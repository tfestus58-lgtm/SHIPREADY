/**
 * Netlify Function: approve-delivery.js
 * Path: netlify/functions/approve-delivery.js
 *
 * Called when a buyer approves a delivered project, OR automatically by
 * scheduled-subscriptions.js after 72 hours of inactivity.
 *
 * - Verifies the caller is the project's buyer (JWT path) OR a trusted
 *   internal function (x-internal-secret path, used by the scheduler)
 * - Updates the project: status → completed, escrowStatus → released
 * - Credits the net amount to the freelancer's availableBalance
 * - Notifies the freelancer (push + in-app + email) that payment is on its way
 *   (the buyer is already notified separately, at delivery-submission time,
 *   by netlify/functions/submit-delivery.js — not duplicated here)
 *
 * POST body:
 *   { projectId: string, buyerUid: string }
 *
 * Auth paths (either one must pass):
 *   1. Firebase ID token in Authorization header — buyer approving manually.
 *      The token uid must match the project's buyerUid.
 *   2. x-internal-secret header matching INTERNAL_FUNCTION_SECRET — trusted
 *      server-to-server call (e.g. scheduled auto-approval after 72 h).
 *      buyerUid must still be supplied in the body; it is validated against
 *      the project document before any write is performed.
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT    — full service account JSON
 *   PLATFORM_URL                — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET    — shared secret for server-to-server calls
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { sanitizeString }               = require('./_sanitize');

/* ── Firebase Admin — lazy singleton ── */
let _db = null;

function getDb() {
  if (_db) return _db;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  _db = getFirestore();
  return _db;
}

/* ── Internal function caller (function-to-function via HTTP) ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return;
  }

  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`${functionName} returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    // Non-fatal — the core Firestore update already succeeded
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Verify caller identity (two accepted paths) ── */
  //
  // Path 1 — Internal server-to-server call (e.g. scheduled-subscriptions.js
  //   auto-approving after 72 h). Identified by the x-internal-secret header.
  //   buyerUid must be supplied in the body; it is validated against the
  //   project document before any write is performed.
  //
  // Path 2 — Authenticated buyer calling from the browser. A Firebase ID token
  //   in the Authorization header is verified and its uid used directly.
  //   Any buyerUid in the body must match the verified token uid.
  //
  const incomingSecret  = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'] || '';
  const expectedSecret  = process.env.INTERNAL_FUNCTION_SECRET || '';
  const isTrustedInternal = !!expectedSecret && incomingSecret === expectedSecret;

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { projectId, buyerUid: bodyBuyerUid } = payload;
  const action = payload.action || 'approve';

  let buyerUid;

  if (isTrustedInternal) {
    // Internal path: trust the buyerUid from the body; validate against Firestore below.
    if (!bodyBuyerUid || typeof bodyBuyerUid !== 'string') {
      return respond(400, { error: 'buyerUid is required for internal calls.' });
    }
    buyerUid = bodyBuyerUid;
  } else {
    // Browser path: verify the Firebase ID token.
    const callerUid = await verifyCaller(event, process.env);
    if (!callerUid) {
      return respond(401, { error: 'Unauthorized. Please log in again.' });
    }
    // If client also sent buyerUid in body, it must match the verified token.
    if (bodyBuyerUid && bodyBuyerUid !== callerUid) {
      return respond(403, { error: 'Caller identity mismatch.' });
    }
    buyerUid = callerUid;
  }

  if (!projectId || typeof projectId !== 'string') {
    return respond(400, { error: 'projectId is required.' });
  }

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  /* ── Fetch project (for auth check only — status/balance writes happen
     inside the transaction below) ── */
  let projectSnap;
  try {
    projectSnap = await db.collection('projects').doc(projectId).get();
  } catch (err) {
    console.error(`Firestore read failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!projectSnap.exists) {
    return respond(404, { error: 'Project not found.' });
  }

  const project = projectSnap.data();

  /* ── Verify caller is the project buyer ── */
  if (project.buyerUid !== buyerUid) {
    return respond(403, { error: 'You are not authorised to approve this delivery.' });
  }

  /* ════════════════════════════════════════════════════════════
     ACTION: request_revision
     Only the buyer can request a revision, and only while the
     project is in 'delivered' status. Moves the project back to
     'in_progress' and appends a revision note for the freelancer.
  ════════════════════════════════════════════════════════════ */
  if (action === 'request_revision') {
    if (isTrustedInternal) {
      return respond(403, { error: 'Only the buyer can request a revision.' });
    }

    if (project.status !== 'delivered') {
      return respond(400, { error: `Cannot request a revision on a project with status "${project.status}".` });
    }

    const safeNote = sanitizeString(payload.revisionNote, 2000);
    if (!safeNote || !safeNote.trim()) {
      return respond(400, { error: 'A revision note is required.' });
    }

    try {
      await db.collection('projects').doc(projectId).update({
        status:         'in_progress',
        revisionNotes:  FieldValue.arrayUnion({
          note:        safeNote,
          requestedAt: new Date().toISOString(),
          requestedBy: buyerUid,
        }),
        updatedAt:      FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error(`Firestore update failed for project ${projectId} (request_revision):`, err.message);
      return respond(500, { error: 'Failed to request revision. Please try again.' });
    }

    const revisionPlatformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
    const revisionProjectUrl  = `${revisionPlatformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(projectId)}`;
    const revisionProjectTitle = project.projectTitle || 'Your project';

    if (project.freelancerUid) {
      await callFunction('send-smart-notification', {
        userUid:    project.freelancerUid,
        title:      'Revision Requested',
        body:       `The buyer has requested a revision on "${revisionProjectTitle}".`,
        url:        revisionProjectUrl,
        templateId: 'delivery-revision-requested',
        emailMode:  'never',
        emailData: {
          projectTitle: revisionProjectTitle,
          revisionNote: safeNote,
        },
      });
    }

    return respond(200, { success: true });
  }

  /* ── Atomic: re-read status inside transaction, mark completed, credit balance ──
     A plain .get() + .update() pair (what was here before) has a race window:
     two near-simultaneous calls (double-tap, network retry, overlapping scheduler
     run) could both pass the status check before either commits and both would
     credit the freelancer's balance — a real double-payment risk.
     Wrapping everything in a single runTransaction() closes that window: only
     one caller will see status !== 'completed' inside the transaction; the
     second will hit the guard and return early with no balance change. ── */

  let netAmount       = 0;
  let projectCurrency = 'USD';
  let freelancerUid   = null;
  let projectTitle    = 'Your project';
  let alreadyApproved = false;

  try {
    await db.runTransaction(async (tx) => {
      const projectRef  = db.collection('projects').doc(projectId);
      // Re-read the document fresh inside the transaction — the earlier .get()
      // outside is only used for auth/validation; this read is what actually
      // gates the write.
      const freshSnap = await tx.get(projectRef);

      if (!freshSnap.exists) {
        const err = new Error('Project not found.');
        err.statusCode = 404;
        throw err;
      }

      const freshProject = freshSnap.data();

      /* ── Idempotency: already completed ── */
      if (freshProject.status === 'completed') {
        alreadyApproved = true;
        return;
      }

      /* ── Guard: must still be in an approvable state ── */
      if (!['in_progress', 'delivered'].includes(freshProject.status)) {
        const err = new Error(`Cannot approve a project with status "${freshProject.status}".`);
        err.statusCode = 400;
        throw err;
      }

      netAmount       = Number(freshProject.netAmount || 0);
      projectCurrency = (freshProject.currency || 'USD').toUpperCase();
      freelancerUid   = freshProject.freelancerUid || null;
      projectTitle    = freshProject.projectTitle || 'Your project';

      if (!freelancerUid) {
        const err = new Error('Project has no freelancer assigned.');
        err.statusCode = 400;
        throw err;
      }
      if (netAmount <= 0) {
        const err = new Error('Project net amount is zero or not set.');
        err.statusCode = 400;
        throw err;
      }

      /* ── Mark project completed inside the transaction ── */
      tx.update(projectRef, {
        status:       'completed',
        escrowStatus: 'released',
        completedAt:  FieldValue.serverTimestamp(),
        updatedAt:    FieldValue.serverTimestamp(),
      });

      /* ── Credit freelancer balance inside the same transaction ──
         Crypto-gateway projects (paymentMethod === 'crypto') earn into
         cryptoBalance, not availableBalance, so only crypto-earned USD can
         be withdrawn via the crypto payout path. Fiat-gateway projects
         (Stripe, Flutterwave) continue to credit availableBalance as before. ── */
      const isCryptoProject = freshProject.paymentMethod === 'crypto';

      const approveUpdate = {
        [`balances.${projectCurrency}`]:              FieldValue.increment(netAmount),
        // totalEarned is a legacy blended (all-currencies-summed) figure kept
        // only for older admin tooling that hasn't been migrated. It must
        // NEVER be shown to a freelancer as "earnings" — it can mix USD+NGN+
        // EUR raw numbers together. Use totalEarnedByCurrency for any
        // freelancer-facing earnings display instead.
        totalEarned:                                  FieldValue.increment(netAmount),
        [`totalEarnedByCurrency.${projectCurrency}`]: FieldValue.increment(netAmount),
        updatedAt:                                    FieldValue.serverTimestamp(),
      };
      if (projectCurrency === 'USD') {
        if (isCryptoProject) {
          // Crypto-sourced USD → dedicated cryptoBalance pool.
          // create-payout.js debits this field for crypto withdrawals.
          approveUpdate.cryptoBalance = FieldValue.increment(netAmount);
        } else {
          // Fiat-sourced USD → availableBalance (bank withdrawal pool).
          approveUpdate.availableBalance = FieldValue.increment(netAmount);
        }
      }
      tx.update(db.collection('users').doc(freelancerUid), approveUpdate);
    });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 404) return respond(404, { error: err.message });
    if (code === 400) return respond(400, { error: err.message });
    console.error(`Transaction failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Failed to approve delivery.' });
  }

  /* ── Idempotency short-circuit ── */
  if (alreadyApproved) {
    return respond(409, { error: 'This delivery has already been approved.' });
  }

  const amountFormatted = new Intl.NumberFormat('en', { style: 'currency', currency: projectCurrency }).format(netAmount);
  console.log(`Project ${projectId} marked completed. Credited ${amountFormatted} to freelancer ${freelancerUid}.`);

  /* ── Fetch user details for notifications and emails ── */
  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerEmail      = null;
  let buyerName       = 'Client';

  try {
    const [fSnap, bSnap] = await Promise.all([
      db.collection('users').doc(freelancerUid).get(),
      db.collection('users').doc(buyerUid).get(),
    ]);
    if (fSnap.exists) {
      freelancerEmail = fSnap.data().email || null;
      freelancerName  = fSnap.data().name  || 'Freelancer';
    }
    if (bSnap.exists) {
      buyerEmail = bSnap.data().email || null;
      buyerName  = bSnap.data().name  || 'Client';
    }
  } catch (err) {
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  const platformUrl  = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const projectUrl   = `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(projectId)}`;
  const buyerProjUrl = `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(projectId)}`;

  /* ── Notify the freelancer: work approved, payment on the way ── */
  await callFunction('send-smart-notification', {
    userUid:    freelancerUid,
    title:      'Work Approved',
    body:       `"${projectTitle}" has been approved. Your payment is on its way.`,
    url:        projectUrl,
    templateId: 'payment-received',
    emailMode:  freelancerEmail ? 'always' : 'never',
    emailData: {
      name:         freelancerName,
      projectTitle,
      amount:       amountFormatted,
      buyerName,
    },
  });

  /* ── Notify the buyer: delivery confirmed ── */
  if (buyerUid || buyerEmail) {
    await callFunction('send-smart-notification', {
      userUid:    buyerUid || null,
      title:      'Delivery Confirmed',
      body:       `You have approved the delivery for "${projectTitle}". The project is now complete.`,
      url:        buyerProjUrl,
      templateId: 'delivery-confirmed-buyer',
      emailMode:  buyerEmail ? 'always' : 'never',
      emailData: {
        name:         buyerName,
        freelancerName,
        projectTitle,
        dashboardUrl: buyerProjUrl,
      },
    });
  }

  /* ── B6: Fire-and-forget referral credit check ── */
  try {
    const baseUrl = process.env.PLATFORM_URL || process.env.URL || 'https://kreddlo.space';
    fetch(`${baseUrl}/.netlify/functions/process-referral-credit`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body: JSON.stringify({ completedByUid: buyerUid, projectId }),
    }).catch(err => console.warn('[approve-delivery] referral-credit fire-and-forget error:', err.message));
  } catch (refErr) {
    console.warn('[approve-delivery] referral-credit hook failed (non-fatal):', refErr.message);
  }

  return respond(200, {
    success: true,
    message: `Delivery approved. ${amountFormatted} credited to ${freelancerName}.`,
  });
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

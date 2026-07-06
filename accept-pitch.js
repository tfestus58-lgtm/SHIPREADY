/**
 * Netlify Function: accept-pitch.js
 * Path: netlify/functions/accept-pitch.js
 *
 * Lets a buyer accept a Pitch on their own Brief, hiring that freelancer.
 * Creates a new `projects` document using the exact same field structure
 * as create-project.js so every downstream function (payment, contracts,
 * escrow, disputes) works identically for Brief-sourced hires.
 *
 * POST body:
 *   {
 *     briefId:  string   — required
 *     pitchId:  string   — required
 *   }
 *
 * Success response (200):
 *   { success: true, projectId: string }
 *
 * Error responses:
 *   400 — missing fields, pitch already actioned
 *   401 — not authenticated
 *   403 — caller does not own this Brief, or freelancer no longer verified
 *   404 — brief, pitch, buyer, or freelancer account not found
 *   405 — method not allowed
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT     — full service account JSON as one-line string
 *   PLATFORM_URL                 — e.g. https://kreddlo.space (for notification fan-out)
 *   INTERNAL_FUNCTION_SECRET     — shared secret for internal function-to-function calls
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { getSettings }                  = require('./get-settings');

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

/* ── Utility: build a Netlify function response ── */
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

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 1. Verify caller identity ── */
  const buyerUid = await verifyCaller(event, process.env);
  if (!buyerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  /* ── 2. Parse request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const briefId = (body.briefId || '').trim();
  const pitchId = (body.pitchId || '').trim();

  if (!briefId) {
    return respond(400, { error: 'briefId is required.' });
  }
  if (!pitchId) {
    return respond(400, { error: 'pitchId is required.' });
  }

  try {
    const db = getDb();

    /* ── 3. Fetch the brief and verify ownership ── */
    const briefRef  = db.collection('briefs').doc(briefId);
    const briefSnap = await briefRef.get();
    if (!briefSnap.exists) {
      return respond(404, { error: 'Brief not found.' });
    }
    const brief = briefSnap.data();

    if (brief.buyerUid !== buyerUid) {
      return respond(403, { error: 'You do not have access to this Brief.' });
    }

    /* ── 4. Fetch the pitch and verify status ── */
    const pitchRef  = briefRef.collection('pitches').doc(pitchId);
    const pitchSnap = await pitchRef.get();
    if (!pitchSnap.exists) {
      return respond(404, { error: 'Pitch not found.' });
    }
    const pitch = pitchSnap.data();

    if (!['pending', 'shortlisted'].includes(pitch.status)) {
      return respond(400, { error: `This Pitch has already been actioned (status: ${pitch.status}).` });
    }

    /* ── 5. Fetch buyer + freelancer accounts ── */
    const buyerSnap = await db.collection('users').doc(buyerUid).get();
    if (!buyerSnap.exists) {
      return respond(404, { error: 'Buyer account not found.' });
    }
    const buyerData  = buyerSnap.data();
    const buyerName  = buyerData.displayName || buyerData.name || 'Client';
    const buyerEmail = buyerData.email || '';

    if (buyerData.suspended === true) {
      return respond(403, { error: 'Your account has been suspended. Please contact support for assistance.' });
    }

    const freelancerSnap = await db.collection('users').doc(pitch.freelancerUid).get();
    if (!freelancerSnap.exists) {
      return respond(404, { error: 'Freelancer account not found.' });
    }
    const freelancerData     = freelancerSnap.data();
    const freelancerName     = freelancerData.displayName || freelancerData.name || pitch.freelancerName || 'Freelancer';
    const freelancerUsername = freelancerData.username || pitch.freelancerUsername || '';

    if (freelancerData.kycStatus !== 'verified') {
      return respond(403, { error: 'This freelancer is not yet verified and cannot accept projects.' });
    }

    /* ── 6. Compute the fee-inclusive charge — same uplift as create-project.js ── */
    const budgetNum = Number(pitch.proposedBudget) || 0;
    if (budgetNum <= 0) {
      return respond(400, { error: 'This Pitch has an invalid proposed budget.' });
    }

    const settings = await getSettings(db);
    const platformFeePercent = typeof settings.platformFeePercent === 'number' ? settings.platformFeePercent : 2.5;
    const totalDeductionPercent = platformFeePercent;
    if (totalDeductionPercent >= 100) {
      return respond(400, { error: 'Platform fee configuration is invalid. Please contact support.' });
    }
    const chargeAmount = +(budgetNum / (1 - totalDeductionPercent / 100)).toFixed(2);

    /* ── 7. Create the project document ── */
    const now = FieldValue.serverTimestamp();
    const projectDoc = {
      // Parties
      buyerUid,
      buyerName,
      buyerEmail,
      freelancerUid:       pitch.freelancerUid,
      freelancerName,
      freelancerUsername,

      // Project details — sourced from the Brief
      projectTitle:   brief.title || 'Untitled Brief',
      title:          brief.title || 'Untitled Brief',
      description:    brief.description || '',
      scope:          brief.description || '',

      // Financial — sourced from the accepted Pitch
      budget:         budgetNum,
      amount:         budgetNum,
      totalAmount:    chargeAmount,
      currency:       'USD',
      withProtection: false,

      // Deadline — sourced from the Brief
      deadline:       brief.deadline || '',

      // Buyer has effectively signed by accepting; freelancer countersigns
      // via the existing contract-signing flow like any other project.
      buyerSigned:         true,
      buyerSignedAt:       now,
      buyerSignature:      '',
      buyerIp:             (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || '',
      buyerCountry:        event.headers['x-country'] || event.headers['cf-ipcountry'] || '',
      freelancerSigned:    false,
      freelancerSignedAt:  null,
      freelancerSignature: '',

      // Lifecycle
      status:       'pending_payment',
      escrowStatus: 'pending',
      paymentStatus: 'unpaid',

      // Traceability back to the Brief/Pitch this project was awarded from
      sourceBriefId: briefId,
      sourcePitchId: pitchId,

      // Timestamps
      createdAt: now,
      updatedAt: now,
    };

    const projectRef = await db.collection('projects').add(projectDoc);
    const projectId  = projectRef.id;

    /* ── 8. Update the pitch, the brief, and decline all other pending pitches ── */
    const batch = db.batch();
    batch.update(pitchRef, { status: 'accepted', updatedAt: now });
    batch.update(briefRef, { status: 'awarded', updatedAt: now });

    const otherPitchesSnap = await briefRef
      .collection('pitches')
      .where('status', '==', 'pending')
      .get();
    otherPitchesSnap.docs.forEach((doc) => {
      if (doc.id === pitchId) return;
      batch.update(doc.ref, { status: 'declined', updatedAt: now });
    });

    await batch.commit();

    console.log(`[accept-pitch] Brief ${briefId} awarded — project ${projectId} created for freelancer ${pitch.freelancerUid}.`);

    /* ── 9. Notify the winning freelancer ── */
    // Non-fatal — fire-and-forget
    try {
      const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      if (platformUrl) {
        const notifyRes = await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
          },
          body: JSON.stringify({
            userUid:    pitch.freelancerUid,
            title:      'Pitch Accepted — You\'re Hired',
            body:       `${buyerName} accepted your Pitch on "${brief.title || 'a Brief'}". A project has been created.`,
            url:        `${platformUrl}/dashboard-projects.html`,
            templateId: 'pitch-accepted',
            emailMode:  'never',
            emailData:  { briefTitle: brief.title || '', buyerName, projectId },
          }),
        });
        if (!notifyRes.ok) {
          console.warn('[accept-pitch] Notification returned', notifyRes.status);
        }
      }
    } catch (notifErr) {
      console.warn('[accept-pitch] Could not notify freelancer:', notifErr.message);
    }

    return respond(200, { success: true, projectId });

  } catch (err) {
    console.error('[accept-pitch] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
};

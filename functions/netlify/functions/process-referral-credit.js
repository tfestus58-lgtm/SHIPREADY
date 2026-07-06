/**
 * process-referral-credit.js
 *
 * Awards a referral credit to the person who referred a new user,
 * the first time that new user completes a paid project.
 *
 * Called internally (fire-and-forget) by:
 *   approve-delivery.js, stripe-webhook.js,
 *   flutterwave-webhook.js, nowpayments-webhook.js
 *
 * Body: { completedByUid: string, projectId: string }
 *
 * Idempotent — uses projectId as the referral-credits doc ID so
 * double-calls for the same project are safe no-ops.
 *
 * Guards:
 *   1. referralProgramEnabled must be true in config/platform
 *   2. completing user must have a referredBy field
 *   3. referralCreditUsed must not already be true on completing user
 *   4. referrer must not be the same uid as the completing user (no self-credit)
 */

'use strict';

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getSettings } from './get-settings';

/* ── Lazy Firebase Admin init ─────────────────────────────────── */
let _db = null;
function getDb(env) {
  if (_db) return _db;
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  _db = getFirestore();
  return _db;
}

/* ── Handler ──────────────────────────────────────────────────── */
export default {
  async fetch(request, env, ctx) {
  const rawText = await request.text();
  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Issue G fix: caller authentication ──────────────────────
     This function writes to user financial-adjacent fields
     (referralCreditsBalance, referralCreditsTotalEarned) and must
     only be callable by trusted internal functions — not by any
     unauthenticated external caller who knows a valid uid/projectId
     pair. All callers (approve-delivery.js, the payment webhooks)
     are server-side Admin SDK functions that share INTERNAL_FUNCTION_SECRET.
     Fails closed: if the env var is unset it is a server misconfiguration,
     not an open door — same pattern used by every other internal function
     in this codebase (scheduled-clear-earnings.js, approve-delivery.js, etc).
  ──────────────────────────────────────────────────────────────── */
  const incomingSecret = request.headers.get('x-internal-secret') || request.headers.get('X-Internal-Secret') || '';
  const expectedSecret = env.INTERNAL_FUNCTION_SECRET || '';
  if (!expectedSecret || incomingSecret !== expectedSecret) {
    return respond(401, { error: 'Unauthorized.' });
  }

  let body;
  try {
    body = JSON.parse(rawText || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { completedByUid, projectId } = body;

  if (!completedByUid || typeof completedByUid !== 'string') {
    return respond(400, { error: 'completedByUid is required.' });
  }
  if (!projectId || typeof projectId !== 'string') {
    return respond(400, { error: 'projectId is required.' });
  }

  const db = getDb(env);

  /* ── 1. Check referral program is enabled ─────────────────── */
  let settings;
  try {
    settings = await getSettings(db);
  } catch (err) {
    console.error('[referral-credit] getSettings failed:', err.message);
    return respond(500, { error: 'Could not read platform settings.' });
  }

  if (!settings.referralProgramEnabled) {
    console.log('[referral-credit] Referral program is disabled — skipping.');
    return respond(200, { skipped: true, reason: 'referralProgramDisabled' });
  }

  const creditAmount = Number(settings.referralCreditAmount) || 2;

  /* ── 2. Read the completing user ──────────────────────────── */
  let completingUserSnap;
  try {
    completingUserSnap = await db.collection('users').doc(completedByUid).get();
  } catch (err) {
    console.error(`[referral-credit] Could not read user ${completedByUid}:`, err.message);
    return respond(500, { error: 'Could not read completing user.' });
  }

  if (!completingUserSnap.exists) {
    console.warn(`[referral-credit] User ${completedByUid} not found.`);
    return respond(200, { skipped: true, reason: 'completingUserNotFound' });
  }

  const completingUser = completingUserSnap.data();

  /* ── 3. Must have been referred ───────────────────────────── */
  const referrerUid = completingUser.referredBy;
  if (!referrerUid || typeof referrerUid !== 'string') {
    console.log(`[referral-credit] User ${completedByUid} has no referredBy — skipping.`);
    return respond(200, { skipped: true, reason: 'noReferrer' });
  }

  /* ── 4. No self-credit ────────────────────────────────────── */
  if (referrerUid === completedByUid) {
    console.warn(`[referral-credit] Self-referral detected for ${completedByUid} — skipping.`);
    return respond(200, { skipped: true, reason: 'selfReferral' });
  }

  /* ── 5. Credit is one-time only ───────────────────────────── */
  if (completingUser.referralCreditUsed === true) {
    console.log(`[referral-credit] User ${completedByUid} already used their referral credit — skipping.`);
    return respond(200, { skipped: true, reason: 'alreadyCredited' });
  }

  /* ── 6. Idempotency: check if this project was already processed ── */
  const creditDocRef = db.collection('referral-credits').doc(projectId);
  let existingCredit;
  try {
    existingCredit = await creditDocRef.get();
  } catch (err) {
    console.error('[referral-credit] Could not check idempotency doc:', err.message);
    return respond(500, { error: 'Could not check referral-credits doc.' });
  }

  if (existingCredit.exists) {
    console.log(`[referral-credit] Project ${projectId} already processed — skipping.`);
    return respond(200, { skipped: true, reason: 'alreadyProcessed' });
  }

  /* ── 7. Read referrer to get their name for the email ─────── */
  let referrerSnap;
  try {
    referrerSnap = await db.collection('users').doc(referrerUid).get();
  } catch (err) {
    console.error(`[referral-credit] Could not read referrer ${referrerUid}:`, err.message);
    return respond(500, { error: 'Could not read referrer user.' });
  }

  if (!referrerSnap.exists) {
    console.warn(`[referral-credit] Referrer ${referrerUid} not found — skipping credit.`);
    return respond(200, { skipped: true, reason: 'referrerNotFound' });
  }

  const referrer        = referrerSnap.data();
  const referrerName    = referrer.name || 'there';
  const referrerEmail   = referrer.email || null;
  const completingName  = completingUser.name || 'Someone you referred';

  /* ── 8. Atomic check-and-write ─────────────────────────────────
     Issue: a double-fire of this function for the same user (e.g. two
     near-simultaneous webhook deliveries for the same project, or two
     different completion events racing each other) could each pass the
     referralCreditUsed check (step 5) and the idempotency check (step 6)
     above before either commits — a db.batch() does not re-read anything,
     it only writes — and both would credit the referrer, a double-credit
     race. Wrapping a fresh re-read of both guard fields plus all three
     writes in a single db.runTransaction() closes that window: only one
     caller will see both guards pass inside the transaction; the second
     will hit a guard and return early with no balance change. Mirrors the
     pattern used in approve-delivery.js.
     a) Re-read completing user + idempotency doc fresh inside the transaction
     b) Increment referrer's referralCreditsBalance
     c) Mark completing user's referralCreditUsed = true
     d) Write audit doc at referral-credits/{projectId}
  ─────────────────────────────────────────────────────────────── */
  const completingUserRef = db.collection('users').doc(completedByUid);
  const referrerRef       = db.collection('users').doc(referrerUid);

  let alreadyCredited = false;

  try {
    await db.runTransaction(async (tx) => {
      // Re-read both guard sources fresh inside the transaction — the
      // earlier .get() calls above (steps 2 and 6) are only used for
      // validation/lookup (program-enabled check, referrer name/email,
      // etc.); these reads are what actually gate the write.
      const [freshCompletingSnap, freshCreditSnap] = await Promise.all([
        tx.get(completingUserRef),
        tx.get(creditDocRef),
      ]);

      if (!freshCompletingSnap.exists) {
        const err = new Error('Completing user not found.');
        err.statusCode = 404;
        throw err;
      }

      const freshCompletingUser = freshCompletingSnap.data();

      /* ── Re-check: credit is one-time only ── */
      if (freshCompletingUser.referralCreditUsed === true) {
        alreadyCredited = true;
        return;
      }

      /* ── Re-check: idempotency for this project ── */
      if (freshCreditSnap.exists) {
        alreadyCredited = true;
        return;
      }

      // Credit the referrer
      tx.update(referrerRef, {
        referralCreditsBalance: FieldValue.increment(creditAmount),
        referralCreditsTotalEarned: FieldValue.increment(creditAmount),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Mark completing user so credit only fires once
      tx.update(completingUserRef, {
        referralCreditUsed: true,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Audit trail (doc ID = projectId for idempotency)
      tx.set(creditDocRef, {
        projectId,
        referrerUid,
        referredUid: completedByUid,
        creditAmount,
        creditCurrency: 'USD',
        referrerName,
        referredName: completingName,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 404) {
      console.warn(`[referral-credit] ${err.message}`);
      return respond(200, { skipped: true, reason: 'completingUserNotFound' });
    }
    console.error('[referral-credit] Transaction failed:', err.message);
    return respond(500, { error: 'Failed to write referral credit.' });
  }

  if (alreadyCredited) {
    console.log(`[referral-credit] Project ${projectId} already processed or credit already used — skipping.`);
    return respond(200, { skipped: true, reason: 'alreadyProcessed' });
  }

  console.log(`[referral-credit] Credited $${creditAmount} to referrer ${referrerUid} for project ${projectId}.`);

  /* ── 9. Send notification email to referrer ─────────────── */
  if (referrerEmail) {
    try {
      const baseUrl = env.PLATFORM_URL || env.URL || 'https://kreddlo.space';
      await fetch(`${baseUrl}/.netlify/functions/send-email`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '' },
        body: JSON.stringify({
          to:         referrerEmail,
          toName:     referrerName,
          templateId: 'referral-credited',
          data: {
            name:         referrerName,
            referredName: completingName,
          },
        }),
      });
      console.log(`[referral-credit] Email sent to referrer ${referrerEmail}.`);
    } catch (emailErr) {
      // Non-fatal — credit is already written
      console.warn('[referral-credit] Email send failed (non-fatal):', emailErr.message);
    }
  }

  return respond(200, {
    success: true,
    message: `Referral credit of $${creditAmount} applied to referrer ${referrerUid}.`,
  });
  }
};

/* ── Utility ──────────────────────────────────────────────────── */
function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Netlify Function: kyc-approve.js
 * Path: netlify/functions/kyc-approve.js
 *
 * Called by admin.html when an admin approves or rejects a KYC submission.
 *
 * POST body:
 *   {
 *     action:  'approve' | 'reject',
 *     uid:     string,           // target user UID
 *     reason:  string,           // required when action === 'reject'
 *   }
 *
 * Auth: Firebase ID token in Authorization: Bearer <token> header.
 *   The token is verified server-side and the caller's Firestore
 *   users/{uid}.role is checked to be 'admin' before any action is taken.
 *   (Issue 1 fix — replaces the shared ADMIN_SECRET pattern.)
 *
 * On approve:
 *   - Sets users/{uid}.kycStatus = 'verified'
 *   - Sets users/{uid}.kycReviewedAt = serverTimestamp()
 *   - Sends kyc-approved branded email via send-email.js
 *
 * On reject:
 *   - Sets users/{uid}.kycStatus = 'declined'
 *   - Sets users/{uid}.kycRejectionReason = reason
 *   - Sets users/{uid}.kycReviewedAt = serverTimestamp()
 *   - Sends kyc-declined branded email (with reason) via send-email.js
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT    — full service account JSON (single-line string)
 *   INTERNAL_FUNCTION_SECRET    — shared secret for server-to-server calls
 *   PLATFORM_URL                — e.g. https://kreddlo.space
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';
import { getAuth }                      from 'firebase-admin/auth';
import { verifyCaller }                 from './_verify-auth';

function getDb(env) {
  if (!getApps().length) {
    let sa;
    try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

/* ── Server-to-server function caller ──────────────────────────────────────
   Mirrors the identical helper in approve-delivery.js, deliver-product.js,
   and other functions. Sends x-internal-secret so send-email.js accepts the
   request. Non-fatal on error — the Firestore write already succeeded before
   this is called.
────────────────────────────────────────────────────────────────────────────*/
async function callFunction(functionName, payload, env) {
  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`[kyc-approve] PLATFORM_URL not set — cannot call ${functionName}.`);
    return;
  }
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[kyc-approve] ${functionName} returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    // Non-fatal — core Firestore write already succeeded.
    console.error(`[kyc-approve] Failed to call ${functionName}:`, err.message);
  }
}

export default {
  async fetch(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const rawText = await request.text();

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  /* ── Issue 1 fix: ID token + role check (replaces shared ADMIN_SECRET) ── */
  let callerUid;
  try { callerUid = await verifyCaller(request, env); }
  catch { callerUid = null; }
  if (!callerUid) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  /* ── Parse body ── */
  let payload;
  try { payload = JSON.parse(rawText || '{}'); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { action, uid, reason } = payload;

  /* ── Verify caller is an admin in Firestore ── */
  let db;
  try { db = getDb(env); }
  catch (err) { return new Response(JSON.stringify({ error: 'Server config error' }), { status: 500 }); }

  let callerSnap;
  try { callerSnap = await db.collection('users').doc(callerUid).get(); }
  catch { return new Response(JSON.stringify({ error: 'Database error' }), { status: 500 }); }
  if (!callerSnap.exists || callerSnap.data().role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
  }

  /* ── Validate ── */
  if (!uid || typeof uid !== 'string') {
    return new Response(JSON.stringify({ error: 'uid is required' }), { status: 400 });
  }
  if (action !== 'approve' && action !== 'reject') {
    return new Response(JSON.stringify({ error: 'action must be approve or reject' }), { status: 400 });
  }
  if (action === 'reject' && (!reason || !reason.trim())) {
    return new Response(JSON.stringify({ error: 'reason is required for rejection' }), { status: 400 });
  }

  /* ── Load target user ── */
  let userSnap;
  try { userSnap = await db.collection('users').doc(uid).get(); }
  catch (err) { return new Response(JSON.stringify({ error: 'Database error' }), { status: 500 }); }

  if (!userSnap.exists) {
    return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });
  }
  const userData = userSnap.data();

  /* ── Write Firestore ── */
  const updatePayload = {
    kycReviewedAt: FieldValue.serverTimestamp(),
  };

  if (action === 'approve') {
    updatePayload.kycStatus = 'verified';
  } else {
    updatePayload.kycStatus          = 'declined';
    updatePayload.kycRejectionReason = reason.trim();
  }

  try {
    await db.collection('users').doc(uid).update(updatePayload);
  } catch (err) {
    console.error('[kyc-approve] Firestore update error:', err.message);
    return new Response(JSON.stringify({ error: 'Failed to update user' }), { status: 500 });
  }

  /* Mirror kycStatus to publicProfiles/{uid} — additive, non-blocking.
     browse.html filters on kycStatus === 'verified', so this keeps a
     declined freelancer out of (or a newly-approved one into) the public
     directory without affecting the primary users/{uid} write above. */
  try {
    await db.collection('publicProfiles').doc(uid).set(
      { kycStatus: updatePayload.kycStatus },
      { merge: true }
    );
  } catch (err) {
    console.warn('[kyc-approve] publicProfiles kycStatus mirror failed (non-fatal):', err.message);
  }

  /* ── Send branded email via send-email.js (non-blocking on error) ──
     Issue 6 fix: previously used private inline HTML templates with Arial
     font sent via a direct Brevo fetch() here. Now routes through
     send-email.js so both KYC emails use the shared Plus Jakarta Sans /
     baseLayout / BRAND system — identical to every other platform email.
     templateKycApproved({ name }) and templateKycDeclined({ name, reason })
     already exist in send-email.js and are wired in its buildEmail() switch. */
  const userName  = userData.displayName || userData.name || 'there';
  const userEmail = userData.email || '';

  if (userEmail) {
    try {
      if (action === 'approve') {
        await callFunction('send-email', {
          to:       userEmail,
          toName:   userName,
          type:     'kyc-approved',
          data:     { name: userName },
        }, env);
      } else {
        await callFunction('send-email', {
          to:       userEmail,
          toName:   userName,
          type:     'kyc-declined',
          data:     { name: userName, reason: reason.trim() },
        }, env);
      }
    } catch (err) {
      // Already caught inside callFunction — this outer catch is a belt-and-
      // suspenders guard so an unexpected throw never blocks the 200 response.
      console.warn('[kyc-approve] Email dispatch error (non-fatal):', err.message);
    }
  }

  console.log(`[kyc-approve] KYC ${action}d for uid: ${uid}`);
  return new Response(JSON.stringify({ ok: true, kycStatus: updatePayload.kycStatus }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  }
};

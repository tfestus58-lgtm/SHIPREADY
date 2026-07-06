/**
 * verify-withdrawal-otp.js — Kreddlo Netlify Function
 *
 * Validates the 6-digit withdrawal OTP against the stored value in Firestore.
 * Single-use: clears the OTP fields on success so it can't be reused.
 *
 * POST body: { uid, code }
 * Auth: Firebase ID token in Authorization header
 *
 * Returns: { success: true } or { error: "..." }
 */

'use strict';

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';
import { verifyCaller }                  from './_verify-auth';

function getDb(env) {
  if (!getApps().length) {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

// Issue 8 fix: OTP is now stored as sha256(otp) in Firestore.
// Verification hashes the submitted code and compares hashes — the raw
// plaintext code is never stored or compared directly.
async function hashOtp(otp) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(otp).trim()));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

export default {
async fetch(request, env, ctx) {
  if (request.method === 'OPTIONS') return respond(204, {});
  if (request.method !== 'POST')    return respond(405, { error: 'Method not allowed.' });

  /* ── Auth ── */
  const callerUid = await verifyCaller(request, env);
  if (!callerUid) return respond(401, { error: 'Unauthorized. Please log in again.' });

  const rawText = await request.text();
  let uid, code;
  try {
    ({ uid, code } = JSON.parse(rawText || '{}'));
  } catch {
    return respond(400, { error: 'Invalid request body.' });
  }

  if (!uid || uid !== callerUid) return respond(403, { error: 'Forbidden.' });
  if (!code) return respond(400, { error: 'Verification code is required.' });

  /* ── Get user ── */
  let db, userSnap;
  try {
    db       = getDb(env);
    userSnap = await db.collection('users').doc(uid).get();
  } catch (err) {
    console.error('[verify-withdrawal-otp] Firestore read error:', err.message);
    return respond(500, { error: 'Database error.' });
  }

  if (!userSnap.exists) return respond(404, { error: 'User not found.' });
  const user = userSnap.data();

  /* ── Check OTP fields exist ── */
  if (!user.withdrawalOtp || !user.withdrawalOtpExpiry) {
    return respond(400, { error: 'No verification code found. Please request a new one.' });
  }

  /* ── Check already used ── */
  if (user.withdrawalOtpUsed === true) {
    return respond(400, { error: 'This code has already been used. Please request a new one.' });
  }

  /* ── Check expiry ── */
  const expiry = user.withdrawalOtpExpiry.toDate
    ? user.withdrawalOtpExpiry.toDate()
    : new Date(user.withdrawalOtpExpiry);

  if (Date.now() > expiry.getTime()) {
    return respond(400, { error: 'This code has expired. Please request a new one.' });
  }

  /* ── Brute-force attempt limit (FIX) ──
     A 6-digit OTP has only 1,000,000 possible values. With no cap on
     verification attempts, an attacker with a valid session for this uid
     (e.g. a stolen token, or a malicious co-user) could brute-force the
     code well within its 10-minute expiry window via rapid automated
     requests — defeating the purpose of having an OTP at all. Cap at 5
     wrong attempts; once exceeded, invalidate the OTP entirely so the
     user must request a fresh one (which is itself rate-limited to one
     per 60s by send-withdrawal-otp.js). */
  const MAX_ATTEMPTS = 5;
  const attempts = Number(user.withdrawalOtpAttempts || 0);
  if (attempts >= MAX_ATTEMPTS) {
    try {
      await db.collection('users').doc(uid).update({
        withdrawalOtp:         FieldValue.delete(),
        withdrawalOtpExpiry:   FieldValue.delete(),
        withdrawalOtpAttempts: FieldValue.delete(),
      });
    } catch (_) {}
    return respond(429, { error: 'Too many incorrect attempts. Please request a new code.' });
  }

  /* ── Check code matches ── */
  // Issue 8 fix: compare sha256(submittedCode) against the stored hash.
  if ((await hashOtp(code)) !== String(user.withdrawalOtp).trim()) {
    // Increment the attempt counter so the cap above eventually triggers.
    try {
      await db.collection('users').doc(uid).update({
        withdrawalOtpAttempts: FieldValue.increment(1),
      });
    } catch (err) {
      console.warn('[verify-withdrawal-otp] Could not increment attempt counter:', err.message);
    }
    const remaining = Math.max(0, MAX_ATTEMPTS - (attempts + 1));
    return respond(400, {
      error: remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Incorrect code. Please request a new one.',
    });
  }

  /* ── Mark used and clear fields ──
     withdrawalOtpVerifiedAt (NEW) is read by create-payout.js,
     create-bank-payout.js, and affiliate-withdraw.js as server-side proof
     that this 2FA step actually happened — previously OTP verification was
     frontend-only and a valid Firebase auth token alone was enough to
     trigger a withdrawal. It's cleared again by those functions on a
     successful payout so one verification can't authorize multiple
     withdrawals. */
  try {
    await db.collection('users').doc(uid).update({
      withdrawalOtpUsed:       true,
      withdrawalOtpVerifiedAt: FieldValue.serverTimestamp(),
      withdrawalOtp:           FieldValue.delete(),
      withdrawalOtpExpiry:     FieldValue.delete(),
      withdrawalOtpAttempts:   FieldValue.delete(),
    });
  } catch (err) {
    console.error('[verify-withdrawal-otp] Firestore update error:', err.message);
    return respond(500, { error: 'Failed to confirm OTP.' });
  }

  console.log(`[verify-withdrawal-otp] uid ${uid} OTP verified successfully.`);
  return respond(200, { success: true });
}
};

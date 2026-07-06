/**
 * send-withdrawal-otp.js — Kreddlo Netlify Function
 *
 * Generates a 6-digit OTP for withdrawal 2FA, stores it in Firestore
 * with a 10-minute expiry, and sends it to the user's registered email
 * via send-email.js (Brevo).
 *
 * POST body: { uid }
 * Auth: Firebase ID token in Authorization header
 *
 * Rate-limited: 60s between sends per user.
 */

'use strict';

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCaller } from './_verify-auth';
import { checkRateLimit } from './_rate-limit';

function getDb(env) {
  if (!getApps().length) {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

function respond(statusCode, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      ...headers,
    },
  });
}

function generateOtp() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const code = 100000 + (array[0] % 900000);
  return String(code);
}

// Issue 8 fix: hash the OTP before storing it in Firestore so that even
// if the users document is read (e.g. by a future rule regression or an
// admin SDK leak), the raw code cannot be recovered. The plaintext OTP is
// still sent to the user's email — it never touches Firestore.
async function hashOtp(otp) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(otp));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env, ctx) {
  if (request.method === 'OPTIONS') return respond(204, {});

  const rawText = await request.text();

  if (request.method !== 'POST')    return respond(405, { error: 'Method not allowed.' });

  /* ── Auth ── */
  const callerUid = await verifyCaller(request, env);
  if (!callerUid) return respond(401, { error: 'Unauthorized. Please log in again.' });

  let uid;
  try {
    ({ uid } = JSON.parse(rawText || '{}'));
  } catch {
    return respond(400, { error: 'Invalid request body.' });
  }

  if (!uid || uid !== callerUid) {
    return respond(403, { error: 'Forbidden.' });
  }

  /* ── Get user from Firestore ── */
  let db, userSnap;
  try {
    db       = getDb(env);

    /* ── Server-side rate limit: 5 OTP sends per 10 minutes per uid ──
       Complements the existing 60-second per-request cooldown stored on the
       user doc. This counter catches automated burst attempts that rotate
       clients or exploit the 60-second window boundary. */
    const rl = await checkRateLimit(db, `otp::${uid}`, 5, 600);
    if (!rl.allowed) {
      return respond(429, { error: rl.error, retryAfter: rl.retryAfter });
    }

    userSnap = await db.collection('users').doc(uid).get();
  } catch (err) {
    console.error('[send-withdrawal-otp] Firestore read error:', err.message);
    return respond(500, { error: 'Database error.' });
  }

  if (!userSnap.exists) return respond(404, { error: 'User not found.' });
  const user = userSnap.data();

  /* ── Rate limit: 60s between sends ── */
  if (user.withdrawalOtpSentAt) {
    const sentAt = user.withdrawalOtpSentAt.toDate
      ? user.withdrawalOtpSentAt.toDate()
      : new Date(user.withdrawalOtpSentAt);
    const secondsSince = (Date.now() - sentAt.getTime()) / 1000;
    if (secondsSince < 60) {
      return respond(429, {
        error: `Please wait ${Math.ceil(60 - secondsSince)} seconds before requesting another code.`,
        retryAfter: Math.ceil(60 - secondsSince),
      });
    }
  }

  /* ── Generate OTP, 10-minute expiry ── */
  const otp    = generateOtp();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);

  /* ── Store in Firestore ──
     Also resets withdrawalOtpAttempts so a freshly issued code always
     gets the full attempt allowance (paired with the attempt-cap fix in
     verify-withdrawal-otp.js). */
  try {
    await db.collection('users').doc(uid).update({
      withdrawalOtp:         await hashOtp(otp),  // Issue 8 fix: stored as sha256 hash, not plaintext
      withdrawalOtpExpiry:   expiry,
      withdrawalOtpSentAt:   FieldValue.serverTimestamp(),
      withdrawalOtpUsed:     false,
      withdrawalOtpAttempts: 0,
    });
  } catch (err) {
    console.error('[send-withdrawal-otp] Firestore write error:', err.message);
    return respond(500, { error: 'Failed to store OTP.' });
  }

  /* ── Send email ── */
  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  try {
    await fetch(`${platformUrl}/.netlify/functions/send-email`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '' },
      body: JSON.stringify({
        to:         user.email,
        type:       'withdrawal-otp',
        data: {
          name: user.name || 'there',
          code: otp,
        },
      }),
    });
  } catch (err) {
    console.warn('[send-withdrawal-otp] send-email failed:', err.message);
    // Non-fatal — OTP is stored, user can still enter it if email arrives
  }

  console.log(`[send-withdrawal-otp] OTP sent to uid ${uid} at ${user.email}`);
  return respond(200, { success: true });
  }
};

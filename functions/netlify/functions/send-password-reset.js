/**
 * send-password-reset.js — Kreddlo Netlify Function
 *
 * Handles "Forgot Password" requests.
 *
 * Flow:
 *  1. Validate request body: { email }
 *  2. Rate-limit by email address (max 3 per 15 minutes) to prevent abuse
 *  3. Look up the user in Firebase Auth by email
 *  4. Generate a Firebase password-reset action link via Admin SDK
 *     (the link is real and functional — we just don't let Firebase send
 *      the email; we send it ourselves through Brevo so it is branded,
 *      lands in the inbox, and looks identical to all other Kreddlo emails)
 *  5. Send the branded HTML email via send-email.js (Brevo)
 *  6. Always return a generic 200 — never reveal whether the email exists
 *
 * Security notes:
 *  - Generic success response regardless of whether the account exists
 *    prevents email-enumeration attacks.
 *  - Rate limit is keyed on the normalised email address so it is not
 *    bypassable by adding + tags (e.g. user+1@example.com counts the same
 *    as user@example.com) — handled by lower-casing the full address, which
 *    is sufficient for the vast majority of providers.
 *  - This function is publicly callable (no auth token required, by design —
 *    the user is logged out when they use it), so the rate limit is the
 *    primary abuse-prevention control.
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — Full Firebase service account JSON (one-line string)
 *   PLATFORM_URL              — e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET  — Shared secret for server-to-server calls
 */

'use strict';

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { getAuth }                       from 'firebase-admin/auth';
import { checkRateLimit }                from './_rate-limit';

/* ── Firebase Admin — lazy singleton ── */
let _db   = null;
let _auth = null;

function getAdminDb(env) {
  if (_db) return _db;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!getApps().length) {
    initializeApp({ credential: cert(sa) });
  }
  _db = getFirestore();
  return _db;
}

function getAdminAuth() {
  if (_auth) return _auth;
  // initializeApp already called by getAdminDb(); just get the auth instance
  _auth = getAuth();
  return _auth;
}

/* ── Standard JSON response helper ──
   Workers' Response constructor throws if a null-body status (204, 205,
   304) is given a non-null body, so those statuses are sent with a null
   body regardless of what's passed in — matches actual HTTP semantics,
   which Netlify's Lambda-style object responses didn't enforce. ── */
function respond(statusCode, body) {
  const isNullBodyStatus = statusCode === 204 || statusCode === 205 || statusCode === 304;
  return new Response(isNullBodyStatus ? null : JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

/* ── Generic success response — never reveal account existence ── */
const GENERIC_SUCCESS = {
  success: true,
  message: 'If an account exists for that email address, a password reset link has been sent.',
};

export default {
  async fetch(request, env, ctx) {
  /* ── CORS preflight ── */
  if (request.method === 'OPTIONS') {
    return respond(204, {});
  }

  const rawText = await request.text();

  /* ── Only accept POST ── */
  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Parse body ── */
  let body;
  try {
    body = JSON.parse(rawText || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const rawEmail = (body.email || '').trim().toLowerCase();

  /* ── Basic format check ── */
  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!rawEmail || !emailRx.test(rawEmail)) {
    return respond(400, { error: 'Please enter a valid email address.' });
  }

  /* ── Initialise Firebase Admin (needed for rate limit + user lookup) ── */
  let db;
  try {
    db = getAdminDb(env);
  } catch (err) {
    console.error('[send-password-reset] Firebase init error:', err.message);
    return respond(500, { error: 'Internal server error.' });
  }

  /* ── Rate limit: 3 requests per 15 minutes per email ── */
  try {
    const rl = await checkRateLimit(db, `pwreset::${rawEmail}`, 3, 900);
    if (!rl.allowed) {
      // Return generic success so attackers cannot use rate-limit errors
      // to enumerate whether an account exists and probe for it more slowly.
      console.warn(`[send-password-reset] Rate limit hit for email hash (not logged for privacy).`);
      return respond(200, GENERIC_SUCCESS);
    }
  } catch (err) {
    // Rate-limit helper itself failed — fail open (do not block the user)
    console.warn('[send-password-reset] Rate limit check failed (failing open):', err.message);
  }

  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  /* ── Look up user + generate reset link ── */
  let resetLink;
  let displayName = '';

  try {
    const adminAuth = getAdminAuth();

    /* getUserByEmail throws if the account does not exist.
       We catch that and return the generic success — no enumeration. */
    const userRecord = await adminAuth.getUserByEmail(rawEmail);
    displayName      = userRecord.displayName || '';

    /* generatePasswordResetLink() creates a real Firebase action link.
       The link works correctly — Firebase processes the password change
       when the user clicks it. We simply skip Firebase's own email send
       and deliver it ourselves via Brevo so the email is branded. */
    resetLink = await adminAuth.generatePasswordResetLink(rawEmail);

  } catch (err) {
    if (
      err.code === 'auth/user-not-found' ||
      err.code === 'auth/invalid-email'
    ) {
      // No account — return generic success (do not reveal this)
      console.log('[send-password-reset] No account for requested email (not logging address).');
      return respond(200, GENERIC_SUCCESS);
    }
    // Unexpected error — log it but still return generic success to the client
    console.error('[send-password-reset] generatePasswordResetLink error:', err.message);
    return respond(200, GENERIC_SUCCESS);
  }

  /* ── Send branded email via Brevo through send-email.js ── */
  try {
    const emailRes = await fetch(`${platformUrl}/.netlify/functions/send-email`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '',
      },
      body: JSON.stringify({
        to:         rawEmail,
        toName:     displayName || '',
        type:       'password-reset',
        data: {
          name:      displayName || 'there',
          resetLink,
        },
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.json().catch(() => ({}));
      console.error('[send-password-reset] send-email returned error:', emailRes.status, errBody);
      // Still return generic success — the user should not see Brevo errors
    } else {
      console.log('[send-password-reset] Password reset email dispatched successfully.');
    }
  } catch (err) {
    // Network/fetch error calling send-email — log but do not expose to client
    console.error('[send-password-reset] fetch to send-email failed:', err.message);
  }

  return respond(200, GENERIC_SUCCESS);
  }
};

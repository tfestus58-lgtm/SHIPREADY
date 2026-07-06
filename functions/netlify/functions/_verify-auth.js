/**
 * _verify-auth.js — Shared caller-identity verification helper
 *
 * Exports `verifyCaller(event)` which:
 *   1. Reads the Authorization header (handles both casings)
 *   2. Extracts the Bearer token
 *   3. Verifies it with Firebase Admin auth
 *   4. Returns the decoded token's uid
 *
 * Usage in any function:
 *   import { verifyCaller } from './_verify-auth';
 *   const callerUid = await verifyCaller(request, env);
 *   if (!callerUid) return respond(401, { error: 'Unauthorized.' });
 *
 * Keep webhooks (stripe, flutterwave, nowpayments) untouched —
 * they use signature verification, not user tokens.
 */

import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function ensureAdminInitialised(env) {
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
}

/**
 * Verifies the Firebase ID token in the Authorization header.
 *
 * @param {Request} request - Cloudflare Workers request object
 * @param {object} env - Cloudflare Workers env bindings (holds FIREBASE_SERVICE_ACCOUNT)
 * @returns {string|null} Verified uid, or null if token is missing/invalid
 */
async function verifyCaller(request, env) {
  // Handle both 'Authorization' and 'authorization' header casings
  const authHeader =
    request.headers.get('authorization') || request.headers.get('Authorization') || '';

  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;

  try {
    ensureAdminInitialised(env);
    const decoded = await getAuth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (err) {
    console.warn('[_verify-auth] Token verification failed:', err.message);
    return null;
  }
}

/**
 * Verifies the Firebase ID token in the Authorization header and also
 * returns the token's verified email claim. Added for functions that need
 * the caller's email as an authenticated value (e.g. matching guest orders
 * stamped with buyerEmail) rather than trusting a client-supplied email
 * string in the request body, which could be spoofed.
 *
 * @param {Request} request - Cloudflare Workers request object
 * @param {object} env - Cloudflare Workers env bindings (holds FIREBASE_SERVICE_ACCOUNT)
 * @returns {{uid: string, email: string|null}|null} Verified identity, or
 *          null if the token is missing/invalid
 */
async function verifyCallerWithEmail(request, env) {
  const authHeader =
    request.headers.get('authorization') || request.headers.get('Authorization') || '';

  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;

  try {
    ensureAdminInitialised(env);
    const decoded = await getAuth().verifyIdToken(idToken);
    return { uid: decoded.uid, email: decoded.email || null };
  } catch (err) {
    console.warn('[_verify-auth] Token verification failed:', err.message);
    return null;
  }
}

export { verifyCaller, verifyCallerWithEmail };

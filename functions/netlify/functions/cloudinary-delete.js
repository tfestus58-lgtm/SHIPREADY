/**
 * Netlify Function: cloudinary-delete.js
 * Deletes one or more assets from Cloudinary by public_id.
 *
 * POST body (JSON):
 *   {
 *     assets: [
 *       { publicId: string, resourceType: 'image'|'video'|'raw' },
 *       ...
 *     ]
 *   }
 *
 * Requires Firebase Auth token in Authorization header to verify the caller
 * owns the assets (publicId must start with their uid).
 *
 * Response:
 *   200 { deleted: [ { publicId, result } ] }
 *   400/401/500 { error: string }
 *
 * Env vars required:
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *   FIREBASE_SERVICE_ACCOUNT
 */

// Cloudflare Workers exposes the Web Crypto API as a global `crypto` object.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

let _auth = null;
function getFirebaseAuth(env) {
  if (_auth) return _auth;
  let serviceAccount;
  try {
    serviceAccount = JSON.parse((env && env.FIREBASE_SERVICE_ACCOUNT) || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  _auth = getAuth();
  return _auth;
}

/**
 * Deletes a single Cloudinary asset using the Admin API (destroy endpoint).
 * Returns the Cloudinary result string e.g. "ok" or "not found".
 */
async function destroyCloudinaryAsset(env, publicId, resourceType) {
  const cloudName = env && env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = env && env.CLOUDINARY_API_KEY;
  const apiSecret = env && env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary env vars not configured.');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigStr    = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const sigHashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sigStr));
  const signature = Array.from(new Uint8Array(sigHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  const body = [
    `public_id=${encodeURIComponent(publicId)}`,
    `api_key=${encodeURIComponent(apiKey)}`,
    `timestamp=${encodeURIComponent(timestamp)}`,
    `signature=${encodeURIComponent(signature)}`,
  ].join('&');

  const bodyBuf = new TextEncoder().encode(body);
  const type    = resourceType || 'image';

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${type}/destroy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: bodyBuf,
  });
  const data = await res.text();
  try {
    const parsed = JSON.parse(data);
    return parsed.result || 'unknown';
  } catch {
    return 'parse-error';
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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const rawText = await request.text();

  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  // ── Verify Firebase Auth token ──
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!idToken) {
    return respond(401, { error: 'Authorization token required.' });
  }

  let callerUid;
  try {
    const decoded = await getFirebaseAuth(env).verifyIdToken(idToken);
    callerUid = decoded.uid;
  } catch {
    return respond(401, { error: 'Invalid or expired authorization token.' });
  }

  // ── Parse body ──
  let payload;
  try { payload = JSON.parse(rawText || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON in request body.' }); }

  const { assets } = payload;
  if (!Array.isArray(assets) || assets.length === 0) {
    return respond(400, { error: 'assets array is required and must not be empty.' });
  }
  if (assets.length > 20) {
    return respond(400, { error: 'Maximum 20 assets per request.' });
  }

  // ── Ownership check: every publicId must start with the caller's uid ──
  for (const asset of assets) {
    if (!asset.publicId || typeof asset.publicId !== 'string') {
      return respond(400, { error: 'Each asset must have a publicId string.' });
    }
    // publicIds are stored as "uid-..." so we verify the prefix
    // FIX: previously checked startsWith(callerUid) with no separator,
    // so a uid that's a string-prefix of another uid (e.g. "abc123" vs
    // "abc1234567...") would incorrectly pass the check, letting one
    // user delete another's assets. Requiring "uid-" exactly matches the
    // naming convention used everywhere assets are created (see
    // upload-image.js, kyc-submit.js) and eliminates the collision.
    const segment = asset.publicId.split('/').pop() || asset.publicId;
    if (!segment.startsWith(callerUid + '-')) {
      return respond(403, { error: 'You do not have permission to delete asset: ' + asset.publicId });
    }
  }

  // ── Delete each asset ──
  const results = [];
  for (const asset of assets) {
    try {
      const result = await destroyCloudinaryAsset(env, asset.publicId, asset.resourceType || 'image');
      results.push({ publicId: asset.publicId, result });
    } catch (err) {
      console.warn('[cloudinary-delete] Failed to delete', asset.publicId, ':', err.message);
      results.push({ publicId: asset.publicId, result: 'error: ' + err.message });
    }
  }

  console.log('[cloudinary-delete] Deleted assets for uid:', callerUid, results);

  return respond(200, { deleted: results });
  }
};

function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Netlify Function: upload-image.js
 * Generic image uploader to Cloudinary.
 * Used for product covers, profile photos, etc.
 *
 * POST body (JSON):
 *   {
 *     image:  string,   // base64, no data: prefix
 *     folder: string,   // e.g. "products", "profiles"
 *     publicId: string, // must start with "{callerUid}-" — see FIX below
 *   }
 *
 * Response:
 *   200 { url: string }
 *   400/401/403/500 { error: string }
 *
 * Env vars required:
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *
 * FIX: this function previously had NO authentication at all — anyone on
 * the internet could POST arbitrary base64 content to it and upload to
 * the operator's Cloudinary account under any folder/publicId they chose,
 * with no rate limit or size cap. Worse, publicId was fully
 * attacker-controlled, so an attacker could overwrite any existing
 * image (profile photos, product covers) by guessing/knowing another
 * user's publicId (e.g. "{uid}-avatar", a predictable pattern already
 * used elsewhere in this app). Now requires a verified Firebase token,
 * and requires publicId to start with "{callerUid}-", matching the
 * pattern both legitimate frontend call sites already use.
 */

// Cloudflare Workers exposes the Web Crypto API as a global `crypto` object.
import { verifyCaller } from './_verify-auth';

async function uploadToCloudinary(base64Data, folder, publicId, env) {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary env vars not configured.');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigStr    = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const sigHashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sigStr));
  const signature = Array.from(new Uint8Array(sigHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const dataUri  = `data:image/jpeg;base64,${base64Data}`;

  const fields = {
    file:      dataUri,
    api_key:   apiKey,
    timestamp,
    public_id: publicId,
    folder,
    signature,
  };

  let body = '';
  for (const [key, val] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
  }
  body += `--${boundary}--\r\n`;

  const bodyBuf = new TextEncoder().encode(body);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyBuf,
  });
  const data = await res.text();
  try {
    const parsed = JSON.parse(data);
    if (parsed.secure_url) return parsed.secure_url;
    else throw new Error('Cloudinary error: ' + (parsed.error?.message || data));
  } catch (e) {
    if (e.message && e.message.startsWith('Cloudinary error:')) throw e;
    throw new Error('Cloudinary response error: ' + data.slice(0, 200));
  }
}

export async function onRequest(context) {
  const { request, env, ctx } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
  }

  const rawText = await request.text();

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  /* ── Verify caller identity (FIX — see header note) ── */
  const callerUid = await verifyCaller(request, env);
  if (!callerUid) {
    return new Response(JSON.stringify({ error: 'Unauthorized. Please log in again.' }), { status: 401 });
  }

  let payload;
  try { payload = JSON.parse(rawText || '{}'); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { image, folder, publicId } = payload;

  /* ── Ownership check (FIX) ──
     publicId must be namespaced under the caller's own uid, so one user
     can never overwrite or create assets under another user's identity.
     Both legitimate frontend call sites already construct publicId this
     way ("{uid}-avatar", "{uid}-cover-..."). */
  if (!publicId || typeof publicId !== 'string' || !publicId.startsWith(callerUid + '-')) {
    return new Response(JSON.stringify({ error: 'publicId must belong to the authenticated user.' }), { status: 403 });
  }

  if (!image || typeof image !== 'string' || image.length < 100) {
    return new Response(JSON.stringify({ error: 'image is required' }), { status: 400 });
  }
  if (!folder || !publicId) {
    return new Response(JSON.stringify({ error: 'folder and publicId are required' }), { status: 400 });
  }

  /* ── Folder allowlist (FIX) ──
     Without this, a caller could pass folder: "kyc" (or any other folder
     used elsewhere, e.g. "kreddlo-contracts") and write into the same
     Cloudinary namespace used for sensitive documents via this far less
     restricted, generic endpoint. */
  const ALLOWED_FOLDERS = ['profiles', 'products'];
  if (!ALLOWED_FOLDERS.includes(folder)) {
    return new Response(JSON.stringify({ error: 'Invalid folder.' }), { status: 400 });
  }

  /* ── Basic size cap (FIX) ──
     No limit previously existed; a large base64 payload could be used to
     run up Cloudinary storage/bandwidth costs or strain the function's
     memory. ~8MB of base64 is roughly 6MB of binary image data, which is
     generous for a profile photo or product cover. */
  const MAX_BASE64_LENGTH = 8 * 1024 * 1024;
  if (image.length > MAX_BASE64_LENGTH) {
    return new Response(JSON.stringify({ error: 'Image is too large.' }), { status: 400 });
  }

  try {
    const url = await uploadToCloudinary(image, folder, publicId, env);
    return new Response(JSON.stringify({ url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('upload-image error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
  }

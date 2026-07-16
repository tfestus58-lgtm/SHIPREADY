/**
 * Netlify Function: kyc-submit.js
 *
 * Receives a POST from verify.html with base64-encoded images (front, back, selfie).
 * Uploads them to Cloudinary (free tier — no Firebase Storage needed).
 * Saves the permanent Cloudinary URLs to Firestore users/{uid}.kycImages.
 * Sets kycStatus to 'under-review'.
 *
 * Environment variables required (Netlify UI → Site settings → Env vars):
 *   FIREBASE_SERVICE_ACCOUNT   — single-line JSON service account
 *   CLOUDINARY_CLOUD_NAME      — e.g. "my-cloud"
 *   CLOUDINARY_API_KEY         — from Cloudinary dashboard
 *   CLOUDINARY_API_SECRET      — from Cloudinary dashboard
 *
 * Optional:
 *   BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME, ADMIN_EMAIL, PLATFORM_URL
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCaller } from './_verify-auth';
import { checkRateLimit } from './_rate-limit';
import { sanitizeString } from './_sanitize';
// Cloudflare Workers exposes the Web Crypto API as a global `crypto` object.

/* ── Allowed KYC document types ──
   Kept in sync with the <select id="doc-type-select"> options in verify.html.
   Anything outside this list (bad client, stale cache, tampered request) is
   coerced to the 'NIN Card' default rather than rejected outright, so a
   malformed/missing value never blocks a legitimate submission. */
const ALLOWED_DOCUMENT_TYPES = [
  'NIN Card',
  'International Passport',
  "Driver's License",
  "Voter's Card",
  'National ID Card',
];

/* ── Firebase Admin singleton ── */
function getDb(env) {
  if (!getApps().length) {
    let sa;
    try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

/* ── Upload one base64 image to Cloudinary ── */
async function uploadToCloudinary(base64Data, mimeType, publicId, env) {
  const cloudName  = env.CLOUDINARY_CLOUD_NAME;
  const apiKey     = env.CLOUDINARY_API_KEY;
  const apiSecret  = env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary env vars not set (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET).');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder    = 'kyc';

  // Build signature
  const sigStr  = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const sigHashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sigStr));
  const signature = Array.from(new Uint8Array(sigHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Build multipart form body
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const dataUri  = `data:${mimeType};base64,${base64Data}`;

  const fields = {
    file:       dataUri,
    api_key:    apiKey,
    timestamp:  timestamp,
    public_id:  publicId,
    folder:     folder,
    signature:  signature,
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
    if (parsed.secure_url) {
      return parsed.secure_url;
    } else {
      throw new Error('Cloudinary error: ' + (parsed.error?.message || data));
    }
  } catch (e) {
    if (e.message && e.message.startsWith('Cloudinary error:')) throw e;
    throw new Error('Cloudinary response parse error: ' + data.slice(0, 200));
  }
}

/* ── Optional admin notification email ── */
async function notifyAdmin({ uid, adminEmail, platformUrl, env, documentType }) {
  const apiKey = env.BREVO_API_KEY;
  if (!apiKey || !adminEmail) return;

  const senderEmail = env.BREVO_SENDER_EMAIL || 'noreply@kreddlo.com';
  const senderName  = env.BREVO_SENDER_NAME  || 'Kreddlo';
  // platformUrl is passed in by the caller (sourced from env.PLATFORM_URL);
  // the literal string below is only a last-resort fallback if that env var is unset.
  const reviewUrl   = (platformUrl || env.PLATFORM_URL || 'https://kreddlo.space') + '/admin.html';
  const docLabel     = documentType || 'identity document';

  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: { 'accept': 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender:      { email: senderEmail, name: senderName },
        to:          [{ email: adminEmail }],
        subject:     'New KYC Submission — Action Required',
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
          <h2 style="color:#0d2145;margin:0 0 12px 0;">New KYC Submission</h2>
          <p style="color:#4a5568;font-size:15px;line-height:1.6;margin:0 0 20px 0;">
            A freelancer (UID: <code>${uid}</code>) has submitted their ${docLabel} and selfie for identity verification.
          </p>
          <a href="${reviewUrl}" style="display:inline-block;background:#2d8a5e;color:#fff;text-decoration:none;padding:13px 28px;border-radius:50px;font-weight:600;font-size:15px;">
            Review in Admin Panel
          </a>
        </div>`,
      }),
    });
  } catch (err) {
    console.warn('Admin notification email failed:', err.message);
  }
}

/* ════════════════════════════════════
   MAIN HANDLER
════════════════════════════════════ */
export default {
  async fetch(request, env, ctx) {
  /* CORS preflight */
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
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(request, env);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  /* Parse body */
  let payload;
  try { payload = JSON.parse(rawText || '{}'); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 }); }

  const { uid, frontImage, backImage, selfieImage } = payload;

  // Sanitize free-text KYC fields before any downstream use
  const fullName    = sanitizeString(payload.fullName,    80);
  const address     = sanitizeString(payload.address,     200);
  const idNumber    = sanitizeString(payload.idNumber,    50);
  const phoneNumber = sanitizeString(payload.phoneNumber, 20);

  // Validate the submitted document type against the allow-list. Anything
  // unrecognized (missing field, tampered value, stale client) falls back
  // to 'NIN Card' rather than failing the request.
  const rawDocumentType = sanitizeString(payload.documentType, 40);
  const documentType    = ALLOWED_DOCUMENT_TYPES.includes(rawDocumentType)
    ? rawDocumentType
    : 'NIN Card';

  console.log('KYC submit — uid:', uid, 'documentType:', documentType, 'frontImage length:', frontImage?.length, 'backImage length:', backImage?.length, 'selfieImage length:', selfieImage?.length);

  /* Validate uid */
  if (!uid || typeof uid !== 'string' || uid.length < 4) {
    console.error('Invalid uid:', uid);
    return new Response(JSON.stringify({ error: 'Invalid uid' }), { status: 400 });
  }

  /* ── FIX: bind uid to the verified caller ──
     Previously `uid` was taken from the request body and used for the
     Firestore lookup, Cloudinary public IDs, and the eventual kycStatus
     write — with no check that it matched the verified token's uid. Any
     authenticated user could submit (or overwrite) another user's KYC
     documents by passing that user's uid in the body. */
  if (uid !== callerUid) {
    return new Response(JSON.stringify({ error: 'You can only submit verification documents for your own account.' }), { status: 403 });
  }

  /* Validate images present */
  for (const [name, data] of [['frontImage', frontImage], ['backImage', backImage], ['selfieImage', selfieImage]]) {
    if (!data || typeof data !== 'string' || data.length < 100) {
      console.error(name, 'is missing or too short');
      return new Response(JSON.stringify({ error: name + ' is missing' }), { status: 400 });
    }
  }

  /* Firebase */
  let db;
  try { db = getDb(env); }
  catch (err) {
    console.error('Firebase init error:', err.message);
    return new Response(JSON.stringify({ error: 'Server configuration error: ' + err.message }), { status: 500 });
  }

  /* ── Server-side rate limit: 3 KYC submissions per 60 minutes per uid ──
     KYC involves Cloudinary uploads and admin email notifications — an
     abuser resubmitting in a loop would burn through storage, email quota,
     and Cloudinary bandwidth. 3 per hour is generous for legitimate retries
     (e.g. blurry photo) while making abuse impractical. */
  try {
    const rl = await checkRateLimit(db, `kyc::${uid}`, 3, 3600);
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: rl.error, retryAfter: rl.retryAfter }), { status: 429 });
    }
  } catch (rlErr) {
    // Non-fatal — if rate-limit check itself errors, fail open so legitimate
    // KYC submissions are never blocked by a transient Firestore hiccup.
    console.warn('[kyc-submit] Rate-limit check error (failing open):', rlErr.message);
  }

  /* Check user exists and isn't already verified */
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return new Response(JSON.stringify({ error: 'User not found in database' }), { status: 400 });
    }
    if (userSnap.data().kycStatus === 'verified') {
      return new Response(JSON.stringify({ error: 'User is already verified' }), { status: 400 });
    }
  } catch (err) {
    console.error('Firestore user lookup failed:', err.message);
    return new Response(JSON.stringify({ error: 'Database error: ' + err.message }), { status: 500 });
  }

  /* Upload to Cloudinary */
  let frontUrl, backUrl, selfieUrl;
  try {
    console.log('Uploading to Cloudinary...');
    [frontUrl, backUrl, selfieUrl] = await Promise.all([
      uploadToCloudinary(frontImage,  'image/jpeg', `${uid}-nin-front`, env),
      uploadToCloudinary(backImage,   'image/jpeg', `${uid}-nin-back`, env),
      uploadToCloudinary(selfieImage, 'image/jpeg', `${uid}-selfie`, env),
    ]);
    console.log('Cloudinary upload success. frontUrl:', frontUrl);
  } catch (err) {
    console.error('Cloudinary upload error:', err.message);
    return new Response(JSON.stringify({ error: 'Image upload failed: ' + err.message }), { status: 500 });
  }

  /* Write to Firestore */
  try {
    await db.collection('users').doc(uid).update({
      kycStatus:          'under-review',
      kycDocumentType:    documentType,
      kycSubmittedAt:     FieldValue.serverTimestamp(),
      kycImages: { frontUrl, backUrl, selfieUrl },
      kycRejectionReason: FieldValue.delete(),
      // Sanitized identity fields — written only if provided by the user
      ...(fullName    ? { kycFullName:    fullName }    : {}),
      ...(address     ? { kycAddress:     address }     : {}),
      ...(idNumber    ? { kycIdNumber:    idNumber }    : {}),
      ...(phoneNumber ? { kycPhoneNumber: phoneNumber } : {}),
    });
  } catch (err) {
    console.error('Firestore update error:', err.message);
    return new Response(JSON.stringify({ error: 'Failed to save submission: ' + err.message }), { status: 500 });
  }

  /* Notify admin */
  await notifyAdmin({ uid, adminEmail: env.ADMIN_EMAIL, platformUrl: env.PLATFORM_URL, env, documentType });

  console.log('KYC submitted successfully for uid:', uid);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  }
};

function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
}

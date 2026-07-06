/**
 * Netlify Function: send-smart-notification.js
 * Path: netlify/functions/send-smart-notification.js
 *
 * Unified notification dispatcher. Handles:
 *   1. Writing an in-app notification to Firestore (always)
 *   2. Sending an FCM push notification (if user has a token)
 *   3. Sending a transactional email via send-email (emailMode controls timing)
 *
 * POST body:
 *   {
 *     userUid:      string        — Firebase UID of the recipient (in-app notif + FCM)
 *     title:        string        — notification title
 *     body:         string        — notification body text
 *     url?:         string        — optional deep-link URL
 *     templateId:   string        — email template ID (matches send-email.js)
 *     emailData:    object        — data object passed to the email template
 *     emailMode:    'always' | 'delayed' | 'never'
 *     delayMinutes: number        — delay in minutes for 'delayed' mode (default 15)
 *     emailTo?:     string        — override: send email to this address instead of
 *                                   userUid's Firestore email. The in-app notif and
 *                                   FCM push still go to userUid as normal.
 *                                   Used by deliver-product.js to send the 48hr
 *                                   review-request email to the BUYER while the
 *                                   in-app notification targets the SELLER's uid.
 *     emailToName?: string        — display name to pair with emailTo override.
 *   }
 *
 * AUTHENTICATION — two allowed caller types:
 *   1. Trusted server-to-server callers (Netlify function → Netlify function,
 *      e.g. payment webhooks, approve-delivery, sign-contract, scheduled jobs).
 *      These send header  'x-internal-secret: <INTERNAL_FUNCTION_SECRET>'
 *      instead of a user auth token, since there is no signed-in user behind
 *      a webhook or scheduled job.
 *   2. An authenticated admin calling from admin.html (broadcast/single-user
 *      notification tool). These send a normal Firebase ID token in the
 *      Authorization header, and the caller's `users/{uid}.role` must be
 *      'admin'.
 *   A request must satisfy ONE of the two — neither grants the other's access.
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT   — full service account JSON (single-line string)
 *   PLATFORM_URL               — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET   — shared secret used ONLY for server-to-server
 *                                calls between Netlify functions. Never expose
 *                                this to the browser/client. Set it in Netlify
 *                                env vars and reuse the exact same value in
 *                                every function that calls this one internally.
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';
// Cloudflare Workers exposes the Web Crypto API as a global `crypto` object.
import { verifyCaller }                 from './_verify-auth';

/* ── Firebase Admin — lazy singleton ── */
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

/* ── Extract project_id for FCM HTTP v1 endpoint ── */
function getProjectId(env) {
  try {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}');
    return sa.project_id || '';
  } catch {
    return '';
  }
}

/* ── Generate a Google OAuth 2.0 access token from the service account ── */
async function getGoogleAccessToken(env) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}');

  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  const header   = { alg: 'RS256', typ: 'JWT' };
  const b64url   = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  // Sign with the private key using the Web Crypto API (RSASSA-PKCS1-v1_5 / SHA-256)
  const privateKey = await importRsaPrivateKey(sa.private_key);
  const sigBuffer   = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsigned)
  );
  const signature = arrayBufferToBase64Url(sigBuffer);
  const jwt       = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google OAuth token exchange failed: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

// Converts a PEM-encoded PKCS#8 private key (as found in the Firebase
// service account JSON) into a Web Crypto CryptoKey usable for signing.
async function importRsaPrivateKey(pem) {
  const pemBody = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const binaryDer = atob(pemBody);
  const derBytes  = new Uint8Array(binaryDer.length);
  for (let i = 0; i < binaryDer.length; i++) derBytes[i] = binaryDer.charCodeAt(i);
  return crypto.subtle.importKey(
    'pkcs8',
    derBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// Encodes a raw signature ArrayBuffer as base64url (no padding).
function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── Send FCM push via HTTP v1 API ── */
async function sendFcmPush({ fcmToken, title, body, url, env }) {
  const projectId   = getProjectId(env);
  const accessToken = await getGoogleAccessToken(env);
  const fcmEndpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const message = {
    message: {
      token: fcmToken,
      notification: { title, body },
      data: {
        url:          url || '',
        title,
        body,
        click_action: url || '',
      },
      webpush: {
        notification: {
          title,
          body,
          icon:  '/assets/kreddlo-192.png',
          badge: '/assets/favicon-32x32.png',
        },
        fcm_options: { link: url || '/' },
      },
    },
  };

  const res = await fetch(fcmEndpoint, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const fcmError = errBody?.error?.details?.[0]?.errorCode || '';
    const stale    = ['registration-token-not-registered', 'invalid-registration-token'];
    if (stale.includes(fcmError)) return { sent: false, staleToken: true };
    throw new Error(`FCM push failed: ${JSON.stringify(errBody)}`);
  }

  return { sent: true, staleToken: false };
}

/* ── Call a sibling Netlify function by name ── */
async function callFunction(env, name, payload) {
  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return null;
  }
  const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '',
    },
    body:    JSON.stringify(payload),
  });
  return res;
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export default {
async fetch(request, env, ctx) {

  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  // Two allowed caller types — see header comment:
  //   1. Trusted internal server-to-server call (shared secret header)
  //   2. Authenticated admin (Firebase ID token + role === 'admin')
  const internalSecretHeader =
    request.headers.get('x-internal-secret') || request.headers.get('X-Internal-Secret') || '';
  const expectedInternalSecret = env.INTERNAL_FUNCTION_SECRET || '';
  const isTrustedInternalCall =
    !!expectedInternalSecret && internalSecretHeader === expectedInternalSecret;

  let db;

  if (isTrustedInternalCall) {
    // Server-to-server call — already trusted, skip user/role checks.
    try {
      db = getDb(env);
    } catch (err) {
      console.error('getDb() failed for internal call:', err.message);
      return respond(500, { error: 'Database initialization failed.' });
    }
  } else {
    // Fall back to admin-token auth (used by admin.html).
    const callerUid = await verifyCaller(request, env);
    if (!callerUid) {
      return respond(401, { error: 'Unauthorized.' });
    }

    try {
      db = getDb(env);
      const callerSnap = await db.collection('users').doc(callerUid).get();
      if (!callerSnap.exists || callerSnap.data().role !== 'admin') {
        return respond(403, { error: 'Forbidden — admin role required.' });
      }
    } catch (err) {
      console.error('Caller role check failed:', err.message);
      return respond(500, { error: 'Could not verify caller permissions.' });
    }
  }

  const rawText = await request.text();
  let payload;
  try {
    payload = JSON.parse(rawText || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    userUid,
    title,
    body,
    url,
    templateId,
    emailData    = {},
    emailMode    = 'never',
    delayMinutes = 15,
    // Issue 6 fix: optional email recipient override.
    // When present, the transactional email goes to emailTo / emailToName
    // instead of the Firestore-fetched email for userUid. The in-app
    // notification and FCM push still target userUid as normal.
    // Used by deliver-product.js for the buyer review-request email:
    // the in-app notif records against the seller's uid (for dashboard
    // display purposes) while the actual email goes to the buyer.
    emailTo     = null,
    emailToName = null,
  } = payload;

  if (!userUid) return respond(400, { error: 'userUid is required.' });
  if (!title)   return respond(400, { error: 'title is required.' });
  if (!body)    return respond(400, { error: 'body is required.' });
  // templateId is only required when an email will actually be sent
  if (!templateId && emailMode !== 'never') {
    return respond(400, { error: 'templateId is required when emailMode is not "never".' });
  }

  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const notifUrl    = url || `${platformUrl}/dashboard.html`;

  /* ── Step 1: Fetch user from Firestore ── */
  let userSnap;
  try {
    userSnap = await db.collection('users').doc(userUid).get();
  } catch (err) {
    console.error('Firestore read failed:', err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!userSnap.exists) {
    console.warn(`send-smart-notification: user ${userUid} not found.`);
    return respond(404, { error: 'User not found.' });
  }

  const { fcmToken, email: firestoreEmail, name: firestoreName } = userSnap.data();

  // Issue 6 fix: use the caller-supplied emailTo / emailToName when present,
  // otherwise fall back to the Firestore values for this user.
  // This lets server functions send an email to a DIFFERENT user (e.g. the buyer)
  // while the in-app notification and FCM push still target userUid (e.g. the seller).
  const recipientEmail = emailTo   || firestoreEmail || null;
  const recipientName  = emailToName || firestoreName  || null;

  /* ── Step 2: Write in-app notification document ── */
  /* Map templateId → broad notification category so notifications.html
     filter tabs (Payments, Projects, Account) work correctly.
     The tab filter matches n.type === currentFilter, so type must be
     one of the four TYPE_CONFIG keys: 'payment' | 'project' | 'account' | 'admin'. */
  const TEMPLATE_TYPE_MAP = {
    'payment-received':           'payment',
    'payment-confirmed-buyer':    'payment',
    'withdrawal-initiated':       'payment',
    'bank-withdrawal-initiated':  'payment',
    'withdrawal-failed':          'payment',
    'referral-credited':          'payment',
    'invoice-escrow-held-seller': 'payment',
    'invoice-escrow-released':    'payment',
    'new-project-request':        'project',
    'contract-active':            'project',
    'contract-sign-requested':    'project',
    'contract-declined':          'project',
    'contract-change-proposed':   'project',
    'contract-change-accepted':   'project',
    'contract-change-rejected':   'project',
    'work-delivered':             'project',
    'delivery-confirmed-buyer':   'project',
    'dispute-raised':             'project',
    'dispute-resolved':           'project',
    'new-review':                 'project',
    'review-request':             'project',
  };
  const notifType = TEMPLATE_TYPE_MAP[templateId] || 'account';

  let notifDocId;
  try {
    const notifRef = await db
      .collection('users')
      .doc(userUid)
      .collection('notifications')
      .add({
        title,
        body,
        url:        notifUrl,
        templateId,
        type:       notifType,
        read:       false,
        emailSent:  false,
        emailMode,
        createdAt:  FieldValue.serverTimestamp(),
      });
    notifDocId = notifRef.id;
    console.log(`In-app notification written for uid ${userUid}, docId ${notifDocId}.`);
  } catch (err) {
    // Non-fatal — log and continue
    console.error(`Failed to write in-app notification for uid ${userUid}:`, err.message);
  }

  /* ── Step 3: Send FCM push if token exists ── */
  if (fcmToken) {
    try {
      const result = await sendFcmPush({ fcmToken, title, body, url: notifUrl, env });
      if (result.staleToken) {
        await db.collection('users').doc(userUid).update({ fcmToken: null });
        console.log(`Stale FCM token cleared for uid ${userUid}.`);
      } else {
        console.log(`FCM push sent to uid ${userUid}.`);
      }
    } catch (err) {
      // Non-fatal — in-app notification already written
      console.error(`FCM push failed for uid ${userUid}:`, err.message);
    }
  } else {
    console.log(`uid ${userUid} has no fcmToken — in-app only.`);
  }

  /* ── Step 4: Handle email based on emailMode ── */
  if (emailMode === 'never') {
    return respond(200, { received: true, notifDocId });
  }

  if (emailMode === 'always') {
    if (!recipientEmail) {
      console.warn(`uid ${userUid} has no email on file — skipping immediate email send (template ${templateId}).`);
      return respond(200, { received: true, notifDocId });
    }
    try {
      // FIX (audit finding N2): callFunction() resolves normally on a 4xx/5xx
      // response — fetch() only throws on network-level failure — so the
      // result must be checked explicitly before trusting the email actually
      // sent. Previously this awaited the call and unconditionally marked
      // emailSent: true, which meant a bad templateId, a missing
      // BREVO_API_KEY, or a Brevo outage all got silently recorded as a
      // successful send. Same res.ok check process-email-queue.js already
      // uses for this exact call.
      const res = await callFunction(env, 'send-email', {
        to:     recipientEmail,
        toName: recipientName || undefined,
        templateId,
        data:   emailData,
      });

      if (res && res.ok) {
        // Mark emailSent on the notification document
        if (notifDocId) {
          await db
            .collection('users').doc(userUid)
            .collection('notifications').doc(notifDocId)
            .update({ emailSent: true, emailSentAt: new Date().toISOString() });
        }
        console.log(`Email sent immediately for uid ${userUid}, template ${templateId}.`);
      } else {
        const status = res ? res.status : 'no response';
        console.error(`send-email returned ${status} for uid ${userUid}, template ${templateId} — not marking emailSent.`);
      }
    } catch (err) {
      console.error(`Email send failed for uid ${userUid}:`, err.message);
    }
    return respond(200, { received: true, notifDocId });
  }

  if (emailMode === 'delayed') {
    if (!recipientEmail) {
      console.warn(`uid ${userUid} has no email on file — skipping delayed email queue (template ${templateId}).`);
      return respond(200, { received: true, notifDocId });
    }
    try {
      await db.collection('email-queue').add({
        userUid,
        notifDocId:  notifDocId || null,
        templateId,
        emailData,
        to:          recipientEmail,
        toName:      recipientName || null,
        // Issue 6 fix — Issue C audit verification:
        // recipientEmail is resolved above as: emailTo || firestoreEmail
        // and written here as `to`. process-email-queue.js reads `to` directly
        // (it only falls back to a Firestore lookup when `to` is absent), so
        // the emailTo override is fully preserved for delayed emails without
        // any extra logic in the queue processor. emailToOverride: true is a
        // diagnostic flag so audit logs in process-email-queue.js can confirm
        // the override path was used — it does not affect send behaviour.
        ...(emailTo ? { emailToOverride: true } : {}),
        sendAfter:   Date.now() + delayMinutes * 60 * 1000,
        sent:        false,
        createdAt:   FieldValue.serverTimestamp(),
      });
      console.log(`Email queued for uid ${userUid} in ${delayMinutes} min, template ${templateId}.`);
    } catch (err) {
      console.error(`Failed to queue email for uid ${userUid}:`, err.message);
    }
    return respond(200, { received: true, notifDocId });
  }

  // Fallback for unknown emailMode
  return respond(200, { received: true, notifDocId });
}
};

/* ── Utility ── */
function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

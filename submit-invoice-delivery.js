/**
 * Netlify Function: submit-invoice-delivery.js
 * Path: netlify/functions/submit-invoice-delivery.js
 *
 * Called when a freelancer marks an invoice as delivered.
 * - Verifies the caller is the invoice owner (sellerUid)
 * - Updates the invoice: status → delivered, deliveredAt → now
 * - Emails the buyer a confirmation link (token-based, no login required)
 * - Emails the freelancer a "delivery submitted" confirmation
 *
 * POST body:
 *   { invoiceId: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT
 *   PLATFORM_URL
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';
import { verifyCaller }                 from './_verify-auth';
// Cloudflare Workers exposes the Web Crypto API as a global `crypto` object.

let _db = null;
function getDb(env) {
  if (_db) return _db;
  let serviceAccount;
  try { serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
  _db = getFirestore();
  return _db;
}

async function callFunction(env, functionName, payload) {
  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) return;
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`${functionName} returned ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/*
 * FIX: this token is the sole authorization for confirm-invoice-delivery.js
 * to release escrowed funds to the seller — it needed to be unguessable,
 * not just "random enough". The previous implementation used Math.random(),
 * which is not cryptographically secure (predictable PRNG, not meant for
 * security tokens), plus a Date.now() suffix that narrows the search space
 * even further. Now uses crypto.randomBytes for a 256-bit token.
 */
function makeToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const { request, env, ctx } = context;
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  const callerUid = await verifyCaller(request, env);
  if (!callerUid) return respond(401, { error: 'Unauthorized. Please log in again.' });

  const rawText = await request.text();
  let body;
  try { body = JSON.parse(rawText || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON body.' }); }

  const { invoiceId } = body;
  if (!invoiceId || typeof invoiceId !== 'string') return respond(400, { error: 'invoiceId is required.' });

  let db;
  try { db = getDb(env); }
  catch (err) { return respond(500, { error: 'Database not available.' }); }

  /* ── Generate a confirmation token for the buyer ── */
  const confirmToken = makeToken();
  const platformUrl  = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  /* ── Atomically verify status and update invoice ──
     Issue 10 fix: the pre-fix code read the invoice outside a transaction
     then wrote it in a separate non-transactional update. A rapid double-tap
     (two near-simultaneous POST requests from the same freelancer) could both
     pass the status === 'escrow' check and both write a fresh confirmToken,
     causing the first buyer email's confirmation link to be silently
     invalidated. Now the read, status check, and write all happen inside a
     single Firestore transaction — the second call will re-read the already-
     'delivered' doc and correctly return 400, so only one email is sent and
     only one confirmToken is ever active at a time. */
  let invoice;
  try {
    await db.runTransaction(async (tx) => {
      const invoiceRef  = db.collection('invoices').doc(invoiceId);
      const invoiceSnap = await tx.get(invoiceRef);

      if (!invoiceSnap.exists) throw Object.assign(new Error('Invoice not found.'), { code: 404 });
      const data = invoiceSnap.data();

      if (data.uid !== callerUid) throw Object.assign(new Error('Not authorised for this invoice.'), { code: 403 });
      if (data.status !== 'escrow') throw Object.assign(new Error(`Invoice must be in escrow to mark as delivered (current status: ${data.status}).`), { code: 400 });

      /* Issue D audit note: confirmToken is written HERE and only here —
         not at invoice creation, not by any payment webhook. The buyer's
         confirmation link (emailed below) carries this token. When the
         buyer clicks it, confirm-invoice-delivery.js validates it against
         this field. Because the token is set atomically in the same
         transaction that flips status to 'delivered', there is no window
         where the invoice is 'delivered' but has no valid token. */
      tx.update(invoiceRef, {
        status:       'delivered',
        deliveredAt:  FieldValue.serverTimestamp(),
        confirmToken,
        updatedAt:    FieldValue.serverTimestamp(),
      });

      invoice = data; // capture for use after transaction
    });
    console.log(`Invoice ${invoiceId} marked as delivered by ${callerUid}.`);
  } catch (err) {
    if (err.code === 404) return respond(404, { error: err.message });
    if (err.code === 403) return respond(403, { error: err.message });
    if (err.code === 400) return respond(400, { error: err.message });
    console.error('[submit-invoice-delivery] Transaction error:', err.message);
    return respond(500, { error: 'Failed to update invoice status.' });
  }

  /* ── Fetch user details ── */
  let freelancerName = 'Freelancer';
  let freelancerEmail = null;
  const clientEmail  = (invoice.clientEmail || '').trim().toLowerCase();
  const clientName   = invoice.clientName || 'Client';
  const invoiceNumber = invoice.invoiceNumber || invoiceId;

  try {
    const fSnap = await db.collection('users').doc(callerUid).get();
    if (fSnap.exists) {
      freelancerName  = fSnap.data().name || fSnap.data().displayName || 'Freelancer';
      freelancerEmail = fSnap.data().email || null;
    }
  } catch (_) {}

  const confirmUrl = `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&confirmToken=${encodeURIComponent(confirmToken)}`;

  /* ── Email buyer: delivery confirmation link ── */
  if (clientEmail) {
    await callFunction(env, 'send-email', {
      to:     clientEmail,
      toName: clientName,
      type:   'invoice-delivered-buyer',
      data: {
        name:           clientName,
        freelancerName,
        invoiceNumber,
        confirmUrl,
      },
    });
  }

  /* ── Email seller: delivery submitted confirmation ── */
  if (freelancerEmail) {
    await callFunction(env, 'send-email', {
      to:     freelancerEmail,
      toName: freelancerName,
      type:   'invoice-delivered-seller',
      data: {
        name:          freelancerName,
        invoiceNumber,
        clientName,
      },
    });
  }

  return respond(200, { success: true, message: 'Invoice marked as delivered. The client has been notified to confirm.' });
}

function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

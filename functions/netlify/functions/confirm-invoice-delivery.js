/**
 * Netlify Function: confirm-invoice-delivery.js
 * Path: netlify/functions/confirm-invoice-delivery.js
 *
 * Called when the buyer clicks their confirmation link (token-based, no auth required).
 * - Validates the confirmToken against the invoice doc
 * - Credits sellerAmount (read from invoice.escrowSellerAmount, set by the payment
 *   webhook when funds entered escrow) directly to the seller's balances.${currency}
 *   (and availableBalance for USD). The user doc's escrowBalance field is NOT used
 *   in the invoice flow — escrow is tracked via escrowSellerAmount on the invoice
 *   doc and the escrow-holds collection, both written server-side at payment time.
 * - Updates invoice status → completed
 * - Notifies the freelancer that funds are released
 *
 * POST body:
 *   { invoiceId: string, confirmToken: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT
 *   PLATFORM_URL
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';

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

async function callFunction(functionName, payload, env) {
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

export default {
  async fetch(request, env, ctx) {
  const rawText = await request.text();
  if (request.method !== 'POST') return respond(405, { error: 'Method not allowed.' });

  let body;
  try { body = JSON.parse(rawText || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON body.' }); }

  const { invoiceId, confirmToken } = body;
  if (!invoiceId || typeof invoiceId !== 'string') return respond(400, { error: 'invoiceId is required.' });
  if (!confirmToken || typeof confirmToken !== 'string') return respond(400, { error: 'confirmToken is required.' });

  let db;
  try { db = getDb(env); }
  catch (err) { return respond(500, { error: 'Database not available.' }); }

  /* ── Atomic: validate token, check status, mark completed, credit balance ──
     All reads and writes that must happen together go inside one transaction.
     HTTP calls (notifications) stay outside — Firestore transactions must only
     contain Firestore reads/writes or they'll fail/retry unpredictably. ── */

  let alreadyCompleted = false;
  let sellerUid        = null;
  let sellerAmount     = 0;
  let currency         = 'USD';
  let invoiceNumber    = invoiceId;
  let isCryptoInvoice  = false;

  try {
    await db.runTransaction(async (tx) => {
      const invoiceRef  = db.collection('invoices').doc(invoiceId);
      const invoiceSnap = await tx.get(invoiceRef);

      if (!invoiceSnap.exists) {
        const err = new Error('Invoice not found.');
        err.statusCode = 404;
        throw err;
      }

      const invoice = invoiceSnap.data();

      /* Token validation —————————————————————————————————————————————————
         Issue D audit check (confirmed not a bug):
         confirmToken is NOT set at invoice creation time and is NOT written
         by any payment webhook. It is written exclusively by
         submit-invoice-delivery.js when the freelancer marks the invoice as
         delivered (status escrow → delivered), at which point the buyer is
         emailed a confirmation link containing the token. This function is
         only ever reachable by the buyer AFTER that delivery step, so
         confirmToken is always present on the invoice doc by the time this
         validation runs. A missing / mismatched token here means the link
         was tampered with, stale, or the invoice was never marked delivered
         — all correctly rejected by this check.
      ─────────────────────────────────────────────────────────────────── */
      if (!invoice.confirmToken || invoice.confirmToken !== confirmToken) {
        const err = new Error('Invalid or expired confirmation token.');
        err.statusCode = 403;
        throw err;
      }

      /* Idempotency: already completed — set flag and exit transaction cleanly */
      if (invoice.status === 'completed') {
        alreadyCompleted = true;
        return;
      }

      /* Invoice must be in delivered state */
      if (invoice.status !== 'delivered') {
        const err = new Error(`Invoice cannot be confirmed in status "${invoice.status}".`);
        err.statusCode = 400;
        throw err;
      }

      sellerUid     = invoice.uid;
      sellerAmount  = Number(invoice.escrowSellerAmount || 0);
      currency      = (invoice.currency || 'USD').toUpperCase();
      invoiceNumber = invoice.invoiceNumber || invoiceId;
      // FIX — crypto/fiat balance separation. invoice.paymentMethod is set
      // by flutterwave-webhook.js / stripe-webhook.js / nowpayments-webhook.js
      // when escrow is first placed ('flutterwave'/'stripe'/'crypto').
      // Without checking this, every USD invoice (including crypto-paid
      // ones) was credited to availableBalance, the fiat bank-withdrawal
      // pool — letting crypto-origin money leave through the wrong rail.
      isCryptoInvoice = invoice.paymentMethod === 'crypto';

      if (!sellerUid) {
        const err = new Error('Invoice has no seller.');
        err.statusCode = 400;
        throw err;
      }

      /* Mark invoice completed */
      tx.update(invoiceRef, {
        status:      'completed',
        completedAt: FieldValue.serverTimestamp(),
        updatedAt:   FieldValue.serverTimestamp(),
      });

      /* Atomically credit seller balance in the same transaction */
      if (sellerAmount > 0) {
        const userRef = db.collection('users').doc(sellerUid);
        const balanceUpdate = {
          [`balances.${currency}`]:             FieldValue.increment(sellerAmount),
          // Legacy blended figure — kept for older admin tooling only.
          totalEarned:                          FieldValue.increment(sellerAmount),
          // Accurate, currency-separated figure for any seller-facing display.
          [`totalEarnedByCurrency.${currency}`]: FieldValue.increment(sellerAmount),
          updatedAt:                             FieldValue.serverTimestamp(),
        };
        if (currency === 'USD') {
          if (isCryptoInvoice) {
            // Crypto-sourced USD → dedicated cryptoBalance pool. Only this
            // pool is debited by create-payout.js for crypto withdrawals —
            // never availableBalance.
            balanceUpdate.cryptoBalance = FieldValue.increment(sellerAmount);
          } else {
            // Fiat-sourced USD (Stripe, Flutterwave) → availableBalance,
            // the bank-withdrawal pool debited by create-bank-payout.js.
            balanceUpdate.availableBalance = FieldValue.increment(sellerAmount);
          }
        }
        tx.update(userRef, balanceUpdate);
      }
    });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 404) return respond(404, { error: err.message });
    if (code === 403) return respond(403, { error: err.message });
    if (code === 400) return respond(400, { error: err.message });
    console.error(`Transaction failed for invoice ${invoiceId}:`, err.message);
    return respond(500, { error: 'Failed to confirm invoice delivery.' });
  }

  /* Idempotency short-circuit — transaction saw it was already completed */
  if (alreadyCompleted) {
    return respond(200, { success: true, message: 'This delivery was already confirmed.' });
  }

  console.log(`Invoice ${invoiceId} confirmed as completed. Released ${sellerAmount} ${currency} to seller ${sellerUid}.`);

  /* ── Update escrow-holds record (outside transaction — query not tx-safe) ── */
  if (sellerAmount > 0) {
    try {
      const holdQuery = await db.collection('escrow-holds')
        .where('invoiceId', '==', invoiceId)
        .where('status', '==', 'held')
        .limit(1)
        .get();
      if (!holdQuery.empty) {
        await holdQuery.docs[0].ref.update({ status: 'released', releasedAt: FieldValue.serverTimestamp() });
      } else {
        // Issue 36-1 fix: the freelancer balance was already credited inside
        // the transaction above, so this is an audit-trail gap only — no fund
        // risk. Log a warning so it is visible for manual reconciliation.
        // Mirrors the identical fix applied to scheduled-clear-earnings.js
        // (Issue 35-4) where the same silent-catch pattern was corrected.
        console.warn(`[confirm-invoice-delivery] No held escrow-hold found for invoice ${invoiceId} — balance already released correctly; hold record may need manual reconciliation.`);
      }
    } catch (holdErr) {
      // Log but do not rethrow — the balance credit inside the transaction
      // is the financially critical operation and has already committed.
      console.error(`[confirm-invoice-delivery] Failed to update escrow-hold record for invoice ${invoiceId}:`, holdErr.message);
    }
  }

  /* ── Fetch seller details for notification ── */
  let freelancerName  = 'Freelancer';
  let freelancerEmail = null;
  try {
    const fSnap = await db.collection('users').doc(sellerUid).get();
    if (fSnap.exists) {
      freelancerName  = fSnap.data().name || fSnap.data().displayName || 'Freelancer';
      freelancerEmail = fSnap.data().email || null;
    }
  } catch (_) {}

  const platformUrl   = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const amountFormatted = new Intl.NumberFormat('en', { style: 'currency', currency }).format(sellerAmount);

  /* ── Notify freelancer: funds released ── */
  await callFunction('send-smart-notification', {
    userUid:    sellerUid,
    title:      'Invoice Payment Released',
    body:       `Your client confirmed delivery for invoice ${invoiceNumber}. ${amountFormatted} is now available.`,
    url:        `${platformUrl}/dashboard-invoices.html`,
    templateId: 'invoice-escrow-released',
    emailMode:  freelancerEmail ? 'always' : 'never',
    emailData: {
      name:          freelancerName,
      invoiceNumber,
      amount:        amountFormatted,
      dashboardUrl:  `${platformUrl}/dashboard-invoices.html`,
    },
  }, env);

  return respond(200, { success: true, message: 'Delivery confirmed. Funds have been released to the freelancer.' });
  }
};

function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

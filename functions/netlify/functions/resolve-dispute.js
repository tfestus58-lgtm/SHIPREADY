/**
 * Netlify Function: resolve-dispute.js
 * Path: netlify/functions/resolve-dispute.js
 *
 * Called by admin.html when an admin issues a ruling on a dispute
 * (Rule Freelancer Wins / Rule Buyer Wins / Custom Split).
 *
 * - Verifies the request via Firebase ID token + users/{uid}.role === 'admin'
 *   check (Issue 1 fix — replaces the shared ADMIN_SECRET pattern).
 * - Loads the disputed record. disputeId is the projects/{id} or
 *   invoices/{id} document ID (the same convention raise-dispute.js
 *   already uses when it writes disputedAt/disputedBy onto that doc
 *   and passes disputeId: projectId / disputeId: invoiceId to the
 *   dispute-raised email — there is no separate disputes/{id} doc to
 *   resolve, project/invoice docs hold dispute state directly).
 * - Splits the escrowed netAmount between freelancer/seller and buyer
 *   per freelancerPercent (0, 50, 100, or any custom split).
 * - Credits the freelancer's share to balances.{CURRENCY} (+ cryptoBalance
 *   or availableBalance for USD), matching the crediting pattern used by
 *   approve-delivery.js and confirm-invoice-delivery.js for normal escrow release.
 *   Credits the buyer's share to refundBalance / refundBalances.{CURRENCY} —
 *   a dedicated display-only ledger pool signalling a manual refund is due;
 *   actual refund disbursement requires admin action (Issue-12 fix).
 * - Sets status → resolved, escrowStatus → released, records the ruling.
 * - Notifies both parties (push + in-app + 'dispute-resolved' email).
 *
 * POST body:
 *   {
 *     disputeId:         string,            // projects/{id} or invoices/{id}
 *     type:               'project'|'invoice' (default 'project'),
 *     winner:             'freelancer'|'buyer'|'split',
 *     freelancerPercent:  number (0-100),
 *   }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET  — shared secret for the internal
 *                               send-smart-notification call

 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';
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

/* ── Internal function caller (function-to-function via HTTP) ── */
async function callFunction(functionName, payload, env) {
  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return;
  }

  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`${functionName} returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    // Non-fatal — the core Firestore update already succeeded
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* NOTE: the standalone creditUser() helper that used to live here was
   removed — its exact field-routing logic (crypto-sourced USD →
   cryptoBalance, fiat-sourced USD → availableBalance, per-currency
   earned/spent totals) now runs inline inside the runTransaction() block
   in the handler below, so the status update and both balance credits
   commit atomically instead of as separate non-transactional writes. */

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export default {
  async fetch(request, env, ctx) {

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const rawText = await request.text();

  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Issue 1 fix: ID token + role check (replaces shared ADMIN_SECRET) ── */
  let callerUid;
  try { callerUid = await verifyCaller(request, env); }
  catch { callerUid = null; }
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized.' });
  }

  let db;
  try { db = getDb(env); }
  catch (err) { return respond(500, { error: 'Server config error.' }); }

  let callerSnap;
  try { callerSnap = await db.collection('users').doc(callerUid).get(); }
  catch { return respond(500, { error: 'Database error.' }); }
  if (!callerSnap.exists || callerSnap.data().role !== 'admin') {
    return respond(403, { error: 'Forbidden.' });
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(rawText || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    disputeId,
    type,
    winner,
    freelancerPercent,
  } = payload;

  /* ── Validate ── */
  if (!disputeId || typeof disputeId !== 'string') {
    return respond(400, { error: 'disputeId is required.' });
  }
  if (!['freelancer', 'buyer', 'split'].includes(winner)) {
    return respond(400, { error: 'winner must be freelancer, buyer, or split.' });
  }
  const fPct = Number(freelancerPercent);
  if (!Number.isFinite(fPct) || fPct < 0 || fPct > 100) {
    return respond(400, { error: 'freelancerPercent must be a number between 0 and 100.' });
  }
  const recordType = type === 'invoice' ? 'invoice' : 'project';
  const collection  = recordType === 'invoice' ? 'invoices' : 'projects';

  /* ── Fetch the disputed record (read-only — for value extraction used in
     notifications below; the actual authoritative status check happens
     fresh inside the transaction further down) ── */
  let snap;
  try {
    snap = await db.collection(collection).doc(disputeId).get();
  } catch (err) {
    console.error(`Firestore read failed for ${collection}/${disputeId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!snap.exists) {
    return respond(404, { error: 'Disputed record not found.' });
  }

  const record = snap.data();

  /* ── Guard: must actually be disputed (fast pre-check; re-verified fresh
     inside the transaction below before any write happens) ── */
  if (record.status !== 'disputed') {
    return respond(409, { error: `This record is not currently disputed (status: "${record.status}").` });
  }

  const currency      = (record.currency || 'USD').toUpperCase();
  /* FIX: previously this read record.netAmount || record.amount, which
     works for projects (netAmount is the correct field there) but is
     wrong for invoices — invoices never have netAmount or amount, they
     have `total` (the gross amount the buyer paid, set at invoice
     creation) and `escrowSellerAmount` (total minus platformFee, set by
     the payment webhook once funds actually land in escrow — see
     stripe-webhook.js / flutterwave-webhook.js / nowpayments-webhook.js).
     Reading `total` here would have let an admin ruling "100% to
     freelancer" pay out the platform's own fee along with it, since
     `total` includes that fee and `escrowSellerAmount` already excludes
     it. raise-dispute.js only allows disputing invoices already in
     'escrow' or 'delivered' status, both set by the same webhook that
     sets escrowSellerAmount, so it's guaranteed present by the time a
     dispute exists. Project disputes are unaffected — netAmount is
     checked first and is unchanged for that path. */
  const grossAmount   = recordType === 'invoice'
    ? Number(record.escrowSellerAmount || record.total || 0)
    : Number(record.netAmount || record.amount || 0);
  const buyerUid       = record.buyerUid || null;
  const freelancerUid  = recordType === 'invoice'
    ? (record.sellerUid || record.uid || null)
    : (record.freelancerUid || null);
  const recordTitle   = record.projectTitle || record.title || record.invoiceNumber || disputeId;

  if (grossAmount <= 0) {
    return respond(400, { error: 'Disputed record has no escrowed amount to distribute.' });
  }

  const freelancerAmount = Math.round(grossAmount * (fPct / 100) * 100) / 100;
  const buyerAmount      = Math.round((grossAmount - freelancerAmount) * 100) / 100;

  /* ── Atomic: re-read status inside transaction, mark resolved, credit
     both parties ──
     A plain .get() + .update() pair (what was here before) has a race
     window: two near-simultaneous ruling requests for the same dispute
     (double-click, network retry, two admin tabs) could both pass the
     status === 'disputed' check above before either commits, and both
     would then credit both parties — a real double-payment risk.
     Wrapping the status re-check, the status update, and both balance
     credits in a single runTransaction() closes that window: only the
     first request to commit will ever see status === 'disputed' inside
     the transaction; any other concurrent request hits the guard and
     returns early with no balance change. This mirrors the identical
     fix already applied in approve-delivery.js and confirm-invoice-
     delivery.js for their own resolved-once-only writes. ── */
  const recordRef = db.collection(collection).doc(disputeId);

  let alreadyResolved = false;

  try {
    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(recordRef);

      if (!freshSnap.exists) {
        const err = new Error('Disputed record not found.');
        err.statusCode = 404;
        throw err;
      }

      const freshRecord = freshSnap.data();

      /* ── Idempotency: another request already resolved this dispute ── */
      if (freshRecord.status === 'resolved') {
        alreadyResolved = true;
        return;
      }

      /* ── Guard: must still be disputed inside the transaction ── */
      if (freshRecord.status !== 'disputed') {
        const err = new Error(`This record is not currently disputed (status: "${freshRecord.status}").`);
        err.statusCode = 409;
        throw err;
      }

      /* ── Mark resolved + escrow released inside the transaction ── */
      tx.update(recordRef, {
        status:               'resolved',
        escrowStatus:         'released',
        disputeRuling:        winner,
        disputeFreelancerPct: fPct,
        disputeResolvedAt:    FieldValue.serverTimestamp(),
        updatedAt:            FieldValue.serverTimestamp(),
      });

      /* ── Credit both parties inside the same transaction ──
         Mirrors creditUser()'s field-routing logic exactly (crypto-sourced
         USD → cryptoBalance, fiat-sourced USD → availableBalance), but
         applied via tx.update() so both credits commit atomically with
         the status change above. ── */
      const isCrypto = freshRecord.paymentMethod === 'crypto';

      if (freelancerUid && freelancerAmount > 0) {
        const freelancerUpdate = {
          [`balances.${currency}`]:              FieldValue.increment(freelancerAmount),
          // Issue 4 fix: totalEarned (legacy blended field) was missing here.
          // Every other crediting path (approve-delivery.js, deliver-product.js,
          // confirm-invoice-delivery.js, scheduled-clear-earnings.js section 4)
          // increments both totalEarned and totalEarnedByCurrency.${currency}.
          // Omitting it caused the freelancer's lifetime earnings to be
          // understated in any admin/display context that reads totalEarned.
          totalEarned:                           FieldValue.increment(freelancerAmount),
          [`totalEarnedByCurrency.${currency}`]: FieldValue.increment(freelancerAmount),
          updatedAt:                              FieldValue.serverTimestamp(),
        };
        if (currency === 'USD') {
          if (isCrypto) {
            freelancerUpdate.cryptoBalance = FieldValue.increment(freelancerAmount);
          } else {
            freelancerUpdate.availableBalance = FieldValue.increment(freelancerAmount);
          }
        }
        tx.update(db.collection('users').doc(freelancerUid), freelancerUpdate);
      }

      if (buyerUid && buyerAmount > 0) {
        /* Issue-12 fix: buyer refunds go into a dedicated refundBalance pool,
           NOT into balances.{currency} / availableBalance / cryptoBalance.
           Those fields belong to the freelancer withdrawal system; buyers have
           no KYC path and no payout function to drain them. refundBalance is a
           display-only ledger field that the admin panel reads to show pending
           refund credit; the actual money movement (Stripe/FLW refund or manual
           transfer) is handled by admin action outside this function.
           refundBalances.{currency} stores the per-currency breakdown for
           multi-currency display in buyer-dashboard and admin panel. */
        const buyerUpdate = {
          refundBalance:                          FieldValue.increment(buyerAmount),
          [`refundBalances.${currency}`]:         FieldValue.increment(buyerAmount),
          updatedAt:                              FieldValue.serverTimestamp(),
        };
        tx.update(db.collection('users').doc(buyerUid), buyerUpdate);
      }
    });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 404) return respond(404, { error: err.message });
    if (code === 409) return respond(409, { error: err.message });
    console.error(`Transaction failed for dispute ${disputeId}:`, err.message);
    return respond(500, { error: 'Failed to resolve dispute.' });
  }

  /* ── Idempotency short-circuit ── */
  if (alreadyResolved) {
    return respond(409, { error: 'This dispute has already been resolved.' });
  }

  console.log(`Dispute resolved on ${collection}/${disputeId}: winner=${winner}, freelancerPercent=${fPct}.`);
  console.log(`Distributed ${currency} ${freelancerAmount} to freelancer/seller, ${currency} ${buyerAmount} to buyer.`);

  /* ── Sync the disputes/{disputeId} record admin.html's table reads from
     (see raise-dispute.js — this is the doc that populates loadDisputes()).
     Without this, the table would still show "Open" on the next reload
     even though the underlying project/invoice was correctly resolved
     above, since admin.html's optimistic local-state update only lasts
     for the current session. Non-fatal: the ruling itself, recorded
     above, is what actually matters — this just keeps the listing
     accurate. ── */
  try {
    await db.collection('disputes').doc(disputeId).update({
      status:    'resolved',
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn(`Could not sync disputes/${disputeId} status (non-fatal — ruling already recorded):`, err.message);
  }

  /* ── Distribute escrow ──
     Now handled atomically inside the runTransaction() above, alongside
     the status update — see that block for the crediting logic. Kept as
     a comment marker here so the original step numbering in the file
     header still maps to where each thing actually happens. ── */

  /* ── Fetch user details for notifications ── */
  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerEmail      = null;
  let buyerName       = 'Client';

  try {
    const fetches = [];
    if (buyerUid) fetches.push(db.collection('users').doc(buyerUid).get());
    if (freelancerUid) fetches.push(db.collection('users').doc(freelancerUid).get());
    const snaps = await Promise.all(fetches);
    snaps.forEach((s) => {
      if (!s.exists) return;
      const d = s.data();
      if (s.id === buyerUid) {
        buyerEmail = d.email || null;
        buyerName  = d.name || 'Client';
      } else if (s.id === freelancerUid) {
        freelancerEmail = d.email || null;
        freelancerName  = d.name || 'Freelancer';
      }
    });
  } catch (err) {
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const amountFmt = (amt) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(amt);

  const rulingText = winner === 'split'
    ? `${amountFmt(freelancerAmount)} to ${freelancerName}, ${amountFmt(buyerAmount)} to ${buyerName}.`
    : '';

  /* ── Notify buyer ── */
  if (buyerUid) {
    const buyerBody = buyerAmount > 0
      ? `A ruling has been issued on "${recordTitle}". A refund credit of ${amountFmt(buyerAmount)} has been recorded and will be processed by our team.`
      : `A ruling has been issued on "${recordTitle}".`;
    await callFunction('send-smart-notification', {
      userUid:    buyerUid,
      title:      'Dispute Resolved',
      body:       buyerBody,
      url:        recordType === 'invoice'
        ? `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(disputeId)}`
        : `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(disputeId)}`,
      templateId: 'dispute-resolved',
      emailMode:  buyerEmail ? 'always' : 'never',
      emailData: {
        name:         buyerName,
        projectTitle: recordTitle,
        ruling:       winner,
        rulingText,
        disputeId,
      },
    }, env);
  }

  /* ── Notify freelancer ── */
  if (freelancerUid) {
    await callFunction('send-smart-notification', {
      userUid:    freelancerUid,
      title:      'Dispute Resolved',
      body:       `A ruling has been issued on "${recordTitle}".`,
      url:        recordType === 'invoice'
        ? `${platformUrl}/dashboard-invoices.html`
        : `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(disputeId)}`,
      templateId: 'dispute-resolved',
      emailMode:  freelancerEmail ? 'always' : 'never',
      emailData: {
        name:         freelancerName,
        projectTitle: recordTitle,
        ruling:       winner,
        rulingText,
        disputeId,
      },
    }, env);
  }

  return respond(200, {
    success: true,
    message: `Ruling issued. ${amountFmt(freelancerAmount)} to freelancer, ${amountFmt(buyerAmount)} to buyer.`,
  });
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

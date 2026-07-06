/**
 * Netlify Function: nowpayments-webhook.js
 * Path: netlify/functions/nowpayments-webhook.js
 *
 * Receives IPN (Instant Payment Notification) POST requests from NOWPayments
 * whenever a payment status changes. Verifies the HMAC-SHA512 signature,
 * then — on a confirmed or finished payment — updates the Firestore project
 * document and emails the freelancer.
 *
 * Environment variables required:
 *   NOWPAYMENTS_IPN_SECRET      — IPN secret from your NOWPayments dashboard
 *   FIREBASE_SERVICE_ACCOUNT    — full Firebase service account JSON as a
 *                                 single-line string (for server-side Firestore)
 *   PLATFORM_URL                — your live domain, e.g. https://kreddlo.space
 *
 * NOWPayments sends these statuses (in rough order):
 *   waiting → confirming → confirmed → finished
 *   partially_paid → failed → refunded → expired
 *
 * We act on "confirmed" and "finished" only — both mean the funds are secured.
 */

// Cloudflare Workers exposes the Web Crypto API as a global `crypto` object.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';
import { getSettings } from './get-settings';

/* ── Initialise Firebase Admin SDK once (survives warm Lambda invocations) ── */
function getDb(env) {
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse((env && env.FIREBASE_SERVICE_ACCOUNT) || '{}');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not valid JSON.');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

/* ── Statuses that mean "money is in hand" ── */
const FUNDED_STATUSES = new Set(['confirmed', 'finished']);

/* ── Statuses worth logging but requiring no Firestore write ── */
const PENDING_STATUSES = new Set(['waiting', 'confirming', 'partially_paid']);

/* ── Terminal failure statuses ── */
const FAILED_STATUSES = new Set(['failed', 'refunded', 'expired']);


export default {
async fetch(request, env, ctx) {

  /* ── 1. Accept POST only ── */
  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Raw body ──────────────────────────────────────────────────────────────
     Cloudflare Workers' request.text() always returns the raw body as a
     UTF-8 string directly — no base64 decoding guard needed here, unlike
     the old Netlify event.body/isBase64Encoded handling.
  ─────────────────────────────────────────────────────────────────────────── */
  const rawBody = await request.text();

  /* ── 2. Verify IPN signature ── */
  const ipnSecret = env.NOWPAYMENTS_IPN_SECRET;
  if (!ipnSecret) {
    console.error('NOWPAYMENTS_IPN_SECRET environment variable is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const receivedSig = (request.headers.get('x-nowpayments-sig') || '').toLowerCase();
  if (!receivedSig) {
    console.warn('Webhook received with no x-nowpayments-sig header — rejected.');
    return respond(401, { error: 'Missing signature.' });
  }

  const isValid = await verifySignature(rawBody, ipnSecret, receivedSig);
  if (!isValid) {
    console.warn('Webhook signature mismatch — possible spoofed request. Rejected.');
    return respond(401, { error: 'Invalid signature.' });
  }

  /* ── 3. Parse the verified payload ── */
  let payment;
  try {
    payment = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    payment_id,
    payment_status,
    order_id,          // this is the Firestore project document ID we passed at invoice creation
    pay_amount,        // amount sent by buyer in crypto
    pay_currency,      // crypto coin used
    actually_paid,     // actual amount received (may differ slightly from pay_amount)
    outcome_amount,    // USD value received after conversion
    outcome_currency,
    fee,               // object: { currency, depositFee, withdrawalFee, serviceFee }
    updated_at,
  } = payment;

  console.log(`IPN received — paymentId: ${payment_id}, status: ${payment_status}, orderId: ${order_id}`);

  /* ── 4. Route by status ── */

  if (PENDING_STATUSES.has(payment_status)) {
    // Confirming on-chain — nothing to write yet, just acknowledge
    console.log(`Payment ${payment_id} is pending (${payment_status}). No action taken.`);
    return respond(200, { received: true });
  }

  if (FAILED_STATUSES.has(payment_status)) {
    // Optionally mark the project payment as failed so the buyer can retry
    await handleFailedPayment(env, { order_id, payment_id, payment_status });
    return respond(200, { received: true });
  }

  if (FUNDED_STATUSES.has(payment_status)) {
    await handleFundedPayment(env, {
      order_id,
      payment_id,
      payment_status,
      pay_amount,
      pay_currency,
      actually_paid,
      outcome_amount,
      outcome_currency,
      fee,
      updated_at,
    });
    return respond(200, { received: true });
  }

  // Unknown status — acknowledge so NOWPayments stops retrying, log for review
  console.warn(`Unhandled payment status "${payment_status}" for order ${order_id}.`);
  return respond(200, { received: true });
}
};


/* ══════════════════════════════════════════════════════════════
   SIGNATURE VERIFICATION
   NOWPayments signs webhooks with HMAC-SHA512 of the request body
   after sorting the body's top-level keys alphabetically.
   Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt#callbacks
══════════════════════════════════════════════════════════════ */
async function verifySignature(rawBody, secret, receivedSig) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }

  // Sort keys alphabetically and re-serialise (NOWPayments requirement)
  const sorted = sortObjectKeys(parsed);
  const sortedJson = JSON.stringify(sorted);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', keyMaterial, new TextEncoder().encode(sortedJson));
  const expectedSig = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();

  // Timing-safe comparison prevents timing attacks
  try {
    return (
      typeof receivedSig === 'string' &&
      expectedSig.length === receivedSig.length &&
      timingSafeEqualStr(expectedSig, receivedSig)
    );
  } catch {
    // Different length — definitely not equal
    return false;
  }
}

// Web Crypto has no direct Node crypto.timingSafeEqual equivalent, so we use a
// constant-time XOR comparison over character codes instead of Buffer.
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Recursively sorts object keys alphabetically.
 * NOWPayments sorts the entire nested payload before signing.
 */
function sortObjectKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectKeys(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}


/* ══════════════════════════════════════════════════════════════
   HANDLE FUNDED PAYMENT
   - Updates the project document in Firestore
   - Emails the freelancer
══════════════════════════════════════════════════════════════ */
async function handleFundedPayment(env, data) {
  const {
    order_id, payment_id, payment_status,
    pay_amount, pay_currency,
    actually_paid, outcome_amount, outcome_currency,
    fee, updated_at,
  } = data;

  if (!order_id) {
    console.error('Funded payment arrived with no order_id — cannot update Firestore.');
    return;
  }

  let db;
  try {
    db = getDb(env);
  } catch (err) {
    console.error('Failed to initialise Firebase Admin:', err.message);
    return;
  }

  /* ── Route: Pro upgrade (order_id starts with "sub_") ── */
  if (order_id.startsWith('sub_')) {
    const subSnap = await db.collection('subscriptions').doc(order_id).get().catch(() => null);
    if (subSnap && subSnap.exists) {
      const sub = subSnap.data();
      await handleProUpgrade({ db, env, uid: sub.uid, billingPeriod: sub.billingPeriod, subscriptionId: order_id, gateway: 'crypto', amount: Number(outcome_amount || pay_amount || 0) });
    } else {
      console.error(`[pro_upgrade] Subscription doc "${order_id}" not found.`);
    }
    return;
  }

  const projectRef = db.collection('projects').doc(order_id);

  /* ── Try projects collection first ── */
  let projectSnap;
  try {
    projectSnap = await projectRef.get();
  } catch (err) {
    console.error(`Firestore read failed for project ${order_id}:`, err.message);
    return;
  }

  /* ── If not a project, try product-orders ── */
  if (!projectSnap.exists) {
    const orderRef  = db.collection('product-orders').doc(order_id);
    let   orderSnap;
    try {
      orderSnap = await orderRef.get();
    } catch (err) {
      console.error(`Firestore read failed for product-order ${order_id}:`, err.message);
      return;
    }

    if (!orderSnap.exists) {
      // ── Try invoice-orders ──
      const invOrderRef  = db.collection('invoice-orders').doc(order_id);
      let   invOrderSnap;
      try {
        invOrderSnap = await invOrderRef.get();
      } catch (err) {
        console.error(`Firestore read failed for invoice-order ${order_id}:`, err.message);
        return;
      }

      if (!invOrderSnap.exists) {
        console.error(`Order "${order_id}" not found in projects, product-orders, or invoice-orders.`);
        return;
      }

      // ── Issue 2 fix: read invOrder data for fee calc before the transaction ──
      // Settings are fetched outside the transaction (no HTTP calls inside tx).
      const invOrder = invOrderSnap.data();

      // Fix 11: outcome_amount/outcome_currency must be present. If absent,
      // flag for manual review rather than crediting a wrong amount.
      let invConfirmedAmount, invConfirmedCurrency;
      if (outcome_amount && outcome_currency) {
        invConfirmedAmount   = Number(outcome_amount);
        invConfirmedCurrency = outcome_currency.toUpperCase();
      } else {
        console.error(
          `[nowpayments-webhook] Missing outcome_amount/outcome_currency on ${payment_status} ` +
          `payment ${payment_id} for invoice-order ${order_id}. ` +
          `pay_amount=${pay_amount} pay_currency=${pay_currency} actually_paid=${actually_paid}. ` +
          `Skipping — needs manual review.`
        );
        // Plain update here is fine — needs-review is a terminal state that
        // does not credit any balance, so duplicate writes are harmless.
        await invOrderRef.update({
          paymentStatus:  'needs-review',
          paymentMethod:  'crypto',
          nowpaymentsId:  payment_id || null,
          reviewReason:   'missing-outcome-amount',
          updatedAt:      FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }

      let invSettings;
      try {
        invSettings = await getSettings(db);
      } catch (err) {
        invSettings = { platformFeePercent: 2.5 };
      }

      /*
       * Fix D-2 (crypto) — originalAmount (saved by create-invoice-order.js at
       * order creation) is the invoice total the seller issued — already fee-free.
       * The platform fee was collected up front. sellerAmount equals originalAmount
       * directly. platformFee here is a display figure only, reconstructed by
       * inverting the markup formula. Falls back to invConfirmedAmount for orders
       * predating the originalAmount field — unchanged legacy behavior.
       */
      const invFeePercent = invSettings.platformFeePercent;
      let invPlatformFee, invSellerAmount;
      if (typeof invOrder.originalAmount === 'number' && invOrder.originalAmount > 0) {
        invSellerAmount = invOrder.originalAmount;
        const invReconstructedCharge = +(invSellerAmount / (1 - invFeePercent / 100)).toFixed(2);
        invPlatformFee  = +(invReconstructedCharge - invSellerAmount).toFixed(2);
      } else {
        // Bug 1 fix — Legacy fallback: no originalAmount field on this order.
        // If the currency NOWPayments confirmed (invConfirmedCurrency) does not
        // match the currency the invoice was issued in (invOrder.originalCurrency
        // / invOrder.currency), we cannot safely compute invSellerAmount —
        // using invConfirmedCurrency would credit the seller in the wrong pool
        // (e.g. USDT or BTC instead of USD for a USD invoice).
        // Flag the order as needs-review for manual resolution instead of
        // silently crediting the wrong amount in the wrong currency pool.
        //
        // This only affects invoice-orders that pre-date the originalAmount
        // field AND were paid with a crypto currency that doesn't match the
        // invoice's issued currency. All new orders have originalAmount and
        // take the `if` branch above — this guard is for legacy records only.
        // Mirrors the identical fix already applied in flutterwave-webhook.js
        // and stripe-webhook.js (Issue 6).
        const invOrderIssuedCurrency = (
          invOrder.originalCurrency ||
          invOrder.currency         ||
          ''
        ).toUpperCase();

        if (invOrderIssuedCurrency && invOrderIssuedCurrency !== invConfirmedCurrency) {
          // Currency mismatch on a legacy order — cannot safely compute
          // invSellerAmount. Flag for manual review rather than crediting
          // the seller in the wrong currency pool.
          console.error(
            `[nowpayments-webhook] Legacy invoice-order ${order_id}: ` +
            `invConfirmedCurrency (${invConfirmedCurrency}) !== order.currency ` +
            `(${invOrderIssuedCurrency}). Flagging needs-review to prevent wrong-currency credit.`
          );
          await invOrderRef.update({
            paymentStatus: 'needs-review',
            reviewReason:  'legacy-currency-mismatch',
            reviewDetail:  `confirmedCurrency=${invConfirmedCurrency}, orderCurrency=${invOrderIssuedCurrency}`,
            updatedAt:     FieldValue.serverTimestamp(),
          }).catch(() => {});
          return;
        }

        // Currencies match (or order has no stored currency — safe to proceed).
        // invConfirmedAmount is guaranteed non-null here — the null-guard above
        // already returned/flagged needs-review if outcome_amount was absent.
        invPlatformFee  = +(invConfirmedAmount * (invFeePercent / 100)).toFixed(2);
        invSellerAmount = +(invConfirmedAmount - invPlatformFee).toFixed(2);
      }

      // ── Issue 2 fix: wrap the status update in a transaction with a fresh
      // re-read of paymentStatus, identical to the product-order path above.
      // NOWPayments sends both "confirmed" and "finished" for the same payment,
      // so two concurrent webhooks can both pass the pre-flight snapshot check
      // and both try to credit escrow. The transaction ensures only one wins.
      let invAlreadyPaid = false;
      try {
        await db.runTransaction(async (tx) => {
          const freshInvOrderSnap = await tx.get(invOrderRef);
          if (!freshInvOrderSnap.exists) {
            throw new Error(`Invoice order ${order_id} not found inside transaction.`);
          }
          if (freshInvOrderSnap.data().paymentStatus === 'paid') {
            invAlreadyPaid = true;
            return;
          }

          tx.update(invOrderRef, {
            paymentStatus:      'paid',
            paymentMethod:      'crypto',
            nowpaymentsId:      payment_id    || null,
            payCurrency:        pay_currency  || null,
            payAmount:          pay_amount    || null,
            actuallyPaid:       actually_paid || null,
            amount:             invConfirmedAmount,
            currency:           invConfirmedCurrency,
            amountUsd:          invConfirmedCurrency === 'USD' ? invConfirmedAmount : null,
            platformFee:        invPlatformFee,
            sellerAmount:       invSellerAmount,
            paymentConfirmedAt: FieldValue.serverTimestamp(),
            updatedAt:          FieldValue.serverTimestamp(),
          });
        });
      } catch (err) {
        console.error(`Transaction failed for invoice-order ${order_id}:`, err.message);
        return;
      }

      if (invAlreadyPaid) {
        console.log(`Invoice order ${order_id} already paid. Skipping duplicate webhook.`);
        return;
      }

      console.log(`Invoice order ${order_id} marked as paid via crypto.`);

      const invoiceId = invOrder.invoiceId || null;
      const sellerUid = invOrder.sellerUid || null;
      const clientEmail = (invOrder.clientEmail || '').trim().toLowerCase();
      const clientName  = invOrder.clientName || invOrder.payerName || 'A client';

      /* ── Place funds in escrow (not paid directly to seller) ── */
      if (invoiceId) {
        try {
          // deliverBy window is admin-configurable (invoiceDeliverByHours), defaulting to 48h
          const deliverByHours = Number(invSettings.invoiceDeliverByHours) || 48;
          const deliverBy = new Date(Date.now() + deliverByHours * 60 * 60 * 1000);
          await db.collection('invoices').doc(invoiceId).update({
            status:              'escrow',
            escrowHeldAt:        FieldValue.serverTimestamp(),
            escrowSellerAmount:  invSellerAmount,
            paidAt:              FieldValue.serverTimestamp(),
            paidOrder:           order_id,
            deliverBy:           deliverBy,
            // FIX — crypto/fiat balance separation. Without this, confirm-
            // invoice-delivery.js / scheduled-clear-earnings.js cannot tell
            // this invoice was paid via crypto and would credit it into the
            // fiat availableBalance pool instead of cryptoBalance, letting
            // crypto-origin money leave through the bank withdrawal rail.
            paymentMethod:       'crypto',
            updatedAt:           FieldValue.serverTimestamp(),
          });
          console.log(`Invoice ${invoiceId} placed in escrow.`);
        } catch (err) {
          console.error(`Could not place invoice ${invoiceId} in escrow:`, err.message);
        }
      }

      if (sellerUid) {
        /* ── Write escrow-holds record ── */
        try {
          await db.collection('escrow-holds').add({
            invoiceId,
            orderId:     order_id,
            sellerId:    sellerUid,
            buyerEmail:  clientEmail,
            amount:      invSellerAmount,
            currency:    invConfirmedCurrency,
            status:      'held',
            createdAt:   FieldValue.serverTimestamp(),
          });
        } catch (err) {
          console.error(`Could not write escrow-holds for invoice ${invoiceId}:`, err.message);
        }
      }

      /* ── Fetch user details for notifications ── */
      let freelancerEmail = null;
      let freelancerName  = 'Freelancer';
      let invoiceNumber   = '';
      if (sellerUid) {
        try {
          const userSnap = await db.collection('users').doc(sellerUid).get();
          if (userSnap.exists) {
            freelancerEmail = userSnap.data().email || null;
            freelancerName  = userSnap.data().name || userSnap.data().displayName || 'Freelancer';
          }
        } catch (_) {}
      }
      if (invoiceId) {
        try {
          const invSnap = await db.collection('invoices').doc(invoiceId).get();
          if (invSnap.exists) invoiceNumber = invSnap.data().invoiceNumber || '';
        } catch (_) {}
      }

      const platformUrl   = ((env && env.PLATFORM_URL) || 'https://kreddlo.space').replace(/\/$/, '');
      const invoiceAmount = new Intl.NumberFormat('en', { style: 'currency', currency: invConfirmedCurrency }).format(invConfirmedAmount);

      /* ── Notify seller: payment in escrow ── */
      if (sellerUid) {
        await callFunction(env, 'send-smart-notification', {
          userUid:    sellerUid,
          to:         freelancerEmail || null,
          title:      'Payment Held in Escrow',
          body:       `Payment received for invoice ${invoiceNumber || invoiceId}. Deliver your work and mark complete to release funds.`,
          url:        `${platformUrl}/dashboard-invoices.html`,
          templateId: 'invoice-escrow-held-seller',
          emailMode:  'always',
          emailData: {
            name:          freelancerName,
            invoiceNumber: invoiceNumber || invoiceId,
            amount:        invoiceAmount,
            dashboardUrl:  `${platformUrl}/dashboard-invoices.html`,
          },
        });
      }

      /* ── Email buyer: payment secured in escrow ── */
      if (clientEmail) {
        await callFunction(env, 'send-email', {
          to:     clientEmail,
          toName: clientName,
          type:   'invoice-escrow-held-buyer',
          data: {
            name:           clientName,
            freelancerName,
            invoiceNumber:  invoiceNumber || invoiceId,
            amount:         invoiceAmount,
          },
        });
      }

      console.log(`NOWPayments invoice order ${order_id} handled successfully — funds in escrow.`);
      return;
    }

    // Fix 11: Don't silently mix a crypto quantity with a fiat label.
    // outcome_amount/outcome_currency are the fiat equivalent after conversion
    // and must be present on a confirmed/finished webhook. If absent, flag the
    // order for manual review rather than crediting a wrong amount.
    let confirmedAmount, confirmedCurrency;
    if (outcome_amount && outcome_currency) {
      confirmedAmount   = Number(outcome_amount);
      confirmedCurrency = outcome_currency.toUpperCase();
    } else {
      console.error(
        `[nowpayments-webhook] Missing outcome_amount/outcome_currency on ${payment_status} ` +
        `payment ${payment_id} for product-order ${order_id}. ` +
        `pay_amount=${pay_amount} pay_currency=${pay_currency} actually_paid=${actually_paid}. ` +
        `Skipping — needs manual review.`
      );
      await orderRef.update({
        paymentStatus:     'needs-review',
        paymentMethod:     'crypto',
        nowpaymentsId:     payment_id || null,
        reviewReason:      'missing-outcome-amount',
        updatedAt:         FieldValue.serverTimestamp(),
      }).catch(() => {});
      return;
    }

    // Fetch platform settings to calculate fees (outside transaction — no HTTP calls inside tx)
    let productOrderSettings;
    try {
      productOrderSettings = await getSettings(db);
    } catch (err) {
      console.warn('[nowpayments-webhook] Could not fetch settings for product order, using defaults:', err.message);
      productOrderSettings = { platformFeePercent: 2.5 };
    }

    // Fix D-2 — originalAmount (saved by create-product-order.js at order
    // creation) is the seller's listed price and is ALREADY fee-free —
    // the platform fee was collected up front via the buyer's grossed-up
    // charge (see create-product-order.js's "Add platform fee on top of
    // product price" block). sellerAmount must equal originalAmount
    // directly. platformFee here is a record/display figure only,
    // reconstructed in the same currency as originalAmount by inverting
    // the exact markup formula used at order creation, avoiding any
    // mismatch with confirmedAmount/outcome_amount (the actual crypto
    // received, which can drift slightly from the requested amount).
    // Falls back to confirmedAmount only for orders predating the
    // originalAmount field — unchanged legacy behavior for those
    // already-historical, already-paid orders.
    const productOrderData    = orderSnap.data();
    const productFeePercent   = productOrderSettings.platformFeePercent;

    let productSellerAmount, productPlatformFee;
    if (typeof productOrderData.originalAmount === 'number' && productOrderData.originalAmount > 0) {
      productSellerAmount = productOrderData.originalAmount;
      const reconstructedChargeAmount = +(productSellerAmount / (1 - productFeePercent / 100)).toFixed(2);
      productPlatformFee  = +(reconstructedChargeAmount - productSellerAmount).toFixed(2);
    } else {
      // Bug B fix — Legacy fallback: no originalAmount field on this order.
      // If the currency NOWPayments confirmed (confirmedCurrency) does not
      // match the currency the product-order was issued in, we cannot safely
      // compute productSellerAmount — using confirmedCurrency would credit the
      // seller in the wrong currency pool (e.g. BTC instead of USD).
      // Flag the order as needs-review for manual resolution instead of
      // silently crediting the wrong amount in the wrong currency pool.
      // Mirrors the identical fix already applied to the invoice-order path above.
      const orderIssuedCurrency = (
        productOrderData.originalCurrency ||
        productOrderData.currency         ||
        ''
      ).toUpperCase();

      if (orderIssuedCurrency && orderIssuedCurrency !== confirmedCurrency) {
        console.error(
          `[nowpayments-webhook] Legacy product-order ${order_id}: ` +
          `confirmedCurrency (${confirmedCurrency}) !== order.currency ` +
          `(${orderIssuedCurrency}). Flagging needs-review to prevent wrong-currency credit.`
        );
        await orderRef.update({
          paymentStatus: 'needs-review',
          reviewReason:  'legacy-currency-mismatch',
          reviewDetail:  `confirmedCurrency=${confirmedCurrency}, orderCurrency=${orderIssuedCurrency}`,
          updatedAt:     FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }

      const productBaseAmount = Number(confirmedAmount || 0);
      productPlatformFee  = +(productBaseAmount * (productFeePercent / 100)).toFixed(2);
      productSellerAmount = +(productBaseAmount - productPlatformFee).toFixed(2);
    }

    // Atomic idempotency: read-check-write inside a transaction so concurrent
    // duplicate webhooks cannot both see paymentStatus !== 'paid' and both write.
    let productAlreadyPaid = false;
    let productOrderDataForDownstream = null;

    try {
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(orderRef);
        if (!freshSnap.exists) throw new Error(`Product order ${order_id} not found inside transaction.`);
        const freshData = freshSnap.data();

        if (freshData.paymentStatus === 'paid') {
          productAlreadyPaid = true;
          return;
        }

        tx.update(orderRef, {
          paymentStatus:      'paid',
          paymentMethod:      'crypto',
          nowpaymentsId:      payment_id  || null,
          payCurrency:        pay_currency || null,
          payAmount:          pay_amount   || null,
          actuallyPaid:       actually_paid || null,
          amount:             confirmedAmount,
          currency:           confirmedCurrency,
          amountUsd:          confirmedCurrency === 'USD' ? confirmedAmount : null,
          platformFee:        productPlatformFee,
          sellerAmount:       productSellerAmount,
          paymentConfirmedAt: FieldValue.serverTimestamp(),
          updatedAt:          FieldValue.serverTimestamp(),
        });

        productOrderDataForDownstream = { ...freshData, sellerAmount: productSellerAmount };
      });
    } catch (err) {
      console.error(`Transaction failed for product-order ${order_id}:`, err.message);
      return; // handleFundedPayment is not expected to throw — caller returns 200
    }

    if (productAlreadyPaid) {
      console.log(`Product order ${order_id} already paid. Skipping duplicate webhook.`);
      return;
    }

    console.log(`Product order ${order_id} marked as paid. Amount: ${confirmedAmount} ${confirmedCurrency}, sellerAmount: ${productSellerAmount}`);

    // Use the order data captured inside the transaction for downstream calls
    const order = productOrderDataForDownstream;

    // Credit affiliate commission if this order was referred
    const { finalSellerAmount } = await creditAffiliateCommission({
      db,
      env,
      order,
      orderId:           order_id,
      sellerAmount:      productSellerAmount,
      confirmedAmount,
      confirmedCurrency,
      amountUsd:         confirmedCurrency === 'USD' ? confirmedAmount : null,
      gateway:           'crypto',
    });

    // Trigger delivery with the final seller amount (after any affiliate deduction).
    // Uses the retrying caller — this single call credits the seller's balance,
    // increments salesCount, and sends their sale notification.
    const deliveryDispatch = await callFunctionWithRetry(env, 'deliver-product', { orderId: order_id, sellerAmount: finalSellerAmount });
    if (!deliveryDispatch.success) {
      try {
        await orderRef.update({
          deliveryDispatchFailed: true,
          deliveryDispatchError:  deliveryDispatch.reason || 'unknown error',
          deliveryDispatchFailedAt: FieldValue.serverTimestamp(),
        });
      } catch (markErr) {
        console.error(`Could not flag delivery dispatch failure for order ${order_id}:`, markErr.message);
      }
    }

    // Fire Facebook pixel if product has a pixelId configured
    try {
      const productSnap = await db.collection('products').doc(order.productId).get();
      const fbPixelId = productSnap.exists && productSnap.data().integrations && productSnap.data().integrations.facebookPixelId;
      if (fbPixelId) {
        await callFunction(env, 'pixel-event', {
          pixelId:   fbPixelId,
          eventName: 'Purchase',
          value:     confirmedAmount,
          currency:  confirmedCurrency,
          email:     order.buyerEmail || '',
          orderId:   order_id,
        });
      }
    } catch (err) {
      console.warn(`Could not fire pixel for product-order ${order_id}:`, err.message);
    }

    return; // done with product order path
  }

  /* Fetch platform fee settings outside the transaction — no HTTP calls inside tx */
  let settings;
  try {
    settings = await getSettings(db);
  } catch (err) {
    console.warn('[nowpayments-webhook] Could not fetch settings, using defaults:', err.message);
    settings = { platformFeePercent: 2.5, projectProtectionPercent: 1.0 };
  }

  /*
   * Fix D-3 (crypto projects) — use the pre-buffer USD budget as the fee base,
   * not outcome_amount. outcome_amount is the USD-equivalent of what the buyer
   * actually sent in crypto, which can differ from the listed project price due
   * to crypto volatility and NowPayments conversion. More importantly, for any
   * project paid via crypto after a currency conversion, using outcome_amount as
   * the base would calculate fees and netAmount in the wrong currency or against
   * a shifted amount.
   *
   * The correct base is the original USD project budget (set at project creation
   * by create-project.js). approve-delivery.js reads project.netAmount and
   * project.currency to credit the freelancer's balance — those must be in USD
   * at the listed price, not the crypto outcome amount. Falls back to
   * outcome_amount for any project where budget is absent — unchanged legacy
   * behavior for those older records.
   */
  const cryptoProjectData  = projectSnap.data();
  const useProjectBudget   = typeof cryptoProjectData.budget === 'number' && cryptoProjectData.budget > 0;
  const baseAmount         = useProjectBudget ? cryptoProjectData.budget : Number(outcome_amount || pay_amount || 0);
  const baseCurrency       = useProjectBudget ? (cryptoProjectData.currency || 'USD').toUpperCase() : (outcome_currency || 'USD').toUpperCase();
  const platformFeeAmt    = +(baseAmount * (settings.platformFeePercent / 100)).toFixed(2);
  // Project Protection is an optional buyer add-on (see pricing.html) — only
  // deduct it if the buyer actually opted in when the project was created.
  const protectionOptedIn = cryptoProjectData.withProtection === true;
  const protectionFeeAmt  = protectionOptedIn
    ? +(baseAmount * (settings.projectProtectionPercent / 100)).toFixed(2)
    : 0;
  const netAmount         = +(baseAmount - platformFeeAmt - protectionFeeAmt).toFixed(2);

  // Atomic idempotency: read-check-write inside a transaction so concurrent
  // duplicate webhooks cannot both see escrowStatus !== 'funded' and both write.
  let projectAlreadyFunded = false;
  let projectDataForDownstream = null;

  try {
    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(projectRef);
      if (!freshSnap.exists) throw new Error(`Project ${order_id} not found inside transaction.`);
      const freshData = freshSnap.data();

      if (freshData.escrowStatus === 'funded') {
        projectAlreadyFunded = true;
        return;
      }

      tx.update(projectRef, {
        escrowStatus:    'funded',
        status:          'in_progress',
        paymentMethod:   'crypto',
        paymentId:       payment_id,
        paymentStatus:   payment_status,
        // currency/netAmount are in the project's original pricing currency (USD
        // when budget was used as base). approve-delivery.js reads these to credit
        // the freelancer, so they must match the currency the project was priced in.
        currency:        baseCurrency,
        platformFee:     platformFeeAmt,
        protectionFee:   protectionFeeAmt,
        netAmount:       netAmount,
        // Crypto payment details — raw amounts exactly as NowPayments reported.
        // These are for auditing/admin display and are NOT used for balance crediting.
        payCurrency:     pay_currency      || null,
        payAmount:       pay_amount        || null,
        actuallyPaid:    actually_paid     || null,
        outcomeAmount:   outcome_amount    || null,
        outcomeCurrency: outcome_currency  || null,
        paymentFee:      fee               || null,
        paymentConfirmedAt: updated_at
          ? new Date(updated_at)
          : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      projectDataForDownstream = freshData;
    });
  } catch (err) {
    console.error(`Transaction failed for project ${order_id}:`, err.message);
    return;
  }

  if (projectAlreadyFunded) {
    console.log(`Project ${order_id} already marked as funded. Skipping duplicate webhook.`);
    return;
  }

  console.log(`Project ${order_id} updated — escrowStatus: funded, status: in_progress.`);

  const project = projectDataForDownstream;

  /*
   * FIX — totalSpent gap. No backend function previously wrote a buyer's
   * lifetime-spend figure, so admin.html always showed $0.00 for buyers
   * (the field was read but never written anywhere). Mirrors the exact
   * same legacy-blended + per-currency pattern already used for freelancer
   * earnings (see totalEarned/totalEarnedByCurrency elsewhere) — totalSpent
   * is a legacy blended (all-currencies-summed) figure kept for reference
   * only, never to be shown as a dollar amount; totalSpentByCurrency is
   * the correct, currency-separated field admin.html now reads.
   *
   * netAmount/baseCurrency here are the same values just written to the
   * project doc above, so this stays in lockstep with what
   * buyer-dashboard.html already derives independently from escrow
   * records (project.amount||netAmount, project.currency) — both will
   * always reconcile to the same total.
   */
  if (project.buyerUid) {
    try {
      await db.collection('users').doc(project.buyerUid).update({
        totalSpent:                                FieldValue.increment(netAmount),
        [`totalSpentByCurrency.${baseCurrency}`]:   FieldValue.increment(netAmount),
        updatedAt:                                  FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn(`Could not update buyer totalSpent for ${project.buyerUid}:`, err.message);
    }
  }

  const platformUrl = ((env && env.PLATFORM_URL) || 'https://kreddlo.space').replace(/\/$/, '');
  const projectUrl  = `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(order_id)}`;

  /* Fetch freelancer and buyer details for the notification */
  let freelancerEmail = null;
  let freelancerName  = 'there';
  let buyerName       = 'A client';

  try {
    if (project.freelancerUid) {
      const freelancerSnap = await db.collection('users').doc(project.freelancerUid).get();
      if (freelancerSnap.exists) {
        freelancerEmail = freelancerSnap.data().email || null;
        freelancerName  = freelancerSnap.data().name  || 'there';
      }
    }
    if (project.buyerUid) {
      const buyerSnap = await db.collection('users').doc(project.buyerUid).get();
      if (buyerSnap.exists) {
        buyerName = buyerSnap.data().name || 'A client';
      }
    }
  } catch (err) {
    console.warn('Could not fetch user details for notification:', err.message);
  }

  /* Notify the freelancer: payment received (push + email always) */
  await callFunction(env, 'send-smart-notification', {
    userUid:    project.freelancerUid || null,
    to:         freelancerEmail,
    title:      'Escrow Funded',
    body:       `Payment has been placed in escrow for "${project.projectTitle || 'Your project'}". You can begin work.`,
    url:        projectUrl,
    templateId: 'payment-received',
    emailMode:  'always',
    emailData: {
      name:         freelancerName,
      buyerName,
      projectTitle: project.projectTitle || 'Your project',
      amount:       (outcome_amount || pay_amount)
                      ? new Intl.NumberFormat('en', { style: 'currency', currency: (outcome_currency || 'USD').toUpperCase() }).format(Number(outcome_amount || pay_amount))
                      : 'the agreed amount',
      dashboardUrl: projectUrl,
    },
  });
}


/* ══════════════════════════════════════════════════════════════
   AFFILIATE COMMISSION CREDITING
   Called from the product-order path after the order is marked paid.
   See stripe-webhook.js for full documentation of this logic.
   Always non-fatal — never blocks order delivery.
══════════════════════════════════════════════════════════════ */
async function creditAffiliateCommission({ db, order, orderId, sellerAmount, confirmedAmount, confirmedCurrency, amountUsd, gateway }) {
  const affiliateRef = order.affiliateRef || null;

  if (!affiliateRef) {
    return { finalSellerAmount: sellerAmount };
  }

  try {
    const affiliateUserSnap = await db.collection('users').doc(affiliateRef).get();
    if (!affiliateUserSnap.exists) {
      console.warn(`[affiliate] Referring user "${affiliateRef}" not found — skipping commission for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    const affiliateUser = affiliateUserSnap.data();
    if (affiliateUser.affiliateEnabled !== true) {
      console.warn(`[affiliate] Referring user "${affiliateRef}" has not opted in — skipping commission for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    if (affiliateRef === order.sellerUid) {
      console.warn(`[affiliate] Self-referral detected for order ${orderId}. Skipping.`);
      return { finalSellerAmount: sellerAmount };
    }

    let commissionPercent = 0;
    try {
      const productSnap = await db.collection('products').doc(order.productId).get();
      if (productSnap.exists) {
        const productData = productSnap.data();
        if (productData.affiliateEnabled !== true) {
          console.log(`[affiliate] Product "${order.productId}" does not have affiliateEnabled — skipping for order ${orderId}.`);
          return { finalSellerAmount: sellerAmount };
        }
        commissionPercent = Number(productData.affiliateCommissionPercent) || 0;
      } else {
        console.warn(`[affiliate] Product "${order.productId}" not found — skipping for order ${orderId}.`);
        return { finalSellerAmount: sellerAmount };
      }
    } catch (err) {
      console.warn(`[affiliate] Could not read product doc: ${err.message} — skipping for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    if (commissionPercent <= 0) {
      return { finalSellerAmount: sellerAmount };
    }

    const commissionAmount  = +(sellerAmount * (commissionPercent / 100)).toFixed(2);
    const finalSellerAmount = +(sellerAmount - commissionAmount).toFixed(2);

    if (commissionAmount <= 0) {
      return { finalSellerAmount: sellerAmount };
    }

    /*
     * Issue 2 fix — USD-equivalent for the blended gate field.
     * See flutterwave-webhook.js creditAffiliateCommission for full comment.
     */
    let commissionAmountUsd;
    if (confirmedCurrency === 'USD') {
      commissionAmountUsd = commissionAmount;
    } else if (amountUsd && Number(amountUsd) > 0 && Number(confirmedAmount) > 0) {
      commissionAmountUsd = +((commissionAmount / confirmedAmount) * Number(amountUsd)).toFixed(6);
    } else {
      commissionAmountUsd = commissionAmount;
    }

    const settings    = await getSettings(db);
    const holdingDays = Number(settings.affiliateHoldingDays) || 0;
    const now         = new Date();
    const clearsAt    = new Date(now.getTime() + holdingDays * 24 * 60 * 60 * 1000);
    const isCleared    = holdingDays <= 0; // 0 days = instant, same as legacy behaviour

    const affiliateUserUpdate = {
      affiliateTotalEarned: FieldValue.increment(commissionAmount),
      updatedAt:            FieldValue.serverTimestamp(),
    };
    if (isCleared) {
      // Gate field — always USD-equivalent so withdrawals are meaningful
      affiliateUserUpdate.affiliateBalance = FieldValue.increment(commissionAmountUsd);
      // Per-currency display map — always native amount for accurate display
      affiliateUserUpdate[`affiliateBalances.${confirmedCurrency}`] = FieldValue.increment(commissionAmount);
    } else {
      // Pending gate field — USD-equivalent
      affiliateUserUpdate.affiliatePendingBalance = FieldValue.increment(commissionAmountUsd);
      // Per-currency pending display map — native amount
      affiliateUserUpdate[`affiliatePendingBalances.${confirmedCurrency}`] = FieldValue.increment(commissionAmount);
    }
    await db.collection('users').doc(affiliateRef).update(affiliateUserUpdate);

    await db.collection('affiliate-earnings').add({
      affiliateUid:         affiliateRef,
      sellerUid:            order.sellerUid      || null,
      buyerUid:             order.buyerUid       || null,
      orderId,
      productId:            order.productId      || null,
      commissionPercent,
      commissionAmount,
      commissionAmountUsd,
      currency:             confirmedCurrency,
      confirmedAmount,
      gateway,
      // paymentMethod is stored for audit / display purposes only.
      // scheduled-clear-earnings.js section 2 does NOT use it for balance routing —
      // affiliate commissions always clear into the dedicated affiliateBalance pool
      // regardless of payment method. See the design note in scheduled-clear-earnings.js.
      paymentMethod:        'crypto',
      status:               'pending',
      cleared:              isCleared,
      clearsAt:             clearsAt,
      createdAt:            FieldValue.serverTimestamp(),
    });

    // Increment the conversions counter on the affiliate-links record
    // (non-fatal — a missed count should never block commission crediting)
    if (order.productId) {
      try {
        await db.collection('affiliate-links').doc(`${affiliateRef}_${order.productId}`).set({
          affiliateUid: affiliateRef,
          productId:    order.productId,
          conversions:  FieldValue.increment(1),
          updatedAt:    FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (err) {
        console.warn(`[affiliate-links] conversions increment failed for order ${orderId}:`, err.message);
      }
    }

    await db.collection('product-orders').doc(orderId).update({
      affiliateCommissionPaid:    true,
      affiliateCommissionAmount:  commissionAmount,
      affiliateCommissionPercent: commissionPercent,
      sellerAmount:               finalSellerAmount,
    });

    console.log(`[affiliate] Commission credited — order: ${orderId}, affiliate: ${affiliateRef}, amount: ${commissionAmount} ${confirmedCurrency} (~${commissionAmountUsd} USD) (${commissionPercent}%), finalSellerAmount: ${finalSellerAmount}`);

    return { finalSellerAmount };

  } catch (err) {
    console.error(`[affiliate] Commission crediting failed for order ${orderId}:`, err.message);
    return { finalSellerAmount: sellerAmount };
  }
}


/* ══════════════════════════════════════════════════════════════
   HANDLE FAILED / EXPIRED / REFUNDED PAYMENT
   Marks the project or product-order payment status so the buyer
   can retry. Checks product-orders first, then falls back to projects.
══════════════════════════════════════════════════════════════ */
async function handleFailedPayment(env, { order_id, payment_id, payment_status }) {
  if (!order_id) return;

  let db;
  try {
    db = getDb(env);
  } catch (err) {
    console.error('Firebase Admin init failed (failed payment handler):', err.message);
    return;
  }

  /* ── Check product-orders first ── */
  try {
    const orderSnap = await db.collection('product-orders').doc(order_id).get();
    if (orderSnap.exists) {
      await db.collection('product-orders').doc(order_id).update({
        paymentStatus: payment_status,
        nowpaymentsId: payment_id || null,
        updatedAt:     FieldValue.serverTimestamp(),
      });
      console.log(`Product order ${order_id} payment marked as ${payment_status}.`);
      return;
    }
  } catch (err) {
    console.error(`Firestore read/update failed for product-order ${order_id}:`, err.message);
  }

  /* ── Fall back to projects ── */
  try {
    const projectSnap = await db.collection('projects').doc(order_id).get();
    if (projectSnap.exists) {
      await db.collection('projects').doc(order_id).update({
        paymentStatus: payment_status,
        paymentId:     payment_id || null,
        updatedAt:     FieldValue.serverTimestamp(),
      });
      console.log(`Project ${order_id} payment marked as ${payment_status}.`);
      return;
    }
  } catch (err) {
    console.error(`Firestore update failed for failed payment on project ${order_id}:`, err.message);
  }

  /* ── Issue 11 fix: fall back to invoice-orders ──
     Previously a failed/expired/refunded NOWPayments status for a crypto
     invoice payment was silently ignored — the invoice-order doc kept its
     previous status with no update and no buyer notification. The invoice
     would then time out via the auto-deliver path, which is incorrect.
     Now we check invoice-orders as the third fallback and mark the
     paymentStatus so the buyer can be informed and retry. */
  try {
    const invOrderSnap = await db.collection('invoice-orders').doc(order_id).get();
    if (invOrderSnap.exists) {
      await db.collection('invoice-orders').doc(order_id).update({
        paymentStatus: payment_status,
        nowpaymentsId: payment_id || null,
        updatedAt:     FieldValue.serverTimestamp(),
      });
      console.log(`Invoice order ${order_id} payment marked as ${payment_status}.`);

      /* ── Issue 35-3 fix: notify seller that the invoice payment failed ──
         The seller has no way to know the crypto payment failed unless they
         proactively check their dashboard. Clients who paid via an emailed
         invoice link especially have no reason to return on their own.
         Fire-and-forget so a notification error never blocks the status write. */
      const invOrderData    = invOrderSnap.data();
      const failedSellerUid = invOrderData ? (invOrderData.sellerUid || null) : null;
      if (failedSellerUid) {
        const platformUrl      = ((env && env.PLATFORM_URL) || 'https://kreddlo.space').replace(/\/$/, '');
        const failedInvoiceRef = invOrderData.invoiceId || order_id;
        const friendlyStatus   = payment_status === 'expired'  ? 'expired'
                               : payment_status === 'refunded' ? 'refunded'
                               : 'failed';
        callFunction(env, 'send-smart-notification', {
          userUid:    failedSellerUid,
          title:      'Invoice Payment ' + friendlyStatus.charAt(0).toUpperCase() + friendlyStatus.slice(1),
          body:       `A crypto payment for invoice ${failedInvoiceRef} ${friendlyStatus}. You may want to follow up with your client to arrange a retry.`,
          url:        `${platformUrl}/dashboard-invoices.html`,
          templateId: 'invoice-payment-failed',
          emailMode:  'always',
          emailData: {
            invoiceRef:   failedInvoiceRef,
            status:       friendlyStatus,
            dashboardUrl: `${platformUrl}/dashboard-invoices.html`,
          },
        }).catch(function(notifErr) {
          console.warn(`Failed-payment seller notification failed for invoice-order ${order_id}:`, notifErr.message);
        });
      }

      return;
    }
  } catch (err) {
    console.error(`Firestore update failed for failed payment on invoice-order ${order_id}:`, err.message);
  }

  console.warn(`handleFailedPayment: order_id "${order_id}" not found in product-orders, projects, or invoice-orders — skipping.`);
}


/* ══════════════════════════════════════════════════════════════
   INTERNAL FUNCTION CALLER
   Calls sibling Netlify functions via HTTP fetch.
   Non-fatal: errors are logged and execution continues.
══════════════════════════════════════════════════════════════ */
async function callFunction(env, name, payload) {
  const platformUrl = ((env && env.PLATFORM_URL) || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return;
  }
  try {
    await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': (env && env.INTERNAL_FUNCTION_SECRET) || '',
      },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    console.warn(`callFunction(${name}) failed:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   INTERNAL FUNCTION CALLER WITH RETRY — used for deliver-product
   deliver-product.js credits the seller's balance, increments
   salesCount, and sends their sale notification. A single transient
   failure used to mean that work never ran and never got retried,
   with the order stuck showing paid but nothing credited. This
   retries up to 3 times with a short backoff and reports whether
   it ultimately succeeded.
══════════════════════════════════════════════════════════════ */
async function callFunctionWithRetry(env, name, payload, maxAttempts = 3) {
  const platformUrl = ((env && env.PLATFORM_URL) || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunctionWithRetry: PLATFORM_URL not set, cannot call ${name}.`);
    return { success: false, reason: 'PLATFORM_URL not set' };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'x-internal-secret': (env && env.INTERNAL_FUNCTION_SECRET) || '',
        },
        body:    JSON.stringify(payload),
      });

      if (res.ok) {
        return { success: true };
      }

      const errText = await res.text();
      lastError = `HTTP ${res.status}: ${errText}`;
      console.warn(`callFunctionWithRetry(${name}) attempt ${attempt}/${maxAttempts} returned ${res.status}: ${errText}`);
    } catch (err) {
      lastError = err.message;
      console.warn(`callFunctionWithRetry(${name}) attempt ${attempt}/${maxAttempts} network error:`, err.message);
    }

    if (attempt < maxAttempts) {
      const backoffMs = 500 * attempt;
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  console.error(`callFunctionWithRetry(${name}) failed after ${maxAttempts} attempts — last error: ${lastError}`);
  return { success: false, reason: lastError };
}


/* ── Pro Upgrade handler ── */
async function handleProUpgrade({ db, env, uid, billingPeriod, subscriptionId, gateway, amount }) {
  if (!uid) {
    console.error('[pro_upgrade] Missing uid — cannot activate Pro.');
    return;
  }
  const now       = new Date();
  const daysToAdd = billingPeriod === 'annual' ? 365 : 30;
  const endDate   = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  try {
    await db.collection('users').doc(uid).update({
      plan:             'pro',
      premiumStatus:    'active',
      planStatus:       'active',
      premiumStartDate: now,
      premiumEndDate:   endDate,
      updatedAt:        FieldValue.serverTimestamp(),
    });
    if (subscriptionId) {
      await db.collection('subscriptions').doc(subscriptionId).update({
        status:         'active',
        activatedAt:    now,
        premiumEndDate: endDate,
      }).catch(() => {});
    }
    console.log(`[pro_upgrade] uid: ${uid} activated Pro via ${gateway} — expires ${endDate.toISOString()}`);
    const platformUrl = ((env && env.PLATFORM_URL) || 'https://kreddlo.space').replace(/\/$/, '');
    if (platformUrl) {
      const userSnap = await db.collection('users').doc(uid).get().catch(() => null);
      const userData = userSnap?.exists ? userSnap.data() : {};
      const toEmail  = userData.email || null;
      const name     = userData.displayName || userData.name || 'Freelancer';
      if (toEmail) {
        await fetch(`${platformUrl}/.netlify/functions/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': (env && env.INTERNAL_FUNCTION_SECRET) || '' },
          body: JSON.stringify({
            to: toEmail, type: 'premium-activated',
            data: { name, plan: 'Pro', billingPeriod: billingPeriod === 'annual' ? 'Annual' : 'Monthly',
              endDate: endDate.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
              dashboardUrl: `${platformUrl}/dashboard.html` },
          }),
        }).catch(e => console.warn('[pro_upgrade] send-email failed:', e.message));
      }
    }
  } catch (err) {
    console.error('[pro_upgrade] Firestore update failed:', err.message);
  }
}

/* ── Utility: build a Workers Response ── */
function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
}

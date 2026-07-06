/**
 * Netlify Function: deliver-product.js
 * Path: netlify/functions/deliver-product.js
 *
 * Handles product delivery after a successful payment.
 * Can be called directly via POST or internally by payment webhooks.
 * Idempotent — returns 200 immediately if delivery already completed.
 *
 * Expected POST body (JSON):
 *   { orderId: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';
import { verifyCaller }                 from './_verify-auth';
import { getSettings }                  from './get-settings';

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

/* ── Internal function-to-function HTTP caller ── */
async function callFunction(functionName, payload, env) {
  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return null;
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
      console.error(`[deliver-product] callFunction(${functionName}) failed — status: ${res.status}, body: ${errText}`);
    }

    return res;
  } catch (err) {
    console.error(`[deliver-product] callFunction(${functionName}) network error:`, err.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export async function onRequest(context) {
  const { request, env, ctx } = context;
  const rawText = await request.text();

  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Verify caller identity — two accepted paths ──
     This function credits the seller's balance, so it must never be
     reachable by an anonymous request that merely supplies a valid
     orderId.
     Path 1 — Trusted internal call (stripe-webhook.js, flutterwave-
       webhook.js, nowpayments-webhook.js) identified by the
       x-internal-secret header. All three already send this header on
       every call via their shared callFunctionWithRetry() helper, so
       this path requires no change to any existing caller.
     Path 2 — An authenticated browser caller (Firebase ID token) whose
       uid matches the order's sellerUid or buyerUid. No current frontend
       page calls this function directly, but this keeps the door open
       for a legitimate authenticated caller without weakening the gate.
     A request satisfying neither is rejected — previously, a request
     with NO Authorization header at all skipped identity verification
     entirely and could still reach the crediting logic below. ── */
  const incomingSecret  = request.headers.get('x-internal-secret') || request.headers.get('X-Internal-Secret') || '';
  const expectedSecret  = env.INTERNAL_FUNCTION_SECRET || '';
  const isTrustedInternal = !!expectedSecret && incomingSecret === expectedSecret;

  let verifiedCallerUid = null;
  if (!isTrustedInternal) {
    verifiedCallerUid = await verifyCaller(request, env);
    if (!verifiedCallerUid) {
      return respond(401, { error: 'Unauthorized. Please log in again.' });
    }
  }

  let body;
  try {
    body = JSON.parse(rawText || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { orderId } = body;

  if (!orderId || typeof orderId !== 'string') {
    return respond(400, { error: 'orderId is required.' });
  }

  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  try {
    const db = getDb(env);

    /* ── Fetch order ── */
    const orderRef  = db.collection('product-orders').doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return respond(404, { error: 'Order not found.' });
    }

    const order = orderSnap.data();

    /* ── Ownership check for the authenticated-caller path ──
       Only applies when this request came in via Path 2 above (no
       internal secret, a verified Firebase token instead). The trusted-
       internal path (Path 1) is already gated by the shared secret and
       skips this check, matching its existing behavior exactly. ── */
    if (!isTrustedInternal) {
      const isOrderParty = order.sellerUid === verifiedCallerUid || order.buyerUid === verifiedCallerUid;
      if (!isOrderParty) {
        return respond(403, { error: 'You are not authorised to trigger delivery for this order.' });
      }
    }

    /* ── Fetch product (needed outside transaction for delivery logic) ── */
    const productSnap = await db.collection('products').doc(order.productId).get();
    if (!productSnap.exists) {
      return respond(404, { error: 'Product not found.' });
    }
    const product = productSnap.data();

    /* ── Fetch seller user document for seller name ── */
    const sellerSnap = await db.collection('users').doc(order.sellerUid).get();
    const seller     = sellerSnap.exists ? sellerSnap.data() : {};
    const sellerName = seller.displayName || seller.name || 'the seller';

    /* ── Delivery logic by type (email/notification before marking delivered) ── */
    if (product.deliveryType === 'instant-auto') {
      /* Send product-delivery email to buyer immediately */
      await callFunction('send-email', {
        to:         order.buyerEmail,
        toName:     order.buyerName,
        templateId: 'product-delivery',
        data: {
          name:            order.buyerName,
          productTitle:    product.title,
          deliveryType:    product.deliveryType,
          deliveryContent: product.deliveryContent,
          sellerName,
        },
      }, env);

    } else if (product.deliveryType === 'manual-link') {
      /* Notify seller to deliver manually */
      await callFunction('send-smart-notification', {
        userUid:      order.sellerUid,
        title:        'New sale — delivery required',
        body:         `You have a new sale on "${product.title}". The buyer is waiting for delivery.`,
        url:          `${platformUrl}/dashboard.html`,
        templateId:   'product-sale',
        emailMode:    'never',
        emailData: {
          name:         sellerName,
          buyerName:    order.buyerName,
          buyerEmail:   order.buyerEmail,
          productTitle: product.title,
          // NOTE: order.sellerAmount (pre-affiliate-deduction) is intentional
          // here. This notification fires before the transaction below, so
          // sellerAmount (post-deduction) and amountFormatted are not yet
          // computed. emailMode is 'never' so this field is never sent in an
          // email. The authoritative post-deduction amount is in the final
          // "You made a sale!" notification further down which uses amountFormatted.
          amount:       order.sellerAmount,
        },
      }, env);

      /* Create a seller task so it appears in their dashboard task list */
      await db.collection('seller-tasks').add({
        sellerUid:    order.sellerUid,
        orderId,
        productId:    order.productId,
        productTitle: product.title,
        buyerEmail:   order.buyerEmail,
        buyerName:    order.buyerName,
        type:         'manual-delivery',
        status:       'pending',
        createdAt:    FieldValue.serverTimestamp(),
      });
    }

    /* ── Atomic: re-read deliveryStatus inside transaction, mark delivered,
       credit seller balance ──
       A plain .get() + .update() pair (what was here before) has a race window:
       two near-simultaneous calls (webhook retry, double-tap, overlapping
       scheduled run) could both pass the deliveryStatus check before either
       commits and both would credit the seller — a real double-payment risk.
       Wrapping inside runTransaction() closes that window: the second caller
       will see deliveryStatus === 'delivered' and return early with no
       balance change. ── */

    const sellerAmount  = (typeof body.sellerAmount === 'number' && body.sellerAmount > 0)
      ? body.sellerAmount
      : (order.sellerAmount || 0);
    const orderCurrency = (order.chargedCurrency || order.currency || 'USD').toUpperCase();
    const amountFormatted = new Intl.NumberFormat('en', { style: 'currency', currency: orderCurrency }).format(sellerAmount);

    const settings        = await getSettings(db);
    const holdingDays     = Number(settings.productSaleHoldingDays) || 0;
    const deliveredAt     = new Date();
    const clearsAt        = new Date(deliveredAt.getTime() + holdingDays * 24 * 60 * 60 * 1000);
    const isCleared       = holdingDays <= 0;
    const isCryptoPayment = order.paymentMethod === 'crypto';

    let alreadyDelivered = false;

    await db.runTransaction(async (tx) => {
      // Re-read the order doc fresh inside the transaction — the earlier .get()
      // above is only used for product/seller lookups; this re-read gates the write.
      const freshOrderSnap = await tx.get(orderRef);
      if (!freshOrderSnap.exists) {
        const err = new Error('Order not found.');
        err.statusCode = 404;
        throw err;
      }

      const freshOrder = freshOrderSnap.data();

      /* ── Idempotency guard — another call already delivered this order ── */
      if (freshOrder.deliveryStatus === 'delivered') {
        alreadyDelivered = true;
        return;
      }

      /* ── Mark order as delivered inside the transaction ──
         For instant-auto products, also copy the product's delivery content
         onto the order itself. buyer-purchases.html reads accessUrl straight
         off the product-orders document — without this, the order showed
         deliveryStatus: 'delivered' with nothing for the buyer to open. ── */
      const orderDeliveryUpdate = {
        deliveryStatus: 'delivered',
        deliveredAt:    FieldValue.serverTimestamp(),
      };
      if (product.deliveryType === 'instant-auto') {
        orderDeliveryUpdate.deliveryContent = product.deliveryContent || null;
        orderDeliveryUpdate.fileUrl         = product.fileUrl         || null;
        orderDeliveryUpdate.courseUrl       = product.courseUrl       || null;
        orderDeliveryUpdate.coachingCalUrl  = product.coachingCalUrl  || null;
        orderDeliveryUpdate.redirectUrl     = product.redirectUrl     || null;
      }
      tx.update(orderRef, orderDeliveryUpdate);

      /* ── Increment product salesCount ── */
      tx.update(db.collection('products').doc(order.productId), {
        salesCount: FieldValue.increment(1),
      });

      /* ── Credit seller balance (per-currency map) inside the transaction ──
         totalSales / totalEarned are gross, all-time stats and update immediately
         regardless of holding period — only the spendable balance is gated.
         totalEarned is a legacy blended (all-currencies-summed) figure kept
         only for older admin tooling. It must never be shown to a seller as
         "earnings" since it can mix USD+NGN+EUR raw numbers together.
         totalEarnedByCurrency is the accurate, currency-separated figure for
         any seller-facing earnings display. ── */
      const sellerUserUpdate = {
        totalSales:  FieldValue.increment(1),
        totalEarned: FieldValue.increment(sellerAmount),
        [`totalEarnedByCurrency.${orderCurrency}`]: FieldValue.increment(sellerAmount),
      };
      if (isCleared) {
        sellerUserUpdate[`balances.${orderCurrency}`] = FieldValue.increment(sellerAmount);
        if (orderCurrency === 'USD') {
          if (isCryptoPayment) {
            // Crypto-sourced USD goes into the dedicated cryptoBalance pool.
            // create-payout.js debits this field — never availableBalance — for
            // crypto withdrawals, keeping the two pools permanently separate.
            sellerUserUpdate.cryptoBalance = FieldValue.increment(sellerAmount);
          } else {
            // Fiat-sourced USD (Stripe, Flutterwave) continues to use availableBalance.
            sellerUserUpdate.availableBalance = FieldValue.increment(sellerAmount);
          }
        }
      } else {
        sellerUserUpdate[`pendingBalances.${orderCurrency}`] = FieldValue.increment(sellerAmount);
        if (orderCurrency === 'USD') {
          if (isCryptoPayment) {
            sellerUserUpdate.cryptoPendingBalance = FieldValue.increment(sellerAmount);
          } else {
            sellerUserUpdate.pendingBalance = FieldValue.increment(sellerAmount);
          }
        }
      }
      tx.update(db.collection('users').doc(order.sellerUid), sellerUserUpdate);
    });

    /* ── Idempotency short-circuit ── */
    if (alreadyDelivered) {
      console.log(`[deliver-product] Order ${orderId} already delivered — skipping.`);
      return respond(200, { success: true, message: 'Already delivered.' });
    }

    /* ── Auditable earning record (outside transaction — no reads required) ──
       scheduled-clear-earnings.js flips `cleared` to true once `clearsAt`
       has passed and moves the amount from pendingBalance(s) to the
       appropriate spendable balance. ── */
    await db.collection('product-earnings').add({
      sellerUid:     order.sellerUid,
      orderId,
      productId:     order.productId,
      amount:        sellerAmount,
      currency:      orderCurrency,
      paymentMethod: order.paymentMethod || 'fiat', // 'crypto' or 'fiat' — used by scheduled-clear-earnings
      cleared:       isCleared,
      clearsAt:      clearsAt,
      deliveredAt:   FieldValue.serverTimestamp(),
      createdAt:     FieldValue.serverTimestamp(),
    });

    /* ── Notify buyer that their order has been delivered (Fix 1) ── */
    await callFunction('send-smart-notification', {
      userUid:    order.buyerUid,
      title:      'Your order has been delivered!',
      body:       `"${product.title}" has been delivered. Visit your purchases to access it.`,
      url:        `${platformUrl}/buyer-purchases.html`,
      templateId: 'product-delivery',
      emailMode:  'never',
    }, env);

    /* ── Schedule review-request email (48 hours = 2880 minutes) ── */
    await callFunction('send-smart-notification', {
      userUid:      order.sellerUid, // placeholder — email goes to buyer via emailData.to
      title:        'Review request scheduled',
      body:         `A review request will be sent to ${order.buyerEmail} in 48 hours.`,
      templateId:   'review-request',
      emailMode:    'never',
      delayMinutes: 2880,
      emailTo:      order.buyerEmail,
      emailToName:  order.buyerName,
      emailData: {
        name:         order.buyerName,
        productTitle: product.title,
        reviewUrl:    `${platformUrl}/review.html?orderId=${encodeURIComponent(orderId)}`,
        sellerName,
      },
    }, env);

    /* ── Send seller a product-sale notification ── */
    await callFunction('send-smart-notification', {
      userUid:    order.sellerUid,
      title:      'You made a sale!',
      body:       `${order.buyerName} purchased "${product.title}" for ${amountFormatted}.`,
      url:        `${platformUrl}/dashboard.html`,
      templateId: 'product-sale',
      emailMode:  'never',
      emailData: {
        name:         sellerName,
        buyerName:    order.buyerName,
        buyerEmail:   order.buyerEmail,
        productTitle: product.title,
        // Fix Issue 3: use amountFormatted (post-affiliate-deduction, correctly
        // formatted in orderCurrency) instead of order.sellerAmount (the
        // pre-deduction raw number from Firestore). sellerAmount at this point
        // already reflects any affiliate commission taken out (passed via
        // body.sellerAmount by the payment webhook), so amountFormatted matches
        // exactly what was credited to the seller's balance above. emailMode is
        // 'never' so this emailData is not sent today, but if it ever becomes
        // 'always' the figure shown will be correct.
        amount:       amountFormatted,
      },
    }, env);

    console.log(`[deliver-product] Delivered — orderId: ${orderId}, type: ${product.deliveryType}`);

    return respond(200, { success: true, orderId, deliveryType: product.deliveryType });

  } catch (err) {
    console.error('[deliver-product] Error:', err);
    return respond(500, { error: err.message || 'Internal server error.' });
  }
  }

function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

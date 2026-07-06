/**
 * Cloudflare Function: purchase-credits.js
 * Path: functions/.netlify/functions/purchase-credits.js
 *
 * Lets a freelancer purchase a bundle of Kreddlo Credits (used to
 * submit Pitches on Briefs — see submit-pitch.js) via Flutterwave or
 * Stripe hosted checkout. Creates a pending order in Firestore, then
 * asks the chosen gateway for a hosted checkout URL. The purchase is
 * only credited to the freelancer's account once the gateway webhook
 * confirms payment (that webhook wiring is out of scope for this step —
 * see the "webhook" note below).
 *
 * Method: POST only.
 *
 * POST body:
 *   {
 *     bundle:  string  — one of 'starter', 'pro', 'power'. Credit counts
 *                        and USD price for each are read live from
 *                        config/platform (admin-configurable in admin.html
 *                        under "Kreddlo Credits") — defaults if never
 *                        configured: starter 50 credits/$4.99, pro 150
 *                        credits/$9.99, power 500 credits/$24.99.
 *     gateway: string  — one of 'flutterwave', 'stripe'
 *   }
 *
 * Success response (200):
 *   { success: true, orderId: string, checkoutUrl: string }
 *
 * Error responses:
 *   400 — missing/invalid bundle or gateway
 *   401 — not authenticated
 *   403 — caller is not a freelancer
 *   404 — account not found
 *   405 — method not allowed
 *   500 — gateway not configured / internal error
 *   502 — gateway API error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — e.g. https://kreddlo.space (no trailing slash)
 *   FLW_SECRET_KEY           — required if gateway is 'flutterwave'
 *   STRIPE_SECRET_KEY        — required if gateway is 'stripe'
 *
 * NOTE ON WEBHOOKS: this function only *initiates* the checkout session
 * and records a 'pending' creditOrders doc. Crediting dailyCredits/
 * purchasedCredits on successful payment is the responsibility of the
 * Flutterwave/Stripe webhook handlers, which read the orderId out of the
 * transaction metadata the same way stripe-webhook.js / the Flutterwave
 * webhook already do for project payments. That webhook wiring is not
 * part of this step and is intentionally left untouched.
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';
import { verifyCaller }                 from './_verify-auth';
import { getSettings }                  from './get-settings';

/* ── Valid bundle keys. Credits + price for each key are NOT hardcoded —
   they are read live from config/platform (admin-configurable in admin.html
   under "Kreddlo Credits") via buildBundles() below. Server is always the
   source of truth; the client-submitted bundle key only selects which
   bundle to charge, it never supplies the price. ── */
const BUNDLE_KEYS = ['starter', 'pro', 'power'];

/* ── Build the live bundle table from platform settings, falling back to
   get-settings.js defaults if an admin has never saved custom values. ── */
function buildBundles(settings) {
  return {
    starter: {
      credits: Number(settings.creditBundleStarterCredits) || 50,
      amount:  Number(settings.creditBundleStarterPrice)   || 4.99,
    },
    pro: {
      credits: Number(settings.creditBundleProCredits) || 150,
      amount:  Number(settings.creditBundleProPrice)   || 9.99,
    },
    power: {
      credits: Number(settings.creditBundlePowerCredits) || 500,
      amount:  Number(settings.creditBundlePowerPrice)   || 24.99,
    },
  };
}

const FLW_PAYMENT_URL      = 'https://api.flutterwave.com/v3/payments';
const STRIPE_CHECKOUT_URL  = 'https://api.stripe.com/v1/checkout/sessions';

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

/* ── Utility: build a Cloudflare Workers response ── */
function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/* ── Utility: application/x-www-form-urlencoded encoder for Stripe ── */
function toFormEncoded(obj, prefix) {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
  }
  return parts.join('&');
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export async function onRequest(context) {
  const { request, env, ctx } = context;

    /* ── Accept POST only ── */
    if (request.method !== 'POST') {
      return respond(405, { error: 'Method not allowed.' });
    }

    /* ── 1. Verify caller identity ── */
    const callerUid = await verifyCaller(request, env);
    if (!callerUid) {
      return respond(401, { error: 'Unauthorized. Please log in again.' });
    }

    /* ── 2. Parse request body ── */
    let body;
    try {
      const rawText = await request.text();
      body = JSON.parse(rawText || '{}');
    } catch {
      return respond(400, { error: 'Invalid JSON in request body.' });
    }

    const { bundle, gateway } = body;

    if (!bundle || !BUNDLE_KEYS.includes(bundle)) {
      return respond(400, { error: "bundle must be one of 'starter', 'pro', 'power'." });
    }
    if (gateway !== 'flutterwave' && gateway !== 'stripe') {
      return respond(400, { error: "gateway must be 'flutterwave' or 'stripe'." });
    }

    const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

    try {
      const db = getDb(env);

      /* ── 3. Role check — freelancer only ── */
      const userRef  = db.collection('users').doc(callerUid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        return respond(404, { error: 'Account not found.' });
      }
      const userData = userSnap.data();
      if (userData.role !== 'freelancer') {
        return respond(403, { error: 'Only freelancers can purchase Kreddlo Credits.' });
      }

      /* ── 3b. Look up the live, admin-configurable price for this bundle ── */
      const settings = await getSettings(db);
      const BUNDLES  = buildBundles(settings);
      const { credits, amount } = BUNDLES[bundle];

      /* ── 4. Create the pending order ── */
      const orderRef = db.collection('creditOrders').doc();
      const orderId  = orderRef.id;
      const now      = FieldValue.serverTimestamp();

      await orderRef.set({
        uid:       callerUid,
        bundle,
        credits,
        amount,
        gateway,
        status:    'pending',
        createdAt: now,
      });

      /* ── 5. Call the chosen gateway ── */
      if (gateway === 'flutterwave') {
        const flwKey = env.FLW_SECRET_KEY;
        if (!flwKey) {
          console.error('FLW_SECRET_KEY environment variable is not set.');
          return respond(500, { error: 'Flutterwave is not configured. Please contact support.' });
        }

        const paymentRef = `kreddlo-credits-${orderId}-${Date.now()}`;
        const transactionPayload = {
          tx_ref:          paymentRef,
          amount:          amount,
          currency:        'USD',
          redirect_url:    `${platformUrl}/credits.html?purchase=success&orderId=${encodeURIComponent(orderId)}`,
          payment_options: 'card,banktransfer,ussd,mobilemoney,account,barter,nqr',
          customer: {
            email: userData.email || `${callerUid}@kreddlo.space`,
            name:  userData.displayName || userData.name || 'Kreddlo Freelancer',
          },
          customizations: {
            title:       'Kreddlo Credits',
            description: `${credits} Kreddlo Credits — ${bundle.charAt(0).toUpperCase()}${bundle.slice(1)} bundle`,
            logo:        `${platformUrl}/assets/kreddlo-logo.png`,
          },
          meta: {
            orderId,
            bundle,
            credits,
            uid:      callerUid,
            platform: 'kreddlo',
            type:     'credit-purchase',
          },
        };

        let flwRes;
        try {
          flwRes = await fetch(FLW_PAYMENT_URL, {
            method:  'POST',
            headers: {
              'Authorization': `Bearer ${flwKey}`,
              'Content-Type':  'application/json',
            },
            body: JSON.stringify(transactionPayload),
          });
        } catch (networkErr) {
          console.error('Network error reaching Flutterwave:', networkErr);
          return respond(502, { error: 'Could not reach the payment service. Please try again.' });
        }

        let flwData;
        try {
          flwData = await flwRes.json();
        } catch {
          console.error('Flutterwave returned non-JSON response, status:', flwRes.status);
          return respond(502, { error: 'Unexpected response from payment service.' });
        }

        if (!flwRes.ok || flwData.status !== 'success') {
          console.error('Flutterwave API error:', { status: flwRes.status, payload: flwData });
          const detail = flwData?.message || 'Unknown error from payment service.';
          return respond(502, { error: `Payment service error: ${detail}` });
        }

        const checkoutUrl = flwData?.data?.link;
        if (!checkoutUrl) {
          console.error('Flutterwave response missing data.link:', flwData);
          return respond(502, { error: 'Payment service did not return a checkout URL.' });
        }

        await orderRef.update({ paymentRef });
        console.log(`[purchase-credits] Flutterwave order ${orderId} initialised for ${callerUid} — ${bundle} (${credits} credits, $${amount}).`);
        return respond(200, { success: true, orderId, checkoutUrl });
      }

      /* gateway === 'stripe' */
      const stripeKey = env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        console.error('STRIPE_SECRET_KEY environment variable is not set.');
        return respond(500, { error: 'Stripe is not configured. Please contact support.' });
      }

      const sessionParams = {
        'payment_method_types[0]':                                'card',
        'mode':                                                   'payment',
        'line_items[0][price_data][currency]':                    'usd',
        'line_items[0][price_data][product_data][name]':          `Kreddlo Credits — ${bundle.charAt(0).toUpperCase()}${bundle.slice(1)}`,
        'line_items[0][price_data][product_data][description]':   `${credits} Kreddlo Credits`,
        'line_items[0][price_data][unit_amount]':                 Math.round(amount * 100),
        'line_items[0][quantity]':                                1,
        'metadata[order_id]':                                     orderId,
        'metadata[uid]':                                          callerUid,
        'metadata[type]':                                         'credit-purchase',
        'metadata[platform]':                                     'kreddlo',
        'success_url': `${platformUrl}/credits.html?purchase=success&orderId=${encodeURIComponent(orderId)}`,
        'cancel_url':  `${platformUrl}/credits.html?purchase=cancelled&orderId=${encodeURIComponent(orderId)}`,
      };
      if (userData.email) {
        sessionParams['customer_email'] = userData.email;
      }

      let stripeRes;
      try {
        stripeRes = await fetch(STRIPE_CHECKOUT_URL, {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${stripeKey}`,
            'Content-Type':  'application/x-www-form-urlencoded',
          },
          body: toFormEncoded(sessionParams),
        });
      } catch (networkErr) {
        console.error('Network error reaching Stripe:', networkErr);
        return respond(502, { error: 'Could not reach the payment service. Please try again.' });
      }

      let stripeData;
      try {
        stripeData = await stripeRes.json();
      } catch {
        console.error('Stripe returned non-JSON response, status:', stripeRes.status);
        return respond(502, { error: 'Unexpected response from payment service.' });
      }

      if (!stripeRes.ok) {
        console.error('Stripe API error:', { status: stripeRes.status, payload: stripeData });
        const detail = stripeData?.error?.message || 'Unknown error from payment service.';
        return respond(502, { error: `Payment service error: ${detail}` });
      }

      const checkoutUrl = stripeData.url;
      if (!checkoutUrl) {
        console.error('Stripe response missing url field:', stripeData);
        return respond(502, { error: 'Payment service did not return a checkout URL.' });
      }

      await orderRef.update({ sessionId: stripeData.id });
      console.log(`[purchase-credits] Stripe order ${orderId} initialised for ${callerUid} — ${bundle} (${credits} credits, $${amount}).`);
      return respond(200, { success: true, orderId, checkoutUrl });

    } catch (err) {
      console.error('[purchase-credits] Unhandled error:', err);
      return respond(500, { error: 'Internal server error. Please try again.' });
    }
  }

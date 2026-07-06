/**
 * resolve-bank-account.js — Kreddlo Netlify Function
 *
 * Resolves a bank account holder name from bank details, via two paths:
 *
 *  1. Flutterwave path (NGN, GHS, KES, …) — POST /v3/accounts/resolve
 *     using bankCode + accountNumber. Unchanged from the original
 *     implementation — used by the affiliate bank withdrawal form
 *     (dashboard-affiliate.html) and the freelancer bank payout flow.
 *
 *  2. Stripe path (USD, EUR, GBP, CAD, AUD, NZD, SGD, HKD, CHF, DKK, NOK, SEK) —
 *     creates a Stripe bank account token via POST /v1/tokens, which
 *     returns the resolved bank_name for the supplied account details.
 *     The exact fields required depend on the currency:
 *       USD / CAD / AUD / NZD / SGD / HKD → routingNumber + accountNumber
 *       GBP                  → sortCode + accountNumber
 *       EUR / CHF / DKK / NOK / SEK → iban
 *
 * Query params:
 *   currency       — fiat currency code, defaults to NGN
 *
 *   — Flutterwave currencies —
 *   bankCode       — Flutterwave bank code — required
 *   accountNumber  — bank account number — required
 *
 *   — Stripe currencies —
 *   accountNumber  — required for routing/sort-code types
 *   routingNumber  — required for USD, CAD, AUD, NZD, SGD, HKD
 *   sortCode       — required for GBP
 *   iban           — required for EUR, CHF, DKK, NOK, SEK
 *
 * Environment variables required:
 *   FLW_SECRET_KEY    — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 *   STRIPE_SECRET_KEY — Stripe secret key (sk_live_... or sk_test_...) — only
 *                       needed when resolving a Stripe-supported currency
 */

import { verifyCaller } from './_verify-auth';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';

const FLW_BASE    = 'https://api.flutterwave.com/v3';
const STRIPE_BASE = 'https://api.stripe.com/v1';

/* ─────────────────────────────────────────────
   FIREBASE ADMIN (loaded lazily, same pattern as
   create-bank-payout.js / create-payout.js, so cold
   starts don't fail if the env var is missing in preview)
───────────────────────────────────────────── */
let _db = null;

function getDb(env) {
  if (_db) return _db;

  if (!getApps().length) {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({
      credential: cert(serviceAccount),
    });
  }

  _db = getFirestore();
  return _db;
}

/**
 * Stripe-supported international currencies and the field/country/currency
 * shape each one needs when creating a bank account token.
 * Kept identical in spirit to the STRIPE_FIELD_MAP in get-bank-list.js so
 * both flows agree on which fields each currency collects.
 */
const STRIPE_FIELD_MAP = {
  USD: { type: 'routing_account', country: 'US' },
  CAD: { type: 'routing_account', country: 'CA' },
  AUD: { type: 'routing_account', country: 'AU' },
  NZD: { type: 'routing_account', country: 'NZ' },
  SGD: { type: 'routing_account', country: 'SG' },
  HKD: { type: 'routing_account', country: 'HK' },
  GBP: { type: 'sort_account',    country: 'GB' },
  EUR: { type: 'iban' },
  CHF: { type: 'iban' },
  DKK: { type: 'iban' },
  NOK: { type: 'iban' },
  SEK: { type: 'iban' },
};

const STRIPE_CURRENCIES = Object.keys(STRIPE_FIELD_MAP);

export async function onRequest(context) {
  const { request, env, ctx } = context;
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: CORS });
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(request, env);
  if (!callerUid) {
    return new Response(JSON.stringify({ error: 'Unauthorized. Please log in again.' }), { status: 401, headers: CORS });
  }

  const url      = new URL(request.url);
  const params   = Object.fromEntries(url.searchParams);
  const currency = (params.currency || 'NGN').toUpperCase().trim();

  /* ════════════════════════════════════════════════════════════════
   * STRIPE PATH — international currencies
   * ════════════════════════════════════════════════════════════════ */
  if (STRIPE_CURRENCIES.includes(currency)) {
    return resolveViaStripe(currency, params, CORS, env);
  }

  /* ════════════════════════════════════════════════════════════════
   * FLUTTERWAVE PATH — unchanged from original implementation
   * ════════════════════════════════════════════════════════════════ */
  const bankCode      = (params.bankCode || '').trim();
  const accountNumber = (params.accountNumber || '').trim();

  if (!bankCode) {
    return new Response(JSON.stringify({ error: 'Bank is required.' }), { status: 400, headers: CORS });
  }
  if (!accountNumber) {
    return new Response(JSON.stringify({ error: 'Account number is required.' }), { status: 400, headers: CORS });
  }

  const flwKey = env.FLW_SECRET_KEY;
  if (!flwKey) {
    console.error('[resolve-bank-account] FLW_SECRET_KEY not set.');
    return new Response(JSON.stringify({ error: 'Account lookup is temporarily unavailable.' }), {
      status: 503,
      headers: CORS,
    });
  }

  try {
    const res = await fetch(`${FLW_BASE}/accounts/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${flwKey}`,
      },
      body: JSON.stringify({
        account_bank:   bankCode,
        account_number: accountNumber,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.status !== 'success' || !data.data || !data.data.account_name) {
      return new Response(JSON.stringify({ error: data.message || 'Could not verify this account. Check the bank and account number.' }), {
        status: 422,
        headers: CORS,
      });
    }

    // Fix 16 — persist the resolved account holder name so
    // create-bank-payout.js can cross-check what's submitted at withdrawal
    // time against what was last independently resolved here. Non-fatal:
    // this is a log-only audit signal, never blocks the lookup response.
    // (Stripe-resolved currencies don't get this — Stripe's token response
    // only returns a bank_name, not an account holder name, so there's
    // nothing meaningful to compare against there.)
    try {
      const db = getDb(env);
      await db.collection('users').doc(callerUid).update({
        lastResolvedAccountName:   data.data.account_name,
        lastResolvedAccountNumber: accountNumber,
        updatedAt:                 FieldValue.serverTimestamp(),
      });
    } catch (persistErr) {
      console.warn('[resolve-bank-account] Could not persist lastResolvedAccountName:', persistErr.message);
    }

    return new Response(JSON.stringify({ accountName: data.data.account_name }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[resolve-bank-account] Lookup failed:', err.message);
    return new Response(JSON.stringify({ error: 'Could not verify this account. Please try again.' }), {
      status: 502,
      headers: CORS,
    });
  }
}

/**
 * Resolves a bank name for a Stripe-supported international currency by
 * creating a bank account token via POST /v1/tokens. The token response
 * includes a `bank_account.bank_name` field derived by Stripe from the
 * routing/sort/BSB number or IBAN — we never store or reuse the token
 * itself, only read the bank name back out of the response.
 */
async function resolveViaStripe(currency, params, CORS, env) {
  const shape = STRIPE_FIELD_MAP[currency];

  const accountNumber = (params.accountNumber || '').trim();
  const routingNumber = (params.routingNumber || '').trim();
  const bsbNumber     = (params.bsbNumber || '').trim();
  const sortCode      = (params.sortCode || '').trim();
  const iban          = (params.iban || '').replace(/\s+/g, '').toUpperCase();

  const bankAccount = {
    currency: currency.toLowerCase(),
  };

  if (shape.type === 'iban') {
    if (!iban) {
      return new Response(JSON.stringify({ error: 'IBAN is required.' }), { status: 400, headers: CORS });
    }
    const ibanCountry = iban.slice(0, 2);
    if (!/^[A-Z]{2}$/.test(ibanCountry)) {
      return new Response(JSON.stringify({ error: 'That IBAN doesn\u2019t look valid. Please check and try again.' }), { status: 400, headers: CORS });
    }
    bankAccount.country        = ibanCountry;
    bankAccount.account_number = iban;
  } else {
    if (!accountNumber) {
      return new Response(JSON.stringify({ error: 'Account number is required.' }), { status: 400, headers: CORS });
    }
    bankAccount.country        = shape.country;
    bankAccount.account_number = accountNumber;

    if (shape.type === 'routing_account') {
      if (!routingNumber) {
        return new Response(JSON.stringify({ error: 'Routing number is required.' }), { status: 400, headers: CORS });
      }
      bankAccount.routing_number = routingNumber;
    } else if (shape.type === 'sort_account') {
      if (!sortCode) {
        return new Response(JSON.stringify({ error: 'Sort code is required.' }), { status: 400, headers: CORS });
      }
      bankAccount.routing_number = sortCode;
    }
  }

  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('[resolve-bank-account] STRIPE_SECRET_KEY not set.');
    return new Response(JSON.stringify({ error: 'Account lookup is temporarily unavailable.' }), {
      status: 503,
      headers: CORS,
    });
  }

  const form = new URLSearchParams();
  Object.keys(bankAccount).forEach((key) => {
    form.append(`bank_account[${key}]`, bankAccount[key]);
  });

  try {
    const res = await fetch(`${STRIPE_BASE}/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:  `Bearer ${stripeKey}`,
      },
      body: form.toString(),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.bank_account) {
      const msg = (data.error && data.error.message) || 'Could not verify this account. Check the details and try again.';
      return new Response(JSON.stringify({ error: msg }), { status: 422, headers: CORS });
    }

    const bankName = data.bank_account.bank_name;
    if (!bankName) {
      return new Response(JSON.stringify({ error: 'Could not determine the bank for these details. You can still continue \u2014 the bank name is for display only.' }), {
        status: 422,
        headers: CORS,
      });
    }

    return new Response(JSON.stringify({ accountName: bankName, stripeAccountToken: data.id }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[resolve-bank-account] Stripe lookup failed:', err.message);
    return new Response(JSON.stringify({ error: 'Could not verify this account. Please try again.' }), {
      status: 502,
      headers: CORS,
    });
  }
}

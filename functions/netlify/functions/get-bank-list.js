/**
 * get-bank-list.js — Kreddlo Netlify Function
 *
 * Returns the list of banks for a given destination country, sourced from
 * Flutterwave's GET /v3/banks/:country endpoint. Used by the freelancer bank
 * withdrawal form (dashboard-withdraw.html) and the affiliate bank withdrawal
 * form (dashboard-affiliate.html) to populate the bank list or Stripe field
 * descriptor for the selected destination country.
 *
 * Country-first design: the `country` query param (ISO 3166-1 alpha-2, e.g.
 * "NG", "US", "DE") is the primary routing key. This decouples "where is your
 * bank account?" from "which balance do you want to spend?" — a freelancer
 * with a USD balance can withdraw to a Nigerian bank account; the bank list
 * is driven by country (NG → Nigerian banks), and the debit currency is
 * chosen separately on the frontend.
 *
 * For Stripe-supported countries (US, GB, DE, CA, AU, NZ, CH, DK, NO, SE,
 * SG, HK) no bank list is returned — instead a `stripeFields` descriptor
 * tells the frontend which input fields to render (routing+account, IBAN,
 * sort+account, etc.)
 *
 * Query params:
 *   country   — ISO 3166-1 alpha-2 country code (NG, US, DE, …) — preferred
 *   currency  — fiat currency code (NGN, USD, EUR, …) — legacy fallback;
 *               used when `country` is absent so old callers continue to work
 *
 * Both params are accepted simultaneously; `country` always wins when present.
 *
 * Response always includes:
 *   payoutCurrency — the native currency of the destination country (e.g. "NGN"
 *                    for NG, "USD" for US). The frontend sends this as
 *                    `payoutCurrency` to create-bank-payout / affiliate-withdraw
 *                    when it differs from the user's debit currency.
 *
 * Environment variables required:
 *   FLW_SECRET_KEY    — Flutterwave secret key
 *   STRIPE_SECRET_KEY — Stripe secret key (only needed for Stripe countries)
 */

import { verifyCaller } from './_verify-auth';

const FLW_BASE    = 'https://api.flutterwave.com/v3';
const STRIPE_BASE = 'https://api.stripe.com/v1';

/* ─────────────────────────────────────────────────────────────────────────────
   COUNTRY → FLW CONFIG
   Maps ISO country code to the Flutterwave country code for bank lookup
   and the native payout currency for that country.
   Kept identical to CURRENCY_TO_COUNTRY in create-bank-payout.js (extended
   here with the payoutCurrency field so we don't need a second lookup).
───────────────────────────────────────────────────────────────────────────── */
const COUNTRY_TO_FLW = {
  NG: { flwCountry: 'NG', payoutCurrency: 'NGN' },
  GH: { flwCountry: 'GH', payoutCurrency: 'GHS' },
  KE: { flwCountry: 'KE', payoutCurrency: 'KES' },
  UG: { flwCountry: 'UG', payoutCurrency: 'UGX' },
  TZ: { flwCountry: 'TZ', payoutCurrency: 'TZS' },
  RW: { flwCountry: 'RW', payoutCurrency: 'RWF' },
  ZA: { flwCountry: 'ZA', payoutCurrency: 'ZAR' },
  CI: { flwCountry: 'CI', payoutCurrency: 'XOF' }, // Côte d'Ivoire
  SN: { flwCountry: 'SN', payoutCurrency: 'XOF' }, // Senegal (also XOF)
  BF: { flwCountry: 'BF', payoutCurrency: 'XOF' }, // Burkina Faso (also XOF)
  CM: { flwCountry: 'CM', payoutCurrency: 'XAF' }, // Cameroon
  MW: { flwCountry: 'MW', payoutCurrency: 'MWK' },
  ZM: { flwCountry: 'ZM', payoutCurrency: 'ZMW' },
  ET: { flwCountry: 'ET', payoutCurrency: 'ETB' },
  SL: { flwCountry: 'SL', payoutCurrency: 'SLL' }, // Sierra Leone
  EG: { flwCountry: 'EG', payoutCurrency: 'EGP' }, // Egypt
};

/* ─────────────────────────────────────────────────────────────────────────────
   COUNTRY → STRIPE CONFIG
   Maps ISO country code to the Stripe payout currency and field descriptor.
   For these countries we return stripeFields instead of a bank list.
───────────────────────────────────────────────────────────────────────────── */
const COUNTRY_TO_STRIPE = {
  US: { payoutCurrency: 'USD', type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Routing number + Account number' },
  CA: { payoutCurrency: 'CAD', type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Institution & transit number + Account number' },
  AU: { payoutCurrency: 'AUD', type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'BSB number + Account number' },
  NZ: { payoutCurrency: 'NZD', type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Bank branch number + Account number' },
  SG: { payoutCurrency: 'SGD', type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Bank code + Account number' },
  HK: { payoutCurrency: 'HKD', type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Bank code + Account number' },
  GB: { payoutCurrency: 'GBP', type: 'sort_account',    fields: ['sortCode', 'accountNumber'],      label: 'Sort code + Account number' },
  DE: { payoutCurrency: 'EUR', type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  CH: { payoutCurrency: 'CHF', type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  DK: { payoutCurrency: 'DKK', type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  NO: { payoutCurrency: 'NOK', type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  SE: { payoutCurrency: 'SEK', type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
};

/* ─────────────────────────────────────────────────────────────────────────────
   LEGACY FALLBACK — currency → country
   Allows old callers that pass only `currency` (no `country`) to continue
   working without any change. New callers always pass `country`.
───────────────────────────────────────────────────────────────────────────── */
const CURRENCY_TO_COUNTRY = {
  // FLW currencies
  NGN: 'NG', GHS: 'GH', KES: 'KE', UGX: 'UG', TZS: 'TZ',
  RWF: 'RW', ZAR: 'ZA', XOF: 'CI', XAF: 'CM', MWK: 'MW',
  ZMW: 'ZM', ETB: 'ET', SLL: 'SL', EGP: 'EG',
  // Stripe currencies
  USD: 'US', CAD: 'CA', AUD: 'AU', NZD: 'NZ', SGD: 'SG',
  HKD: 'HK', GBP: 'GB', EUR: 'DE', CHF: 'CH', DKK: 'DK',
  NOK: 'NO', SEK: 'SE',
};

/* ─────────────────────────────────────────────────────────────────────────────
   FX RATE FETCH
   Always fetches USD → payoutCurrency rate from the appropriate gateway.
   Returns null on any failure — frontend falls back gracefully.

   IMPORTANT — NO CACHING ALLOWED WITHOUT A STALENESS CAP:
   This function makes a live gateway request on every call intentionally.
   If Firestore caching is ever added here (a natural performance optimisation),
   you MUST also enforce a MAX_STALE_MS cap of ≤ 24 hours and return null if
   the cached rate is older — identical to the pattern used in
   create-invoice-order.js / create-stripe-payment.js / create-product-order.js.

   Those charge-time functions block a payment entirely rather than use a rate
   older than 24 hours, specifically to prevent the platform going into debt
   when exchange rates move between cache-write and payment-collection time.
   A display-only rate here that silently ages past 24 hours would break user
   trust (showing an estimate that no longer reflects market reality) and would
   set a dangerous precedent inconsistent with every other rate-fetch in this
   codebase. Return null instead — the frontend already handles null gracefully
   by hiding the estimate row entirely rather than showing a stale figure.
───────────────────────────────────────────────────────────────────────────── */
async function fetchGatewayFxRate(env, payoutCurrency) {
  payoutCurrency = payoutCurrency.toUpperCase();

  const STRIPE_CURRENCIES_SET = new Set([
    'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'DKK', 'NOK', 'SEK', 'SGD', 'HKD',
  ]);

  if (STRIPE_CURRENCIES_SET.has(payoutCurrency)) {
    if (payoutCurrency === 'USD') return 1;
    const stripeKey = env.STRIPE_SECRET_KEY;
    if (!stripeKey) return null;
    try {
      const auth = 'Basic ' + btoa(stripeKey + ':');
      // Use the single-resource endpoint /v1/exchange_rates/usd which returns
      // { "id": "usd", "rates": { "gbp": 0.79, "eur": 0.91, ... } } directly.
      // The list endpoint (?currency=usd) wraps rates inside data[0].rates,
      // so data.rates would be undefined there — always returning null.
      const res  = await fetch(`${STRIPE_BASE}/exchange_rates/usd`, {
        headers: { Authorization: auth },
      });
      const data = await res.json().catch(() => ({}));
      const rate = data.rates && data.rates[payoutCurrency.toLowerCase()];
      return rate ? Number(rate) : null;
    } catch {
      return null;
    }
  }

  // FLW currencies
  const flwKey = env.FLW_SECRET_KEY;
  if (!flwKey) return null;
  try {
    const res = await fetch(
      `${FLW_BASE}/transfers/rates?amount=1&destination_currency=${payoutCurrency}&source_currency=USD`,
      { headers: { Authorization: `Bearer ${flwKey}` } }
    );
    const data = await res.json().catch(() => ({}));
    const rate = data.data && data.data.rate;
    return rate ? Number(rate) : null;
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   HANDLER
───────────────────────────────────────────────────────────────────────────── */
export default {
async fetch(request, env, ctx) {
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

  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams);

  /* ── Resolve country code ──
   * `country` param wins when present (new callers).
   * Fall back to deriving country from `currency` (legacy callers).
   * Both are normalised to uppercase. */
  let countryParam = (params.country || '').toUpperCase().trim();
  const currencyParam = (params.currency || '').toUpperCase().trim();

  if (!countryParam && currencyParam) {
    countryParam = CURRENCY_TO_COUNTRY[currencyParam] || '';
  }

  if (!countryParam) {
    return new Response(JSON.stringify({ error: 'A country or currency parameter is required.' }), {
      status: 400,
      headers: CORS,
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     STRIPE PATH — routing/IBAN/sort-code countries
  ───────────────────────────────────────────────────────────────── */
  if (COUNTRY_TO_STRIPE[countryParam]) {
    const cfg = COUNTRY_TO_STRIPE[countryParam];
    const stripeFields = { type: cfg.type, fields: cfg.fields, label: cfg.label };
    const fxRate = await fetchGatewayFxRate(env, cfg.payoutCurrency);

    return new Response(JSON.stringify({
      banks:          [],
      country:        countryParam,
      payoutCurrency: cfg.payoutCurrency, // native currency of this country
      currency:       cfg.payoutCurrency, // kept for legacy callers that read `currency`
      stripeFields,
      fxRate,
      fxSource: 'stripe',
    }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     FLW PATH — African bank-list countries
  ───────────────────────────────────────────────────────────────── */
  if (COUNTRY_TO_FLW[countryParam]) {
    const cfg    = COUNTRY_TO_FLW[countryParam];
    const flwKey = env.FLW_SECRET_KEY;

    if (!flwKey) {
      console.error('[get-bank-list] FLW_SECRET_KEY not set.');
      return new Response(JSON.stringify({ error: 'Bank lookup is temporarily unavailable.' }), {
        status: 503,
        headers: CORS,
      });
    }

    try {
      const res = await fetch(`${FLW_BASE}/banks/${cfg.flwCountry}`, {
        headers: { Authorization: `Bearer ${flwKey}` },
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.status !== 'success' || !Array.isArray(data.data)) {
        console.error(
          `[get-bank-list] Flutterwave rejected country=${countryParam} flwCountry=${cfg.flwCountry} status=${res.status}:`,
          JSON.stringify(data)
        );
        throw new Error(data.message || `Flutterwave bank list returned status ${res.status}`);
      }

      const banks = data.data
        .map((b) => ({ code: b.code, name: b.name }))
        .filter((b) => b.code && b.name)
        .sort((a, b) => a.name.localeCompare(b.name));

      // Fetch live FLW rate best-effort — never blocks the bank list response
      const fxRate = await fetchGatewayFxRate(env, cfg.payoutCurrency).catch(() => null);

      return new Response(JSON.stringify({
        banks,
        country:        countryParam,
        payoutCurrency: cfg.payoutCurrency, // native currency of this country
        currency:       cfg.payoutCurrency, // kept for legacy callers that read `currency`
        fxRate,
        fxSource: 'flutterwave',
      }), {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('[get-bank-list] Failed to fetch bank list:', err.message);
      return new Response(JSON.stringify({ error: 'Could not load bank list. Please try again.' }), {
        status: 502,
        headers: CORS,
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     UNSUPPORTED COUNTRY
  ───────────────────────────────────────────────────────────────── */
  return new Response(JSON.stringify({ error: `Bank transfers are not yet supported for country: ${countryParam}.` }), {
    status: 400,
    headers: CORS,
  });
}
};

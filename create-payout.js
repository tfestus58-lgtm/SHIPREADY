/**
 * create-payout.js — Kreddlo Netlify Function
 *
 * Handles freelancer CRYPTO withdrawal requests.
 *
 * Flow:
 *  1. Validate & parse request body
 *  2. Verify user exists + has sufficient cryptoBalance in Firestore
 *     (the dedicated crypto-gateway USD pool — NOT availableBalance, which
 *     is the separate fiat pool debited only by create-bank-payout.js)
 *  3. Check our NOWPayments outcome wallet actually holds enough of the
 *     requested coin (PRIORITY 2 FIX — runs before any balance is touched)
 *  4. Call NOWPayments Mass Payout API to send chosen coin to wallet
 *  5. Write payout document to Firestore /payouts collection
 *  6. Deduct amount from user's cryptoBalance + increment totalWithdrawn
 *  7. Call /send-email function to send withdrawal confirmation email
 *  8. Return payout ID and NOWPayments batch ID to the client
 *
 * Note: steps 5/6 above happen before step 4's NOWPayments call completes —
 * see STEP 2 / the atomic balance-reservation transaction further down for
 * the actual ordering. The numbered list here is a high-level summary.
 *
 * Environment variables required (set in Netlify dashboard):
 *   NOWPAYMENTS_API_KEY       — NOWPayments API key
 *   NOWPAYMENTS_IPN_SECRET    — IPN secret (used for payout HMAC if needed)
 *   FIREBASE_SERVICE_ACCOUNT  — Full Firebase service account JSON as one-line string
 *   PLATFORM_URL              — live domain; used to build the ipn_callback_url
 *                                passed to NOWPayments so payout status updates
 *                                (finished/failed/rejected) reach
 *                                nowpayments-payout-webhook.js. See that file
 *                                for what happens when a payout fails after
 *                                this function has already deducted the balance.
 */

import { verifyCaller } from './_verify-auth';
import admin from 'firebase-admin';

/* ─────────────────────────────────────────────
   FIREBASE ADMIN (loaded lazily so cold starts
   don't fail if env var is missing in preview)
───────────────────────────────────────────── */
let _db = null;

function getDb(env) {
  if (_db) return _db;

  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  _db = admin.firestore();
  return _db;
}

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

/** Simple HTTPS POST returning parsed JSON */
async function httpsPost(hostname, path, data, headers) {
  const body = JSON.stringify(data);
  const res = await fetch(`https://${hostname}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
  });
  const raw = await res.text();
  try { return { status: res.status, body: JSON.parse(raw) }; }
  catch (e) { return { status: res.status, body: raw }; }
}

/** Simple HTTPS GET returning parsed JSON */
async function httpsGet(hostname, path, headers) {
  const res = await fetch(`https://${hostname}${path}`, {
    method: 'GET',
    headers: headers || {},
  });
  const raw = await res.text();
  try { return { status: res.status, body: JSON.parse(raw) }; }
  catch (e) { return { status: res.status, body: raw }; }
}

/*
 * Maps the coin IDs used on the withdraw form to CoinGecko's "simple price"
 * IDs, so the server can independently fetch the same USD price the
 * frontend used to compute its display rate. usdt/usd-coin are treated as
 * pegged 1:1 to USD (matches the frontend's static fallback for stables).
 */
const COINGECKO_ID_MAP = {
  usdt:            'tether',
  bitcoin:         'bitcoin',
  ethereum:        'ethereum',
  binancecoin:     'binancecoin',
  'usd-coin':      'usd-coin',
  litecoin:        'litecoin',
  ripple:          'ripple',
  dogecoin:        'dogecoin',
  solana:          'solana',
  cardano:         'cardano',
  tron:            'tron',
  'matic-network': 'matic-network',
};

/**
 * Fetches the current USD price for a coin from CoinGecko and returns it
 * as "USD per 1 coin unit" (exchangeRate), matching the convention used by
 * the frontend's liveRates object. Returns null if the coin is unknown or
 * the fetch fails — callers must handle that by falling back safely
 * (never by trusting the client's number unchecked).
 */
async function fetchServerExchangeRate(coinId) {
  const geckoId = COINGECKO_ID_MAP[coinId];
  if (!geckoId) return null;

  try {
    const result = await httpsGet(
      'api.coingecko.com',
      `/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd`,
    );
    const usdPrice = result?.body?.[geckoId]?.usd;
    if (!usdPrice || isNaN(Number(usdPrice)) || Number(usdPrice) <= 0) return null;
    return 1 / Number(usdPrice); // USD per 1 coin unit, same convention as frontend
  } catch (err) {
    console.warn('[create-payout] CoinGecko rate fetch failed:', err.message);
    return null;
  }
}

/**
 * Normalises the coin selector down to the exact lowercase ticker that
 * NOWPayments expects for both the /v1/payout request and the /v1/balance
 * lookup, so both call sites can never drift out of sync with each other.
 */
function normalizeNowCurrency(coinId, currency) {
  return (coinId || currency || 'usdttrc20').toLowerCase();
}

/**
 * PRIORITY 2 FIX — checks our NOWPayments outcome wallet actually holds
 * enough of the requested coin BEFORE we touch the user's balance.
 * Docs: GET /v1/balance returns { "<ticker>": { amount, pendingAmount } }.
 * Returns the available `amount` for the coin, or null if the lookup
 * couldn't be completed (unknown ticker, network error, bad response).
 * Callers should fail OPEN on null — the payout webhook refund (Priority 1
 * fix) is still the safety net for an actual failed payout — and fail
 * CLOSED only on a confirmed, explicit insufficient-balance reading.
 */
async function fetchPayoutWalletBalance(env, nowCurrency) {
  const apiKey = env.NOWPAYMENTS_API_KEY;
  if (!apiKey) return null;

  try {
    const result = await httpsGet(
      'api.nowpayments.io',
      '/v1/balance',
      { 'x-api-key': apiKey },
    );
    if (result.status !== 200 || typeof result.body !== 'object' || !result.body) {
      console.warn('[create-payout] NOWPayments balance endpoint returned non-200:', result.status);
      return null;
    }
    const entry = result.body[nowCurrency];
    if (!entry || typeof entry.amount !== 'number' || isNaN(entry.amount)) {
      console.warn(`[create-payout] No usable balance entry for "${nowCurrency}" in /v1/balance response.`);
      return null;
    }
    return Number(entry.amount);
  } catch (err) {
    console.warn('[create-payout] NOWPayments balance fetch failed:', err.message);
    return null;
  }
}

/** Truncate wallet address for display in emails */
function shortWallet(addr) {
  if (!addr || addr.length <= 14) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-6);
}

/** Format a number as USD string */
function usd(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* ─────────────────────────────────────────────
   NOWPAYMENTS MASS PAYOUT
   Docs: https://documenter.getpostman.com/view/7907941/2s93JqTRWN
───────────────────────────────────────────── */
async function initiateNowPaymentsPayout({
  walletAddress,
  currency,     // e.g. "USDT", "BTC", "ETH"
  coinId,       // e.g. "trc20", "btc", "eth" — maps to NOWPayments currency code
  amountCoin,   // exact coin amount to send (after all fees)
  uid,          // used as unique_external_id
  payoutDocId,  // Firestore doc ID — used as extra_id for reconciliation
  env,
}) {
  const apiKey = env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error('NOWPAYMENTS_API_KEY is not set.');

  /*
   * NOWPayments accepts the currency as the coin ticker symbol in lowercase.
   * The coinId from the frontend (e.g. "trc20", "btc", "eth") maps cleanly
   * to what NOWPayments expects. normalizeNowCurrency() is shared with the
   * Priority 2 wallet balance pre-check so both stay in sync.
   */
  const nowCurrency = normalizeNowCurrency(coinId, currency);

  /*
   * PRIORITY 1 FIX — wire up the payout status webhook.
   * Without ipn_callback_url, NOWPayments never sends payout status
   * updates (FINISHED/FAILED/REJECTED) back to us, so a payout that
   * fails AFTER this API call accepts it goes completely unnoticed —
   * the user's balance stays deducted with no crypto ever received.
   * extra_id (payoutDocId) is echoed back in that callback so
   * nowpayments-payout-webhook.js can find the matching Firestore doc.
   */
  const platformUrl    = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const ipnCallbackUrl = platformUrl
    ? `${platformUrl}/.netlify/functions/nowpayments-payout-webhook`
    : undefined;

  const payload = {
    withdrawals: [
      {
        address:             walletAddress,
        currency:            nowCurrency,
        amount:              amountCoin,
        unique_external_id:  `kreddlo-${uid}-${Date.now()}`,
        extra_id:            payoutDocId || '',
        ipn_callback_url:    ipnCallbackUrl,
      },
    ],
  };

  const result = await httpsPost(
    'api.nowpayments.io',
    '/v1/payout',
    payload,
    { 'x-api-key': apiKey },
  );

  if (result.status !== 200 && result.status !== 201) {
    const errMsg =
      (typeof result.body === 'object' && (result.body.message || result.body.error))
        || `NOWPayments returned status ${result.status}`;
    throw new Error(`NOWPayments error: ${errMsg}`);
  }

  /*
   * Response shape:
   * {
   *   id: "batch_id",
   *   withdrawals: [{ id, status, amount, currency, address, ... }]
   * }
   */
  const batchId      = result.body.id || null;
  const withdrawal   = Array.isArray(result.body.withdrawals) ? result.body.withdrawals[0] : null;
  const withdrawalId = withdrawal?.id || null;
  const nowStatus    = withdrawal?.status || 'WAITING';

  return { batchId, withdrawalId, nowStatus };
}

/* ─────────────────────────────────────────────
   MAIN HANDLER
───────────────────────────────────────────── */
export async function onRequest(context) {
  const { request, env, ctx } = context;
  /* ── CORS preflight ── */
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

  /* ── Only allow POST ── */
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405 });
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(request, env);
  if (!callerUid) {
    return new Response(JSON.stringify({ error: 'Unauthorized. Please log in again.' }), { status: 401 });
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(rawText || '{}');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), { status: 400 });
  }

  const {
    uid: _bodyUid,  // ignored — we use the verified caller uid
    amount,         // USD amount the freelancer entered
    amountCoin,     // coin amount after fees (sent to wallet)
    amountUsdt,     // equivalent USDT amount (for records)
    currency,       // coin symbol  — e.g. "USDT", "BTC", "ETH"
    coinId,         // NOWPayments currency id — e.g. "trc20", "btc"
    network,        // network label — e.g. "TRC-20", "Bitcoin"
    walletAddress,
    exchangeRate,   // USD per 1 coin unit
    usdtRate,       // USD per 1 USDT
    fees,           // { nowpaymentsFee, platformFee }
  } = payload;

  // Always use the token-verified uid, not the client-supplied one
  const uid = callerUid;

  /* ── Basic input validation ── */
  if (!uid || typeof uid !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing user ID.' }), { status: 400 });
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) < 10) {
    return new Response(JSON.stringify({ error: 'Minimum withdrawal amount is $10.00.' }), { status: 400 });
  }
  if (!walletAddress || walletAddress.trim().length < 10) {
    return new Response(JSON.stringify({ error: 'Invalid wallet address.' }), { status: 400 });
  }
  if (!currency || !coinId) {
    return new Response(JSON.stringify({ error: 'Missing coin selection.' }), { status: 400 });
  }
  if (!amountCoin || Number(amountCoin) <= 0) {
    return new Response(JSON.stringify({ error: 'Coin amount must be greater than zero.' }), { status: 400 });
  }

  const amtUsd  = Number(amount);
  let   coinAmt = Number(amountCoin); // may be clamped down by server-side rate validation below

  try {
    const db = getDb(env);

    /* ────────────────────────────────────────
       STEP 1 — Pre-flight: verify user exists, role, KYC
       (outside transaction — read-only, fail fast)
    ──────────────────────────────────────── */
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return new Response(JSON.stringify({ error: 'User not found.' }), { status: 404 });
    }

    const userData = userSnap.data();

    /* Role check */
    if (userData.role !== 'freelancer') {
      return new Response(JSON.stringify({ error: 'Only freelancers can withdraw funds.' }), { status: 403 });
    }

    /* KYC check */
    if (userData.kycStatus !== 'verified') {
      return new Response(JSON.stringify({ error: 'KYC verification required before withdrawing.' }), { status: 403 });
    }

    /* Payout freeze check */
    if (userData.payoutsFrozen === true) {
      return new Response(JSON.stringify({ error: 'Withdrawals temporarily paused by platform. Please contact support for assistance.' }), { status: 403 });
    }

    /* ────────────────────────────────────────
       STEP 1a — OTP verification gate (FIX)
       Server-side enforcement of the 2FA step. Previously a valid Firebase
       auth token alone was enough to call this function and withdraw funds
       — the OTP step lived entirely in the frontend and was trivially
       bypassable. withdrawalOtpVerifiedAt is written by
       verify-withdrawal-otp.js on success and must be within the last 5
       minutes; it is cleared after a successful payout (see FIX #1
       transaction below) so one verification cannot be reused for
       multiple withdrawals.
    ──────────────────────────────────────── */
    {
      const otpVerifiedAt = userData.withdrawalOtpVerifiedAt
        ? (userData.withdrawalOtpVerifiedAt.toDate
            ? userData.withdrawalOtpVerifiedAt.toDate()
            : new Date(userData.withdrawalOtpVerifiedAt))
        : null;

      const OTP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
      if (!userData.withdrawalOtpUsed || !otpVerifiedAt || (Date.now() - otpVerifiedAt.getTime()) > OTP_WINDOW_MS) {
        return new Response(JSON.stringify({ error: 'Withdrawal requires OTP verification. Please verify your identity and try again.' }), { status: 403 });
      }
    }

    /* ────────────────────────────────────────
       STEP 1b — Server-side fee validation
       Load the expected platform fee rate from Firestore config,
       apply Pro rate if the user has an active Pro plan,
       then reject the request if the client-supplied fee is
       more than 5% below what we expect (manipulation guard).
    ──────────────────────────────────────── */
    {
      let expectedFeePct = 1.5; // safe default
      try {
        const cfgSnap = await db.collection('config').doc('platform').get();
        if (cfgSnap.exists) {
          const cfgData = cfgSnap.data();
          if (typeof cfgData.withdrawalFeePercent === 'number') {
            expectedFeePct = cfgData.withdrawalFeePercent;
          }
          // Pro users get a reduced fee rate
          const isPro = userData.plan === 'pro' && userData.premiumStatus === 'active';
          if (isPro && typeof cfgData.withdrawalFeePercentPro === 'number') {
            expectedFeePct = cfgData.withdrawalFeePercentPro;
          }
        }
      } catch (cfgErr) {
        console.warn('[create-payout] Could not load fee config, using default:', cfgErr.message);
      }

      const expectedPlatformFee = amtUsd * (expectedFeePct / 100);
      const clientPlatformFee   = Number(fees?.platformFee || 0);

      if (clientPlatformFee < expectedPlatformFee * 0.95) {
        return new Response(JSON.stringify({ error: 'Invalid fee calculation. Please refresh and try again.' }), { status: 400 });
      }
    }

    /* ────────────────────────────────────────
       STEP 1c — Server-side coin-amount validation (FIX)
       amountCoin is the exact quantity sent to the freelancer's wallet by
       NOWPayments. Previously it was taken from the request body as-is,
       so a tampered request could deduct the correct USD amount from the
       balance while inflating the actual crypto payout. We independently
       fetch the current USD/coin rate from CoinGecko (the same source the
       frontend uses), recompute the expected coin amount from amtUsd and
       the validated fees, and reject if the client's amountCoin exceeds
       that by more than a small tolerance (covers normal price drift
       between page load and submit). We never trust the client's number
       upward — at most we use it if it's within tolerance, and otherwise
       fall back to the server-computed value when a sane rate is available.
    ──────────────────────────────────────── */
    {
      const serverRate = await fetchServerExchangeRate(coinId);

      if (serverRate) {
        const validatedNowFee  = Number(fees?.nowpaymentsFee || 0);
        const validatedPlatFee = Number(fees?.platformFee || 0);
        const expectedAfterFees = amtUsd - validatedNowFee - validatedPlatFee;
        const expectedCoinAmt   = expectedAfterFees > 0 ? expectedAfterFees * serverRate : 0;

        // Allow 3% tolerance for normal market movement between the user
        // loading the page and submitting the withdrawal.
        const TOLERANCE = 0.03;

        if (expectedCoinAmt <= 0 || coinAmt > expectedCoinAmt * (1 + TOLERANCE)) {
          return new Response(JSON.stringify({ error: 'Invalid coin amount. Please refresh and try again.' }), { status: 400 });
        }

        // Use the lower (safer) of the two values so a stale-but-valid
        // client rate never results in overpaying the user.
        coinAmt = Math.min(coinAmt, expectedCoinAmt);
      } else {
        // Could not independently verify the rate (CoinGecko unreachable,
        // or coinId not in our map). Fail closed rather than trusting an
        // unverified client-supplied coin amount.
        console.error('[create-payout] Could not verify exchange rate server-side for coinId:', coinId);
        return new Response(JSON.stringify({ error: 'Unable to verify current exchange rate. Please try again shortly.' }), { status: 502 });
      }
    }

    /* ────────────────────────────────────────
       STEP 1d — Wallet outcome-balance pre-check (PRIORITY 2 FIX)
       Checks our NOWPayments payout wallet actually holds enough of the
       requested coin BEFORE we deduct anything from the user's balance.
       This runs before STEP 2 specifically so a known-insufficient wallet
       never causes a balance deduction in the first place — sparing the
       user the deduct/refund round-trip the Priority 1 webhook handles
       for payouts that fail *after* being accepted by NOWPayments.
       Fails OPEN (lets the request proceed) if the check itself can't be
       completed — the webhook refund safety net still covers that case —
       and fails CLOSED only on a confirmed insufficient reading.
    ──────────────────────────────────────── */
    {
      const nowCurrencyForCheck = normalizeNowCurrency(coinId, currency);
      const walletBalance = await fetchPayoutWalletBalance(env, nowCurrencyForCheck);

      if (walletBalance !== null && walletBalance < coinAmt) {
        console.error(
          `[create-payout] Insufficient payout wallet balance for "${nowCurrencyForCheck}". ` +
          `Have: ${walletBalance}, need: ${coinAmt}.`
        );
        return new Response(JSON.stringify({
          error: `Withdrawals in ${currency.toUpperCase()} are temporarily unavailable. Please try a different coin or contact support.`,
        }), { status: 503 });
      }
    }

    /* ────────────────────────────────────────
       STEP 2 — Atomic balance reservation via Firestore transaction.
       Issue B fix: the payout doc is now created AFTER the transaction
       commits (see STEP 2b below), not before it. Previously the doc was
       created with status 'pending' before the transaction ran; two
       concurrent requests that both passed the pre-flight OTP check at
       STEP 1a could both create a 'pending' doc, and only one would win
       the transaction — leaving the loser's doc marked 'failed' in the
       catch block. The failed doc was cosmetically harmless (no balance
       was ever moved for it) but cluttered the audit trail. Moving doc
       creation to after the transaction commit means a payout doc only
       exists when funds have already been atomically reserved, which is
       the same fix already applied to affiliate-withdraw.js (Issue 5).
       payoutRef / payoutId are declared here, assigned in STEP 2b below.
    ──────────────────────────────────────── */
    let payoutRef = null;
    let payoutId  = null;

    /* ────────────────────────────────────────
       FIX #1 — Atomic balance reservation via Firestore transaction
       Re-reads balance inside the transaction to prevent race conditions
       where two simultaneous withdrawals both pass the balance check.
    ──────────────────────────────────────── */
    let reservedBalance;
    try {
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(userRef);
        const freshData = freshSnap.data();

        /*
         * RACE-CONDITION FIX — re-verify the OTP is still unused INSIDE this
         * same atomic transaction, not just in the pre-flight check at STEP
         * 1a above. That earlier check reads a snapshot that can go stale:
         * if two withdrawal requests arrive close together (a double-tap on
         * a slow connection, a client retry, or a deliberate replay), BOTH
         * could pass the pre-flight check before either one commits — the
         * old code then let both transactions through because only balance
         * sufficiency was re-checked here, not the OTP.
         *
         * Firestore transactions serialize per-document: only the FIRST
         * request to commit can ever see withdrawalOtpUsed === true here.
         * The moment it commits, it deletes the OTP fields as part of this
         * same write. Any other concurrent request's tx.get() above is
         * guaranteed to observe that post-commit state and will hit this
         * check and fail loudly — before a single cent of balance moves.
         * One verified OTP can now authorize at most one withdrawal, full
         * stop, regardless of timing.
         */
        const freshOtpVerifiedAt = freshData.withdrawalOtpVerifiedAt
          ? (freshData.withdrawalOtpVerifiedAt.toDate
              ? freshData.withdrawalOtpVerifiedAt.toDate()
              : new Date(freshData.withdrawalOtpVerifiedAt))
          : null;
        const OTP_WINDOW_MS_TX = 5 * 60 * 1000; // 5 minutes — matches STEP 1a
        if (!freshData.withdrawalOtpUsed || !freshOtpVerifiedAt || (Date.now() - freshOtpVerifiedAt.getTime()) > OTP_WINDOW_MS_TX) {
          const err = new Error(
            'This withdrawal has already been processed, or your verification has expired. Please verify your identity again to submit a new withdrawal.'
          );
          err.statusCode = 409;
          throw err;
        }

        // Crypto withdrawals debit cryptoBalance — the dedicated pool that
        // nowpayments-webhook.js credits via deliver-product.js and
        // approve-delivery.js for crypto-gateway USD earnings.
        // availableBalance is the fiat pool (Stripe / Flutterwave) and must
        // never be touched by a crypto payout.
        const cryptoBalance = Number(freshData.cryptoBalance || 0);

        if (cryptoBalance < amtUsd) {
          const err = new Error(
            `Insufficient crypto balance. Available: ${usd(cryptoBalance)}, Requested: ${usd(amtUsd)}.`
          );
          err.statusCode = 400;
          throw err;
        }

        reservedBalance = cryptoBalance; // capture for post-transaction display only

        /*
         * Issue F fix — use FieldValue.increment() for all three balance
         * mutations instead of SET to absolute computed values.
         *
         * The previous code computed:
         *   newBalance     = Math.max(0, cryptoBalance - amtUsd)   → SET
         *   totalWithdrawn = freshData.totalWithdrawn + amtUsd     → SET
         *
         * Both suffer the same atomicity gap as Issue B in create-bank-payout.js:
         * if nowpayments-payout-webhook.js or scheduled-clear-earnings.js
         * concurrently writes cryptoBalance between tx.get() and tx.update(),
         * Firestore retries the transaction but freshData.cryptoBalance is stale
         * from the prior attempt — so the SET would wipe out the concurrent
         * write. Math.max(0, ...) also silently clamps underflows to zero
         * instead of surfacing an error. FieldValue.increment is applied
         * atomically by Firestore regardless of concurrent writes and is the
         * correct pattern for balance fields — matching how create-bank-payout.js
         * (Issue B fix) and the refund path below already handle this.
         *
         * Debit cryptoBalance — the crypto-earned USD pool written by
         * deliver-product.js / approve-delivery.js when paymentMethod === 'crypto'.
         * balances.USD is also decremented to keep the display map in sync
         * (deliver-product.js / approve-delivery.js credit both fields for
         * crypto-gateway orders). availableBalance is NOT touched — it is
         * the fiat withdrawal pool and belongs to create-bank-payout.js.
         */
        tx.update(userRef, {
          cryptoBalance:     admin.firestore.FieldValue.increment(-amtUsd),
          'balances.USD':    admin.firestore.FieldValue.increment(-amtUsd),
          totalWithdrawn:    admin.firestore.FieldValue.increment(amtUsd),
          updatedAt: new Date(),
          // Part C of the OTP fix — consume the verification on success so
          // it can't be replayed for a second withdrawal.
          withdrawalOtpUsed:       admin.firestore.FieldValue.delete(),
          withdrawalOtpVerifiedAt: admin.firestore.FieldValue.delete(),
        });
      });
    } catch (txErr) {
      // Issue B fix: no payout doc was created before the transaction, so
      // there is nothing to mark as 'failed' here — the transaction rolled
      // back automatically and the user's balance was never touched.
      const sc = txErr.statusCode || 500;
      return new Response(JSON.stringify({ error: txErr.message }), { status: sc });
    }

    /* ────────────────────────────────────────
       STEP 2b — Create payout document AFTER transaction commits.
       Issue B fix: funds are already atomically reserved above, so we
       now create the payout doc. If this write fails (network blip after
       a successful commit), we compensate by refunding the reserved
       balance — the user sees a clean error and can retry.
    ──────────────────────────────────────── */
    const payoutData = {
      userUid:       uid,
      userName:      userData.name        || '',
      userEmail:     userData.email       || '',
      amount:        amtUsd,
      amountCoin:    coinAmt,
      amountUsdt:    Number(amountUsdt    || 0),
      currency:      currency.toUpperCase(),
      coinId:        coinId,
      network:       network              || '',
      walletAddress: walletAddress.trim(),
      exchangeRate:  Number(exchangeRate  || 0),
      usdtRate:      Number(usdtRate      || 0),
      fees: {
        nowpaymentsFee: Number(fees?.nowpaymentsFee || 0),
        platformFee:    Number(fees?.platformFee    || 0),
      },
      status:        'pending',
      batchId:       null,
      withdrawalId:  null,
      nowStatus:     null,
      createdAt:     new Date(),
      updatedAt:     new Date(),
    };

    try {
      payoutRef = await db.collection('payouts').add(payoutData);
      payoutId  = payoutRef.id;
    } catch (docErr) {
      // Payout doc creation failed after balance was already reserved.
      // Refund the balance so the user is not left with funds deducted
      // but no payout record — this is the only safe recovery here.
      console.error('[create-payout] Failed to create payout doc after transaction committed:', docErr.message);
      try {
        await userRef.update({
          cryptoBalance:  admin.firestore.FieldValue.increment(amtUsd),
          'balances.USD': admin.firestore.FieldValue.increment(amtUsd),
          totalWithdrawn: admin.firestore.FieldValue.increment(-amtUsd),
          updatedAt:      new Date(),
        });
      } catch (refundErr) {
        console.error('[create-payout] CRITICAL: compensating refund also failed after doc creation error for uid ' + uid + ':', refundErr.message);
      }
      return new Response(JSON.stringify({ error: 'Internal error creating payout record. Your balance has been refunded. Please request a new OTP verification and try again.' }), { status: 500 });
    }

    /* ────────────────────────────────────────
       STEP 3 — Call NOWPayments AFTER balance is reserved
       If this fails we refund via compensating update.
    ──────────────────────────────────────── */
    let batchId, withdrawalId, nowStatus;

    try {
      ({ batchId, withdrawalId, nowStatus } = await initiateNowPaymentsPayout({
        walletAddress: walletAddress.trim(),
        currency,
        coinId,
        amountCoin:    coinAmt,
        uid,
        payoutDocId:   payoutId,
        env,
      }));
    } catch (nowErr) {
      /*
       * NOWPayments call failed — compensate by refunding the deducted balance
       * and marking the payout doc 'failed'.
       *
       * Bug 4 fix: the OTP fields were already consumed inside the STEP 2
       * transaction above. The user's balance has been refunded here, but if
       * we return only the raw gateway error message the user will click
       * "Withdraw" again, hit the OTP check (fields are gone), and see a
       * confusing "OTP required" error with no explanation of what happened.
       * Appending the OTP re-verify instruction (same sentinel phrase used by
       * the STEP 2b doc-creation error and detected by the frontend's
       * 'new OTP' check) ensures the existing Issue 7 UX fix in
       * dashboard-withdraw.html triggers automatically — re-opening the OTP
       * modal with the refund message shown first.
       */
      await payoutRef.update({ status: 'failed', errorMsg: nowErr.message, updatedAt: new Date() });
      await userRef.update({
        cryptoBalance:  admin.firestore.FieldValue.increment(amtUsd),  // restore the crypto pool deducted above
        'balances.USD': admin.firestore.FieldValue.increment(amtUsd),  // restore the display map
        totalWithdrawn: admin.firestore.FieldValue.increment(-amtUsd),
        updatedAt:      new Date(),
      });

      return new Response(JSON.stringify({
        error: nowErr.message + ' Your balance has been refunded. Please request a new OTP verification and try again.',
      }), { status: 502 });
    }

    /* ────────────────────────────────────────
       STEP 4 — Update payout doc to 'sent'
    ──────────────────────────────────────── */
    await payoutRef.update({
      status:       'sent',
      batchId:      batchId      || null,
      withdrawalId: withdrawalId || null,
      nowStatus:    nowStatus    || null,
      updatedAt:    new Date(),
    });

    /* ── Compute newBalance for response/notification ── */
    const newBalance = Math.max(0, reservedBalance - amtUsd);
    // Return the updated cryptoBalance so the frontend can update the
    // crypto card immediately without waiting for a full page reload.
    const newCryptoBalance = Math.max(0, newBalance);

    /* ────────────────────────────────────────
       STEP 6 — Send withdrawal confirmation email
    ──────────────────────────────────────── */
    try {
      const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '',
        },
        body:    JSON.stringify({
          userUid:    uid,
          to:         userData.email || null,
          title:      'Withdrawal Initiated',
          body:       `Your withdrawal of ${usd(amtUsd)} has been processed and is on its way.`,
          url:        `${platformUrl}/dashboard-withdraw.html`,
          templateId: 'withdrawal-initiated',
          emailMode:  'always',
          emailData: {
            name:          userData.name || 'Freelancer',
            amount:        usd(amtUsd),
            coinAmount:    coinAmt.toFixed(coinAmt < 0.01 ? 8 : 4),
            currency:      currency.toUpperCase(),
            network:       network || '',
            walletAddress: shortWallet(walletAddress.trim()),
            payoutId,
            newBalance:    usd(newBalance),
            date:          new Date().toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            }),
          },
        }),
      }).catch(err => {
        console.error('[create-payout] send-smart-notification failed:', err.message);
      });
    } catch (emailErr) {
      console.error('[create-payout] Notification block error:', emailErr.message);
    }

    /* ────────────────────────────────────────
       STEP 7 — Return success response
    ──────────────────────────────────────── */
    return new Response(JSON.stringify({
      success:           true,
      payoutId,
      batchId:           batchId      || null,
      withdrawalId:      withdrawalId || null,
      nowStatus:         nowStatus    || null,
      newBalance,
      // Lets the frontend crypto card update immediately after a successful
      // crypto withdrawal (no full reload needed).
      newCryptoBalance,
      debitedCurrency:   'USD',
      message:           `Withdrawal of ${usd(amtUsd)} initiated successfully.`,
    }), {
      status: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (err) {
    console.error('[create-payout] Unhandled error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error. Please try again.' }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  }

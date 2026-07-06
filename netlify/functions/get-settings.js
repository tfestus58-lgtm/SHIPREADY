/**
 * get-settings.js
 * Shared helper — NOT a Netlify function handler.
 * Usage: const { getSettings } = require('./get-settings');
 *        const settings = await getSettings(db);
 */

const DEFAULTS = {
  platformFeePercent:           2.5,
  projectProtectionPercent:     1.0,
  withdrawalFeePercent:         1.5,
  withdrawalFeePercentPro:      0.5,
  earlyPayoutFeePercent:        2.0,
  // Margin applied (a) when converting NGN/UGX/RWF/XOF/TZS to USD at Stripe
  // checkout, and (b) as the max allowed drift on cross-currency Flutterwave
  // payouts before they're held for manual review instead of auto-sent.
  // 0 = no protection against exchange-rate movement. Admin-configurable
  // in admin.html under Fee Configuration → "FX Safety Buffer (%)".
  platformFxBuffer:             0,
  holdingPeriodDays:            7,
  productSaleHoldingDays:       0,
  affiliateHoldingDays:         0,
  invoiceDeliverByHours:        48,
  minWithdrawalUsd:             10,
  affiliateWithdrawFeePercent:  2.0,
  minAffiliateWithdrawalUsd:    5,
  boostPrice24h:             5,
  boostPrice3d:              12,
  boostPrice7d:              25,
  proMonthlyPrice:           9.99,
  proAnnualPrice:            99.00,
  referralCreditAmount:      2,
  referralProgramEnabled:    false,
  stripeEnabled:             false,
  flutterwaveEnabled:        false,
  // Which currency your Flutterwave wallet is actually funded/topped-up in.
  // create-bank-payout.js debits THIS wallet to fund every Flutterwave
  // payout (regardless of which balance bucket the freelancer withdraws
  // from) and lets Flutterwave convert natively to the destination
  // currency. Change this if you start keeping balance in a different
  // currency on Flutterwave.
  flutterwaveSettlementCurrency: 'NGN',
  cryptoEnabled:             true,
  platformCurrency:          'USD',
  maxProductPriceUsd:        1800,
  twitterUrl:                '',
  linkedinUrl:               '',
  instagramUrl:              '',
  supportEmail:              'support@kreddlo.com',
  privacyEmail:              'privacy@kreddlo.com',
  legalEmail:                'legal@kreddlo.com',
  // Kreddlo Credits — bundle pricing (purchase-credits.js reads these as the
  // source of truth; the client-side price shown on credits.html is display
  // only). Admin-configurable in admin.html under "Kreddlo Credits".
  creditBundleStarterCredits: 50,
  creditBundleStarterPrice:   4.99,
  creditBundleProCredits:     150,
  creditBundleProPrice:       9.99,
  creditBundlePowerCredits:   500,
  creditBundlePowerPrice:     24.99,
  // Kreddlo Credits — monthly free credit grant. When enabled, each
  // freelancer is granted this many bonus credits once per calendar month
  // (added to purchasedCredits, so they never expire). Granted lazily at
  // the same point-of-use as the daily reset, inside submit-pitch.js.
  monthlyFreeCreditEnabled:   false,
  monthlyFreeCreditAmount:    0,
};

/**
 * Fetches platform settings from Firestore config/platform.
 * Always returns a complete settings object — falls back to defaults
 * if the document is missing or the read fails.
 *
 * @param {FirebaseFirestore.Firestore} db  Initialized Firestore instance
 * @returns {Promise<typeof DEFAULTS>}
 */
async function getSettings(db) {
  try {
    const snap = await db.collection('config').doc('platform').get();

    if (!snap.exists) {
      return { ...DEFAULTS };
    }

    // Merge: Firestore values win; any missing field falls back to its default
    return { ...DEFAULTS, ...snap.data() };
  } catch (err) {
    console.error('[get-settings] Firestore read failed, using defaults:', err.message);
    return { ...DEFAULTS };
  }
}

export { getSettings };

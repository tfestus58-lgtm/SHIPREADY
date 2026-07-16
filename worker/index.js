/**
 * Worker entry point for Kreddlo.
 *
 * This project is a Cloudflare Workers project (NOT Cloudflare Pages).
 * There is no automatic file-based routing here — this single script
 * is the one entry point for every request, and it manually dispatches
 * to the correct handler module based on the request path.
 *
 * Each handler module below is UNCHANGED from its original form —
 * every file still exports `export default { async fetch(request, env, ctx) {...} }`
 * (and, for five of them, also `scheduled(event, env, ctx)` for cron jobs).
 * This router simply imports each one and calls .fetch() / .scheduled()
 * on it — no handler file's internal logic was modified to build this.
 *
 * Routing rules, in order:
 *   1. /.netlify/functions/<name>  — the default path convention the
 *      frontend (assets/shared.js) already calls everywhere.
 *   2. Short public webhook aliases (/stripe-webhook, /flutterwave-webhook,
 *      /nowpayments-webhook, /photonpay-webhook) — these are the exact
 *      public URLs configured with Stripe/Flutterwave/NOWPayments/PhotonPay,
 *      ported over from netlify.toml's [[redirects]] entries.
 *   3. /p, /store, /profile — when the request is from a known social
 *      media crawler (Facebook, Twitter/X, WhatsApp, LinkedIn, Telegram,
 *      Discord, Slack, etc.), forward to og-meta for server-rendered
 *      OG/Twitter Card tags. Real visitors fall through to the static
 *      HTML page as normal. (Ported from functions/_middleware.js, which
 *      was written for Cloudflare Pages Functions and does not run in a
 *      plain Workers project.)
 *   3b. /p/<slug>, /store/<slug> — same crawler-interception behavior as
 *      step 3, plus a rewrite to /p.html?slug=<slug> / 
 *      /store.html?storeSlug=<slug> for real visitors (ported from
 *      netlify.toml's /p/:slug and /store/:slug redirects — these are
 *      the pretty share-link URLs shown to sellers in
 *      dashboard-products.html's product-link preview).
 *   4. Otherwise, serve static assets. If the exact path doesn't match a
 *      file, try appending ".html" (replicates netlify.toml's ~40 clean-URL
 *      redirects, e.g. /dashboard -> /dashboard.html, generically instead
 *      of hardcoding each one).
 *   5. If nothing matches, fall through to the configured 404 handling.
 *
 * Scheduled (cron) jobs:
 *   Cloudflare Workers Cron Triggers call the scheduled() handler below,
 *   which dispatches to the right job(s) based on which cron pattern fired
 *   (patterns and their originally-intended jobs are taken directly from
 *   netlify.toml's [functions."<name>"] schedule = "..." entries).
 */

import acceptPitch from '../functions/netlify/functions/accept-pitch.js';
import affiliateWithdraw from '../functions/netlify/functions/affiliate-withdraw.js';
import approveDelivery from '../functions/netlify/functions/approve-delivery.js';
import backfillAffiliateTotals from '../functions/netlify/functions/backfill-affiliate-totals.js';
import backfillDeactivateOrphanedAffiliateLinks from '../functions/netlify/functions/backfill-deactivate-orphaned-affiliate-links.js';
import backfillPublicProfiles from '../functions/netlify/functions/backfill-public-profiles.js';
import backfillSellerTotals from '../functions/netlify/functions/backfill-seller-totals.js';
import cancelSubscription from '../functions/netlify/functions/cancel-subscription.js';
import cleanupAffiliateLinks from '../functions/netlify/functions/cleanup-affiliate-links.js';
import cloudinaryDelete from '../functions/netlify/functions/cloudinary-delete.js';
import confirmInvoiceDelivery from '../functions/netlify/functions/confirm-invoice-delivery.js';
import createBankPayout from '../functions/netlify/functions/create-bank-payout.js';
import createCryptoPayment from '../functions/netlify/functions/create-crypto-payment.js';
import createFlutterwavePayment from '../functions/netlify/functions/create-flutterwave-payment.js';
import createFlutterwaveSubscription from '../functions/netlify/functions/create-flutterwave-subscription.js';
import createInvoiceOrder from '../functions/netlify/functions/create-invoice-order.js';
import createPayout from '../functions/netlify/functions/create-payout.js';
import createProductOrder from '../functions/netlify/functions/create-product-order.js';
import createProject from '../functions/netlify/functions/create-project.js';
import createStripePayment from '../functions/netlify/functions/create-stripe-payment.js';
import createStripeSubscription from '../functions/netlify/functions/create-stripe-subscription.js';
import createSubscription from '../functions/netlify/functions/create-subscription.js';
import declineContract from '../functions/netlify/functions/decline-contract.js';
import deliverProduct from '../functions/netlify/functions/deliver-product.js';
import downloadContract from '../functions/netlify/functions/download-contract.js';
import flutterwaveWebhook from '../functions/netlify/functions/flutterwave-webhook.js';
import generateContractPdf from '../functions/netlify/functions/generate-contract-pdf.js';
import getBankList from '../functions/netlify/functions/get-bank-list.js';
import getBrief from '../functions/netlify/functions/get-brief.js';
import getBriefs from '../functions/netlify/functions/get-briefs.js';
import getCredits from '../functions/netlify/functions/get-credits.js';
import getGuestPurchases from '../functions/netlify/functions/get-guest-purchases.js';
import getPitches from '../functions/netlify/functions/get-pitches.js';
import kycApprove from '../functions/netlify/functions/kyc-approve.js';
import kycSubmit from '../functions/netlify/functions/kyc-submit.js';
import nowpaymentsPayoutWebhook from '../functions/netlify/functions/nowpayments-payout-webhook.js';
import nowpaymentsWebhook from '../functions/netlify/functions/nowpayments-webhook.js';
import ogMeta from '../functions/netlify/functions/og-meta.js';
import photonpayWebhook from '../functions/netlify/functions/photonpay-webhook.js';
import pixelEvent from '../functions/netlify/functions/pixel-event.js';
import postBrief from '../functions/netlify/functions/post-brief.js';
import processEmailQueue from '../functions/netlify/functions/process-email-queue.js';
import processReferralCredit from '../functions/netlify/functions/process-referral-credit.js';
import proposeChanges from '../functions/netlify/functions/propose-changes.js';
import purchaseCredits from '../functions/netlify/functions/purchase-credits.js';
import raiseDispute from '../functions/netlify/functions/raise-dispute.js';
import reconcileStuckPayouts from '../functions/netlify/functions/reconcile-stuck-payouts.js';
import removebgProcess from '../functions/netlify/functions/removebg-process.js';
import resolveBankAccount from '../functions/netlify/functions/resolve-bank-account.js';
import resolveDispute from '../functions/netlify/functions/resolve-dispute.js';
import scheduledClearEarnings from '../functions/netlify/functions/scheduled-clear-earnings.js';
import scheduledClearRateLimits from '../functions/netlify/functions/scheduled-clear-rate-limits.js';
import scheduledSubscriptions from '../functions/netlify/functions/scheduled-subscriptions.js';
import sendEmail from '../functions/netlify/functions/send-email.js';
import sendPasswordReset from '../functions/netlify/functions/send-password-reset.js';
import sendProjectMessage from '../functions/netlify/functions/send-project-message.js';
import sendPushNotification from '../functions/netlify/functions/send-push-notification.js';
import sendSmartNotification from '../functions/netlify/functions/send-smart-notification.js';
import sendVerificationEmail from '../functions/netlify/functions/send-verification-email.js';
import sendWithdrawalOtp from '../functions/netlify/functions/send-withdrawal-otp.js';
import shortlistPitch from '../functions/netlify/functions/shortlist-pitch.js';
import signContract from '../functions/netlify/functions/sign-contract.js';
import signDeliveryUpload from '../functions/netlify/functions/sign-delivery-upload.js';
import stripeWebhook from '../functions/netlify/functions/stripe-webhook.js';
import submitDelivery from '../functions/netlify/functions/submit-delivery.js';
import submitInvoiceDelivery from '../functions/netlify/functions/submit-invoice-delivery.js';
import submitPitch from '../functions/netlify/functions/submit-pitch.js';
import submitReview from '../functions/netlify/functions/submit-review.js';
import trackAffiliateLink from '../functions/netlify/functions/track-affiliate-link.js';
import uploadImage from '../functions/netlify/functions/upload-image.js';
import verifyEmailCode from '../functions/netlify/functions/verify-email-code.js';
import verifyWithdrawalOtp from '../functions/netlify/functions/verify-withdrawal-otp.js';

const routes = {
  'accept-pitch': acceptPitch,
  'affiliate-withdraw': affiliateWithdraw,
  'approve-delivery': approveDelivery,
  'backfill-affiliate-totals': backfillAffiliateTotals,
  'backfill-deactivate-orphaned-affiliate-links': backfillDeactivateOrphanedAffiliateLinks,
  'backfill-public-profiles': backfillPublicProfiles,
  'backfill-seller-totals': backfillSellerTotals,
  'cancel-subscription': cancelSubscription,
  'cleanup-affiliate-links': cleanupAffiliateLinks,
  'cloudinary-delete': cloudinaryDelete,
  'confirm-invoice-delivery': confirmInvoiceDelivery,
  'create-bank-payout': createBankPayout,
  'create-crypto-payment': createCryptoPayment,
  'create-flutterwave-payment': createFlutterwavePayment,
  'create-flutterwave-subscription': createFlutterwaveSubscription,
  'create-invoice-order': createInvoiceOrder,
  'create-payout': createPayout,
  'create-product-order': createProductOrder,
  'create-project': createProject,
  'create-stripe-payment': createStripePayment,
  'create-stripe-subscription': createStripeSubscription,
  'create-subscription': createSubscription,
  'decline-contract': declineContract,
  'deliver-product': deliverProduct,
  'download-contract': downloadContract,
  'flutterwave-webhook': flutterwaveWebhook,
  'generate-contract-pdf': generateContractPdf,
  'get-bank-list': getBankList,
  'get-brief': getBrief,
  'get-briefs': getBriefs,
  'get-credits': getCredits,
  'get-guest-purchases': getGuestPurchases,
  'get-pitches': getPitches,
  'kyc-approve': kycApprove,
  'kyc-submit': kycSubmit,
  'nowpayments-payout-webhook': nowpaymentsPayoutWebhook,
  'nowpayments-webhook': nowpaymentsWebhook,
  'og-meta': ogMeta,
  'photonpay-webhook': photonpayWebhook,
  'pixel-event': pixelEvent,
  'post-brief': postBrief,
  'process-email-queue': processEmailQueue,
  'process-referral-credit': processReferralCredit,
  'propose-changes': proposeChanges,
  'purchase-credits': purchaseCredits,
  'raise-dispute': raiseDispute,
  'reconcile-stuck-payouts': reconcileStuckPayouts,
  'removebg-process': removebgProcess,
  'resolve-bank-account': resolveBankAccount,
  'resolve-dispute': resolveDispute,
  'scheduled-clear-earnings': scheduledClearEarnings,
  'scheduled-clear-rate-limits': scheduledClearRateLimits,
  'scheduled-subscriptions': scheduledSubscriptions,
  'send-email': sendEmail,
  'send-password-reset': sendPasswordReset,
  'send-project-message': sendProjectMessage,
  'send-push-notification': sendPushNotification,
  'send-smart-notification': sendSmartNotification,
  'send-verification-email': sendVerificationEmail,
  'send-withdrawal-otp': sendWithdrawalOtp,
  'shortlist-pitch': shortlistPitch,
  'sign-contract': signContract,
  'sign-delivery-upload': signDeliveryUpload,
  'stripe-webhook': stripeWebhook,
  'submit-delivery': submitDelivery,
  'submit-invoice-delivery': submitInvoiceDelivery,
  'submit-pitch': submitPitch,
  'submit-review': submitReview,
  'track-affiliate-link': trackAffiliateLink,
  'upload-image': uploadImage,
  'verify-email-code': verifyEmailCode,
  'verify-withdrawal-otp': verifyWithdrawalOtp,
};

const WEBHOOK_ALIASES = {
  '/stripe-webhook': 'stripe-webhook',
  '/flutterwave-webhook': 'flutterwave-webhook',
  '/nowpayments-webhook': 'nowpayments-webhook',
  '/photonpay-webhook': 'photonpay-webhook',
};

const OG_ROUTES = new Set(['/p', '/store', '/profile']);

const CRAWLER_UA_PATTERN = /facebookexternalhit|Twitterbot|WhatsApp|LinkedInBot|TelegramBot|Slackbot|Discordbot|vkShare|W3C_Validator|ia_archiver/i;

const SCHEDULED_JOBS = [
  { name: 'scheduled-subscriptions', cron: '0 */6 * * *' },
  { name: 'scheduled-clear-earnings', cron: '0 * * * *' },
  { name: 'scheduled-clear-rate-limits', cron: '0 * * * *' },
  { name: 'process-email-queue', cron: '*/5 * * * *' },
  { name: 'reconcile-stuck-payouts', cron: '*/20 * * * *' },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    /* ── 1. /.netlify/functions/<name> ── */
    const fnMatch = p.match(/^\/\.netlify\/functions\/([a-zA-Z0-9_-]+)\/?$/);
    if (fnMatch && routes[fnMatch[1]]) {
      return routes[fnMatch[1]].fetch(request, env, ctx);
    }

    /* ── 2. Short public webhook aliases ── */
    const aliasTarget = WEBHOOK_ALIASES[p];
    if (aliasTarget && routes[aliasTarget]) {
      return routes[aliasTarget].fetch(request, env, ctx);
    }

    /* ── 3. Social-crawler OG interception for /p, /store, /profile ── */
    if (OG_ROUTES.has(p)) {
      const ua = request.headers.get('user-agent') || '';
      if (CRAWLER_UA_PATTERN.test(ua) && routes['og-meta']) {
        const ogUrl = new URL('/.netlify/functions/og-meta', url.origin);
        url.searchParams.forEach((v, k) => ogUrl.searchParams.set(k, v));
        if (p === '/p') ogUrl.searchParams.set('type', 'product');
        if (p === '/store') ogUrl.searchParams.set('type', 'store');
        if (p === '/profile') ogUrl.searchParams.set('type', 'profile');
        const ogRequest = new Request(ogUrl.toString(), request);
        return routes['og-meta'].fetch(ogRequest, env, ctx);
      }
      /* real visitor — fall through to static asset serving below */
    }

    /* ── 3b. Path-style clean URLs with a dynamic slug segment ──
       Ported from netlify.toml's /p/:slug and /store/:slug redirects
       ("ISSUE 4 FIX" in the original Netlify config). These are the
       pretty share-link URLs shown to sellers as their product's
       shareable link (see dashboard-products.html's linkPreview) and
       used for social-media OG previews of shared product/store links.
       Without this block, /p/<slug> and /store/<slug> 404 — the
       .html-append fallback in step 4 below only handles the SAME path
       gaining an extension, not a path segment being rewritten into a
       query parameter, so this dynamic-segment case needs its own rule. */
    const productSlugMatch = p.match(/^\/p\/([a-zA-Z0-9-]+)\/?$/);
    const storeSlugMatch   = p.match(/^\/store\/([a-zA-Z0-9-]+)\/?$/);

    if (productSlugMatch || storeSlugMatch) {
      const slug = decodeURIComponent((productSlugMatch || storeSlugMatch)[1]);
      const ua   = request.headers.get('user-agent') || '';

      if (CRAWLER_UA_PATTERN.test(ua) && routes['og-meta']) {
        const ogUrl = new URL('/.netlify/functions/og-meta', url.origin);
        ogUrl.searchParams.set('type', productSlugMatch ? 'product' : 'store');
        ogUrl.searchParams.set('slug', slug);
        const ogRequest = new Request(ogUrl.toString(), request);
        return routes['og-meta'].fetch(ogRequest, env, ctx);
      }

      // Real visitor — rewrite to the static .html page with the slug as a
      // query param, matching p.html's `?slug=` / store.html's `?storeSlug=`
      // readers exactly (see the URLSearchParams reads in each file).
      const targetPath = productSlugMatch ? '/p.html' : '/store.html';
      const paramName  = productSlugMatch ? 'slug' : 'storeSlug';
      const targetUrl  = new URL(targetPath, url.origin);
      targetUrl.searchParams.set(paramName, slug);
      const targetRequest = new Request(targetUrl.toString(), request);
      return env.ASSETS.fetch(targetRequest);
    }

    /* ── 4. Static assets, with clean-URL (.html) fallback ── */
    let assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;

    if (!p.includes('.') && !p.endsWith('/')) {
      const htmlUrl = new URL(p + '.html', url.origin);
      const htmlRequest = new Request(htmlUrl.toString(), request);
      const htmlResponse = await env.ASSETS.fetch(htmlRequest);
      if (htmlResponse.status !== 404) return htmlResponse;
    }

    /* ── 5. Nothing matched ── */
    return assetResponse;
  },

  async scheduled(event, env, ctx) {
    const matches = SCHEDULED_JOBS.filter(job => job.cron === event.cron);
    const tasks = matches
      .filter(job => routes[job.name] && typeof routes[job.name].scheduled === 'function')
      .map(job => routes[job.name].scheduled(event, env, ctx));
    ctx.waitUntil(Promise.all(tasks));
  },
};

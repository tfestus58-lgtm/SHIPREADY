/**
 * photonpay-webhook.js — INTENTIONAL PLACEHOLDER
 *
 * PhotonPay integration is not yet implemented. This stub is kept so
 * the file is not mistaken for a forgotten implementation.
 *
 * When PhotonPay is wired up, replace this with real signature
 * verification and Firestore update logic, following the same pattern
 * as nowpayments-webhook.js.
 *
 * Do NOT add this URL to any payment provider's webhook dashboard
 * until the real implementation is in place.
 */
export async function onRequest(context) {
  const { request, env, ctx } = context;
    return new Response(JSON.stringify({ message: 'PhotonPay webhook not yet implemented.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

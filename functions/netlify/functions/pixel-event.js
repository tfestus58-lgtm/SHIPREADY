/**
 * Netlify Function: pixel-event.js
 * Path: netlify/functions/pixel-event.js
 *
 * Fires a Facebook Conversions API (CAPI) Purchase event.
 * Pixel failures NEVER interrupt the payment flow — this always returns 200.
 *
 * Expected POST body (JSON):
 *   {
 *     pixelId:   string  — Facebook Pixel ID
 *     eventName: string  — e.g. 'Purchase'
 *     value:     number  — purchase value in USD
 *     currency:  string  — e.g. 'USD'
 *     email:     string  — buyer email (hashed with SHA-256 before sending)
 *     orderId:   string  — used as event_id for deduplication
 *   }
 *
 * Always returns 200 — failures are logged server-side only.
 *
 * Environment variables required:
 *   FACEBOOK_ACCESS_TOKEN — Meta Conversions API access token (optional)
 *                           If not set, function exits silently with 200.
 */

// Cloudflare Workers exposes the Web Crypto API as a global `crypto` object
// (crypto.subtle.digest, crypto.getRandomValues) — no import needed.

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export default {
  async fetch(request, env, ctx) {
  const rawText = await request.text();

  /* ── Always 200 on non-POST (pixel should never block anything) ── */
  if (request.method !== 'POST') {
    return respond(200, { ok: true });
  }

  /* ── If no access token configured, exit silently ── */
  const accessToken = env.FACEBOOK_ACCESS_TOKEN;
  if (!accessToken) {
    return respond(200, { ok: true, skipped: true });
  }

  /* ── Parse body (fail silently) ── */
  let body;
  try {
    body = JSON.parse(rawText || '{}');
  } catch {
    return respond(200, { ok: true });
  }

  const {
    pixelId   = '',
    eventName = 'Purchase',
    value     = 0,
    currency  = 'USD',
    email     = '',
    orderId   = '',
  } = body;

  if (!pixelId) {
    return respond(200, { ok: true });
  }

  /* ── Hash the email with SHA-256 (Meta CAPI requirement) ── */
  let hashedEmail;
  if (email) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
    hashedEmail = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ── Build the CAPI payload ── */
  const capiPayload = {
    data: [
      {
        event_name:  eventName,
        event_time:  Math.floor(Date.now() / 1000),
        event_id:    orderId || undefined,          // deduplication against browser pixel
        action_source: 'website',
        user_data: {
          ...(hashedEmail ? { em: hashedEmail } : {}),
        },
        custom_data: {
          value:    Number(value) || 0,
          currency: (currency || 'USD').toUpperCase(),
        },
      },
    ],
  };

  /* ── Call Facebook Conversions API ── */
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(capiPayload),
    });

    const data = await res.json();

    if (!res.ok) {
      /* Log server-side but never fail the caller */
      console.error('[pixel-event] Facebook CAPI error:', data);
    } else {
      console.log(`[pixel-event] Fired ${eventName} — orderId: ${orderId}, pixelId: ${pixelId}`);
    }
  } catch (err) {
    /* Network error — log and swallow */
    console.error('[pixel-event] Network error calling Facebook CAPI:', err.message);
  }

  /* ── Always return 200 — pixel failures must never interrupt payment flow ── */
  return respond(200, { ok: true });
  }
};

function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

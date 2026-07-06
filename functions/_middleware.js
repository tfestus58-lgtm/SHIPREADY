// Intercepts /p, /store, /profile requests that carry OG query params
// and forwards them to the og-meta function for social crawler handling.
// Human visitors with JS pass through to the static HTML pages normally.
//
// NOTE ON FILENAME: Cloudflare Pages Functions only invokes middleware from
// a file literally named `_middleware.js` placed in `functions/` (applying
// to every route) or in a `functions/<path>/_middleware.js` subfolder
// (applying only under that path). A file named anything else — e.g.
// `og-route.js` — is treated as a normal function bound to that exact route
// name (`/og-route`) and would never run for requests to /p, /store, or
// /profile. This file is therefore named `_middleware.js` so the
// interception below actually executes.
//
// NOTE ON SCOPE: a path guard is added below so this middleware only ever
// changes behavior for the three OG-preview routes (/p, /store, /profile).
// Without it, this file — being global middleware — would run on every
// single request site-wide, and a crawler visiting any other page (e.g.
// /pricing, /how-it-works, /admin) would incorrectly get redirected into
// og-meta's generic fallback page instead of seeing that page's real
// content, breaking link previews across the rest of the site.

const OG_ROUTES = new Set(['/p', '/store', '/profile']);

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Only ever touch the three OG-preview routes — every other request
  // passes straight through untouched.
  if (!OG_ROUTES.has(url.pathname)) {
    return context.next();
  }

  const ua = context.request.headers.get('user-agent') || '';

  // Only intercept known social crawler user-agents
  const isCrawler = /facebookexternalhit|Twitterbot|WhatsApp|LinkedInBot|TelegramBot|Slackbot|Discordbot|vkShare|W3C_Validator|ia_archiver/i.test(ua);

  if (!isCrawler) {
    // Real user — pass through to static HTML
    return context.next();
  }

  // Forward to og-meta function with the same query params
  const ogUrl = new URL('/.netlify/functions/og-meta', url.origin);
  url.searchParams.forEach((v, k) => ogUrl.searchParams.set(k, v));

  // Set type based on path
  if (url.pathname === '/p') ogUrl.searchParams.set('type', 'product');
  if (url.pathname === '/store') ogUrl.searchParams.set('type', 'store');
  if (url.pathname === '/profile') ogUrl.searchParams.set('type', 'profile');

  return fetch(ogUrl.toString(), { headers: context.request.headers });
}

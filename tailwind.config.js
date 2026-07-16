/**
 * Unified Tailwind config — replaces the 7 slightly different inline
 * `tailwind.config = {...}` blocks that were previously duplicated across
 * 35 pages (each loaded via the CDN <script> tag). This is a superset of
 * every color, radius, and font token found across all of them — nothing
 * removed, nothing renamed, so no page loses a class it was relying on.
 * Unused tokens cost nothing in the compiled output; Tailwind only ever
 * generates CSS for classes it finds actually referenced in `content`.
 */
module.exports = {
  content: [
    './*.html',
  ],
  safelist: [
    // Class names that may only ever appear inside a JS template string
    // (built at runtime rather than sitting in static HTML) are still
    // caught by Tailwind's plain-text content scan as long as the literal
    // token appears somewhere in a scanned file — same mechanism the CDN
    // JIT compiler already relied on. This safelist is an extra safety net
    // for any classes only ever added/removed via classList.add/remove
    // with a literal string Tailwind's scanner might not tokenize on its own.
    'overflow-x-hidden',
  ],
  theme: {
    extend: {
      colors: {
        navy:          '#0d2145',
        'navy-deep':   '#091830',
        'navy-mid':    '#162f5e',
        green:         '#2d8a5e',
        'green-light': '#3dbd7a',
        'green-pale':  '#e8f5ef',
        cream:         '#f8f9fb',
        border:        '#e2e8f0',
        error:         '#c81e1e',
        'error-pale':  '#fde8e8',
        warning:       '#856404',
        'warning-pale':'#fff3cd',
        info:          '#1a56db',
        'info-pale':   '#e8f0fe',
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'sans-serif'],
      },
      borderRadius: {
        pill:  '50px',
        card:  '20px',
        btn:   '50px',
        input: '12px',
        badge: '50px',
        modal: '24px',
      },
      // The CDN Play CDN build generates ANY opacity modifier (e.g.
      // bg-navy/2, text-navy/58) on demand. The standard Tailwind CLI only
      // ships multiples of 5 by default (5, 10, 15 ... 100), which silently
      // drops classes like /2 or /58 that this codebase actually uses
      // (about.html, how-it-works.html, pricing.html). Extending to every
      // integer 0-100 makes the compiled build match the CDN's behavior
      // exactly, so no opacity-modifier class is ever missing.
      opacity: Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [String(i), (i / 100).toString()])
      ),
    },
  },
  plugins: [],
};

/**
 * Netlify Function: backfill-affiliate-totals.js
 * Path: netlify/functions/backfill-affiliate-totals.js
 *
 * ONE-TIME ADMIN SCRIPT — not scheduled, not linked from any UI.
 *
 * Reconstructs `affiliateTotalEarnedByCurrency` on each affiliate's user doc
 * from their historical `affiliate-earnings` records (each of which already
 * stores its own `currency` and `commissionAmount` — nothing is guessed or
 * approximated). This closes the only remaining gap in the affiliate
 * currency fix: commissions credited *before* the webhooks started writing
 * affiliateTotalEarnedByCurrency still only had the old blended
 * `affiliateTotalEarned` number, so dashboard.html would fall back to
 * showing that raw figure labeled USD for those accounts. After this runs
 * once, every affiliate has an accurate per-currency lifetime total and
 * dashboard.html never needs the legacy fallback again.
 *
 * SAFE TO RUN MORE THAN ONCE: each affiliate-earnings doc is processed
 * inside a transaction that re-reads the doc and skips it if it has already
 * been marked `backfilled: true` — the same re-check-then-skip pattern
 * scheduled-clear-earnings.js already uses to survive overlapping/duplicate
 * runs. No existing field (affiliateBalance, affiliateBalances,
 * affiliateTotalEarned) is ever touched — this only ever adds to
 * affiliateTotalEarnedByCurrency.
 *
 * PAGINATED — processes up to `limit` affiliate-earnings docs per call
 * (default 300) and returns a `nextCursor` + `hasMore` flag. Call it
 * repeatedly (same secret, passing the returned cursor) until
 * `hasMore: false`. This keeps each invocation well under Netlify's
 * function timeout regardless of how many historical records exist.
 *
 * USAGE (run from your own machine, never from the browser):
 *   curl -X POST "https://kreddlo.space/.netlify/functions/backfill-affiliate-totals" \
 *        -H "x-internal-secret: $INTERNAL_FUNCTION_SECRET"
 *   # repeat with the returned cursor until hasMore is false:
 *   curl -X POST "https://kreddlo.space/.netlify/functions/backfill-affiliate-totals?cursor=<nextCursor>" \
 *        -H "x-internal-secret: $INTERNAL_FUNCTION_SECRET"
 *
 * Environment variables required (already set for the other functions):
 *   FIREBASE_SERVICE_ACCOUNT
 *   INTERNAL_FUNCTION_SECRET
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

/* ── Firebase Admin — lazy singleton ── */
let _db = null;

function getDb() {
  if (_db) return _db;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  _db = getFirestore();
  return _db;
}

const DEFAULT_LIMIT = 300;

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  // Admin-only, secret-gated — same server-to-server check used throughout
  // this codebase (e.g. scheduled-clear-earnings.js). No schedule bypass
  // here on purpose: this must only ever run when someone deliberately
  // triggers it with the secret.
  const incomingSecret = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'] || '';
  const expectedSecret  = process.env.INTERNAL_FUNCTION_SECRET || '';
  if (!expectedSecret || incomingSecret !== expectedSecret) {
    return respond(401, { error: 'Unauthorized.' });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const params = event.queryStringParameters || {};
  const limit  = Math.min(Math.max(parseInt(params.limit, 10) || DEFAULT_LIMIT, 1), 500);
  const cursor = params.cursor || null;

  const results = {
    processed:      0,
    skippedAlready: 0,
    failed:         0,
    nextCursor:     null,
    hasMore:        false,
  };

  try {
    // Ordered by document ID for a stable, gap-free cursor across calls —
    // createdAt is not guaranteed unique/indexed the same way, and we just
    // need a consistent walk through the whole collection once.
    let q = db.collection('affiliate-earnings').orderBy('__name__').limit(limit);
    if (cursor) {
      const cursorSnap = await db.collection('affiliate-earnings').doc(cursor).get();
      if (cursorSnap.exists) q = q.startAfter(cursorSnap);
    }

    const snap = await q.get();

    if (snap.empty) {
      console.log('backfill-affiliate-totals: no more affiliate-earnings records to process.');
      return respond(200, results);
    }

    for (const docSnap of snap.docs) {
      try {
        await db.runTransaction(async (tx) => {
          // Re-read fresh inside the transaction so a second overlapping/
          // repeated call sees backfilled: true and skips — closing the
          // race exactly as scheduled-clear-earnings.js already does.
          const freshSnap = await tx.get(docSnap.ref);
          if (!freshSnap.exists) return; // deleted between query and tx — skip

          const earning = freshSnap.data();
          if (earning.backfilled === true) {
            results.skippedAlready++;
            return;
          }

          const affiliateUid = earning.affiliateUid;
          const currency      = (earning.currency || 'USD').toUpperCase();
          const amount        = Number(earning.commissionAmount) || 0;

          if (affiliateUid && amount > 0) {
            const userRef = db.collection('users').doc(affiliateUid);
            tx.update(userRef, {
              [`affiliateTotalEarnedByCurrency.${currency}`]: FieldValue.increment(amount),
            });
          }

          tx.update(docSnap.ref, {
            backfilled:   true,
            backfilledAt: FieldValue.serverTimestamp(),
          });

          results.processed++;
        });
      } catch (err) {
        console.error(`backfill-affiliate-totals: failed on affiliate-earnings/${docSnap.id}:`, err.message);
        results.failed++;
      }
    }

    results.nextCursor = snap.docs[snap.docs.length - 1].id;
    results.hasMore     = snap.docs.length === limit;

    console.log('backfill-affiliate-totals: batch complete —', JSON.stringify(results));
    return respond(200, results);

  } catch (err) {
    console.error('backfill-affiliate-totals: query failed:', err.message);
    return respond(500, { error: 'Query failed.', detail: err.message });
  }
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

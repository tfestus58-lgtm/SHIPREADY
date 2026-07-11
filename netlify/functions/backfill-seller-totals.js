/**
 * Netlify Function: backfill-seller-totals.js
 * Path: netlify/functions/backfill-seller-totals.js
 *
 * ONE-TIME ADMIN SCRIPT — not scheduled, not linked from any UI.
 *
 * Companion to backfill-affiliate-totals.js, but for the seller-facing
 * "Total Earnings" figure instead of affiliate commissions.
 *
 * Every write site that credits a seller (deliver-product.js,
 * approve-delivery.js, confirm-invoice-delivery.js, resolve-dispute.js,
 * scheduled-clear-earnings.js) increments `totalEarned` (legacy, blended)
 * and `totalEarnedByCurrency.{currency}` (accurate, per-currency) in the
 * exact same atomic update — so the two have never drifted apart for any
 * earning credited after totalEarnedByCurrency existed in the code.
 *
 * The only possible gap is earnings credited *before* that field existed.
 * Rather than reconstructing that from four different source collections
 * (product-orders, projects, invoices, disputes — each with its own status
 * semantics, refund/dispute adjustments, etc., and more surface area for a
 * subtle double-count or miss), this script uses a simpler and safer fact:
 * because the two fields are always incremented together going forward,
 * the DIFFERENCE between a user's `totalEarned` and the sum of their
 * `totalEarnedByCurrency` map IS exactly their pre-migration amount — no
 * matter which of the four sources it came from. That gap is credited to
 * `totalEarnedByCurrency.USD`, since USD was the platform's only currency
 * before multi-currency support existed.
 *
 * This does not change `totalEarned` at all, and does not touch balances,
 * pendingBalances, or any withdrawal-gating field — purely reconciles the
 * display-only per-currency map so it always sums to the trusted legacy
 * total.
 *
 * SAFE TO RUN MORE THAN ONCE: each user doc is processed inside a
 * transaction that re-reads the doc and skips it if already marked
 * `totalEarnedByCurrencyBackfilled: true` — same pattern as
 * backfill-affiliate-totals.js / scheduled-clear-earnings.js.
 *
 * PAGINATED — processes up to `limit` user docs per call (default 300),
 * returns `nextCursor` + `hasMore`. Call repeatedly until `hasMore: false`.
 *
 * USAGE:
 *   curl -X POST "https://kreddlo.space/.netlify/functions/backfill-seller-totals" \
 *        -H "x-internal-secret: $INTERNAL_FUNCTION_SECRET"
 *   # repeat with the returned cursor until hasMore is false:
 *   curl -X POST "https://kreddlo.space/.netlify/functions/backfill-seller-totals?cursor=<nextCursor>" \
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
const EPSILON        = 0.005; // ignore sub-cent float noise from repeated increments

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  // Admin-only, secret-gated — same server-to-server check used throughout
  // this codebase (e.g. scheduled-clear-earnings.js, backfill-affiliate-totals.js).
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
    scanned:        0,
    reconciled:     0,
    skippedAlready: 0,
    skippedNoGap:   0,
    failed:         0,
    nextCursor:     null,
    hasMore:        false,
  };

  try {
    // Only accounts that have earned something are relevant — cuts out
    // buyers and freelancers with zero sales entirely.
    let q = db.collection('users')
      .where('totalEarned', '>', 0)
      .orderBy('totalEarned')
      .orderBy('__name__')
      .limit(limit);

    if (cursor) {
      const cursorSnap = await db.collection('users').doc(cursor).get();
      if (cursorSnap.exists) {
        const cursorData = cursorSnap.data();
        q = db.collection('users')
          .where('totalEarned', '>', 0)
          .orderBy('totalEarned')
          .orderBy('__name__')
          .startAfter(cursorData.totalEarned, cursorSnap.id)
          .limit(limit);
      }
    }

    const snap = await q.get();

    if (snap.empty) {
      console.log('backfill-seller-totals: no more users with totalEarned > 0 to process.');
      return respond(200, results);
    }

    for (const docSnap of snap.docs) {
      results.scanned++;
      try {
        await db.runTransaction(async (tx) => {
          // Re-read fresh inside the transaction so a repeated/overlapping
          // call sees the flag and skips — same race protection used
          // throughout this codebase's background jobs.
          const freshSnap = await tx.get(docSnap.ref);
          if (!freshSnap.exists) return; // deleted between query and tx — skip

          const user = freshSnap.data();
          if (user.totalEarnedByCurrencyBackfilled === true) {
            results.skippedAlready++;
            return;
          }

          const legacyTotal = Number(user.totalEarned) || 0;
          const currencyMap = user.totalEarnedByCurrency || {};
          const mapSum = Object.keys(currencyMap).reduce(
            (sum, cur) => sum + (Number(currencyMap[cur]) || 0), 0
          );

          const gap = legacyTotal - mapSum;

          if (gap > EPSILON) {
            tx.update(docSnap.ref, {
              'totalEarnedByCurrency.USD':        FieldValue.increment(gap),
              totalEarnedByCurrencyBackfilled:    true,
              totalEarnedByCurrencyBackfilledAt:  FieldValue.serverTimestamp(),
            });
            results.reconciled++;
          } else {
            // Already in sync (or map is ahead of legacy total due to float
            // rounding) — nothing to add, just mark as checked.
            tx.update(docSnap.ref, {
              totalEarnedByCurrencyBackfilled:   true,
              totalEarnedByCurrencyBackfilledAt: FieldValue.serverTimestamp(),
            });
            results.skippedNoGap++;
          }
        });
      } catch (err) {
        console.error(`backfill-seller-totals: failed on users/${docSnap.id}:`, err.message);
        results.failed++;
      }
    }

    const lastDoc = snap.docs[snap.docs.length - 1];
    results.nextCursor = lastDoc.id;
    results.hasMore     = snap.docs.length === limit;

    console.log('backfill-seller-totals: batch complete —', JSON.stringify(results));
    return respond(200, results);

  } catch (err) {
    console.error('backfill-seller-totals: query failed:', err.message);
    // Most likely cause: missing composite index on users (totalEarned asc, __name__ asc).
    // Firestore's error message includes a direct console link to create it — check
    // the function logs for that link if this happens.
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

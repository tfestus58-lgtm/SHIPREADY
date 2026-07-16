/**
 * Netlify Function: backfill-deactivate-orphaned-affiliate-links.js
 * Path: netlify/functions/backfill-deactivate-orphaned-affiliate-links.js
 *
 * MAINTENANCE SCRIPT — safe to run any time, not just once.
 *
 * cleanup-affiliate-links.js already deactivates affiliate-links docs at
 * the moment a product is deleted (dashboard-products.html) or removed by
 * an admin (admin.html) — see that file for the event-driven fix. But that
 * call is explicitly non-fatal at both call sites: if it fails for any
 * reason (network hiccup, cold start timeout, the request never reaching
 * the server), the product deletion/removal still succeeds and the
 * affiliate-links doc is silently left `active` forever, with no retry.
 * Any product deleted before cleanup-affiliate-links.js existed in the
 * codebase has the same problem — nothing ever went back and deactivated
 * those older links either.
 *
 * This script is the catch-up net for both cases: it scans every
 * affiliate-links doc that isn't already marked inactive, checks whether
 * its target product still exists and is still visible in the
 * marketplace, and deactivates it (same fields cleanup-affiliate-links.js
 * uses) if not. dashboard-affiliate.html already knows how to render an
 * inactive link (greyed out, "Unavailable" instead of a Copy button) —
 * this script just makes sure the `active` flag is actually correct for
 * every doc, including ones the event-driven fix never reached.
 *
 * Product lookups are batched: every affiliate-links doc's productId is
 * collected first (deduplicated), then those product docs are fetched with
 * db.getAll() in chunks of 300, rather than one read per link. A product
 * that no longer exists, or whose status is 'removed_by_admin', is treated
 * as orphaned.
 *
 * IDEMPOTENT: re-running is always safe. Links already `active: false` are
 * skipped outright; a link whose product is fine is left untouched.
 *
 * HOW TO RUN:
 *   Trigger from admin.html's Maintenance tab ("Deactivate Orphaned
 *   Affiliate Links" button), or:
 *   curl -X POST https://kreddlo.space/.netlify/functions/backfill-deactivate-orphaned-affiliate-links \
 *     -H "Content-Type: application/json" \
 *     -H "Authorization: Bearer <firebase-admin-id-token>"
 *
 * RESPONSE:
 *   { processed: number, deactivated: number, skipped: number, errors: [...] }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON (single-line string)
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';
import { verifyCaller }                 from './_verify-auth';

/* ── Firebase Admin — lazy singleton ── */
let _db = null;

function getDb(env) {
  if (_db) return _db;
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  _db = getFirestore();
  return _db;
}

/* Split an array into chunks of a given size */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default {
  async fetch(request, env, ctx) {
  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Auth: ID token + admin role check (same pattern as the other
     admin-triggered maintenance scripts in this codebase) ── */
  let callerUid;
  try { callerUid = await verifyCaller(request, env); }
  catch { callerUid = null; }
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  let db;
  try {
    db = getDb(env);
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  let callerSnap;
  try { callerSnap = await db.collection('users').doc(callerUid).get(); }
  catch { return respond(500, { error: 'Database error.' }); }
  if (!callerSnap.exists || callerSnap.data().role !== 'admin') {
    return respond(403, { error: 'Forbidden.' });
  }

  const result = { processed: 0, deactivated: 0, skipped: 0, errors: [] };

  try {
    /* ── 1. Load every affiliate-links doc that isn't already inactive ── */
    const linksSnap = await db.collection('affiliate-links').get();
    result.processed = linksSnap.size;

    const candidateDocs = linksSnap.docs.filter((d) => d.data().active !== false);
    result.skipped += linksSnap.size - candidateDocs.length; // already inactive

    if (candidateDocs.length === 0) {
      return respond(200, result);
    }

    /* ── 2. Batch-fetch the distinct products these links point to ── */
    const productIds = Array.from(
      new Set(candidateDocs.map((d) => d.data().productId).filter(Boolean))
    );

    const productStatusById = new Map(); // productId -> 'missing' | 'removed' | 'ok'
    const productChunks = chunk(productIds, 300); // db.getAll() practical batch size

    for (const ids of productChunks) {
      try {
        const refs  = ids.map((id) => db.collection('products').doc(id));
        const snaps = await db.getAll(...refs);
        snaps.forEach((snap, i) => {
          if (!snap.exists) {
            productStatusById.set(ids[i], 'missing');
          } else if (snap.data().status === 'removed_by_admin') {
            productStatusById.set(ids[i], 'removed');
          } else {
            productStatusById.set(ids[i], 'ok');
          }
        });
      } catch (err) {
        console.error('[backfill-affiliate-links] product batch read failed:', err.message);
        result.errors.push(`Product batch read failed: ${err.message}`);
        // Leave these productIds unresolved — the links referencing them are
        // skipped below rather than incorrectly deactivated.
      }
    }

    /* ── 3. Deactivate any link whose product is missing or removed ── */
    const toDeactivate = candidateDocs.filter((d) => {
      const status = productStatusById.get(d.data().productId);
      return status === 'missing' || status === 'removed';
    });

    result.skipped += candidateDocs.length - toDeactivate.length;

    const BATCH_SIZE = 450; // Firestore batch write cap is 500
    for (const docsChunk of chunk(toDeactivate, BATCH_SIZE)) {
      const batch = db.batch();
      docsChunk.forEach((docSnap) => {
        batch.update(docSnap.ref, {
          active:            false,
          deactivatedAt:     FieldValue.serverTimestamp(),
          deactivatedReason: 'product_deleted_or_removed_backfill',
        });
      });
      await batch.commit();
      result.deactivated += docsChunk.length;
    }

  } catch (err) {
    console.error('[backfill-affiliate-links] Error:', err);
    result.errors.push(err.message || String(err));
    return respond(500, result);
  }

  console.log(`[backfill-affiliate-links] Done — processed: ${result.processed}, deactivated: ${result.deactivated}, skipped: ${result.skipped}`);
  return respond(200, result);
  }
};

/* ── Utility ── */
function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

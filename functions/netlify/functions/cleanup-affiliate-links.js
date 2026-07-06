/**
 * Netlify Function: cleanup-affiliate-links.js
 * Path: netlify/functions/cleanup-affiliate-links.js
 *
 * Closes the gap where deleting or removing a product left its
 * affiliate-links documents untouched — affiliates kept a live, copyable
 * referral link (and dashboard-affiliate.html kept showing it) for a
 * product that no longer existed or was hidden from the marketplace.
 *
 * Called from two places, both of which already mutate the products/{id}
 * doc and then call this function as a follow-up step:
 *   - dashboard-products.html's confirmDeleteProduct() — after the product
 *     is permanently deleted.
 *   - admin.html's toggleProductRemoval() — after an admin sets
 *     status: 'removed_by_admin' on a product (removal only hides it from
 *     the marketplace; the product doc itself still exists).
 *
 * Action: queries affiliate-links where productId == X and sets
 * active: false on every matching doc (Admin SDK — affiliate-links has
 * `allow write: if false` in firestore.rules, so this can only ever be
 * done server-side). Docs are deactivated rather than deleted so historical
 * click/conversion counts are preserved for reporting; affiliate-earnings
 * records are independently keyed and are never affected either way.
 *
 * Two allowed caller types:
 *   1. Product owner — Firebase ID token (verifyCaller), caller's uid must
 *      match the product's uid. Used by dashboard-products.html.
 *   2. Admin — Firebase ID token (verifyCaller) + users/{uid}.role === 'admin'
 *      check. Used by admin.html's marketplace-removal action.
 *      (Issue 1 fix: previously used shared ADMIN_SECRET; now uses ID token.)
 *
 * Non-fatal by design at the call site: if this function fails, the
 * product delete/removal itself has already succeeded. Callers log failures
 * but do not surface them as the primary error.
 *
 * POST body:
 *   {
 *     productId:   string,            — required
 *     callerType:  'owner' | 'admin', — required
 *   }
 *
 * Authorization header:
 *   Authorization: Bearer <Firebase ID token>   — required for both caller types
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON
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

export default {
  async fetch(request, env, ctx) {
  const rawText = await request.text();
  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawText || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { productId, callerType } = payload;

  if (!productId || typeof productId !== 'string' || productId.trim() === '') {
    return respond(400, { error: 'productId is required.' });
  }
  if (callerType !== 'owner' && callerType !== 'admin') {
    return respond(400, { error: "callerType must be 'owner' or 'admin'." });
  }

  /* ── Auth: ID token required for both caller types (Issue 1 fix) ── */
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

  if (callerType === 'admin') {
    /* Verify caller has admin role in Firestore (replaces shared ADMIN_SECRET) */
    let adminSnap;
    try { adminSnap = await db.collection('users').doc(callerUid).get(); }
    catch { return respond(500, { error: 'Database error.' }); }
    if (!adminSnap.exists || adminSnap.data().role !== 'admin') {
      return respond(403, { error: 'Forbidden.' });
    }
  } else {
    /* owner path: verify caller owns the product */
    let productSnap;
    try {
      productSnap = await db.collection('products').doc(productId.trim()).get();
    } catch (err) {
      console.error('Firestore read failed for product:', err.message);
      return respond(500, { error: 'Database read failed.' });
    }
    // The product may already be gone (this runs after deletion) — that's
    // fine, ownership just can't be re-verified at that point. Only block
    // when the product still exists and clearly belongs to someone else.
    if (productSnap.exists && productSnap.data().uid !== callerUid) {
      return respond(403, { error: 'You do not have permission to modify this product.' });
    }
  }

  /* ── Find and deactivate every affiliate-links doc for this product ── */
  let linksSnap;
  try {
    linksSnap = await db
      .collection('affiliate-links')
      .where('productId', '==', productId.trim())
      .get();
  } catch (err) {
    console.error('Firestore affiliate-links query failed:', err.message);
    return respond(500, { error: 'Query failed.' });
  }

  if (linksSnap.empty) {
    return respond(200, { success: true, deactivated: 0 });
  }

  try {
    const batch = db.batch();
    linksSnap.docs.forEach((doc) => {
      batch.update(doc.ref, {
        active:            false,
        deactivatedAt:     FieldValue.serverTimestamp(),
        deactivatedReason: 'product_deleted_or_removed',
      });
    });
    await batch.commit();
  } catch (err) {
    console.error(`Failed to deactivate affiliate-links for product ${productId}:`, err.message);
    return respond(500, { error: 'Failed to update affiliate links.' });
  }

  console.log(`cleanup-affiliate-links: deactivated ${linksSnap.size} link(s) for product ${productId}.`);
  return respond(200, { success: true, deactivated: linksSnap.size });
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

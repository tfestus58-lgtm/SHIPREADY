/**
 * Netlify Function: submit-review.js
 * Path: netlify/functions/submit-review.js
 *
 * Submits a verified buyer review for a product order or a project.
 * Verifies the reviewer made the purchase before writing to Firestore.
 * Recalculates the seller's average rating after each review.
 *
 * Expected POST body (JSON):
 *   {
 *     sourceType:    'product' | 'project'
 *     sourceId:      string   — orderId (product) or projectId (project)
 *     rating:        number   — 1 to 5
 *     comment:       string   — review text
 *     reviewerEmail: string   — must match the buyer email on the order / project
 *     reviewerName:  string   — display name shown on the review
 *   }
 *
 * Success response (201):
 *   { reviewId: string }
 *
 * Error responses:
 *   400 — Missing / invalid fields
 *   403 — Reviewer did not make this purchase
 *   409 — Review already submitted
 *   500 — Internal server error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { checkRateLimit }               = require('./_rate-limit');
const { sanitizeString, sanitizeEmail } = require('./_sanitize');

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

/* ── Internal function caller ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) return null;

  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[submit-review] callFunction(${functionName}) failed — ${res.status}: ${errText}`);
    }

    return res;
  } catch (err) {
    console.error(`[submit-review] callFunction(${functionName}) network error:`, err.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(event, process.env);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { sourceType, sourceId, rating, comment, reviewerEmail, reviewerName } = body;

  /* ── Validate fields ── */
  if (!['product', 'project'].includes(sourceType)) {
    return respond(400, { error: "sourceType must be 'product' or 'project'." });
  }
  if (!sourceId || typeof sourceId !== 'string') {
    return respond(400, { error: 'sourceId is required.' });
  }
  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    return respond(400, { error: 'rating must be a number between 1 and 5.' });
  }
  if (!comment || typeof comment !== 'string' || comment.trim().length === 0) {
    return respond(400, { error: 'comment is required.' });
  }
  if (!reviewerEmail || !reviewerEmail.includes('@')) {
    return respond(400, { error: 'reviewerEmail must be a valid email address.' });
  }
  if (!reviewerName || typeof reviewerName !== 'string') {
    return respond(400, { error: 'reviewerName is required.' });
  }

  try {
    const db = getDb();

    /* ── Server-side rate limit: 10 review submissions per 60 min per uid ──
       Prevents a user from spamming review submissions on multiple orders
       in a short window, which could flood a seller's profile page or
       trigger excessive Firestore publicProfiles mirror writes. */
    const rl = await checkRateLimit(db, `rev::${callerUid}`, 10, 3600);
    if (!rl.allowed) {
      return respond(429, { error: rl.error, retryAfter: rl.retryAfter });
    }

    /* ── Bind reviewerEmail to the verified caller (FIX) ──
       Previously reviewerEmail was just a request-body field compared
       against the order/project's buyerEmail — verifyCaller authenticated
       *someone*, but never confirmed that someone was the actual buyer.
       Any logged-in user who knew (or could view, e.g. via a shared
       invoice link) another buyer's email could post a review in their
       name. We now require the verified caller's own account email to
       match the claimed reviewerEmail, so a review can only be posted by
       the account that owns that email address. */
    const callerSnap = await db.collection('users').doc(callerUid).get();
    const callerEmail = callerSnap.exists ? (callerSnap.data().email || '').trim().toLowerCase() : '';
    if (!callerEmail || callerEmail !== reviewerEmail.trim().toLowerCase()) {
      return respond(403, { error: 'You can only submit reviews for your own account.' });
    }

    /* ── Verify purchase ── */
    let sourceDoc    = null;
    let targetUid    = null;
    let productTitle = '';

    if (sourceType === 'product') {
      /* Product order verification — match by document ID and buyerEmail */
      const orderSnap = await db.collection('product-orders').doc(sourceId).get();

      if (!orderSnap.exists || orderSnap.data().buyerEmail !== reviewerEmail.trim().toLowerCase()) {
        return respond(403, { error: 'You can only review purchases you made.' });
      }

      sourceDoc    = orderSnap;
      targetUid    = orderSnap.data().sellerUid;

      /* Fetch product title for notification */
      const prodSnap = await db.collection('products').doc(orderSnap.data().productId).get();
      productTitle   = prodSnap.exists ? (prodSnap.data().title || '') : '';

    } else {
      /* Project verification — query by id and buyerEmail */
      const projectSnap = await db.collection('projects').doc(sourceId).get();

      if (!projectSnap.exists || projectSnap.data().buyerEmail !== reviewerEmail.trim().toLowerCase()) {
        return respond(403, { error: 'You can only review purchases you made.' });
      }

      sourceDoc    = projectSnap;
      targetUid    = projectSnap.data().freelancerUid;
      productTitle = projectSnap.data().title || '';
    }

    /* ── Atomic duplicate-guard check + writes ───────────────────
       Issue: the earlier `sourceDoc` read (used above for purchase
       verification) and the `reviewLeft === true` duplicate-review guard
       that used to run off that same stale read were not transaction-
       wrapped — two near-simultaneous submissions for the same order/
       project could both pass the guard before either commits, producing
       two review docs and two seller-rating recalculations for one
       purchase. Wrapping a fresh re-read of reviewLeft plus both writes
       (the new `reviews` doc and the `reviewLeft: true` update) inside a
       single db.runTransaction() closes that window: only one caller
       will see the guard pass inside the transaction; the second throws
       and returns 409 with no write performed. Mirrors the pattern used
       in approve-delivery.js. ── */
    const collection = sourceType === 'product' ? 'product-orders' : 'projects';
    const sourceRef  = db.collection(collection).doc(sourceId);
    const reviewRef  = db.collection('reviews').doc();

    // Sanitize free-text fields before writing to Firestore (rendered in HTML pages)
    const safeComment      = sanitizeString(comment, 1000);
    const safeReviewerName = sanitizeString(reviewerName, 80);

    try {
      await db.runTransaction(async (tx) => {
        // Re-read fresh inside the transaction — the earlier sourceDoc
        // read above is only used for purchase/buyerEmail verification;
        // this read is what actually gates the duplicate-review write.
        const freshSourceSnap = await tx.get(sourceRef);

        if (!freshSourceSnap.exists) {
          const err = new Error('Purchase record not found.');
          err.statusCode = 404;
          throw err;
        }

        if (freshSourceSnap.data().reviewLeft === true) {
          const err = new Error('Review already submitted for this purchase.');
          err.statusCode = 409;
          throw err;
        }

        tx.set(reviewRef, {
          targetUid,
          reviewerEmail:  reviewerEmail.trim().toLowerCase(),
          reviewerName:   safeReviewerName,
          rating:         Number(rating),
          comment:        safeComment,
          sourceType,
          sourceId,
          verified:       true,
          visible:        true,
          createdAt:      FieldValue.serverTimestamp(),
        });

        tx.update(sourceRef, { reviewLeft: true });
      });
    } catch (err) {
      const code = err.statusCode || 500;
      if (code === 409) return respond(409, { error: err.message });
      if (code === 404) return respond(404, { error: err.message });
      console.error('[submit-review] Transaction failed:', err.message);
      return respond(500, { error: 'Failed to submit review.' });
    }

    /* ── Recalculate seller averageRating ── */
    const allReviewsSnap = await db.collection('reviews')
      .where('targetUid', '==', targetUid)
      .get();

    let totalRating = 0;
    allReviewsSnap.forEach(doc => { totalRating += (doc.data().rating || 0); });

    const totalReviews  = allReviewsSnap.size;
    const averageRating = totalReviews > 0
      ? Math.round((totalRating / totalReviews) * 10) / 10
      : 0;

    await db.collection('users').doc(targetUid).update({ averageRating, totalReviews });

    /* Mirror to publicProfiles/{uid} — additive, non-blocking. This is
       what profile.html and browse.html display publicly as the
       freelancer's rating, so it needs to stay in sync with every new
       review without affecting the primary users/{uid} write above. */
    try {
      await db.collection('publicProfiles').doc(targetUid).set(
        { averageRating, totalReviews },
        { merge: true }
      );
    } catch (err) {
      console.warn('publicProfiles rating mirror failed (non-fatal):', err.message);
    }

    /* ── Notify seller of new review (send immediately, check online status) ── */
    const sellerSnap = await db.collection('users').doc(targetUid).get();
    const sellerName = sellerSnap.exists
      ? (sellerSnap.data().displayName || sellerSnap.data().name || 'there')
      : 'there';

    await callFunction('send-smart-notification', {
      userUid:      targetUid,
      title:        `New ${rating}★ review from ${safeReviewerName}`,
      body:         `"${safeComment.substring(0, 100)}${safeComment.length > 100 ? '…' : ''}"`,
      templateId:   'new-review',
      emailMode:    'never',
      delayMinutes: 0,
      emailData: {
        name:         sellerName,
        reviewerName: safeReviewerName,
        productTitle,
        rating:       Number(rating),
        comment:      safeComment,
      },
    });

    console.log(`[submit-review] Review ${reviewRef.id} written — target: ${targetUid}, rating: ${rating}`);

    return respond(201, { reviewId: reviewRef.id });

  } catch (err) {
    console.error('[submit-review] Error:', err);
    return respond(500, { error: err.message || 'Internal server error.' });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

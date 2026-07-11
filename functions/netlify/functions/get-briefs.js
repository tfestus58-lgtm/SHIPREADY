/**
 * Netlify Function: get-briefs.js
 * Path: netlify/functions/get-briefs.js
 *
 * Public listing endpoint for Briefs. Works for logged-out visitors as
 * well as logged-in buyers/freelancers — no auth is required to browse.
 *
 * Query params (all optional):
 *   category  — filter to a single category (e.g. "Development & Tech")
 *   budgetMin — minimum budget, applied client-side after fetch
 *   budgetMax — maximum budget, applied client-side after fetch
 *   q         — search term, scored/ranked server-side (title > category > skills > description)
 *   after     — cursor (last brief ID) for pagination
 *   page      — page number, default 1, 24 Briefs per page
 *
 * Success response (200):
 *   { briefs: [...], total: number, page: number }
 *
 * Error responses:
 *   405 — method not allowed
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON as one-line string
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

const PAGE_SIZE = 24;

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

/* ── Utility: build a Response ── */
function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export default {
  async fetch(request, env, ctx) {

  /* ── Accept GET only ── */
  if (request.method !== 'GET') {
    return respond(405, { error: 'Method not allowed.' });
  }

  const url       = new URL(request.url);
  const params    = url.searchParams;
  const category  = (params.get('category') || '').trim();
  const budgetMinRaw = params.get('budgetMin');
  const budgetMaxRaw = params.get('budgetMax');
  const budgetMin = budgetMinRaw !== null ? Number(budgetMinRaw) : null;
  const budgetMax = budgetMaxRaw !== null ? Number(budgetMaxRaw) : null;
  const page      = Math.max(1, parseInt(params.get('page'), 10) || 1);
  const searchQuery = (params.get('q') || '').trim().toLowerCase().slice(0, 200);

  try {
    const db = getDb(env);

    /* ── Build the Firestore query ──
       Range filters on budgetMin/budgetMax are deliberately NOT applied here
       — Firestore would require a composite index for range queries combined
       with the status/category equality filters and createdAt ordering.
       They are applied in JavaScript after the page is fetched instead. ── */
    let query = db.collection('briefs')
      .where('status', '==', 'open')
      .where('visibility', '==', 'public')
      .orderBy('createdAt', 'desc');

    if (category) {
      query = query.where('category', '==', category);
    }

    // .offset() is not supported in Firebase Admin SDK — use startAfter() cursor instead.
    // The client passes the last document ID as the 'after' query param for page 2+.
    const afterId = params.get('after') || null;

    if (afterId) {
      const cursorDoc = await db.collection('briefs').doc(afterId).get();
      if (cursorDoc.exists) {
        query = query.limit(PAGE_SIZE).startAfter(cursorDoc);
      } else {
        query = query.limit(PAGE_SIZE);
      }
    } else {
      query = query.limit(PAGE_SIZE);
    }

    const snap = await query.get();

    let briefs = snap.docs.map((d) => {
      const data = d.data();
      return {
        id:           d.id,
        title:        data.title       || '',
        description:  data.description || '',
        budgetMin:    data.budgetMin   || 0,
        budgetMax:    data.budgetMax   || 0,
        deadline:     data.deadline    || '',
        category:     data.category    || 'Other',
        skills:       data.skills      || [],
        buyerUid:     data.buyerUid    || '',
        buyerName:    data.buyerName   || 'Buyer',
        buyerAvatar:  data.buyerAvatar || '',
        status:       data.status      || 'open',
        pitchCount:   data.pitchCount   || 0,
        visibility:        data.visibility        || 'public',
        experienceLevel:   data.experienceLevel    || '',
        duration:          data.duration           || '',
        engagementType:    data.engagementType     || '',
        preferredLocation: data.preferredLocation  || '',
        language:          data.language           || '',
        isUrgent:          data.isUrgent === true,
        createdAt:    data.createdAt    || null,
        updatedAt:    data.updatedAt    || null,
      };
    });

    /* ── Apply budget range filters client-side ── */
    if (budgetMin !== null && !isNaN(budgetMin)) {
      briefs = briefs.filter((b) => b.budgetMax >= budgetMin);
    }
    if (budgetMax !== null && !isNaN(budgetMax)) {
      briefs = briefs.filter((b) => b.budgetMin <= budgetMax);
    }

    /* ── Apply search with relevance scoring ──
       Title match > category match > skill match > description match.
       This runs across the fetched page only (see note above the handler
       docstring on pagination); combined with a higher PAGE_SIZE this
       gives good coverage without a dedicated search index. ── */
    if (searchQuery) {
      const terms = searchQuery.split(/\s+/).filter(Boolean);
      briefs = briefs
        .map((b) => {
          let score = 0;
          const titleLower  = (b.title || '').toLowerCase();
          const descLower   = (b.description || '').toLowerCase();
          const skillsLower = (b.skills || []).map((s) => String(s).toLowerCase());
          const catLower    = (b.category || '').toLowerCase();
          terms.forEach((term) => {
            if (titleLower.indexOf(term) !== -1) score += 10;
            if (titleLower.split(/\s+/).includes(term)) score += 5;
            if (catLower.indexOf(term) !== -1) score += 8;
            skillsLower.forEach((s) => { if (s.indexOf(term) !== -1) score += 6; });
            if (descLower.indexOf(term) !== -1) score += 2;
          });
          return Object.assign({}, b, { _score: score });
        })
        .filter((b) => b._score > 0)
        .sort((a, b) => b._score - a._score);
    }

    const lastDoc = snap.docs[snap.docs.length - 1];
    const nextCursor = lastDoc ? lastDoc.id : null;
    return respond(200, { briefs, total: briefs.length, page, nextCursor });

  } catch (err) {
    console.error('[get-briefs] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
  }
};

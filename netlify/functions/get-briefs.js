/**
 * Netlify Function: get-briefs.js
 * Path: netlify/functions/get-briefs.js
 *
 * Public listing endpoint for Briefs. Works for logged-out visitors as
 * well as logged-in buyers/freelancers — no auth is required to browse.
 *
 * Query params (all optional):
 *   category  — filter to a single category (e.g. "Development")
 *   budgetMin — minimum budget, applied client-side after fetch
 *   budgetMax — maximum budget, applied client-side after fetch
 *   page      — page number, default 1, 20 Briefs per page
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

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');

const PAGE_SIZE = 20;

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

/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept GET only ── */
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed.' });
  }

  const params = event.queryStringParameters || {};
  const category  = (params.category || '').trim();
  const budgetMin = params.budgetMin !== undefined ? Number(params.budgetMin) : null;
  const budgetMax = params.budgetMax !== undefined ? Number(params.budgetMax) : null;
  const page      = Math.max(1, parseInt(params.page, 10) || 1);

  try {
    const db = getDb();

    /* ── Build the Firestore query ──
       Range filters on budgetMin/budgetMax are deliberately NOT applied here
       — Firestore would require a composite index for range queries combined
       with the status/category equality filters and createdAt ordering.
       They are applied in JavaScript after the page is fetched instead. ── */
    let query = db.collection('briefs')
      .where('status', '==', 'open')
      .orderBy('createdAt', 'desc');

    if (category) {
      query = query.where('category', '==', category);
    }

    query = query.limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);

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

    return respond(200, { briefs, total: briefs.length, page });

  } catch (err) {
    console.error('[get-briefs] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
};

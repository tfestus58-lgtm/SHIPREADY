/**
 * Netlify Function: get-brief.js
 * Path: netlify/functions/get-brief.js
 *
 * Public single-Brief detail endpoint. Works for logged-out visitors as
 * well as logged-in buyers/freelancers — no auth is required to view.
 * Closed Briefs are not publicly viewable. Individual Pitches are never
 * returned here — see get-pitches.js (buyer-only) for that.
 *
 * Query params:
 *   id  — required, the Brief's Firestore document ID
 *
 * Success response (200):
 *   { brief: { ...all fields, pitchCount } }
 *
 * Error responses:
 *   400 — missing id
 *   404 — brief not found, or not open
 *   405 — method not allowed
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON as one-line string
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');

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
  const id = (params.id || '').trim();

  if (!id) {
    return respond(400, { error: 'id is required.' });
  }

  try {
    const db = getDb();

    const snap = await db.collection('briefs').doc(id).get();

    if (!snap.exists) {
      return respond(404, { error: 'Brief not found.' });
    }

    const data = snap.data();

    if (data.status !== 'open') {
      return respond(404, { error: 'Brief not found.' });
    }

    const brief = {
      id:           snap.id,
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

    return respond(200, { brief });

  } catch (err) {
    console.error('[get-brief] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
};

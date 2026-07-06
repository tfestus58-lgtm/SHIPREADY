/**
 * Netlify Function: get-pitches.js
 * Path: netlify/functions/get-pitches.js
 *
 * Buyer-only endpoint that lists every Pitch submitted on one of their
 * own Briefs. Used by buyer-briefs.html's "Received Pitches" tab.
 *
 * Query params:
 *   briefId  — required, the Brief's Firestore document ID
 *
 * Success response (200):
 *   { pitches: [ { id, freelancerUid, freelancerName, freelancerUsername,
 *                  freelancerAvatar, coverLetter, proposedBudget,
 *                  proposedTimeline, portfolioLink, status, submittedAt } ] }
 *
 * Error responses:
 *   400 — missing briefId
 *   401 — not authenticated
 *   403 — caller does not own this Brief
 *   404 — brief not found
 *   405 — method not allowed
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON as one-line string
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');

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

  /* ── 1. Verify caller identity ── */
  const callerUid = await verifyCaller(event, process.env);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  const params  = event.queryStringParameters || {};
  const briefId = (params.briefId || '').trim();
  if (!briefId) {
    return respond(400, { error: 'briefId is required.' });
  }

  try {
    const db = getDb();

    /* ── 2. Fetch the brief and verify ownership ── */
    const briefRef  = db.collection('briefs').doc(briefId);
    const briefSnap = await briefRef.get();
    if (!briefSnap.exists) {
      return respond(404, { error: 'Brief not found.' });
    }
    const brief = briefSnap.data();

    if (brief.buyerUid !== callerUid) {
      return respond(403, { error: 'You do not have access to this Brief.' });
    }

    /* ── 3. Query pitches, oldest first ── */
    const pitchesSnap = await briefRef
      .collection('pitches')
      .orderBy('submittedAt', 'asc')
      .get();

    const pitches = pitchesSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id:                 doc.id,
        freelancerUid:      d.freelancerUid      || '',
        freelancerName:     d.freelancerName     || 'Freelancer',
        freelancerUsername: d.freelancerUsername || '',
        freelancerAvatar:   d.freelancerAvatar   || '',
        coverLetter:        d.coverLetter        || '',
        proposedBudget:     d.proposedBudget      || 0,
        proposedTimeline:   d.proposedTimeline    || '',
        portfolioLink:      d.portfolioLink       || '',
        status:             d.status              || 'pending',
        submittedAt:        d.submittedAt         || null,
      };
    });

    return respond(200, { pitches });

  } catch (err) {
    console.error('[get-pitches] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
};

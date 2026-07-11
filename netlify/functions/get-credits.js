/**
 * Netlify Function: get-credits.js
 * Path: netlify/functions/get-credits.js
 *
 * Returns the current Kreddlo Credits balance for the authenticated
 * freelancer. Read-only — the daily reset itself happens lazily inside
 * submit-pitch.js at the point of use, not here, so this endpoint never
 * mutates state.
 *
 * Method: GET only.
 *
 * Success response (200):
 *   {
 *     dailyCredits:     number,
 *     creditsResetAt:   string|null (ISO date),
 *     purchasedCredits: number,
 *     totalAvailable:   number
 *   }
 *
 * Error responses:
 *   401 — not authenticated
 *   404 — account not found
 *   405 — method not allowed
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { getSettings }                  = require('./get-settings');

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

/* ── Utility: normalise a Firestore Timestamp/Date/string to an ISO string ── */
function toIsoOrNull(val) {
  if (!val) return null;
  const d = val.toDate ? val.toDate() : new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
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

  try {
    const db = getDb();

    /* ── 2. Read the user's current credit balances ── */
    const userSnap = await db.collection('users').doc(callerUid).get();
    if (!userSnap.exists) {
      return respond(404, { error: 'Account not found.' });
    }
    const userData = userSnap.data();

    let dailyCredits = Number(userData.dailyCredits);
    if (!Number.isFinite(dailyCredits) || dailyCredits < 0) dailyCredits = 0;

    let purchasedCredits = Number(userData.purchasedCredits);
    if (!Number.isFinite(purchasedCredits) || purchasedCredits < 0) purchasedCredits = 0;

    const creditsResetAt = toIsoOrNull(userData.creditsResetAt);

    /* ── 2b. Read admin-configurable credit settings so the client can
       display the real per-Pitch cost and whether daily free credits are
       still on, instead of assuming defaults. ── */
    const settings = await getSettings(db);
    const dailyFreeEnabled = settings.dailyFreeCreditsEnabled !== false;
    const creditCost = Number(settings.creditsPerPitch) >= 1 ? Math.floor(Number(settings.creditsPerPitch)) : 2;

    /* ── 3. Return current values — no writes here (reset happens in submit-pitch.js) ── */
    return respond(200, {
      dailyCredits,
      creditsResetAt,
      purchasedCredits,
      totalAvailable: dailyCredits + purchasedCredits,
      dailyFreeEnabled,
      creditCost,
    });

  } catch (err) {
    console.error('[get-credits] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
};

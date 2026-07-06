/**
 * Netlify Function: shortlist-pitch.js
 * Path: netlify/functions/shortlist-pitch.js
 *
 * Lets a buyer shortlist or decline a pending Pitch on their own Brief.
 * This does not create a project — see accept-pitch.js for hiring.
 *
 * POST body:
 *   {
 *     briefId:  string   — required
 *     pitchId:  string   — required
 *     action:   string   — required, one of: 'shortlist', 'decline'
 *   }
 *
 * Success response (200):
 *   { success: true }
 *
 * Error responses:
 *   400 — missing / invalid fields, pitch already actioned
 *   401 — not authenticated
 *   403 — caller does not own this Brief
 *   404 — brief or pitch not found
 *   405 — method not allowed
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT     — full service account JSON as one-line string
 *   PLATFORM_URL                 — e.g. https://kreddlo.space (for notification fan-out)
 *   INTERNAL_FUNCTION_SECRET     — shared secret for internal function-to-function calls
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');

const VALID_ACTIONS = ['shortlist', 'decline'];

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

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 1. Verify caller identity ── */
  const callerUid = await verifyCaller(event, process.env);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  /* ── 2. Parse request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const briefId = (body.briefId || '').trim();
  const pitchId = (body.pitchId || '').trim();
  const action  = body.action;

  if (!briefId) {
    return respond(400, { error: 'briefId is required.' });
  }
  if (!pitchId) {
    return respond(400, { error: 'pitchId is required.' });
  }
  if (!action || !VALID_ACTIONS.includes(action)) {
    return respond(400, { error: "action must be 'shortlist' or 'decline'." });
  }

  try {
    const db = getDb();

    /* ── 3. Fetch the brief and verify ownership ── */
    const briefRef  = db.collection('briefs').doc(briefId);
    const briefSnap = await briefRef.get();
    if (!briefSnap.exists) {
      return respond(404, { error: 'Brief not found.' });
    }
    const brief = briefSnap.data();

    if (brief.buyerUid !== callerUid) {
      return respond(403, { error: 'You do not have access to this Brief.' });
    }

    /* ── 4. Fetch the pitch and verify status ── */
    const pitchRef  = briefRef.collection('pitches').doc(pitchId);
    const pitchSnap = await pitchRef.get();
    if (!pitchSnap.exists) {
      return respond(404, { error: 'Pitch not found.' });
    }
    const pitch = pitchSnap.data();

    if (pitch.status !== 'pending') {
      return respond(400, { error: `This Pitch has already been actioned (status: ${pitch.status}).` });
    }

    /* ── 5. Update the pitch status ── */
    const newStatus = action === 'shortlist' ? 'shortlisted' : 'declined';
    await pitchRef.update({
      status:    newStatus,
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.log(`[shortlist-pitch] Pitch ${pitchId} on brief ${briefId} set to ${newStatus} by buyer ${callerUid}.`);

    /* ── 6. Notify the freelancer ── */
    // Non-fatal — fire-and-forget
    try {
      const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      if (platformUrl && pitch.freelancerUid) {
        const notifTitle = newStatus === 'shortlisted' ? 'Pitch Shortlisted' : 'Pitch Update';
        const notifBody  = newStatus === 'shortlisted'
          ? `Your Pitch on "${brief.title || 'a Brief'}" has been shortlisted.`
          : `Your Pitch on "${brief.title || 'a Brief'}" was not selected.`;

        const notifyRes = await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
          },
          body: JSON.stringify({
            userUid:    pitch.freelancerUid,
            title:      notifTitle,
            body:       notifBody,
            url:        `${platformUrl}/dashboard-briefs.html`,
            templateId: 'pitch-status-update',
            emailMode:  'never',
            emailData:  { briefTitle: brief.title || '', status: newStatus },
          }),
        });
        if (!notifyRes.ok) {
          console.warn('[shortlist-pitch] Notification returned', notifyRes.status);
        }
      }
    } catch (notifErr) {
      console.warn('[shortlist-pitch] Could not notify freelancer:', notifErr.message);
    }

    return respond(200, { success: true });

  } catch (err) {
    console.error('[shortlist-pitch] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
};

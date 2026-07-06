/**
 * Netlify Function: send-project-message.js
 * Path: netlify/functions/send-project-message.js
 *
 * Lets either party on a project (buyer or freelancer) send a free-form
 * message to the other without having to propose a full contract change.
 * Messages are appended to the project document's `messages` array.
 *
 * POST body:
 *   { projectId: string, text: string }
 *
 * Success response (200):
 *   { success: true }
 *
 * Error responses:
 *   400 — missing / invalid fields, or project status does not allow messaging
 *   401 — not authenticated
 *   403 — caller is not a party to this project
 *   404 — project not found
 *   405 — method not allowed
 *   429 — rate limited (30 messages / hour / user)
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON as one-line string
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET  — shared secret for server-to-server calls
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { checkRateLimit }                = require('./_rate-limit');
const { sanitizeString }                = require('./_sanitize');

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

/* ── Internal function caller (server-to-server) ── */
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`[send-project-message] PLATFORM_URL not set — cannot call ${name}.`);
    return;
  }
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[send-project-message] ${name} returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    // Non-fatal — core Firestore write already succeeded
    console.error(`[send-project-message] Failed to call ${name}:`, err.message);
  }
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

  /* ── 2. Parse and validate request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { projectId, text } = body;

  if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
    return respond(400, { error: 'projectId is required.' });
  }
  if (!text || typeof text !== 'string') {
    return respond(400, { error: 'text is required.' });
  }

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[send-project-message] Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  /* ── 3. Rate limit — 30 messages per hour per user ── */
  const rlResult = await checkRateLimit(db, `msg::${callerUid}`, 30, 3600);
  if (!rlResult.allowed) {
    return respond(429, { error: rlResult.error, retryAfter: rlResult.retryAfter });
  }

  /* ── 4. Sanitize message text ── */
  const sanitizedText = sanitizeString(text, 2000);
  if (!sanitizedText || !sanitizedText.trim()) {
    return respond(400, { error: 'Message text cannot be empty.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  /* ── 5. Fetch the project doc ── */
  let projectSnap;
  try {
    projectSnap = await db.collection('projects').doc(projectId.trim()).get();
  } catch (err) {
    console.error(`[send-project-message] Firestore read failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!projectSnap.exists) {
    return respond(404, { error: 'Project not found.' });
  }

  const project = projectSnap.data();

  /* ── 6. Verify caller is a party to this project ── */
  const isBuyer      = project.buyerUid      === callerUid;
  const isFreelancer = project.freelancerUid === callerUid;

  if (!isBuyer && !isFreelancer) {
    return respond(403, { error: 'You are not a party to this project.' });
  }

  /* ── 7. Guard: messaging only allowed on active projects ── */
  if (!['pending_payment', 'in_progress', 'delivered'].includes(project.status)) {
    return respond(400, {
      error: 'Messages can only be sent on active projects. Current status: ' + project.status,
    });
  }

  const senderRole   = isBuyer ? 'buyer' : 'freelancer';
  const senderName   = isBuyer ? (project.buyerName || 'The client') : (project.freelancerName || 'The freelancer');
  const projectTitle = project.projectTitle || project.title || 'your project';

  const otherUid = isBuyer ? project.freelancerUid : project.buyerUid;

  /* ── 8. Append the message to the project doc ── */
  const message = {
    senderUid:  callerUid,
    senderRole: senderRole,
    text:       sanitizedText,
    sentAt:     new Date().toISOString(),
  };

  try {
    await db.collection('projects').doc(projectId.trim()).update({
      messages:  FieldValue.arrayUnion(message),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[send-project-message] Message sent on project ${projectId} by ${callerUid} (${senderRole}).`);
  } catch (err) {
    console.error(`[send-project-message] Firestore update failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Failed to send message. Please try again.' });
  }

  /* ── 9. Notify the other party ── */
  if (otherUid) {
    const dashboardUrl = isBuyer
      ? `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(projectId.trim())}`
      : `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(projectId.trim())}`;

    await callFunction('send-smart-notification', {
      userUid:    otherUid,
      title:      'New Message',
      body:       `${senderName} sent you a message on "${projectTitle}".`,
      url:        dashboardUrl,
      templateId: 'project-message-received',
      emailMode:  'never',
      emailData: {
        projectTitle,
        senderName,
        text: sanitizedText,
      },
    });
  }

  return respond(200, { success: true });
};

/* ── Utility ── */
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

/**
 * Netlify Function: post-brief.js
 * Path: netlify/functions/post-brief.js
 *
 * Lets a buyer post a Brief — a job listing describing work they need
 * done. Freelancers apply to Briefs by submitting Pitches (see
 * submit-pitch.js).
 *
 * POST body:
 *   {
 *     title:       string   — 5-120 chars
 *     description: string   — 20-5000 chars
 *     budgetMin:   number   — >= 1
 *     budgetMax:   number   — >= budgetMin
 *     deadline:    string   — ISO date string, must be in the future
 *     category:    string   — one of: Design, Development, Writing,
 *                              Marketing, Video, Audio, Business, Other
 *     skills:      string[] — max 10 items, each max 40 chars
 *   }
 *
 * Success response (200):
 *   { success: true, briefId: string }
 *
 * Error responses:
 *   400 — missing / invalid fields
 *   401 — not authenticated
 *   403 — caller is not a buyer
 *   404 — buyer account not found
 *   405 — method not allowed
 *   429 — rate limited (5 briefs / 24h / buyer)
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON as one-line string
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';
import { verifyCaller }                  from './_verify-auth';
import { checkRateLimit }                from './_rate-limit';
import { sanitizeString }                from './_sanitize';

const VALID_CATEGORIES = [
  'Design & Creative',
  'Development & Tech',
  'Writing & Translation',
  'Marketing & Growth',
  'Video & Animation',
  'Audio & Music',
  'Business & Finance',
  'Data & Analytics',
  'Legal & Compliance',
  'Engineering & Architecture',
  'Sales & CRM',
  'Admin & Operations',
  'Customer Support',
  'Photography',
  '3D & CAD',
  'AI & Machine Learning',
  'Blockchain & Web3',
  'Cybersecurity',
  'Education & Training',
  'Health & Wellness',
  'Other',
];

const VALID_EXPERIENCE_LEVELS = ['Entry', 'Intermediate', 'Expert'];

const VALID_DURATIONS = [
  'Less than a week',
  '1-2 weeks',
  '1 month',
  '1-3 months',
  '3-6 months',
  '6+ months',
  'Ongoing',
];

const VALID_ENGAGEMENT_TYPES = ['One-time', 'Ongoing', 'Part-time', 'Full-time'];

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
  const rawText = await request.text();

  /* ── Accept POST only ── */
  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 1. Verify caller identity ── */
  const callerUid = await verifyCaller(request, env);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  /* ── 2. Parse request body ── */
  let body;
  try {
    body = JSON.parse(rawText || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  try {
    const db = getDb(env);

    /* ── 3. Role check ── */
    const userSnap = await db.collection('users').doc(callerUid).get();
    if (!userSnap.exists) {
      return respond(404, { error: 'Account not found.' });
    }
    const userData = userSnap.data();

    if (userData.role !== 'buyer') {
      return respond(403, { error: 'Only buyers can post Briefs.' });
    }

    if (userData.suspended === true) {
      return respond(403, { error: 'Your account has been suspended. Please contact support for assistance.' });
    }

    /* ── 4. Rate limit — 5 briefs per 24 hours per buyer ── */
    const rlResult = await checkRateLimit(db, `brief::${callerUid}`, 5, 86400);
    if (!rlResult.allowed) {
      return respond(429, { error: rlResult.error, retryAfter: rlResult.retryAfter });
    }

    /* ── 5. Validate fields ── */
    const { title, description, budgetMin, budgetMax, deadline, category, skills } = body;
    const { experienceLevel, duration, engagementType, preferredLocation, language, isUrgent, visibility } = body;

    if (!title || typeof title !== 'string' || title.trim().length < 5 || title.trim().length > 120) {
      return respond(400, { error: 'Title must be between 5 and 120 characters.' });
    }
    if (!description || typeof description !== 'string' || description.trim().length < 20 || description.trim().length > 5000) {
      return respond(400, { error: 'Description must be between 20 and 5000 characters.' });
    }

    const budgetMinNum = Number(budgetMin);
    if (!budgetMinNum || budgetMinNum < 1) {
      return respond(400, { error: 'budgetMin must be a number of at least 1.' });
    }
    const budgetMaxNum = Number(budgetMax);
    if (!budgetMaxNum || budgetMaxNum < budgetMinNum) {
      return respond(400, { error: 'budgetMax must be a number greater than or equal to budgetMin.' });
    }

    if (!deadline || typeof deadline !== 'string' || !deadline.trim()) {
      return respond(400, { error: 'A deadline is required.' });
    }
    const deadlineDate = new Date(deadline.trim() + 'T00:00:00Z');
    if (isNaN(deadlineDate.getTime()) || deadlineDate <= new Date()) {
      return respond(400, { error: 'Deadline must be a valid future date.' });
    }

    if (!category || typeof category !== 'string' || !VALID_CATEGORIES.includes(category)) {
      return respond(400, { error: 'category must be one of: ' + VALID_CATEGORIES.join(', ') + '.' });
    }

    if (skills !== undefined && !Array.isArray(skills)) {
      return respond(400, { error: 'skills must be an array of strings.' });
    }
    const skillsArr = Array.isArray(skills) ? skills : [];
    if (skillsArr.length > 10) {
      return respond(400, { error: 'A maximum of 10 skills is allowed.' });
    }
    for (const s of skillsArr) {
      if (typeof s !== 'string' || !s.trim() || s.trim().length > 40) {
        return respond(400, { error: 'Each skill must be a non-empty string of at most 40 characters.' });
      }
    }

    if (!experienceLevel || typeof experienceLevel !== 'string' || !VALID_EXPERIENCE_LEVELS.includes(experienceLevel)) {
      return respond(400, { error: 'experienceLevel must be one of: ' + VALID_EXPERIENCE_LEVELS.join(', ') + '.' });
    }

    if (!duration || typeof duration !== 'string' || !VALID_DURATIONS.includes(duration)) {
      return respond(400, { error: 'duration must be one of: ' + VALID_DURATIONS.join(', ') + '.' });
    }

    if (!engagementType || typeof engagementType !== 'string' || !VALID_ENGAGEMENT_TYPES.includes(engagementType)) {
      return respond(400, { error: 'engagementType must be one of: ' + VALID_ENGAGEMENT_TYPES.join(', ') + '.' });
    }

    if (preferredLocation !== undefined && preferredLocation !== null && preferredLocation !== '') {
      if (typeof preferredLocation !== 'string' || preferredLocation.trim().length > 100) {
        return respond(400, { error: 'preferredLocation must be a string of at most 100 characters.' });
      }
    }

    if (!language || typeof language !== 'string' || language.trim().length < 2 || language.trim().length > 60) {
      return respond(400, { error: 'language must be between 2 and 60 characters.' });
    }

    const isUrgentBool = isUrgent === true;

    const visibilityVal = (visibility === 'private') ? 'private' : 'public';

    /* ── 6. Sanitize free-text fields ── */
    const safeTitle       = sanitizeString(title, 120);
    const safeDescription = sanitizeString(description, 5000);
    const safeSkills      = skillsArr.map((s) => sanitizeString(s, 40));
    const safePreferredLocation = preferredLocation ? sanitizeString(preferredLocation, 100) : '';
    const safeLanguage    = sanitizeString(language, 60);

    /* ── 7. Write the brief document ── */
    const now = FieldValue.serverTimestamp();
    const briefDoc = {
      title:        safeTitle,
      description:  safeDescription,
      budgetMin:    budgetMinNum,
      budgetMax:    budgetMaxNum,
      deadline:     deadline.trim(),
      category:     category,
      skills:       safeSkills,
      experienceLevel:   experienceLevel,
      duration:          duration,
      engagementType:    engagementType,
      preferredLocation: safePreferredLocation,
      language:          safeLanguage,
      isUrgent:          isUrgentBool,
      visibility:        visibilityVal,
      buyerUid:     callerUid,
      buyerName:    userData.displayName || userData.name || 'Buyer',
      buyerAvatar:  userData.avatarUrl || '',
      status:       'open',
      pitchCount:   0,
      createdAt:    now,
      updatedAt:    now,
    };

    const briefRef = await db.collection('briefs').add(briefDoc);
    const briefId  = briefRef.id;

    console.log(`[post-brief] Brief ${briefId} posted by buyer ${callerUid}.`);

    return respond(200, { success: true, briefId });

  } catch (err) {
    console.error('[post-brief] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
  }
};

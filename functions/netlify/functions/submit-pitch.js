/**
 * Netlify Function: submit-pitch.js
 * Path: netlify/functions/submit-pitch.js
 *
 * Lets a freelancer submit a Pitch (application) on an open Brief.
 * Spends 1 Kreddlo Credit per submission — daily free credits first,
 * then purchased credits (see credits.html / get-credits.js / purchase-credits.js).
 *
 * If an admin has enabled the monthly free credit grant (config/platform
 * monthlyFreeCreditEnabled + monthlyFreeCreditAmount, set in admin.html
 * under "Kreddlo Credits"), this function also lazily grants that amount
 * once per calendar month, added to purchasedCredits so it never expires.
 *
 * POST body:
 *   {
 *     briefId:          string   — required, the Brief's Firestore doc ID
 *     coverLetter:      string   — required, 50-2000 chars
 *     proposedBudget:   number   — required, must fall within
 *                                  [brief.budgetMin, brief.budgetMax * 1.5]
 *     proposedTimeline: string   — required, max 200 chars
 *     portfolioLink:    string   — optional, must start with https://, max 2048 chars
 *   }
 *
 * Success response (200):
 *   { success: true, pitchId: string, creditsRemaining: number }
 *
 * Error responses:
 *   400 — missing / invalid fields, brief not open, duplicate pitch
 *   401 — not authenticated
 *   402 — no Kreddlo Credits remaining
 *   403 — caller is not a freelancer, or not KYC-verified
 *   404 — account or brief not found
 *   405 — method not allowed
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT     — full service account JSON as one-line string
 *   PLATFORM_URL                 — e.g. https://kreddlo.space (for notification fan-out)
 *   INTERNAL_FUNCTION_SECRET     — shared secret for internal function-to-function calls
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';
import { verifyCaller }                  from './_verify-auth';
import { sanitizeString, sanitizeUrl }   from './_sanitize';
import { getSettings }                   from './get-settings';

const DAILY_CREDIT_ALLOWANCE = 10;

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

/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/* ── Utility: today's UTC midnight, as a Date ── */
function todayUtcMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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

    /* ── 3. Role + KYC check ── */
    const userRef  = db.collection('users').doc(callerUid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return respond(404, { error: 'Account not found.' });
    }
    const userData = userSnap.data();

    if (userData.role !== 'freelancer') {
      return respond(403, { error: 'Only freelancers can submit Pitches.' });
    }
    if (userData.suspended === true) {
      return respond(403, { error: 'Your account has been suspended. Please contact support for assistance.' });
    }
    /* NOTE: this codebase's verified KYC value is 'verified' (see kyc-approve.js),
       not 'approved' — matched here so real verified freelancers are not blocked. */
    if (userData.kycStatus !== 'verified') {
      return respond(403, { error: 'Complete identity verification before submitting Pitches.' });
    }

    /* ── 4. Daily credit check — reset if the window has rolled over ── */
    const todayMidnight = todayUtcMidnight();
    let dailyCredits     = Number(userData.dailyCredits);
    let purchasedCredits = Number(userData.purchasedCredits) || 0;
    if (!Number.isFinite(purchasedCredits) || purchasedCredits < 0) purchasedCredits = 0;

    let creditsResetAt = userData.creditsResetAt
      ? (userData.creditsResetAt.toDate ? userData.creditsResetAt.toDate() : new Date(userData.creditsResetAt))
      : null;

    let needsReset = !creditsResetAt || isNaN(creditsResetAt.getTime()) || creditsResetAt < todayMidnight;
    if (needsReset || !Number.isFinite(dailyCredits) || dailyCredits < 0) {
      dailyCredits   = DAILY_CREDIT_ALLOWANCE;
      creditsResetAt = todayMidnight;
    }

    /* ── 4b. Monthly free credit grant (admin-configurable) — granted lazily
       at this same point-of-use, once per calendar month, the same way the
       daily allowance is reset above. Added to purchasedCredits so it never
       expires and is spent after the daily allowance runs out. ── */
    const settings = await getSettings(db);
    let monthlyCreditsGrantedAt = userData.monthlyCreditsGrantedAt || null;
    let monthlyGrantApplied = false;
    if (settings.monthlyFreeCreditEnabled && Number(settings.monthlyFreeCreditAmount) > 0) {
      const nowUtc = new Date();
      const thisMonthKey = nowUtc.getUTCFullYear() + '-' + String(nowUtc.getUTCMonth() + 1).padStart(2, '0');
      if (monthlyCreditsGrantedAt !== thisMonthKey) {
        purchasedCredits += Number(settings.monthlyFreeCreditAmount);
        monthlyCreditsGrantedAt = thisMonthKey;
        monthlyGrantApplied = true;
      }
    }

    if (dailyCredits <= 0 && purchasedCredits <= 0) {
      // Persist the reset (if any) and/or the monthly grant (if any) even
      // when blocking, so the UI reflects the correct values on next load.
      if (needsReset || monthlyGrantApplied) {
        await userRef.update({
          dailyCredits,
          creditsResetAt,
          purchasedCredits,
          monthlyCreditsGrantedAt,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return respond(402, {
        error: 'No Kreddlo Credits remaining. Purchase more to continue pitching.',
        creditsRemaining: 0,
      });
    }

    /* ── 5. Validate briefId + fetch brief ── */
    const { briefId, coverLetter, proposedBudget, proposedTimeline, portfolioLink } = body;

    if (!briefId || typeof briefId !== 'string' || !briefId.trim()) {
      return respond(400, { error: 'briefId is required.' });
    }

    const briefRef  = db.collection('briefs').doc(briefId.trim());
    const briefSnap = await briefRef.get();
    if (!briefSnap.exists) {
      return respond(404, { error: 'Brief not found.' });
    }
    const brief = briefSnap.data();

    if (brief.status !== 'open') {
      return respond(400, { error: 'This Brief is no longer accepting Pitches.' });
    }

    /* ── 6. Duplicate check ── */
    const dupeSnap = await briefRef
      .collection('pitches')
      .where('freelancerUid', '==', callerUid)
      .limit(1)
      .get();
    if (!dupeSnap.empty) {
      return respond(400, { error: 'You have already submitted a Pitch on this Brief.' });
    }

    /* ── 7. Validate remaining fields ── */
    if (!coverLetter || typeof coverLetter !== 'string') {
      return respond(400, { error: 'A cover letter is required.' });
    }
    const safeCoverLetter = sanitizeString(coverLetter, 2000);
    if (safeCoverLetter.length < 50) {
      return respond(400, { error: 'Cover letter must be at least 50 characters.' });
    }

    const proposedBudgetNum = Number(proposedBudget);
    const budgetMin = Number(brief.budgetMin) || 0;
    const budgetMax = Number(brief.budgetMax) || 0;
    if (!Number.isFinite(proposedBudgetNum) || proposedBudgetNum < budgetMin || proposedBudgetNum > budgetMax * 1.5) {
      return respond(400, {
        error: `Proposed budget must be between $${budgetMin} and $${(budgetMax * 1.5).toFixed(2)}.`,
      });
    }

    if (!proposedTimeline || typeof proposedTimeline !== 'string') {
      return respond(400, { error: 'A proposed timeline is required.' });
    }
    const safeTimeline = sanitizeString(proposedTimeline, 200);
    if (!safeTimeline) {
      return respond(400, { error: 'A proposed timeline is required.' });
    }

    let safePortfolioLink = '';
    if (portfolioLink !== undefined && portfolioLink !== null && portfolioLink !== '') {
      const cleaned = sanitizeUrl(portfolioLink, 2048);
      if (!cleaned) {
        return respond(400, { error: 'Portfolio link must start with https:// and be a valid URL.' });
      }
      safePortfolioLink = cleaned;
    }

    /* ── 8. Deduct 1 credit — daily first, then purchased ── */
    let newDailyCredits     = dailyCredits;
    let newPurchasedCredits = purchasedCredits;
    if (newDailyCredits > 0) {
      newDailyCredits -= 1;
    } else {
      newPurchasedCredits -= 1;
    }

    await userRef.update({
      dailyCredits:     newDailyCredits,
      purchasedCredits: newPurchasedCredits,
      creditsResetAt,
      monthlyCreditsGrantedAt,
      updatedAt:        FieldValue.serverTimestamp(),
    });

    /* ── 9. Write the pitch document ── */
    const now = FieldValue.serverTimestamp();
    const pitchDoc = {
      freelancerUid:      callerUid,
      freelancerName:     userData.displayName || userData.name || 'Freelancer',
      freelancerUsername: userData.username || '',
      freelancerAvatar:   userData.avatarUrl || '',
      coverLetter:        safeCoverLetter,
      proposedBudget:     proposedBudgetNum,
      proposedTimeline:   safeTimeline,
      portfolioLink:      safePortfolioLink,
      status:             'pending',
      submittedAt:        now,
    };

    const pitchRef = await briefRef.collection('pitches').add(pitchDoc);
    const pitchId  = pitchRef.id;

    /* ── 10. Increment the brief's pitch count ── */
    await briefRef.update({
      pitchCount: FieldValue.increment(1),
      updatedAt:  now,
    });

    console.log(`[submit-pitch] Pitch ${pitchId} submitted by ${callerUid} on brief ${briefId}.`);

    /* ── 11. Notify the buyer ── */
    // Non-fatal — fire-and-forget
    try {
      const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      if (platformUrl && brief.buyerUid) {
        const notifyRes = await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '',
          },
          body: JSON.stringify({
            userUid:    brief.buyerUid,
            title:      'New Pitch Received',
            body:       `${pitchDoc.freelancerName} submitted a Pitch on "${brief.title || 'your Brief'}".`,
            url:        `${platformUrl}/buyer-briefs.html`,
            templateId: 'new-pitch-received',
            emailMode:  'never',
            emailData:  { briefTitle: brief.title || '', freelancerName: pitchDoc.freelancerName },
          }),
        });
        if (!notifyRes.ok) {
          console.warn('[submit-pitch] Notification returned', notifyRes.status);
        }
      }
    } catch (notifErr) {
      console.warn('[submit-pitch] Could not notify buyer:', notifErr.message);
    }

    return respond(200, {
      success: true,
      pitchId,
      creditsRemaining: newDailyCredits + newPurchasedCredits,
    });

  } catch (err) {
    console.error('[submit-pitch] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
  }
};

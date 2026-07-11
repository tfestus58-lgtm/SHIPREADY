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

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { sanitizeString, sanitizeUrl }  = require('./_sanitize');
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

/* ── Utility: today's UTC midnight, as a Date ── */
function todayUtcMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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

  try {
    const db = getDb();

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

    /* ── 4. Load platform settings first — needed for both the daily
       allowance (is it enabled? what's the amount?) and the per-Pitch
       credit cost, admin-configurable in admin.html under "Kreddlo
       Credits". Falls back to sane defaults if Firestore is unreachable. ── */
    const settings        = await getSettings(db);
    const dailyFreeEnabled = settings.dailyFreeCreditsEnabled !== false; // default true
    const dailyAllowance   = Number(settings.dailyFreeCreditsAmount) > 0 ? Number(settings.dailyFreeCreditsAmount) : 10;
    const creditCost       = Number(settings.creditsPerPitch) >= 1 ? Math.floor(Number(settings.creditsPerPitch)) : 2;

    /* ── 4a. Daily credit check — reset if the window has rolled over.
       If the admin has disabled daily free credits, the reset grants 0
       instead of the allowance, so freelancers fall straight through to
       purchasedCredits. ── */
    const todayMidnight = todayUtcMidnight();
    let dailyCredits     = Number(userData.dailyCredits);
    let purchasedCredits = Number(userData.purchasedCredits) || 0;
    if (!Number.isFinite(purchasedCredits) || purchasedCredits < 0) purchasedCredits = 0;

    let creditsResetAt = userData.creditsResetAt
      ? (userData.creditsResetAt.toDate ? userData.creditsResetAt.toDate() : new Date(userData.creditsResetAt))
      : null;

    let needsReset = !creditsResetAt || isNaN(creditsResetAt.getTime()) || creditsResetAt < todayMidnight;
    if (needsReset || !Number.isFinite(dailyCredits) || dailyCredits < 0) {
      dailyCredits   = dailyFreeEnabled ? dailyAllowance : 0;
      creditsResetAt = todayMidnight;
    }

    /* ── 4b. Monthly free credit grant (admin-configurable) — granted lazily
       at this same point-of-use, once per calendar month, the same way the
       daily allowance is reset above. Added to purchasedCredits so it never
       expires and is spent after the daily allowance runs out. ── */
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

    const totalAvailable = dailyCredits + purchasedCredits;
    if (totalAvailable < creditCost) {
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
        error: 'Not enough Kreddlo Credits. Submitting a Pitch costs ' + creditCost + ' Credit' + (creditCost !== 1 ? 's' : '') + '. Purchase more to continue.',
        creditsRemaining: totalAvailable,
        creditCost,
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

    /* ── 8. Deduct 1 credit — daily first, then purchased.
       Wrapped in a Firestore transaction with a FRESH re-read of the user
       doc, mirroring the transaction pattern already used for balance
       mutations elsewhere in this codebase (create-bank-payout.js,
       create-payout.js, scheduled-clear-earnings.js). The pre-check above
       (step 4) uses the snapshot read at the top of this request purely as
       a fast-fail for UX — it is NOT the enforcement point. Without this
       transaction, two concurrent submissions (two tabs, two devices, or a
       client retry) could both read the same dailyCredits/purchasedCredits
       values before either write commits, and both succeed — letting a
       user with 1 credit left submit 2 Pitches, or driving purchasedCredits
       negative. The transaction re-read closes that window: whichever
       request commits first wins, and the second sees the already-updated
       balance. ── */
    let newDailyCredits, newPurchasedCredits;
    let outOfCreditsAtCommit = false;

    try {
      await db.runTransaction(async (tx) => {
        const freshUserSnap = await tx.get(userRef);
        if (!freshUserSnap.exists) {
          throw new Error('Account not found during credit transaction.');
        }
        const freshData = freshUserSnap.data();

        let txDailyCredits     = Number(freshData.dailyCredits);
        let txPurchasedCredits = Number(freshData.purchasedCredits) || 0;
        if (!Number.isFinite(txPurchasedCredits) || txPurchasedCredits < 0) txPurchasedCredits = 0;

        let txCreditsResetAt = freshData.creditsResetAt
          ? (freshData.creditsResetAt.toDate ? freshData.creditsResetAt.toDate() : new Date(freshData.creditsResetAt))
          : null;
        const txNeedsReset = !txCreditsResetAt || isNaN(txCreditsResetAt.getTime()) || txCreditsResetAt < todayMidnight;
        if (txNeedsReset || !Number.isFinite(txDailyCredits) || txDailyCredits < 0) {
          txDailyCredits   = dailyFreeEnabled ? dailyAllowance : 0;
          txCreditsResetAt = todayMidnight;
        }

        let txMonthlyCreditsGrantedAt = freshData.monthlyCreditsGrantedAt || null;
        if (settings.monthlyFreeCreditEnabled && Number(settings.monthlyFreeCreditAmount) > 0) {
          const nowUtc = new Date();
          const thisMonthKey = nowUtc.getUTCFullYear() + '-' + String(nowUtc.getUTCMonth() + 1).padStart(2, '0');
          if (txMonthlyCreditsGrantedAt !== thisMonthKey) {
            txPurchasedCredits += Number(settings.monthlyFreeCreditAmount);
            txMonthlyCreditsGrantedAt = thisMonthKey;
          }
        }

        // Re-check against the FRESH values — a concurrent request may have
        // already spent enough credits since the pre-check at step 4.
        if ((txDailyCredits + txPurchasedCredits) < creditCost) {
          outOfCreditsAtCommit = true;
          tx.update(userRef, {
            dailyCredits:            txDailyCredits,
            creditsResetAt:          txCreditsResetAt,
            purchasedCredits:        txPurchasedCredits,
            monthlyCreditsGrantedAt: txMonthlyCreditsGrantedAt,
            updatedAt:               FieldValue.serverTimestamp(),
          });
          return;
        }

        // Deduct creditCost credits total — daily allowance first, then
        // purchased credits cover the remainder.
        let txRemaining = creditCost;
        if (txDailyCredits >= txRemaining) {
          txDailyCredits -= txRemaining;
          txRemaining = 0;
        } else {
          txRemaining -= txDailyCredits;
          txDailyCredits = 0;
          txPurchasedCredits = Math.max(0, txPurchasedCredits - txRemaining);
          txRemaining = 0;
        }

        newDailyCredits     = txDailyCredits;
        newPurchasedCredits = txPurchasedCredits;

        tx.update(userRef, {
          dailyCredits:            txDailyCredits,
          purchasedCredits:        txPurchasedCredits,
          creditsResetAt:          txCreditsResetAt,
          monthlyCreditsGrantedAt: txMonthlyCreditsGrantedAt,
          updatedAt:               FieldValue.serverTimestamp(),
        });
      });
    } catch (txErr) {
      console.error('[submit-pitch] Credit transaction failed:', txErr.message);
      return respond(500, { error: 'Internal server error. Please try again.' });
    }

    if (outOfCreditsAtCommit) {
      return respond(402, {
        error: 'Not enough Kreddlo Credits. Submitting a Pitch costs ' + creditCost + ' Credit' + (creditCost !== 1 ? 's' : '') + '. Purchase more to continue.',
        creditsRemaining: 0,
        creditCost,
      });
    }

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
      const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      if (platformUrl && brief.buyerUid) {
        const notifyRes = await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
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
};

/**
 * Netlify Scheduled Function: process-email-queue.js
 * Path: netlify/functions/process-email-queue.js
 * Schedule: every 5 minutes (cron: 5-minute interval)
 *
 * Processes delayed emails from the email-queue Firestore collection.
 *
 * Logic per queued document:
 *   1. Check if sendAfter timestamp has passed. (Firestore query handles this.)
 *   2. Resolve the recipient email — uses the `to` field stored on the
 *      queue doc, falling back to a Firestore lookup by userUid for queue
 *      docs that don't carry a top-level recipient (e.g. guest-welcome
 *      emails where userUid IS the recipient). If no email can be
 *      resolved, mark sent=true, skippedReason='no-recipient-email'.
 *   3. Fetch the corresponding in-app notification document.
 *   4. If the user has already READ the notification — skip the email.
 *      Mark queue doc as sent with skippedReason = 'read-by-user'.
 *   5. If not read — send the email via send-email function.
 *      Mark queue doc sent=true, update notification emailSent=true.
 *
 * Firestore email-queue document schema:
 *   {
 *     userUid:    string
 *     notifDocId: string | null
 *     templateId: string
 *     emailData:  object
 *     to:         string         — recipient email address
 *     toName:     string | null  — recipient display name
 *     sendAfter:  number (Unix ms timestamp)
 *     sent:       boolean
 *     createdAt:  Timestamp
 *   }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET  — shared secret sent as x-internal-secret when
 *                               calling send-email (server-to-server call)
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                 from 'firebase-admin/firestore';

/* ── Firebase Admin — lazy singleton ── */
let _db = null;

function getDb(env) {
  if (_db) return _db;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse((env && env.FIREBASE_SERVICE_ACCOUNT) || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  _db = getFirestore();
  return _db;
}

/* ── Call a sibling Netlify function ── */
async function callFunction(env, name, payload) {
  const platformUrl = ((env && env.PLATFORM_URL) || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return null;
  }
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': (env && env.INTERNAL_FUNCTION_SECRET) || '',
      },
      body:    JSON.stringify(payload),
    });
    return res;
  } catch (err) {
    console.warn(`callFunction(${name}) failed:`, err.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
// NOTE: Cloudflare Pages Functions have no Cron Trigger mechanism, so
// this scheduled() handler is preserved here as a plain export but is
// NOT currently invoked by anything on Pages. See migration notes.
export async function scheduled(event, env, ctx) {

  /* ── Trigger source ──
     Cloudflare Workers' scheduled() handler can only ever be invoked by
     Cloudflare's own Cron Trigger system — there is no public URL that
     reaches it, unlike Netlify's event.headers-based check this replaces.
     The fetch() handler below is the only HTTP-reachable entry point for
     this file, and it never runs this business logic. No auth check is
     needed here as a result. (Note: the original event.headers-based
     check could not simply be left in place — ScheduledEvent has no
     .headers property, so it would have evaluated isRealSchedule/
     isTrustedCall to false on every real cron run and rejected every
     invocation with 401, silently breaking the entire email queue.) */

  let db;
  try {
    db = getDb(env);
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return;
  }

  const now = Date.now();

  /* ── Query: unsent docs whose sendAfter has passed ──
     This needs a composite index on (sent ASC, sendAfter ASC), declared in
     firestore.indexes.json. That file only takes effect in the live project
     via a separate `firebase deploy --only firestore:indexes` step — it is
     NOT applied by the Netlify/GitHub deploy pipeline. If that index step
     was ever skipped or hasn't finished building, Firestore rejects this
     exact query with FAILED_PRECONDITION (gRPC code 9), this function
     returns 500 on every scheduled run, and every queued email — including
     dashboard-invoices.html's client-side 'invoice-sent' write — silently
     never sends, with no visible error to the freelancer or buyer.

     FIX: if that specific error occurs, fall back to a query that needs no
     composite index (single-field `sent` is auto-indexed by Firestore by
     default) and filter `sendAfter <= now` in memory instead. This keeps the
     queue working even if the composite index is missing, while leaving the
     normal fast path untouched once the index is deployed and healthy. ── */
  let snapshot;
  let usedFallbackQuery = false;
  try {
    snapshot = await db
      .collection('email-queue')
      .where('sent', '==', false)
      .where('sendAfter', '<=', now)
      .limit(20)
      .get();
  } catch (err) {
    const isMissingIndex = err && err.code === 9; // FAILED_PRECONDITION
    if (!isMissingIndex) {
      console.error('Firestore email-queue query failed:', err.message);
      return;
    }

    console.warn(
      'process-email-queue: composite index on email-queue (sent, sendAfter) ' +
      'is missing or still building — falling back to an unindexed query. ' +
      'Run `firebase deploy --only firestore:indexes` to restore the fast path.'
    );

    try {
      const fallbackSnapshot = await db
        .collection('email-queue')
        .where('sent', '==', false)
        .limit(100) // wider cap since this path can't pre-filter by sendAfter
        .get();

      const dueDocs = fallbackSnapshot.docs.filter((d) => {
        const sendAfter = d.data().sendAfter;
        return typeof sendAfter === 'number' && sendAfter <= now;
      });

      // Mimic a QuerySnapshot shape closely enough for the loop below.
      snapshot = { empty: dueDocs.length === 0, size: dueDocs.length, docs: dueDocs.slice(0, 20) };
      usedFallbackQuery = true;
    } catch (fallbackErr) {
      console.error('Firestore email-queue fallback query also failed:', fallbackErr.message);
      return;
    }
  }

  if (snapshot.empty) {
    console.log('process-email-queue: no pending items.');
    return;
  }

  console.log(`process-email-queue: processing ${snapshot.size} item(s).`);

  let processed = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const queueDoc of snapshot.docs) {
    const queueData = queueDoc.data();
    const { userUid, notifDocId, templateId, emailData } = queueData;
    let   { to: recipientEmail, toName: recipientName } = queueData;

    const queueRef = db.collection('email-queue').doc(queueDoc.id);

    /* ── Issue C verification (confirmed not a bug) ──────────────────────
       send-smart-notification.js resolves the final recipient address as:
         recipientEmail = emailTo || firestoreEmail
       and writes it directly to the `to` field on the queue doc BEFORE
       enqueueing. This means `to` already holds the correct address — the
       emailTo override (used by deliver-product.js for buyer review-request
       emails) is fully preserved here without any extra logic needed.

       The Firestore lookup below runs ONLY when `to` is absent — which
       covers two legacy/backward-compat cases:
         1. Queue docs written before the `to` field existed.
         2. Guest-welcome emails where userUid IS the recipient (no emailTo,
            and the user may not have a Firestore email at queue-write time).

       In all normal cases (emailTo override present OR standard user email),
       `to` is populated at queue-write time and the fallback never fires.
       This is the audit-required targeted check for Issue C — confirmed safe.

       When emailToOverride: true is present on the doc, we log it so that
       audit trails show the override was used correctly. ── */
    if (queueData.emailToOverride && recipientEmail) {
      console.log(`[process-email-queue] emailTo override active for uid ${userUid}, queueDocId ${queueDoc.id}, template ${templateId}.`);
    }

    /* ── Backward compat / sender-vs-recipient cases: some queue docs
       (e.g. create-product-order.js's guest-welcome email) don't store a
       top-level `to` field at all — userUid IS the recipient there, so
       look the user up. This also covers any older queue docs written
       before the `to` field existed. NOTE: this fallback is intentionally
       NOT run when recipientEmail is already populated — that includes all
       emailTo-override docs, ensuring the override is never clobbered by
       a stale Firestore re-fetch. ── */
    if (!recipientEmail && userUid) {
      try {
        const userSnap = await db.collection('users').doc(userUid).get();
        if (userSnap.exists) {
          recipientEmail = userSnap.data().email || null;
          recipientName  = userSnap.data().name  || null;
        }
      } catch (err) {
        console.warn(`Could not look up email for uid ${userUid}:`, err.message);
      }
    }

    /* ── Skip cleanly if we still have no recipient email — this item can
       never succeed, so don't let it loop in the queue indefinitely. ── */
    if (!recipientEmail) {
      try {
        await queueRef.update({
          sent:          true,
          skippedReason: 'no-recipient-email',
          processedAt:   new Date().toISOString(),
        });
        console.warn(`Skipped email for uid ${userUid} (no recipient email found), queueDocId ${queueDoc.id}.`);
        skipped++;
      } catch (err) {
        console.error(`Failed to mark queue doc ${queueDoc.id} as skipped:`, err.message);
        errors++;
      }
      continue;
    }

    /* ── Check if notification was already read ── */
    let notificationRead = false;

    if (notifDocId && userUid) {
      try {
        const notifSnap = await db
          .collection('users').doc(userUid)
          .collection('notifications').doc(notifDocId)
          .get();

        if (notifSnap.exists && notifSnap.data().read === true) {
          notificationRead = true;
        }
      } catch (err) {
        // If we can't read the notification doc, err on the side of sending
        console.warn(`Could not read notification doc ${notifDocId} for uid ${userUid}:`, err.message);
      }
    }

    /* ── Skip if already read ── */
    if (notificationRead) {
      try {
        await queueRef.update({
          sent:          true,
          skippedReason: 'read-by-user',
          processedAt:   new Date().toISOString(),
        });
        console.log(`Skipped email for uid ${userUid} (notification already read), queueDocId ${queueDoc.id}.`);
        skipped++;
      } catch (err) {
        console.error(`Failed to mark queue doc ${queueDoc.id} as skipped:`, err.message);
        errors++;
      }
      continue;
    }

    /* ── Retry cap: abandon docs that have failed too many times ──────────
       Without this, a doc that can never succeed (e.g. permanent Brevo
       rejection, mismatched secret) fills every batch run indefinitely and
       blocks new legitimate entries from being processed. After MAX_RETRIES
       failed send attempts we mark it sent=true with skippedReason so it
       leaves the active queue. retryCount is incremented on every failure. ── */
    const MAX_RETRIES = 5;
    const retryCount  = typeof queueData.retryCount === 'number' ? queueData.retryCount : 0;

    if (retryCount >= MAX_RETRIES) {
      try {
        await queueRef.update({
          sent:          true,
          skippedReason: 'max-retries-exceeded',
          processedAt:   new Date().toISOString(),
        });
        console.warn(`Abandoned queue doc ${queueDoc.id} after ${retryCount} failed attempts (uid ${userUid}, template ${templateId}).`);
        skipped++;
      } catch (err) {
        console.error(`Failed to abandon queue doc ${queueDoc.id}:`, err.message);
        errors++;
      }
      continue;
    }

    /* ── Send the email ── */
    try {
      const res = await callFunction(env, 'send-email', {
        to:     recipientEmail,
        toName: recipientName || undefined,
        templateId,
        data:   emailData || {},
      });

      if (res && res.ok) {
        // Mark queue doc as sent
        await queueRef.update({
          sent:        true,
          sentAt:      new Date().toISOString(),
          processedAt: new Date().toISOString(),
        });

        // Update the notification document too
        if (notifDocId && userUid) {
          try {
            await db
              .collection('users').doc(userUid)
              .collection('notifications').doc(notifDocId)
              .update({ emailSent: true, emailSentAt: new Date().toISOString() });
          } catch (err) {
            // Non-fatal
            console.warn(`Could not update emailSent on notification ${notifDocId}:`, err.message);
          }
        }

        console.log(`Email sent for uid ${userUid}, template ${templateId}, queueDocId ${queueDoc.id}.`);
        processed++;
      } else {
        const status    = res ? res.status : 'no response';
        const nextRetry = retryCount + 1;
        console.error(`send-email returned ${status} for uid ${userUid}, queueDocId ${queueDoc.id}. Retry ${nextRetry}/${MAX_RETRIES}.`);
        try {
          await queueRef.update({
            retryCount:  nextRetry,
            lastError:   `send-email HTTP ${status}`,
            lastAttempt: new Date().toISOString(),
          });
        } catch (updateErr) {
          console.error(`Failed to update retryCount on queue doc ${queueDoc.id}:`, updateErr.message);
        }
        errors++;
      }
    } catch (err) {
      const nextRetry = retryCount + 1;
      console.error(`Error sending email for queueDocId ${queueDoc.id} (retry ${nextRetry}/${MAX_RETRIES}):`, err.message);
      try {
        await queueRef.update({
          retryCount:  nextRetry,
          lastError:   err.message,
          lastAttempt: new Date().toISOString(),
        });
      } catch (updateErr) {
        console.error(`Failed to update retryCount on queue doc ${queueDoc.id}:`, updateErr.message);
      }
      errors++;
    }
  }

  console.log(
    `process-email-queue done. processed=${processed} skipped=${skipped} errors=${errors}` +
    (usedFallbackQuery ? ' (used fallback query — composite index missing/building)' : '')
  );
  }

export async function onRequest(context) {
  const { request, env, ctx } = context;
    return new Response('Scheduled function — not callable via HTTP.', { status: 200 });
  }

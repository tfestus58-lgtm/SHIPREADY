/**
 * Netlify Scheduled Function: scheduled-clear-earnings.js
 * Path: netlify/functions/scheduled-clear-earnings.js
 *
 * Runs hourly (schedule defined in netlify.toml).
 *
 * Item 9 — Earnings Holding Period (product sales + affiliate commissions).
 *
 * Finds `product-earnings` and `affiliate-earnings` records where
 * `cleared === false` and `clearsAt <= now`, then:
 *   1. Moves the held amount from the user's pendingBalance(s) into their
 *      availableBalance / balances.{CURRENCY} (product sales) or from
 *      affiliatePendingBalance into affiliateBalance (affiliate commissions).
 *   2. Flips the earning record's `cleared` flag to true.
 *
 * This is the only place uncleared funds ever become withdrawable — both
 * create-payout.js / create-bank-payout.js (freelancer payouts) and
 * affiliate-withdraw.js already gate on availableBalance / affiliateBalance,
 * so once this job has run, those existing functions enforce the holding
 * period automatically with no changes of their own required.
 *
 * If a holding period of 0 days is configured, deliver-product.js and the
 * payment webhooks mark earnings `cleared: true` immediately at creation —
 * this job will simply find nothing to do for those records.
 *
 * netlify.toml entry required:
 *   [functions."scheduled-clear-earnings"]
 *   schedule = "0 * * * *"
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as single-line string
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }     from 'firebase-admin/firestore';

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
     needed here as a result. */

  console.log('scheduled-clear-earnings: running at', new Date().toISOString());

  let db;
  try {
    db = getDb(env);
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return;
  }

  const now = new Date();
  const results = {
    productEarningsCleared:   0,
    productEarningsFailed:    0,
    affiliateEarningsCleared: 0,
    affiliateEarningsFailed:  0,
    invoiceEscrowReleased:    0,  // Bug 7 fix: pre-initialised so the key is always
    invoiceEscrowFailed:      0,  // present in the response JSON, even when section 4
                                  // query throws before the loop — consistent with
                                  // sections 1 & 2 which pre-declare their counters.
  };

  /* ════════════════════════════════════════════════════════════
     1. CLEAR PRODUCT-SALE EARNINGS
  ════════════════════════════════════════════════════════════ */
  try {
    const snap = await db.collection('product-earnings')
      .where('cleared',  '==', false)
      .where('clearsAt', '<=', now)
      .get();

    if (snap.empty) {
      console.log('scheduled-clear-earnings: no product earnings ready to clear.');
    } else {
      console.log(`scheduled-clear-earnings: found ${snap.size} product earning(s) ready to clear.`);

      for (const docSnap of snap.docs) {
        try {
          await db.runTransaction(async (tx) => {
            // Re-read the earning doc fresh inside the transaction so a second
            // overlapping run sees cleared: true and skips — closing the race.
            const freshSnap = await tx.get(docSnap.ref);
            if (!freshSnap.exists) return; // deleted between query and tx — skip

            const earning = freshSnap.data();
            if (earning.cleared === true) return; // another run already claimed it

            const currency = (earning.currency || 'USD').toUpperCase();
            const amount   = Number(earning.amount) || 0;
            if (amount <= 0) {
              // Nothing to credit — just flip the flag so this record is skipped next time
              tx.update(docSnap.ref, { cleared: true, clearedAt: FieldValue.serverTimestamp() });
              return;
            }

            const userRef = db.collection('users').doc(earning.sellerUid);
            // Route based on paymentMethod so crypto-pending → cryptoBalance
            // and fiat-pending → availableBalance, matching the credit path in
            // deliver-product.js / approve-delivery.js.
            const isCryptoEarning = earning.paymentMethod === 'crypto';
            const clearUpdate = {
              [`balances.${currency}`]:        FieldValue.increment(amount),
              [`pendingBalances.${currency}`]: FieldValue.increment(-amount),
            };
            if (currency === 'USD') {
              if (isCryptoEarning) {
                clearUpdate.cryptoBalance        = FieldValue.increment(amount);
                clearUpdate.cryptoPendingBalance = FieldValue.increment(-amount);
              } else {
                clearUpdate.availableBalance = FieldValue.increment(amount);
                clearUpdate.pendingBalance   = FieldValue.increment(-amount);
              }
            }
            tx.update(userRef, clearUpdate);
            tx.update(docSnap.ref, { cleared: true, clearedAt: FieldValue.serverTimestamp() });
          });

          results.productEarningsCleared++;
        } catch (err) {
          console.error(`scheduled-clear-earnings: failed to clear product earning ${docSnap.id}:`, err.message);
          results.productEarningsFailed++;
        }
      }
    }
  } catch (err) {
    // Likely a missing composite index (cleared + clearsAt) — see FIRESTORE_INDEXES.md
    console.error('scheduled-clear-earnings: product-earnings query failed (may need composite index on product-earnings.cleared + product-earnings.clearsAt — check logs for a Firebase auto-create link):', err.message);
  }

  /* ════════════════════════════════════════════════════════════
     2. CLEAR AFFILIATE-COMMISSION EARNINGS
  ════════════════════════════════════════════════════════════ */
  try {
    const snap = await db.collection('affiliate-earnings')
      .where('cleared',  '==', false)
      .where('clearsAt', '<=', now)
      .get();

    if (snap.empty) {
      console.log('scheduled-clear-earnings: no affiliate earnings ready to clear.');
    } else {
      console.log(`scheduled-clear-earnings: found ${snap.size} affiliate earning(s) ready to clear.`);

      for (const docSnap of snap.docs) {
        try {
          await db.runTransaction(async (tx) => {
            // Re-read fresh inside the transaction so a second overlapping run
            // sees cleared: true and skips — closing the race.
            const freshSnap = await tx.get(docSnap.ref);
            if (!freshSnap.exists) return; // deleted between query and tx — skip

            const earning = freshSnap.data();
            if (earning.cleared === true) return; // another run already claimed it

            const amount = Number(earning.commissionAmount) || 0;
            if (amount <= 0) {
              // Nothing to credit — just flip the flag so this record is skipped next time
              tx.update(docSnap.ref, { cleared: true, clearedAt: FieldValue.serverTimestamp() });
              return;
            }

            const userRef  = db.collection('users').doc(earning.affiliateUid);
            const currency = (earning.currency || 'USD').toUpperCase();

            /*
             * Issue 2 fix — use the stored USD-equivalent for the gate field.
             * commissionAmountUsd is written by the webhooks (post-fix) using the
             * order's gateway-derived exchange rate. For earnings written before
             * this fix (no commissionAmountUsd field), fall back to commissionAmount
             * so behaviour is unchanged for legacy records.
             */
            const amountUsd = Number(earning.commissionAmountUsd != null ? earning.commissionAmountUsd : earning.commissionAmount) || 0;

            /*
             * Design note — why paymentMethod is NOT used for routing here:
             *
             * affiliate-earnings records written by nowpayments-webhook.js carry
             * paymentMethod: 'crypto' for audit purposes. This does NOT mean the
             * cleared amount should go to cryptoBalance or availableBalance.
             *
             * The affiliate balance pool (affiliateBalance / affiliateBalances) is
             * intentionally separate from both the fiat pool (availableBalance) and
             * the crypto pool (cryptoBalance). Affiliates withdraw exclusively via
             * affiliate-withdraw.js, which gates only on affiliateBalance — it never
             * reads cryptoBalance or availableBalance. Routing affiliate commissions
             * into either of those pools would make them withdrawable via the wrong
             * rail (bank payout or crypto payout) and would break the rail isolation
             * enforced by create-bank-payout.js and create-payout.js.
             *
             * The paymentMethod field on affiliate-earnings is audit / display metadata
             * only. Do not use it to switch the destination balance pool here.
             */
            const clearUpdate = {
              // Gate field — always USD-equivalent so withdrawals are meaningful
              affiliateBalance:        FieldValue.increment(amountUsd),
              affiliatePendingBalance: FieldValue.increment(-amountUsd),
              // Per-currency display maps — always native amount
              [`affiliateBalances.${currency}`]:        FieldValue.increment(amount),
              [`affiliatePendingBalances.${currency}`]: FieldValue.increment(-amount),
            };
            tx.update(userRef, clearUpdate);
            tx.update(docSnap.ref, { cleared: true, clearedAt: FieldValue.serverTimestamp() });
          });

          results.affiliateEarningsCleared++;
        } catch (err) {
          console.error(`scheduled-clear-earnings: failed to clear affiliate earning ${docSnap.id}:`, err.message);
          results.affiliateEarningsFailed++;
        }
      }
    }
  } catch (err) {
    // Likely a missing composite index (cleared + clearsAt) — see FIRESTORE_INDEXES.md
    console.error('scheduled-clear-earnings: affiliate-earnings query failed (may need composite index on affiliate-earnings.cleared + affiliate-earnings.clearsAt — check logs for a Firebase auto-create link):', err.message);
  }

  /* ════════════════════════════════════════════════════════════
     3. AUTO-MARK INVOICE AS DELIVERED (48hr window)
     Any invoice in `escrow` status with deliverBy <= now gets
     auto-marked as `delivered` so the escrow countdown starts.
  ════════════════════════════════════════════════════════════ */
  try {
    const escrowSnap = await db.collection('invoices')
      .where('status', '==', 'escrow')
      .where('deliverBy', '<=', now)
      .get();

    if (!escrowSnap.empty) {
      console.log(`scheduled-clear-earnings: auto-marking ${escrowSnap.size} invoice(s) as delivered.`);
      for (const docSnap of escrowSnap.docs) {
        try {
          /* ── Issue 3 fix: wrap in a transaction with a fresh status re-read ──
             Without this, two overlapping cron runs (or a cron run + manual
             trigger) could both query status === 'escrow' and both write
             status: 'delivered' with a slightly different deliveredAt timestamp.
             Section 4 queries deliveredAt <= cutoff — if the second write's
             timestamp is newer than the cutoff, the invoice would not appear
             in section 4's query on this run, delaying auto-release by up to
             1 hour. The transaction ensures only one run sets deliveredAt,
             closing the race exactly as sections 1, 2, and 4 already do. */
          await db.runTransaction(async (tx) => {
            const freshSnap = await tx.get(docSnap.ref);
            if (!freshSnap.exists) return; // deleted between query and tx — skip

            const inv = freshSnap.data();
            if (inv.status !== 'escrow') return; // another run already claimed it

            tx.update(docSnap.ref, {
              status:        'delivered',
              deliveredAt:   FieldValue.serverTimestamp(), // Issue 5 fix: server clock, not JS Date — avoids clock-drift mismatch with section 4's deliveredAt <= cutoff query
              autoDelivered: true,
              updatedAt:     FieldValue.serverTimestamp(),
            });
          });
          console.log(`Auto-marked invoice ${docSnap.id} as delivered.`);
        } catch (err) {
          console.error(`Failed to auto-mark invoice ${docSnap.id} as delivered:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('scheduled-clear-earnings: invoice auto-deliver query failed (may need composite index on invoices.status + invoices.deliverBy):', err.message);
  }

  /* ════════════════════════════════════════════════════════════
     4. AUTO-RELEASE INVOICE ESCROW (admin-configured escrow days)
     Any invoice in `delivered` status with deliveredAt older than
     holdingPeriodDays gets funds released to the seller's availableBalance.
  ════════════════════════════════════════════════════════════ */
  try {
    const settings = await db.collection('config').doc('platform').get();
    const escrowDays = (settings.exists && settings.data().holdingPeriodDays != null)
      ? Number(settings.data().holdingPeriodDays)
      : 7;

    const cutoff = new Date(now.getTime() - escrowDays * 24 * 60 * 60 * 1000);

    const deliveredSnap = await db.collection('invoices')
      .where('status', '==', 'delivered')
      .where('deliveredAt', '<=', cutoff)
      .get();

    if (!deliveredSnap.empty) {
      console.log(`scheduled-clear-earnings: auto-releasing escrow for ${deliveredSnap.size} delivered invoice(s).`);
      for (const docSnap of deliveredSnap.docs) {
        try {
          await db.runTransaction(async (tx) => {
            // Re-read the invoice doc fresh inside the transaction so a second
            // overlapping cron run sees status !== 'delivered' and skips —
            // closing the same race that sections 1 & 2 above already close
            // for product-earnings and affiliate-earnings. Without this, two
            // simultaneous cron runs could both pass the .where('status','==',
            // 'delivered') query and both credit the seller's balance.
            const freshSnap = await tx.get(docSnap.ref);
            if (!freshSnap.exists) return; // deleted between query and tx — skip

            const inv = freshSnap.data();
            if (inv.status !== 'delivered') return; // another run already released it

            const sellerUid    = inv.uid;
            const sellerAmount = Number(inv.escrowSellerAmount || 0);
            const currency     = (inv.currency || 'USD').toUpperCase();
            // FIX — crypto/fiat balance separation. inv.paymentMethod is set
            // by flutterwave-webhook.js / stripe-webhook.js / nowpayments-webhook.js
            // when escrow is first placed. Without checking this, every USD
            // invoice auto-released here (including crypto-paid ones) was
            // credited to availableBalance, the fiat bank-withdrawal pool.
            const isCryptoInvoice = inv.paymentMethod === 'crypto';

            if (sellerUid && sellerAmount > 0) {
              const autoReleaseUpdate = {
                [`balances.${currency}`]:              FieldValue.increment(sellerAmount),
                // Legacy blended figure — kept for older admin tooling only.
                totalEarned:                           FieldValue.increment(sellerAmount),
                // Accurate, currency-separated figure for any seller-facing display.
                [`totalEarnedByCurrency.${currency}`]: FieldValue.increment(sellerAmount),
                updatedAt:                             FieldValue.serverTimestamp(),
              };
              if (currency === 'USD') {
                if (isCryptoInvoice) {
                  // Crypto-sourced USD → dedicated cryptoBalance pool, never
                  // availableBalance — keeps the crypto payout rail isolated.
                  autoReleaseUpdate.cryptoBalance = FieldValue.increment(sellerAmount);
                } else {
                  autoReleaseUpdate.availableBalance = FieldValue.increment(sellerAmount);
                }
              }
              tx.update(db.collection('users').doc(sellerUid), autoReleaseUpdate);
            }

            tx.update(docSnap.ref, {
              status:       'completed',
              completedAt:  FieldValue.serverTimestamp(),
              autoReleased: true,
              updatedAt:    FieldValue.serverTimestamp(),
            });
          });

          /* ── Update escrow-holds record (outside transaction — collection query
             not allowed inside a Firestore transaction) ── */
          try {
            const holdQuery = await db.collection('escrow-holds')
              .where('invoiceId', '==', docSnap.id)
              .where('status', '==', 'held')
              .limit(1)
              .get();
            if (!holdQuery.empty) {
              await holdQuery.docs[0].ref.update({ status: 'released', releasedAt: FieldValue.serverTimestamp() });
            } else {
              // Issue 35-4 fix: the freelancer balance was already credited inside
              // the transaction above, so this is an audit-trail gap only — no fund
              // risk. Log a warning so it is visible for manual reconciliation.
              console.warn(`[scheduled-clear-earnings] No held escrow-hold found for invoice ${docSnap.id} — balance already released correctly; hold record may need manual reconciliation.`);
            }
          } catch (holdErr) {
            // Log but do not rethrow — the balance credit inside the transaction
            // is the financially critical operation and has already committed.
            console.error(`[scheduled-clear-earnings] Failed to update escrow-hold record for invoice ${docSnap.id}:`, holdErr.message);
          }

          console.log(`Auto-released escrow for invoice ${docSnap.id}.`);
          results.invoiceEscrowReleased++;
        } catch (err) {
          console.error(`Failed to auto-release escrow for invoice ${docSnap.id}:`, err.message);
          results.invoiceEscrowFailed++;
        }
      }
    }
  } catch (err) {
    console.error('scheduled-clear-earnings: invoice escrow-release query failed (may need composite index on invoices.status + invoices.deliveredAt):', err.message);
    results.invoiceEscrowQueryFailed = true;  // Bug E fix: flag query failure so the summary JSON distinguishes a failed query from a run that found nothing to release
  }

  console.log('scheduled-clear-earnings: complete —', JSON.stringify(results));
  }

export async function onRequest(context) {
  const { request, env, ctx } = context;
    return new Response('Scheduled function — not callable via HTTP.', { status: 200 });
  }

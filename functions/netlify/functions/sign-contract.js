// netlify/functions/sign-contract.js
//
// Records a party's signature on a project in Firestore.
// Fix #9: Now reads/writes the `projects` collection (where create-project.js
// actually stores data) instead of the orphaned `contracts` collection.
// When both parties have signed, generates the PDF via generate-contract-pdf
// (internal call), uploads it to Cloudinary, and writes contractPdfUrl back
// to the Firestore document.
//
// POST body:
//   contractId   string   — Firestore projects doc ID
//   role         string   — 'freelancer' | 'buyer'
//   signature    string   — base64 PNG of signature (no data: prefix)
//   ip           string   — signer's IP (pass from client or from event headers)
//
// Returns:
//   { ok: true, bothSigned: bool, contractPdfUrl: string|null }

import admin from 'firebase-admin';
import { verifyCaller } from './_verify-auth';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
// Cloudflare Workers provides fetch() natively as a global — the Netlify-era
// node-fetch dynamic-import shim is no longer needed (node-fetch is not even
// a project dependency; see package.json).
// Cloudflare Workers exposes the Web Crypto API as a global `crypto` object.
import { sanitizeString } from './_sanitize';
import generateContractPdfModule from './generate-contract-pdf';

// ── Firebase Admin (singleton) ────────────────────────────────────
function getAdmin(env) {
  if (admin.apps.length) return admin;
  const svc = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  return admin;
}

// ── Upload buffer to Cloudinary ───────────────────────────────────
async function uploadToCloudinary(pdfBuffer, publicId, env) {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary env vars not configured');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder    = 'kreddlo-contracts';
  const sigStr    = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const sigHashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(sigStr));
  const signature = Array.from(new Uint8Array(sigHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  const formData  = new FormData();
  const blob      = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('file',      blob,       `${publicId}.pdf`);
  formData.append('public_id', publicId);
  formData.append('folder',    folder);
  formData.append('timestamp', timestamp);
  formData.append('api_key',   apiKey);
  formData.append('signature', signature);

  const res  = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`,
    { method: 'POST', body: formData }
  );
  const json = await res.json();

  if (!res.ok || json.error) {
    throw new Error(json.error?.message || 'Cloudinary upload failed');
  }

  // Return the secure_url (permanent, CDN-hosted)
  return json.secure_url;
}

// ── Generate PDF bytes by calling generate-contract-pdf internally ─
// We call the sibling module's fetch handler directly (same isolate) to
// avoid an extra HTTP round-trip. This mirrors the old Netlify pattern of
// require()'ing the handler module directly and invoking it in-process —
// the Workers equivalent is invoking its export default { fetch } with a
// real Request object.
async function buildPdf(contractData, contractId, env, ctx) {
  const fakeRequest = new Request('https://internal.kreddlo/generate-contract-pdf', {
    method: 'POST',
    body: JSON.stringify({
      projectId:           contractId,
      projectTitle:        contractData.title || contractData.projectTitle || 'Service Agreement',
      serviceDescription:  contractData.scope || contractData.description || '',
      budget:              contractData.amount || contractData.budget || 0,
      deadline:            contractData.deadline
                             ? (contractData.deadline.toDate
                                 ? contractData.deadline.toDate().toISOString()
                                 : contractData.deadline)
                             : '',
      freelancerName:      contractData.freelancerName   || '',
      freelancerUsername:  contractData.freelancerUsername || '',
      freelancerSignature: contractData.freelancerSignature || '',
      freelancerSignedAt:  contractData.freelancerSignedAt
                             ? (contractData.freelancerSignedAt.toDate
                                 ? contractData.freelancerSignedAt.toDate().toISOString()
                                 : contractData.freelancerSignedAt)
                             : '',
      freelancerIp:        contractData.freelancerIp     || '',
      buyerName:           contractData.buyerName        || '',
      buyerEmail:          contractData.buyerEmail       || '',
      buyerSignature:      contractData.buyerSignature   || '',
      buyerSignedAt:       contractData.buyerSignedAt
                             ? (contractData.buyerSignedAt.toDate
                                 ? contractData.buyerSignedAt.toDate().toISOString()
                                 : contractData.buyerSignedAt)
                             : '',
      buyerIp:             contractData.buyerIp          || '',
      agreementDate:       new Date().toLocaleDateString('en-US', {
                             month: 'long', day: 'numeric', year: 'numeric'
                           }),
      preview: true,
    }),
  });

  const result = await generateContractPdfModule.fetch(fakeRequest, env, ctx);

  if (result.status !== 200) {
    throw new Error('PDF generation failed: ' + await result.text());
  }

  // generate-contract-pdf.js now returns the raw PDF binary directly
  // (no more base64/isBase64Encoded wrapping).
  const arrayBuffer = await result.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

// ── Internal function caller ──────────────────────────────────────
async function callFunction(env, name, payload) {
  const platformUrl = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) { console.warn(`PLATFORM_URL not set — cannot call ${name}.`); return; }
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`${name} returned ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error(`Failed to call ${name}:`, err.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────
export default {
async fetch(request, env, ctx) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(request, env);
  if (!callerUid) {
    return new Response(JSON.stringify({ error: 'Unauthorized. Please log in again.' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawText = await request.text();
  let body;
  try {
    body = JSON.parse(rawText || '{}');
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { contractId, role, signature = '', ip = '' } = body;

  // Sanitize the signer's display name — it is embedded in the contract PDF
  // which is uploaded to Cloudinary and linked from the HTML dashboard pages.
  // signature is a base64 PNG blob — not a text field, not sanitized here.
  // ip is server-side-derived or discarded in favor of event headers below.

  if (!contractId || !role) {
    return new Response(JSON.stringify({ error: 'contractId and role are required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (role !== 'freelancer' && role !== 'buyer') {
    return new Response(JSON.stringify({ error: 'role must be freelancer or buyer' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const db  = getAdmin(env).firestore();
    // Fix #9: use `projects` collection — this is where create-project.js writes.
    // The orphaned `contracts` collection was never populated by any create path.
    const ref = db.collection('projects').doc(contractId);
    const snap = await ref.get();

    if (!snap.exists) {
      return new Response(JSON.stringify({ error: 'Contract not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = snap.data();

    /* ── Ownership check (FIX) ──
       Previously `role` was trusted entirely from the request body, with
       no check that the verified caller actually corresponds to the
       contract's freelancerUid/buyerUid. That let any authenticated user
       sign someone else's contract by passing an arbitrary contractId and
       role. Mirrors the same ownership pattern already used in
       submit-delivery.js (project.freelancerUid !== freelancerUid) and
       raise-dispute.js (project.buyerUid === raisedBy). */
    const expectedUid = role === 'freelancer' ? data.freelancerUid : data.buyerUid;
    if (!expectedUid || expectedUid !== callerUid) {
      return new Response(JSON.stringify({ error: 'You are not authorised to sign this contract as ' + role + '.' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Determine which fields to update
    const now = admin.firestore.FieldValue.serverTimestamp();
    const updates = {};

    if (role === 'freelancer') {
      /* KYC guard — freelancer must be verified to sign a contract */
      const freelancerUserSnap = await db.collection('users').doc(callerUid).get();
      if (!freelancerUserSnap.exists || freelancerUserSnap.data().kycStatus !== 'verified') {
        return new Response(JSON.stringify({ error: 'Your identity must be verified before you can sign contracts.' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        });
      }

      if (data.freelancerSigned) {
        return new Response(JSON.stringify({ error: 'Already signed as freelancer' }), {
          status: 409, headers: { 'Content-Type': 'application/json' },
        });
      }
      updates.freelancerSigned    = true;
      updates.freelancerSignedAt  = now;
      updates.freelancerIp        = ip || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || '';
      if (signature) updates.freelancerSignature = signature;
    } else {
      if (data.buyerSigned) {
        return new Response(JSON.stringify({ error: 'Already signed as buyer' }), {
          status: 409, headers: { 'Content-Type': 'application/json' },
        });
      }
      updates.buyerSigned   = true;
      updates.buyerSignedAt = now;
      updates.buyerIp       = ip || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || '';
      if (signature) updates.buyerSignature = signature;
    }

    // Write the signature fields first
    await ref.update(updates);

    // Check if both parties have now signed
    const freelancerSigned = role === 'freelancer' ? true : (data.freelancerSigned || false);
    const buyerSigned      = role === 'buyer'       ? true : (data.buyerSigned      || false);
    const bothSigned       = freelancerSigned && buyerSigned;

    let contractPdfUrl = data.contractPdfUrl || null;

    if (bothSigned) {
      // Fix 11: flip status to active in its own step, immediately once both
      // signatures are recorded — this must never be blocked by (or lost to)
      // a PDF-generation/Cloudinary failure. Previously the status flip was
      // combined with PDF generation, so if that step threw, the whole
      // request 500'd and the contract stayed stuck on "awaiting_signatures"
      // forever even though both freelancerSigned/buyerSigned were already
      // true (written above at the top of this function).
      await ref.update({ status: 'active', escrowStatus: 'unfunded' });

      if (!contractPdfUrl) {
        try {
          // Re-fetch to get the server-written timestamps for the signature we just recorded
          const freshSnap = await ref.get();
          const freshData = freshSnap.data();

          // Merge in the new signature image so PDF has it
          if (role === 'freelancer' && signature) freshData.freelancerSignature = signature;
          if (role === 'buyer'      && signature) freshData.buyerSignature      = signature;

          // Generate PDF
          const pdfBuffer = await buildPdf(freshData, contractId, env, ctx);

          // Upload to Cloudinary
          const publicId  = `contract-${contractId}-${Date.now()}`;
          contractPdfUrl  = await uploadToCloudinary(pdfBuffer, publicId, env);

          // Persist the URL now that generation succeeded
          await ref.update({ contractPdfUrl });
        } catch (pdfErr) {
          // Non-fatal (same pattern as the notification block below): the
          // contract is already active regardless. dashboard-contracts.html's
          // viewContractPdf() fallback generates the PDF on-demand via
          // download-contract.js whenever contractPdfUrl is still missing.
          console.warn('[sign-contract] PDF generation/upload failed — contract remains active, PDF can be generated on demand:', pdfErr && pdfErr.message);
        }
      }
    }

    /* ── Notify the other party ── */
    try {
      const platformUrl  = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      const contractUrl  = `${platformUrl}/dashboard-contracts.html`;
      const contractTitle = data.title || 'Contract';

      if (bothSigned) {
        // Both signed — notify both parties the contract is now active
        const notifyUids = [
          { uid: data.freelancerUid, name: data.buyerName     || 'the client',     other: data.freelancerName || 'the freelancer' },
          { uid: data.buyerUid,      name: data.freelancerName || 'the freelancer', other: data.buyerName      || 'the client' },
        ];
        for (const party of notifyUids) {
          if (!party.uid) continue;
          await callFunction(env, 'send-smart-notification', {
            userUid:    party.uid,
            title:      'Contract Now Active',
            body:       `"${contractTitle}" has been signed by both parties and is now active.`,
            url:        contractUrl,
            templateId: 'contract-active',
            emailMode:  'always',
            emailData:  { contractTitle, name: party.other },
          });
        }
      } else {
        // Only one party signed — notify the other to sign
        const otherUid  = role === 'freelancer' ? data.buyerUid      : data.freelancerUid;
        const signerName = role === 'freelancer' ? (data.freelancerName || 'The freelancer') : (data.buyerName || 'The client');
        if (otherUid) {
          await callFunction(env, 'send-smart-notification', {
            userUid:    otherUid,
            title:      'Signature Required',
            body:       `${signerName} has signed "${contractTitle}". Your signature is needed to activate it.`,
            url:        contractUrl,
            templateId: 'contract-sign-requested',
            emailMode:  'always',
            emailData:  { contractTitle, signerName },
          });
        }
      }
    } catch (notifErr) {
      // Non-fatal — contract is already signed/active
      console.warn('[sign-contract] notification error:', notifErr.message);
    }

    return new Response(JSON.stringify({ ok: true, bothSigned, contractPdfUrl }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[sign-contract]', err);
    return new Response(JSON.stringify({ error: err.message || 'Signing failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
};

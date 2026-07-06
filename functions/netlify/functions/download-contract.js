// netlify/functions/download-contract.js
//
// Streams a contract PDF directly to the browser without storing it anywhere.
// Fetches the contract doc from Firestore, passes all fields to
// generate-contract-pdf in preview mode, and pipes the bytes back as the
// HTTP response.
//
// GET /api/download-contract?contractId=xxx&idToken=yyy
//
// Security: idToken is a Firebase ID token, verified server-side, and its
//           decoded uid must match either freelancerUid or buyerUid on the
//           contract document.
//
//           FIX: this previously trusted a bare `uid` query-string value
//           with no verification that the actual requester controlled
//           that uid — anyone who knew (or could see, e.g. via another
//           API response) a contract's freelancerUid/buyerUid could
//           download that contract's signed PDF (names, signatures, deal
//           terms, IP addresses) by simply passing it as `uid`. This is
//           invoked via window.open() (a plain navigation), which can't
//           carry an Authorization header, so the caller's Firebase ID
//           token is passed as a query parameter instead and verified
//           the same way every other function verifies it from a header.
//
// Returns:
//   application/pdf binary stream (Content-Disposition: attachment)

import admin from 'firebase-admin';
import { generatePdf } from './generate-contract-pdf.js';

function getAdmin(env) {
  if (admin.apps.length) return admin;
  const svc = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  return admin;
}

export default {
async fetch(request, env, ctx) {
  const url = new URL(request.url);
  const contractId = url.searchParams.get('contractId') || '';
  const idToken = url.searchParams.get('idToken') || '';

  if (!contractId || !idToken) {
    return new Response('contractId and idToken are required', { status: 400 });
  }

  let uid;
  try {
    const decoded = await getAdmin(env).auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    return new Response('Invalid or expired session. Please refresh and try again.', { status: 401 });
  }

  try {
    const db = getAdmin(env).firestore();
    // Fix #9: use `projects` collection — this is where create-project.js writes.
    // The orphaned `contracts` collection was never populated by any create path.
    const snap = await db.collection('projects').doc(contractId).get();

    if (!snap.exists) {
      return new Response('Contract not found', { status: 404 });
    }

    const data = snap.data();

    // Auth check: only freelancer or buyer may download
    if (data.freelancerUid !== uid && data.buyerUid !== uid) {
      return new Response('Access denied', { status: 403 });
    }

    // If a stored PDF already exists, redirect to it — fastest path
    if (data.contractPdfUrl) {
      return new Response(null, { status: 302, headers: { Location: data.contractPdfUrl } });
    }

    // Generate on-demand via the shared PDF generator (in-process call,
    // no require()/fetch — generatePdf is a plain async function that
    // returns the raw PDF Uint8Array directly).
    function toIso(ts) {
      if (!ts) return '';
      // Firestore Timestamp
      if (ts && typeof ts.toDate === 'function') return ts.toDate().toISOString();
      // ISO string stored directly (deadline is stored as string in projects)
      return String(ts);
    }

    const params = {
      projectId:           contractId,
      // projects store title in both `title` and `projectTitle`
      projectTitle:        data.title || data.projectTitle || 'Service Agreement',
      // projects store scope of work in `scope` (aliased from `description` in create-project.js)
      serviceDescription:  data.scope || data.description || '',
      // projects store budget in `amount` and `budget`
      budget:              data.amount || data.budget || 0,
      deadline:            toIso(data.deadline),
      freelancerName:      data.freelancerName      || '',
      freelancerUsername:  data.freelancerUsername  || '',
      freelancerSignature: data.freelancerSignature || '',
      freelancerSignedAt:  toIso(data.freelancerSignedAt),
      freelancerIp:        data.freelancerIp        || '',
      buyerName:           data.buyerName           || '',
      buyerEmail:          data.buyerEmail          || '',
      buyerSignature:      data.buyerSignature      || '',
      buyerSignedAt:       toIso(data.buyerSignedAt),
      buyerIp:             data.buyerIp             || '',
      agreementDate:       new Date().toLocaleDateString('en-US', {
                             month: 'long', day: 'numeric', year: 'numeric',
                           }),
      preview: true,
    };

    let pdfBytes;
    try {
      pdfBytes = await generatePdf(params);
    } catch (genErr) {
      console.error('[download-contract] PDF generation failed:', genErr);
      return new Response('PDF generation failed', { status: 500 });
    }

    // Pass through the binary PDF
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="kreddlo-contract-${contractId}.pdf"`,
        'Cache-Control':       'private, no-store',
      },
    });

  } catch (err) {
    console.error('[download-contract]', err);
    return new Response(err.message || 'Download failed', { status: 500 });
  }
}
};

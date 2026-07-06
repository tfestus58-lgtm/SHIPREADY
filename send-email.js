// netlify/functions/send-email.js
// Kreddlo Platform — Transactional Email Service via Brevo API
// All 15 templates from Section 15 of the master build spec.
// Mobile-responsive email layout with inline styles for maximum client compatibility.

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
import { sanitizeString, sanitizeEmail } from './_sanitize';

// Live site domain — used for every link inside transactional emails.
// NOTE: Workers modules load once at startup, before any request exists,
// so `env` is not available at module scope. This starts as a safe
// hardcoded fallback and is overwritten with the real env-sourced value
// at the top of fetch(request, env, ctx) on every request, before any
// template function (which reference this binding directly) is called.
let PLATFORM_URL = 'https://kreddlo.space';

const BRAND = {
  navy:      '#0d2145',
  navyDeep:  '#091830',
  green:     '#2d8a5e',
  greenLight:'#3dbd7a',
  greenPale: '#e8f5ef',
  cream:     '#f8f9fb',
  border:    '#e2e8f0',
  textMuted: 'rgba(13,33,69,0.50)',
  textBody:  'rgba(13,33,69,0.70)',
  error:     '#c81e1e',
  warning:   '#856404',
};

// ---------------------------------------------------------------------------
// Base layout — shared wrapper for every email
// Fully table-based for Outlook compatibility.
// Mobile-first: single column at 100% width, max 600px on wider screens.
// ---------------------------------------------------------------------------
function baseLayout(subject, preheader, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${subject}</title>
  <!-- Plus Jakarta Sans — matches the website wordmark. Clients that strip
       external stylesheets (Outlook desktop, some Gmail contexts) simply
       ignore this link and fall through to the Arial/Helvetica fallback
       chain set on every element below; this can only add fidelity, it
       can never break rendering. -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <!--[if mso]>
  <noscript>
    <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  </noscript>
  <![endif]-->
  <style>
    /* Reset */
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    /* Base */
    body { margin: 0 !important; padding: 0 !important; background-color: ${BRAND.cream}; width: 100% !important; }
    /* Mobile overrides */
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .content-padding { padding: 24px 20px !important; }
      .header-padding  { padding: 24px 20px 20px !important; }
      .footer-padding  { padding: 20px 20px 28px !important; }
      .stat-value      { font-size: 28px !important; }
      .code-value      { font-size: 32px !important; letter-spacing: 6px !important; }
      h1               { font-size: 20px !important; }
      .btn             { display: block !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.cream};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">

  <!-- Preheader (hidden inbox preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:${BRAND.cream};">
    ${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
  </div>

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.cream};padding:32px 16px;">
    <tr>
      <td align="center">

        <!-- Email container -->
        <table role="presentation" class="email-container" cellpadding="0" cellspacing="0"
          style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(13,33,69,0.08);">

          <!-- HEADER -->
          <tr>
            <td class="header-padding" style="padding:36px 40px 28px;border-bottom:1px solid ${BRAND.border};text-align:center;">
              <!-- Text logo — no image so it renders even when images are blocked.
                   Font matches the website wordmark (Plus Jakarta Sans, weight 800)
                   with the same Arial/Helvetica fallback used everywhere else. -->
              <div style="margin:0 0 10px;">
                <span style="font-size:24px;font-weight:800;color:${BRAND.navy};letter-spacing:-0.5px;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Kreddl</span><span style="font-size:24px;font-weight:800;color:${BRAND.green};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">o</span>
              </div>
              <div style="width:28px;height:3px;background-color:${BRAND.green};border-radius:2px;margin:0 auto;"></div>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td class="content-padding" style="padding:40px 40px 32px;">
              ${bodyContent}
            </td>
          </tr>

          <!-- DIVIDER -->
          <tr>
            <td style="padding:0 40px;">
              <div style="height:1px;background-color:${BRAND.border};"></div>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td class="footer-padding" style="padding:24px 40px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:${BRAND.textBody};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">
                You received this email because you have an account on Kreddlo.
              </p>
              <p style="margin:0 0 8px;font-size:12px;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">
                <a href="${PLATFORM_URL}" style="color:${BRAND.green};text-decoration:none;font-weight:600;">${PLATFORM_URL.replace(/^https?:\/\//, '')}</a>
                &nbsp;&bull;&nbsp;
                <a href="${PLATFORM_URL}/privacy.html" style="color:${BRAND.green};text-decoration:none;font-weight:600;">Privacy</a>
                &nbsp;&bull;&nbsp;
                <a href="${PLATFORM_URL}/terms.html" style="color:${BRAND.green};text-decoration:none;font-weight:600;">Terms</a>
              </p>
              <p style="margin:0;font-size:11px;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">
                &copy; ${new Date().getFullYear()} Kreddlo. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
        <!-- /email container -->

      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Reusable HTML building blocks (inline styles — required for email clients)
// ---------------------------------------------------------------------------

function badge(text, color = BRAND.green, bg = BRAND.greenPale) {
  return `<p style="margin:0 0 14px;"><span style="display:inline-block;background-color:${bg};color:${color};padding:4px 14px;border-radius:50px;font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${text}</span></p>`;
}

function heading(text) {
  return `<h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:${BRAND.navy};letter-spacing:-0.5px;line-height:1.3;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${text}</h1>`;
}

function bodyText(text) {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${BRAND.textBody};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${text}</p>`;
}

function highlightBox(content) {
  return `<div style="background-color:${BRAND.cream};border:1px solid ${BRAND.border};border-left:3px solid ${BRAND.green};border-radius:14px;padding:22px 24px;margin:20px 0;box-shadow:0 4px 16px rgba(13,33,69,0.08);">${content}</div>`;
}

function infoRow(label, value, isLast = false) {
  const border = isLast ? '' : `border-bottom:1px solid ${BRAND.border};`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 0;font-size:14px;color:${BRAND.textBody};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;${border}">${label}</td>
        <td style="padding:8px 0;font-size:14px;font-weight:600;color:${BRAND.navy};text-align:right;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;${border}">${value}</td>
      </tr>
    </table>`;
}

function btn(label, href, color = BRAND.navy) {
  return `<p style="margin:24px 0 8px;"><a href="${href}" class="btn" style="display:inline-block;background-color:${color};color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:600;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${label}</a></p>`;
}

function divider() {
  return `<div style="height:1px;background-color:${BRAND.border};margin:24px 0;"></div>`;
}

function mutedText(text) {
  return `<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${text}</p>`;
}

// ---------------------------------------------------------------------------
// TEMPLATE 1: welcome
// ---------------------------------------------------------------------------
function templateWelcome({ name = 'there' }) {
  const preheader = `Welcome to Kreddlo, ${name}. Complete verification to get started.`;
  const body = `
    ${badge('Welcome')}
    ${heading(`Welcome aboard, ${name}.`)}
    ${bodyText('Your Kreddlo account has been created. You now have access to a platform built for freelancers in countries that mainstream payment providers have left behind.')}
    ${bodyText('Before you can accept payments or appear in the freelancer directory, you need to complete identity verification. The process takes a few minutes and is handled securely through our verification partner.')}
    ${highlightBox(`
      <p style="margin:0 0 6px;font-weight:700;font-size:14px;color:${BRAND.navy};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Your next step</p>
      <p style="margin:0;font-size:14px;color:${BRAND.textBody};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Complete your KYC verification to unlock payments and your public profile.</p>
    `)}
    ${btn('Complete Verification', `${PLATFORM_URL}/dashboard.html`, BRAND.green)}
    ${divider()}
    ${mutedText('If you did not create this account, please disregard this email. No action is required.')}
  `;
  return { subject: `Welcome to Kreddlo, ${name}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 2: kyc-approved
// ---------------------------------------------------------------------------
function templateKycApproved({ name = 'there' }) {
  const preheader = 'Your identity has been verified. Your Kreddlo profile is now live.';
  const body = `
    ${badge('Verified', BRAND.green, BRAND.greenPale)}
    ${heading('You are verified.')}
    ${bodyText(`Hi ${name}, your identity verification was approved. Your Kreddlo profile is now active and visible to clients worldwide.`)}
    ${bodyText('You can now receive payments, sign contracts, and withdraw your earnings to your preferred wallet.')}
    ${btn('Go to Dashboard', `${PLATFORM_URL}/dashboard.html`, BRAND.green)}
  `;
  return { subject: 'Your identity has been verified', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 3: kyc-under-review
// ---------------------------------------------------------------------------
function templateKycUnderReview({ name = 'there' }) {
  const preheader = 'Your verification documents are under review. We will email you within 1 to 2 business days.';
  const body = `
    ${badge('Under Review', BRAND.warning, '#fff3cd')}
    ${heading('We are reviewing your documents.')}
    ${bodyText(`Hi ${name}, your identity verification submission is being reviewed by our team.`)}
    ${bodyText('This typically takes 1 to 2 business days. You will receive an email as soon as a decision is made. There is nothing more you need to do right now.')}
    ${divider()}
    ${mutedText('While you wait, you can log in and prepare your profile description and skill tags so everything is ready once approved.')}
  `;
  return { subject: 'Verification under review', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 4: kyc-declined
// ---------------------------------------------------------------------------
function templateKycDeclined({ name = 'there', reason = '' }) {
  const preheader = 'Your identity verification was not approved. You can resubmit with clearer documents.';
  const body = `
    ${badge('Not Approved', BRAND.error, '#fde8e8')}
    ${heading('We could not verify your identity.')}
    ${bodyText(`Hi ${name}, unfortunately we were unable to verify your identity at this time.`)}
    ${reason ? highlightBox(`
      <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.error};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Reason</p>
      <p style="margin:0;font-size:14px;line-height:1.55;color:${BRAND.textBody};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${reason}</p>
    `) : bodyText('This can happen if document images were unclear, cropped, or expired. You can resubmit with clear photos of a valid government-issued ID. Make sure both sides are fully visible and the selfie matches the photo on your document.')}
    ${btn('Try Again', `${PLATFORM_URL}/verify.html`, BRAND.navy)}
    ${divider()}
    ${mutedText('If you believe this is an error, reply to this email and our team will assist you.')}
  `;
  return { subject: 'Verification not approved', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 5: contract-signed
// ---------------------------------------------------------------------------
function templateContractSigned({ name = 'there', projectTitle = 'Your project', otherPartyName = '', contractUrl = '' }) {
  const preheader = `The contract for "${projectTitle}" has been signed by both parties.`;
  const dashUrl = contractUrl || `${PLATFORM_URL}/dashboard-contracts.html`;
  const body = `
    ${badge('Contract Signed')}
    ${heading('Both parties have signed.')}
    ${bodyText(`Hi ${name}, the service agreement for the project below has been signed by both parties and is now in effect.`)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${infoRow('Other Party', otherPartyName || 'Counterparty', true)}
    `)}
    ${bodyText('The client can now proceed to fund the escrow to begin work.')}
    ${btn('View Project', dashUrl, BRAND.navy)}
    ${divider()}
    ${mutedText('Funds are held securely in escrow and will only be released upon delivery approval.')}
  `;
  return { subject: `Your contract is ready: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 6: payment-received
// ---------------------------------------------------------------------------
function templatePaymentReceived({ name = 'there', projectTitle = 'Your project', amount = '', buyerName = '' }) {
  const preheader = `Escrow funded for "${projectTitle}". You can begin work.`;
  const body = `
    ${badge('Escrow Funded')}
    ${heading('Your escrow has been funded.')}
    ${bodyText(`Hi ${name}, the client has paid for the project below. The funds are held securely in escrow and will be released to you once you deliver and the client approves.`)}
    ${highlightBox(`
      <div style="text-align:center;padding:8px 0;">
        <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Amount in Escrow</p>
        <p class="stat-value" style="margin:4px 0;font-size:36px;font-weight:800;color:${BRAND.navy};letter-spacing:-1px;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${amount}</p>
        ${buyerName ? `<p style="margin:0;font-size:13px;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">From ${buyerName}</p>` : ''}
      </div>
    `)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${infoRow('Status', '<span style="color:#2d8a5e;font-weight:600;">In Escrow</span>', true)}
    `)}
    ${btn('View Project', `${PLATFORM_URL}/dashboard-projects.html`, BRAND.navy)}
  `;
  return { subject: `Payment received: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 6b: payment-confirmed-buyer
// Sent to the BUYER after a Flutterwave project payment is confirmed.
// Mirrors the layout of payment-received (sent to the freelancer) but
// reframes the message from the buyer's perspective: their money is safe
// in escrow and work is now underway.
// ---------------------------------------------------------------------------
function templatePaymentConfirmedBuyer({ name = 'there', projectTitle = 'Your project', amount = '', freelancerName = '', dashboardUrl = '' }) {
  const preheader = `Your payment for "${projectTitle}" is secured in escrow. Work has begun.`;
  const viewUrl   = dashboardUrl || `${PLATFORM_URL}/buyer-projects.html`;
  const body = `
    ${badge('Payment Confirmed')}
    ${heading('Your payment is secured.')}
    ${bodyText(`Hi ${name}, your payment has been received and is held securely in escrow. It will only be released to the freelancer once you approve the delivered work.`)}
    ${highlightBox(`
      <div style="text-align:center;padding:8px 0;">
        <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Amount in Escrow</p>
        <p class="stat-value" style="margin:4px 0;font-size:36px;font-weight:800;color:${BRAND.navy};letter-spacing:-1px;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${amount}</p>
        ${freelancerName ? `<p style="margin:0;font-size:13px;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Assigned to ${freelancerName}</p>` : ''}
      </div>
    `)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${infoRow('Status', '<span style="color:#2d8a5e;font-weight:600;">In Escrow — Work in Progress</span>', true)}
    `)}
    ${bodyText('You will be notified when the freelancer submits the completed work for your review. You can also monitor progress from your buyer dashboard at any time.')}
    ${btn('View Project', viewUrl, BRAND.green)}
    ${divider()}
    ${mutedText('Funds are released to the freelancer only after you approve the delivery. If you are unsatisfied, you can raise a dispute from your project page.')}
  `;
  return { subject: `Payment confirmed: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 7: work-delivered
// ---------------------------------------------------------------------------
function templateWorkDelivered({ name = 'there', projectTitle = 'Your project', freelancerName = 'The freelancer', deliveryNote = '' }) {
  const preheader = `${freelancerName} has marked "${projectTitle}" as delivered and is awaiting your review.`;
  const body = `
    ${badge('Work Delivered')}
    ${heading('Review and approve.')}
    ${bodyText(`Hi ${name}, ${freelancerName} has marked the project below as delivered and is requesting your review.`)}
    ${highlightBox(`
      <p style="margin:0 0 4px;font-size:13px;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Project</p>
      <p style="margin:0;font-size:16px;font-weight:700;color:${BRAND.navy};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${projectTitle}</p>
      ${deliveryNote ? `<div style="height:1px;background:${BRAND.border};margin:12px 0;"></div><p style="margin:0;font-size:14px;color:${BRAND.textBody};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${deliveryNote}</p>` : ''}
    `)}
    ${bodyText('If you are satisfied with the work, approve the delivery to release the escrowed funds. If there is an issue, you can raise a dispute from your dashboard.')}
    ${btn('Review and Approve', `${PLATFORM_URL}/buyer-projects.html`, BRAND.green)}
    ${divider()}
    ${mutedText('Escrow funds are released automatically 7 days after delivery if no action is taken.')}
  `;
  return { subject: `Work delivered: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 8: withdrawal-initiated
// ---------------------------------------------------------------------------
function templateWithdrawalInitiated({ name = 'there', amount = '', currency = 'USDT', walletAddress = '', network = '' }) {
  const masked = walletAddress && walletAddress.length > 14
    ? walletAddress.slice(0, 6) + '...' + walletAddress.slice(-6)
    : (walletAddress || 'on file');
  const preheader = `Your withdrawal of ${amount} ${currency} has been initiated.`;
  const body = `
    ${badge('Withdrawal Initiated')}
    ${heading('Your withdrawal is on its way.')}
    ${bodyText(`Hi ${name}, your withdrawal request has been received and is now being processed.`)}
    ${highlightBox(`
      <div style="text-align:center;padding:8px 0;">
        <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Withdrawal Amount</p>
        <p class="stat-value" style="margin:4px 0;font-size:36px;font-weight:800;color:${BRAND.navy};letter-spacing:-1px;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${amount} <span style="font-size:18px;font-weight:600;">${currency}</span></p>
      </div>
    `)}
    ${highlightBox(`
      ${infoRow('Destination Wallet', `<span style="font-family:monospace;">${masked}</span>`)}
      ${network ? infoRow('Network', network) : ''}
      ${infoRow('Status', '<span style="color:#856404;font-weight:600;">Processing</span>', true)}
    `)}
    ${bodyText('You will receive a confirmation once the transfer has been sent to your wallet.')}
    ${btn('View Dashboard', `${PLATFORM_URL}/dashboard-withdraw.html`, BRAND.navy)}
    ${divider()}
    ${mutedText('If you did not initiate this withdrawal, contact our support team immediately.')}
  `;
  return { subject: `Withdrawal sent: ${amount} ${currency}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 8b: withdrawal-failed — sent by nowpayments-payout-webhook.js when
// a payout fails/rejects AFTER the balance was deducted; balance is restored
// before this email goes out.
// ---------------------------------------------------------------------------
function templateWithdrawalFailed({ name = 'there', amount = '', payoutId = '' }) {
  const preheader = `Your withdrawal of ${amount} could not be completed — it's been refunded to your balance.`;
  const body = `
    ${badge('Withdrawal Failed', BRAND.error, '#fde8e8')}
    ${heading('Your withdrawal did not go through.')}
    ${bodyText(`Hi ${name}, unfortunately your withdrawal could not be completed. No funds were lost — we've returned the full amount to your available balance.`)}
    ${highlightBox(`
      <div style="text-align:center;padding:8px 0;">
        <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Amount Restored</p>
        <p class="stat-value" style="margin:4px 0;font-size:36px;font-weight:800;color:${BRAND.navy};letter-spacing:-1px;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${amount}</p>
      </div>
    `)}
    ${bodyText('You can try the withdrawal again from your dashboard. If this keeps happening, please reach out to our support team.')}
    ${btn('Go to Dashboard', `${PLATFORM_URL}/dashboard-withdraw.html`, BRAND.navy)}
    ${divider()}
    ${mutedText(`Reference: ${payoutId}`)}
  `;
  return { subject: `Withdrawal failed: ${amount} refunded to your balance`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 9: dispute-raised
// ---------------------------------------------------------------------------
function templateDisputeRaised({ name = 'there', projectTitle = 'Your project', raisedByName = 'A party', disputeId = '' }) {
  const preheader = `A dispute has been raised on "${projectTitle}". Submit your evidence within 48 hours.`;
  const body = `
    ${badge('Dispute Raised', BRAND.error, '#fde8e8')}
    ${heading('A dispute has been opened.')}
    ${bodyText(`Hi ${name}, a dispute has been raised on the project below. The Kreddlo team will review all evidence and reach a decision within 3 to 5 business days.`)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${infoRow('Raised By', raisedByName)}
      ${infoRow('Reference', `<span style="font-family:monospace;font-size:12px;">${disputeId}</span>`, true)}
    `)}
    ${bodyText('Log in to your dashboard and submit any evidence that supports your position. Evidence submitted within 48 hours is given the most weight in the review process.')}
    ${divider()}
    ${mutedText('Escrow funds remain frozen until a ruling is issued. Average resolution time is 3 to 5 business days.')}
  `;
  return { subject: `Dispute raised on: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 10: dispute-resolved
// ---------------------------------------------------------------------------
function templateDisputeResolved({ name = 'there', projectTitle = 'Your project', ruling = '', rulingText = '', disputeId = '' }) {
  const rulingLabel = ruling === 'freelancer'
    ? 'In Favour of Freelancer'
    : ruling === 'buyer'
    ? 'In Favour of Buyer'
    : 'Split Decision';
  const rulingColor = ruling === 'freelancer' ? BRAND.green : ruling === 'buyer' ? BRAND.navy : BRAND.warning;
  const preheader = `The dispute on "${projectTitle}" has been resolved.`;
  const body = `
    ${badge('Dispute Resolved')}
    ${heading('A decision has been made.')}
    ${bodyText(`Hi ${name}, the Kreddlo team has reviewed the dispute for the project below and a ruling has been issued.`)}
    ${highlightBox(`
      <div style="text-align:center;padding:8px 0;">
        <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Ruling</p>
        <p style="margin:0;font-size:20px;font-weight:700;color:${rulingColor};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${rulingLabel}</p>
      </div>
    `)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${rulingText ? infoRow('Decision Notes', rulingText) : ''}
      ${infoRow('Reference', `<span style="font-family:monospace;font-size:12px;">${disputeId}</span>`, true)}
    `)}
    ${bodyText('Escrow funds will be distributed according to this ruling within 1 to 2 business days. If you believe this ruling is in error, reply to this email within 14 days to request a review.')}
    ${btn('View Project', `${PLATFORM_URL}/dashboard-projects.html`, BRAND.navy)}
  `;
  return { subject: `Dispute resolved: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 11: premium-activated
// ---------------------------------------------------------------------------
function templatePremiumActivated({ name = 'there' }) {
  const preheader = 'Your Kreddlo Pro plan is now active. Enjoy all premium features.';
  const features = [
    'Verified Pro Badge on your profile',
    'Featured placement in search results',
    'Priority dispute resolution',
    'Advanced earnings analytics',
    'Early payout access',
  ];
  const featureList = features.map(f =>
    `<p style="margin:6px 0;font-size:14px;color:${BRAND.textBody};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">&#10003;&nbsp;&nbsp;${f}</p>`
  ).join('');
  const body = `
    ${badge('Pro Plan Active', BRAND.green, BRAND.greenPale)}
    ${heading('Welcome to Kreddlo Pro.')}
    ${bodyText(`Hi ${name}, your Pro plan is now active. Here is what you have unlocked:`)}
    ${highlightBox(featureList)}
    ${btn('Go to Dashboard', `${PLATFORM_URL}/dashboard.html`, BRAND.green)}
  `;
  return { subject: 'Pro plan activated', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 12: premium-expired
// ---------------------------------------------------------------------------
function templatePremiumExpired({ name = 'there' }) {
  const preheader = 'Your Kreddlo Pro plan has ended. Renew anytime from your settings.';
  const body = `
    ${badge('Subscription Ended', BRAND.warning, '#fff3cd')}
    ${heading('Your Pro plan has ended.')}
    ${bodyText(`Hi ${name}, your Kreddlo Pro plan has ended. Your profile has returned to the standard tier.`)}
    ${bodyText('You can renew anytime from your settings to restore your Pro badge, featured placement, and all other premium features.')}
    ${btn('Renew Pro', `${PLATFORM_URL}/dashboard-settings.html`, BRAND.green)}
  `;
  return { subject: 'Your Pro plan has ended', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 13: boost-purchased
// ---------------------------------------------------------------------------
function templateBoostPurchased({ name = 'there', duration = '' }) {
  const preheader = 'Your profile boost is live. You are now appearing at the top of search results.';
  const body = `
    ${badge('Boost Active', BRAND.green, BRAND.greenPale)}
    ${heading('Your profile is now boosted.')}
    ${bodyText(`Hi ${name}, your profile boost is active and your profile will appear at the top of search results${duration ? ` for ${duration}` : ''}.`)}
    ${bodyText('Make sure your profile is complete, your portfolio is up to date, and your response time is fast to convert the extra visibility into work.')}
    ${btn('View Your Profile', `${PLATFORM_URL}/dashboard.html`, BRAND.navy)}
  `;
  return { subject: 'Profile boost is live', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 14: referral-credited
// ---------------------------------------------------------------------------
function templateReferralCredited({ name = 'there', referredName = 'Someone you referred' }) {
  const preheader = 'You earned a referral credit. It will reduce your next withdrawal fee.';
  const body = `
    ${badge('Credit Earned', BRAND.green, BRAND.greenPale)}
    ${heading('You earned a credit.')}
    ${bodyText(`Hi ${name}, ${referredName} has completed their first project on Kreddlo and you have earned a referral credit.`)}
    ${bodyText('The credit has been added to your account and will automatically reduce the fee on your next withdrawal. Keep sharing your referral link to earn more credits.')}
    ${btn('View Dashboard', `${PLATFORM_URL}/dashboard.html`, BRAND.navy)}
  `;
  return { subject: 'Referral credit earned', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE 15: kyc-declined (alias — some callers use this key)
// Template router maps both 'kyc-declined' and 'kyc-rejected' to this fn.
// ---------------------------------------------------------------------------
// (defined above as templateKycDeclined)

// ---------------------------------------------------------------------------
// Template router
// ---------------------------------------------------------------------------
// email-verification — 6-digit code for custom email verification flow
// ---------------------------------------------------------------------------
function tplEmailVerification({ name = 'there', code = '------' }) {
  const preheader = `Your Kreddlo verification code is ${code}. It expires in 30 minutes.`;
  const body = `
    ${badge('Email Verification')}
    ${heading('Verify your email address.')}
    ${bodyText(`Hi ${name}, thanks for joining Kreddlo. Enter the 6-digit code below to verify your email address and continue setting up your account.`)}
    ${highlightBox(`
      <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#2d8a5e;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Your verification code</p>
      <p class="code-value" style="margin:0;font-size:44px;font-weight:800;letter-spacing:10px;color:#0d2145;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;line-height:1.1;">${code}</p>
      <p style="margin:10px 0 0;font-size:12px;color:rgba(13,33,69,0.50);font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Expires in 30 minutes</p>
    `)}
    ${divider()}
    ${mutedText('If you did not create a Kreddlo account you can safely ignore this email.')}
  `;
  return { subject: 'Your Kreddlo verification code', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: withdrawal-otp — 6-digit OTP sent before a withdrawal is processed
// ---------------------------------------------------------------------------
function tplWithdrawalOtp({ name = 'there', code = '------' }) {
  const preheader = `Your Kreddlo withdrawal code is ${code}. It expires in 10 minutes.`;
  const body = `
    ${badge('Withdrawal Verification', BRAND.navy, '#fff')}
    ${heading('Confirm your withdrawal.')}
    ${bodyText(`Hi ${name}, we received a withdrawal request on your Kreddlo account. Enter the 6-digit code below to authorise it.`)}
    ${highlightBox(`
      <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#2d8a5e;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Your withdrawal code</p>
      <p class="code-value" style="margin:0;font-size:44px;font-weight:800;letter-spacing:10px;color:#0d2145;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;line-height:1.1;">${code}</p>
      <p style="margin:10px 0 0;font-size:12px;color:rgba(13,33,69,0.50);font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Expires in 10 minutes &bull; Single use only</p>
    `)}
    ${divider()}
    ${mutedText('If you did not request this withdrawal, contact our support team immediately and do not share this code with anyone.')}
  `;
  return { subject: 'Your Kreddlo withdrawal verification code', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: product-delivery
// Receives: name, productTitle, deliveryType, deliveryContent, sellerName
// ---------------------------------------------------------------------------
function templateProductDelivery({ name = 'there', productTitle = 'your product', deliveryType = 'link', deliveryContent = '#', sellerName = 'the seller' }) {
  const preheader = `Your order for ${productTitle} from ${sellerName} is ready.`;

  let deliveryBlock = '';
  if (deliveryType === 'download') {
    deliveryBlock = btn('Download Now', deliveryContent, BRAND.green);
  } else if (deliveryType === 'link') {
    deliveryBlock = btn('Access Now', deliveryContent, BRAND.green);
  } else if (deliveryType === 'coaching') {
    deliveryBlock = `
      ${mutedText('Your session link is:')}
      <div style="background-color:${BRAND.greenPale};border:1px solid ${BRAND.green};border-radius:10px;padding:16px 20px;margin:16px 0;">
        <a href="${deliveryContent}" style="font-size:14px;color:${BRAND.green};font-weight:600;word-break:break-all;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${deliveryContent}</a>
      </div>`;
  } else if (deliveryType === 'course' && Array.isArray(deliveryContent)) {
    deliveryBlock = deliveryContent.map((link, i) =>
      btn(`Module ${i + 1}`, link, BRAND.green)
    ).join('');
  } else {
    deliveryBlock = btn('Access Now', deliveryContent, BRAND.green);
  }

  const body = `
    ${heading('Here is what you purchased.')}
    ${bodyText(`Hi ${name}, your order for <strong>${productTitle}</strong> from ${sellerName} is ready.`)}
    ${deliveryBlock}
    ${divider()}
    ${mutedText('If you have any issues, reply to this email and we will help you out.')}
  `;
  return { subject: 'Your purchase is ready', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: review-request
// Receives: name, productTitle, reviewUrl, sellerName
// ---------------------------------------------------------------------------
function templateReviewRequest({ name = 'there', productTitle = 'your product', reviewUrl = '#', sellerName = 'the seller' }) {
  const preheader = `How was your experience with ${productTitle}?`;
  const body = `
    ${heading('Leave a quick review.')}
    ${bodyText(`Hi ${name}, we hope you are enjoying <strong>${productTitle}</strong> from ${sellerName}.`)}
    ${bodyText('Your honest review helps other buyers make confident decisions.')}
    ${btn('Leave a Review', reviewUrl, BRAND.green)}
    ${mutedText('Takes less than 60 seconds.')}
  `;
  return { subject: `How was your experience with ${productTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: product-sale
// Receives: name, buyerName, buyerEmail, productTitle, amount
// ---------------------------------------------------------------------------
function templateProductSale({ name = 'there', buyerName = 'A buyer', buyerEmail = '', productTitle = 'your product', amount = '0' }) {
  const preheader = `${buyerName} just purchased ${productTitle}.`;
  const body = `
    ${heading(`New sale on ${productTitle}.`)}
    ${bodyText(`Hi ${name}, <strong>${buyerName}</strong> (${buyerEmail}) just purchased <strong>${productTitle}</strong> for <strong>$${amount} USD</strong>.`)}
    ${bodyText('The funds will be available in your dashboard shortly.')}
    ${btn('View Dashboard', `${PLATFORM_URL}/dashboard.html`, BRAND.navy)}
  `;
  return { subject: 'You made a sale', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: new-review
// Receives: name (client name), invoiceNumber, amount, freelancerName, payLink, dueDate
// ---------------------------------------------------------------------------
function templateInvoiceSent({ name = 'there', invoiceNumber = '', amount = '', freelancerName = 'Your Kreddlo freelancer', payLink = PLATFORM_URL, dueDate = '' }) {
  const preheader = `${freelancerName} sent you an invoice for ${amount}.`;
  const body = `
    ${badge('Invoice')}
    ${heading(`You have a new invoice from ${freelancerName}.`)}
    ${bodyText(`Hi ${name}, ${freelancerName} has sent you an invoice${invoiceNumber ? ` (${invoiceNumber})` : ''} for <strong>${amount}</strong>.`)}
    ${highlightBox(`
      ${infoRow('Invoice', invoiceNumber || '—')}
      ${infoRow('Amount Due', amount)}
      ${infoRow('Due Date', dueDate || 'On receipt', true)}
    `)}
    ${btn('View & Pay Invoice', payLink, BRAND.green)}
    ${mutedText('No account or sign-up is required to view or pay this invoice.')}
  `;
  return { subject: `New invoice from ${freelancerName}${invoiceNumber ? ` — ${invoiceNumber}` : ''}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: invoice-paid
// Sent to the freelancer when their client pays an invoice.
// Receives: name (freelancer name), invoiceNumber, amount, clientName
// ---------------------------------------------------------------------------
function templateInvoicePaid({ name = 'there', invoiceNumber = '', amount = '', clientName = 'Your client' }) {
  const preheader = `${clientName} paid invoice ${invoiceNumber} — ${amount}.`;
  const body = `
    ${badge('Payment Received', BRAND.green, BRAND.greenPale)}
    ${heading(`${clientName} paid your invoice.`)}
    ${bodyText(`Hi ${name}, great news — your invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} has been paid in full.`)}
    ${highlightBox(`
      ${infoRow('Invoice', invoiceNumber || '—')}
      ${infoRow('Paid By', clientName)}
      ${infoRow('Amount', amount, true)}
    `)}
    ${btn('View Invoices', `${PLATFORM_URL}/dashboard-invoices.html`, BRAND.navy)}
  `;
  return { subject: `Paid: Invoice ${invoiceNumber || ''} — ${amount}`, preheader, body };
}

// Receives: name, reviewerName, productTitle, rating, comment
// ---------------------------------------------------------------------------
function templateNewReview({ name = 'there', reviewerName = 'Someone', productTitle = 'your product', rating = 5, comment = '' }) {
  const preheader = `${reviewerName} left you a ${rating}/5 rating on ${productTitle}.`;
  const body = `
    ${heading(`${reviewerName} left you a rating of ${rating} out of 5.`)}
    ${bodyText(`Hi ${name}, you received a new review on <strong>${productTitle}</strong>.`)}
    <div style="border-left:4px solid ${BRAND.green};background-color:${BRAND.cream};border-radius:0 10px 10px 0;padding:16px 20px;margin:20px 0;">
      <p style="margin:0;font-size:15px;line-height:1.55;color:${BRAND.textBody};font-style:italic;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${comment}</p>
    </div>
    ${btn('View Profile', `${PLATFORM_URL}/profile.html`, BRAND.navy)}
  `;
  return { subject: 'New review on your profile', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: invoice-escrow-held-seller
// Sent to the freelancer when their invoice payment is held in escrow.
// ---------------------------------------------------------------------------
function templateInvoiceEscrowHeldSeller({ name = 'there', invoiceNumber = '', amount = '', dashboardUrl = PLATFORM_URL }) {
  const preheader = `Payment for invoice ${invoiceNumber} is held in escrow — deliver your work to release funds.`;
  const body = `
    ${badge('Payment in Escrow', BRAND.green, BRAND.greenPale)}
    ${heading('Your invoice payment is secured.')}
    ${bodyText(`Hi ${name}, payment for invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} has been received and is safely held in escrow.`)}
    ${highlightBox(`
      ${infoRow('Invoice', invoiceNumber || '—')}
      ${infoRow('Amount Held', amount, true)}
    `)}
    ${bodyText('Deliver your work and click "Mark as Delivered" on your dashboard. Once your client confirms receipt, funds will be released to your available balance.')}
    ${btn('Go to Invoices', dashboardUrl, BRAND.navy)}
  `;
  return { subject: `Payment in escrow — Invoice ${invoiceNumber || ''}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: invoice-escrow-held-buyer
// Sent to the buyer after their payment is placed in escrow.
// ---------------------------------------------------------------------------
function templateInvoiceEscrowHeldBuyer({ name = 'there', freelancerName = 'The freelancer', invoiceNumber = '', amount = '' }) {
  const preheader = `Your payment of ${amount} is secured in escrow for invoice ${invoiceNumber}.`;
  const body = `
    ${badge('Payment Secured', BRAND.green, BRAND.greenPale)}
    ${heading('Your payment is held safely in escrow.')}
    ${bodyText(`Hi ${name}, your payment for invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} has been received and is being held in escrow by Kreddlo.`)}
    ${highlightBox(`
      ${infoRow('Invoice', invoiceNumber || '—')}
      ${infoRow('Paid To (Escrow)', freelancerName)}
      ${infoRow('Amount', amount, true)}
    `)}
    ${bodyText(`${freelancerName} will deliver your work shortly. You will receive a confirmation link by email — clicking it releases payment to the freelancer. If you have any concerns, you can raise a dispute directly from the invoice page.`)}
  `;
  return { subject: `Payment secured in escrow — Invoice ${invoiceNumber || ''}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: invoice-delivered-buyer
// Sent to the buyer when the freelancer marks the invoice as delivered.
// ---------------------------------------------------------------------------
function templateInvoiceDeliveredBuyer({ name = 'there', freelancerName = 'The freelancer', invoiceNumber = '', confirmUrl = PLATFORM_URL }) {
  const preheader = `${freelancerName} has delivered invoice ${invoiceNumber}. Confirm to release payment.`;
  const body = `
    ${badge('Work Delivered', BRAND.green, BRAND.greenPale)}
    ${heading(`${freelancerName} has marked your order as delivered.`)}
    ${bodyText(`Hi ${name}, ${freelancerName} has marked invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} as delivered. Please review the work and confirm receipt to release payment.`)}
    ${btn('Confirm Delivery & Release Payment', confirmUrl, BRAND.green)}
    ${mutedText('If you did not receive the work or have concerns, you can raise a dispute from the invoice page instead of confirming.')}
  `;
  return { subject: `Delivery confirmation needed — Invoice ${invoiceNumber || ''}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: invoice-delivered-seller
// Sent to the freelancer confirming they have marked delivery.
// ---------------------------------------------------------------------------
function templateInvoiceDeliveredSeller({ name = 'there', invoiceNumber = '', clientName = 'Your client', dashboardUrl = PLATFORM_URL }) {
  const preheader = `Delivery submitted for invoice ${invoiceNumber}. Waiting for client confirmation.`;
  const body = `
    ${badge('Delivery Submitted', BRAND.navy, '#e8edf5')}
    ${heading('Delivery marked — waiting for client.')}
    ${bodyText(`Hi ${name}, you have successfully marked invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} as delivered. ${clientName} has been sent a confirmation link.`)}
    ${bodyText('Once they confirm receipt, your funds will be released to your available balance. If they do not confirm within the escrow window, funds will be released automatically.')}
    ${btn('View Invoices', dashboardUrl, BRAND.navy)}
  `;
  return { subject: `Delivery submitted — Invoice ${invoiceNumber || ''}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: invoice-escrow-released
// Sent to the freelancer when funds are released from escrow.
// ---------------------------------------------------------------------------
function templateInvoiceEscrowReleased({ name = 'there', invoiceNumber = '', amount = '', dashboardUrl = PLATFORM_URL }) {
  const preheader = `${amount} released to your balance for invoice ${invoiceNumber}.`;
  const body = `
    ${badge('Funds Released', BRAND.green, BRAND.greenPale)}
    ${heading('Your payment has been released!')}
    ${bodyText(`Hi ${name}, the escrow hold for invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} has been cleared and ${amount} is now available in your balance.`)}
    ${btn('View Earnings', dashboardUrl, BRAND.green)}
  `;
  return { subject: `Payment released — Invoice ${invoiceNumber || ''}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: bank-withdrawal-initiated
// (Audit finding N3) — sent to a freelancer who withdraws to a bank account
// via create-bank-payout.js. Distinct from templateWithdrawalInitiated above,
// which is wallet/crypto-specific (walletAddress, network) and has no fields
// for bank details — reusing it here would render a bank withdrawal email
// with a blank/placeholder "Destination Wallet" line. This template matches
// the { name, amount, currency, bankName, accountNumber, payoutId, newBalance,
// date } shape create-bank-payout.js already sends.
// ---------------------------------------------------------------------------
function templateBankWithdrawalInitiated({ name = 'there', amount = '', currency = '', bankName = '', accountNumber = '', payoutId = '', newBalance = '', date = '' }) {
  const preheader = `Your withdrawal of ${amount} to ${bankName || 'your bank account'} has been initiated.`;
  const body = `
    ${badge('Withdrawal Initiated')}
    ${heading('Your bank withdrawal is on its way.')}
    ${bodyText(`Hi ${name}, your withdrawal request has been received and is now being processed.`)}
    ${highlightBox(`
      <div style="text-align:center;padding:8px 0;">
        <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">Withdrawal Amount</p>
        <p class="stat-value" style="margin:4px 0;font-size:36px;font-weight:800;color:${BRAND.navy};letter-spacing:-1px;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;">${amount}</p>
      </div>
    `)}
    ${highlightBox(`
      ${bankName ? infoRow('Bank', bankName) : ''}
      ${accountNumber ? infoRow('Account', `<span style="font-family:monospace;">${accountNumber}</span>`) : ''}
      ${date ? infoRow('Date', date) : ''}
      ${infoRow('Status', '<span style="color:#856404;font-weight:600;">Processing</span>', true)}
    `)}
    ${newBalance ? bodyText(`Your remaining available balance is <strong>${newBalance}</strong>.`) : ''}
    ${bodyText('You will receive a confirmation once the transfer has been completed by your bank.')}
    ${btn('View Dashboard', `${PLATFORM_URL}/dashboard-withdraw.html`, BRAND.navy)}
    ${divider()}
    ${mutedText(`If you did not initiate this withdrawal, contact our support team immediately.${payoutId ? ` Reference: ${payoutId}.` : ''}`)}
  `;
  return { subject: `Bank withdrawal initiated — ${amount}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: guest-purchase-welcome
// (Audit finding N3) — sent to a guest buyer after create-product-order.js
// auto-creates a passwordless account for them. Distinct from templateWelcome
// above, which is freelancer/KYC-focused copy ("complete verification to
// unlock payments") and has no field for a password-reset link at all. This
// template matches the { name, email, resetLink } shape already queued by
// create-product-order.js via email-queue.
// ---------------------------------------------------------------------------
function templateGuestPurchaseWelcome({ name = 'there', email = '', resetLink = PLATFORM_URL }) {
  const preheader = `Set a password to view your purchase and order history on Kreddlo.`;
  const body = `
    ${badge('Purchase Confirmed', BRAND.green, BRAND.greenPale)}
    ${heading('Thanks for your purchase!')}
    ${bodyText(`Hi ${name}, thanks for your order on Kreddlo. We've created an account for you${email ? ` using ${email}` : ''} so you can track your purchase and access it anytime.`)}
    ${bodyText('Set a password to finish setting up your account and view your order in My Purchases.')}
    ${btn('Set Your Password', resetLink, BRAND.green)}
    ${divider()}
    ${mutedText('This link is used to set your password and is unique to your account. If you did not make this purchase, please contact our support team.')}
  `;
  return { subject: 'Set your password to access your Kreddlo purchase', preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: new-project-request
// (Audit finding N3) — sent to a freelancer when a buyer initiates a custom
// project and signs the contract first. Currently dormant (create-project.js
// calls this with emailMode: 'never'), but the templateId is corrected here
// so it isn't a landmine if emailMode is ever flipped to an active mode.
// Matches the { projectTitle, buyerName } shape create-project.js sends.
// ---------------------------------------------------------------------------
function templateNewProjectRequest({ projectTitle = 'A new project', buyerName = 'A client' }) {
  const preheader = `${buyerName} wants to hire you for "${projectTitle}". Your countersignature is needed.`;
  const body = `
    ${badge('New Project Request')}
    ${heading('You have a new project request.')}
    ${bodyText(`${buyerName} would like to hire you and has signed the contract for the project below. Your countersignature is needed to activate it.`)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${infoRow('Client', buyerName, true)}
    `)}
    ${btn('Review and Sign', `${PLATFORM_URL}/dashboard-projects.html`, BRAND.navy)}
  `;
  return { subject: `New project request: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: contract-active
// (Audit finding N3) — sent to both parties once a contract is signed by
// both sides. Currently dormant (sign-contract.js calls this with
// emailMode: 'never'); templateId corrected here so it isn't a landmine.
// Matches the { contractTitle, name } shape sign-contract.js sends (`name`
// here is the other party's name, passed through as party.other).
// ---------------------------------------------------------------------------
function templateContractActive({ contractTitle = 'Your contract', name = 'the other party' }) {
  const preheader = `"${contractTitle}" has been signed by both parties and is now active.`;
  const body = `
    ${badge('Contract Active', BRAND.green, BRAND.greenPale)}
    ${heading('Your contract is now active.')}
    ${bodyText(`The contract for the project below has been signed by both you and ${name}, and is now in effect.`)}
    ${highlightBox(`
      ${infoRow('Project', contractTitle)}
      ${infoRow('Other Party', name, true)}
    `)}
    ${btn('View Project', `${PLATFORM_URL}/dashboard-projects.html`, BRAND.green)}
  `;
  return { subject: `Contract now active: ${contractTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: contract-sign-requested
// (Audit finding N3) — sent to the second party when the first party signs
// a contract. Currently dormant (sign-contract.js calls this with
// emailMode: 'never'); templateId corrected here so it isn't a landmine.
// Matches the { contractTitle, signerName } shape sign-contract.js sends.
// ---------------------------------------------------------------------------
function templateContractSignRequested({ contractTitle = 'A contract', signerName = 'The other party' }) {
  const preheader = `${signerName} has signed "${contractTitle}". Your signature is needed to activate it.`;
  const body = `
    ${badge('Signature Required', BRAND.warning, '#fff3cd')}
    ${heading('Your signature is needed.')}
    ${bodyText(`${signerName} has signed the contract below. It will become active once you add your signature too.`)}
    ${highlightBox(`
      ${infoRow('Project', contractTitle)}
      ${infoRow('Signed By', signerName, true)}
    `)}
    ${btn('Review and Sign', `${PLATFORM_URL}/dashboard-projects.html`, BRAND.navy)}
  `;
  return { subject: `Signature needed: ${contractTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: contract-declined
// Sent to the other party when a buyer or freelancer declines a contract.
// Currently dormant (decline-contract.js uses emailMode: 'never').
// Stub is here so emailMode can safely be changed to 'always' in future
// without a silent 400 from buildEmail().
// emailData shape: { projectTitle, declinerName, reason }
// ---------------------------------------------------------------------------
function templateContractDeclined({ projectTitle = 'Your project', declinerName = 'The other party', reason = '' }) {
  const preheader = `${declinerName} has declined the contract for "${projectTitle}".`;
  const body = `
    ${badge('Contract Declined', BRAND.error, '#fde8e8')}
    ${heading('This contract has been declined.')}
    ${bodyText(`${declinerName} has declined the contract for the project below. This contract is now cancelled.`)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${reason ? infoRow('Reason', reason, true) : infoRow('Reason', 'No reason provided.', true)}
    `)}
    ${bodyText('You can discuss next steps directly with the other party or start a new contract if both parties wish to proceed.')}
    ${btn('Go to Dashboard', `${PLATFORM_URL}/dashboard-projects.html`, BRAND.navy)}
    ${divider()}
    ${mutedText('If you believe this was a mistake, please contact the other party directly through your project dashboard.')}
  `;
  return { subject: `Contract declined: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: contract-change-proposed
// Sent to the other party when a buyer or freelancer proposes a change
// to an existing contract's terms.
// Currently dormant (propose-changes.js uses emailMode: 'never').
// emailData shape: { projectTitle, proposerName, budget, deadline, scope, message }
// ---------------------------------------------------------------------------
function templateContractChangeProposed({ projectTitle = 'Your project', proposerName = 'The other party', budget = '', deadline = '', scope = '', message = '' }) {
  const preheader = `${proposerName} has proposed changes to "${projectTitle}". Review on your dashboard.`;
  const budgetFormatted = budget
    ? new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(budget)
    : '';
  const body = `
    ${badge('Change Proposed', BRAND.warning, '#fff3cd')}
    ${heading('New change proposal received.')}
    ${bodyText(`${proposerName} has proposed updated terms for the project below. Review the proposal and accept or reject it from your dashboard.`)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${budgetFormatted ? infoRow('Proposed Budget', budgetFormatted) : ''}
      ${deadline ? infoRow('Proposed Deadline', deadline) : ''}
      ${scope ? infoRow('Scope Update', scope) : ''}
      ${message ? infoRow('Message', message, true) : infoRow('Status', '<span style="color:#856404;font-weight:600;">Awaiting Your Response</span>', true)}
    `)}
    ${btn('Review Proposal', `${PLATFORM_URL}/dashboard-projects.html`, BRAND.navy)}
    ${divider()}
    ${mutedText('The original contract terms remain in effect until you accept this proposal.')}
  `;
  return { subject: `Change proposed: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: contract-change-accepted
// Sent to the proposer when the other party accepts their change proposal.
// Currently dormant (propose-changes.js uses emailMode: 'never').
// emailData shape: { projectTitle, responderName, budget, deadline }
// ---------------------------------------------------------------------------
function templateContractChangeAccepted({ projectTitle = 'Your project', responderName = 'The other party', budget = '', deadline = '' }) {
  const preheader = `${responderName} accepted your proposed changes to "${projectTitle}". New terms are now active.`;
  const budgetFormatted = budget
    ? new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(budget)
    : '';
  const body = `
    ${badge('Proposal Accepted', BRAND.green, BRAND.greenPale)}
    ${heading('Your proposal was accepted.')}
    ${bodyText(`${responderName} has accepted your proposed changes to the project below. The new terms are now in effect.`)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${budgetFormatted ? infoRow('New Budget', budgetFormatted) : ''}
      ${deadline ? infoRow('New Deadline', deadline) : ''}
      ${infoRow('Status', '<span style="color:#2d8a5e;font-weight:600;">Terms Updated</span>', true)}
    `)}
    ${btn('View Project', `${PLATFORM_URL}/dashboard-projects.html`, BRAND.green)}
  `;
  return { subject: `Changes accepted: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: contract-change-rejected
// Sent to the proposer when the other party rejects their change proposal.
// Currently dormant (propose-changes.js uses emailMode: 'never').
// emailData shape: { projectTitle, responderName }
// ---------------------------------------------------------------------------
function templateContractChangeRejected({ projectTitle = 'Your project', responderName = 'The other party' }) {
  const preheader = `${responderName} declined your proposed changes to "${projectTitle}". Original terms remain.`;
  const body = `
    ${badge('Proposal Declined', BRAND.error, '#fde8e8')}
    ${heading('Your proposal was declined.')}
    ${bodyText(`${responderName} has declined your proposed changes to the project below. The original contract terms remain in effect.`)}
    ${highlightBox(`
      ${infoRow('Project', projectTitle)}
      ${infoRow('Declined By', responderName)}
      ${infoRow('Status', '<span style="color:#c81e1e;font-weight:600;">Original Terms Still Active</span>', true)}
    `)}
    ${bodyText('You can submit a new proposal or continue under the original terms from your project dashboard.')}
    ${btn('View Project', `${PLATFORM_URL}/dashboard-projects.html`, BRAND.navy)}
    ${divider()}
    ${mutedText('Both parties must agree on any changes before new terms take effect.')}
  `;
  return { subject: `Proposal declined: ${projectTitle}`, preheader, body };
}

// ---------------------------------------------------------------------------
// TEMPLATE: password-reset
// Sent by send-password-reset.js when a user requests a password reset.
// The resetLink is a real Firebase action link — we just send it ourselves
// via Brevo so it is branded and avoids spam / the Firebase no-reply domain.
// ---------------------------------------------------------------------------
function templatePasswordReset({ name = 'there', resetLink = '#' }) {
  const preheader = 'Reset your Kreddlo password — this link expires in 1 hour.';
  const body = `
    ${badge('Password Reset', BRAND.navy, 'rgba(13,33,69,0.07)')}
    ${heading('Reset your password')}
    ${bodyText(`Hi ${name}, we received a request to reset the password for your Kreddlo account.`)}
    ${bodyText('Click the button below to choose a new password. For your security, this link expires in <strong>1 hour</strong>.')}
    ${btn('Reset My Password', resetLink, BRAND.green)}
    ${divider()}
    ${mutedText('If the button above does not work, copy and paste the link below into your browser:')}
    <p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:${BRAND.textMuted};font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;word-break:break-all;">${resetLink}</p>
    ${divider()}
    ${mutedText('If you did not request a password reset, you can safely ignore this email. Your password will not change.')}
    ${mutedText('For security, never share this link with anyone. Kreddlo staff will never ask for it.')}
  `;
  return { subject: 'Reset your Kreddlo password', preheader, body };
}

// Maps the templateId / type string from the POST body to a template function.
// ---------------------------------------------------------------------------
function buildEmail(type, data) {
  switch (type) {
    case 'welcome':
      return templateWelcome(data);
    case 'kyc-approved':
      return templateKycApproved(data);
    case 'kyc-under-review':
      return templateKycUnderReview(data);
    case 'kyc-declined':
    case 'kyc-rejected':
      return templateKycDeclined(data);
    case 'contract-signed':
      return templateContractSigned(data);
    case 'payment-received':
      return templatePaymentReceived(data);
    case 'payment-confirmed-buyer':
      return templatePaymentConfirmedBuyer(data);
    case 'work-delivered':
      return templateWorkDelivered(data);
    case 'withdrawal-initiated':
    case 'withdrawal-confirmation':  // alias used by create-payout.js
      return templateWithdrawalInitiated(data);
    case 'withdrawal-failed':  // used by nowpayments-payout-webhook.js
      return templateWithdrawalFailed(data);
    case 'dispute-raised':
      return templateDisputeRaised(data);
    case 'dispute-resolved':
      return templateDisputeResolved(data);
    case 'premium-activated':
      return templatePremiumActivated(data);
    case 'premium-expired':
      return templatePremiumExpired(data);
    case 'boost-purchased':
      return templateBoostPurchased(data);
    case 'referral-credited':
      return templateReferralCredited(data);
    case 'email-verification':
      return tplEmailVerification(data);
    case 'withdrawal-otp':
      return tplWithdrawalOtp(data);
    case 'product-delivery':
      return templateProductDelivery(data);
    case 'review-request':
      return templateReviewRequest(data);
    case 'product-sale':
      return templateProductSale(data);
    case 'new-review':
      return templateNewReview(data);
    case 'invoice-sent':
      return templateInvoiceSent(data);
    case 'invoice-paid':
      return templateInvoicePaid(data);
    case 'invoice-escrow-held-seller':
      return templateInvoiceEscrowHeldSeller(data);
    case 'invoice-escrow-held-buyer':
      return templateInvoiceEscrowHeldBuyer(data);
    case 'invoice-delivered-buyer':
      return templateInvoiceDeliveredBuyer(data);
    case 'invoice-delivered-seller':
      return templateInvoiceDeliveredSeller(data);
    case 'invoice-escrow-released':
      return templateInvoiceEscrowReleased(data);
    case 'bank-withdrawal-initiated':  // (audit finding N3) used by create-bank-payout.js
      return templateBankWithdrawalInitiated(data);
    case 'guest-purchase-welcome':  // (audit finding N3) used by create-product-order.js
      return templateGuestPurchaseWelcome(data);
    case 'new-project-request':  // (audit finding N3) used by create-project.js — currently dormant (emailMode: 'never')
      return templateNewProjectRequest(data);
    case 'contract-active':  // (audit finding N3) used by sign-contract.js — currently dormant (emailMode: 'never')
      return templateContractActive(data);
    case 'contract-sign-requested':  // (audit finding N3) used by sign-contract.js — currently dormant (emailMode: 'never')
      return templateContractSignRequested(data);
    case 'contract-declined':  // used by decline-contract.js — currently dormant (emailMode: 'never')
      return templateContractDeclined(data);
    case 'contract-change-proposed':  // used by propose-changes.js — currently dormant (emailMode: 'never')
      return templateContractChangeProposed(data);
    case 'contract-change-accepted':  // used by propose-changes.js — currently dormant (emailMode: 'never')
      return templateContractChangeAccepted(data);
    case 'contract-change-rejected':  // used by propose-changes.js — currently dormant (emailMode: 'never')
      return templateContractChangeRejected(data);
    case 'password-reset':
      return templatePasswordReset(data);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Netlify Function handler
// POST body shape: { to, toName?, type, data? }
// ---------------------------------------------------------------------------
export async function onRequest(context) {
  const { request, env, ctx } = context;

  /* ── Set the real platform URL from env for this request, before any
     template function (which read the module-level PLATFORM_URL binding
     directly) is called. See the PLATFORM_URL declaration comment above. ── */
  PLATFORM_URL = (env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/+$/, '');

  /* ── Only allow POST ── */
  if (request.method !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── BUG 3 FIX: internal-secret auth guard ────────────────────────────────
     send-email.js is a server-to-server function — it should never be
     callable from the public internet. Without this guard, anyone who
     discovers the /.netlify/functions/send-email URL can POST to it and
     send arbitrary transactional email from Kreddlo's Brevo domain to any
     address with any template they can guess (e.g. spoofing kyc-approved,
     payment-received, etc.). The email-queue Firestore rule only limits the
     queue-write path; it does nothing to protect a direct POST here.

     Every legitimate server-side caller already sets this header:
       - callFunction() helpers in: flutterwave-webhook, stripe-webhook,
         nowpayments-webhook, deliver-product, scheduled-subscriptions,
         process-email-queue, submit-invoice-delivery, confirm-invoice-delivery
       - Direct fetch() calls below are updated in the same fix to also
         send the header: flutterwave-webhook, stripe-webhook,
         nowpayments-webhook, send-verification-email, send-withdrawal-otp,
         process-referral-credit.

     INTERNAL_FUNCTION_SECRET must be set in Netlify → Site settings →
     Environment variables. If it is unset the guard always rejects, so the
     endpoint is never publicly accessible regardless of what the caller sends.
  ── */
  const expectedSecret  = env.INTERNAL_FUNCTION_SECRET || '';
  const receivedSecret  =
    (request.headers.get('x-internal-secret') || request.headers.get('X-Internal-Secret') || '').trim();
  const isTrustedCaller = !!expectedSecret && receivedSecret === expectedSecret;
  if (!isTrustedCaller) {
    console.warn('[send-email] Rejected request: missing or invalid x-internal-secret.');
    return respond(401, { error: 'Unauthorized.' });
  }

  /* ── Parse body ── */
  const rawText = await request.text();
  let payload;
  try {
    payload = JSON.parse(rawText || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { to: rawTo, toName: rawToName, type, templateId, data = {} } = payload;

  /* ── Sanitize recipient address (highest-priority field: goes to external SMTP) ── */
  const to = sanitizeEmail(rawTo);
  if (!to) {
    return respond(400, { error: 'Missing or invalid recipient email address.' });
  }
  // toName is display-only in the email header — strip tags, cap at 80 chars
  const toName = rawToName ? sanitizeString(rawToName, 80) : '';

  // Accept both 'type' and 'templateId' as the template selector (backwards compat)
  const emailType = type || templateId;
  if (!emailType) {
    return respond(400, { error: 'Missing required field: type (or templateId).' });
  }

  /* ── Build template ── */
  const template = buildEmail(emailType, data);
  if (!template) {
    return respond(400, { error: `Unknown email type: "${emailType}".` });
  }

  const { subject, preheader, body } = template;
  const htmlContent = baseLayout(subject, preheader, body);

  /* ── Read env vars for sender ── */
  const brevoKey    = env.BREVO_API_KEY;
  const senderEmail = env.BREVO_SENDER_EMAIL || 'noreply@kreddlo.com';
  const senderName  = env.BREVO_SENDER_NAME  || 'Kreddlo';

  if (!brevoKey) {
    console.error('BREVO_API_KEY environment variable is not set.');
    return respond(500, { error: 'Email service is not configured.' });
  }

  /* ── Send via Brevo ── */
  const brevoPayload = {
    sender:      { name: senderName, email: senderEmail },
    to:          [{ email: to, name: toName || to }],
    subject,
    htmlContent,
  };

  try {
    const response = await fetch(BREVO_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key':      brevoKey,
      },
      body: JSON.stringify(brevoPayload),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Brevo API error:', result);
      return respond(502, { error: 'Failed to send email.', details: result });
    }

    console.log(`Email sent — type: ${emailType}, to: ${to}`);
    return respond(200, { success: true, messageId: result.messageId, type: emailType, to });

  } catch (err) {
    console.error('send-email error:', err);
    return respond(500, { error: 'Internal server error.', message: err.message });
  }
}

/* ── Utility ── */
function respond(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

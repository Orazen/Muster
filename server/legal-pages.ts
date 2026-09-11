// Server-rendered legal pages — /privacy-policy and /terms-of-service.
//
// The app is a client-side SPA: its shell ships no readable content, which
// reads as a blank page to an OAuth consent-screen reviewer ("your privacy
// policy page does not have sufficient content"). These pages are
// self-contained static HTML with inline styles, so a crawler or a human
// reviewer sees the full text without executing any JavaScript.
//
// The Google consent-screen branding form links /Terms-of-Service with
// capital letters, so route matching is case-insensitive (legalPageFor).
//
// Search-Console ownership verification rides the same pages: when
// GOOGLE_SITE_VERIFICATION (or GSC_VERIFICATION_TOKEN) is set, the meta tag
// is injected into every served HTML page — that is the "HTML tag"
// verification method, and it also covers the marketing homepage.

const PAGE_STYLE = `
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
       background:#070707;color:#e7e5e4;line-height:1.65}
  main{max-width:760px;margin:0 auto;padding:3rem 1.5rem 4rem}
  header{border-bottom:1px solid #26262e;padding:1.25rem 1.5rem;display:flex;align-items:center;gap:.6rem}
  header a{color:#f08a24;font-weight:700;text-decoration:none;font-size:1.05rem}
  header span{color:#8a8a93;font-size:.85rem}
  h1{font-size:1.9rem;margin:0 0 .4rem;color:#fafaf9}
  h2{font-size:1.15rem;margin:2.2rem 0 .5rem;color:#f5f5f4}
  p,li{color:#c9c7c4;font-size:.95rem}
  ul{padding-left:1.3rem}
  li{margin:.3rem 0}
  .updated{color:#8a8a93;font-size:.85rem;margin-bottom:2rem}
  footer{border-top:1px solid #26262e;margin-top:3rem;padding-top:1.25rem;color:#8a8a93;font-size:.85rem}
  footer a{color:#f08a24;text-decoration:none}
`;

function legalShell(title: string, updated: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, follow">
<title>${title} — Muster</title>
<style>${PAGE_STYLE}</style></head>
<body>
<header><a href="/">Muster</a><span>AI agent workforce</span></header>
<main>
<h1>${title}</h1>
<p class="updated">${updated}</p>
${body}
<footer><a href="/">Home</a> · <a href="/privacy-policy">Privacy policy</a> · <a href="/terms-of-service">Terms of service</a></footer>
</main>
</body></html>`;
}

function privacyPolicy(): string {
  return legalShell(
    "Privacy policy",
    "Last updated: 11 September 2026",
    `
<h2>1. Who we are</h2>
<p>Muster is an AI-agent workforce platform operated by the Muster team ("we", "us"). This policy explains what
information we collect when you use https://muster.today and https://muster.orazen.online (the "Service"), why we
collect it, and what you can control. Questions or requests: <strong>support@muster.today</strong>.</p>

<h2>2. Information we collect</h2>
<ul>
<li><strong>Account information.</strong> When you create an account we store your name, email address and, if you
sign in with Google, your Google profile identifier and profile picture. If you never sign in with Google, we never
receive any Google data.</li>
<li><strong>Workspace content.</strong> The content you create in the Service — teammates (agents) you configure,
tasks and conversations, uploaded files, notes and settings — is stored so the product works across sessions and
devices.</li>
<li><strong>Google Drive sync data.</strong> If you connect Google Drive, the Service stores your workspace backups
in a private, app-only folder of your Google Drive that only this application can read. We do not read, list, or
modify any other file in your Google Drive.</li>
<li><strong>Usage and technical data.</strong> Request logs, crash reports and aggregate usage events (for example
feature counters) used to operate and improve the Service.</li>
<li><strong>Payment data.</strong> Paid plans are billed through a third-party payment processor. We never receive
or store your full card number.</li>
</ul>

<h2>3. How we use information</h2>
<ul>
<li>To provide the Service: run your agents, sync and restore your workspace, and show your history.</li>
<li>To authenticate you and secure your account.</li>
<li>To bill paid plans and prevent fraud.</li>
<li>To communicate service updates and respond to support requests.</li>
<li>To improve reliability and features on the basis of aggregate, non-identifying statistics.</li>
</ul>
<p>We do not sell your personal information, and we do not use your content or your Google data to advertise to you
or to train foundation models.</p>

<h2>4. Google user data and the Limited Use disclosure</h2>
<p>If you sign in with Google or connect Google Drive, Muster's use and transfer to any other app of information
received from Google APIs will adhere to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy,
including the Limited Use requirements</a>. Concretely:</p>
<ul>
<li>We receive only your basic Google profile (name, email, picture) for sign-in.</li>
<li>Drive access is restricted to the application's own private app-data folder used for workspace backups. Your
other Drive files are inaccessible to the Service.</li>
<li>Google user data is not transferred to third parties except to processors acting on our behalf to provide the
Service, and is not used for advertising.</li>
<li>You can revoke our access at any time in your Google account security settings, or disconnect Drive inside the
Service. Revocation deletes the sync connection immediately; backups already written to your own Drive remain in
your Drive until you delete them.</li>
</ul>

<h2>5. AI model providers</h2>
<p>Muster runs agents on the AI engine you choose — self-hosted on your own machine, or a hosted provider whose API
key you supply or whose hosted plan you select. Prompts and context that your agents process are sent to that
engine to generate responses. Hosted providers process that content under their own terms; on-device engines never
leave your machine. We do not add your content to any dataset beyond what is needed to run your tasks.</p>

<h2>6. Sharing and processors</h2>
<p>We share data only with the categories of processors required to run the Service: cloud hosting, payment
processing, transactional email delivery, and the AI engine you explicitly select. Each processor receives the
minimum data needed for its function. We may disclose information if required by law, with notice when legally
permitted.</p>

<h2>7. Retention and deletion</h2>
<p>Account and workspace data are retained while your account is active. When you delete your account, workspace
content and account data are deleted within 30 days, except where longer retention is required by law or for
fraud records in aggregated form. Google-scoped tokens are deleted immediately when you disconnect Google or
delete your account.</p>

<h2>8. Security</h2>
<p>Data is encrypted in transit (HTTPS/TLS) and at rest. Authentication tokens are stored hashed or encrypted, and
access to production systems is limited to operators who need it.</p>

<h2>9. Children</h2>
<p>The Service is not directed to children under 16 and we do not knowingly collect their personal information. If
you believe a child has provided us data, contact us and we will delete it.</p>

<h2>10. Your rights</h2>
<p>You may access, correct, export or delete your personal data at any time from the Service settings or by
emailing <strong>support@muster.today</strong>. We respond to verified requests within 30 days.</p>

<h2>11. Changes to this policy</h2>
<p>If we make material changes we will notify you in the Service or by email before they take effect. Continuing to
use the Service after a change means you accept the updated policy.</p>
`,
  );
}

function termsOfService(): string {
  return legalShell(
    "Terms of service",
    "Last updated: 11 September 2026",
    `
<h2>1. Acceptance</h2>
<p>By creating an account or using Muster at https://muster.today or https://muster.orazen.online (the "Service")
you agree to these Terms. If you use the Service on behalf of an organisation, you confirm you are authorised to
bind it.</p>

<h2>2. The service</h2>
<p>Muster lets you create, configure and supervise AI agents ("teammates") that perform tasks you assign. Features
may evolve; we may add, change or retire functionality, and will give reasonable notice for material changes to
paid plans.</p>

<h2>3. Accounts</h2>
<p>You are responsible for activity under your account, for keeping credentials safe, and for the configuration of
your agents, including which engines and permissions you grant them. One person or legal entity per account;
accounts may not be resold.</p>

<h2>4. Acceptable use</h2>
<p>You agree not to use the Service to violate any applicable law or the rights of others, to distribute malware,
to infringe intellectual property, to generate content intended to deceive or harm, or to attempt to disrupt,
probe or overload the Service or other users. We may throttle or suspend accounts that endanger availability,
security or other customers.</p>

<h2>5. AI output</h2>
<p>Agent output is generated by AI models and may be inaccurate or incomplete. You are responsible for reviewing
output before relying on it, and for any action you let an agent take on your behalf. We grant you the rights you
need to use the output you generate, to the extent we hold them.</p>

<h2>6. Paid plans and billing</h2>
<p>Paid plans bill in advance through a third-party processor under their terms. Subscriptions renew until
cancelled; you can cancel at any time and keep access until the end of the paid period. Except where required by
law, fees already paid are non-refundable.</p>

<h2>7. Your content</h2>
<p>You keep all rights to the content you provide. You grant us the limited licence needed to store, process and
back it up in order to provide the Service, including syncing your own backups to storage you connect (such as
your Google Drive app-data folder).</p>

<h2>8. Suspension and termination</h2>
<p>You may stop using the Service and delete your account at any time. We may suspend or terminate accounts that
breach these Terms, create legal risk, or remain inactive on free plans for an extended period, with notice where
practical. On termination we delete your data as described in the privacy policy.</p>

<h2>9. Disclaimers</h2>
<p>The Service is provided "as is" without warranties of any kind, express or implied, including merchantability,
fitness for a particular purpose and non-infringement. We do not warrant uninterrupted or error-free operation.</p>

<h2>10. Limitation of liability</h2>
<p>To the maximum extent permitted by law, we are not liable for indirect, incidental, special, consequential or
punitive damages, or for lost profits, data or goodwill. Our total liability for any claim is limited to the
amount you paid us in the 12 months before the claim, or USD 50 if you have not paid for the Service.</p>

<h2>11. Changes to these terms</h2>
<p>We may update these Terms; material changes will be notified in the Service or by email at least 14 days before
they take effect. Continued use after that date constitutes acceptance.</p>

<h2>12. Contact</h2>
<p>Questions about these Terms: <strong>support@muster.today</strong>.</p>
`,
  );
}

/** Route → page. Case-insensitive so the consent form's /Terms-of-Service
 * link resolves to the same page as the lowercase footer link. */
export function legalPageFor(path: string): string | undefined {
  switch (path.toLowerCase()) {
    case "/privacy-policy":
      return privacyPolicy();
    case "/terms-of-service":
      return termsOfService();
    default:
      return undefined;
  }
}

/** Search Console "HTML tag" verification: inject the meta tag right after
 * <head> on every served HTML page while GOOGLE_SITE_VERIFICATION (or
 * GSC_VERIFICATION_TOKEN) is set. The token value is restricted to the
 * characters Google issues so a hostile env value cannot break out of the
 * attribute; without a token the page passes through untouched. */
export function withVerificationMeta(page: string): string {
  const token = (process.env.GOOGLE_SITE_VERIFICATION ?? process.env.GSC_VERIFICATION_TOKEN ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "");
  if (!token || /google-site-verification/i.test(page)) return page;
  return page.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n<meta name="google-site-verification" content="${token}" />`);
}

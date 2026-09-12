// Legal pages must be readable without running the app's JavaScript.
const PAGE_STYLE = `
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
       background:#070707;color:#e7e5e4;line-height:1.7;overflow-wrap:anywhere}
  main{max-width:808px;margin:0 auto;padding:3rem 1.5rem 4rem}
  header{border-bottom:1px solid #26262e;padding:1.25rem 1.5rem;display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
  a{color:#ffb478;text-underline-offset:3px}
  a:focus-visible{outline:2px solid #ffb478;outline-offset:4px}
  header a{color:#f08a24;font-weight:700;text-decoration:none;font-size:1.05rem}
  header span{color:#a1a1aa;font-size:.85rem}
  h1{font-size:1.9rem;margin:0 0 .4rem;color:#fafaf9;line-height:1.25}
  h2{font-size:1.15rem;margin:2.2rem 0 .5rem;color:#f5f5f4}
  p,li{color:#c9c7c4;font-size:1rem}
  ul{padding-left:1.3rem}
  li{margin:.5rem 0}
  .updated{color:#a1a1aa;font-size:.85rem;margin-bottom:2rem}
  footer{border-top:1px solid #26262e;margin-top:3rem;padding-top:1.25rem;color:#a1a1aa;font-size:.9rem}
`;

const CONTACT = '<a href="mailto:ramagiritharun@gmail.com">ramagiritharun@gmail.com</a>';

function legalShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${title === "Privacy policy" ? "https://muster.today/privacy-policy" : "https://muster.today/terms-of-service"}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Muster">
<meta property="og:title" content="${title} — Muster">
<title>${title} — Muster</title>
<style>${PAGE_STYLE}</style></head>
<body>
<header><a href="/">Muster</a><span>AI agent workforce</span></header>
<main>
<h1>${title}</h1>
<p class="updated">Last updated: 12 September 2026</p>
${body}
<footer><a href="/">Home</a> · <a href="/privacy-policy">Privacy policy</a> · <a href="/terms-of-service">Terms of service</a></footer>
</main>
</body></html>`;
}

function privacyPolicy(): string {
  return legalShell("Privacy policy", `
<h2>1. Who we are and how to contact us</h2>
<p>Muster is an AI-agent workforce platform built by Tharun Ramagiri at Orazen. This policy explains how Muster
handles information on https://muster.today and https://muster.orazen.online, and how local or self-hosted
installations differ. For privacy questions, access requests or deletion requests, contact ${CONTACT}.</p>
<p>When you connect to someone else's self-hosted Muster server, that server's operator manages the data stored
there. Contact that operator about its retention, hosting and security practices.</p>

<h2>2. Information we collect</h2>
<ul>
<li><strong>Account information.</strong> Accounts store your name, email address, authentication records and sessions.
Google sign-in supplies a Google account identifier, email address, name and profile picture. OAuth access and
refresh tokens are stored to support authorized Google features without asking you to sign in on every request.</li>
<li><strong>Workspace content.</strong> We process the agents you configure, tasks, conversations, uploaded files,
notes, memories, settings and integration credentials you provide. The connected Muster server stores workspace
records and may keep model request and response logs.</li>
<li><strong>Google Drive data.</strong> The workspace-backup feature uploads an encrypted workspace bundle to
Muster's private Google Drive app-data folder and reads it when you request restoration. That feature uses the
<code>drive.appdata</code> scope, not access to your general Drive files. Separately configured integrations, such
as Vault Drive backup, can read other Drive files if you provide credentials with those permissions.</li>
<li><strong>Technical data.</strong> Server request and diagnostic logs, connection information and feature-usage
events help operate and troubleshoot the Service. Authentication uses session cookies; local application storage
also keeps preferences and drafts.</li>
<li><strong>Billing information.</strong> Where you purchase a paid service, payment providers process payment details.
Muster may receive customer, subscription and transaction identifiers and payment status, rather than your full
card number.</li>
</ul>

<h2>3. How we use information</h2>
<ul>
<li>Authenticate users and maintain accounts and sessions.</li>
<li>Run the tasks and integrations you request, generate agent responses and display workspace history.</li>
<li>Back up and restore supported workspace data when you invoke those features.</li>
<li>Operate, troubleshoot and secure the Service, manage billing where applicable, and respond to requests.</li>
</ul>
<p>We do not sell personal information or Google user data. We do not use Google user data for advertising or to
train generalized AI or machine-learning models. Selecting an external AI provider can send task content to that
provider, as described below.</p>

<h2>4. Google user data and Limited Use</h2>
<p>Muster's use and transfer to any other app of information received from Google APIs will adhere to
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
including the Limited Use requirements.</p>
<ul>
<li><strong>Permissions and purpose.</strong> Google sign-in requests basic profile access and the Drive app-data
permission for workspace backup. Requesting permission is not the same as running a backup. Workspace backup and
restore are currently manual features for local installations, not automatic cloud-account synchronization.</li>
<li><strong>Scope of backup access.</strong> The workspace-backup integration accesses only its app-data folder.
This restriction does not apply to other Drive integrations that you separately configure with broader permissions.</li>
<li><strong>Sharing.</strong> Google data is used for the user-facing features you authorize, not advertising,
sale to data brokers or generalized model training. Transfers are limited to providing those features, permitted
security purposes, legal obligations or other transfers allowed by Google's Limited Use requirements. Human access
to Google data is limited to the circumstances permitted by that policy, such as your affirmative consent to review
specific data or a security investigation.</li>
<li><strong>Revoking access.</strong> You can remove Muster's authorization in your
<a href="https://myaccount.google.com/connections">Google account connections</a>. Revocation prevents further
authorized access; it does not automatically erase credentials or copies already stored by Muster. The workspace
backup interface currently has no Drive-disconnect control. Request removal of stored account credentials from the
operator and manage existing app-data backups separately in Google Drive.</li>
</ul>

<h2>5. AI model providers and local processing</h2>
<p>Prompts and relevant context pass through the connected Muster server and are sent to the model endpoint you
configure. Hosted providers process that content under their own policies. Review those policies before including
sensitive information in a task. Connected tools may also send data to services you authorize.</p>
<p>A local model runs on the machine hosting its endpoint, which may not be your browser or phone. Using a local
model does not prevent server-side logging or transfers through other enabled integrations. For a fully local
workflow, both the Muster server and model endpoint must be local, with external integrations configured accordingly.</p>

<h2>6. Sharing and service providers</h2>
<p>Data may be processed by the hosting infrastructure supporting your deployment, the model and integration
providers you select, and payment or email providers when those functions are used. We disclose data as necessary
to provide the requested functions, protect the Service or comply with applicable law. Processing locations depend
on the operator and providers involved and may be outside your country.</p>

<h2>7. Retention and deletion</h2>
<p>Account records, workspace content, credentials and diagnostic records can remain on the connected server until
removed by its operator; the application does not currently enforce a single automatic expiry period for all of
these records. Signing out does not erase them. Self-service account deletion is not currently available in Settings.</p>
<p>To request deletion of hosted account data, workspace content or stored Google credentials, contact ${CONTACT}.
We may need to verify account ownership and identify the affected deployment. Any legally required retention or
limitations on the request must be considered separately. We do not promise that revoking Google access or deleting
an individual agent also deletes all related logs, backups or account records.</p>
<p>For a local or independently hosted installation, its operator controls deletion of stored files and databases.
Backups in your Google Drive are separate copies; removing server data does not remove those backups. Manage them
separately through Google Drive.</p>

<h2>8. Security</h2>
<p>The public Muster websites use HTTPS. Local and self-hosted connections depend on the deployment and may use
HTTP. Muster encrypts workspace backup bundles and hosted per-user provider-key vault entries. Other application
records are stored in files and databases without uniform application-level encryption. Session and OAuth tokens
are not uniformly hashed or encrypted in storage. Host access controls, disk encryption and backup protection depend
on the operator. No system can guarantee absolute security.</p>

<h2>9. Children</h2>
<p>Muster is not intended for children under 16. Contact us if you believe a child has provided personal information
so that we can investigate and address removal.</p>

<h2>10. Your rights and choices</h2>
<p>Depending on your jurisdiction, you may have rights to access, correct, erase or restrict processing of personal
data, obtain a portable copy, object to processing, withdraw consent, or complain to a data-protection authority.
Send requests to ${CONTACT}. Applicable legal requirements govern how requests are handled.</p>
<p>Settings provides limited profile controls. Local workspace export is a partial backup of supported workspace
records, not a complete personal-data or conversation export. For other access, correction, export or deletion
requests, contact the operator rather than relying on Settings alone.</p>

<h2>11. Changes to this policy</h2>
<p>Updates will appear on this page with a revised date. Where required by law, material changes will be accompanied
by additional notice or a request for consent. This policy does not limit your statutory privacy rights.</p>
`);
}

function termsOfService(): string {
  return legalShell("Terms of service", `
<h2>1. Acceptance and operator</h2>
<p>Muster is built by Tharun Ramagiri at Orazen. By using the Service at https://muster.today or
https://muster.orazen.online, you agree to these Terms. If acting for an organization, you must be authorized to do
so. You must be at least 16 and meet applicable legal requirements to use the Service.</p>

<h2>2. The service</h2>
<p>Muster lets you configure and supervise AI agents that perform tasks you assign. Feature availability differs
between hosted, desktop and self-hosted deployments. We may change or retire features. Third-party models,
integrations and independently operated servers are subject to their own terms.</p>

<h2>3. Accounts and permissions</h2>
<p>You are responsible for keeping credentials safe and for the permissions and engines you configure. Only connect
accounts, files and services you are authorized to use. Review consequential actions before approving them.</p>

<h2>4. Acceptable use</h2>
<p>Do not use Muster to break the law, infringe others' rights, distribute malware, gain unauthorized access,
commit fraud or disrupt services. We may restrict access when necessary to protect security or address abuse.</p>

<h2>5. AI output</h2>
<p>AI output can be inaccurate or incomplete. You are responsible for reviewing results before relying on them and
for actions authorized on your behalf. Outputs are not guaranteed to be unique or free of third-party rights and
are not a substitute for qualified professional advice.</p>

<h2>6. Paid services</h2>
<p>If you purchase a paid service, review the price, renewal, cancellation and refund terms presented at checkout.
Third-party model or infrastructure charges may be separate. Nothing in these Terms limits mandatory consumer
rights, including cancellation or refunds required by applicable law.</p>

<h2>7. Your content and privacy</h2>
<p>You retain rights to the content you provide and authorize its processing as needed to carry out your requests,
including transfers to the engines and integrations you choose. You must have permission to provide that content.
Read the <a href="/privacy-policy">privacy policy</a> for data handling, storage limitations and deletion requests.</p>

<h2>8. Stopping use and suspension</h2>
<p>You may stop using Muster at any time. Stopping use or signing out does not automatically delete stored data.
Request account or workspace-data deletion through the contact below; local and self-hosted operators manage their
own stored copies. We may suspend access for breaches of these Terms or to address legal or security concerns.</p>

<h2>9. Disclaimers and liability</h2>
<p>To the extent permitted by applicable law, the Service is provided as available without guarantees of continuous
operation, fitness for a particular purpose or error-free output. We are not responsible for losses resulting from
unauthorized use of your credentials or actions you approve, except where applicable law imposes responsibility.
Nothing here excludes liability or consumer protections that cannot lawfully be excluded.</p>

<h2>10. Changes and contact</h2>
<p>Updated Terms will be published here with a revised date, with additional notice where required by law. Questions
about the Service, these Terms or account requests: ${CONTACT}.</p>
`);
}

// The consent form uses /Terms-of-Service; both spellings must resolve.
// Trailing slashes must resolve too: without this, /privacy-policy/ falls
// through to the bare SPA shell (an empty <div id="root">), which Google's
// OAuth review reads as a privacy policy with no content.
export function legalPageFor(path: string): string | undefined {
  switch (path.replace(/\/+$/, "").toLowerCase()) {
    case "/privacy-policy":
      return privacyPolicy();
    case "/terms-of-service":
      return termsOfService();
    default:
      return undefined;
  }
}

export function withVerificationMeta(page: string): string {
  const token = process.env.GOOGLE_SITE_VERIFICATION ?? process.env.GSC_VERIFICATION_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(token) || /google-site-verification/i.test(page)) return page;
  return page.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n<meta name="google-site-verification" content="${token}" />`);
}

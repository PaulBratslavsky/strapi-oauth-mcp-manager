const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const STYLES = `
  :root { color-scheme: light dark; --bg:#f6f6f9; --card:#fff; --text:#32324d; --muted:#666687; --border:#dcdce4; --primary:#4945ff; --danger:#d02b20; }
  @media (prefers-color-scheme: dark) { :root { --bg:#181826; --card:#212134; --text:#ffffff; --muted:#a5a5ba; --border:#4a4a6a; --primary:#7b79ff; --danger:#f23628; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--border); border-radius:8px; padding:32px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); }
  .client { font-weight:600; color:var(--text); }
  .details { border:1px solid var(--border); border-radius:4px; padding:12px; margin:0 0 20px; font-size:13px; }
  .details dt { color:var(--muted); }
  .details dd { margin:0 0 8px; word-break:break-all; }
  .details dd:last-child { margin-bottom:0; }
  label { display:block; font-weight:600; font-size:12px; margin:0 0 4px; }
  input[type=email], input[type=password] { width:100%; padding:10px 12px; margin:0 0 16px; border:1px solid var(--border); border-radius:4px; background:transparent; color:var(--text); font:inherit; }
  .actions { display:flex; gap:8px; margin-top:8px; }
  button { flex:1; padding:10px 16px; border-radius:4px; font:inherit; font-weight:600; cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--text); }
  button.primary { background:var(--primary); border-color:var(--primary); color:#fff; }
  .error { border:1px solid var(--danger); color:var(--danger); border-radius:4px; padding:10px 12px; margin:0 0 16px; }
  .warning { font-size:12px; }
  a { color:var(--primary); }
  fieldset { border:0; padding:0; margin:0 0 12px; }
  legend { font-weight:600; font-size:12px; margin:0 0 8px; }
  .option { display:flex; gap:10px; align-items:flex-start; border:1px solid var(--border); border-radius:4px; padding:10px 12px; margin:0 0 8px; font-weight:normal; font-size:14px; cursor:pointer; }
  .option input { margin-top:3px; }
  .option small { display:block; color:var(--muted); font-size:12px; word-break:break-word; }
`;

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>`;

export interface TokenOption {
  id: number;
  name: string;
  description?: string | null;
  expiresAt?: string | null;
}

interface BasePageProps {
  clientName: string;
  redirectUri: string;
  resource: string;
  /** Hidden OAuth request parameters echoed back on submit. */
  params: Record<string, string | undefined>;
  registrationType: 'manual' | 'dynamic';
  error?: string;
}

export interface SignInPageProps extends BasePageProps {
  email?: string;
}

export interface ChooseAccessPageProps extends BasePageProps {
  userEmail: string;
  ticket: string;
  tokens: TokenOption[];
  allowUserPermissions: boolean;
  tokensSettingsUrl: string;
}

const hiddenInputs = (params: Record<string, string | undefined>) =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');

const header = (props: BasePageProps) => {
  let redirectHost = props.redirectUri;
  try {
    const url = new URL(props.redirectUri);
    redirectHost = url.host || `${url.protocol}//`;
  } catch {
    // keep the raw value
  }
  return `
    <h1>Connect to Strapi MCP</h1>
    <p><span class="client">${escapeHtml(props.clientName)}</span> wants to use this Strapi instance's MCP server.</p>
    <dl class="details">
      <dt>MCP server</dt><dd>${escapeHtml(props.resource)}</dd>
      <dt>Returns you to</dt><dd>${escapeHtml(redirectHost)}</dd>
    </dl>
    ${props.error ? `<div class="error" role="alert">${escapeHtml(props.error)}</div>` : ''}
  `;
};

const dynamicWarning = (props: BasePageProps) =>
  props.registrationType === 'dynamic'
    ? '<p class="warning">This client registered itself, so only continue if you started this connection.</p>'
    : '';

export const renderAuthorizePage = (props: SignInPageProps) =>
  layout(
    `Authorize ${props.clientName}`,
    `
    ${header(props)}
    <form method="post" autocomplete="on">
      ${hiddenInputs(props.params)}
      <input type="hidden" name="step" value="signin">
      <label for="email">Admin email</label>
      <input id="email" name="email" type="email" required autocomplete="username" value="${escapeHtml(props.email)}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      ${dynamicWarning(props)}
      <div class="actions">
        <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
        <button type="submit" name="decision" value="continue" class="primary">Continue</button>
      </div>
    </form>
  `
  );

const formatExpiry = (expiresAt?: string | null) =>
  expiresAt ? `Expires ${new Date(expiresAt).toISOString().slice(0, 10)}` : 'Never expires';

export const renderChooseAccessPage = (props: ChooseAccessPageProps) => {
  const options = [
    ...props.tokens.map(
      (token, index) => `
      <label class="option">
        <input type="radio" name="access" value="token:${token.id}" ${index === 0 ? 'checked' : ''} required>
        <span><strong>${escapeHtml(token.name)}</strong>
        <small>${escapeHtml(token.description || 'Admin token')} · ${escapeHtml(formatExpiry(token.expiresAt))}</small></span>
      </label>`
    ),
    ...(props.allowUserPermissions
      ? [
          `<label class="option">
        <input type="radio" name="access" value="user" ${props.tokens.length === 0 ? 'checked' : ''} required>
        <span><strong>All of my permissions</strong><small>Everything your admin account can do</small></span>
      </label>`,
        ]
      : []),
  ];

  const body =
    options.length === 0
      ? `<div class="error" role="alert">You don't have any admin tokens to connect with.</div>
         <p>Create one with the permissions this client should have in <a href="${escapeHtml(props.tokensSettingsUrl)}" target="_blank" rel="noopener">Settings → Admin Tokens</a>, then choose <strong>Refresh</strong>.</p>
         <div class="actions">
           <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
           <button type="submit" name="decision" value="refresh" class="primary" formnovalidate>Refresh</button>
         </div>`
      : `<fieldset>
           <legend>Choose what ${escapeHtml(props.clientName)} can access</legend>
           ${options.join('')}
         </fieldset>
         <p class="warning">The client gets exactly the permissions of the token you choose. Revoke access any time on the MCP OAuth page, or by deleting or regenerating the token.</p>
         ${dynamicWarning(props)}
         <div class="actions">
           <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
           <button type="submit" name="decision" value="approve" class="primary">Authorize</button>
         </div>`;

  return layout(
    `Authorize ${props.clientName}`,
    `
    ${header(props)}
    <p>Signed in as <span class="client">${escapeHtml(props.userEmail)}</span>.</p>
    <form method="post">
      ${hiddenInputs(props.params)}
      <input type="hidden" name="step" value="choose">
      <input type="hidden" name="ticket" value="${escapeHtml(props.ticket)}">
      ${body}
    </form>
  `
  );
};

export const renderErrorPage = (message: string) =>
  layout(
    'Authorization error',
    `<h1>Authorization error</h1><div class="error" role="alert">${escapeHtml(message)}</div><p>Close this window and try connecting again from your MCP client.</p>`
  );

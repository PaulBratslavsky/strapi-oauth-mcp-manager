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

export interface AuthorizePageProps {
  clientName: string;
  redirectUri: string;
  resource: string;
  /** Hidden OAuth request parameters echoed back on submit. */
  params: Record<string, string | undefined>;
  email?: string;
  error?: string;
  registrationType: 'manual' | 'dynamic';
}

export const renderAuthorizePage = (props: AuthorizePageProps) => {
  const hidden = Object.entries(props.params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');

  let redirectHost = props.redirectUri;
  try {
    const url = new URL(props.redirectUri);
    redirectHost = url.host || `${url.protocol}//`;
  } catch {
    // keep the raw value
  }

  return layout(
    `Authorize ${props.clientName}`,
    `
    <h1>Connect to Strapi MCP</h1>
    <p><span class="client">${escapeHtml(props.clientName)}</span> wants to use this Strapi instance's MCP server on your behalf.</p>
    <dl class="details">
      <dt>MCP server</dt><dd>${escapeHtml(props.resource)}</dd>
      <dt>Returns you to</dt><dd>${escapeHtml(redirectHost)}</dd>
    </dl>
    ${props.error ? `<div class="error" role="alert">${escapeHtml(props.error)}</div>` : ''}
    <form method="post" autocomplete="on">
      ${hidden}
      <label for="email">Admin email</label>
      <input id="email" name="email" type="email" required autocomplete="username" value="${escapeHtml(props.email)}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <p class="warning">The client will be able to do anything your admin account can do through MCP. You can revoke access at any time from the OAuth MCP Manager page in the admin panel.${
        props.registrationType === 'dynamic' ? ' This client registered itself, so only continue if you started this connection.' : ''
      }</p>
      <div class="actions">
        <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
        <button type="submit" name="decision" value="approve" class="primary">Authorize</button>
      </div>
    </form>
  `
  );
};

export const renderErrorPage = (message: string) =>
  layout(
    'Authorization error',
    `<h1>Authorization error</h1><div class="error" role="alert">${escapeHtml(message)}</div><p>Close this window and try connecting again from your MCP client.</p>`
  );

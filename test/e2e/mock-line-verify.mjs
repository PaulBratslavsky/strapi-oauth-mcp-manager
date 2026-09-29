// A local stand-in for LINE's ID token verify endpoint (POST /verify), for tests and development.
// Run it on its own with: node test/e2e/mock-line-verify.mjs [port] [channelId]
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const startMockLineVerify = ({ port = 4545, channelId = '1234567890' } = {}) =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST' || req.url !== '/verify') return send(404, { error: 'not_found' });
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const token = form.get('id_token') ?? '';
        const now = Math.floor(Date.now() / 1000);
        if (form.get('client_id') !== channelId) return send(400, { error: 'invalid_request', error_description: 'Invalid IdToken Audience.' });
        const [kind, sub] = token.split('.');
        if (kind === 'expired') return send(400, { error: 'invalid_request', error_description: 'IdToken expired.' });
        if ((kind === 'valid' || kind === 'wrong-aud') && sub) {
          return send(200, {
            iss: 'https://access.line.me',
            sub,
            aud: kind === 'valid' ? channelId : '9999999999',
            exp: now + 3600,
            iat: now,
            amr: ['linesso'],
            name: 'Test Customer',
          });
        }
        return send(400, { error: 'invalid_request', error_description: 'Invalid IdToken.' });
      });
    });
    server.listen(port, () => resolve({ url: `http://localhost:${port}/verify`, close: () => new Promise((done) => server.close(done)) }));
  });

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [port = '4545', channelId = '1234567890'] = process.argv.slice(2);
  const mock = await startMockLineVerify({ port: Number(port), channelId });
  console.log(`Mock LINE verify endpoint on ${mock.url} for channel ${channelId}`);
}

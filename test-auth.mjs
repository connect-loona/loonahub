import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('./netlify/edge-functions/basic-auth.ts', import.meta.url), 'utf8');
const { default: gate, config } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
let credentials;
globalThis.Netlify = { env: { get: () => credentials } };
let passed = 0;
async function check(host, path, expected, init = {}) {
  const response = await gate(new Request(`https://${host}${path}`, init), { next: async () => new Response('allowed', { status: 200 }) });
  assert.equal(response.status, expected, `${host}${path}`);
  if (expected === 404 || expected === 503) assert.equal(response.headers.get('Cache-Control'), 'no-store');
  passed++;
  return response;
}
assert.equal(config.path, '/*');
assert.equal(config.excludedPath, undefined);
for (credentials of [undefined, '', 'invalid', ':password', 'user:', 'user:password']) {
  for (const path of ['/', '/?from=example', '/independence/', '/independence/index.html', '/independence/admin/', '/assets/independence-day/vande-mataram.mp3?v=2']) {
    await check('flag.loona.in', path, 200);
  }
  for (const path of ['/index.html', '/sw.js', '/netlify.toml', '/api/sarvam-upload-proxy', '/.netlify/functions/chat', '/.netlify/functions/calendar-create', '/.netlify/functions/independence-hoist-extra', '/independence-other', '/assets/independence-day/../private.txt']) {
    await check('flag.loona.in', path, 404);
  }
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    for (const path of ['/.netlify/functions/independence-hoist', '/.netlify/functions/independence-admin']) await check('flag.loona.in', path, 200, { method });
  }
  await check('flag.loona.in', '/', 404, { method: 'POST', body: 'username=user' });
  await check('flag.loona.in', '/', 200, { method: 'HEAD' });
  await check('loonahub.netlify.app', '/index.html', credentials === 'user:password' ? 401 : 503);
  await check('main--loonahub.netlify.app', '/', credentials === 'user:password' ? 401 : 503);
  for (const path of ['/manifest.json', '/icons/icon-192-v2.png', '/independence/', '/.netlify/functions/calendar-sync']) await check('loonahub.netlify.app', path, 200);
}
credentials = 'user:password';
const login = await check('loonahub.netlify.app', '/', 302, { method: 'POST', body: new URLSearchParams({ username: 'user', password: 'password', redirect_to: '/index.html' }) });
assert.equal(login.headers.get('Location'), '/index.html');
const cookie = login.headers.get('Set-Cookie').split(';')[0];
await check('loonahub.netlify.app', '/index.html', 200, { headers: { cookie } });
await check('flag.loona.in', '/index.html', 404, { headers: { cookie } });
await check('loonahub.netlify.app', '/', 401, { method: 'POST', body: new URLSearchParams({ username: 'user', password: 'wrong' }) });
credentials = undefined;
await check('loonahub.netlify.app', '/', 503, { headers: { cookie } });
console.log(`${passed} authentication and routing checks passed. No network calls made.`);

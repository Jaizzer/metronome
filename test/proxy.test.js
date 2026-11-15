import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxy, rewriteSetCookie } from '../api/auth-proxy.js';

const APP = 'https://metronome.example';
const UPSTREAM = 'https://neon.example/neondb/auth';

// Stub fetch, record what the proxy sent upstream.
function withFetch(responder) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init });
		return responder(url, init);
	};
	return calls;
}

const req = (path, init = {}) => new Request(APP + path, init);

test('rejects a foreign Origin without calling upstream', async () => {
	const calls = withFetch(() => new Response('{}'));
	const res = await proxy(req('/api/auth/sign-in/email', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }), UPSTREAM);
	assert.equal(res.status, 403);
	assert.equal((await res.json()).code, 'PROXY_INVALID_ORIGIN');
	assert.equal(calls.length, 0);
});

test('rejects a POST with no Origin, allows a GET with none', async () => {
	withFetch(() => new Response('null', { headers: { 'content-type': 'application/json' } }));
	assert.equal((await proxy(req('/api/auth/sign-out', { method: 'POST', body: '{}' }), UPSTREAM)).status, 403);
	assert.equal((await proxy(req('/api/auth/get-session'), UPSTREAM)).status, 200);
});

test('forwards path (rewrite form), query, body, cookie; sets trusted Origin', async () => {
	const calls = withFetch(() => new Response('{"ok":true}', { status: 200 }));
	await proxy(
		req('/api/auth-proxy?__path=sign-in/email&x=1', {
			method: 'POST',
			headers: { origin: APP, cookie: 'a=b', 'content-type': 'application/json' },
			body: '{"email":"e"}',
		}),
		UPSTREAM,
	);
	const { url, init } = calls[0];
	assert.equal(url, UPSTREAM + '/sign-in/email?x=1');
	assert.equal(init.headers.get('origin'), 'http://localhost:5173');
	assert.equal(init.headers.get('cookie'), 'a=b');
	assert.equal(new TextDecoder().decode(init.body), '{"email":"e"}');
});

test('passes set-auth-jwt through and makes cookies host-only', async () => {
	withFetch(() => {
		const h = new Headers({ 'set-auth-jwt': 'jwt123', 'content-type': 'application/json', 'access-control-allow-origin': 'http://localhost:5173' });
		h.append('set-cookie', '__Secure-x=1; Domain=neon.example; Path=/; HttpOnly; Secure; SameSite=None');
		return new Response('{}', { headers: h });
	});
	const res = await proxy(req('/api/auth/get-session'), UPSTREAM);
	assert.equal(res.headers.get('set-auth-jwt'), 'jwt123');
	assert.equal(res.headers.get('access-control-allow-origin'), null);
	const cookie = res.headers.getSetCookie()[0];
	assert.ok(!/domain=/i.test(cookie));
	assert.match(cookie, /Secure/);
	assert.match(cookie, /SameSite=None/);
});

test('rewriteSetCookie only drops Domain', () => {
	assert.equal(rewriteSetCookie('a=1; Domain=.x.com; Path=/; Secure'), 'a=1; Path=/; Secure');
});

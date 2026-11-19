import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64url, buildAuthUrl, readCallback, createSpotifyRemote, SCOPES } from '../src/spotify.js';

function memStore(init = {}) {
	const m = new Map(Object.entries(init));
	return {
		get: (k, d) => (m.has(k) ? m.get(k) : d),
		set: (k, v) => m.set(k, String(v)),
		del: (k) => m.delete(k),
		raw: m,
	};
}

// Fake fetch: routes 'METHOD path' to a handler, records every call.
function fakeFetch(routes) {
	const calls = [];
	const fn = async (url, opts = {}) => {
		const u = new URL(url);
		const key = `${opts.method || 'GET'} ${u.pathname}`;
		calls.push({ key, url: u, opts });
		const h = routes[key];
		if (!h) return { status: 404, ok: false, json: async () => ({}) };
		const [status, body] = h(u, opts);
		return { status, ok: status >= 200 && status < 300, json: async () => body };
	};
	fn.calls = calls;
	return fn;
}

const fresh = (now) => ({
	'spotify.token': JSON.stringify({ access: 'A', refresh: 'R', expiresAt: now + 3600_000 }),
});

test('base64url has no padding or +/', () => {
	assert.equal(base64url(new Uint8Array([251, 255, 191])), '-_-_');
	assert.equal(base64url(new Uint8Array([1])), 'AQ');
});

test('buildAuthUrl asks for playback scopes with PKCE S256', () => {
	const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'https://x.app/', challenge: 'ch', state: 'st' }));
	assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
	const p = Object.fromEntries(u.searchParams);
	assert.deepEqual(p, {
		client_id: 'cid',
		response_type: 'code',
		redirect_uri: 'https://x.app/',
		code_challenge_method: 'S256',
		code_challenge: 'ch',
		state: 'st',
		scope: SCOPES,
	});
	assert.match(SCOPES, /user-modify-playback-state/);
	assert.match(SCOPES, /user-read-playback-state/);
});

test('readCallback only accepts our own state', () => {
	assert.deepEqual(readCallback('?code=c1&state=s1', 's1'), { code: 'c1' });
	assert.deepEqual(readCallback('?error=access_denied&state=s1', 's1'), { error: 'access_denied' });
	assert.equal(readCallback('?code=c1&state=other', 's1'), null);
	assert.equal(readCallback('?code=c1&state=s1', null), null);
	assert.equal(readCallback('?foo=1', 's1'), null);
});

test('pausing a playing device returns true and remembers the device', async () => {
	const now = 1_000_000;
	const fetch = fakeFetch({
		'GET /v1/me/player': () => [200, { is_playing: true, device: { id: 'phone' } }],
		'PUT /v1/me/player/pause': () => [204],
	});
	const r = createSpotifyRemote({ clientId: 'cid', redirectUri: 'r', fetch, store: memStore(fresh(now)), now: () => now });
	assert.equal(await r.setPlaying(false), true);
	assert.equal(fetch.calls.at(-1).opts.headers.Authorization, 'Bearer A');
	await r.setPlaying(true);
	const play = fetch.calls.at(-1);
	assert.equal(play.key, 'PUT /v1/me/player/play');
	assert.equal(play.url.searchParams.get('device_id'), 'phone');
});

test('pausing when nothing is playing does nothing and returns false', async () => {
	const now = 1_000_000;
	for (const res of [[204], [200, { is_playing: false, device: { id: 'phone' } }]]) {
		const fetch = fakeFetch({ 'GET /v1/me/player': () => res });
		const r = createSpotifyRemote({ clientId: 'cid', redirectUri: 'r', fetch, store: memStore(fresh(now)), now: () => now });
		assert.equal(await r.setPlaying(false), false);
		assert.ok(!fetch.calls.some((c) => c.key === 'PUT /v1/me/player/pause'));
	}
});

test('an expired token is refreshed first, keeping the old refresh token if none comes back', async () => {
	const now = 5_000_000;
	const store = memStore({ 'spotify.token': JSON.stringify({ access: 'old', refresh: 'R', expiresAt: now - 1 }) });
	const fetch = fakeFetch({
		'POST /api/token': (_u, o) => {
			const b = new URLSearchParams(o.body);
			assert.equal(b.get('grant_type'), 'refresh_token');
			assert.equal(b.get('refresh_token'), 'R');
			assert.equal(b.get('client_id'), 'cid');
			return [200, { access_token: 'new', expires_in: 3600 }];
		},
		'GET /v1/me/player': () => [204],
	});
	const r = createSpotifyRemote({ clientId: 'cid', redirectUri: 'r', fetch, store, now: () => now });
	await r.setPlaying(false);
	assert.equal(fetch.calls.at(-1).opts.headers.Authorization, 'Bearer new');
	const saved = JSON.parse(store.get('spotify.token'));
	assert.equal(saved.refresh, 'R');
	assert.equal(saved.access, 'new');
});

test('a rejected refresh disconnects instead of retrying forever', async () => {
	const now = 5_000_000;
	const store = memStore({ 'spotify.token': JSON.stringify({ access: 'old', refresh: 'R', expiresAt: now - 1 }) });
	const fetch = fakeFetch({ 'POST /api/token': () => [400, { error: 'invalid_grant' }] });
	let status = '';
	const r = createSpotifyRemote({ clientId: 'cid', redirectUri: 'r', fetch, store, now: () => now, onStatus: (t) => (status = t) });
	assert.equal(await r.setPlaying(false), false);
	assert.equal(r.connected, false);
	assert.match(status, /Connect Spotify again/);
});

test('finishing login exchanges the code with the saved verifier', async () => {
	const now = 1_000;
	const store = memStore({ 'spotify.verifier': 'V', 'spotify.state': 'S' });
	const fetch = fakeFetch({
		'POST /api/token': (_u, o) => {
			const b = new URLSearchParams(o.body);
			assert.equal(b.get('grant_type'), 'authorization_code');
			assert.equal(b.get('code'), 'C');
			assert.equal(b.get('code_verifier'), 'V');
			assert.equal(b.get('redirect_uri'), 'https://x.app/');
			return [200, { access_token: 'A', refresh_token: 'R', expires_in: 3600 }];
		},
	});
	const r = createSpotifyRemote({ clientId: 'cid', redirectUri: 'https://x.app/', fetch, store, now: () => now });
	assert.equal(await r.finishLogin('?code=C&state=S'), true);
	assert.equal(r.connected, true);
	assert.equal(store.get('spotify.verifier', null), null);
	assert.equal(await r.finishLogin('?code=C&state=S'), false); // state is single-use
});

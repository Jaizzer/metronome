import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64url, buildAuthUrl, readCallback, createSpotifyRemote, describePlayback, parseShows, parseEpisodes, parseRecent, SCOPES } from '../src/spotify.js';

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

test('describePlayback reads episodes and tracks, null when idle', () => {
	assert.equal(describePlayback(null), null);
	assert.equal(describePlayback({ is_playing: false, item: null }), null);
	assert.deepEqual(
		describePlayback({
			is_playing: true,
			progress_ms: 61000,
			device: { name: 'iPhone' },
			item: { type: 'episode', name: 'Ep 1', duration_ms: 3600000, show: { name: 'Show' }, images: [{ url: 'big' }, { url: 'small' }] },
		}),
		{ uri: null, playing: true, title: 'Ep 1', subtitle: 'Show', image: 'small', device: 'iPhone', volume: null, progress: 61000, duration: 3600000 },
	);
	const t = describePlayback({
		is_playing: false,
		progress_ms: 0,
		device: { name: 'Mac' },
		item: { type: 'track', name: 'Song', duration_ms: 200000, artists: [{ name: 'A' }, { name: 'B' }], album: { images: [{ url: 'cover' }] } },
	});
	assert.equal(t.subtitle, 'A, B');
	assert.equal(t.image, 'cover');
});

test('state asks for episodes and seek clamps at zero', async () => {
	const now = 1_000_000;
	const fetch = fakeFetch({
		'GET /v1/me/player': (u) => {
			assert.equal(u.searchParams.get('additional_types'), 'episode,track');
			return [200, { is_playing: true, progress_ms: 5000, device: { id: 'd' }, item: { type: 'episode', name: 'E', duration_ms: 9000, show: { name: 'S' }, images: [] } }];
		},
		'PUT /v1/me/player/seek': () => [204],
	});
	const r = createSpotifyRemote({ clientId: 'cid', redirectUri: 'r', fetch, store: memStore(fresh(now)), now: () => now });
	const s = await r.state();
	assert.equal(s.title, 'E');
	await r.seekBy(-15000);
	assert.equal(fetch.calls.at(-1).url.searchParams.get('position_ms'), '0');
});

test('library scope is asked for, and an old login without it reports so', () => {
	assert.match(SCOPES, /user-library-read/);
	const now = 1;
	const old = createSpotifyRemote({ clientId: 'c', redirectUri: 'r', fetch: fakeFetch({}), store: memStore(fresh(now)), now: () => now });
	assert.equal(old.canBrowse, false);
	const store = memStore({ 'spotify.token': JSON.stringify({ access: 'A', refresh: 'R', expiresAt: 9e15, scope: SCOPES }) });
	assert.equal(createSpotifyRemote({ clientId: 'c', redirectUri: 'r', fetch: fakeFetch({}), store, now: () => now }).canBrowse, true);
});

test('parseShows and parseEpisodes keep what the lists show', () => {
	assert.deepEqual(
		parseShows({ items: [{ show: { id: 's1', uri: 'spotify:show:s1', name: 'Pod', publisher: 'Pub', images: [{ url: 'b' }, { url: 's' }] } }, { show: null }] }),
		[{ id: 's1', uri: 'spotify:show:s1', name: 'Pod', publisher: 'Pub', image: 's' }],
	);
	const eps = parseEpisodes({
		items: [
			{ uri: 'spotify:episode:e1', name: 'E1', release_date: '2026-11-01', duration_ms: 600000, images: [], resume_point: { fully_played: false, resume_position_ms: 120000 } },
			null,
		],
	});
	assert.deepEqual(eps, [{ uri: 'spotify:episode:e1', name: 'E1', date: '2026-11-01', duration: 600000, played: false, resumeAt: 120000 }]);
});

test('playUri starts an episode where it left off on the remembered device', async () => {
	const now = 1;
	const fetch = fakeFetch({ 'PUT /v1/me/player/play': () => [204] });
	const store = memStore({ ...fresh(now), 'spotify.device': 'phone' });
	const r = createSpotifyRemote({ clientId: 'c', redirectUri: 'r', fetch, store, now: () => now });
	assert.equal(await r.playUri('spotify:episode:e1', 120000), true);
	const c = fetch.calls.at(-1);
	assert.equal(c.url.searchParams.get('device_id'), 'phone');
	assert.deepEqual(JSON.parse(c.opts.body), { uris: ['spotify:episode:e1'], position_ms: 120000 });
});

test('setVolume clamps and reports a device that refuses', async () => {
	const now = 1;
	let msg = '';
	const fetch = fakeFetch({ 'PUT /v1/me/player/volume': (u) => [u.searchParams.get('volume_percent') === '100' ? 403 : 204] });
	const r = createSpotifyRemote({ clientId: 'c', redirectUri: 'r', fetch, store: memStore(fresh(now)), now: () => now, onStatus: (t) => (msg = t) });
	assert.equal(await r.setVolume(40.4), true);
	assert.equal(fetch.calls.at(-1).url.searchParams.get('volume_percent'), '40');
	assert.equal(await r.setVolume(150), false);
	assert.match(msg, /volume/i);
});

test('parseRecent keeps the newest play of each track', () => {
	const track = (id, name) => ({ uri: `spotify:track:${id}`, name, duration_ms: 200000, artists: [{ name: 'A' }, { name: 'B' }], album: { images: [{ url: 'big' }, { url: 'small' }] } });
	assert.deepEqual(
		parseRecent({
			items: [
				{ track: track('t1', 'One'), played_at: '2026-11-24T10:00:00Z' },
				{ track: track('t2', 'Two'), played_at: '2026-11-24T09:00:00Z' },
				{ track: track('t1', 'One'), played_at: '2026-11-24T08:00:00Z' },
				{ track: null },
			],
		}),
		[
			{ uri: 'spotify:track:t1', name: 'One', subtitle: 'A, B', image: 'small', duration: 200000 },
			{ uri: 'spotify:track:t2', name: 'Two', subtitle: 'A, B', image: 'small', duration: 200000 },
		],
	);
	assert.deepEqual(parseRecent(null), []);
});

test('recentlyPlayed needs its scope and asks Spotify for the latest plays', async () => {
	assert.match(SCOPES, /user-read-recently-played/);
	const now = 1;
	const old = createSpotifyRemote({ clientId: 'c', redirectUri: 'r', fetch: fakeFetch({}), store: memStore(fresh(now)), now: () => now });
	assert.equal(old.canRecent, false);
	const fetch = fakeFetch({ 'GET /v1/me/player/recently-played': () => [200, { items: [] }] });
	const store = memStore({ 'spotify.token': JSON.stringify({ access: 'A', refresh: 'R', expiresAt: 9e15, scope: SCOPES }) });
	const r = createSpotifyRemote({ clientId: 'c', redirectUri: 'r', fetch, store, now: () => now });
	assert.equal(r.canRecent, true);
	assert.deepEqual(await r.recentlyPlayed(), []);
	assert.equal(fetch.calls.at(-1).url.searchParams.get('limit'), '50');
});

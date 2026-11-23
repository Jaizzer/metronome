// spotify.js: log in to Spotify (Authorization Code + PKCE, no server) and
// pause/play whatever the Spotify app is playing (Web API player endpoints,
// Spotify Connect). Needs Premium. Pure helpers + a remote with injectable
// fetch/store/clock so it runs under node --test.

export const CLIENT_ID = 'dc49097b05c7419fb97f58164a753ee2';
export const SCOPES = 'user-read-playback-state user-modify-playback-state user-library-read user-read-playback-position user-read-recently-played';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

const KEY_TOKEN = 'spotify.token';
const KEY_VERIFIER = 'spotify.verifier';
const KEY_STATE = 'spotify.state';
const KEY_DEVICE = 'spotify.device';
const EARLY = 60_000; // refresh a minute before the token runs out

export function base64url(bytes) {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildAuthUrl({ clientId, redirectUri, challenge, state }) {
	const p = new URLSearchParams({
		client_id: clientId,
		response_type: 'code',
		redirect_uri: redirectUri,
		code_challenge_method: 'S256',
		code_challenge: challenge,
		state,
		scope: SCOPES,
	});
	return `${AUTH_URL}?${p}`;
}

// The redirect back from Spotify: { code } or { error }, or null when the
// URL isn't ours (no state saved, or a different state).
export function readCallback(search, savedState) {
	const p = new URLSearchParams(search);
	if (!savedState || p.get('state') !== savedState) return null;
	if (p.get('error')) return { error: p.get('error') };
	if (p.get('code')) return { code: p.get('code') };
	return null;
}

// GET /me/player body -> what the now-playing card shows, or null when
// nothing is loaded. Episodes carry their own images; tracks use the album's.
export function describePlayback(body) {
	const item = body?.item;
	if (!item) return null;
	const episode = item.type === 'episode';
	const images = (episode ? item.images : item.album?.images) || [];
	return {
		uri: item.uri || null,
		playing: Boolean(body.is_playing),
		title: item.name || '',
		subtitle: episode ? item.show?.name || '' : (item.artists || []).map((a) => a.name).join(', '),
		image: smallest(images),
		device: body.device?.name || '',
		volume: body.device?.volume_percent ?? null,
		progress: body.progress_ms || 0,
		duration: item.duration_ms || 0,
	};
}

const smallest = (images) => (images || []).at(-1)?.url || null;

export function parseShows(body) {
	return (body?.items || [])
		.map((i) => i?.show)
		.filter(Boolean)
		.map((sh) => ({ id: sh.id, uri: sh.uri, name: sh.name, publisher: sh.publisher || '', image: smallest(sh.images) }));
}

export function parseEpisodes(body) {
	return (body?.items || []).filter(Boolean).map((e) => ({
		uri: e.uri,
		name: e.name,
		date: e.release_date || '',
		duration: e.duration_ms || 0,
		played: Boolean(e.resume_point?.fully_played),
		resumeAt: e.resume_point?.resume_position_ms || 0,
	}));
}

// GET /me/player/recently-played body -> one row per track, newest play
// first (Spotify lists every play, so repeats are dropped). Tracks only:
// Spotify leaves podcast episodes out of this list.
export function parseRecent(body) {
	const seen = new Set();
	const out = [];
	for (const t of (body?.items || []).map((i) => i?.track)) {
		if (!t?.uri || seen.has(t.uri)) continue;
		seen.add(t.uri);
		out.push({ uri: t.uri, name: t.name || '', subtitle: (t.artists || []).map((a) => a.name).join(', '), image: smallest(t.album?.images), duration: t.duration_ms || 0 });
	}
	return out;
}

export const localStore = {
	get(k, d) {
		try {
			const v = localStorage.getItem(k);
			return v === null ? d : v;
		} catch {
			return d;
		}
	},
	set(k, v) {
		try {
			localStorage.setItem(k, String(v));
		} catch {
			/* private mode: login lasts this page only */
		}
	},
	del(k) {
		try {
			localStorage.removeItem(k);
		} catch {
			/* nothing saved */
		}
	},
};

function randomString(n) {
	return base64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function sha256(text) {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// opts: { clientId, redirectUri, fetch, store, now, onStatus(text) }.
export function createSpotifyRemote({
	clientId = CLIENT_ID,
	redirectUri,
	fetch = globalThis.fetch.bind(globalThis),
	store = localStore,
	now = Date.now,
	onStatus = () => {},
}) {
	let refreshing = null;

	function readToken() {
		try {
			return JSON.parse(store.get(KEY_TOKEN, 'null'));
		} catch {
			return null;
		}
	}

	function saveToken(body, old = {}) {
		const t = {
			access: body.access_token,
			refresh: body.refresh_token || old.refresh, // Spotify may not send a new one
			expiresAt: now() + (body.expires_in || 3600) * 1000,
			scope: body.scope || old.scope || '',
		};
		store.set(KEY_TOKEN, JSON.stringify(t));
		return t;
	}

	function disconnect(msg) {
		store.del(KEY_TOKEN);
		store.del(KEY_DEVICE);
		if (msg) onStatus(msg);
	}

	async function tokenRequest(params) {
		const res = await fetch(TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: clientId, ...params }).toString(),
		});
		return { res, body: await res.json().catch(() => ({})) };
	}

	async function refresh(t) {
		if (refreshing) return refreshing;
		refreshing = (async () => {
			try {
				const { res, body } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
				if (res.ok && body.access_token) return saveToken(body, t);
				if (res.status >= 400 && res.status < 500) disconnect('Spotify logged you out. Connect Spotify again.');
				return null;
			} catch {
				return null; // offline: keep the login, try again later
			} finally {
				refreshing = null;
			}
		})();
		return refreshing;
	}

	async function access(force = false) {
		let t = readToken();
		if (!t) return null;
		if (force || t.expiresAt - EARLY <= now()) t = await refresh(t);
		return t?.access ?? null;
	}

	// One Web API call; on 401 refreshes once and retries.
	async function call(method, path, query, json) {
		for (const force of [false, true]) {
			const token = await access(force);
			if (!token) return null;
			const url = new URL(API + path);
			for (const [k, v] of Object.entries(query || {})) if (v) url.searchParams.set(k, v);
			let res;
			try {
				const headers = { Authorization: `Bearer ${token}` };
				if (json) headers['Content-Type'] = 'application/json';
				res = await fetch(url.toString(), { method, headers, body: json ? JSON.stringify(json) : undefined });
			} catch {
				onStatus("Couldn't reach Spotify. Check your connection.");
				return null;
			}
			if (res.status !== 401) return res;
		}
		return null;
	}

	async function getJson(path, query) {
		const res = await call('GET', path, query);
		if (!res || !res.ok) return null;
		return res.json().catch(() => null);
	}

	return {
		get connected() {
			return readToken() !== null;
		},

		// Logged in with the library scope (older logins need to reconnect).
		get canBrowse() {
			return (readToken()?.scope || '').split(' ').includes('user-library-read');
		},

		// Logged in with the recently-played scope (older logins need to reconnect).
		get canRecent() {
			return (readToken()?.scope || '').split(' ').includes('user-read-recently-played');
		},

		async recentlyPlayed() {
			const body = await getJson('/me/player/recently-played', { limit: '50' });
			return body ? parseRecent(body) : null;
		},

		async savedShows() {
			const body = await getJson('/me/shows', { limit: '50' });
			return body ? parseShows(body) : null;
		},

		async showEpisodes(showId) {
			const body = await getJson(`/shows/${encodeURIComponent(showId)}/episodes`, { limit: '50' });
			return body ? parseEpisodes(body) : null;
		},

		// Play one episode/track on the Spotify app, from positionMs.
		async playUri(uri, positionMs = 0) {
			const res = await call('PUT', '/me/player/play', { device_id: store.get(KEY_DEVICE, '') }, { uris: [uri], position_ms: positionMs });
			if (res && res.status === 404) onStatus('Open Spotify on your phone first, then tap the episode again.');
			return Boolean(res && res.ok);
		},

		async login() {
			const verifier = randomString(64);
			const state = randomString(16);
			store.set(KEY_VERIFIER, verifier);
			store.set(KEY_STATE, state);
			const challenge = base64url(await sha256(verifier));
			location.assign(buildAuthUrl({ clientId, redirectUri, challenge, state }));
		},

		// Called on page load with location.search. True when a login finished.
		async finishLogin(search) {
			const cb = readCallback(search, store.get(KEY_STATE, null));
			if (!cb) return false;
			const verifier = store.get(KEY_VERIFIER, null);
			store.del(KEY_STATE); // single use
			store.del(KEY_VERIFIER);
			if (cb.error || !verifier) {
				onStatus(cb.error === 'access_denied' ? 'Spotify login cancelled.' : 'Spotify login failed. Try again.');
				return false;
			}
			try {
				const { res, body } = await tokenRequest({
					grant_type: 'authorization_code',
					code: cb.code,
					redirect_uri: redirectUri,
					code_verifier: verifier,
				});
				if (!res.ok || !body.access_token) throw new Error(body.error || res.status);
				saveToken(body);
				return true;
			} catch {
				onStatus('Spotify login failed. Try again.');
				return false;
			}
		},

		logout() {
			disconnect();
		},

		// What the Spotify app is playing (null: nothing, or not reachable).
		async state() {
			const res = await call('GET', '/me/player', { additional_types: 'episode,track' });
			if (!res || res.status !== 200) return null;
			const body = await res.json().catch(() => null);
			if (body?.device?.id) store.set(KEY_DEVICE, body.device.id);
			return describePlayback(body);
		},

		// Spotify app volume, 0-100. Some devices (often iPhones) refuse it.
		async setVolume(pct) {
			const v = String(Math.round(Math.min(100, Math.max(0, pct))));
			const res = await call('PUT', '/me/player/volume', { volume_percent: v });
			if (res && res.status === 403) onStatus("This device doesn't let apps change Spotify's volume. Use the phone buttons.");
			return Boolean(res && res.ok);
		},

		// Jump back/forward in the current item (podcasts: ±15 s).
		async seekBy(deltaMs) {
			const s = await this.state();
			if (!s) return;
			const pos = Math.max(0, Math.min(s.duration || Infinity, s.progress + deltaMs));
			await call('PUT', '/me/player/seek', { position_ms: String(Math.round(pos)) });
		},

		// Pause or resume the Spotify app. Returns true only when it paused
		// something that was playing, so the caller knows the pause is its own.
		async setPlaying(play) {
			if (play) {
				const res = await call('PUT', '/me/player/play', { device_id: store.get(KEY_DEVICE, '') });
				if (res && res.status === 404) onStatus('Open Spotify on a device to resume.');
				return false;
			}
			const state = await call('GET', '/me/player');
			if (!state || state.status !== 200) return false; // 204 = nothing active
			const body = await state.json().catch(() => ({}));
			if (!body.is_playing) return false;
			if (body.device?.id) store.set(KEY_DEVICE, body.device.id);
			const res = await call('PUT', '/me/player/pause');
			return Boolean(res && res.ok);
		},
	};
}

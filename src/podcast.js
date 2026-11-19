// podcast.js: Spotify podcast panel logic. Pure helpers (tested) + a small
// controller around the Spotify iFrame API (no Web API, no OAuth, no SDK).

const ID = '[A-Za-z0-9]{22}';
const KINDS = 'episode|show|playlist';

// Spotify link (open.spotify.com/<kind>/<id>[?si=..], optional intl-xx/ or
// embed/ prefix) or URI (spotify:<kind>:<id>) -> 'spotify:<kind>:<id>', else null.
export function parseSpotifyLink(str) {
	if (typeof str !== 'string') return null;
	const s = str.trim();
	let m = s.match(new RegExp(`^spotify:(${KINDS}):(${ID})$`));
	if (m) return `spotify:${m[1]}:${m[2]}`;
	m = s.match(
		new RegExp(`^(?:https?://)?open\\.spotify\\.com/(?:embed/)?(?:intl-[a-z-]+/)?(${KINDS})/(${ID})(?:[/?#].*)?$`, 'i'),
	);
	return m ? `spotify:${m[1].toLowerCase()}:${m[2]}` : null;
}

// chunkState: 'drill' | 'maintain' | null (null = no Drill/Maintain context).
// wePaused: the app itself paused the podcast earlier. userOverride: the user
// pressed play during a Drill chunk, so it stays on until the next chunk.
// Returns true (play), false (pause) or null (leave it alone). It only ever
// resumes a podcast the app paused; it never starts one the user didn't.
export function podcastShouldPlay({
	autoPause,
	manualPaused,
	running,
	chunkState,
	resting,
	wePaused = false,
	userOverride = false,
}) {
	if (manualPaused) return false;
	if (!autoPause || !chunkState) return wePaused ? true : null; // undo our own pause
	if (running && !resting && chunkState === 'drill') return userOverride ? null : false;
	return wePaused ? true : null;
}

// ---- controller ----

const KEY_LINK = 'podcast.link';
const KEY_AUTO = 'podcast.autoPause';
const KEY_CLICK = 'podcast.clickGain';

export const store = {
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
			/* private mode: not remembered */
		}
	},
};
export { KEY_LINK, KEY_AUTO, KEY_CLICK };

let apiPromise = null;
function loadApi() {
	if (apiPromise) return apiPromise;
	apiPromise = new Promise((resolve, reject) => {
		window.onSpotifyIframeApiReady = (api) => resolve(api);
		const s = document.createElement('script');
		s.src = 'https://open.spotify.com/embed/iframe-api/v1';
		s.async = true;
		s.onerror = () => {
			apiPromise = null;
			reject(new Error('Spotify script failed to load'));
		};
		document.head.appendChild(s);
	});
	return apiPromise;
}

const CREATE_TIMEOUT = 10000;
const PENDING_TIMEOUT = 5000;

// opts: { mount: element, onStatus(text) }.
export function createPodcastPlayer({ mount, onStatus = () => {} }) {
	let controller = null;
	let creating = null;
	let loadedUri = null; // what the embed currently holds
	let wantUri = null; // what the user last asked for
	let paused = null; // last known state of the embed (null = unknown)
	let pending = null; // { play, at }: our own request, not yet confirmed
	const listeners = { manual: () => {} };

	function onUpdate(e) {
		const nowPaused = Boolean(e?.data?.isPaused);
		if (pending && Date.now() - pending.at > PENDING_TIMEOUT) pending = null;
		const first = paused === null;
		if (nowPaused === paused) return;
		paused = nowPaused;
		if (pending && pending.play === !nowPaused) {
			pending = null; // the answer to our request
			return;
		}
		pending = null;
		if (!first) listeners.manual(nowPaused); // the user pressed play/pause in the embed
	}

	function ensure(firstUri) {
		if (controller) return Promise.resolve(controller);
		if (creating) return creating;
		const make = loadApi().then(
			(api) =>
				new Promise((resolve) => {
					const el = document.createElement('div');
					mount.replaceChildren(el);
					api.createController(el, { uri: firstUri, width: '100%', height: 152 }, (c) => {
						controller = c;
						loadedUri = firstUri;
						c.addListener('playback_update', onUpdate);
						resolve(c);
					});
				}),
		);
		const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CREATE_TIMEOUT));
		creating = Promise.race([make, timeout]).catch(() => {
			creating = null; // allow a retry
			onStatus("Spotify didn't load. Check your connection and try again.");
			return null;
		});
		creating.then(() => {
			creating = null;
		});
		return creating;
	}

	return {
		set onManual(fn) {
			listeners.manual = fn;
		},
		async load(uri) {
			wantUri = uri;
			mount.hidden = false;
			const c = await ensure(uri);
			if (!c || wantUri !== uri || loadedUri === uri) return;
			loadedUri = uri;
			paused = null;
			pending = null;
			c.loadUri(uri);
		},
		// Field cleared: stop the audio and hide the embed.
		clear() {
			wantUri = null;
			pending = { play: false, at: Date.now() }; // our pause, not the user's
			if (controller) {
				try {
					controller.pause();
				} catch {
					/* not ready */
				}
			}
			mount.hidden = true;
		},
		// Ask the embed to play or pause (auto-pause). Returns true only when
		// it paused an embed known to be playing, so the app knows the pause
		// is its own to undo.
		setPlaying(play) {
			if (!controller || !wantUri) return false;
			if (paused === !play) return false; // already there
			if (pending && pending.play === play && Date.now() - pending.at < PENDING_TIMEOUT) return false;
			const wasPlaying = paused === false;
			pending = { play, at: Date.now() };
			try {
				if (play) controller.play();
				else controller.pause();
			} catch {
				pending = null;
				return false;
			}
			return !play && wasPlaying;
		},
		get ready() {
			return Boolean(controller) && Boolean(wantUri);
		},
	};
}

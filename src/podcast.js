// podcast.js: Spotify podcast panel logic. Pure helpers (tested) + a small
// controller around the Spotify iFrame API (no Web API, no OAuth, no SDK).

const ID = '[A-Za-z0-9]{10,32}';
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
// Returns true (should play), false (should pause) or null (leave it alone).
export function podcastShouldPlay({ autoPause, manualPaused, running, chunkState, resting }) {
	if (!autoPause) return null;
	if (manualPaused) return false;
	if (!chunkState) return null;
	if (!running || resting) return true;
	return chunkState !== 'drill';
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

// opts: { mount: element, onStatus(text) }. Returns { load(uri), setPlaying(bool), onManual }.
export function createPodcastPlayer({ mount, onStatus = () => {} }) {
	let controller = null;
	let creating = null;
	let uri = null;
	let wantPlay = null; // last state we asked for (to tell our pauses from the user's)
	let expectUntil = 0;
	let userPaused = null; // null until the first update (baseline, not a user action)
	let listeners = { manual: () => {} };

	async function ensure(firstUri) {
		if (controller) return controller;
		if (creating) return creating;
		creating = loadApi()
			.then(
				(api) =>
					new Promise((resolve) => {
						const el = document.createElement('div');
						mount.replaceChildren(el);
						api.createController(el, { uri: firstUri, width: '100%', height: 152 }, (c) => {
							controller = c;
							c.addListener('playback_update', (e) => {
								const paused = Boolean(e?.data?.isPaused);
								const ours = Date.now() < expectUntil && wantPlay === !paused;
								if (ours) {
									userPaused = paused;
									return;
								}
								// The user pressed play/pause in the embed.
								const first = userPaused === null;
								if (paused !== userPaused) {
									userPaused = paused;
									wantPlay = null;
									if (!first) listeners.manual(paused);
								}
							});
							resolve(c);
						});
					}),
			)
			.catch(() => {
				creating = null;
				onStatus('Could not load Spotify. Check your connection.');
				return null;
			});
		return creating;
	}

	return {
		set onManual(fn) {
			listeners.manual = fn;
		},
		async load(newUri) {
			if (newUri === uri && controller) return;
			uri = newUri;
			userPaused = null;
			wantPlay = null;
			if (!controller) await ensure(newUri);
			else controller.loadUri(newUri);
		},
		// Ask the embed to play or pause (auto-pause). Ignored until the player exists.
		setPlaying(play) {
			if (!controller || wantPlay === play) return;
			wantPlay = play;
			expectUntil = Date.now() + 1500;
			try {
				if (play) controller.play();
				else controller.pause();
			} catch {
				/* embed not ready */
			}
		},
		get ready() {
			return Boolean(controller);
		},
	};
}

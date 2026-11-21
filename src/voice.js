// ============================================================
// voice.js — voice commands, the hands-free sibling of the pedal.
//
//   "good" ✓ · "miss" ✗ · "undo" · "next" · "back" · "pause" · "play"
//
// MVP: the browser's own SpeechRecognition (continuous + interim results).
// Chrome sends audio to Google; iOS Safari may need the network and stops
// after silence, so the controller restarts it. A word fires as soon as an
// interim result holds it, once per result, so a wrong hear is undo-able.
//
// No DOM in here: main.js wires it up, tests feed it a fake recognizer.
// ============================================================

const WORDS = {
	good: 'good',
	goods: 'good',
	gud: 'good',
	miss: 'miss',
	mis: 'miss',
	missed: 'miss',
	misses: 'miss',
	undo: 'undo',
	undue: 'undo',
	next: 'next',
	back: 'back',
	pause: 'pause',
	paused: 'pause',
	paws: 'pause',
	play: 'play',
};
// Sound-alikes are only words nobody says mid-practice: "could" (for good)
// is left out on purpose, normal talk would record runs.

// Transcript -> commands in the order spoken; anything else is ignored.
export function parseCommands(text) {
	if (typeof text !== 'string') return [];
	return text
		.toLowerCase()
		.replace(/\bun[\s-]+do\b/g, 'undo')
		.split(/[^a-z]+/)
		.map((w) => WORDS[w])
		.filter(Boolean);
}

// Each recognition result (by index) grows through interim versions to a
// final one. push() returns only the commands that result hasn't fired yet.
export function createCommandStream() {
	let fired = new Map(); // result index -> commands already fired
	return {
		push(index, text) {
			const cmds = parseCommands(text);
			const done = fired.get(index) ?? 0;
			if (cmds.length <= done) return [];
			fired.set(index, cmds.length);
			return cmds.slice(done);
		},
		reset() {
			fired = new Map();
		},
	};
}

const RESTART_MS = 0; // iOS ends after each phrase: any gap loses words
const LANG = 'en-US';
const LOCAL = { langs: [LANG], processLocally: true };
const BACKOFF_MS = 250; // after an error: 500 ms, 1 s, 2 s… up to 8 s
const MAX_BACKOFF_MS = 8000;

// onCommand(cmd, heardAt) · onState('listening' | 'off' | 'error')
export function createVoice({
	Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition,
	onCommand,
	onState = () => {},
	now = () => Date.now(),
	setTimer = (fn, ms) => setTimeout(fn, ms),
}) {
	const supported = typeof Recognition === 'function';
	let rec = null;
	let on = false;
	let errors = 0; // in a row, for the backoff
	let local = false; // on-device recognition (Chrome): no network trip
	let localTried = false;
	const stream = createCommandStream();

	// Use the browser's on-device model when it has one (installs it if it's
	// only downloadable). Starts on the cloud meanwhile, then switches.
	async function tryLocal() {
		if (localTried || typeof Recognition.available !== 'function') return;
		localTried = true;
		try {
			let st = await Recognition.available(LOCAL);
			if (st === 'downloadable' && typeof Recognition.install === 'function') {
				await Recognition.install(LOCAL);
				st = await Recognition.available(LOCAL);
			}
			if (st !== 'available') return;
			local = true;
			if (on && rec) rec.stop(); // onend restarts it on-device
		} catch {
			/* cloud it is */
		}
	}

	function make() {
		const r = new Recognition();
		r.continuous = true;
		r.interimResults = true;
		r.lang = LANG;
		r.onstart = () => onState('listening');
		r.onresult = (e) => {
			errors = 0;
			const at = now();
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const res = e.results[i];
				if (!res) continue;
				for (const cmd of stream.push(i, res[0]?.transcript ?? '')) onCommand(cmd, at);
			}
		};
		r.onerror = (e) => {
			if (e.error === 'no-speech' || e.error === 'aborted') return; // normal; onend restarts
			if (local && e.error !== 'not-allowed') {
				local = false; // on-device failed: back to the cloud, no error shown
				return;
			}
			if (e.error === 'not-allowed' || e.error === 'service-not-allowed') on = false; // mic refused: stop for good
			errors++;
			onState('error');
		};
		r.onend = () => {
			stream.reset(); // a new session numbers its results from 0
			if (!on) {
				if (!errors) onState('off');
				return;
			}
			const wait = errors ? Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** errors) : RESTART_MS;
			setTimer(() => on && begin(), wait);
		};
		return r;
	}

	function begin() {
		if (local) rec.processLocally = true;
		else if (rec.processLocally) rec.processLocally = false;
		try {
			rec.start();
		} catch {
			/* already started */
		}
	}

	return {
		supported,
		get on() {
			return on;
		},
		get local() {
			return local;
		},
		start() {
			if (!supported) return false;
			on = true;
			errors = 0;
			rec ??= make();
			stream.reset();
			begin();
			tryLocal(); // inside the tap that turned Voice on, so install() is allowed
			return true;
		},
		stop() {
			on = false;
			errors = 0;
			try {
				rec?.stop();
			} catch {
				/* not running */
			}
			onState('off');
		},
	};
}

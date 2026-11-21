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
	miss: 'miss',
	missed: 'miss',
	undo: 'undo',
	next: 'next',
	back: 'back',
	pause: 'pause',
	paused: 'pause',
	play: 'play',
};

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

const RESTART_MS = 250;
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
	const stream = createCommandStream();

	function make() {
		const r = new Recognition();
		r.continuous = true;
		r.interimResults = true;
		r.lang = 'en-US';
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
			const wait = errors ? Math.min(MAX_BACKOFF_MS, RESTART_MS * 2 ** errors) : RESTART_MS;
			setTimer(() => on && begin(), wait);
		};
		return r;
	}

	function begin() {
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
		start() {
			if (!supported) return false;
			on = true;
			errors = 0;
			rec ??= make();
			stream.reset();
			begin();
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

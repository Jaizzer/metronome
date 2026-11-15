// ============================================================
// engine.js — Song mode: the practice algorithm (docs/PRACTICE-ALGORITHM.md).
//
// Every ✓/✗ in a song routine is an attempt { id, t, k: 's'|'f', bpm }
// kept in its section's `log`. Everything else is derived from the log:
//   - ladder: 2 ✓ in a row → +4% (band-tuned); 2 ✗ → shrink prompt;
//     4 ✗ in a row → −4%
//   - band: share of ✓ in the last 30 attempts (good = 70–90%)
//   - owned tempo: the cold (first-of-day) attempt passed on 2 separate days
//   - review: owned chunks come back after 1, 3, 7, 14, 30 days
//   - song tempo: the lowest owned tempo among joined chunks
//
// No DOM in here: main.js feeds it logs, tests feed it fixed clocks.
// ============================================================

export const STEP = 0.04;
export const STEP_HI = 0.05; // band above 90%
export const STEP_LO = 0.03; // band below 70%
export const CEILING = 1.1; // of the target, and of the song tempo for joined chunks
export const BAND_LO = 0.7;
export const BAND_HI = 0.9;
export const WINDOW = 30;
export const MIN_BAND = 10; // attempts before the band means anything
export const REVIEW_DAYS = [1, 3, 7, 14, 30];
export const LOG_CAP = 400;
export const PLATEAU_SESSIONS = 3;
export const MIN_BPM = 20;
export const MAX_BPM = 300;

const clamp = (v) => Math.max(MIN_BPM, Math.min(MAX_BPM, v));

// Local calendar day, so "next day" means after a night's sleep.
export function dayKey(t) {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(key, n) {
	const [y, m, d] = key.split('-').map(Number);
	return dayKey(new Date(y, m - 1, d + n).getTime());
}

export function stepUp(bpm, rate = STEP) {
	return clamp(bpm + Math.max(1, Math.round(bpm * rate)));
}

export function stepDown(bpm, rate = STEP) {
	return clamp(bpm - Math.max(1, Math.round(bpm * rate)));
}

export const newAttemptId = () =>
	globalThis.crypto?.randomUUID?.() ?? `a-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Union by id, minus removed ids, oldest first, newest LOG_CAP kept.
export function mergeLog(base = [], add = [], del = []) {
	const gone = new Set(del);
	const byId = new Map();
	for (const a of [...base, ...add]) if (a?.id && !gone.has(a.id)) byId.set(a.id, a);
	const out = [...byId.values()].sort((a, b) => a.t - b.t);
	return out.length > LOG_CAP ? out.slice(out.length - LOG_CAP) : out;
}

// Share of ✓ in the last WINDOW attempts (any tempo), or null if too few.
export function band(log) {
	const w = log.slice(-WINDOW);
	if (w.length < MIN_BAND) return null;
	return w.filter((a) => a.k === 's').length / w.length;
}

export function stepRate(b) {
	if (b === null) return STEP;
	if (b > BAND_HI) return STEP_HI;
	if (b < BAND_LO) return STEP_LO;
	return STEP;
}

// Same-kind run at the end of the log, counted only at `bpm`
// (a tempo change starts a fresh streak).
export function streak(log, bpm) {
	let kind = null;
	let n = 0;
	for (let i = log.length - 1; i >= 0; i--) {
		const a = log[i];
		if (a.bpm !== bpm) break;
		if (kind === null) kind = a.k;
		if (a.k !== kind) break;
		n++;
	}
	return { kind, n };
}

// First attempt of each day = the cold attempt.
export function coldAttempts(log) {
	const seen = new Set();
	const out = [];
	for (const a of log) {
		const d = dayKey(a.t);
		if (seen.has(d)) continue;
		seen.add(d);
		out.push({ ...a, day: d });
	}
	return out;
}

// Highest tempo whose cold attempt passed on 2 separate days, or null.
export function ownedTempo(log) {
	const best = coldAttempts(log)
		.filter((a) => a.k === 's')
		.map((a) => a.bpm)
		.sort((a, b) => b - a);
	return best.length >= 2 ? best[1] : null;
}

// When this chunk's next cold check is due (day key), or null if it has no
// owned tempo yet (then it's practised every session anyway).
export function nextReview(log) {
	const cold = coldAttempts(log);
	if (!cold.length || ownedTempo(log) === null) return null;
	let run = 0; // consecutive passed cold checks, newest backwards
	for (let i = cold.length - 1; i >= 0 && cold[i].k === 's'; i--) run++;
	const last = cold[cold.length - 1];
	if (last.k === 'f') return addDays(last.day, 1);
	const gap = REVIEW_DAYS[Math.min(Math.max(run - 1, 0), REVIEW_DAYS.length - 1)];
	return addDays(last.day, gap);
}

// Top tempo with a ✓ per practice day, newest last.
function sessionTops(log) {
	const tops = new Map();
	for (const a of log) {
		if (a.k !== 's') continue;
		const d = dayKey(a.t);
		tops.set(d, Math.max(tops.get(d) ?? 0, a.bpm));
	}
	return [...tops.values()];
}

// No new top tempo in the last PLATEAU_SESSIONS practice days.
export function plateau(log) {
	const tops = sessionTops(log);
	if (tops.length < PLATEAU_SESSIONS + 1) return false;
	const before = Math.max(...tops.slice(0, -PLATEAU_SESSIONS));
	return Math.max(...tops.slice(-PLATEAU_SESSIONS)) <= before;
}

// What to do after an attempt at `bpm`. cap: highest tempo allowed.
// → { action: 'up' | 'down' | 'shrink' | null, to }
export function ladder(log, bpm, cap = MAX_BPM) {
	const s = streak(log, bpm);
	if (s.kind === 's' && s.n >= 2 && bpm < cap) {
		return { action: 'up', to: Math.min(cap, stepUp(bpm, stepRate(band(log)))) };
	}
	if (s.kind === 'f' && s.n >= 4) return { action: 'down', to: stepDown(bpm) };
	if (s.kind === 'f' && s.n === 2) return { action: 'shrink', to: bpm };
	return { action: null, to: bpm };
}

// ---------- Song level ----------

// sections: the routine's sections; kind 'run' sections are play-throughs
// and don't count. joined: chunks that have entered the song.
export function songState(sections, target) {
	const chunks = sections.filter((m) => (m.kind ?? 'chunk') !== 'run');
	const joined = chunks.filter((m) => m.joined && ownedTempo(m.log ?? []) !== null);
	let tempo = null;
	let bottleneck = null;
	for (const m of joined) {
		const o = ownedTempo(m.log ?? []);
		if (tempo === null || o < tempo) {
			tempo = o;
			bottleneck = m;
		}
	}
	const ceiling = target ? Math.round(target * CEILING) : MAX_BPM;
	const cap = tempo === null ? ceiling : Math.min(ceiling, Math.max(Math.round(tempo * CEILING), tempo + 1));
	return { tempo, bottleneck, cap, ceiling, pct: tempo && target ? Math.round((tempo / target) * 100) : null };
}

// A chunk joins the song once its owned tempo reaches the song tempo
// (the first chunk to own a tempo starts the song). Returns true if it
// should be marked joined now.
export function shouldJoin(section, song) {
	if (section.joined || (section.kind ?? 'chunk') === 'run') return false;
	const o = ownedTempo(section.log ?? []);
	return o !== null && (song.tempo === null || o >= song.tempo);
}

// Today's view of one chunk, for labels.
export function chunkStatus(section, song, now = Date.now()) {
	const log = section.log ?? [];
	const today = dayKey(now);
	const owned = ownedTempo(log);
	const review = nextReview(log);
	const playedToday = log.some((a) => dayKey(a.t) === today);
	let state = 'new';
	if ((section.kind ?? 'chunk') === 'run') state = 'run';
	else if (section.joined) state = song.bottleneck === section ? 'bottleneck' : 'joined';
	return {
		state,
		owned,
		band: band(log),
		due: review !== null && review <= today && !playedToday,
		review,
		plateau: plateau(log),
		attempts: log.length,
	};
}

// Tempo a chunk starts today's session at: its owned tempo (warm-up below
// is fine), capped; or its current tempo if nothing is owned yet.
export function sessionStart(section, song) {
	const o = ownedTempo(section.log ?? []);
	const cap = section.joined ? song.cap : song.ceiling;
	const start = o ?? section.startBPM;
	return Math.min(start, cap);
}

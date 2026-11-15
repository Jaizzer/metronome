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

// Same-kind run at the end of the log, counted only at `bpm` and within
// one day (a tempo change or a new day starts a fresh streak: the ladder
// is in-session, and today's first attempt is the cold check).
export function streak(log, bpm) {
	let kind = null;
	let n = 0;
	let day = null;
	for (let i = log.length - 1; i >= 0; i--) {
		const a = log[i];
		if (a.bpm !== bpm) break;
		const d = dayKey(a.t);
		if (day === null) day = d;
		else if (d !== day) break;
		if (kind === null) kind = a.k;
		if (a.k !== kind) break;
		n++;
	}
	return { kind, n };
}

// Attempts grouped by local day, oldest day first: [{ day, list, top }].
// top = highest tempo with a ✓ that day (0 if the day had none).
export function practiceDays(log) {
	const days = new Map();
	for (const a of log) {
		const d = dayKey(a.t);
		if (!days.has(d)) days.set(d, { day: d, list: [], top: 0 });
		const e = days.get(d);
		e.list.push(a);
		if (a.k === 's') e.top = Math.max(e.top, a.bpm);
	}
	return [...days.values()];
}

// Top ✓ tempo of the last practice day before `today` (0 if that day had
// no ✓), or null when there is no earlier day.
export function previousTop(log, today = dayKey(Date.now())) {
	const before = practiceDays(log).filter((d) => d.day < today);
	return before.length ? before[before.length - 1].top : null;
}

// The day's cold check: its first attempt at or above stepDown(previous
// practice day's top ✓). Slower attempts before it are warm-ups. With no
// earlier ✓ (first day, or an all-✗ day before), the first attempt counts.
export function coldAttempts(log) {
	const out = [];
	let prevTop = 0;
	for (const { day, list, top } of practiceDays(log)) {
		const min = prevTop ? stepDown(prevTop) : 0;
		const c = list.find((a) => a.bpm >= min);
		if (c) out.push({ ...c, day });
		prevTop = top;
	}
	return out;
}

// Lowest tempo that counts as today's cold check (null: any tempo does).
export function coldThreshold(log, today = dayKey(Date.now())) {
	const top = previousTop(log, today);
	return top ? stepDown(top) : null;
}

export function isColdAttempt(log, attempt) {
	return coldAttempts(log).some((c) => c.id === attempt.id);
}

// Has today's cold check been played yet?
export function coldDoneToday(log, now = Date.now()) {
	const today = dayKey(now);
	return coldAttempts(log).some((c) => c.day === today);
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

// Top ✓ tempo per practice day, newest last; a day with only ✗ has top 0.
function sessionTops(log) {
	return practiceDays(log).map((d) => d.top);
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
	const run = (section.kind ?? 'chunk') === 'run';
	const owned = ownedTempo(log);
	const review = run ? null : nextReview(log); // runs are never due
	let state = 'new';
	if (run) state = 'run';
	else if (section.joined) state = song.bottleneck === section ? 'bottleneck' : 'joined';
	return {
		state,
		owned,
		band: band(log),
		due: review !== null && review <= today && !coldDoneToday(log, now),
		review,
		plateau: plateau(log),
		attempts: log.length,
	};
}

const capFor = (section, song) => (section.joined ? song.cap : song.ceiling);

// The tempo today's cold check is played at (the probe): the previous
// practice day's top ✓ tempo, capped. Falls back to the owned tempo, then
// the chunk's current tempo. Owned tempo then rises with a one-day lag.
export function sessionStart(section, song, now = Date.now()) {
	const log = section.log ?? [];
	const start = previousTop(log, dayKey(now)) || ownedTempo(log) || section.startBPM;
	return Math.min(start, capFor(section, song));
}

// Everything that follows one attempt on a section (the calls main.js
// makes after each ✓/✗). `section.log` must already include `attempt`.
//   action: 'up' | 'down' | 'shrink' | 'cold-miss' | null, to: new tempo
//   join: true when the chunk should be marked joined now
// Cold ✓ keeps climbing through the ladder; a cold ✗ drops the working
// tempo to max(owned, stepDown(probe)).
export function nextStep(section, sections, target, attempt) {
	if ((section.kind ?? 'chunk') === 'run') return { action: null, to: attempt.bpm, join: false };
	const log = section.log ?? [];
	const song = songState(sections, target);
	const cap = capFor(section, song);
	let r;
	if (attempt.k === 'f' && isColdAttempt(log, attempt)) {
		const to = Math.min(cap, Math.max(ownedTempo(log) ?? MIN_BPM, stepDown(attempt.bpm)));
		r = to === attempt.bpm ? { action: null, to } : { action: 'cold-miss', to };
	} else {
		r = ladder(log, attempt.bpm, cap);
	}
	return { ...r, join: shouldJoin(section, song) };
}

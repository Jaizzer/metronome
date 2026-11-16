// ============================================================
// tabplayerlogic.js — the Tab player's pure rules (docs/TAB-PLAYER.md):
// bar taps → cursor / selection, loop ends, speed, chunk chips and
// matching, the "Add as a new chunk" section, keyboard mapping and
// tick ↔ bar lookups. No DOM, no alphaTab, so node tests cover it.
//
// Bars are 1-based (as on sections' `bars: [start, end]`).
// A position: { cursor, sel: { start, end, range? } | null, anchor: bar | null, anchorBeat? }
//   cursor = where playback starts; sel = the selected (looped) bars, with
//   `range` when it is beat-level (docs/TAB-PRACTICE.md);
//   anchor = a first tap waiting for the second one that ends a selection
//   (anchorBeat: the beat point when that first tap was on a beat).
// A beat point: { bar, beat, tick, end } (tabscore.beatPoints).
// ============================================================

import { barRange, chunkName, chunkSeconds, practiceSeconds, startTempo, isDense } from './slicer.js';
import { playedRange, playedSpan, TICKS_PER_QUARTER } from './tabscore.js';

export const SPEED_MIN = 50;
export const SPEED_MAX = 150;
export const SPEED_STEP = 5;

const clampBar = (bar, total) => Math.max(1, Math.min(Math.max(1, total), Math.round(bar)));

export const position = (cursor = 1) => ({ cursor, sel: null, anchor: null });

export const normalizeSel = (a, b) => ({ start: Math.min(a, b), end: Math.max(a, b) });

// A tap on a bar. With a selection: it clears it and moves the cursor.
// Otherwise the first tap moves the cursor and arms an anchor; the next
// tap selects anchor..bar (the same bar twice = that one bar).
export function tapBar(pos, bar) {
	if (pos.sel || pos.anchor === null) return { cursor: bar, sel: null, anchor: bar };
	const sel = normalizeSel(pos.anchor, bar);
	return { cursor: sel.start, sel, anchor: null };
}

// A drag from one bar to another selects the range in one go.
export function dragBars(pos, from, to) {
	if (from === to) return tapBar(pos, to);
	const sel = normalizeSel(from, to);
	return { cursor: sel.start, sel, anchor: null };
}

// ← / → : one bar. With a selection the cursor stays inside it (it never
// leaves or snaps); without one it moves through the piece, keeping a
// pending start ([ or a first tap).
export function moveCursor(pos, delta, total) {
	if (pos.sel) {
		const cursor = Math.max(pos.sel.start, Math.min(pos.sel.end, Math.round(pos.cursor + delta)));
		return { ...pos, cursor, anchor: null };
	}
	return { ...pos, cursor: clampBar(pos.cursor + delta, total) };
}

// [ : with a selection, it now starts at the cursor (inside it, see
// moveCursor). Without one, the cursor's bar becomes a pending start that
// ] (or a tap) completes.
export function setLoopStart(pos) {
	const c = pos.cursor;
	if (pos.sel) return { cursor: c, sel: { start: c, end: Math.max(pos.sel.end, c) }, anchor: null };
	return { cursor: c, sel: null, anchor: c };
}

// ] : the selection ends at the cursor (from the pending start, else from
// the selection's start, else just this bar); the cursor goes to its start.
export function setLoopEnd(pos) {
	const c = pos.cursor;
	const from = pos.sel ? Math.min(pos.sel.start, c) : (pos.anchor ?? c);
	const sel = normalizeSel(from, c);
	return { cursor: sel.start, sel, anchor: null };
}

export const selectBars = (start, end) => ({ cursor: Math.min(start, end), sel: normalizeSel(start, end), anchor: null });

export const clearSelection = (pos) => ({ ...pos, sel: null, anchor: null });

// Where Stop returns to: the selection's start, else where playback began.
export const stopBar = (pos, playedFrom = pos.cursor) => pos.sel?.start ?? playedFrom;

// ---- Speed ----

export function clampSpeed(pct) {
	const n = Math.round((Number(pct) || 100) / SPEED_STEP) * SPEED_STEP;
	return Math.max(SPEED_MIN, Math.min(SPEED_MAX, n));
}

export const stepSpeed = (pct, dir) => clampSpeed(clampSpeed(pct) + Math.sign(dir) * SPEED_STEP);

// The tempo you'd hear at this speed (the file tempo at the cursor × speed).
export const bpmAt = (fileTempo, pct) => Math.round(((fileTempo > 0 ? fileTempo : 120) * clampSpeed(pct)) / 100);

export const speedLabel = (pct, fileTempo) => `${clampSpeed(pct)}% · ${bpmAt(fileTempo, pct)} BPM`;

// ---- Sections ↔ selections ----

const hasBars = (m) => Array.isArray(m?.bars) && m.bars.length === 2;
const kindOf = (m) => m?.kind ?? 'chunk';

// Quick-select chips: the routine's chunks (not seams or the full run),
// in bar order.
export function chunkChips(sections) {
	return (sections ?? [])
		.map((m, index) => ({ m, index }))
		.filter(({ m }) => hasBars(m) && kindOf(m) === 'chunk' && !m.seam)
		.map(({ m, index }) => ({ index, id: m.id, name: m.name, start: m.bars[0], end: m.bars[1], ...(m.range ? { range: m.range } : {}) }))
		.sort((a, b) => a.start - b.start || (a.range?.start.tick ?? 0) - (b.range?.start.tick ?? 0) || a.end - b.end || a.index - b.index);
}

// The section whose bars are exactly the selection: a chunk first, then a
// seam, then the full run. -1 when none.
export function matchSection(sections, sel) {
	if (!sel) return -1;
	const list = sections ?? [];
	const same = (m) => hasBars(m) && m.bars[0] === sel.start && m.bars[1] === sel.end && sameRange(m.range, sel.range);
	const rank = (m) => (kindOf(m) === 'run' ? 2 : m.seam ? 1 : 0);
	let best = -1;
	list.forEach((m, i) => {
		if (same(m) && (best < 0 || rank(m) < rank(list[best]))) best = i;
	});
	return best;
}

// Where a new chunk goes: before the first section (not the run) that
// starts after it, else before the full run, else at the end.
export function insertIndex(sections, start) {
	const list = sections ?? [];
	const after = list.findIndex((m) => hasBars(m) && kindOf(m) !== 'run' && m.bars[0] > start);
	if (after >= 0) return after;
	const run = list.findIndex((m) => kindOf(m) === 'run');
	return run >= 0 ? run : list.length;
}

// A new Song-mode chunk for bars sel.start..sel.end, shaped like the
// imported ones (slicer.buildSections): 70% start tempo, ~4 attempts,
// Song mode settings and the tab reference copied from the routine.
// `bars`: the slicer's bar list (for lengths and density).
export function newChunkSection(sections, sel, { bars, target, makeId = () => undefined }) {
	const like = (sections ?? []).find((m) => m.song || m.tab) ?? {};
	const song = like.song ? { ...like.song } : null;
	const goal = target ?? song?.target ?? null;
	const bpm = goal > 0 ? startTempo(goal) : (like.startBPM ?? 100);
	const inRange = (bars ?? []).filter((b) => b.index >= sel.start && b.index <= sel.end);
	const section = {
		id: makeId(),
		name: sel.range ? `Chunk · ${rangeText(sel.range)}` : chunkName('Chunk', sel.start, sel.end),
		startBPM: bpm,
		ramp: false,
		duration: !inRange.length ? 60 : sel.range ? spanSeconds(bars, sel.range, bpm) : chunkSeconds(bars, sel, bpm),
		kind: 'chunk',
		bars: [sel.start, sel.end],
	};
	if (sel.range) section.range = copyRange(sel.range);
	if (inRange.some(isDense)) section.dense = true;
	if (song) section.song = song;
	if (like.tab) section.tab = { ...like.tab };
	if (section.id === undefined) delete section.id;
	return section;
}

// A section's name without its bar range ("Verse · bars 5–6" → "Verse"),
// for the selection line that already shows the bars.
export const shortName = (name) =>
	String(name ?? '')
		.replace(/\s*·\s*bars?\s+\d+(?:–\d+)?\s*$/, '')
		.replace(/\s*·\s*bar\s+\d+\s+beats?\s+\d+(?:–\d+)?(?:\s*→\s*bar\s+\d+\s+beat\s+\d+)?\s*$/, '')
		.trim() || String(name ?? '');

const cap = (t) => t.replace(/^b/, 'B');

export const selectionLabel = (sel) => (!sel ? '' : sel.range ? cap(rangeText(sel.range)) : cap(barRange(sel.start, sel.end)));

// ---- Ticks ↔ bars (alphaTab's played-bar list, repeats expanded) ----
// played: [{ index (0-based master bar), start, end }] in playing order.

export function barAtTick(played, tick) {
	if (!played?.length) return 1;
	const hit = played.find((p) => tick >= p.start && tick < p.end);
	if (hit) return hit.index + 1;
	return (tick < played[0].start ? played[0] : played[played.length - 1]).index + 1;
}

// The first tick where a bar is played (cursor moves, seeks).
export const barStartTick = (played, bar) => playedRange(played ?? [], bar, bar)?.startTick ?? null;

// The ticks a selection plays (the first time the piece plays it through;
// beat-level selections from their first beat to the end of their last).
export const selectionTicks = (played, sel) => (sel ? playedSpan(played ?? [], sel) : null);

// ---- Keys ----
// What a key does in the Tab player. `field`: focus is in an input,
// select or textarea; `control`: focus is on a button / summary (the
// keyboard's Enter and Space press it). The pedal sends Enter: with no
// control focused it goes to the pedal (✓ / ✗ / undo, docs/TAB-PRACTICE.md),
// auto-repeat included (pedal.js ignores it); Space plays/pauses.
export function keyAction({ key, field = false, control = false, repeat = false, meta = false, shift = false }) {
	if (meta) return null;
	if (key === 'Escape') return field ? null : 'exit';
	if (field) return null;
	if (key === 'Enter') return control ? null : 'pedal';
	if (key === ' ') return control || repeat ? null : 'toggle';
	if (key === 'ArrowLeft') return shift ? 'endPrev' : 'prev';
	if (key === 'ArrowRight') return shift ? 'endNext' : 'next';
	if (key === '[') return 'loopStart';
	if (key === ']') return 'loopEnd';
	return null;
}

// ---- Beat-level ranges (docs/TAB-PRACTICE.md) ----
// range: { start: { bar, beat, tick }, end: { bar, beat, tick } }; start.tick
// = where the span starts in its bar, end.tick = where it ends in its bar
// (after the end beat). `beats`: every beat point in score order.

const before = (a, b) => a.bar < b.bar || (a.bar === b.bar && a.tick < b.tick);

const copyRange = (r) => ({ start: { ...r.start }, end: { ...r.end } });

// Same span (by bars and ticks; beat numbers are only labels). Both
// missing = both bar-level = same.
export function sameRange(a, b) {
	if (!a || !b) return !a && !b;
	return a.start.bar === b.start.bar && a.start.tick === b.start.tick && a.end.bar === b.end.bar && a.end.tick === b.end.tick;
}

export const sameSel = (a, b) => (!a || !b ? !a && !b : a.start === b.start && a.end === b.end && sameRange(a.range, b.range));

// The range from beat a to beat b (either order), both included.
export function beatRange(a, b) {
	const [s, e] = before(b, a) ? [b, a] : [a, b];
	return { start: { bar: s.bar, beat: s.beat, tick: s.tick }, end: { bar: e.bar, beat: e.beat, tick: e.end } };
}

export const firstBeat = (beats, bar) => (beats ?? []).find((p) => p.bar === bar) ?? null;
export function lastBeat(beats, bar) {
	const list = (beats ?? []).filter((p) => p.bar === bar);
	return list[list.length - 1] ?? null;
}

// The beat points at a range's ends (found by ticks, so a range made on
// another track still lands on this track's beats).
export function rangePoints(range, beats) {
	const inBar = (bar) => (beats ?? []).filter((p) => p.bar === bar);
	const s = inBar(range.start.bar);
	const e = inBar(range.end.bar);
	const a = s.find((p) => p.end > range.start.tick) ?? s[s.length - 1] ?? null;
	const z = [...e].reverse().find((p) => p.tick < range.end.tick) ?? e[0] ?? null;
	return { a, z };
}

// A selection from a range: whole bars (first beat of the first bar to the
// last beat of the last bar) are a plain bar selection.
export function selFromRange(range, beats) {
	const sel = { start: range.start.bar, end: range.end.bar };
	const f = firstBeat(beats, range.start.bar);
	const l = lastBeat(beats, range.end.bar);
	const whole = range.start.tick <= (f?.tick ?? 0) && (!l || range.end.tick >= l.end);
	return whole ? sel : { ...sel, range: copyRange(range) };
}

const fromRange = (range, beats) => {
	const sel = selFromRange(range, beats);
	return { cursor: sel.start, sel, anchor: null };
};

// A tap on a beat: like tapBar, at beat level. With a bar-level pending
// start ([ or a bar-number tap), the second beat pairs with that bar's
// first beat (or its last, when the beat comes before it).
export function tapBeat(pos, point, beats) {
	if (pos.sel || pos.anchor === null) return { cursor: point.bar, sel: null, anchor: point.bar, anchorBeat: point };
	let a = pos.anchorBeat;
	if (!a) a = (point.bar < pos.anchor ? lastBeat(beats, pos.anchor) : firstBeat(beats, pos.anchor)) ?? point;
	return fromRange(beatRange(a, point), beats);
}

// A mouse drag from one beat to another selects in one go.
export function dragBeats(pos, from, to, beats) {
	if (from.bar === to.bar && from.beat === to.beat) return tapBeat(pos, to, beats);
	return fromRange(beatRange(from, to), beats);
}

// The beat points a selection spans (bar selections: first to last beat).
export function selPoints(sel, beats) {
	if (!sel) return null;
	if (sel.range) return rangePoints(sel.range, beats);
	return { a: firstBeat(beats, sel.start), z: lastBeat(beats, sel.end) };
}

// A handle dragged to `point`: that end moves there, never past the other.
export function moveEnd(pos, which, point, beats) {
	const pts = selPoints(pos.sel, beats);
	if (!pts?.a || !pts?.z) return pos;
	let { a, z } = pts;
	if (which === 'start') a = before(z, point) ? z : point;
	else z = before(point, a) ? a : point;
	return fromRange(beatRange(a, z), beats);
}

// Shift+← / Shift+→: the selection's end moves one beat (never before its
// start). With nothing selected, the cursor bar's first beat is selected.
export function stepEnd(pos, delta, beats) {
	const list = beats ?? [];
	if (!pos.sel) {
		const f = firstBeat(list, pos.cursor);
		return f ? fromRange(beatRange(f, f), list) : pos;
	}
	const { a, z } = selPoints(pos.sel, list) ?? {};
	if (!a || !z) return pos;
	const i = list.indexOf(z);
	const next = list[Math.max(list.indexOf(a), Math.min(list.length - 1, i + Math.sign(delta)))] ?? z;
	return fromRange(beatRange(a, next), list);
}

// "bar 5 beat 3 → bar 7 beat 2", "bar 5 beats 3–6", "bar 5 beat 3".
export function rangeText(range) {
	const { start: s, end: e } = range;
	if (s.bar !== e.bar) return `bar ${s.bar} beat ${s.beat} → bar ${e.bar} beat ${e.beat}`;
	return s.beat === e.beat ? `bar ${s.bar} beat ${s.beat}` : `bar ${s.bar} beats ${s.beat}–${e.beat}`;
}

// Ticks a range lasts, played straight through. `bars`: the slicer's bar
// list (each with `ticks`; 4/4 = 3840 when missing).
export function spanTicks(bars, range) {
	const ticksOf = (i) => (bars ?? []).find((b) => b.index === i)?.ticks ?? TICKS_PER_QUARTER * 4;
	let n = 0;
	for (let i = range.start.bar; i <= range.end.bar; i++) n += ticksOf(i);
	return Math.max(0, n - range.start.tick - (ticksOf(range.end.bar) - range.end.tick));
}

// Practice length for a beat range (like chunkSeconds: ~4 attempts, each
// the span plus one bar of rest).
export function spanSeconds(bars, range, bpm) {
	const last = (bars ?? []).find((b) => b.index === range.end.bar);
	return practiceSeconds(spanTicks(bars, range) / TICKS_PER_QUARTER, last?.beats > 0 ? last.beats : 4, bpm);
}

// ---- Where the pedal records (docs/TAB-PRACTICE.md §5a) ----

// Does a section contain a playing position { bar, offset } (offset = ticks
// into that bar)? Works in any pass of a repeat.
export function contains(m, at) {
	if (!hasBars(m) || at.bar < m.bars[0] || at.bar > m.bars[1]) return false;
	const r = m.range;
	if (!r) return true;
	if (at.bar === r.start.bar && at.offset < r.start.tick) return false;
	if (at.bar === r.end.bar && at.offset >= r.end.tick) return false;
	return true;
}

// The section the pedal records to: the one matching the selection (-1 if
// none matches); with no selection, the one containing the position:
// chunks before seams before the run, then the shortest, then list order.
// barTicks(bar) → ticks in that bar (for lengths).
export function pedalTarget(sections, sel, at, barTicks = () => TICKS_PER_QUARTER * 4) {
	const list = sections ?? [];
	if (sel) return matchSection(list, sel);
	if (!at) return -1;
	const rank = (m) => (kindOf(m) === 'run' ? 2 : m.seam ? 1 : 0);
	const len = (m) => {
		let n = 0;
		for (let i = m.bars[0]; i <= m.bars[1]; i++) n += barTicks(i);
		return m.range ? n - m.range.start.tick - (barTicks(m.bars[1]) - m.range.end.tick) : n;
	};
	let best = -1;
	list.forEach((m, i) => {
		if (!contains(m, at)) return;
		if (best < 0) return (best = i);
		const b = list[best];
		if (rank(m) < rank(b) || (rank(m) === rank(b) && len(m) < len(b))) best = i;
	});
	return best;
}

// ---- Speed lock (Song mode chunk selected) ----

export const LOCK_MIN = 0.25;
export const LOCK_MAX = 2;

// Playback speed for a practice BPM over the file tempo: any ratio from
// 25% to 200% (not rounded to 5%). bpm = what is actually heard.
export function speedLock(bpm, fileTempo) {
	const ft = fileTempo > 0 ? fileTempo : 120;
	const ratio = Math.max(LOCK_MIN, Math.min(LOCK_MAX, (bpm > 0 ? bpm : ft) / ft));
	return { ratio, pct: Math.round(ratio * 100), bpm: Math.round(ratio * ft) };
}

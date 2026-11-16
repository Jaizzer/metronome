// ============================================================
// tabplayerlogic.js — the Tab player's pure rules (docs/TAB-PLAYER.md):
// bar taps → cursor / selection, loop ends, speed, chunk chips and
// matching, the "Add as a new chunk" section, keyboard mapping and
// tick ↔ bar lookups. No DOM, no alphaTab, so node tests cover it.
//
// Bars are 1-based (as on sections' `bars: [start, end]`).
// A position: { cursor, sel: { start, end } | null, anchor: bar | null }
//   cursor = where playback starts; sel = the selected (looped) bars;
//   anchor = a first tap waiting for the second one that ends a selection.
// ============================================================

import { barRange, chunkName, chunkSeconds, startTempo, isDense } from './slicer.js';
import { playedRange } from './tabscore.js';

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
		.map(({ m, index }) => ({ index, id: m.id, name: m.name, start: m.bars[0], end: m.bars[1] }))
		.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
}

// The section whose bars are exactly the selection: a chunk first, then a
// seam, then the full run. -1 when none.
export function matchSection(sections, sel) {
	if (!sel) return -1;
	const list = sections ?? [];
	const same = (m) => hasBars(m) && m.bars[0] === sel.start && m.bars[1] === sel.end;
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
		name: chunkName('Chunk', sel.start, sel.end),
		startBPM: bpm,
		ramp: false,
		duration: inRange.length ? chunkSeconds(bars, sel, bpm) : 60,
		kind: 'chunk',
		bars: [sel.start, sel.end],
	};
	if (inRange.some(isDense)) section.dense = true;
	if (song) section.song = song;
	if (like.tab) section.tab = { ...like.tab };
	if (section.id === undefined) delete section.id;
	return section;
}

// A section's name without its bar range ("Verse · bars 5–6" → "Verse"),
// for the selection line that already shows the bars.
export const shortName = (name) => String(name ?? '').replace(/\s*·\s*bars?\s+\d+(?:–\d+)?\s*$/, '').trim() || String(name ?? '');

export const selectionLabel = (sel) => (sel ? barRange(sel.start, sel.end).replace(/^b/, 'B') : '');

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

// The ticks a selection plays (the first time the piece plays it through).
export const selectionTicks = (played, sel) => (sel ? playedRange(played ?? [], sel.start, sel.end) : null);

// ---- Keys ----
// What a key does in the Tab player. `field`: focus is in an input,
// select or textarea; `control`: focus is on a button / summary (the
// keyboard's Enter and Space press it). The pedal sends Enter: with no
// control focused it plays/pauses, like Space (no ✓/✗ here).
export function keyAction({ key, field = false, control = false, repeat = false, meta = false }) {
	if (meta) return null;
	if (key === 'Escape') return field ? null : 'exit';
	if (field) return null;
	if (key === ' ' || key === 'Enter') return control || repeat ? null : 'toggle';
	if (key === 'ArrowLeft') return 'prev';
	if (key === 'ArrowRight') return 'next';
	if (key === '[') return 'loopStart';
	if (key === ']') return 'loopEnd';
	return null;
}

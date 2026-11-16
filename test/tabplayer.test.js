import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	position,
	tapBar,
	dragBars,
	moveCursor,
	setLoopStart,
	setLoopEnd,
	selectBars,
	clearSelection,
	stopBar,
	clampSpeed,
	stepSpeed,
	bpmAt,
	speedLabel,
	chunkChips,
	matchSection,
	insertIndex,
	newChunkSection,
	selectionLabel,
	shortName,
	barAtTick,
	barStartTick,
	selectionTicks,
	keyAction,
	sameRange,
	sameSel,
	beatRange,
	firstBeat,
	lastBeat,
	rangePoints,
	selFromRange,
	tapBeat,
	dragBeats,
	moveEnd,
	stepEnd,
	rangeText,
	spanTicks,
	spanSeconds,
	contains,
	pedalTarget,
	speedLock,
} from '../src/tabplayerlogic.js';

const bar = (index, extra = {}) => ({ index, beats: 4, notes: 8, shortNotes: 0, legato: 0, marker: null, tempo: null, phraseEnd: false, ...extra });

// The etude import: chunks, seams and the run as buildSections makes them.
const song = { on: true, target: 100 };
const tab = { title: 'Fixture Etude', track: 0, bars: 10, format: 'score' };
const sections = [
	{ id: 'a', name: 'Intro · bars 1–4', kind: 'chunk', bars: [1, 4], song, tab, startBPM: 70 },
	{ id: 'b', name: 'Verse · bars 5–6', kind: 'chunk', bars: [5, 6], song, tab, startBPM: 70 },
	{ id: 'c', name: 'Seam · bars 4–5', kind: 'chunk', bars: [4, 5], seam: true, song, tab, startBPM: 70 },
	{ id: 'd', name: 'Verse · bars 7–8', kind: 'chunk', bars: [7, 8], dense: true, song, tab, startBPM: 70 },
	{ id: 'e', name: 'Seam · bars 6–7', kind: 'chunk', bars: [6, 7], seam: true, song, tab, startBPM: 70 },
	{ id: 'f', name: 'Full run · bars 1–10', kind: 'run', bars: [1, 10], song, tab, startBPM: 70 },
];

test('tap: first tap moves the cursor and arms an anchor', () => {
	assert.deepEqual(tapBar(position(1), 5), { cursor: 5, sel: null, anchor: 5 });
});

test('tap: a second tap selects from the anchor (either direction)', () => {
	assert.deepEqual(tapBar({ cursor: 5, sel: null, anchor: 5 }, 8), { cursor: 5, sel: { start: 5, end: 8 }, anchor: null });
	assert.deepEqual(tapBar({ cursor: 8, sel: null, anchor: 8 }, 3), { cursor: 3, sel: { start: 3, end: 8 }, anchor: null });
});

test('tap: the same bar twice selects that one bar', () => {
	assert.deepEqual(tapBar(tapBar(position(), 4), 4).sel, { start: 4, end: 4 });
});

test('tap: with a selection, a tap clears it and moves the cursor', () => {
	assert.deepEqual(tapBar({ cursor: 5, sel: { start: 5, end: 6 }, anchor: null }, 9), { cursor: 9, sel: null, anchor: 9 });
});

test('drag selects a range; a drag that stays on one bar is a tap', () => {
	assert.deepEqual(dragBars(position(), 7, 3), { cursor: 3, sel: { start: 3, end: 7 }, anchor: null });
	assert.deepEqual(dragBars(position(), 4, 4), { cursor: 4, sel: null, anchor: 4 });
});

test('arrows: without a selection, one bar through the piece', () => {
	assert.equal(moveCursor(position(5), 1, 10).cursor, 6);
	assert.equal(moveCursor(position(1), -1, 10).cursor, 1);
	assert.equal(moveCursor(position(10), 1, 10).cursor, 10);
	// A pending start ([ or a first tap) is kept.
	assert.deepEqual(moveCursor({ cursor: 5, sel: null, anchor: 5 }, 1, 10), { cursor: 6, sel: null, anchor: 5 });
});

test('arrows: with a selection, the cursor stays inside it', () => {
	const p = { cursor: 5, sel: { start: 5, end: 6 }, anchor: null };
	assert.deepEqual(moveCursor(p, 1, 10), { cursor: 6, sel: { start: 5, end: 6 }, anchor: null });
	assert.equal(moveCursor({ ...p, cursor: 6 }, 1, 10).cursor, 6);
	assert.equal(moveCursor(p, -1, 10).cursor, 5);
	assert.deepEqual(moveCursor(p, -1, 10).sel, { start: 5, end: 6 });
});

test('[ without a selection marks a pending start; ] completes it', () => {
	assert.deepEqual(setLoopStart(position(3)), { cursor: 3, sel: null, anchor: 3 });
	// [ then → → ] = three bars, cursor back at the start.
	let p = setLoopStart(position(5));
	p = moveCursor(moveCursor(p, 1, 10), 1, 10);
	assert.deepEqual(setLoopEnd(p), { cursor: 5, sel: { start: 5, end: 7 }, anchor: null });
	// ] before the pending start: the same bars, in order.
	p = moveCursor(moveCursor(setLoopStart(position(5)), -1, 10), -1, 10);
	assert.deepEqual(setLoopEnd(p).sel, { start: 3, end: 5 });
	// ] with nothing pending: just this bar.
	assert.deepEqual(setLoopEnd(position(4)).sel, { start: 4, end: 4 });
});

test('[ / ] with a selection trim it at the cursor', () => {
	assert.deepEqual(setLoopStart({ cursor: 6, sel: { start: 5, end: 8 }, anchor: null }), { cursor: 6, sel: { start: 6, end: 8 }, anchor: null });
	assert.deepEqual(setLoopEnd({ cursor: 7, sel: { start: 5, end: 8 }, anchor: null }), { cursor: 5, sel: { start: 5, end: 7 }, anchor: null });
});

test('selectBars, clearSelection, stopBar', () => {
	assert.deepEqual(selectBars(6, 5), { cursor: 5, sel: { start: 5, end: 6 }, anchor: null });
	assert.deepEqual(clearSelection({ cursor: 5, sel: { start: 5, end: 6 }, anchor: 2 }), { cursor: 5, sel: null, anchor: null });
	assert.equal(stopBar({ cursor: 9, sel: { start: 5, end: 6 } }, 9), 5);
	assert.equal(stopBar({ cursor: 9, sel: null }, 3), 3);
});

test('speed: 50–150% in 5% steps', () => {
	assert.equal(clampSpeed(73), 75);
	assert.equal(clampSpeed(10), 50);
	assert.equal(clampSpeed(400), 150);
	assert.equal(clampSpeed(undefined), 100);
	assert.equal(stepSpeed(100, -1), 95);
	assert.equal(stepSpeed(150, 1), 150);
	assert.equal(stepSpeed(50, -1), 50);
});

test('speed → BPM equivalent from the file tempo', () => {
	assert.equal(bpmAt(100, 75), 75);
	assert.equal(bpmAt(90, 75), 68); // 67.5 rounds up
	assert.equal(bpmAt(null, 50), 60); // no tempo: alphaTab plays at 120
	assert.equal(speedLabel(75, 100), '75% · 75 BPM');
	assert.equal(speedLabel(100, 132), '100% · 132 BPM');
});

test('chips: chunks only, in bar order, with their section index', () => {
	assert.deepEqual(
		chunkChips(sections).map((c) => [c.index, c.start, c.end]),
		[
			[0, 1, 4],
			[1, 5, 6],
			[3, 7, 8],
		],
	);
	assert.deepEqual(chunkChips([{ name: 'Plain', startBPM: 90 }]), []);
});

test('match: exact bars; chunk before seam before run', () => {
	assert.equal(matchSection(sections, { start: 5, end: 6 }), 1);
	assert.equal(matchSection(sections, { start: 4, end: 5 }), 2); // the seam
	assert.equal(matchSection(sections, { start: 1, end: 10 }), 5); // the run
	assert.equal(matchSection(sections, { start: 5, end: 7 }), -1);
	assert.equal(matchSection(sections, null), -1);
	const both = [...sections, { id: 'g', name: 'Chunk · bars 4–5', kind: 'chunk', bars: [4, 5] }];
	assert.equal(matchSection(both, { start: 4, end: 5 }), 6); // a chunk wins over the seam
});

test('insertIndex: before the first later section, else before the run', () => {
	assert.equal(insertIndex(sections, 3), 1); // before Verse 5–6
	assert.equal(insertIndex(sections, 9), 5); // before the full run
	assert.equal(insertIndex([{ name: 'x' }], 2), 1);
});

test('newChunkSection: shaped like an imported chunk', () => {
	const bars = Array.from({ length: 10 }, (_, i) => bar(i + 1, i + 1 === 4 ? { notes: 16, shortNotes: 16 } : {}));
	const s = newChunkSection(sections, { start: 3, end: 5 }, { bars, makeId: () => 'new' });
	assert.equal(s.id, 'new');
	assert.equal(s.name, 'Chunk · bars 3–5');
	assert.equal(s.kind, 'chunk');
	assert.deepEqual(s.bars, [3, 5]);
	assert.equal(s.startBPM, 70); // 70% of the target
	// 4 attempts × (12 + 4 beats) at 70 BPM = 54.9 s → 55
	assert.equal(s.duration, 55);
	assert.equal(s.dense, true); // bar 4 is dense
	assert.deepEqual(s.song, song);
	assert.notEqual(s.song, song); // a copy
	assert.deepEqual(s.tab, tab);
	assert.equal(s.ramp, false);
	assert.equal('seam' in s, false);
	const plain = newChunkSection([], { start: 1, end: 1 }, { bars, target: 120 });
	assert.equal('id' in plain, false);
	assert.equal(plain.startBPM, 84);
	assert.equal('dense' in plain, false);
});

test('shortName drops the bar range from a section name', () => {
	assert.equal(shortName('Verse · bars 5–6'), 'Verse');
	assert.equal(shortName('Chunk · bars 3–5'), 'Chunk');
	assert.equal(shortName('Solo · bar 9'), 'Solo');
	assert.equal(shortName('Fast run'), 'Fast run');
	assert.equal(shortName('Seam · bars 4–5'), 'Seam');
});

test('selectionLabel', () => {
	assert.equal(selectionLabel({ start: 5, end: 6 }), 'Bars 5–6');
	assert.equal(selectionLabel({ start: 4, end: 4 }), 'Bar 4');
	assert.equal(selectionLabel(null), '');
});

// 4 bars of 3840 ticks; bars 2–3 repeated once (1 2 3 2 3 4).
const played = [
	{ index: 0, start: 0, end: 3840 },
	{ index: 1, start: 3840, end: 7680 },
	{ index: 2, start: 7680, end: 11520 },
	{ index: 1, start: 11520, end: 15360 },
	{ index: 2, start: 15360, end: 19200 },
	{ index: 3, start: 19200, end: 23040 },
];

test('ticks → bars, repeats expanded', () => {
	assert.equal(barAtTick(played, 0), 1);
	assert.equal(barAtTick(played, 8000), 3);
	assert.equal(barAtTick(played, 12000), 2); // the repeat
	assert.equal(barAtTick(played, 99999), 4);
	assert.equal(barAtTick([], 500), 1);
	assert.equal(barStartTick(played, 2), 3840); // first time it's played
	assert.equal(barStartTick(played, 9), null);
	assert.deepEqual(selectionTicks(played, { start: 2, end: 3 }), { startTick: 3840, endTick: 11520 });
	assert.deepEqual(selectionTicks(played, { start: 3, end: 4 }), { startTick: 15360, endTick: 23040 }); // played straight through only after the repeat
	assert.equal(selectionTicks(played, null), null);
});

test('keys: Space plays/pauses, the pedal Enter records; arrows; [ ]; Escape', () => {
	assert.equal(keyAction({ key: ' ' }), 'toggle');
	assert.equal(keyAction({ key: ' ', repeat: true }), null);
	assert.equal(keyAction({ key: 'Enter' }), 'pedal');
	assert.equal(keyAction({ key: 'Enter', repeat: true }), 'pedal'); // pedal.js ignores the repeat
	assert.equal(keyAction({ key: 'ArrowLeft', shift: true }), 'endPrev');
	assert.equal(keyAction({ key: 'ArrowRight', shift: true }), 'endNext');
	assert.equal(keyAction({ key: 'ArrowLeft' }), 'prev');
	assert.equal(keyAction({ key: 'ArrowRight' }), 'next');
	assert.equal(keyAction({ key: '[' }), 'loopStart');
	assert.equal(keyAction({ key: ']' }), 'loopEnd');
	assert.equal(keyAction({ key: 'Escape' }), 'exit');
	assert.equal(keyAction({ key: 'x' }), null);
});

test('keys: never from a field; a focused control keeps Enter/Space', () => {
	for (const key of ['Enter', ' ', 'ArrowLeft', '[', ']', 'Escape']) assert.equal(keyAction({ key, field: true }), null, key);
	assert.equal(keyAction({ key: 'Enter', control: true }), null);
	assert.equal(keyAction({ key: ' ', control: true }), null);
	assert.equal(keyAction({ key: 'ArrowRight', control: true }), 'next');
	assert.equal(keyAction({ key: ' ', meta: true }), null);
});

// ---- Phase 5 (docs/TAB-PRACTICE.md) ----

// Beat points for 4 bars of 4/4: bar 1 four quarters, bar 2 eight eighths,
// bar 3 four quarters, bar 4 a whole note.
const pts = [];
const addBar = (barNo, lens) => {
	let t = 0;
	lens.forEach((len, i) => {
		pts.push({ bar: barNo, beat: i + 1, tick: t, end: t + len });
		t += len;
	});
};
addBar(1, [960, 960, 960, 960]);
addBar(2, Array(8).fill(480));
addBar(3, [960, 960, 960, 960]);
addBar(4, [3840]);
const P = (bar, beat) => pts.find((p) => p.bar === bar && p.beat === beat);

test('beat range: either order, both beats included', () => {
	const r = beatRange(P(2, 3), P(3, 2));
	assert.deepEqual(r, { start: { bar: 2, beat: 3, tick: 960 }, end: { bar: 3, beat: 2, tick: 1920 } });
	assert.deepEqual(beatRange(P(3, 2), P(2, 3)), r);
	assert.deepEqual(beatRange(P(1, 2), P(1, 2)), { start: { bar: 1, beat: 2, tick: 960 }, end: { bar: 1, beat: 2, tick: 1920 } });
	assert.equal(firstBeat(pts, 2), P(2, 1));
	assert.equal(lastBeat(pts, 2), P(2, 8));
	assert.deepEqual(rangePoints(r, pts), { a: P(2, 3), z: P(3, 2) });
});

test('beat range labels', () => {
	assert.equal(rangeText(beatRange(P(2, 3), P(3, 2))), 'bar 2 beat 3 → bar 3 beat 2');
	assert.equal(rangeText(beatRange(P(2, 3), P(2, 6))), 'bar 2 beats 3–6');
	assert.equal(rangeText(beatRange(P(2, 3), P(2, 3))), 'bar 2 beat 3');
	assert.equal(selectionLabel({ start: 5, end: 7, range: { start: { bar: 5, beat: 3, tick: 1920 }, end: { bar: 7, beat: 2, tick: 1920 } } }), 'Bar 5 beat 3 → bar 7 beat 2');
	assert.equal(shortName('Chunk · bar 5 beat 3 → bar 7 beat 2'), 'Chunk');
	assert.equal(shortName('Riff · bar 5 beats 3–6'), 'Riff');
	assert.equal(shortName('Riff · bar 5 beat 3'), 'Riff');
});

test('whole bars from beats are a bar selection', () => {
	assert.deepEqual(selFromRange(beatRange(P(2, 1), P(3, 4)), pts), { start: 2, end: 3 });
	const sel = selFromRange(beatRange(P(2, 2), P(3, 4)), pts);
	assert.deepEqual(sel, { start: 2, end: 3, range: { start: { bar: 2, beat: 2, tick: 480 }, end: { bar: 3, beat: 4, tick: 3840 } } });
});

test('beat taps: pending start, second tap selects, a tap with a selection starts over', () => {
	let p = tapBeat(position(1), P(2, 3), pts);
	assert.deepEqual(p, { cursor: 2, sel: null, anchor: 2, anchorBeat: P(2, 3) });
	p = tapBeat(p, P(1, 2), pts);
	assert.deepEqual(p.sel, { start: 1, end: 2, range: { start: { bar: 1, beat: 2, tick: 960 }, end: { bar: 2, beat: 3, tick: 1440 } } });
	assert.equal(p.cursor, 1);
	assert.equal(p.anchor, null);
	p = tapBeat(p, P(3, 1), pts);
	assert.deepEqual(p, { cursor: 3, sel: null, anchor: 3, anchorBeat: P(3, 1) });
	// After a bar-level pending start ([ or a bar-number tap): from that bar's first beat …
	assert.deepEqual(tapBeat({ cursor: 2, sel: null, anchor: 2 }, P(3, 2), pts).sel.range.start, { bar: 2, beat: 1, tick: 0 });
	// … or to its last beat when the beat comes first.
	assert.deepEqual(tapBeat({ cursor: 2, sel: null, anchor: 2 }, P(1, 3), pts).sel.range.end, { bar: 2, beat: 8, tick: 3840 });
	// A bar tap after a beat tap is bar-level.
	assert.deepEqual(tapBar(tapBeat(position(1), P(2, 3), pts), 3), { cursor: 2, sel: { start: 2, end: 3 }, anchor: null });
});

test('mouse drag beat to beat', () => {
	assert.deepEqual(dragBeats(position(1), P(3, 3), P(2, 5), pts).sel.range, { start: { bar: 2, beat: 5, tick: 1920 }, end: { bar: 3, beat: 3, tick: 2880 } });
	assert.equal(dragBeats(position(1), P(3, 3), P(3, 3), pts).anchorBeat, P(3, 3));
});

test('handles: each end moves to a beat, never past the other', () => {
	const pos = fromSel(beatRange(P(2, 3), P(3, 2)));
	assert.deepEqual(moveEnd(pos, 'end', P(3, 4), pts).sel.range.end, { bar: 3, beat: 4, tick: 3840 });
	assert.deepEqual(moveEnd(pos, 'start', P(1, 4), pts).sel.range.start, { bar: 1, beat: 4, tick: 2880 });
	// Past the other end: stops on it.
	assert.deepEqual(moveEnd(pos, 'end', P(1, 1), pts).sel.range, beatRange(P(2, 3), P(2, 3)));
	assert.deepEqual(moveEnd(pos, 'start', P(4, 1), pts).sel.range, beatRange(P(3, 2), P(3, 2)));
	// A bar selection gets beat-level ends.
	assert.deepEqual(moveEnd({ cursor: 2, sel: { start: 2, end: 3 }, anchor: null }, 'end', P(3, 3), pts).sel.range, beatRange(P(2, 1), P(3, 3)));
});
function fromSel(range) {
	return { cursor: range.start.bar, sel: selFromRange(range, pts), anchor: null };
}

test('Shift+arrows move the end one beat', () => {
	let pos = stepEnd(position(2), 1, pts); // nothing selected: the cursor bar's first beat
	assert.deepEqual(pos.sel.range, beatRange(P(2, 1), P(2, 1)));
	pos = stepEnd(pos, 1, pts);
	assert.deepEqual(pos.sel.range, beatRange(P(2, 1), P(2, 2)));
	pos = stepEnd(stepEnd(pos, -1, pts), -1, pts); // never before the start
	assert.deepEqual(pos.sel.range, beatRange(P(2, 1), P(2, 1)));
	// Across a bar line; a bar selection starts from its last beat.
	pos = stepEnd({ cursor: 2, sel: { start: 2, end: 2 }, anchor: null }, 1, pts);
	assert.deepEqual(pos.sel.range, beatRange(P(2, 1), P(3, 1)));
	pos = stepEnd(pos, -1, pts);
	assert.deepEqual(pos.sel, { start: 2, end: 2 }); // whole bar again
});

test('chips and matching with beat ranges', () => {
	const range = beatRange(P(2, 3), P(3, 2));
	const list = [...sections, { id: 'r', name: 'Chunk · bar 2 beat 3 → bar 3 beat 2', kind: 'chunk', bars: [2, 3], range }];
	const sel = selFromRange(range, pts);
	assert.equal(matchSection(list, sel), 6);
	assert.equal(matchSection(list, { start: 2, end: 3 }), -1); // bar-level ≠ beat-level
	assert.equal(matchSection([{ name: 'x', bars: [2, 3] }], sel), -1);
	assert.equal(matchSection(list, { ...sel, range: { ...range, end: { ...range.end, tick: 960 } } }), -1);
	// Beat numbers are labels: the ticks decide.
	assert.equal(matchSection(list, { ...sel, range: { start: { ...range.start, beat: 9 }, end: range.end } }), 6);
	const chips = chunkChips(list);
	assert.deepEqual(chips.map((c) => c.index), [0, 6, 1, 3]);
	assert.deepEqual(chips[1].range, range);
	assert.equal(sameRange(undefined, null), true);
	assert.equal(sameRange(range, undefined), false);
	assert.equal(sameSel(sel, { ...sel }), true);
	assert.equal(sameSel(sel, { start: 2, end: 3 }), false);
});

test('beat range ↔ ticks, repeats expanded', () => {
	// played: 1 2 3 2 3 4 (bars 2–3 repeated), 3840 ticks a bar.
	const range = { start: { bar: 2, beat: 3, tick: 960 }, end: { bar: 3, beat: 2, tick: 1920 } };
	assert.deepEqual(selectionTicks(played, { start: 2, end: 3, range }), { startTick: 3840 + 960, endTick: 7680 + 1920 });
	// 3 → 4 is played straight through only on the second pass.
	const r34 = { start: { bar: 3, beat: 4, tick: 2880 }, end: { bar: 4, beat: 1, tick: 960 } };
	assert.deepEqual(selectionTicks(played, { start: 3, end: 4, range: r34 }), { startTick: 15360 + 2880, endTick: 19200 + 960 });
	// One bar, the second half.
	assert.deepEqual(selectionTicks(played, { start: 4, end: 4, range: { start: { bar: 4, beat: 3, tick: 1920 }, end: { bar: 4, beat: 4, tick: 3840 } } }), { startTick: 21120, endTick: 23040 });
	assert.equal(selectionTicks(played, { start: 8, end: 9, range: { start: { bar: 8, beat: 1, tick: 0 }, end: { bar: 9, beat: 1, tick: 960 } } }), null);
});

test('durations from ticks', () => {
	const bars10 = Array.from({ length: 10 }, (_, i) => bar(i + 1, { ticks: 3840 }));
	const range = { start: { bar: 5, beat: 3, tick: 1920 }, end: { bar: 7, beat: 2, tick: 1920 } };
	assert.equal(spanTicks(bars10, range), 1920 + 3840 + 1920); // 8 quarter beats
	// 4 attempts × (8 + 4 beats) at 70 BPM = 41.1 s → 45
	assert.equal(spanSeconds(bars10, range, 70), 45);
	// 3/4 bars (2880 ticks): bar 2 beat 2 → bar 3 beat 1.
	const waltz = Array.from({ length: 4 }, (_, i) => bar(i + 1, { ticks: 2880, beats: 3 }));
	assert.equal(spanTicks(waltz, { start: { bar: 2, beat: 2, tick: 960 }, end: { bar: 3, beat: 1, tick: 960 } }), 2880);
});

test('newChunkSection saves a beat range (and reloads as the same selection)', () => {
	const bars10 = Array.from({ length: 10 }, (_, i) => bar(i + 1, { ticks: 3840 }));
	const range = { start: { bar: 5, beat: 3, tick: 1920 }, end: { bar: 7, beat: 2, tick: 1920 } };
	const sel = { start: 5, end: 7, range };
	const s = newChunkSection(sections, sel, { bars: bars10, makeId: () => 'n' });
	assert.equal(s.name, 'Chunk · bar 5 beat 3 → bar 7 beat 2');
	assert.deepEqual(s.bars, [5, 7]);
	assert.deepEqual(s.range, range);
	assert.notEqual(s.range.start, range.start); // a copy
	assert.equal(s.duration, 45);
	assert.equal(s.startBPM, 70);
	// Through JSON (the jsonb column) and back: still matches the selection.
	const list = JSON.parse(JSON.stringify([...sections, s]));
	assert.equal(matchSection(list, sel), sections.length);
	assert.equal(chunkChips(list).find((c) => c.id === 'n').range.end.tick, 1920);
});

test('pedal target: the selected chunk, else the chunk under the cursor', () => {
	// Selection: the matching section, or none.
	assert.equal(pedalTarget(sections, { start: 5, end: 6 }, { bar: 9, offset: 0 }), 1);
	assert.equal(pedalTarget(sections, { start: 5, end: 7 }, { bar: 5, offset: 0 }), -1);
	// No selection: chunk before seam before run.
	assert.equal(pedalTarget(sections, null, { bar: 5, offset: 0 }), 1); // Verse 5–6, not seam 4–5
	assert.equal(pedalTarget(sections, null, { bar: 4, offset: 100 }), 0); // Intro 1–4
	assert.equal(pedalTarget(sections, null, { bar: 10, offset: 0 }), 5); // only the run
	assert.equal(pedalTarget([sections[2]], null, { bar: 5, offset: 0 }), 0); // a seam when it's all there is
	assert.equal(pedalTarget(sections, null, { bar: 11, offset: 0 }), -1);
	assert.equal(pedalTarget(sections, null, null), -1);
	// The smallest containing chunk; beat ranges by offset.
	const range = { start: { bar: 5, beat: 3, tick: 1920 }, end: { bar: 6, beat: 2, tick: 960 } };
	const list = [...sections, { id: 'one', name: 'One', kind: 'chunk', bars: [5, 5] }, { id: 'r', name: 'R', kind: 'chunk', bars: [5, 6], range }];
	assert.equal(pedalTarget(list, null, { bar: 5, offset: 0 }), 6); // bar 5 alone (3840) < Verse 5–6
	assert.equal(pedalTarget(list, null, { bar: 5, offset: 2000 }), 7); // the range (2880 ticks) is smaller
	assert.equal(pedalTarget(list, null, { bar: 6, offset: 960 }), 1); // past the range's end
	assert.equal(contains(list[7], { bar: 5, offset: 1919 }), false);
	assert.equal(contains(list[7], { bar: 6, offset: 959 }), true);
	// Ties: list order.
	assert.equal(pedalTarget([{ bars: [1, 1] }, { bars: [1, 1] }], null, { bar: 1, offset: 0 }), 0);
});

test('speed lock: practice BPM over the file tempo', () => {
	assert.deepEqual(speedLock(73, 100), { ratio: 0.73, pct: 73, bpm: 73 });
	assert.deepEqual(speedLock(77, 90), { ratio: 77 / 90, pct: 86, bpm: 77 });
	assert.deepEqual(speedLock(30, 200), { ratio: 0.25, pct: 25, bpm: 50 }); // clamped
	assert.deepEqual(speedLock(300, 100), { ratio: 2, pct: 200, bpm: 200 });
	assert.deepEqual(speedLock(60, null), { ratio: 0.5, pct: 50, bpm: 60 }); // no tempo: alphaTab's 120
});

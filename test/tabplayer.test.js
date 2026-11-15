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
	barAtTick,
	barStartTick,
	selectionTicks,
	keyAction,
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

test('arrows move one bar inside the piece and keep the selection', () => {
	const p = { cursor: 5, sel: { start: 5, end: 6 }, anchor: 5 };
	assert.deepEqual(moveCursor(p, 1, 10), { cursor: 6, sel: { start: 5, end: 6 }, anchor: null });
	assert.equal(moveCursor(position(1), -1, 10).cursor, 1);
	assert.equal(moveCursor(position(10), 1, 10).cursor, 10);
});

test('[ sets the loop start at the cursor', () => {
	assert.deepEqual(setLoopStart(position(3)).sel, { start: 3, end: 3 });
	assert.deepEqual(setLoopStart({ cursor: 3, sel: { start: 5, end: 8 }, anchor: null }).sel, { start: 3, end: 8 });
	// Past the old end: a one-bar loop at the cursor.
	assert.deepEqual(setLoopStart({ cursor: 9, sel: { start: 5, end: 8 }, anchor: null }).sel, { start: 9, end: 9 });
});

test('] sets the loop end at the cursor and returns the cursor to the start', () => {
	assert.deepEqual(setLoopEnd({ cursor: 8, sel: { start: 5, end: 6 }, anchor: null }), { cursor: 5, sel: { start: 5, end: 8 }, anchor: null });
	assert.deepEqual(setLoopEnd(position(4)).sel, { start: 4, end: 4 });
	// Before the old start: a one-bar loop at the cursor.
	assert.deepEqual(setLoopEnd({ cursor: 2, sel: { start: 5, end: 6 }, anchor: null }).sel, { start: 2, end: 2 });
	// [ then → → ] = three bars.
	let p = setLoopStart(position(5));
	p = moveCursor(moveCursor(p, 1, 10), 1, 10);
	assert.deepEqual(setLoopEnd(p).sel, { start: 5, end: 7 });
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

test('keys: Space and the pedal Enter play/pause; arrows; [ ]; Escape', () => {
	assert.equal(keyAction({ key: ' ' }), 'toggle');
	assert.equal(keyAction({ key: 'Enter' }), 'toggle');
	assert.equal(keyAction({ key: 'Enter', repeat: true }), null);
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

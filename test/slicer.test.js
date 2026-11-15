import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	isDense,
	sectionsOf,
	cutRun,
	planChunks,
	mergeWithNext,
	splitChunk,
	canSplit,
	renameChunk,
	deleteChunk,
	seamsOf,
	practiceSeconds,
	chunkSeconds,
	seamSeconds,
	runSeconds,
	startTempo,
	targetTempo,
	tempoAt,
	buildSections,
	planSummary,
} from '../src/slicer.js';

// A plain 4/4 bar with 8 eighth notes.
const bar = (index, extra = {}) => ({ index, beats: 4, notes: 8, shortNotes: 0, legato: 0, marker: null, tempo: null, phraseEnd: false, ...extra });
const bars = (n, f = () => ({})) => Array.from({ length: n }, (_, i) => bar(i + 1, f(i + 1)));
const ranges = (chunks) => chunks.map((c) => [c.start, c.end]);

test('dense bars: many notes, mostly 16ths, or a legato run', () => {
	assert.equal(isDense(bar(1)), false);
	assert.equal(isDense(bar(1, { notes: 12 })), true); // 12 per 4/4 bar
	assert.equal(isDense(bar(1, { notes: 9, beats: 3 })), true); // 3/4 with 9 notes = 12 per 4/4
	assert.equal(isDense(bar(1, { notes: 9, beats: 4 })), false);
	assert.equal(isDense(bar(1, { notes: 8, shortNotes: 6 })), true); // mostly 16ths
	assert.equal(isDense(bar(1, { notes: 4, shortNotes: 4 })), false); // a 16th flourish isn't a run
	assert.equal(isDense(bar(1, { legato: 3 })), true);
	assert.equal(isDense(bar(1, { legato: 2 })), false);
});

test('sections come from markers', () => {
	const list = bars(10, (i) => ({ marker: i === 1 ? 'Intro' : i === 5 ? 'Verse' : null }));
	const secs = sectionsOf(list);
	assert.deepEqual(secs.map((s) => [s.label, s.bars.length]), [['Intro', 4], ['Verse', 6]]);
});

test('bars before the first marker get their own section', () => {
	const secs = sectionsOf(bars(6, (i) => ({ marker: i === 3 ? 'Riff' : null })));
	assert.deepEqual(secs.map((s) => [s.label, s.bars.length]), [['Start', 2], ['Riff', 4]]);
});

test('no markers → 8-bar sections', () => {
	const secs = sectionsOf(bars(20));
	assert.deepEqual(secs.map((s) => [s.label, s.bars.length]), [['Part 1', 8], ['Part 2', 8], ['Part 3', 4]]);
});

test('runs are cut into 2–4 bars, preferring phrase ends, never leaving one bar', () => {
	assert.deepEqual(cutRun(bars(8)).map((r) => r.length), [4, 4]);
	assert.deepEqual(cutRun(bars(5)).map((r) => r.length), [3, 2]); // not 4 + 1
	assert.deepEqual(cutRun(bars(3)).map((r) => r.length), [3]);
	assert.deepEqual(cutRun(bars(1)).map((r) => r.length), [1]);
	// phrase end after bar 2 → cut there
	assert.deepEqual(cutRun(bars(8, (i) => ({ phraseEnd: i === 2 || i === 5 }))).map((r) => r.length), [2, 3, 3]);
	// fixed size (plain-text tabs)
	assert.deepEqual(cutRun(bars(5), 2).map((r) => r.length), [2, 2, 1]);
});

test('plan: markers, phrase ends and a dense bar pair as its own chunk', () => {
	// Mirrors test/fixtures/etude.musicxml.
	const list = bars(10, (i) => ({
		marker: i === 1 ? 'Intro' : i === 5 ? 'Verse' : null,
		phraseEnd: [2, 4, 6, 10].includes(i),
		notes: i === 7 ? 16 : 8,
		shortNotes: i === 7 ? 16 : 0,
		legato: i === 8 ? 4 : 0,
	}));
	const chunks = planChunks(list);
	assert.deepEqual(ranges(chunks), [[1, 4], [5, 6], [7, 8], [9, 10]]);
	assert.deepEqual(chunks.map((c) => c.dense), [false, false, true, false]);
	assert.deepEqual(chunks.map((c) => c.name), ['Intro · bars 1–4', 'Verse · bars 5–6', 'Verse · bars 7–8', 'Verse · bars 9–10']);
});

test('plan without markers: 8-bar sections, chunks never cross them', () => {
	const chunks = planChunks(bars(12));
	assert.deepEqual(ranges(chunks), [[1, 4], [5, 8], [9, 12]]);
	assert.deepEqual([...new Set(chunks.map((c) => c.label))], ['Part 1', 'Part 2']);
});

test('dense runs: 1–2 bar chunks; density can be turned off or replaced', () => {
	const list = bars(6, (i) => ({ notes: i >= 2 && i <= 4 ? 16 : 8 }));
	assert.deepEqual(ranges(planChunks(list)), [[1, 1], [2, 3], [4, 4], [5, 6]]);
	assert.deepEqual(ranges(planChunks(list, { density: false })), [[1, 4], [5, 6]]);
	assert.deepEqual(ranges(planChunks(list, { size: 2, density: (b) => b.index === 3 })), [[1, 2], [3, 3], [4, 5], [6, 6]]);
});

test('merge with next', () => {
	const chunks = planChunks(bars(8, (i) => ({ phraseEnd: i % 2 === 0 })), { size: 2 });
	const merged = mergeWithNext(chunks, 1);
	assert.deepEqual(ranges(merged), [[1, 2], [3, 6], [7, 8]]);
	assert.equal(merged[1].name, 'Part 1 · bars 3–6');
	assert.equal(mergeWithNext(chunks, 3), chunks); // last one: nothing to merge
	// dense wins, a custom name is kept
	const custom = renameChunk([{ ...chunks[0] }, { ...chunks[1], dense: true }], 0, 'Opening lick');
	const m2 = mergeWithNext(custom, 0);
	assert.equal(m2[0].name, 'Opening lick');
	assert.equal(m2[0].dense, true);
});

test('split in half (only 2+ bars)', () => {
	const chunks = [{ start: 1, end: 4, label: 'Intro', dense: false, name: 'Intro · bars 1–4', auto: true }];
	assert.deepEqual(ranges(splitChunk(chunks, 0)), [[1, 2], [3, 4]]);
	assert.deepEqual(ranges(splitChunk([{ ...chunks[0], end: 3 }], 0)), [[1, 1], [2, 3]]);
	assert.deepEqual(splitChunk(chunks, 0).map((c) => c.name), ['Intro · bars 1–2', 'Intro · bars 3–4']);
	const one = [{ ...chunks[0], end: 1 }];
	assert.equal(canSplit(one[0]), false);
	assert.equal(splitChunk(one, 0), one);
	const named = renameChunk(chunks, 0, 'Riff');
	assert.deepEqual(splitChunk(named, 0).map((c) => c.name), ['Riff (1)', 'Riff (2)']);
});

test('rename (blank restores the generated name) and delete', () => {
	const chunks = planChunks(bars(4), { size: 2 });
	const r = renameChunk(chunks, 1, '  Turnaround ');
	assert.equal(r[1].name, 'Turnaround');
	assert.equal(r[1].auto, false);
	assert.equal(renameChunk(r, 1, ' ')[1].name, 'Part 1 · bars 3–4');
	assert.deepEqual(ranges(deleteChunk(chunks, 0)), [[3, 4]]);
	assert.equal(chunks.length, 2); // edits never mutate
});

test('seams join neighbouring chunks only', () => {
	const chunks = [
		{ start: 1, end: 2 },
		{ start: 3, end: 4 },
		{ start: 7, end: 8 }, // gap after a delete: no seam
		{ start: 9, end: 9 },
	];
	assert.deepEqual(seamsOf(chunks), [
		{ after: 0, start: 2, end: 3 },
		{ after: 2, start: 8, end: 9 },
	]);
});

test('durations: ~4 attempts with a bar of rest, whole seconds, multiple of 5', () => {
	// 2 bars of 4/4 at 70 BPM: (8 + 4 beats) × 60 / 70 = 10.29 s per attempt; × 4 = 41.1 → 42 → 45
	assert.equal(practiceSeconds(8, 4, 70), 45);
	assert.equal(practiceSeconds(1, 1, 300), 15); // floor of 15 s
	const list = bars(10);
	assert.equal(chunkSeconds(list, { start: 1, end: 4 }, 70), 70); // (16 + 4) × 60 / 70 × 4 = 68.6 → 69 → 70
});

test('seam duration is one bar + one beat, plus a bar of rest', () => {
	// (4 + 1 + 4) × 60 / 70 × 4 = 30.86 → 31 → 35
	assert.equal(seamSeconds(bars(2), { start: 1, end: 2 }, 70), 35);
});

test('run duration: the whole piece once plus a bar', () => {
	// (40 + 4) beats × 60 / 70 = 37.7 → 38 → 40
	assert.equal(runSeconds(bars(10), 70), 40);
});

test('tempo: first tempo is the target, later changes are kept per bar', () => {
	const list = bars(10, (i) => ({ tempo: i === 1 ? 100 : i === 9 ? 90 : null }));
	assert.equal(targetTempo(list), 100);
	assert.equal(tempoAt(list, 8), 100);
	assert.equal(tempoAt(list, 9), 90);
	assert.equal(targetTempo(bars(3)), null);
	assert.equal(startTempo(100), 70);
	assert.equal(startTempo(120), 84);
	assert.equal(startTempo(20), 20); // never under 20 BPM
});

test('build sections: chunks, seams after each joined pair, one run', () => {
	const list = bars(10, (i) => ({ marker: i === 1 ? 'Intro' : i === 5 ? 'Verse' : null, phraseEnd: [2, 4, 6, 10].includes(i), notes: i === 7 ? 16 : 8 }));
	const chunks = planChunks(list);
	let n = 0;
	const tab = { title: 'Etude', track: 0, bars: 10, format: 'score' };
	const secs = buildSections(chunks, list, { target: 100, makeId: () => `id${n++}`, tab });
	assert.deepEqual(
		secs.map((m) => [m.name, m.kind, m.bars, Boolean(m.seam), Boolean(m.dense)]),
		[
			['Intro · bars 1–4', 'chunk', [1, 4], false, false],
			['Verse · bars 5–6', 'chunk', [5, 6], false, false],
			['Seam · bars 4–5', 'chunk', [4, 5], true, false],
			['Verse · bar 7', 'chunk', [7, 7], false, true],
			['Seam · bars 6–7', 'chunk', [6, 7], true, false],
			['Verse · bars 8–10', 'chunk', [8, 10], false, false],
			['Seam · bars 7–8', 'chunk', [7, 8], true, false],
			['Full run · bars 1–10', 'run', [1, 10], false, false],
		],
	);
	for (const m of secs) {
		assert.equal(m.startBPM, 70);
		assert.equal(m.ramp, false);
		assert.deepEqual(m.song, { on: true, target: 100 });
		assert.deepEqual(m.tab, tab);
		assert.ok(m.duration >= 15 && m.duration % 5 === 0);
	}
	assert.equal(new Set(secs.map((m) => m.id)).size, secs.length);
	assert.equal(secs[0].song === secs[1].song, false); // not shared objects
	assert.throws(() => buildSections(chunks, list, { target: 0 }), /target BPM/);
	assert.throws(() => buildSections([], list, { target: 100 }), /Nothing/);
	assert.equal('id' in buildSections(chunks, list, { target: 100 })[0], false);
});

test('summary counts', () => {
	const list = bars(8);
	const chunks = planChunks(list, { size: 2 });
	assert.deepEqual(planSummary(chunks, list), { bars: 8, chunks: 4, seams: 3, dense: 0, sections: 8 });
});

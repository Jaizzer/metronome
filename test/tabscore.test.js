// Reads the hand-made fixtures with alphaTab's own parser (it runs in
// node), then checks what src/tabscore.js extracts and how it slices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as alphaTab from '@coderline/alphatab/core';
import { barsFromScore, trackList, defaultTrack, scoreTitle, playedRange, playedBars, fileStatesTempo } from '../src/tabscore.js';
import { planChunks, buildSections, targetTempo } from '../src/slicer.js';

alphaTab.Logger.logLevel = alphaTab.LogLevel.None; // the bad-file test would log an error

const load = (name) =>
	alphaTab.importer.ScoreLoader.loadScoreFromBytes(
		new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url))),
		new alphaTab.Settings(),
	);

for (const file of ['etude.musicxml', 'etude.gp']) {
	test(`${file}: bars, markers, tempo, density`, () => {
		const score = load(file);
		assert.equal(scoreTitle(score, file), 'Fixture Etude');
		assert.equal(defaultTrack(score), 0);
		assert.equal(trackList(score)[0].guitar, true);
		const bars = barsFromScore(score, 0);
		assert.equal(bars.length, 10);
		assert.deepEqual(bars.map((b) => b.marker), ['Intro', null, null, null, 'Verse', null, null, null, null, null]);
		assert.deepEqual(bars.map((b) => b.tempo), [100, null, null, null, null, null, null, null, 90, null]);
		assert.equal(targetTempo(bars), 100);
		assert.deepEqual(bars.map((b) => b.notes), [4, 2, 8, 1, 4, 5, 16, 8, 4, 1]);
		assert.equal(bars[6].shortNotes, 16);
		assert.equal(bars[7].legato, 4);
		assert.deepEqual(bars.filter((b) => b.phraseEnd).map((b) => b.index), [2, 4, 6, 10]);
		assert.ok(bars.every((b) => b.beats === 4));

		const chunks = planChunks(bars);
		assert.deepEqual(chunks.map((c) => [c.start, c.end, c.dense]), [
			[1, 4, false],
			[5, 6, false],
			[7, 8, true],
			[9, 10, false],
		]);
		const secs = buildSections(chunks, bars, { target: 100 });
		assert.deepEqual(secs.map((m) => m.name), [
			'Intro · bars 1–4',
			'Verse · bars 5–6',
			'Seam · bars 4–5',
			'Verse · bars 7–8',
			'Seam · bars 6–7',
			'Verse · bars 9–10',
			'Seam · bars 8–9',
			'Full run · bars 1–10',
		]);
	});
}

// alphaTab's own MIDI tick lookup for a score (what the player uses).
function played(score) {
	const settings = new alphaTab.Settings();
	const gen = new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(new alphaTab.midi.MidiFile()));
	gen.generate();
	return playedBars(gen.tickLookup);
}

test('played ranges: chunk, seam (ends on the first beat), missing bars', () => {
	const list = played(load('etude.musicxml'));
	assert.deepEqual(playedRange(list, 7, 8), { startTick: 6 * 3840, endTick: 8 * 3840 });
	assert.deepEqual(playedRange(list, 4, 5, { seam: true }), { startTick: 3 * 3840, endTick: 4 * 3840 + 960 });
	assert.equal(playedRange(list, 11, 12), null);
});

test('played ranges with a repeat: the first time the bars are played', () => {
	const score = load('repeat.musicxml');
	const list = played(score);
	assert.deepEqual(list.map((p) => p.index + 1), [1, 2, 3, 4, 3, 4, 5, 6, 7, 8]);
	// Written bars 5–6 start 6 played bars in (bars 3–4 come twice).
	assert.deepEqual(playedRange(list, 5, 6), { startTick: 6 * 3840, endTick: 8 * 3840 });
	assert.deepEqual(playedRange(list, 3, 4), { startTick: 2 * 3840, endTick: 4 * 3840 });
	// Seam 4→5 only happens on the second pass.
	assert.deepEqual(playedRange(list, 4, 5, { seam: true }), { startTick: 5 * 3840, endTick: 6 * 3840 + 960 });
	// 3–5 is played straight through only on the second pass.
	assert.deepEqual(playedRange(list, 3, 5), { startTick: 4 * 3840, endTick: 7 * 3840 });
	// Never straight through → first start of the first bar to the first end of the last after it.
	const jumpy = [{ index: 0, start: 0, end: 10 }, { index: 2, start: 10, end: 20 }, { index: 1, start: 20, end: 30 }];
	assert.deepEqual(playedRange(jumpy, 1, 3), { startTick: 0, endTick: 20 });
	// The written start of bar 5 would have been wrong:
	assert.equal(score.masterBars[4].start, 4 * 3840);
});

test('tempo stated in the file or not', () => {
	const scale = load('notation.musicxml');
	assert.equal(scale.tempo, 120); // alphaTab's default
	const raw = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
	assert.equal(fileStatesTempo('musicxml', raw('notation.musicxml'), scale), false);
	assert.equal(fileStatesTempo('musicxml', raw('etude.musicxml'), load('etude.musicxml')), true);
	assert.equal(fileStatesTempo('musicxml', null, scale), false); // .mxl at 120: unknown
	assert.equal(fileStatesTempo('musicxml', null, { tempo: 96 }), true);
	assert.equal(fileStatesTempo('gp', null, { tempo: 120 }), true);
	assert.equal(barsFromScore(scale, 0, { tempoKnown: false })[0].tempo, null);
	assert.equal(barsFromScore(scale, 0)[0].tempo, 120);
});

test('a notation-only staff (no tab) still gives bars', () => {
	const score = load('notation.musicxml');
	assert.equal(trackList(score)[0].strings, 0);
	assert.equal(defaultTrack(score), 0);
	assert.deepEqual(barsFromScore(score, 0).map((b) => b.notes), [4, 4]);
});

test('a missing track is an error; titles fall back to the file name', () => {
	assert.throws(() => barsFromScore(load('etude.musicxml'), 3), /track is missing/);
	assert.equal(scoreTitle({ title: '' }, 'my_song-solo.gp5'), 'my song solo');
	assert.equal(scoreTitle({}, ''), 'Imported tab');
});

test('a file alphaTab can’t read throws', () => {
	assert.throws(() =>
		alphaTab.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode('not a tab file'), new alphaTab.Settings()),
	);
});

test('two tracks: the guitar is picked, not the bass that comes first', () => {
	const score = load('duet.musicxml');
	const tracks = trackList(score);
	assert.deepEqual(tracks.map((t) => [t.name, t.strings, t.guitar]), [
		['Bass', 4, false],
		['Lead guitar', 6, true],
	]);
	assert.equal(defaultTrack(score), 1);
	const bars = barsFromScore(score, 1);
	assert.equal(bars.length, 2);
	assert.equal(bars[0].tempo, 132);
	assert.deepEqual(bars.map((b) => b.notes), [4, 4]);
});

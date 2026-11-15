// Reads the hand-made fixtures with alphaTab's own parser (it runs in
// node), then checks what src/tabscore.js extracts and how it slices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as alphaTab from '@coderline/alphatab/core';
import { barsFromScore, trackList, defaultTrack, scoreTitle, tickRange } from '../src/tabscore.js';
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

test('tick ranges for playback: chunk, seam (ends on the first beat)', () => {
	const bars = barsFromScore(load('etude.musicxml'), 0);
	assert.deepEqual(tickRange(bars, 7, 8), { startTick: 6 * 3840, endTick: 8 * 3840 });
	assert.deepEqual(tickRange(bars, 4, 5, true), { startTick: 3 * 3840, endTick: 4 * 3840 + 960 });
	assert.equal(tickRange(bars, 11, 12), null);
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

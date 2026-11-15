import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTextTab, textBarsSlice, textDense } from '../src/tabtext.js';
import { planChunks, buildSections } from '../src/slicer.js';

const riff = fs.readFileSync(new URL('./fixtures/riff.txt', import.meta.url), 'utf8');

test('plain-text tab: bars from | columns across the strings', () => {
	const p = parseTextTab(riff);
	assert.equal(p.title, 'Fixture Riff (plain-text test tab written for this repo)');
	assert.equal(p.tempo, 96);
	assert.equal(p.bars.length, 8);
	assert.equal(p.systems.length, 2);
	assert.deepEqual(p.bars.map((b) => b.marker), ['Intro', null, null, null, 'Solo', null, null, null]);
	assert.deepEqual(p.bars.map((b) => b.notes), [6, 6, 6, 3, 12, 6, 4, 1]);
	assert.equal(p.bars[5].legato, 4); // 5h7p5 twice
	assert.ok(p.bars.every((b) => b.beats === 4 && b.tempo === null));
});

test('plain-text density only when the digits are obvious', () => {
	const p = parseTextTab(riff);
	assert.deepEqual(p.bars.filter(textDense).map((b) => b.index), [5]);
	const chunks = planChunks(p.bars, { size: 2, density: textDense });
	assert.deepEqual(chunks.map((c) => [c.start, c.end, c.dense]), [
		[1, 2, false],
		[3, 4, false],
		[5, 5, true],
		[6, 7, false],
		[8, 8, false],
	]);
	// The owner's tempo is the target.
	const secs = buildSections(chunks, p.bars, { target: 96 });
	assert.equal(secs[0].startBPM, 67);
	assert.equal(secs.at(-1).kind, 'run');
	assert.deepEqual(secs.at(-1).bars, [1, 8]);
});

test('a slice of bars keeps the tuning labels and spans systems', () => {
	const p = parseTextTab(riff);
	const [a, b] = textBarsSlice(p, 4, 5);
	assert.equal(a.length, 6);
	assert.equal(a[1], 'B|-----1-----------|');
	assert.equal(b[0], 'e|-5-8-5-8-5-8-5-8-5-8-5-8-|');
	assert.deepEqual(textBarsSlice(p, 2, 2)[0][2], 'G|---0-------0-----|');
	assert.deepEqual(textBarsSlice(p, 20, 21), []);
});

test('pasted text without labels, with 4-string bass and doubled bar lines', () => {
	const bass = ['G|-----||-----5-|', 'D|-----||-3-----|', 'A|-3-5-||-------|', 'E|-----||-------|'].join('\n');
	const p = parseTextTab(bass);
	assert.equal(p.bars.length, 2);
	assert.equal(p.title, null);
	assert.equal(p.tempo, null);
	assert.deepEqual(p.bars.map((b) => b.notes), [2, 2]);
});

test('text with no tab in it is an error', () => {
	assert.throws(() => parseTextTab('Just some lyrics\nno tab here'), /No tab found/);
	assert.throws(() => parseTextTab(''), /No tab found/);
	// Two string lines aren't a guitar system.
	assert.throws(() => parseTextTab('e|---0---|---1---|\nB|---1---|---0---|'), /No tab found/);
});

test('tempo out of range is ignored; "120 bpm" is found', () => {
	assert.equal(parseTextTab(`Song\n120 bpm\n${riff.split('\n').slice(4, 10).join('\n')}`).tempo, 120);
	assert.equal(parseTextTab(`Tempo: 999\n${riff.split('\n').slice(4, 10).join('\n')}`).tempo, null);
});

test('ragged strings are lined up bar by bar', () => {
	const ragged = [
		'e|---0---|-------3--|',
		'B|-1---1--|---1---|',
		'G|0-----|-0----0---|',
		'D|------|------|',
		'A|---|---|',
		'E|-----------|-3-|',
	].join('\n');
	const p = parseTextTab(ragged);
	assert.equal(p.bars.length, 2);
	const lines = textBarsSlice(p, 1, 2)[0];
	assert.equal(new Set(lines.map((l) => l.length)).size, 1); // all the same width
	assert.equal(lines[0], 'e|---0-------|-------3--|');
	assert.equal(lines[5], 'E|-----------|-3--------|');
	// onsets per bar after aligning: bar 1 columns 0, 1, 3, 5; bar 2 columns 1 (G + E), 3, 6, 7
	assert.deepEqual(p.bars.map((b) => b.notes), [4, 4]);
});

test('strings with different numbers of bars → a clear error, not one garbled bar', () => {
	const bad = ['Title', 'e|---0---|---0---|', 'B|-1---1-|', 'G|0------|-------|', 'D|-------|-------|', 'A|-------|-------|', 'E|-------|-------|'].join('\n');
	assert.throws(() => parseTextTab(bad), /starting on line 2\) have different numbers of bars \(2, 1, 2, 2, 2, 2\)/);
});

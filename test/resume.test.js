import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, resumable, rampBpm, cardText, RESUME_MAX_AGE_MS } from '../src/resume.js';

const NOW = 1_800_000_000_000;
const routine = (over = {}) => ({
	id: 7,
	name: 'Scales',
	loop: false,
	metronomes: [
		{ name: 'A', startBPM: 80, duration: 60 },
		{ name: 'B', startBPM: 100, duration: 120 },
	],
	...over,
});
const saved = (over = {}) => ({ v: 1, view: 'player', practiceId: 7, index: 1, timeLeft: 45, bpm: null, savedAt: NOW - 1000, ...over });

test('snapshot builds the player and tab player shapes', () => {
	assert.deepEqual(snapshot({ view: 'player', practiceId: 7, index: 1, timeLeft: 45, bpm: 92 }, NOW), {
		v: 1, view: 'player', practiceId: 7, index: 1, timeLeft: 45, bpm: 92, savedAt: NOW,
	});
	assert.deepEqual(snapshot({ view: 'player', practiceId: 7, index: 0, timeLeft: 5 }, NOW).bpm, null);
	assert.deepEqual(snapshot({ view: 'tabplayer', practiceId: 7, index: 3 }, NOW), { v: 1, view: 'tabplayer', practiceId: 7, savedAt: NOW });
});

test('a fresh snapshot resumes where it stopped', () => {
	const p = routine();
	assert.deepEqual(resumable(saved({ bpm: 92 }), [p], NOW), { practice: p, view: 'player', index: 1, timeLeft: 45, bpm: 92 });
});

test('round-trips through snapshot', () => {
	const p = routine();
	const s = snapshot({ view: 'player', practiceId: 7, index: 0, timeLeft: 30 }, NOW);
	assert.deepEqual(resumable(JSON.parse(JSON.stringify(s)), [p], NOW + 5000), { practice: p, view: 'player', index: 0, timeLeft: 30, bpm: null });
});

test('missing or malformed snapshots give null', () => {
	const ps = [routine()];
	for (const s of [null, undefined, 'x', 42, [], {}]) assert.equal(resumable(s, ps, NOW), null);
	assert.equal(resumable(saved({ view: 'builder' }), ps, NOW), null);
	assert.equal(resumable(saved({ savedAt: 'yesterday' }), ps, NOW), null);
	assert.equal(resumable(saved({ index: '1' }), ps, NOW), null);
	assert.equal(resumable(saved({ index: 0.5 }), ps, NOW), null);
	assert.equal(resumable(saved({ timeLeft: null }), ps, NOW), null);
	assert.equal(resumable(saved({ timeLeft: NaN }), ps, NOW), null);
});

test('a different version gives null', () => {
	assert.equal(resumable(saved({ v: 2 }), [routine()], NOW), null);
	assert.equal(resumable(saved({ v: undefined }), [routine()], NOW), null);
});

test('older than 12 hours gives null', () => {
	const ps = [routine()];
	assert.equal(resumable(saved({ savedAt: NOW - RESUME_MAX_AGE_MS - 1 }), ps, NOW), null);
	assert.notEqual(resumable(saved({ savedAt: NOW - RESUME_MAX_AGE_MS }), ps, NOW), null);
});

test('a deleted routine gives null', () => {
	assert.equal(resumable(saved({ practiceId: 99 }), [routine()], NOW), null);
	assert.equal(resumable(saved(), [], NOW), null);
	assert.equal(resumable(saved(), undefined, NOW), null);
});

test('a section index out of range gives null', () => {
	const ps = [routine()];
	assert.equal(resumable(saved({ index: 2 }), ps, NOW), null);
	assert.equal(resumable(saved({ index: -1 }), ps, NOW), null);
	assert.equal(resumable(saved({ index: 0 }), [routine({ metronomes: [] })], NOW), null);
});

test('time left is clamped to 1..section duration', () => {
	const ps = [routine()];
	assert.equal(resumable(saved({ timeLeft: 500 }), ps, NOW).timeLeft, 120);
	assert.equal(resumable(saved({ timeLeft: 0.6 }), ps, NOW).timeLeft, 1);
	assert.equal(resumable(saved({ timeLeft: 44.4 }), ps, NOW).timeLeft, 44);
});

test('a section whose time ran out resumes at the next one with full time', () => {
	const r = resumable(saved({ index: 0, timeLeft: 0, bpm: 90 }), [routine()], NOW);
	assert.deepEqual([r.index, r.timeLeft, r.bpm], [1, 120, null]);
});

test('the last section ran out: null, or the first section when it loops', () => {
	assert.equal(resumable(saved({ index: 1, timeLeft: 0 }), [routine()], NOW), null);
	const r = resumable(saved({ index: 1, timeLeft: -3 }), [routine({ loop: true })], NOW);
	assert.deepEqual([r.index, r.timeLeft], [0, 60]);
});

test('a saved tempo is clamped to 20..300', () => {
	const ps = [routine()];
	assert.equal(resumable(saved({ bpm: 400 }), ps, NOW).bpm, 300);
	assert.equal(resumable(saved({ bpm: 5 }), ps, NOW).bpm, 20);
	assert.equal(resumable(saved({ bpm: 'fast' }), ps, NOW).bpm, null);
});

test('the tab player resumes by routine only', () => {
	const p = routine();
	assert.deepEqual(resumable({ v: 1, view: 'tabplayer', practiceId: 7, savedAt: NOW }, [p], NOW), {
		practice: p, view: 'tabplayer', index: null, timeLeft: null, bpm: null,
	});
	assert.equal(resumable({ v: 1, view: 'tabplayer', practiceId: 8, savedAt: NOW }, [p], NOW), null);
	assert.equal(resumable({ v: 1, view: 'tabplayer', practiceId: 7, savedAt: NOW - RESUME_MAX_AGE_MS - 1 }, [p], NOW), null);
});

test('rampBpm follows the position in the section', () => {
	assert.equal(rampBpm(80, 120, 100, 100), 80);
	assert.equal(rampBpm(80, 120, 100, 50), 100);
	assert.equal(rampBpm(80, 120, 100, 0), 120);
	assert.equal(rampBpm(80, 120, 100, -5), 120);
	assert.equal(rampBpm(120, 80, 60, 15), 90);
	assert.equal(rampBpm(80, 120, 0, 0), 80);
});

test('card text names the routine and the position', () => {
	const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	const r = resumable(saved({ timeLeft: 65 }), [routine()], NOW);
	assert.deepEqual(cardText(r, clock), { title: 'Continue Scales', subtitle: 'Section 2 / 2 · 1:05 left' });
	const t = resumable({ v: 1, view: 'tabplayer', practiceId: 7, savedAt: NOW }, [routine()], NOW);
	assert.deepEqual(cardText(t, clock), { title: 'Continue Scales', subtitle: 'Tab player' });
});

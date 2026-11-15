import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder, routineStats, accuracy, UNDO_LIMIT } from '../src/records.js';

const routine = () => ({ name: 'R', metronomes: [{ name: 'A' }, { name: 'B', stats: { s: 2, f: 1 } }] });

test('record bumps the all-time total and the section', () => {
	const totals = { s: 0, f: 0 };
	const p = routine();
	const r = createRecorder(totals);
	r.record('s', { practice: p, section: p.metronomes[0] });
	r.record('f', { practice: p, section: p.metronomes[1] });
	assert.deepEqual(totals, { s: 1, f: 1 });
	assert.deepEqual(p.metronomes[0].stats, { s: 1, f: 0 });
	assert.deepEqual(routineStats(p), { s: 3, f: 2 });
	assert.equal(accuracy(routineStats(p)), 60);
});

test('undo reverts both tallies, newest first', () => {
	const totals = { s: 5, f: 5 };
	const p = routine();
	const r = createRecorder(totals);
	r.record('s', { practice: p, section: p.metronomes[1] });
	r.record('f', { practice: p, section: p.metronomes[1] });
	assert.equal(r.undo().kind, 'f');
	assert.deepEqual(p.metronomes[1].stats, { s: 3, f: 1 });
	assert.equal(r.undo().kind, 's');
	assert.deepEqual(p.metronomes[1].stats, { s: 2, f: 1 });
	assert.deepEqual(totals, { s: 5, f: 5 });
	assert.equal(r.undo(), null);
});

test('undo survives reorder and tolerates a deleted section', () => {
	const totals = { s: 0, f: 0 };
	const p = routine();
	const r = createRecorder(totals);
	const a = p.metronomes[0];
	r.record('s', { practice: p, section: a });
	p.metronomes.reverse();
	r.record('s', { practice: p, section: a });
	assert.equal(r.undo().sectionGone, false);
	assert.deepEqual(a.stats, { s: 1, f: 0 });
	p.metronomes.splice(p.metronomes.indexOf(a), 1);
	const undone = r.undo();
	assert.equal(undone.sectionGone, true);
	assert.deepEqual(totals, { s: 0, f: 0 });
});

test('records without a target only touch the total', () => {
	const totals = { s: 0, f: 0 };
	const r = createRecorder(totals);
	r.record('s', null);
	assert.deepEqual(totals, { s: 1, f: 0 });
	r.undo();
	assert.deepEqual(totals, { s: 0, f: 0 });
});

test('the undo stack keeps at least 20 entries', () => {
	assert.ok(UNDO_LIMIT >= 20);
	const totals = { s: 0, f: 0 };
	const r = createRecorder(totals);
	for (let i = 0; i < UNDO_LIMIT + 5; i++) r.record('s', null);
	assert.equal(r.size, UNDO_LIMIT);
	let n = 0;
	while (r.undo()) n++;
	assert.equal(n, UNDO_LIMIT);
	assert.equal(totals.s, 5);
});

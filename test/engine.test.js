import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	stepUp,
	stepDown,
	mergeLog,
	band,
	streak,
	ownedTempo,
	nextReview,
	plateau,
	ladder,
	songState,
	shouldJoin,
	chunkStatus,
	sessionStart,
	dayKey,
	LOG_CAP,
} from '../src/engine.js';

const DAY = 86400000;
const T0 = new Date(2026, 10, 16, 3, 0).getTime(); // local 03:00
let n = 0;
const at = (day, k, bpm, minute = 0) => ({ id: `a${n++}`, t: T0 + day * DAY + minute * 60000, k, bpm });

test('steps are percentages with a 1 BPM minimum', () => {
	assert.equal(stepUp(100), 104);
	assert.equal(stepUp(20), 21);
	assert.equal(stepDown(100), 96);
	assert.equal(stepUp(299), 300);
});

test('mergeLog unions by id, drops removed ids, sorts and caps', () => {
	const a = at(0, 's', 60, 1);
	const b = at(0, 'f', 60, 2);
	const merged = mergeLog([b], [a, b], []);
	assert.deepEqual(merged.map((x) => x.id), [a.id, b.id]);
	assert.deepEqual(mergeLog(merged, [], [a.id]).map((x) => x.id), [b.id]);
	const many = Array.from({ length: LOG_CAP + 5 }, (_, i) => at(0, 's', 60, i));
	const capped = mergeLog(many);
	assert.equal(capped.length, LOG_CAP);
	assert.equal(capped[capped.length - 1].id, many[many.length - 1].id);
});

test('band needs 10 attempts and looks at the last 30', () => {
	assert.equal(band([at(0, 's', 60)]), null);
	const log = [...Array(20).fill(0).map((_, i) => at(0, 'f', 60, i)), ...Array(30).fill(0).map((_, i) => at(0, 's', 60, 30 + i))];
	assert.equal(band(log), 1);
});

test('streak stops at a tempo change', () => {
	const log = [at(0, 's', 60, 1), at(0, 's', 62, 2), at(0, 's', 62, 3)];
	assert.deepEqual(streak(log, 62), { kind: 's', n: 2 });
	assert.deepEqual(streak(log, 64), { kind: null, n: 0 });
});

test('streak and ladder stay within one day', () => {
	const log = [at(0, 's', 62, 30), at(1, 's', 62, 0)];
	assert.deepEqual(streak(log, 62), { kind: 's', n: 1 });
	assert.equal(ladder(log, 62).action, null);
	log.push(at(1, 's', 62, 1));
	assert.equal(ladder(log, 62).action, 'up');
});

test('ladder: 2 ✓ up, 2 ✗ shrink, 4 ✗ down, cap respected', () => {
	assert.deepEqual(ladder([at(0, 's', 100, 1), at(0, 's', 100, 2)], 100), { action: 'up', to: 104 });
	assert.deepEqual(ladder([at(0, 's', 100, 1), at(0, 's', 100, 2)], 100, 102), { action: 'up', to: 102 });
	assert.equal(ladder([at(0, 's', 100, 1), at(0, 's', 100, 2)], 100, 100).action, null);
	assert.equal(ladder([at(0, 'f', 100, 1), at(0, 'f', 100, 2)], 100).action, 'shrink');
	const four = [1, 2, 3, 4].map((m) => at(0, 'f', 100, m));
	assert.deepEqual(ladder(four, 100), { action: 'down', to: 96 });
	assert.equal(ladder([at(0, 'f', 100, 1)], 100).action, null);
});

test('ladder steps are bigger above a 90% band', () => {
	const log = Array.from({ length: 12 }, (_, i) => at(0, 's', 100, i));
	assert.deepEqual(ladder(log, 100), { action: 'up', to: 105 });
});

test('owned tempo = cold first attempt passed on 2 separate days', () => {
	const log = [at(0, 's', 80, 0), at(0, 's', 90, 5), at(1, 'f', 84, 0), at(1, 's', 90, 9)];
	assert.equal(ownedTempo(log), null); // only day 0's cold attempt passed
	log.push(at(2, 's', 82, 0));
	assert.equal(ownedTempo(log), 80); // 2 days: cold ✓ at 80 and 82 → owned 80
	log.push(at(3, 's', 86, 0));
	assert.equal(ownedTempo(log), 82);
});

test('reviews spread out after passed cold checks and reset after a miss', () => {
	const log = [at(0, 's', 80), at(1, 's', 80)];
	assert.equal(nextReview(log), dayKey(T0 + 4 * DAY)); // 2 passes → gap 3 days
	log.push(at(4, 'f', 80));
	assert.equal(nextReview(log), dayKey(T0 + 5 * DAY)); // miss → tomorrow
	assert.equal(nextReview([at(0, 's', 80)]), null); // nothing owned yet
});

test('plateau = no new top tempo for 3 practice days', () => {
	const log = [at(0, 's', 90), at(1, 's', 88), at(2, 's', 90), at(3, 's', 89)];
	assert.equal(plateau(log), true);
	log.push(at(4, 's', 92));
	assert.equal(plateau(log), false);
});

test('song tempo = lowest owned joined chunk; joining and caps', () => {
	const owns = (bpm) => [at(0, 's', bpm), at(1, 's', bpm)];
	const a = { name: 'A', joined: true, log: owns(80), startBPM: 80 };
	const b = { name: 'B', joined: true, log: owns(70), startBPM: 70 };
	const c = { name: 'C', joined: false, log: owns(60), startBPM: 60 };
	const run = { name: 'Run', kind: 'run', joined: true, log: owns(40) };
	const song = songState([a, b, c, run], 120);
	assert.equal(song.tempo, 70);
	assert.equal(song.bottleneck, b);
	assert.equal(song.cap, 77);
	assert.equal(song.pct, 58);
	assert.equal(shouldJoin(c, song), false);
	c.log = owns(72);
	assert.equal(shouldJoin(c, song), true);
	assert.equal(shouldJoin(run, song), false);
	assert.equal(sessionStart(a, song), 77); // owned 80, capped at song +10%
	assert.equal(sessionStart({ startBPM: 64, log: [] }, song), 64);
	const first = songState([{ joined: false, log: owns(60) }], 120);
	assert.equal(first.tempo, null);
	assert.equal(shouldJoin({ log: owns(60) }, first), true);
});

test('chunk status flags due reviews and the bottleneck', () => {
	const b = { joined: true, log: [at(0, 's', 70), at(1, 's', 70)] };
	const song = songState([b], 100);
	const st = chunkStatus(b, song, T0 + 4 * DAY);
	assert.equal(st.state, 'bottleneck');
	assert.equal(st.owned, 70);
	assert.equal(st.due, true);
	assert.equal(chunkStatus(b, song, T0 + 2 * DAY).due, false);
});

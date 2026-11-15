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
	coldAttempts,
	coldThreshold,
	nextStep,
	previousTop,
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

test('owned tempo = cold check passed on 2 separate days; slower warm-ups don’t count', () => {
	const log = [at(0, 's', 80, 0), at(0, 's', 90, 5), at(1, 'f', 84, 0), at(1, 'f', 90, 1), at(1, 's', 90, 9)];
	// day 1: 84 < stepDown(90) = 86 is a warm-up; the cold check is the ✗ at 90
	assert.deepEqual(coldAttempts(log).map((c) => [c.k, c.bpm]), [['s', 80], ['f', 90]]);
	assert.equal(ownedTempo(log), null);
	log.push(at(2, 's', 88, 0)); // ≥ stepDown(90): counts
	assert.equal(ownedTempo(log), 80);
	log.push(at(3, 's', 92, 0));
	assert.equal(ownedTempo(log), 88);
	assert.equal(coldThreshold(log, dayKey(T0 + 4 * DAY)), stepDown(92));
	assert.equal(coldAttempts([at(0, 'f', 50, 0), at(0, 's', 60, 1)])[0].bpm, 50); // first day: first attempt
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
	assert.equal(sessionStart(a, song, T0 + 2 * DAY), 77); // yesterday's top 80, capped at song +10%
	assert.equal(sessionStart({ startBPM: 64, log: [] }, song, T0), 64);
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

test('plateau counts ✗-only days as no new top', () => {
	const log = [at(0, 's', 90), at(1, 'f', 95), at(2, 'f', 95), at(3, 's', 88)];
	assert.equal(plateau(log), true);
});

test('runs are never due', () => {
	const run = { kind: 'run', log: [at(0, 's', 70), at(1, 's', 70)] };
	const st = chunkStatus(run, songState([run], 100), T0 + 10 * DAY);
	assert.equal(st.due, false);
	assert.equal(st.review, null);
});

// Drives the engine the way main.js does: start each day at sessionStart,
// play the attempts, apply nextStep after each (tempo + join).
function simulate(days, perDay, { coldFailDay = -1 } = {}) {
	const m = { name: 'A', startBPM: 70, log: [] };
	const sections = [m];
	const out = [];
	for (let d = 0; d < days; d++) {
		const now = T0 + d * DAY;
		m.startBPM = m.log.length ? sessionStart(m, songState(sections, 120), now) : m.startBPM;
		const probe = m.startBPM;
		for (let i = 0; i < perDay; i++) {
			const a = { id: `s${d}-${i}`, t: now + i * 60000, k: d === coldFailDay && i === 0 ? 'f' : 's', bpm: m.startBPM };
			m.log.push(a);
			const r = nextStep(m, sections, 120, a);
			if (r.action === 'up' || r.action === 'down' || r.action === 'cold-miss') m.startBPM = r.to;
			if (r.join) m.joined = true;
			if (i === 0) out.push({ day: d, probe, afterCold: m.startBPM, action: r.action });
		}
		Object.assign(out[out.length - 1], { owned: ownedTempo(m.log), song: songState(sections, 120).tempo, top: previousTop(m.log, dayKey(now + DAY)) });
	}
	return out;
}

test('10 clean days: owned tempo and song tempo rise every day', () => {
	const days = simulate(10, 6);
	assert.equal(days[0].owned, null);
	assert.equal(days[1].owned, 70); // 2 cold passes: day 0 at 70, day 1 at day 0's top
	for (let d = 2; d < 10; d++) {
		assert.ok(days[d].owned > days[d - 1].owned, `owned rises on day ${d}: ${days[d - 1].owned} → ${days[d].owned}`);
		assert.ok(days[d].song > days[d - 1].song, `song tempo rises on day ${d}`);
		assert.equal(days[d].probe, Math.min(days[d - 1].top, 132)); // cold check at yesterday's top ✓
	}
	assert.ok(days[9].owned < 132);
});

test('a failed cold check drops to max(owned, stepDown(probe)) and owned holds', () => {
	const clean = simulate(7, 6);
	const miss = simulate(7, 6, { coldFailDay: 6 });
	const day = miss[6];
	assert.equal(day.action, 'cold-miss');
	assert.equal(day.afterCold, Math.max(clean[5].owned, stepDown(day.probe)));
	assert.equal(day.owned, miss[5].owned); // a missed check doesn't raise it
	assert.ok(clean[6].owned > miss[6].owned);
});

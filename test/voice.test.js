import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommands, createCommandStream, createVoice } from '../src/voice.js';

test('parseCommands maps the word list, in order, ignoring everything else', () => {
	assert.deepEqual(parseCommands('good'), ['good']);
	assert.deepEqual(parseCommands('Good!'), ['good']);
	assert.deepEqual(parseCommands('miss'), ['miss']);
	assert.deepEqual(parseCommands('missed'), ['miss']);
	assert.deepEqual(parseCommands('undo'), ['undo']);
	assert.deepEqual(parseCommands('un-do'), ['undo']);
	assert.deepEqual(parseCommands('un do'), ['undo']);
	assert.deepEqual(parseCommands('next back'), ['next', 'back']);
	assert.deepEqual(parseCommands('pause'), ['pause']);
	assert.deepEqual(parseCommands('play'), ['play']);
	assert.deepEqual(parseCommands('okay that was good then miss'), ['good', 'miss']);
	for (const none of ['', '  ', 'goodness', 'mister', 'playing', 'hello there', null, undefined])
		assert.deepEqual(parseCommands(none), [], String(none));
});

test('command stream fires each word once across interim and final results', () => {
	const s = createCommandStream();
	assert.deepEqual(s.push(0, 'good'), ['good']); // interim
	assert.deepEqual(s.push(0, 'good'), []); // same interim again
	assert.deepEqual(s.push(0, 'good miss'), ['miss']); // interim grew
	assert.deepEqual(s.push(0, 'good miss'), []); // final
	assert.deepEqual(s.push(1, 'undo'), ['undo']); // next result
	s.reset(); // recognition restarted: indexes start over
	assert.deepEqual(s.push(0, 'good'), ['good']);
});

test('command stream does not refire when an interim drops a word', () => {
	const s = createCommandStream();
	assert.deepEqual(s.push(0, 'good good'), ['good', 'good']);
	assert.deepEqual(s.push(0, 'good'), []);
	assert.deepEqual(s.push(0, 'good good next'), ['next']);
});

// A fake SpeechRecognition: tests drive its events by hand.
function fakeRecognition() {
	const made = [];
	class Rec {
		constructor() {
			this.started = 0;
			this.stopped = 0;
			made.push(this);
		}
		start() {
			this.started++;
		}
		stop() {
			this.stopped++;
		}
		abort() {
			this.stopped++;
		}
		say(index, text, isFinal = false) {
			const results = [];
			results[index] = Object.assign([{ transcript: text }], { isFinal });
			this.onresult({ resultIndex: index, results });
		}
	}
	return { Rec, made };
}

function harness() {
	const { Rec, made } = fakeRecognition();
	const timers = [];
	const heard = [];
	const states = [];
	const voice = createVoice({
		Recognition: Rec,
		onCommand: (cmd, at) => heard.push([cmd, at]),
		onState: (s) => states.push(s),
		now: () => 1000,
		setTimer: (fn, ms) => timers.push({ fn, ms }),
	});
	return { voice, made, timers, heard, states, rec: () => made.at(-1) };
}

test('createVoice: unsupported without a Recognition class', () => {
	const v = createVoice({ Recognition: undefined, onCommand() {} });
	assert.equal(v.supported, false);
	assert.equal(v.start(), false);
});

test('createVoice: starts continuous + interim, emits commands with the time heard', () => {
	const h = harness();
	assert.equal(h.voice.supported, true);
	h.voice.start();
	const r = h.rec();
	assert.equal(r.continuous, true);
	assert.equal(r.interimResults, true);
	assert.equal(r.started, 1);
	r.onstart?.();
	assert.equal(h.states.at(-1), 'listening');
	r.say(0, 'good');
	r.say(0, 'good', true);
	assert.deepEqual(h.heard, [['good', 1000]]);
});

test('createVoice: auto-restarts after the browser ends it, but not after stop()', () => {
	const h = harness();
	h.voice.start();
	const r = h.rec();
	r.say(0, 'good');
	r.onend();
	assert.equal(h.timers.length, 1);
	h.timers[0].fn();
	assert.equal(r.started, 2); // same object restarted
	r.say(0, 'miss'); // indexes restart after a restart
	assert.deepEqual(h.heard.map((x) => x[0]), ['good', 'miss']);
	h.voice.stop();
	r.onend();
	assert.equal(h.timers.length, 1); // no new restart
	assert.equal(h.states.at(-1), 'off');
});

test('createVoice: mic refused -> error state, no restart loop', () => {
	const h = harness();
	h.voice.start();
	const r = h.rec();
	r.onerror({ error: 'not-allowed' });
	r.onend();
	assert.equal(h.states.at(-1), 'error');
	assert.equal(h.timers.length, 0);
	assert.equal(h.voice.on, false);
});

test('createVoice: network errors back off before restarting', () => {
	const h = harness();
	h.voice.start();
	const r = h.rec();
	r.onerror({ error: 'network' });
	r.onend();
	r.onerror({ error: 'network' });
	r.onend();
	assert.equal(h.timers.length, 2);
	assert.ok(h.timers[1].ms > h.timers[0].ms);
	assert.equal(h.states.at(-1), 'error');
	assert.equal(h.voice.on, true); // still trying
});

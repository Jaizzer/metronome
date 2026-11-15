import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPedal, DOUBLE_TAP_MS, HOLD_MS } from '../src/pedal.js';

// Fake clock + timers so gestures run instantly and deterministically.
function harness() {
	let t = 0;
	let nextId = 1;
	const timers = new Map();
	const log = [];
	let target = null;
	const pedal = createPedal({
		capture: () => target,
		onGood: (t) => log.push(t === undefined || t === null ? 'good' : `good@${t}`),
		onBad: (t) => log.push(t === undefined || t === null ? 'bad' : `bad@${t}`),
		onUndo: (info) => log.push(info.cancelledPending ? 'cancel' : 'undo'),
		onPending: (on) => log.push(on ? 'pending' : 'idle'),
		now: () => t,
		setTimer: (fn, ms) => {
			const id = nextId++;
			timers.set(id, { fn, at: t + ms });
			return id;
		},
		clearTimer: (id) => timers.delete(id),
	});
	function advance(ms) {
		const end = t + ms;
		for (;;) {
			const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			timers.delete(due[0]);
			t = due[1].at;
			due[1].fn();
		}
		t = end;
	}
	const tap = (gap = 0, press = 60) => {
		advance(gap);
		pedal.keydown({});
		advance(press);
		pedal.keyup();
	};
	const records = () => log.filter((x) => !['pending', 'idle'].includes(x));
	const setTarget = (v) => (target = v);
	return { pedal, advance, tap, log, records, setTarget };
}

test('single tap commits ✓ after the window', () => {
	const h = harness();
	h.tap();
	assert.deepEqual(h.records(), []);
	assert.ok(h.log.includes('pending'));
	h.advance(DOUBLE_TAP_MS);
	assert.deepEqual(h.records(), ['good']);
	assert.equal(h.log.at(-1), 'good');
});

test('double tap commits ✗ immediately and cancels the ✓', () => {
	const h = harness();
	h.tap();
	h.tap(150);
	assert.deepEqual(h.records(), ['bad']);
	h.advance(2000);
	assert.deepEqual(h.records(), ['bad']);
});

test('third tap inside the window adds nothing', () => {
	const h = harness();
	h.tap();
	h.tap(100);
	h.tap(100);
	h.advance(2000);
	assert.deepEqual(h.records(), ['bad']);
});

test('taps after the window start a new record', () => {
	const h = harness();
	h.tap();
	h.advance(DOUBLE_TAP_MS + 10);
	h.tap();
	h.tap(100);
	h.advance(DOUBLE_TAP_MS + 10);
	h.tap();
	h.advance(DOUBLE_TAP_MS + 10);
	assert.deepEqual(h.records(), ['good', 'bad', 'good']);
});

test('key auto-repeat is ignored', () => {
	const h = harness();
	h.pedal.keydown({});
	h.advance(30);
	h.pedal.keydown({ repeat: true });
	h.pedal.keydown({ repeat: true });
	h.advance(30);
	h.pedal.keyup();
	h.advance(DOUBLE_TAP_MS);
	assert.deepEqual(h.records(), ['good']);
});

test('hold ≥ 800 ms undoes and is not a tap', () => {
	const h = harness();
	h.pedal.keydown({});
	h.advance(HOLD_MS + 200);
	h.pedal.keyup();
	h.advance(2000);
	assert.deepEqual(h.records(), ['undo']);
});

test('hold just under 800 ms is a tap', () => {
	const h = harness();
	h.pedal.keydown({});
	h.advance(HOLD_MS - 1);
	h.pedal.keyup();
	h.advance(DOUBLE_TAP_MS);
	assert.deepEqual(h.records(), ['good']);
});

test('tap then hold inside the window drops the pending ✓', () => {
	const h = harness();
	h.tap();
	h.advance(100);
	h.pedal.keydown({});
	h.advance(HOLD_MS);
	h.pedal.keyup();
	h.advance(2000);
	assert.deepEqual(h.records(), ['cancel']);
});

test('a slow second release still counts as a double-tap', () => {
	const h = harness();
	h.tap(0, 60); // pressed at 0
	h.tap(400, 300); // pressed at 460, released at 760 (after the window)
	h.advance(2000);
	assert.deepEqual(h.records(), ['bad']);
});

test('the window is timed from the first press, not its release', () => {
	const h = harness();
	h.tap(0, 500); // pressed 0, released 500
	h.advance(150); // 650: window (0..600) is over
	assert.deepEqual(h.records(), ['good']);
});

test('third tap pressed inside the window adds nothing, even if released after it', () => {
	const h = harness();
	h.tap(0, 50);
	h.tap(100, 50);
	h.tap(100, 400); // pressed at 300, released at 700
	h.advance(2000);
	assert.deepEqual(h.records(), ['bad']);
});

test('focus loss during a second press commits the frozen ✓', () => {
	const h = harness();
	h.tap();
	h.advance(100);
	h.pedal.keydown({});
	h.pedal.cancelPress();
	h.advance(2000);
	assert.deepEqual(h.records(), ['good']);
});

test('focus loss mid-press forgets the press', () => {
	const h = harness();
	h.pedal.keydown({});
	h.pedal.cancelPress();
	h.advance(2000);
	assert.deepEqual(h.records(), []);
});

test('the record goes to the target captured at the first press', () => {
	const h = harness();
	h.setTarget('A');
	h.tap();
	h.setTarget('B'); // section auto-advanced during the window
	h.advance(DOUBLE_TAP_MS);
	assert.deepEqual(h.records(), ['good@A']);
});

test('a double-tap goes to the first press target too', () => {
	const h = harness();
	h.setTarget('A');
	h.tap();
	h.setTarget('B');
	h.tap(100);
	assert.deepEqual(h.records(), ['bad@A']);
});

test('cancelPending drops a pending ✓', () => {
	const h = harness();
	h.tap();
	assert.equal(h.pedal.cancelPending(), true);
	h.advance(2000);
	assert.deepEqual(h.records(), []);
	assert.equal(h.pedal.cancelPending(), false);
});

test('cancelPending during a second press: release adds nothing', () => {
	const h = harness();
	h.tap();
	h.advance(100);
	h.pedal.keydown({});
	assert.equal(h.pedal.cancelPending(), true);
	h.advance(50);
	h.pedal.keyup();
	h.advance(2000);
	assert.deepEqual(h.records(), []);
});

test('after cancelPending the next tap is a fresh ✓', () => {
	const h = harness();
	h.tap();
	h.pedal.cancelPending();
	h.tap(100);
	h.advance(DOUBLE_TAP_MS);
	assert.deepEqual(h.records(), ['good']);
});

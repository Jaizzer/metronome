// ============================================================
// pedal.js — foot pedal gesture recognition (the pedal sends Enter).
//
//   tap         → ✓ good run   (committed when the double-tap window expires)
//   double-tap  → ✗ bad run    (committed on the second tap, cancels the ✓)
//   hold ≥ 800ms → undo        (fires while still held; never counts as a tap)
//
// A tap is measured on key release so a hold can never also be a tap. The
// double-tap window starts at the first tap; once a ✗ is committed, any
// further taps inside that same window are ignored (so a nervous triple-tap
// records one ✗, not two). Key auto-repeat is ignored.
//
// No DOM in here: main.js feeds it keydown/keyup, tests feed it fake clocks.
// ============================================================

export const DOUBLE_TAP_MS = 600;
export const HOLD_MS = 800;

export function createPedal({
	onGood,
	onBad,
	onUndo,
	onPending = () => {},
	now = () => performance.now(),
	setTimer = (fn, ms) => setTimeout(fn, ms),
	clearTimer = (id) => clearTimeout(id),
}) {
	let downAt = null; // time the pedal went down, null while up
	let holdTimer = null;
	let heldLongEnough = false;
	let windowStart = null; // time of the first tap of the current burst
	let goodTimer = null; // pending ✓, fires when the window expires
	let burstResolved = false; // ✗ already committed for this window
	let secondPress = false; // foot is down for a possible second tap

	function setPending(on) {
		onPending(on);
	}

	function clearPendingGood() {
		if (goodTimer !== null) clearTimer(goodTimer);
		goodTimer = null;
	}

	function keydown(e = {}) {
		if (e.repeat || downAt !== null) return; // auto-repeat or already down
		downAt = now();
		heldLongEnough = false;
		// Pressing again inside the window is (probably) the second tap of a
		// double-tap: freeze the pending ✓ so it can't commit while the foot
		// is still down. Release decides ✗; a hold drops the ✓ instead.
		secondPress = goodTimer !== null && downAt - windowStart < DOUBLE_TAP_MS;
		if (secondPress) clearPendingGood();
		holdTimer = setTimer(() => {
			holdTimer = null;
			heldLongEnough = true;
			if (secondPress) {
				// Tap, then hold: the pending ✓ is the "last record"; drop it.
				secondPress = false;
				windowStart = null;
				setPending(false);
				onUndo({ cancelledPending: true });
			} else {
				onUndo({ cancelledPending: false });
			}
		}, HOLD_MS);
	}

	function keyup() {
		if (downAt === null) return;
		const pressedAt = downAt;
		downAt = null;
		if (holdTimer !== null) clearTimer(holdTimer);
		holdTimer = null;
		if (heldLongEnough) return; // it was a hold, not a tap
		tap(pressedAt);
	}

	// pressedAt: when this tap's press began — the window is judged on
	// press time so a slow release doesn't turn a double-tap into two ✓.
	function tap(pressedAt) {
		if (secondPress) {
			// Second tap inside the window → ✗ (the pending ✓ is already cancelled).
			secondPress = false;
			burstResolved = true;
			setPending(false);
			onBad();
			return;
		}

		const inWindow = windowStart !== null && pressedAt - windowStart < DOUBLE_TAP_MS;
		if (inWindow && burstResolved) return; // third+ tap: ignore

		// First tap of a new burst → pending ✓, committed when the window ends.
		windowStart = pressedAt;
		burstResolved = false;
		setPending(true);
		goodTimer = setTimer(
			() => {
				goodTimer = null;
				setPending(false);
				onGood();
			},
			Math.max(0, DOUBLE_TAP_MS - (now() - pressedAt)),
		);
	}

	// The window lost focus mid-press: we'll never see the keyup, so forget
	// the press without counting it. A pending ✓ still commits on time.
	function cancelPress() {
		if (holdTimer !== null) clearTimer(holdTimer);
		holdTimer = null;
		downAt = null;
		heldLongEnough = false;
		// A frozen ✓ would otherwise be lost: commit it.
		if (secondPress) {
			secondPress = false;
			setPending(false);
			onGood();
		}
	}

	return { keydown, keyup, cancelPress };
}

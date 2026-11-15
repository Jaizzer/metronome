// ============================================================
// records.js — ✓/✗ bookkeeping and undo.
//
// Every record bumps two tallies:
//   1. the all-time total (mastery_counts row: { s, f } here)
//   2. the section it was recorded against, stored inside that section's
//      object in the practice's `metronomes` jsonb as `stats: { s, f }`
//      (no schema change needed — it's just another key in the JSON).
// Routine totals are derived by summing its sections.
//
// Sections have no ids, so the undo stack holds a direct reference to the
// section object. Reordering keeps the reference valid; if the section was
// deleted in the meantime, undo still reverts the all-time total.
// ============================================================

export const UNDO_LIMIT = 50;

export function sectionStats(section) {
	const st = section?.stats;
	return { s: Math.max(0, st?.s | 0), f: Math.max(0, st?.f | 0) };
}

export function routineStats(practice) {
	return (practice?.metronomes ?? []).reduce(
		(acc, m) => {
			const st = sectionStats(m);
			acc.s += st.s;
			acc.f += st.f;
			return acc;
		},
		{ s: 0, f: 0 },
	);
}

// Whole-number accuracy, or null when there's nothing to measure yet.
export function accuracy({ s, f }) {
	const total = s + f;
	return total === 0 ? null : Math.round((s / total) * 100);
}

export function formatAccuracy(stats) {
	const acc = accuracy(stats);
	return acc === null ? '–' : acc + '%';
}

function bump(section, kind, delta) {
	const st = sectionStats(section);
	st[kind] = Math.max(0, st[kind] + delta);
	section.stats = st;
}

// totals: the all-time { s, f } object (mutated in place).
export function createRecorder(totals, limit = UNDO_LIMIT) {
	const stack = [];

	// kind: 's' (✓) or 'f' (✗). target: { practice, section } or null.
	function record(kind, target) {
		totals[kind]++;
		if (target?.section) bump(target.section, kind, 1);
		const entry = {
			kind,
			practice: target?.practice ?? null,
			section: target?.section ?? null,
			sectionName: target?.section?.name ?? null,
			at: Date.now(),
		};
		stack.push(entry);
		if (stack.length > limit) stack.shift();
		return entry;
	}

	// Returns the undone entry (with `sectionGone` when the section no
	// longer exists), or null when there's nothing to undo.
	function undo() {
		const entry = stack.pop();
		if (!entry) return null;
		totals[entry.kind] = Math.max(0, totals[entry.kind] - 1);
		const stillThere = entry.section && entry.practice?.metronomes?.includes(entry.section);
		if (stillThere) bump(entry.section, entry.kind, -1);
		return { ...entry, sectionGone: Boolean(entry.section && !stillThere) };
	}

	function clear() {
		stack.length = 0;
	}

	return {
		record,
		undo,
		clear,
		get size() {
			return stack.length;
		},
		peek: () => stack[stack.length - 1] ?? null,
	};
}

// restore.js — which routine to show after a reload.

// The index of the first saved id that still exists (saved ids go stale
// when a routine is deleted on another device), else 0.
export function restoreIndex(practices, ...savedIds) {
	for (const id of savedIds) {
		if (id === null || id === undefined) continue;
		const i = practices.findIndex((p) => p.id === id);
		if (i >= 0) return i;
	}
	return 0;
}

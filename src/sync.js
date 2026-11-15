// ============================================================
// sync.js — conflict-safe saving of ✓/✗ counts and routine edits.
//
// Two tabs (or a phone and a laptop) can record at the same time, so we
// never write a stale absolute count. Instead every record/undo is kept
// as an unsaved *delta* (+1 / -1 per section and for the all-time total).
// A flush re-reads the row, adds the deltas to the server's numbers, and
// writes back with compare-and-swap on `updated_at` (the DB trigger bumps
// it on every write). If someone else wrote in between, the CAS matches
// no row and we re-read and retry.
//
// Structure edits (names, tempos, order, sections added/removed) are
// last-writer-wins: while a routine has local structure edits, its local
// section list is written, but each section's stats still come from the
// server plus our deltas.
//
// Sections are matched by an `id` stored inside each section object in the
// `metronomes` jsonb (no schema change). Older sections without one get a
// positional id (`idx-<n>`) so every tab derives the same ids for them.
//
// No DOM and no Neon here: main.js injects the API, tests inject a fake.
// ============================================================

export const MAX_CAS_RETRIES = 6;

const clampStats = (s, f) => ({ s: Math.max(0, s), f: Math.max(0, f) });

export function addStats(base, delta) {
	return clampStats((base?.s | 0) + (delta?.s | 0), (base?.f | 0) + (delta?.f | 0));
}

// Gives every section an id (positional for legacy sections, so every tab
// derives the same ones). Returns true if any were added.
export function ensureSectionIds(sections) {
	let changed = false;
	sections.forEach((m, i) => {
		if (!m.id) {
			m.id = `idx-${i}`;
			changed = true;
		}
	});
	return changed;
}

export const newSectionId = () => crypto.randomUUID();

// What to write for one routine, given the fresh server row.
export function mergeForWrite({ server, local, deltas, structDirty }) {
	const serverById = new Map((server.metronomes ?? []).map((m) => [m.id, m]));
	if (structDirty) {
		return {
			name: local.name,
			loop: local.loop,
			metronomes: local.metronomes.map((m) => ({
				...m,
				stats: addStats(serverById.get(m.id)?.stats, deltas.get(m.id)),
			})),
		};
	}
	return {
		name: server.name,
		loop: server.loop,
		metronomes: (server.metronomes ?? []).map((m) => ({ ...m, stats: addStats(m.stats, deltas.get(m.id)) })),
	};
}

// Bring local section objects in line with what the server holds, keeping
// object identity (the undo stack points at these objects). Displayed
// stats = server stats + deltas not yet saved.
export function reconcileSections(localSections, serverSections, pending, keepLocalStructure) {
	const serverById = new Map(serverSections.map((m) => [m.id, m]));
	if (keepLocalStructure) {
		for (const m of localSections) m.stats = addStats(serverById.get(m.id)?.stats, pending.get(m.id));
		return localSections;
	}
	const localById = new Map(localSections.map((m) => [m.id, m]));
	return serverSections.map((sm) => {
		const m = localById.get(sm.id) ?? {};
		for (const k of Object.keys(m)) if (!(k in sm)) delete m[k];
		Object.assign(m, sm);
		m.stats = addStats(sm.stats, pending.get(sm.id));
		return m;
	});
}

/*
 * api = {
 *   fetchPractice(id) → { id, name, loop, metronomes, updated_at } | null
 *   casUpdatePractice(id, updatedAt, patch) → row | null (null = lost the race)
 *   fetchTotals() → { success, fail, updated_at } | null
 *   casUpdateTotals(updatedAt, success, fail) → row | null
 *   insertTotals(success, fail) → row | null (null = row appeared meanwhile)
 * }
 */
export function createSync(api) {
	const sectionDeltas = new Map(); // practiceId → Map(sectionId → { s, f })
	const structVersion = new Map(); // practiceId → edit counter (absent = clean)
	const totalsDelta = { s: 0, f: 0 };

	function deltasFor(pid) {
		if (!sectionDeltas.has(pid)) sectionDeltas.set(pid, new Map());
		return sectionDeltas.get(pid);
	}

	function addSectionDelta(pid, sid, kind, n) {
		const m = deltasFor(pid);
		const d = m.get(sid) ?? { s: 0, f: 0 };
		d[kind] += n;
		m.set(sid, d);
	}

	function addTotalsDelta(kind, n) {
		totalsDelta[kind] += n;
	}

	function markStructure(pid) {
		structVersion.set(pid, (structVersion.get(pid) ?? 0) + 1);
	}

	function isStructDirty(pid) {
		return structVersion.has(pid);
	}

	function pendingFor(pid) {
		return sectionDeltas.get(pid) ?? new Map();
	}

	function hasPending(pid) {
		return isStructDirty(pid) || [...pendingFor(pid).values()].some((d) => d.s || d.f);
	}

	function totalsPending() {
		return { ...totalsDelta };
	}

	function forget(pid) {
		sectionDeltas.delete(pid);
		structVersion.delete(pid);
	}

	function subtract(pid, snapshot) {
		const m = pendingFor(pid);
		for (const [sid, d] of snapshot) {
			const cur = m.get(sid);
			if (!cur) continue;
			cur.s -= d.s;
			cur.f -= d.f;
			if (!cur.s && !cur.f) m.delete(sid);
		}
	}

	// Returns the row as written, or null if the routine was deleted elsewhere.
	async function flushPractice(local) {
		const pid = local.id;
		for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
			const server = await api.fetchPractice(pid);
			if (!server) {
				forget(pid);
				return null;
			}
			ensureSectionIds(server.metronomes ?? []);
			// Snapshot after the await so it matches `local` exactly.
			const snapshot = new Map([...pendingFor(pid)].map(([k, d]) => [k, { ...d }]));
			const version = structVersion.get(pid);
			const patch = mergeForWrite({ server, local, deltas: snapshot, structDirty: version !== undefined });
			const written = await api.casUpdatePractice(pid, server.updated_at, patch);
			if (!written) continue; // someone else wrote first: re-read and retry
			subtract(pid, snapshot);
			if (version !== undefined && structVersion.get(pid) === version) structVersion.delete(pid);
			return written;
		}
		throw new Error('Too many simultaneous edits; will retry.');
	}

	// Returns the all-time { s, f } as written.
	async function flushTotals() {
		for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
			const server = await api.fetchTotals();
			const snap = { ...totalsDelta };
			const next = addStats({ s: server?.success ?? 0, f: server?.fail ?? 0 }, snap);
			const written = server
				? await api.casUpdateTotals(server.updated_at, next.s, next.f)
				: await api.insertTotals(next.s, next.f);
			if (!written) continue;
			totalsDelta.s -= snap.s;
			totalsDelta.f -= snap.f;
			return next;
		}
		throw new Error('Too many simultaneous edits; will retry.');
	}

	return {
		addSectionDelta,
		addTotalsDelta,
		markStructure,
		isStructDirty,
		pendingFor,
		hasPending,
		totalsPending,
		forget,
		flushPractice,
		flushTotals,
	};
}

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
// Song mode attempts: each ✓/✗ in a song routine is also an attempt
// { id, t, k, bpm } in its section's `log`. Pending attempt changes ride
// in the same per-section delta as `add` (attempts) and `del` (attempt
// ids). They merge by id (engine.mergeLog), so re-sending is harmless and
// a local structure edit never overwrites another device's attempts: the
// written log is always the server's log plus our pending add/del.
//
// Sections are matched by an `id` stored inside each section object in the
// `metronomes` jsonb (no schema change). Older sections without one get a
// positional id (`idx-<n>`) so every tab derives the same ids for them.
//
// No DOM and no Neon here: main.js injects the API, tests inject a fake.
// ============================================================

import { mergeLog } from './engine.js';

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

// Server log + pending attempt changes, or undefined when the section has
// neither (non-song sections never get a `log` key).
export function mergedLog(serverLog, delta) {
	if (!serverLog && !delta?.add?.length && !delta?.del?.length) return undefined;
	return mergeLog(serverLog ?? [], delta?.add ?? [], delta?.del ?? []);
}

// Section as written/shown: its own fields, with stats and log taken from
// the server value plus pending changes.
function withCounts(m, serverSection, delta) {
	const out = { ...m, stats: addStats(serverSection?.stats, delta) };
	const log = mergedLog(serverSection?.log, delta);
	if (log) out.log = log;
	else delete out.log;
	return out;
}

// What to write for one routine, given the fresh server row.
export function mergeForWrite({ server, local, deltas, structDirty }) {
	const serverById = new Map((server.metronomes ?? []).map((m) => [m.id, m]));
	if (structDirty) {
		return {
			name: local.name,
			loop: local.loop,
			metronomes: local.metronomes.map((m) => withCounts(m, serverById.get(m.id), deltas.get(m.id))),
		};
	}
	return {
		name: server.name,
		loop: server.loop,
		metronomes: (server.metronomes ?? []).map((m) => withCounts(m, m, deltas.get(m.id))),
	};
}

function setLog(m, log) {
	if (log) m.log = log;
	else delete m.log;
}

// Bring local section objects in line with what the server holds, keeping
// object identity (the undo stack points at these objects). Displayed
// stats = server stats + deltas not yet saved.
export function reconcileSections(localSections, serverSections, pending, keepLocalStructure) {
	const serverById = new Map(serverSections.map((m) => [m.id, m]));
	if (keepLocalStructure) {
		for (const m of localSections) {
			const sm = serverById.get(m.id);
			m.stats = addStats(sm?.stats, pending.get(m.id));
			setLog(m, mergedLog(sm?.log, pending.get(m.id)));
		}
		return localSections;
	}
	const localById = new Map(localSections.map((m) => [m.id, m]));
	return serverSections.map((sm) => {
		const m = localById.get(sm.id) ?? {};
		for (const k of Object.keys(m)) if (!(k in sm)) delete m[k];
		Object.assign(m, sm);
		m.stats = addStats(sm.stats, pending.get(sm.id));
		setLog(m, mergedLog(sm.log, pending.get(sm.id)));
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
 * onChange(state): called after every change to the unsaved counts, with
 * exportState(), so main.js can mirror them to localStorage. Structure
 * edits are not part of it (they're re-sent from the open tab only).
 *
 * Lost responses: before each write, the expected result is recorded as
 * `inflight` (and mirrored). If the request errors out we can't tell
 * whether it landed, so we re-read: unchanged `updated_at` → it didn't;
 * values equal to what we expected → it did (don't apply twice); anything
 * else → assume it didn't and apply again later.
 */
// Deep copy of a pending delta (its arrays keep changing after a snapshot).
function cloneDelta(d) {
	const out = { s: d.s, f: d.f };
	if (d.add?.length) out.add = d.add.map((a) => ({ ...a }));
	if (d.del?.length) out.del = [...d.del];
	return out;
}

export function createSync(api, onChange = () => {}) {
	let sectionDeltas = new Map(); // practiceId → Map(sectionId → { s, f, add?, del? })
	const structVersion = new Map(); // practiceId → edit counter (absent = clean)
	const totalsDelta = { s: 0, f: 0 };
	let inflight = []; // writes sent whose outcome we haven't confirmed

	const changed = () => onChange(exportState());

	function deltasFor(pid) {
		if (!sectionDeltas.has(pid)) sectionDeltas.set(pid, new Map());
		return sectionDeltas.get(pid);
	}

	function addSectionDelta(pid, sid, kind, n) {
		const m = deltasFor(pid);
		const d = m.get(sid) ?? { s: 0, f: 0 };
		d[kind] += n;
		m.set(sid, d);
		changed();
	}

	// Song mode: a new attempt, or the removal of one (undo).
	function addAttempt(pid, sid, attempt) {
		const m = deltasFor(pid);
		const d = m.get(sid) ?? { s: 0, f: 0 };
		d.add = [...(d.add ?? []).filter((a) => a.id !== attempt.id), attempt];
		if (d.del) d.del = d.del.filter((id) => id !== attempt.id);
		m.set(sid, d);
		changed();
	}

	// Always sent as a del too: the attempt may already be on the server
	// (or in a write whose answer we haven't seen yet).
	function removeAttempt(pid, sid, attemptId) {
		const m = deltasFor(pid);
		const d = m.get(sid) ?? { s: 0, f: 0 };
		if (d.add) d.add = d.add.filter((a) => a.id !== attemptId);
		d.del = [...new Set([...(d.del ?? []), attemptId])];
		m.set(sid, d);
		changed();
	}

	function addTotalsDelta(kind, n) {
		totalsDelta[kind] += n;
		changed();
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

	const nonZero = (d) => Boolean(d && (d.s || d.f || d.add?.length || d.del?.length));

	function hasPending(pid) {
		return (
			isStructDirty(pid) ||
			[...pendingFor(pid).values()].some(nonZero) ||
			inflight.some((w) => w.type === 'practice' && w.id === pid)
		);
	}

	function pendingPracticeIds() {
		const ids = new Set([...structVersion.keys()]);
		for (const [pid, m] of sectionDeltas) if ([...m.values()].some(nonZero)) ids.add(pid);
		for (const w of inflight) if (w.type === 'practice') ids.add(w.id);
		return [...ids];
	}

	function hasTotalsPending() {
		return Boolean(nonZero(totalsDelta) || inflight.some((w) => w.type === 'totals'));
	}

	function totalsPending() {
		return { ...totalsDelta };
	}

	function forget(pid) {
		sectionDeltas.delete(pid);
		structVersion.delete(pid);
		inflight = inflight.filter((w) => !(w.type === 'practice' && w.id === pid));
		changed();
	}

	// ---- persistence (localStorage mirror) ----

	function exportState() {
		const sections = {};
		for (const [pid, m] of sectionDeltas) {
			for (const [sid, d] of m) if (nonZero(d)) (sections[pid] ??= {})[sid] = cloneDelta(d);
		}
		return { sections, totals: { ...totalsDelta }, inflight: JSON.parse(JSON.stringify(inflight)) };
	}

	function isEmptyState(st) {
		return !st || (!Object.keys(st.sections ?? {}).length && !nonZero(st.totals) && !(st.inflight ?? []).length);
	}

	// Adds another tab's (or a previous session's) unsaved counts to ours.
	function importState(st) {
		if (!st) return;
		for (const [pid, secs] of Object.entries(st.sections ?? {})) {
			for (const [sid, d] of Object.entries(secs)) {
				const m = deltasFor(pid);
				const cur = m.get(sid) ?? { s: 0, f: 0 };
				const next = { s: cur.s + (d.s | 0), f: cur.f + (d.f | 0) };
				// Attempts are unions by id, never counted twice.
				const add = new Map([...(cur.add ?? []), ...(d.add ?? [])].map((a) => [a.id, a]));
				const del = new Set([...(cur.del ?? []), ...(d.del ?? [])]);
				for (const id of del) add.delete(id);
				if (add.size) next.add = [...add.values()];
				if (del.size) next.del = [...del];
				m.set(sid, next);
			}
		}
		totalsDelta.s += st.totals?.s | 0;
		totalsDelta.f += st.totals?.f | 0;
		inflight.push(...(st.inflight ?? []));
		changed();
	}

	// Forget every unsaved count in memory (another tab took them over).
	function dropCounts() {
		sectionDeltas = new Map();
		totalsDelta.s = 0;
		totalsDelta.f = 0;
		inflight = [];
		changed();
	}

	function subtract(pid, snapshot) {
		const m = pendingFor(pid);
		for (const [sid, d] of Object.entries(snapshot)) {
			const cur = m.get(sid);
			if (!cur) continue;
			cur.s -= d.s;
			cur.f -= d.f;
			const sentAdd = new Set((d.add ?? []).map((a) => a.id));
			const sentDel = new Set(d.del ?? []);
			if (cur.add) cur.add = cur.add.filter((a) => !sentAdd.has(a.id));
			if (cur.del) cur.del = cur.del.filter((id) => !sentDel.has(id));
			if (!cur.add?.length) delete cur.add;
			if (!cur.del?.length) delete cur.del;
			if (!nonZero(cur)) m.delete(sid);
		}
	}

	function settle(w, applied) {
		inflight = inflight.filter((x) => x !== w);
		if (applied) {
			if (w.type === 'practice') subtract(w.id, w.snapshot);
			else {
				totalsDelta.s -= w.snapshot.s;
				totalsDelta.f -= w.snapshot.f;
			}
		}
		changed();
	}

	// Did an unconfirmed write land? Re-read and compare (see header).
	async function resolveInflight(w) {
		if (w.type === 'practice') {
			const row = await api.fetchPractice(w.id);
			if (!row) return settle(w, false);
			if (row.updated_at === w.prev) return settle(w, false);
			const byId = new Map((row.metronomes ?? []).map((m) => [m.id, m]));
			// Our own attempt ids are proof: only this write can have put
			// them there. Without any, fall back to comparing the counts.
			let proof = null;
			for (const [sid, d] of Object.entries(w.snapshot)) {
				const ids = new Set((byId.get(sid)?.log ?? []).map((a) => a.id));
				for (const a of d.add ?? []) proof = proof === false ? false : ids.has(a.id);
			}
			if (proof !== null) return settle(w, proof);
			const landed = Object.entries(w.expected).every(([sid, e]) => {
				const st = byId.get(sid)?.stats;
				const gone = new Set(w.snapshot[sid]?.del ?? []);
				const logOk = !(byId.get(sid)?.log ?? []).some((a) => gone.has(a.id));
				return st && (st.s | 0) === e.s && (st.f | 0) === e.f && logOk;
			});
			return settle(w, landed);
		}
		const row = await api.fetchTotals();
		if (!row || row.updated_at === w.prev) return settle(w, false);
		settle(w, row.success === w.expected.s && row.fail === w.expected.f);
	}

	async function resolveAll(match) {
		for (const w of inflight.filter(match)) await resolveInflight(w);
	}

	// Send one write, recording it as in flight until its outcome is known.
	async function guardedWrite(w, send) {
		inflight.push(w);
		changed();
		let result;
		try {
			result = await send();
		} catch (e) {
			// No answer: maybe it landed. Find out before anything is re-sent.
			await resolveInflight(w).catch(() => {}); // still unknown → stays in flight
			throw e;
		}
		settle(w, Boolean(result)); // null = lost the CAS race: definitely not applied
		return result;
	}

	// Returns the row as written, or null if the routine was deleted elsewhere.
	async function flushPractice(local) {
		const pid = local.id;
		await resolveAll((w) => w.type === 'practice' && w.id === pid);
		for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
			const server = await api.fetchPractice(pid);
			if (!server) {
				forget(pid);
				return null;
			}
			ensureSectionIds(server.metronomes ?? []);
			// Snapshot after the await so it matches `local` exactly.
			const snapshot = {};
			for (const [sid, d] of pendingFor(pid)) if (nonZero(d)) snapshot[sid] = cloneDelta(d);
			const version = structVersion.get(pid);
			const patch = mergeForWrite({ server, local, deltas: new Map(Object.entries(snapshot)), structDirty: version !== undefined });
			const expected = {};
			for (const m of patch.metronomes) if (snapshot[m.id]) expected[m.id] = { ...m.stats };
			const w = { type: 'practice', id: pid, prev: server.updated_at, snapshot, expected };
			const written = await guardedWrite(w, () => api.casUpdatePractice(pid, server.updated_at, patch));
			if (!written) continue; // someone else wrote first: re-read and retry
			if (version !== undefined && structVersion.get(pid) === version) structVersion.delete(pid);
			return written;
		}
		throw new Error('Too many simultaneous edits; will retry.');
	}

	// Returns the all-time { s, f } as written.
	async function flushTotals() {
		await resolveAll((w) => w.type === 'totals');
		for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
			const server = await api.fetchTotals();
			const snapshot = { ...totalsDelta };
			const next = addStats({ s: server?.success ?? 0, f: server?.fail ?? 0 }, snapshot);
			const w = { type: 'totals', prev: server?.updated_at ?? null, snapshot, expected: next };
			const written = await guardedWrite(w, () =>
				server ? api.casUpdateTotals(server.updated_at, next.s, next.f) : api.insertTotals(next.s, next.f),
			);
			if (written) return next;
		}
		throw new Error('Too many simultaneous edits; will retry.');
	}

	return {
		addSectionDelta,
		addTotalsDelta,
		addAttempt,
		removeAttempt,
		markStructure,
		isStructDirty,
		pendingFor,
		hasPending,
		pendingPracticeIds,
		hasTotalsPending,
		totalsPending,
		forget,
		exportState,
		importState,
		isEmptyState,
		dropCounts,
		flushPractice,
		flushTotals,
	};
}

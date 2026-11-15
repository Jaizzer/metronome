// ============================================================
// tabstore.js — the imported tab file stays on this device (IndexedDB),
// keyed by routine id; sections only keep bar ranges (docs/TAB-IMPORT.md).
// The pure helpers at the top are unit-tested; the IndexedDB calls take
// an optional factory so tests can pass a fake.
// ============================================================

const DB_NAME = 'metronome-tabs';
const STORE = 'tabs';

export const routineKey = (id) => String(id);

// What gets stored for a routine. data: ArrayBuffer (score files) or
// string (plain-text tabs).
export function tabRecord({ routineId, fileName, format, data, track = 0, title = '', bars = 0 }) {
	if (routineId === undefined || routineId === null) throw new Error('No routine to attach the tab to');
	if (format !== 'score' && format !== 'text') throw new Error(`Unknown tab format: ${format}`);
	return { key: routineKey(routineId), fileName: fileName || '', format, data, track, title, bars, savedAt: Date.now() };
}

// The routine's tab reference (mirrored on its sections as `tab`).
export function routineTab(p) {
	return p?.metronomes?.find((m) => m.tab)?.tab ?? null;
}

// The highest bar any section of the routine uses.
export function barsNeeded(p) {
	return Math.max(0, ...(p?.metronomes ?? []).map((m) => (Array.isArray(m.bars) ? m.bars[1] : 0) || 0));
}

// Re-attaching a file on another device: it has to be the same kind of
// file and long enough for the routine's bar ranges. A different title is
// allowed (files get renamed) but reported so the UI can say so.
export function checkReattach(p, file) {
	const ref = routineTab(p);
	const needed = barsNeeded(p);
	if (!needed) return { ok: false, reason: 'This routine has no bar ranges to show' };
	if (ref?.format && file.format !== ref.format) {
		return { ok: false, reason: ref.format === 'text' ? 'This routine was made from a text tab' : 'This routine was made from a Guitar Pro or MusicXML file' };
	}
	if (file.bars < needed) return { ok: false, reason: `This file has ${file.bars} bars; the routine needs ${needed}` };
	const sameTitle = !ref?.title || !file.title || ref.title.trim().toLowerCase() === file.title.trim().toLowerCase();
	return { ok: true, sameTitle };
}

// ---- IndexedDB ----

let dbPromise = null;

function openDb(idb = globalThis.indexedDB) {
	if (!idb) return Promise.reject(new Error('This browser can’t store files (no IndexedDB)'));
	if (dbPromise && idb === globalThis.indexedDB) return dbPromise;
	const p = new Promise((resolve, reject) => {
		const req = idb.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('Couldn’t open the tab store'));
		req.onblocked = () => reject(new Error('The tab store is busy in another tab'));
	});
	if (idb === globalThis.indexedDB) dbPromise = p.catch((e) => ((dbPromise = null), Promise.reject(e)));
	return p;
}

function run(mode, fn, idb) {
	return openDb(idb).then(
		(db) =>
			new Promise((resolve, reject) => {
				const tx = db.transaction(STORE, mode);
				const req = fn(tx.objectStore(STORE));
				tx.oncomplete = () => resolve(req?.result);
				tx.onerror = () => reject(tx.error ?? new Error('Tab store error'));
				tx.onabort = () => reject(tx.error ?? new Error('Tab store write was cancelled (storage full?)'));
			}),
	);
}

export const saveTab = (record, idb) => run('readwrite', (s) => s.put(record), idb).then(() => record);
export const loadTab = (routineId, idb) => run('readonly', (s) => s.get(routineKey(routineId)), idb).then((r) => r ?? null);
export const deleteTab = (routineId, idb) => run('readwrite', (s) => s.delete(routineKey(routineId)), idb);

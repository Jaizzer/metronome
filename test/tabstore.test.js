import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabRecord, routineTab, barsNeeded, checkReattach, saveTab, loadTab, deleteTab } from '../src/tabstore.js';

const routine = (format = 'score', title = 'Fixture Etude') => ({
	id: 42,
	metronomes: [
		{ id: 'a', bars: [1, 4], tab: { title, track: 0, bars: 10, format } },
		{ id: 'b', bars: [9, 10], tab: { title, track: 0, bars: 10, format } },
		{ id: 'c' },
	],
});

test('record shape and key', () => {
	const r = tabRecord({ routineId: 42, fileName: 'etude.gp', format: 'score', data: new ArrayBuffer(4), title: 'Etude', bars: 10 });
	assert.equal(r.key, '42');
	assert.equal(r.track, 0);
	assert.ok(r.savedAt > 0);
	assert.throws(() => tabRecord({ format: 'score' }), /No routine/);
	assert.throws(() => tabRecord({ routineId: 1, format: 'pdf' }), /Unknown tab format/);
});

test('routine tab reference and bars needed', () => {
	assert.equal(routineTab(routine()).title, 'Fixture Etude');
	assert.equal(barsNeeded(routine()), 10);
	assert.equal(barsNeeded({ metronomes: [{}] }), 0);
	assert.equal(routineTab({ metronomes: [] }), null);
});

test('re-attach: same format, enough bars; title mismatch is only reported', () => {
	assert.deepEqual(checkReattach(routine(), { format: 'score', bars: 10, title: 'fixture etude ' }), { ok: true, sameTitle: true });
	assert.deepEqual(checkReattach(routine(), { format: 'score', bars: 12, title: 'Other' }), { ok: true, sameTitle: false });
	assert.match(checkReattach(routine(), { format: 'score', bars: 8, title: 'x' }).reason, /has 8 bars; the routine needs 10/);
	assert.match(checkReattach(routine(), { format: 'text', bars: 10 }).reason, /Guitar Pro or MusicXML/);
	assert.match(checkReattach(routine('text'), { format: 'score', bars: 10 }).reason, /text tab/);
	assert.match(checkReattach({ metronomes: [{}] }, { format: 'score', bars: 10 }).reason, /no bar ranges/);
});

// A minimal in-memory stand-in for the IndexedDB calls tabstore makes.
function fakeIdb() {
	const data = new Map();
	const later = (fn) => setTimeout(fn, 0);
	return {
		data,
		open() {
			const req = {};
			later(() => {
				const db = {
					createObjectStore() {},
					transaction() {
						const tx = {};
						const store = {
							put(v) {
								data.set(v.key, structuredClone(v));
								return { result: v.key };
							},
							get(k) {
								return { result: structuredClone(data.get(k)) };
							},
							delete(k) {
								data.delete(k);
								return { result: undefined };
							},
						};
						tx.objectStore = () => store;
						later(() => tx.oncomplete?.());
						return tx;
					},
				};
				req.result = db;
				req.onupgradeneeded?.();
				req.onsuccess?.();
			});
			return req;
		},
	};
}

test('save, load and delete through the store', async () => {
	const idb = fakeIdb();
	const rec = tabRecord({ routineId: 7, fileName: 'riff.txt', format: 'text', data: 'e|---|', title: 'Riff', bars: 1 });
	await saveTab(rec, idb);
	const back = await loadTab(7, idb);
	assert.equal(back.data, 'e|---|');
	assert.equal(back.format, 'text');
	assert.equal(await loadTab('8', idb), null);
	await deleteTab('7', idb);
	assert.equal(await loadTab(7, idb), null);
});

test('no IndexedDB → a clear error', async () => {
	await assert.rejects(loadTab(1, null), /can’t store files/);
});

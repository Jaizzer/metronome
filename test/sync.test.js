import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync, reconcileSections, ensureSectionIds, mergeForWrite } from '../src/sync.js';

// In-memory "database" with updated_at bumped on every write, like the trigger.
function fakeServer() {
	let clock = 0;
	const rows = new Map();
	let totals = null;
	const stamp = () => `t${++clock}`;
	const clone = (x) => JSON.parse(JSON.stringify(x));
	const api = {
		async fetchPractice(id) {
			return rows.has(id) ? clone(rows.get(id)) : null;
		},
		async casUpdatePractice(id, updatedAt, patch) {
			const row = rows.get(id);
			if (!row || row.updated_at !== updatedAt) return null;
			Object.assign(row, clone(patch), { updated_at: stamp() });
			return clone(row);
		},
		async fetchTotals() {
			return totals && clone(totals);
		},
		async casUpdateTotals(updatedAt, success, fail) {
			if (!totals || totals.updated_at !== updatedAt) return null;
			totals = { success, fail, updated_at: stamp() };
			return clone(totals);
		},
		async insertTotals(success, fail) {
			if (totals) return null;
			totals = { success, fail, updated_at: stamp() };
			return clone(totals);
		},
	};
	return {
		api,
		rows,
		get totals() {
			return totals;
		},
		seed(row) {
			rows.set(row.id, { ...clone(row), updated_at: stamp() });
		},
		// Simulate another writer sneaking in right before our CAS.
		interfereOnce(fn) {
			const orig = api.casUpdatePractice;
			api.casUpdatePractice = async (...args) => {
				api.casUpdatePractice = orig;
				fn();
				return orig(...args);
			};
		},
	};
}

const routine = () => ({ id: 'p1', name: 'R', loop: false, metronomes: [{ id: 'a', name: 'A', startBPM: 100, duration: 60 }, { id: 'b', name: 'B', startBPM: 120, duration: 60 }] });
const local = (srv) => JSON.parse(JSON.stringify(srv.rows.get('p1')));

test('two stale tabs both keep their records (no lost update)', async () => {
	const srv = fakeServer();
	srv.seed(routine());
	const tab1 = createSync(srv.api);
	const tab2 = createSync(srv.api);
	const l1 = local(srv);
	const l2 = local(srv); // loaded before tab1 saved: stale
	tab1.addSectionDelta('p1', 'a', 's', 1);
	tab1.addTotalsDelta('s', 1);
	await tab1.flushPractice(l1);
	await tab1.flushTotals();
	tab2.addSectionDelta('p1', 'a', 'f', 1);
	tab2.addTotalsDelta('f', 1);
	await tab2.flushPractice(l2);
	await tab2.flushTotals();
	assert.deepEqual(srv.rows.get('p1').metronomes[0].stats, { s: 1, f: 1 });
	assert.deepEqual([srv.totals.success, srv.totals.fail], [1, 1]);
});

test('a concurrent write between read and write is retried, not overwritten', async () => {
	const srv = fakeServer();
	srv.seed(routine());
	const tab = createSync(srv.api);
	tab.addSectionDelta('p1', 'b', 's', 2);
	srv.interfereOnce(() => {
		const row = srv.rows.get('p1');
		row.metronomes[1].stats = { s: 5, f: 0 };
		row.updated_at = 'other';
	});
	await tab.flushPractice(local(srv));
	assert.deepEqual(srv.rows.get('p1').metronomes[1].stats, { s: 7, f: 0 });
	assert.equal(tab.hasPending('p1'), false);
});

test('undo is a negative delta and never drives counts below zero', async () => {
	const srv = fakeServer();
	srv.seed({ ...routine(), metronomes: [{ id: 'a', name: 'A', stats: { s: 1, f: 0 } }] });
	const tab = createSync(srv.api);
	tab.addSectionDelta('p1', 'a', 's', 1);
	tab.addSectionDelta('p1', 'a', 's', -1);
	tab.addSectionDelta('p1', 'a', 's', -1);
	tab.addSectionDelta('p1', 'a', 'f', -3);
	await tab.flushPractice(local(srv));
	assert.deepEqual(srv.rows.get('p1').metronomes[0].stats, { s: 0, f: 0 });
});

test('records made while a flush is in flight stay pending', async () => {
	const srv = fakeServer();
	srv.seed(routine());
	const tab = createSync(srv.api);
	tab.addSectionDelta('p1', 'a', 's', 1);
	const orig = srv.api.casUpdatePractice;
	srv.api.casUpdatePractice = async (...args) => {
		tab.addSectionDelta('p1', 'a', 's', 1); // rapid second record mid-flight
		srv.api.casUpdatePractice = orig;
		return orig(...args);
	};
	await tab.flushPractice(local(srv));
	assert.deepEqual(srv.rows.get('p1').metronomes[0].stats, { s: 1, f: 0 });
	assert.deepEqual(tab.pendingFor('p1').get('a'), { s: 1, f: 0 });
	await tab.flushPractice(local(srv));
	assert.deepEqual(srv.rows.get('p1').metronomes[0].stats, { s: 2, f: 0 });
	assert.equal(tab.hasPending('p1'), false);
});

test('structure edits win but keep server stats + deltas', async () => {
	const srv = fakeServer();
	srv.seed({ ...routine(), metronomes: [{ id: 'a', name: 'A', stats: { s: 4, f: 1 } }, { id: 'b', name: 'B', stats: { s: 0, f: 2 } }] });
	const tab = createSync(srv.api);
	const l = local(srv);
	l.metronomes.reverse();
	l.metronomes[0].name = 'B renamed';
	l.metronomes[0].stats = { s: 99, f: 99 }; // stale local display must not be written
	l.name = 'Renamed';
	tab.markStructure('p1');
	tab.addSectionDelta('p1', 'a', 'f', 1);
	await tab.flushPractice(l);
	const row = srv.rows.get('p1');
	assert.equal(row.name, 'Renamed');
	assert.deepEqual(row.metronomes.map((m) => [m.id, m.name, m.stats]), [
		['b', 'B renamed', { s: 0, f: 2 }],
		['a', 'A', { s: 4, f: 2 }],
	]);
	assert.equal(tab.isStructDirty('p1'), false);
});

test('without local structure edits the server structure is kept', () => {
	const out = mergeForWrite({
		server: { name: 'S', loop: true, metronomes: [{ id: 'x', name: 'X' }] },
		local: { name: 'L', loop: false, metronomes: [] },
		deltas: new Map([['x', { s: 1, f: 0 }]]),
		structDirty: false,
	});
	assert.deepEqual(out, { name: 'S', loop: true, metronomes: [{ id: 'x', name: 'X', stats: { s: 1, f: 0 } }] });
});

test('routine deleted elsewhere: flush returns null and drops deltas', async () => {
	const srv = fakeServer();
	const tab = createSync(srv.api);
	tab.addSectionDelta('gone', 'a', 's', 1);
	assert.equal(await tab.flushPractice({ id: 'gone', metronomes: [] }), null);
	assert.equal(tab.hasPending('gone'), false);
});

test('reconcile keeps object identity and shows server + pending', () => {
	const a = { id: 'a', name: 'A', stats: { s: 1, f: 0 } };
	const pending = new Map([['a', { s: 1, f: 0 }]]);
	const out = reconcileSections([a], [{ id: 'a', name: 'A2', stats: { s: 3, f: 1 } }, { id: 'n', name: 'New' }], pending, false);
	assert.equal(out[0], a);
	assert.deepEqual(a, { id: 'a', name: 'A2', stats: { s: 4, f: 1 } });
	assert.deepEqual(out[1].stats, { s: 0, f: 0 });
});

test('legacy sections get the same positional ids in every tab', () => {
	const one = [{ name: 'A' }, { name: 'B', id: 'keep' }];
	const two = [{ name: 'A' }, { name: 'B', id: 'keep' }];
	ensureSectionIds(one);
	ensureSectionIds(two);
	assert.deepEqual(one, two);
	assert.equal(one[0].id, 'idx-0');
});

test('totals: first write inserts, later writes merge', async () => {
	const srv = fakeServer();
	const t1 = createSync(srv.api);
	const t2 = createSync(srv.api);
	t1.addTotalsDelta('s', 2);
	t2.addTotalsDelta('f', 1);
	await t1.flushTotals();
	assert.deepEqual(await t2.flushTotals(), { s: 2, f: 1 });
});

// Make the next CAS call land (or not) on the server but throw like a dropped connection.
function dropResponse(srv, method, { lands }) {
	const orig = srv.api[method];
	srv.api[method] = async (...args) => {
		srv.api[method] = orig;
		if (lands) await orig(...args);
		throw new TypeError('Failed to fetch');
	};
}

test('lost response after the write landed: not applied twice', async () => {
	const srv = fakeServer();
	srv.seed(routine());
	const tab = createSync(srv.api);
	tab.addSectionDelta('p1', 'a', 's', 1);
	tab.addTotalsDelta('s', 1);
	dropResponse(srv, 'casUpdatePractice', { lands: true });
	await assert.rejects(tab.flushPractice(local(srv)));
	assert.equal(tab.hasPending('p1'), false);
	await tab.flushPractice(local(srv));
	assert.deepEqual(srv.rows.get('p1').metronomes[0].stats, { s: 1, f: 0 });

	await tab.flushTotals(); // creates the row
	tab.addTotalsDelta('f', 1);
	dropResponse(srv, 'casUpdateTotals', { lands: true });
	await assert.rejects(tab.flushTotals());
	assert.equal(tab.hasTotalsPending(), false);
	assert.deepEqual([srv.totals.success, srv.totals.fail], [1, 1]);
});

test('lost response when the write did not land: applied on retry', async () => {
	const srv = fakeServer();
	srv.seed(routine());
	const tab = createSync(srv.api);
	tab.addSectionDelta('p1', 'a', 'f', 2);
	dropResponse(srv, 'casUpdatePractice', { lands: false });
	await assert.rejects(tab.flushPractice(local(srv)));
	assert.equal(tab.hasPending('p1'), true);
	await tab.flushPractice(local(srv));
	assert.deepEqual(srv.rows.get('p1').metronomes[0].stats, { s: 0, f: 2 });
});

test('outcome unknown (re-read also fails): stays in flight and is resolved first next time', async () => {
	const srv = fakeServer();
	srv.seed(routine());
	const tab = createSync(srv.api);
	tab.addSectionDelta('p1', 'a', 's', 1);
	const fetchOrig = srv.api.fetchPractice;
	dropResponse(srv, 'casUpdatePractice', { lands: true });
	let calls = 0;
	srv.api.fetchPractice = async (id) => {
		if (++calls === 2) throw new TypeError('offline'); // the re-read after the drop
		return fetchOrig(id);
	};
	await assert.rejects(tab.flushPractice(local(srv)));
	assert.equal(tab.exportState().inflight.length, 1);
	srv.api.fetchPractice = fetchOrig;
	await tab.flushPractice(local(srv));
	assert.deepEqual(srv.rows.get('p1').metronomes[0].stats, { s: 1, f: 0 });
	assert.equal(tab.exportState().inflight.length, 0);
});

test('state survives export → import into a new tab (closed-tab recovery), applied once', async () => {
	const srv = fakeServer();
	srv.seed(routine());
	const saved = [];
	const closing = createSync(srv.api, (st) => saved.push(st));
	closing.addSectionDelta('p1', 'b', 's', 1);
	closing.addTotalsDelta('s', 1);
	const stored = JSON.parse(JSON.stringify(saved.at(-1))); // what localStorage holds
	assert.deepEqual(stored.sections, { p1: { b: { s: 1, f: 0 } } });

	const next = createSync(srv.api);
	next.importState(stored);
	await next.flushPractice(local(srv));
	await next.flushTotals();
	assert.deepEqual(srv.rows.get('p1').metronomes[1].stats, { s: 1, f: 0 });
	assert.equal(srv.totals.success, 1);
	assert.equal(next.isEmptyState(next.exportState()), true);
	await next.flushTotals();
	assert.equal(srv.totals.success, 1);
});

test('dropCounts clears memory and reports an empty state', () => {
	const saved = [];
	const tab = createSync(fakeServer().api, (st) => saved.push(st));
	tab.addSectionDelta('p1', 'a', 's', 1);
	tab.addTotalsDelta('f', 1);
	tab.dropCounts();
	assert.equal(tab.isEmptyState(saved.at(-1)), true);
	assert.deepEqual(tab.pendingPracticeIds(), []);
});

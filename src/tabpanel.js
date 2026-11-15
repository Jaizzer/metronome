// ============================================================
// tabpanel.js — the player's "Tab" disclosure: the current section's
// bars drawn by alphaTab (or the text tab's lines), and "Hear it", which
// plays them with alphaTab's synth at the live tempo while the click is
// paused. The file comes from this device's IndexedDB (tabstore.js);
// without it the panel offers "Import again".
// ============================================================
import { h, iconEl } from './dom.js';
import { ACCEPT, readTab, sourceFromRecord, sourceBars, loadTabView } from './tabload.js';
import { loadTab, saveTab, tabRecord, routineTab, checkReattach } from './tabstore.js';
import { textBarsSlice } from './tabtext.js';
import { tempoAt, barRange } from './slicer.js';

const $ = (id) => document.getElementById(id);
const OPEN_KEY = 'metronome:tab-open';

function remembered() {
	try {
		return localStorage.getItem(OPEN_KEY) === '1';
	} catch {
		return false;
	}
}

function remember(open) {
	try {
		localStorage.setItem(OPEN_KEY, open ? '1' : '0');
	} catch {
		// private mode: the choice just isn't kept
	}
}

// opts: { toast, pauseClick() → wasRunning, resumeClick(), liveBpm() }
export function createTabPanel(opts) {
	const panel = $('tab-panel');
	const body = $('tab-body');
	const cache = new Map(); // routine id → Promise<source | null>
	let current = null; // { p, m }
	let view = null; // alphaTab view (score tabs)
	let viewHost = null;
	let token = 0;
	let hearing = false;

	panel.open = remembered();
	panel.addEventListener('toggle', () => {
		remember(panel.open);
		if (panel.open && current) render();
		if (!panel.open) stop();
	});

	const input = h('input', { type: 'file', id: 'tab-file', accept: ACCEPT, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
	input.addEventListener('change', () => {
		const file = input.files?.[0];
		input.value = '';
		if (file && current) reattach(current.p, file);
	});
	document.body.append(input);

	function sourceFor(p) {
		if (!cache.has(p.id)) {
			cache.set(
				p.id,
				loadTab(p.id)
					.then((rec) => (rec ? sourceFromRecord(rec) : null))
					.catch((e) => {
						cache.delete(p.id);
						throw e;
					}),
			);
		}
		return cache.get(p.id);
	}

	function summaryLabel(m) {
		const r = barRange(m.bars[0], m.bars[1]);
		return m.seam ? `Tab · seam, ${r}` : `Tab · ${r}`;
	}

	function update(p, m) {
		const changed = current?.p !== p || current?.m !== m;
		current = m?.bars ? { p, m } : null;
		if (changed) stop();
		panel.hidden = !current;
		if (!current) return;
		$('tab-summary').replaceChildren(iconEl('tab'), summaryLabel(m));
		if (panel.open && changed) render();
	}

	function setStatus(text) {
		const el = $('tab-status');
		if (el) el.textContent = text;
	}

	// idle: "Hear it"; loading: "Loading sound… · Cancel"; playing: "Stop".
	function hearButton(state) {
		const btn = $('tab-hear');
		if (!btn) return;
		const label = { idle: 'Hear it', loading: 'Loading sound… · Cancel', playing: 'Stop' }[state];
		btn.replaceChildren(iconEl(state === 'idle' ? 'speaker' : 'stop'), label);
		btn.setAttribute('aria-pressed', String(state !== 'idle'));
		btn.dataset.state = state;
	}

	async function render() {
		const my = ++token;
		const { p, m } = current;
		let src;
		if (!body.querySelector('.tab-render')) body.replaceChildren(h('p', { class: 'tab-note' }, 'Loading the tab…'));
		try {
			src = await sourceFor(p);
		} catch (e) {
			if (my !== token) return;
			body.replaceChildren(h('p', { class: 'tab-note' }, e.message || 'The tab couldn’t be loaded'));
			return;
		}
		if (my !== token || !current) return;
		if (!src) {
			dropView();
			body.replaceChildren(
				h(
					'div',
					{ class: 'tab-missing' },
					h('p', {}, 'Tab file not on this device'),
					h('button', { class: 'btn', type: 'button', id: 'tab-reattach', onclick: () => input.click() }, iconEl('importFile'), 'Import again'),
				),
			);
			return;
		}
		const [a, b] = m.bars;
		if (src.format === 'text') {
			dropView();
			const blocks = textBarsSlice(src.parsed, a, b);
			body.replaceChildren(
				h(
					'div',
					{ class: 'tab-render tab-render-text', role: 'img', 'aria-label': `Tab, ${barRange(a, b)}` },
					blocks.length ? blocks.map((lines) => h('pre', { class: 'tab-text' }, lines.join('\n'))) : h('p', { class: 'tab-note' }, 'These bars aren’t in the file'),
				),
				h('p', { class: 'tab-note' }, 'Text tabs have no rhythm, so there’s nothing to play.'),
			);
			return;
		}
		if (!view || !viewHost?.isConnected) {
			dropView();
			viewHost = h('div', { class: 'tab-render', role: 'img', 'aria-label': `Tab, ${barRange(a, b)}` });
			body.replaceChildren(
				h(
					'div',
					{ class: 'tab-tools' },
					h('button', { class: 'btn', type: 'button', id: 'tab-hear', 'aria-pressed': 'false', onclick: hear }),
					h('span', { id: 'tab-status', class: 'tab-status', 'aria-live': 'polite' }),
				),
				viewHost,
			);
			hearButton('idle');
			try {
				const tv = await loadTabView();
				if (my !== token) return;
				view = tv.createTabView(viewHost, { scale: matchMedia('(max-width: 560px)').matches ? 0.95 : 1.1 });
			} catch (e) {
				body.replaceChildren(h('p', { class: 'tab-note' }, e.message));
				view = null;
				return;
			}
		}
		viewHost.setAttribute('aria-label', `Tab, ${barRange(a, b)}`);
		try {
			await view.show(src.score, src.track, a, b);
		} catch (e) {
			if (my !== token) return;
			dropView(); // the next try starts from a fresh alphaTab view
			body.replaceChildren(h('p', { class: 'tab-note', role: 'alert' }, `Couldn’t draw this tab: ${e.message || e}`));
		}
	}

	// Hear it / Stop / Cancel. Stop, a section change, closing the panel,
	// leaving the player or the click resuming all end it through stop(),
	// including while the sound is still loading.
	async function hear() {
		if (!view || !current) return;
		if (hearing) return stop();
		const at = current;
		const src = await sourceFor(at.p).catch(() => null);
		if (current !== at || !src || src.format !== 'score' || !view) return;
		const { m } = at;
		const v = view;
		hearing = true;
		hearButton('loading');
		const wasRunning = opts.pauseClick();
		// What the synth plays at speed 1 (alphaTab uses 120 when the file has no tempo).
		const fileTempo = tempoAt(sourceBars(src), m.bars[0]) || src.score.tempo || 120;
		const bpm = opts.liveBpm();
		const offState = v.onState((s) => {
			if (s.playing) {
				hearButton('playing');
				setStatus(`Playing at ${bpm} BPM`);
			}
		});
		try {
			await v.hear({ bpm, fileTempo, start: m.bars[0], end: m.bars[1], seam: Boolean(m.seam) });
		} catch (e) {
			opts.toast(e.message || 'Couldn’t play the tab', 'error', 3000);
		} finally {
			offState();
			hearing = false;
			if (view === v) hearButton('idle');
			setStatus('');
			if (wasRunning) opts.resumeClick();
		}
	}

	function stop() {
		view?.stop();
	}

	function dropView() {
		view?.destroy();
		view = null;
		viewHost = null;
	}

	async function reattach(p, file) {
		let src;
		let bars;
		let check;
		const ref = routineTab(p);
		try {
			src = await readTab({ file });
			if (src.format === 'score') {
				if (ref && !src.score.tracks[ref.track]) throw new Error(`This file has no track ${ref.track + 1}`);
				src.track = ref?.track ?? src.track;
			}
			bars = sourceBars(src).length;
			check = checkReattach(p, { format: src.format, bars, title: src.title });
			if (!check.ok) throw new Error(check.reason);
		} catch (e) {
			opts.toast(e.message || String(e), 'error', 4000);
			return;
		}
		const attach = async () => {
			try {
				await saveTab(tabRecord({ routineId: p.id, fileName: file.name, format: src.format, data: src.data, track: src.track, title: src.title, bars }));
				cache.set(p.id, Promise.resolve(src));
				opts.toast('Tab attached', '', 2000);
				if (current?.p === p) render();
			} catch (e) {
				opts.toast(e.message || String(e), 'error', 4000);
			}
		};
		if (check.sameTitle) return attach();
		opts.confirm({
			title: 'Use this file?',
			text: `This file is “${src.title}”, the routine was imported from “${ref?.title ?? ''}”. Use it anyway?`,
			confirm: 'Use it',
			danger: false,
			onConfirm: attach,
		});
	}

	return {
		update,
		stop,
		get hearing() {
			return hearing;
		},
		// Leaving the player: stop and free alphaTab.
		close() {
			stop();
			token++;
			dropView();
			current = null;
			body.replaceChildren();
		},
		forget(routineId) {
			cache.delete(routineId);
		},
		remember(routineId, source) {
			cache.set(routineId, Promise.resolve(source));
		},
	};
}

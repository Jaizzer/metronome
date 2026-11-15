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
import { tickRange } from './tabscore.js';

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

	function hearButton(on) {
		const btn = $('tab-hear');
		if (!btn) return;
		btn.replaceChildren(iconEl(on ? 'stop' : 'speaker'), on ? 'Stop' : 'Hear it');
		btn.setAttribute('aria-pressed', String(on));
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
			hearButton(false);
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
			if (my === token) setStatus(e.message || 'The tab couldn’t be drawn');
		}
	}

	async function hear() {
		if (!view || !current) return;
		if (hearing) return stop();
		const { p, m } = current;
		const src = await sourceFor(p).catch(() => null);
		if (!src || src.format !== 'score') return;
		hearing = true;
		hearButton(true);
		const wasRunning = opts.pauseClick();
		const bars = sourceBars(src);
		const bpm = opts.liveBpm();
		const fileTempo = tempoAt(bars, m.bars[0]) || src.score.tempo || bpm;
		// A seam ends on the first beat of its second bar.
		const range = tickRange(bars, m.bars[0], m.bars[1], Boolean(m.seam));
		setStatus('Loading the sound…');
		const offState = view.onState((s) => {
			if (s.playing) setStatus(`Playing at ${bpm} BPM`);
		});
		try {
			await view.hear({ bpm, fileTempo, range });
		} catch (e) {
			opts.toast(e.message || 'Couldn’t play the tab', 'error', 3000);
		} finally {
			offState();
			hearing = false;
			hearButton(false);
			setStatus('');
			if (wasRunning) opts.resumeClick();
		}
	}

	function stop() {
		if (view?.isPlaying) view.stop();
	}

	function dropView() {
		view?.destroy();
		view = null;
		viewHost = null;
	}

	async function reattach(p, file) {
		try {
			const src = await readTab({ file });
			const ref = routineTab(p);
			if (src.format === 'score') {
				if (ref && !src.score.tracks[ref.track]) throw new Error(`This file has no track ${ref.track + 1}`);
				src.track = ref?.track ?? src.track;
			}
			const bars = sourceBars(src).length;
			const check = checkReattach(p, { format: src.format, bars, title: src.title });
			if (!check.ok) throw new Error(check.reason);
			await saveTab(tabRecord({ routineId: p.id, fileName: file.name, format: src.format, data: src.data, track: src.track, title: src.title, bars }));
			cache.set(p.id, Promise.resolve(src));
			opts.toast(check.sameTitle ? 'Tab attached' : `Tab attached · “${src.title}”`, '', 2000);
			if (current?.p === p) render();
		} catch (e) {
			opts.toast(e.message || String(e), 'error', 4000);
		}
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

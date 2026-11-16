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
import { tempoAt, barRange, rangeText } from './slicer.js';

const $ = (id) => document.getElementById(id);
const OPEN_KEY = 'metronome:tab-open';
const ALONG_KEY = 'metronome:tab-along';
function lsGetJSON(k) {
	try {
		return JSON.parse(localStorage.getItem(k));
	} catch {
		return null;
	}
}

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

// opts: { toast, confirm, pauseClick() → wasRunning, resumeClick(), liveBpm(),
//         openFull() (the Tab player), attached(p) (a file was re-attached) }
export function createTabPanel(opts) {
	const panel = $('tab-panel');
	const body = $('tab-body');
	const cache = new Map(); // routine id → Promise<source | null>
	let current = null; // { p, m }
	let view = null; // alphaTab view (score tabs)
	let viewHost = null;
	let token = 0;
	let hearing = false;
	let pickFor = null; // the routine "Import again" was pressed for (player or Tab player)
	// "Play with metronome": the tab loops with the click (alphaTab is the clock).
	let alongOn = lsGetJSON(ALONG_KEY) === true;
	let alongPlaying = false; // alphaTab is sounding the click + music now
	let alongFileTempo = 0;
	let currentFormat = null; // 'score' | 'text' for the shown section's routine
	let rendering = null; // the latest render() promise
	let alongSeq = 0; // bumped by every start/stop: a late start can't revive a stopped one

	panel.open = remembered();
	panel.addEventListener('toggle', () => {
		remember(panel.open);
		if (panel.open && current) render();
		if (panel.open && current && alongOn) startAlong({ paused: opts.isPaused() });
		if (!panel.open) stop();
	});

	const input = h('input', { type: 'file', id: 'tab-file', accept: ACCEPT, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
	input.addEventListener('change', () => {
		const file = input.files?.[0];
		input.value = '';
		const p = pickFor ?? current?.p;
		pickFor = null;
		if (file && p) reattach(p, file);
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

	// What a section covers: its bars, or its beat range.
	const spanText = (m) => (m.range ? rangeText(m.range) : barRange(m.bars[0], m.bars[1]));

	function summaryLabel(m) {
		const r = spanText(m);
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
		if (changed && alongOn) startAlong({ paused: opts.isPaused() });
	}

	// ---------- Play with metronome ----------

	const mutesKey = (p) => `metronome:tab-mutes:${p.id}`;
	function mutesFor(p) {
		const v = lsGetJSON(mutesKey(p));
		return { muted: Array.isArray(v?.muted) ? v.muted : [], clickOnly: Boolean(v?.clickOnly) };
	}
	function saveMutes(p, v) {
		try {
			localStorage.setItem(mutesKey(p), JSON.stringify(v));
		} catch {
			// private mode: not remembered
		}
	}

	// Loop the current section's bars with the click, at the live tempo.
	async function startAlong({ paused = false } = {}) {
		if (!alongOn || !current || !panel.open) return;
		const seq = ++alongSeq;
		const at = current;
		const live = () => alongOn && seq === alongSeq && current === at && panel.open;
		await (rendering ?? render());
		if (!live() || !view || currentFormat !== 'score') return;
		const src = await sourceFor(at.p).catch(() => null);
		if (!live() || !src || src.format !== 'score' || !view) return;
		const { m } = at;
		alongFileTempo = tempoAt(sourceBars(src), m.bars[0]) || src.score.tempo || 120;
		const v = view;
		const off = v.onState((st) => {
			if ('playing' in st) alongPlaying = st.playing && view === v;
			if (st.loading !== undefined) setStatus(st.loading ? 'Loading sound…' : '');
		});
		try {
			const r = await v.along({
				bpm: opts.liveBpm(),
				fileTempo: alongFileTempo,
				start: m.bars[0],
				end: m.bars[1],
				seam: Boolean(m.seam),
				range: m.range ?? null,
				...mutesFor(at.p),
				paused,
			});
			if (r === 'failed') throw new Error('Couldn’t play the tab');
		} catch (e) {
			opts.toast(`${e.message || e} · back to the normal click`, 'error', 3000);
		} finally {
			off();
			if (view === v) alongPlaying = false;
		}
	}

	function renderAlongTools() {
		const box = $('tab-along-tools');
		if (!box || !current) return;
		const sw = $('tab-along');
		sw?.setAttribute('aria-checked', String(alongOn));
		if (!alongOn) return box.replaceChildren();
		const p = current.p;
		const st = mutesFor(p);
		const tracks = view?.api?.score?.tracks ?? [];
		const toggle = (label, pressed, onclick) =>
			h('button', { class: 'btn btn-quiet tab-track', type: 'button', 'aria-pressed': String(pressed), onclick }, label);
		box.replaceChildren(
			...tracks.map((t) =>
				toggle(t.name || `Track ${t.index + 1}`, !st.clickOnly && !st.muted.includes(t.index), () => {
					const v = mutesFor(p);
					v.muted = v.muted.includes(t.index) ? v.muted.filter((i) => i !== t.index) : [...v.muted, t.index];
					v.clickOnly = false;
					saveMutes(p, v);
					view?.setMutes(v.muted, v.clickOnly);
					renderAlongTools();
				}),
			),
			toggle('Click only', st.clickOnly, () => {
				const v = mutesFor(p);
				v.clickOnly = !v.clickOnly;
				saveMutes(p, v);
				view?.setMutes(v.muted, v.clickOnly);
				renderAlongTools();
			}),
		);
	}

	function setAlong(on) {
		alongOn = on;
		try {
			localStorage.setItem(ALONG_KEY, JSON.stringify(on));
		} catch {
			// private mode
		}
		renderAlongTools();
		if (on) startAlong({ paused: opts.isPaused() });
		else stop();
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

	function render() {
		rendering = doRender();
		return rendering;
	}

	async function doRender() {
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
					h('button', { class: 'btn', type: 'button', id: 'tab-reattach', onclick: () => pickFile(null) }, iconEl('importFile'), 'Import again'),
				),
			);
			return;
		}
		const [a, b] = m.bars;
		currentFormat = src.format;
		if (src.format === 'text') {
			dropView();
			const blocks = textBarsSlice(src.parsed, a, b);
			body.replaceChildren(
				h(
					'div',
					{ class: 'tab-render tab-render-text', role: 'img', 'aria-label': `Tab, ${spanText(m)}` },
					blocks.length ? blocks.map((lines) => h('pre', { class: 'tab-text' }, lines.join('\n'))) : h('p', { class: 'tab-note' }, 'These bars aren’t in the file'),
				),
				h('p', { class: 'tab-note' }, 'Text tabs have no rhythm, so there’s nothing to play.'),
			);
			return;
		}
		if (!view || !viewHost?.isConnected) {
			dropView();
			viewHost = h('div', { class: 'tab-render', role: 'img', 'aria-label': `Tab, ${spanText(m)}` });
			body.replaceChildren(
				h(
					'div',
					{ class: 'tab-tools' },
					h('button', { class: 'btn', type: 'button', id: 'tab-hear', 'aria-pressed': 'false', onclick: hear }),
					h('button', { class: 'btn btn-quiet', type: 'button', id: 'tab-full', onclick: () => opts.openFull?.() }, iconEl('expand'), 'Open full tab'),
					h(
						'button',
						{ class: 'switch', type: 'button', role: 'switch', id: 'tab-along', 'aria-checked': String(alongOn), onclick: () => setAlong(!alongOn) },
						h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
						'Play with metronome',
					),
					h('span', { id: 'tab-status', class: 'tab-status', 'aria-live': 'polite' }),
				),
				h('div', { id: 'tab-along-tools', class: 'tab-along-tools' }),
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
		viewHost.setAttribute('aria-label', `Tab, ${spanText(m)}`);
		try {
			await view.show(src.score, src.track, a, b, m.range ?? null);
			if (my === token) renderAlongTools();
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
			await v.hear({ bpm, fileTempo, start: m.bars[0], end: m.bars[1], seam: Boolean(m.seam), range: m.range ?? null });
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
		alongSeq++;
		view?.stop();
	}

	// "Import again" (p: the routine, null = the player's section).
	function pickFile(p) {
		pickFor = p;
		input.click();
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
				opts.attached?.(p);
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
		// Play with metronome is on and this section has a playable tab.
		wantsAlong: () => alongOn && Boolean(current) && panel.open && currentFormat === 'score',
		get alongPlaying() {
			return alongPlaying;
		},
		pauseAlong: () => view?.pause(),
		resumeAlong: () => {
			if (!view?.isPlaying) startAlong({ paused: false });
			else view.resume();
		},
		alongSpeed: (bpm) => view?.setSpeed(bpm, alongFileTempo),
		sourceFor,
		pickFile,
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

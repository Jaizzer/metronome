// ============================================================
// importer.js — the Import tab view: pick a file (or paste a text tab),
// review the proposed chunks (merge, split, rename, delete), then create
// a Song-mode routine (docs/TAB-IMPORT.md). alphaTab is only loaded for
// Guitar Pro / MusicXML files and previews (tabload.js).
// ============================================================
import { h, iconEl } from './dom.js';
import { ACCEPT, readTab, sourceBars, loadTabView } from './tabload.js';
import { textBarsSlice, textDense } from './tabtext.js';
import {
	planChunks,
	mergeWithNext,
	canMerge,
	splitChunk,
	canSplit,
	renameChunk,
	deleteChunk,
	buildSections,
	planSummary,
	startTempo,
	targetTempo,
	tempoAt,
	barRange,
} from './slicer.js';

const $ = (id) => document.getElementById(id);

// opts: { toast, show(view), close(), create(draft, source) → Promise, makeId }
export function createImporter(opts) {
	let st = null; // the review state, null while choosing
	let preview = null; // the open chunk's tab view (alphaTab)
	let busy = false;

	const input = h('input', { type: 'file', id: 'import-file', accept: ACCEPT, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
	input.addEventListener('change', () => {
		const file = input.files?.[0];
		input.value = '';
		if (file) load({ file });
	});
	document.body.append(input);

	const main = () => $('import-main');

	function dropPreview() {
		preview?.destroy();
		preview = null;
	}

	function open({ pick = true } = {}) {
		st = null;
		dropPreview();
		opts.show();
		renderChoose();
		$('import-title').focus();
		if (pick) input.click();
	}

	function close() {
		dropPreview();
		st = null;
		opts.close();
	}

	// ---- Step 1: choose a file or paste text ----

	function chooseBlock(error = '') {
		const area = h('textarea', {
			id: 'import-paste',
			class: 'paste-area',
			rows: '8',
			spellcheck: false,
			autocapitalize: 'off',
			placeholder: 'e|-----0-----|---0---0---|\nB|---1---1---|-1---1-----|\n…',
			'aria-label': 'Text tab',
		});
		return [
			h('p', { class: 'import-lede' }, 'A Guitar Pro or MusicXML file gives the best cut: it has the rhythm, sections and tempo. A text tab works too; you set the tempo.'),
			error && h('p', { class: 'form-error import-error', role: 'alert' }, error),
			h('button', { class: 'btn btn-primary btn-block', type: 'button', id: 'import-pick', onclick: () => input.click() }, iconEl('importFile'), 'Choose a tab file'),
			h('p', { class: 'import-types' }, '.gp · .gp3 · .gp4 · .gp5 · .gpx · .musicxml · .xml · .mxl · .txt'),
			h(
				'details',
				{ class: 'import-paste' },
				h('summary', {}, iconEl('paste'), 'Paste a text tab'),
				h(
					'div',
					{ class: 'import-paste-body' },
					area,
					h(
						'button',
						{
							class: 'btn',
							type: 'button',
							id: 'import-read-text',
							onclick: () => {
								if (!area.value.trim()) return opts.toast('Paste a tab first');
								load({ text: area.value });
							},
						},
						'Read this tab',
					),
				),
			),
		];
	}

	function renderChoose(error = '') {
		main().replaceChildren(h('div', { class: 'import-choose' }, ...chooseBlock(error)));
	}

	async function load(src) {
		if (busy) return;
		busy = true;
		dropPreview();
		main().replaceChildren(h('p', { class: 'import-status', role: 'status' }, src.file ? `Reading ${src.file.name}…` : 'Reading the tab…'));
		try {
			const source = await readTab(src);
			startReview(source);
		} catch (e) {
			st = null;
			renderChoose(e.message || String(e));
		} finally {
			busy = false;
		}
	}

	// ---- Step 2: review ----

	function plan(source, track) {
		const bars = sourceBars(source, track);
		const chunks = source.format === 'text' ? planChunks(bars, { size: 2, density: textDense }) : planChunks(bars);
		return { bars, chunks };
	}

	function startReview(source) {
		const { bars, chunks } = plan(source, source.track);
		const fileTarget = source.format === 'text' ? source.tempo : targetTempo(bars);
		st = { source, track: source.track, bars, chunks, name: source.title, target: fileTarget ?? null, fromFile: fileTarget !== null && source.format !== 'text', openIdx: -1 };
		st.noTempo = source.format === 'score' && fileTarget === null;
		renderReview();
		$('import-title').focus();
	}

	function chunkRow(c, i) {
		const isOpen = st.openIdx === i;
		const n = c.end - c.start + 1;
		const fileTempo = st.source.format === 'score' ? tempoAt(st.bars, c.start) : null;
		const tempoNote = fileTempo && st.target && Math.round(fileTempo) !== Math.round(st.target) ? `♩ ${Math.round(fileTempo)} here` : null;
		const li = h('li', { class: `chunk${isOpen ? ' is-open' : ''}`, 'data-idx': i });
		const panelId = `chunk-panel-${i}`;
		const keepFocus = (e, idx) => {
			if (e.detail === 0) main().querySelector(`.chunk[data-idx="${idx}"] .chunk-open`)?.focus();
		};
		const edit = (next, e, focusIdx) => {
			st.chunks = next;
			st.openIdx = Math.min(st.openIdx, st.chunks.length - 1);
			renderReview();
			keepFocus(e, Math.max(0, Math.min(focusIdx, st.chunks.length - 1)));
		};
		li.append(
			h(
				'button',
				{
					class: 'chunk-open',
					type: 'button',
					'aria-expanded': String(isOpen),
					'aria-controls': panelId,
					onclick: (e) => {
						st.openIdx = isOpen ? -1 : i;
						renderReview();
						keepFocus(e, i);
					},
				},
				h(
					'span',
					{ class: 'chunk-main' },
					h('span', { class: 'chunk-name' }, c.name),
					h(
						'span',
						{ class: 'chunk-meta' },
						// The generated name already says which bars.
						`${c.auto ? '' : `${barRange(c.start, c.end).replace(/^b/, 'B')} · `}${n} ${n === 1 ? 'bar' : 'bars'}`,
						tempoNote && ` · ${tempoNote}`,
					),
					c.dense && h('span', { class: 'chunk-flag' }, '▼ Likely bottleneck'),
				),
				h('span', { class: 'chev', 'aria-hidden': 'true' }),
			),
		);
		const panel = h('div', { class: 'chunk-panel', id: panelId, hidden: !isOpen });
		if (isOpen) {
			const nameInput = h('input', {
				type: 'text',
				value: c.name,
				class: 'chunk-name-input',
				'aria-label': 'Chunk name',
				// Updated in place (no re-render), so Tab to the next control still works.
				onchange: (e) => {
					st.chunks = renameChunk(st.chunks, i, e.target.value);
					e.target.value = st.chunks[i].name;
					li.querySelector('.chunk-name').textContent = st.chunks[i].name;
					li.querySelector('.chunk-meta').firstChild.textContent = `${st.chunks[i].auto ? '' : `${barRange(c.start, c.end).replace(/^b/, 'B')} · `}${n} ${n === 1 ? 'bar' : 'bars'}`;
				},
			});
			const previewEl = h('div', { class: 'chunk-preview', 'aria-label': `Tab, ${barRange(c.start, c.end)}`, role: 'img' });
			panel.append(
				previewEl,
				h('label', { class: 'field' }, h('span', {}, 'Name'), nameInput),
				h(
					'div',
					{ class: 'chunk-actions' },
					h(
						'button',
						{
							class: 'btn btn-quiet',
							type: 'button',
							disabled: !canMerge(st.chunks, i),
							title: st.chunks[i + 1] && !canMerge(st.chunks, i) ? 'The next chunk doesn’t start right after this one' : null,
							onclick: (e) => edit(mergeWithNext(st.chunks, i), e, i),
						},
						iconEl('merge'),
						'Merge with next',
					),
					h(
						'button',
						{ class: 'btn btn-quiet', type: 'button', disabled: !canSplit(c), onclick: (e) => edit(splitChunk(st.chunks, i), e, i) },
						iconEl('split'),
						'Split in half',
					),
					h(
						'button',
						{
							class: 'btn btn-quiet',
							type: 'button',
							disabled: st.chunks.length <= 1,
							onclick: (e) => {
								st.openIdx = -1;
								edit(deleteChunk(st.chunks, i), e, i);
							},
						},
						iconEl('trash'),
						'Delete',
					),
				),
			);
			fillPreview(previewEl, c.start, c.end);
		}
		li.append(panel);
		return li;
	}

	async function fillPreview(el, start, end) {
		dropPreview();
		if (st.source.format === 'text') {
			el.replaceChildren(...textBarsSlice(st.source.parsed, start, end).map((lines) => h('pre', { class: 'tab-text' }, lines.join('\n'))));
			return;
		}
		el.replaceChildren(h('p', { class: 'tab-note' }, 'Drawing the tab…'));
		try {
			const tv = await loadTabView();
			if (!el.isConnected) return;
			const view = tv.createTabView(el, { scale: 0.8 });
			preview = view;
			await view.show(st.source.score, st.track, start, end);
		} catch (e) {
			if (el.isConnected) el.replaceChildren(h('p', { class: 'tab-note' }, e.message || 'The tab couldn’t be drawn'));
		}
	}

	function summaryText() {
		const s = planSummary(st.chunks, st.bars);
		const parts = [`${s.bars} bars`, `${s.chunks} ${s.chunks === 1 ? 'chunk' : 'chunks'}`];
		if (s.dense) parts.push(`${s.dense} likely ${s.dense === 1 ? 'bottleneck' : 'bottlenecks'}`);
		return `${parts.join(' · ')} · plus ${s.seams} ${s.seams === 1 ? 'seam' : 'seams'} and 1 full run = ${s.sections} sections`;
	}

	function targetHint() {
		if (!(st.target >= 20 && st.target <= 300)) {
			if (st.source.format === 'text') return 'Required: the tempo you’re aiming for (a text tab has no rhythm).';
			if (st.noTempo) return 'Required: the file has no tempo. Enter the tempo you’re aiming for.';
			return 'Enter the tempo you’re aiming for (20–300).';
		}
		const from = st.fromFile ? 'From the file. ' : '';
		return `${from}Every chunk starts at ${startTempo(st.target)} BPM (70%) and climbs from there.`;
	}

	function renderReview() {
		dropPreview();
		const tracks = st.source.tracks;
		const createBtn = h(
			'button',
			{ class: 'btn btn-primary', type: 'button', id: 'import-create', disabled: !(st.target >= 20 && st.target <= 300) || !st.chunks.length, onclick: create },
			iconEl('plus'),
			'Create routine',
		);
		const hint = h('p', { class: 'import-hint', id: 'import-target-hint' }, targetHint());
		const summary = h('p', { class: 'import-summary', id: 'import-summary' }, summaryText());
		main().replaceChildren(
			h(
				'div',
				{ class: 'import-review' },
				h(
					'label',
					{ class: 'field' },
					h('span', {}, 'Routine name'),
					h('input', {
						type: 'text',
						id: 'import-name',
						value: st.name,
						onchange: (e) => (st.name = e.target.value.trim() || st.source.title),
					}),
				),
				tracks.length > 1 &&
					h(
						'label',
						{ class: 'field' },
						h('span', {}, 'Track'),
						h(
							'select',
							{
								id: 'import-track',
								onchange: (e) => {
									const track = Number(e.target.value);
									const next = plan(st.source, track);
									Object.assign(st, { track, bars: next.bars, chunks: next.chunks, openIdx: -1 });
									renderReview();
								},
							},
							tracks.map((t) => h('option', { value: String(t.index), selected: t.index === st.track }, `${t.index + 1}. ${t.name}${t.percussion ? ' (drums)' : ''}`)),
						),
					),
				h(
					'label',
					{ class: 'field field-bpm' },
					h('span', {}, 'Target BPM'),
					h('input', {
						type: 'number',
						id: 'import-target',
						min: '20',
						max: '300',
						step: '1',
						inputmode: 'numeric',
						required: true,
						value: st.target ? String(Math.round(st.target)) : '',
						'aria-describedby': 'import-target-hint',
						oninput: (e) => {
							const v = Number(e.target.value);
							st.target = Number.isFinite(v) && v > 0 ? v : null;
							st.fromFile = false;
							hint.textContent = targetHint();
							createBtn.disabled = !(st.target >= 20 && st.target <= 300) || !st.chunks.length;
						},
					}),
				),
				hint,
				summary,
				h('ol', { class: 'chunk-list', 'aria-label': 'Chunks' }, st.chunks.map(chunkRow)),
			),
			h(
				'div',
				{ class: 'import-bar' },
				h('div', { class: 'import-bar-inner' }, createBtn),
			),
		);
	}

	async function create() {
		if (busy || !st) return;
		const target = Math.round(st.target);
		if (!(target >= 20 && target <= 300)) return opts.toast('Enter a target BPM (20–300)', 'error');
		let metronomes;
		try {
			metronomes = buildSections(st.chunks, st.bars, {
				target,
				makeId: opts.makeId,
				tab: { title: st.source.title, track: st.track, bars: st.bars.length, format: st.source.format },
			});
		} catch (e) {
			return opts.toast(e.message || String(e), 'error');
		}
		busy = true;
		const btn = $('import-create');
		if (btn) {
			btn.disabled = true;
			btn.lastChild.textContent = 'Creating…';
		}
		try {
			await opts.create({ name: (st.name || st.source.title).slice(0, 120), metronomes }, { ...st.source, track: st.track, bars: st.bars.length });
			dropPreview();
			st = null;
		} catch (e) {
			opts.toast(`Couldn’t create the routine: ${e.message || e}`, 'error', 4000);
			if (btn) {
				btn.disabled = false;
				btn.lastChild.textContent = 'Create routine';
			}
		} finally {
			busy = false;
		}
	}

	return { open, close, pickFile: () => input.click(), get reviewing() { return Boolean(st); } };
}

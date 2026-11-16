// ============================================================
// tabplayer.js — the full-song Tab player (docs/TAB-PLAYER.md): the
// whole track drawn by alphaTab with its playback cursor and auto-scroll,
// a transport (Play/Pause, Stop, speed, count-in, metronome, loop), bar
// selection + loop, chunk chips, mute/solo, and the link back to practice.
// main.js loads this file with a dynamic import, so it (and alphaTab)
// stay out of the main bundle. The rules live in tabplayerlogic.js.
// ============================================================
import './tabplayer.css';
import { h, iconEl } from './dom.js';
import { alphaTab, makeSettings, profileFor, soundFontBytes, parseScore } from './tabview.js';
import { sourceBars } from './tabload.js';
import { playedBars, trackList, beatPoints } from './tabscore.js';
import { tempoAt, barRange } from './slicer.js';
import {
	position,
	tapBar,
	dragBars,
	moveCursor,
	setLoopStart,
	setLoopEnd,
	selectBars,
	clearSelection,
	stopBar,
	clampSpeed,
	stepSpeed,
	speedLabel,
	chunkChips,
	matchSection,
	insertIndex,
	newChunkSection,
	selectionLabel,
	shortName,
	barAtTick,
	barStartTick,
	selectionTicks,
	keyAction,
	bpmAt,
	sameSel,
	pedalTarget,
	speedLock,
	tapBeat,
	dragBeats,
	moveEnd,
	stepEnd,
	selPoints,
	rangeText,
	SPEED_MIN,
	SPEED_MAX,
} from './tabplayerlogic.js';

const PREFS_KEY = 'metronome:tabplayer';
const PLAYING = 1; // alphaTab.synth.PlayerState.Playing
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadPrefs() {
	try {
		const v = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
		return { speed: clampSpeed(v.speed ?? 100), countIn: Boolean(v.countIn), metronome: Boolean(v.metronome), loop: v.loop !== false, clickOnly: Boolean(v.clickOnly) };
	} catch {
		return { speed: 100, countIn: false, metronome: false, loop: true, clickOnly: false };
	}
}

function savePrefs(prefs) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// private mode: the choice just isn't kept
	}
}

// opts: {
//   p: the routine, root: the view's main element, posEl: the header's bar count,
//   source: Promise<tab source | null> (null = not on this device),
//   initial: the section to select on open ({ bars, range? }, the player's) or null,
//   toast, confirm, pickFile(), beforePlay(), practice(sectionIndex),
//   makeId(), insertSection(section, index) (adds it to the routine and saves),
//   isSong() (the routine is in Song mode), songLine(sectionIndex, bpm) (the
//   player's Song mode line for that section at that tempo, or null)
// }
// Recording (docs/TAB-PRACTICE.md): main.js feeds the pedal and asks
// target() at press time; refresh() after a record, undo or tempo change.
export function createTabPlayer(opts) {
	const { p, root, posEl } = opts;
	const prefs = loadPrefs();
	let token = 0; // bumped by destroy(): every await checks it
	let api = null;
	let host = null;
	let scoreEl = null;
	let marks = null;
	let boxLayer = null; // the selection boxes (re-drawn)
	const handles = {}; // start / end handles of a beat-level selection (kept, so a drag keeps its pointer)
	let beats = []; // beat points of the shown track (tabscore.beatPoints)
	let beatBounds = new Map(); // alphaTab Beat → its BeatBounds
	let score = null;
	let fileBars = [];
	let played = [];
	let total = 1;
	let track = 0;
	let ready = false; // synth + MIDI loaded
	let playing = false;
	let playedFrom = 1;
	let pos = position(1);
	let hold = null; // a bar kept in view while the tab loads (opened from a section)
	let movedTo = false; // the user moved the cursor to a bar (chip, tap, arrow) since the last scroll by hand
	let readyDone = false; // our playerReady handler (with its seek) has run
	let freeSpeed = false; // Free speed: manual speed even with a Song chunk selected
	let lastTick = 0; // playback position (alphaTab's)
	let recKey = null; // what the record line shows (re-drawn when it changes)
	const mute = new Set();
	const solo = new Set();
	const el = {}; // controls that get updated

	// ---------- Building the view ----------

	const toggleBtn = (id, icon, label, key) =>
		h(
			'button',
			{
				class: 'btn tp-toggle',
				type: 'button',
				id,
				'aria-pressed': String(prefs[key]),
				onclick: () => {
					prefs[key] = !prefs[key];
					savePrefs(prefs);
					el[key].setAttribute('aria-pressed', String(prefs[key]));
					applyPrefs();
					if (key === 'clickOnly') applyMix();
					renderToggles();
				},
			},
			iconEl(icon),
			label,
		);

	function buildShell() {
		el.status = h('p', { class: 'tab-note tp-status', id: 'tp-status', role: 'status' }, 'Loading the tab…');
		el.chips = h('div', { class: 'tp-chips', id: 'tp-chips', role: 'group', 'aria-label': 'Chunks' });
		el.tracks = h('div', { class: 'tp-tracks-wrap' });
		scoreEl = h('div', { class: 'tp-score', id: 'tp-score' });
		el.selLabel = h('p', { class: 'tp-sel-label', id: 'tp-sel-label', 'aria-live': 'polite' });
		el.selActions = h('div', { class: 'tp-sel-actions' });
		el.play = h('button', { class: 'btn btn-primary tp-play', type: 'button', id: 'tp-play', disabled: true, onclick: toggle });
		el.stop = h('button', { class: 'btn tp-stop', type: 'button', id: 'tp-stop', disabled: true, onclick: stop }, iconEl('stop'), 'Stop');
		el.slower = h('button', { class: 'btn btn-icon', type: 'button', id: 'tp-slower', 'aria-label': 'Slower (−5%)', title: 'Slower (−5%)', onclick: () => setSpeed(stepSpeed(prefs.speed, -1)) }, iconEl('minus'));
		el.faster = h('button', { class: 'btn btn-icon', type: 'button', id: 'tp-faster', 'aria-label': 'Faster (+5%)', title: 'Faster (+5%)', onclick: () => setSpeed(stepSpeed(prefs.speed, 1)) }, iconEl('plus'));
		el.speed = h('output', { class: 'tp-speed-val', id: 'tp-speed', 'aria-live': 'polite' });
		el.countIn = toggleBtn('tp-countin', 'countin', 'Count-in', 'countIn');
		el.metronome = toggleBtn('tp-metronome', 'metronome', 'Metronome', 'metronome');
		el.loop = toggleBtn('tp-loop', 'loop', 'Loop', 'loop');
		el.clickOnly = toggleBtn('tp-clickonly', 'clickOnly', 'Click only', 'clickOnly');
		// The record line: where the pedal records and what the attempt is for.
		el.pending = h('span', { class: 'tp-pending', id: 'tp-pending', hidden: true, role: 'img', 'aria-label': '✓ pending' });
		el.recLine = h('p', { class: 'tp-rec-line', id: 'tp-rec-line', 'aria-live': 'polite' });
		el.free = h(
			'button',
			{
				class: 'btn tp-free',
				type: 'button',
				id: 'tp-free',
				'aria-pressed': 'false',
				hidden: true,
				title: 'Free speed: set the speed by hand (attempts still record)',
				onclick: () => {
					freeSpeed = !freeSpeed;
					applyPrefs();
					renderSpeed();
					renderRec(true);
				},
			},
			iconEl('unlock'),
			'Free speed',
		);
		el.bar = h(
			'div',
			{ class: 'tp-bar' },
			h('div', { class: 'tp-sel' }, el.selLabel, el.selActions),
			h('div', { class: 'tp-rec', id: 'tp-rec' }, el.pending, el.recLine, el.free),
			h(
				'div',
				{ class: 'tp-transport' },
				h('div', { class: 'tp-main-ctl' }, el.stop, el.play),
				h('div', { class: 'tp-speed', role: 'group', 'aria-label': 'Speed' }, el.slower, el.speed, el.faster),
				h('div', { class: 'tp-toggles' }, el.countIn, el.metronome, el.loop, el.clickOnly),
			),
		);
		root.replaceChildren(h('div', { class: 'tp-top' }, el.chips, el.tracks), el.status, scoreEl, el.bar);
		renderPlay();
		renderSpeed();
		renderToggles();
		renderRec(true);
	}

	// Click only turns the metronome on: its toggle reads pressed (and waits).
	function renderToggles() {
		el.metronome.setAttribute('aria-pressed', String(prefs.metronome || prefs.clickOnly));
		el.metronome.disabled = prefs.clickOnly;
	}

	function setStatus(text, alert = false) {
		el.status.textContent = text;
		el.status.hidden = !text;
		if (alert) el.status.setAttribute('role', 'alert');
	}

	function renderPlay() {
		// The label says what a press does (no aria-pressed: "Pause" alone is read).
		// While the sound loads it is text only, so it fits at 360px.
		if (!ready) el.play.replaceChildren('Loading…');
		else el.play.replaceChildren(iconEl(playing ? 'pause' : 'play'), playing ? 'Pause' : 'Play');
		el.play.disabled = !ready;
		el.stop.disabled = !ready;
	}

	const tempoOf = (bar) => tempoAt(fileBars, bar) || score?.tempo || 120;
	const fileTempo = () => tempoOf(pos.cursor);
	const barTicks = (bar) => fileBars[bar - 1]?.ticks ?? 3840;

	// ---------- Recording: target, speed lock, record line ----------

	// The Song mode section matching the selection (-1: none).
	function lockable() {
		if (!score || !pos.sel || !opts.isSong?.()) return -1;
		return matchSection(p.metronomes, pos.sel);
	}

	// The speed lock: the selected Song chunk's practice BPM over the file
	// tempo at its first bar, unless Free speed is on.
	function lock() {
		const i = freeSpeed ? -1 : lockable();
		if (i < 0) return null;
		const m = p.metronomes[i];
		return { i, ...speedLock(m.startBPM, tempoOf(m.bars[0])) };
	}

	// Where playback is: { bar, offset (ticks into it) }.
	function at() {
		if (ready && playing) {
			const e = played.find((x) => lastTick >= x.start && lastTick < x.end);
			if (e) return { bar: e.index + 1, offset: lastTick - e.start };
		}
		const r = pos.sel?.range;
		return { bar: pos.cursor, offset: r && pos.cursor === r.start.bar ? r.start.tick : 0 };
	}

	// Where the pedal records now: { index, bpm } or null (no chunk).
	function target() {
		if (!score) return null;
		const i = pedalTarget(p.metronomes, pos.sel, at(), barTicks);
		if (i < 0) return null;
		const m = p.metronomes[i];
		const lk = lock();
		return { index: i, bpm: lk && lk.i === i ? lk.bpm : bpmAt(tempoOf(m.bars?.[0] ?? pos.cursor), prefs.speed) };
	}

	function renderRec(force = false) {
		const t = target();
		const key = t ? `${t.index}:${t.bpm}` : '';
		el.free.hidden = lockable() < 0;
		el.free.setAttribute('aria-pressed', String(freeSpeed));
		if (host) host.dataset.free = String(freeSpeed);
		if (!force && key === recKey) return;
		recKey = key;
		let text = 'Select a chunk to record';
		if (t) {
			const m = p.metronomes[t.index];
			text = `${shortName(m.name)} · ${opts.songLine?.(t.index, t.bpm) ?? 'pedal ✓ ✗ record here'}`;
		}
		el.recLine.textContent = text;
		el.recLine.title = text;
		if (host) host.dataset.target = t ? String(p.metronomes[t.index].id ?? t.index) : '';
	}

	function renderSpeed() {
		// "75% · 75 BPM" (the BPM part wraps under the % on narrow phones).
		// Locked to a Song chunk: its practice tempo, − / + off.
		const lk = lock();
		const [pct, bpm] = lk ? [`${lk.pct}%`, `${lk.bpm} BPM`] : speedLabel(prefs.speed, fileTempo()).split(' · ');
		el.speed.replaceChildren(h('span', {}, pct), h('span', { class: 'tp-bpm' }, h('span', { class: 'tp-dot' }, ' · '), bpm));
		el.speed.classList.toggle('is-locked', Boolean(lk));
		if (lk) el.speed.setAttribute('aria-label', `Speed locked to the chunk’s practice tempo, ${lk.bpm} BPM`);
		else el.speed.removeAttribute('aria-label');
		el.slower.disabled = Boolean(lk) || prefs.speed <= SPEED_MIN;
		el.faster.disabled = Boolean(lk) || prefs.speed >= SPEED_MAX;
	}

	function renderPos() {
		posEl.textContent = `${pos.cursor}/${total}`;
		posEl.setAttribute('aria-label', `Bar ${pos.cursor} of ${total}`);
	}

	function renderChips() {
		const chips = chunkChips(p.metronomes);
		el.chips.hidden = !chips.length;
		el.chips.replaceChildren(
			...chips.map((c) => {
				const sel = c.range ? { start: c.start, end: c.end, range: c.range } : { start: c.start, end: c.end };
				const on = sameSel(pos.sel, sel);
				return h(
					'button',
					{
						class: 'tp-chip',
						type: 'button',
						'aria-pressed': String(on),
						'data-bars': `${c.start}-${c.end}`,
						title: `${c.name} (${barRange(c.start, c.end)})`,
						onclick: () => {
							setPos(c.range ? { cursor: c.start, sel, anchor: null } : selectBars(c.start, c.end));
							scrollToBar(c.start);
						},
					},
					c.name,
				);
			}),
		);
	}

	function renderSelection() {
		const { sel, anchor } = pos;
		const actions = [];
		if (sel) {
			const i = matchSection(p.metronomes, sel);
			const m = p.metronomes[i];
			el.selLabel.replaceChildren(h('b', {}, selectionLabel(sel)), m ? ` · ${shortName(m.name)}` : '');
			if (m) {
				actions.push(
					h('button', { class: 'btn', type: 'button', id: 'tp-practice', onclick: () => practice(i) }, iconEl('metronome'), (m.kind ?? 'chunk') === 'run' ? 'Practice the full run' : 'Practice this chunk'),
				);
			} else {
				actions.push(h('button', { class: 'btn', type: 'button', id: 'tp-add', onclick: addChunk }, iconEl('plus'), 'Add as a new chunk'));
			}
			actions.push(h('button', { class: 'btn btn-quiet', type: 'button', id: 'tp-clear', onclick: () => setPos(clearSelection(pos)) }, iconEl('cross'), 'Clear'));
		} else if (pos.anchorBeat) {
			el.selLabel.replaceChildren(h('b', {}, `Bar ${pos.anchorBeat.bar} beat ${pos.anchorBeat.beat}`), ' · Pending start · tap the beat where it ends');
		} else if (anchor !== null) {
			el.selLabel.replaceChildren(h('b', {}, `Bar ${anchor}`), ' · Pending start · tap a bar or a beat, or press ] to select up to it');
		} else {
			el.selLabel.replaceChildren('Tap a beat, then another, to select and loop · tap above the staff for whole bars');
		}
		el.selActions.replaceChildren(...actions);
		renderChips();
		showSelectedChip();
	}

	// Keep the selected chip visible in its scrolling row.
	function showSelectedChip() {
		const chip = el.chips.querySelector('.tp-chip[aria-pressed="true"]');
		if (!chip || el.chips.hidden) return;
		const row = el.chips;
		const left = chip.offsetLeft - row.offsetLeft;
		const right = left + chip.offsetWidth;
		if (left < row.scrollLeft || right > row.scrollLeft + row.clientWidth) row.scrollLeft = Math.max(0, left - 16);
	}

	function renderTracks() {
		const list = trackList(score); // clean names (alphaTab keeps no-break spaces)
		if (list.length < 2) return el.tracks.replaceChildren();
		const select = h(
			'select',
			{
				id: 'tp-track',
				'aria-label': 'Show track',
				onchange: (e) => {
					e.target.blur(); // Space / the pedal's Enter play again, not reopen the list
					showTrack(Number(e.target.value));
				},
			},
			list.map((t, i) => h('option', { value: String(i), selected: i === track }, t.name)),
		);
		const row = (t, i) => {
			const btn = (kind, set, label) =>
				h(
					'button',
					{
						class: `btn tp-${kind}`,
						type: 'button',
						'aria-pressed': String(set.has(i)),
						'aria-label': `${label} ${t.name}`,
						onclick: (e) => {
							if (set.has(i)) set.delete(i);
							else set.add(i);
							e.currentTarget.setAttribute('aria-pressed', String(set.has(i)));
							applyMix();
						},
					},
					label,
				);
			return h('li', { class: 'tp-track-row' }, h('span', { class: 'tp-track-name' }, t.name), btn('mute', mute, 'Mute'), btn('solo', solo, 'Solo'));
		};
		el.tracks.replaceChildren(
			h(
				'details',
				{ class: 'tp-tracks', id: 'tp-tracks' },
				h('summary', { id: 'tp-tracks-summary' }, iconEl('layers'), `Tracks · ${list.length}`),
				h('label', { class: 'tp-show' }, 'Show', select),
				h('ul', { class: 'tp-track-list' }, list.map(row)),
			),
		);
	}

	// ---------- Selection marks (drawn over alphaTab's surface) ----------

	function surface() {
		return host?.querySelector('.at-surface') ?? null;
	}

	// Beat bounds after each render (the shown track's beats, any staff).
	function indexBeats() {
		beatBounds = new Map();
		for (const sys of api?.renderer?.boundsLookup?.staffSystems ?? []) {
			for (const mb of sys.bars ?? []) for (const bb of mb.bars ?? []) for (const b of bb.beats ?? []) if (!beatBounds.has(b.beat)) beatBounds.set(b.beat, b);
		}
	}

	// The staff lines' top and bottom of a master bar (surface coordinates).
	function staffBox(mb) {
		const list = mb.bars ?? [];
		if (!list.length) return { top: mb.visualBounds.y, bottom: mb.visualBounds.y + mb.visualBounds.h };
		const top = Math.min(...list.map((b) => b.realBounds.y));
		const bottom = Math.max(...list.map((b) => b.realBounds.y + b.realBounds.h));
		return { top, bottom };
	}

	// A beat's slot [x0, x1] in its bar: the first beat starts at the bar's
	// start and the last ends at its end, so whole bars look whole.
	function beatSlot(pt) {
		const look = api?.renderer?.boundsLookup;
		const mb = look?.findMasterBarByIndex(pt.bar - 1);
		const bb = beatBounds.get(pt.beatRef);
		if (!mb || !bb) return null;
		const inBar = beats.filter((x) => x.bar === pt.bar);
		const r = mb.realBounds;
		const x0 = inBar[0] === pt ? r.x : bb.realBounds.x;
		const x1 = inBar[inBar.length - 1] === pt ? r.x + r.w : bb.realBounds.x + bb.realBounds.w;
		return { x0, x1, mb };
	}

	function drawMarks() {
		const look = api?.renderer?.boundsLookup;
		const surf = surface();
		if (!marks || !look || !surf) return;
		marks.style.left = `${surf.offsetLeft}px`;
		marks.style.top = `${surf.offsetTop}px`;
		const boxes = [];
		const add = (mb, x0, x1, cls) => boxes.push(h('div', { class: cls, style: `left:${x0}px;top:${mb.visualBounds.y}px;width:${Math.max(2, x1 - x0)}px;height:${mb.visualBounds.h}px` }));
		const box = (bar, cls) => {
			const b = look.findMasterBarByIndex(bar - 1);
			if (b) add(b, b.realBounds.x, b.realBounds.x + b.realBounds.w, cls);
		};
		let ends = null;
		if (pos.sel?.range) {
			// Beat-exact: from the start beat's slot to the end beat's slot.
			const { a, z } = selPoints(pos.sel, beats) ?? {};
			const sa = a && beatSlot(a);
			const sz = z && beatSlot(z);
			for (let bar = pos.sel.start; bar <= pos.sel.end; bar++) {
				const b = look.findMasterBarByIndex(bar - 1);
				if (!b) continue;
				const x0 = bar === pos.sel.start && sa ? sa.x0 : b.realBounds.x;
				const x1 = bar === pos.sel.end && sz ? sz.x1 : b.realBounds.x + b.realBounds.w;
				add(b, x0, x1, 'tp-mark-sel');
			}
			if (sa && sz) ends = { a: { x: sa.x0, ...staffBox(sa.mb) }, z: { x: sz.x1, ...staffBox(sz.mb) } };
		} else if (pos.sel) for (let bar = pos.sel.start; bar <= pos.sel.end; bar++) box(bar, 'tp-mark-sel');
		else if (pos.anchorBeat) {
			const sl = beatSlot(pos.anchorBeat);
			if (sl) add(sl.mb, sl.x0, sl.x1, 'tp-mark-anchor');
		} else if (pos.anchor !== null) box(pos.anchor, 'tp-mark-anchor');
		boxLayer.replaceChildren(...boxes);
		// Handles: 44px targets at both ends, under the staff lines.
		for (const [k, e] of [['start', ends?.a], ['end', ends?.z]]) {
			const el = handles[k];
			el.hidden = !e;
			if (e) {
				el.style.left = `${e.x - 22}px`;
				el.style.top = `${e.bottom - 12}px`;
				el.style.setProperty('--stem', `${e.bottom - e.top}px`);
			}
		}
		host.dataset.sel = pos.sel ? `${pos.sel.start}-${pos.sel.end}` : '';
		const r = pos.sel?.range;
		host.dataset.beats = r ? `${r.start.bar}.${r.start.beat}-${r.end.bar}.${r.end.beat}` : pos.anchorBeat ? `${pos.anchorBeat.bar}.${pos.anchorBeat.beat}` : '';
	}

	// What is under a point (client coordinates): { bar, zone, point }:
	// zone 'number' = the band above the bar's staff lines (its number and
	// markers: bar-level taps), else 'beat'; point = the nearest beat of that
	// bar. nearest: a point outside every line counts for the closest line
	// (handle drags).
	function hitAt(clientX, clientY, { nearest = false } = {}) {
		const look = api?.renderer?.boundsLookup;
		const surf = surface();
		if (!look || !surf) return null;
		const r = surf.getBoundingClientRect();
		const x = clientX - r.left;
		const y = clientY - r.top;
		const systems = look.staffSystems ?? [];
		let sys = systems.find((s) => y >= s.realBounds.y && y <= s.realBounds.y + s.realBounds.h);
		if (!sys && nearest && systems.length) {
			const dist = (s) => Math.min(Math.abs(y - s.realBounds.y), Math.abs(y - s.realBounds.y - s.realBounds.h));
			sys = systems.reduce((a, b) => (dist(b) < dist(a) ? b : a));
		}
		if (!sys?.bars?.length) return null;
		let mb = sys.bars.find((b) => x >= b.realBounds.x && x <= b.realBounds.x + b.realBounds.w);
		if (!mb && nearest) mb = x < sys.bars[0].realBounds.x ? sys.bars[0] : sys.bars[sys.bars.length - 1];
		if (!mb) return null;
		const bar = mb.index + 1;
		const zone = y < staffBox(mb).top ? 'number' : 'beat';
		let point = null;
		let best = Infinity;
		for (const pt of beats) {
			if (pt.bar !== bar) continue;
			const bb = beatBounds.get(pt.beatRef);
			if (!bb) continue;
			const d = Math.abs((bb.onNotesX ?? bb.visualBounds.x + bb.visualBounds.w / 2) - x);
			if (d < best) {
				best = d;
				point = pt;
			}
		}
		return { bar, zone, point };
	}

	// The bar under a point (client coordinates), or null.
	function barAt(clientX, clientY) {
		return hitAt(clientX, clientY)?.bar ?? null;
	}

	// Drag a handle: that end follows the nearest beat; released = applied.
	function makeHandle(which) {
		const el = h('div', { class: `tp-handle tp-handle-${which}`, id: `tp-handle-${which}`, hidden: true, title: which === 'start' ? 'Drag to move the start' : 'Drag to move the end' });
		let active = null;
		let from = null; // the position when the drag began
		el.addEventListener('pointerdown', (e) => {
			from = pos;
			e.stopPropagation();
			e.preventDefault();
			el.setPointerCapture(e.pointerId);
			active = e.pointerId;
			hold = null;
			el.classList.add('is-dragging');
		});
		el.addEventListener('pointermove', (e) => {
			if (active !== e.pointerId) return;
			const hit = hitAt(e.clientX, e.clientY, { nearest: true });
			if (!hit?.point) return;
			const next = moveEnd(pos, which, hit.point, beats);
			if (sameSel(next.sel, pos.sel)) return;
			pos = next; // drawn now, applied (range, seek, lock) on release
			drawMarks();
			renderSelection();
		});
		const end = (e) => {
			if (active !== e.pointerId) return;
			active = null;
			el.classList.remove('is-dragging');
			const kept = pos;
			pos = from ?? pos; // so setPos sees the change and applies it
			setPos(kept);
			host._dragged = true; // the click that follows is not a tap
			setTimeout(() => (host._dragged = false), 0);
		};
		el.addEventListener('pointerup', end);
		el.addEventListener('pointercancel', end);
		el.addEventListener('click', (e) => e.stopPropagation());
		return el;
	}

	// ---------- Position, range and seeking ----------

	// Bring a bar into view in the score (we scroll ourselves: alphaTab's
	// scrollToCursor would still use the cursor from before the seek).
	function scrollToBar(bar) {
		const b = api?.renderer?.boundsLookup?.findMasterBarByIndex(bar - 1);
		const surf = surface();
		if (!b || !surf) return;
		const top = surf.getBoundingClientRect().top - scoreEl.getBoundingClientRect().top + scoreEl.scrollTop + b.visualBounds.y;
		const bottom = top + b.visualBounds.h;
		const view = scoreEl.scrollTop;
		if (top >= view && bottom <= view + scoreEl.clientHeight) return;
		scoreEl.scrollTo({ top: Math.max(0, top - 24), behavior: 'auto' });
	}

	function setPos(next, { seek = true } = {}) {
		hold = null; // the user moved: stop holding the opening view
		movedTo = true;
		const selChanged = !sameSel(next.sel, pos.sel);
		pos = next;
		if (selChanged) {
			applyRange();
			applyPrefs(); // the speed lock follows the selection
		}
		if (seek) seekTo(pos.cursor);
		renderPos();
		renderSpeed();
		renderSelection();
		renderRec();
		drawMarks();
	}

	function seekTo(bar) {
		if (!ready) return;
		// A beat-level selection starts mid-bar.
		const t = pos.sel?.range && bar === pos.sel.start ? (selectionTicks(played, pos.sel)?.startTick ?? null) : barStartTick(played, bar);
		if (t !== null) api.tickPosition = t;
	}

	function applyRange() {
		if (!api || !ready) return;
		const r = selectionTicks(played, pos.sel);
		api.playbackRange = r; // moves playback to its start
		api.isLooping = prefs.loop;
		host.dataset.range = r ? `${r.startTick}-${r.endTick}` : '';
	}

	// Speed (locked or the user's), count-in, metronome, loop. Speed changes
	// apply live, without restarting playback.
	function applyPrefs() {
		if (!api) return;
		const lk = lock();
		api.playbackSpeed = lk ? lk.ratio : prefs.speed / 100;
		api.countInVolume = prefs.countIn ? 1 : 0;
		api.metronomeVolume = prefs.metronome || prefs.clickOnly ? 1 : 0;
		api.isLooping = prefs.loop;
		host.dataset.speed = String(lk ? lk.pct : prefs.speed);
		host.dataset.playbackSpeed = String(api.playbackSpeed);
		host.dataset.lock = lk ? String(lk.bpm) : '';
		host.dataset.loop = String(prefs.loop);
		host.dataset.metronome = String(api.metronomeVolume);
	}

	// Mute / Solo as chosen; Click only mutes every track (the metronome stays).
	function applyMix() {
		if (!api || !score) return;
		score.tracks.forEach((t, i) => {
			api.changeTrackMute([t], prefs.clickOnly || mute.has(i));
			api.changeTrackSolo([t], !prefs.clickOnly && solo.has(i));
		});
		host.dataset.mute = prefs.clickOnly ? score.tracks.map((_, i) => i).join(',') : [...mute].sort().join(',');
		host.dataset.solo = prefs.clickOnly ? '' : [...solo].sort().join(',');
		host.dataset.clickOnly = String(prefs.clickOnly);
	}

	function setSpeed(pct) {
		prefs.speed = clampSpeed(pct);
		savePrefs(prefs);
		applyPrefs();
		renderSpeed();
		renderRec(); // the next attempt's tempo (warm-up or daily check)
	}

	// ---------- Transport ----------

	function toggle() {
		if (!ready || !api) return;
		if (playing) return api.pause();
		hold = null;
		opts.beforePlay?.();
		// Outside the selection: start at its first bar.
		if (pos.sel && (pos.cursor < pos.sel.start || pos.cursor > pos.sel.end)) setPos({ ...pos, cursor: pos.sel.start });
		playedFrom = pos.cursor;
		api.play();
	}

	function stop() {
		if (!api || !ready) return;
		api.stop();
		setPos({ ...pos, cursor: stopBar(pos, playedFrom), anchor: null });
		scrollToBar(pos.cursor);
	}

	// Shift+← / Shift+→: the selection's end, one beat.
	function stepEndBy(delta) {
		const next = stepEnd(pos, delta, beats);
		if (next === pos) return;
		setPos(next);
		scrollToBar(next.sel?.end ?? next.cursor);
	}

	function move(delta) {
		setPos(moveCursor(pos, delta, total));
		scrollToBar(pos.cursor);
	}

	function practice(index) {
		api?.stop();
		opts.practice(index);
	}

	function addChunk() {
		const sel = pos.sel;
		if (!sel) return;
		opts.confirm({
			title: 'Add a new chunk?',
			text: `Adds “Chunk · ${sel.range ? rangeText(sel.range) : barRange(sel.start, sel.end)}” to “${p.name}” as a Song mode chunk you can practise.`,
			confirm: 'Add chunk',
			danger: false,
			onConfirm: () => {
				const section = newChunkSection(p.metronomes, sel, { bars: fileBars, makeId: opts.makeId });
				opts.insertSection(section, insertIndex(p.metronomes, sel.start));
				if (!api) return;
				// The selection now matches the new chunk: Practice, its chip, the lock.
				renderSelection();
				applyPrefs();
				renderSpeed();
				renderRec(true);
			},
		});
	}

	// ---------- alphaTab ----------

	function showTrack(t) {
		track = t;
		beats = beatPoints(score, t);
		api.settings.display.staveProfile = profileFor(score, t);
		api.updateSettings();
		api.renderScore(score, [t]);
	}

	function mountScore(my) {
		host = h('div', { class: 'tp-host' });
		boxLayer = h('div', { class: 'tp-boxes' });
		handles.start = makeHandle('start');
		handles.end = makeHandle('end');
		marks = h('div', { class: 'tp-marks', 'aria-hidden': 'true' }, boxLayer, handles.start, handles.end);
		scoreEl.replaceChildren(host);
		const narrow = matchMedia('(max-width: 560px)').matches;
		const s = makeSettings(narrow ? 0.9 : 1.05);
		s.core.enableLazyLoading = true; // long pieces: draw what's on screen
		s.display.padding = narrow ? [12, 8] : [24, 16];
		s.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
		s.player.soundFont = null; // given as bytes below (shared with Hear it)
		s.player.enableCursor = true;
		s.player.enableAnimatedBeatCursor = true;
		s.player.enableElementHighlighting = true;
		s.player.enableSeekToClick = false; // taps are ours (tapBar)
		s.player.enablePlaybackRangeSelection = false;
		s.player.scrollMode = alphaTab.ScrollMode.Continuous;
		s.player.scrollElement = scoreEl;
		s.player.scrollOffsetY = -24;
		if (reduceMotion()) s.player.scrollSpeed = 0; // jump, don't glide
		host.dataset.scrollSpeed = String(s.player.scrollSpeed); // read by the harness
		s.display.staveProfile = profileFor(score, track);
		api = new alphaTab.AlphaTabApi(host, s);
		host.append(marks);
		
		// Test hooks (harness): a beat's slot / the bar-number band, client coordinates.
		host.tpBeatBox = (bar, beat) => {
			const pt = beats.find((x) => x.bar === bar && x.beat === beat);
			const bb = pt && beatBounds.get(pt.beatRef);
			const mb = api?.renderer?.boundsLookup?.findMasterBarByIndex(bar - 1);
			const r = surface()?.getBoundingClientRect();
			if (!bb || !mb || !r) return null;
			const st = staffBox(mb);
			return { x: r.left + (bb.onNotesX ?? bb.visualBounds.x), y: r.top + st.top, h: st.bottom - st.top, tick: pt.tick, end: pt.end };
		};
		host.tpBarNumberBox = (bar) => {
			const mb = api?.renderer?.boundsLookup?.findMasterBarByIndex(bar - 1);
			const r = surface()?.getBoundingClientRect();
			if (!mb || !r) return null;
			return { x: r.left + mb.realBounds.x, y: r.top + mb.realBounds.y, w: mb.realBounds.w, h: staffBox(mb).top - mb.realBounds.y };
		};
		// Test hook (harness): a bar's box in client coordinates.
		host.tpBarBox = (bar) => {
			const b = api?.renderer?.boundsLookup?.findMasterBarByIndex(bar - 1);
			const r = surface()?.getBoundingClientRect();
			return b && r ? { x: r.left + b.realBounds.x, y: r.top + b.visualBounds.y, w: b.realBounds.w, h: b.visualBounds.h } : null;
		};

		// Following playback is ours: alphaTab's own handler also scrolls to
		// its cursor after renders and pauses (bar 1 before the first seek),
		// which pulled a section opened far down back to the top. This one scrolls
		// (like ScrollMode.Continuous: when the cursor's system changes) only
		// while playing; seeks scroll through scrollToBar().
		let lastY = null;
		const scrollTo = (bb, force) => {
			const y = bb.barBounds.masterBarBounds.realBounds.y;
			if (!force && y === lastY) return;
			lastY = y;
			const ui = api.uiFacade;
			const scroll = ui.getScrollContainer();
			ui.scrollToY(scroll, ui.getOffset(scroll, api.container).y + y + s.player.scrollOffsetY, s.player.scrollSpeed);
		};
		api.customScrollHandler = {
			[Symbol.dispose]() {},
			// alphaTab calls this when playback pauses (scrollToCursor). It also
			// fires as the player gets ready, before our seek, with the cursor
			// still on bar 1: ignored until our ready handler has run, and
			// whenever we aren't playing (our seeks scroll by themselves).
			forceScrollTo: (bb) => {
				if (readyDone && playing) scrollTo(bb, true);
			},
			onBeatCursorUpdating: (bb) => {
				if (playing) scrollTo(bb, false);
				else lastY = null;
			},
		};

		// Opened from a section: show its bars once drawn, and again once the
		// player is ready (in case a render moved things). Any move by the
		// user (setPos), Play or a hand scroll ends this.
		hold = pos.sel ? pos.sel.start : null;
		const settle = () =>
			requestAnimationFrame(() => {
				if (my !== token || hold === null) return;
				scrollToBar(hold);
				showSelectedChip();
			});
		// A hand scroll: leave the view where the user put it.
		const release = () => {
			hold = null;
			movedTo = false;
		};
		scoreEl.addEventListener('wheel', release, { passive: true });
		scoreEl.addEventListener('touchstart', release, { passive: true });
		api.renderFinished.on(() => {
			if (my !== token) return;
			setStatus('');
			host.dataset.rendered = 'true';
			indexBeats();
			drawMarks();
			renderRec(true);
			if (hold !== null) settle();
		});
		api.error.on((e) => {
			if (my !== token) return;
			if (!host.dataset.rendered) setStatus(`Couldn’t draw this tab: ${e?.message || e}`, true);
			else if (!ready) setStatus('The sound couldn’t be loaded. Check your connection.', true);
		});
		api.playerReady.on(() => {
			if (my !== token) return;
			played = playedBars(api.tickCache);
			ready = true;
			host.dataset.ready = 'true';
			applyPrefs();
			applyMix();
			applyRange();
			seekTo(pos.cursor);
			renderPlay();
			// After the seek: show the cursor's bar if the user moved to one
			// while loading (chip, tap, arrow) or the opening section is held;
			// not after a hand scroll.
			if (hold !== null || movedTo) {
				const bar = pos.cursor;
				requestAnimationFrame(() => {
					if (my !== token || !(hold !== null || movedTo)) return;
					scrollToBar(bar);
					showSelectedChip();
				});
			}
			readyDone = true;
		});
		api.playerStateChanged.on((e) => {
			if (my !== token) return;
			playing = e.state === PLAYING;
			host.dataset.synth = playing ? 'playing' : 'stopped'; // read by the harness
			if (playing) host.dataset.everPlayed = 'true';
			renderPlay();
		});
		api.playerPositionChanged.on((e) => {
			if (my !== token) return;
			host.dataset.tick = String(e.currentTick);
			lastTick = e.currentTick;
			if (!playing) return;
			const bar = barAtTick(played, e.currentTick);
			if (bar !== pos.cursor) {
				pos = { ...pos, cursor: bar };
				renderPos();
				renderSpeed();
			}
			renderRec(); // the chunk under the cursor (re-drawn only when it changes)
		});
		api.playerFinished.on(() => {
			if (my !== token || prefs.loop) return;
			setPos({ ...pos, cursor: stopBar(pos, playedFrom) });
		});

		// Taps pick beats (the band above the staff lines: bars); mouse drags
		// select beat to beat (or bar to bar from the band). A touch drag is a
		// scroll, never a selection.
		let down = null;
		host.addEventListener('pointerdown', (e) => {
			down = e.pointerType === 'mouse' && e.button === 0 ? hitAt(e.clientX, e.clientY) : null;
		});
		host.addEventListener('pointerup', (e) => {
			if (!down || e.pointerType !== 'mouse') return;
			const to = hitAt(e.clientX, e.clientY);
			const from = down;
			down = null;
			if (!to) return;
			if (from.zone === 'number' || to.zone === 'number' || !from.point || !to.point) {
				if (to.bar === from.bar) return;
				setPos(dragBars(pos, from.bar, to.bar));
			} else {
				if (from.point === to.point) return;
				setPos(dragBeats(pos, from.point, to.point, beats));
			}
			host._dragged = true;
		});
		host.addEventListener('click', (e) => {
			if (host._dragged) {
				host._dragged = false;
				return;
			}
			const hit = hitAt(e.clientX, e.clientY);
			if (!hit) return;
			if (hit.zone === 'number' || !hit.point) setPos(tapBar(pos, hit.bar));
			else setPos(tapBeat(pos, hit.point, beats));
		});

		api.renderScore(score, [track]);
		applyPrefs();
		soundFontBytes().then(
			(bytes) => {
				if (my !== token) return;
				if (!api.loadSoundFont(bytes)) setStatus('The sound couldn’t be loaded.', true);
			},
			() => my === token && setStatus('The sound couldn’t be loaded. Check your connection.', true),
		);
	}

	function showMissing() {
		root.replaceChildren(
			h(
				'div',
				{ class: 'tab-missing tp-missing' },
				h('p', {}, 'Tab file not on this device'),
				h('button', { class: 'btn', type: 'button', id: 'tp-reattach', onclick: () => opts.pickFile() }, iconEl('importFile'), 'Import again'),
			),
		);
	}

	async function load() {
		const my = ++token;
		ready = false;
		readyDone = false;
		movedTo = false;
		playing = false;
		api?.destroy();
		api = null;
		buildShell();
		let src;
		try {
			src = await opts.source();
		} catch (e) {
			if (my === token) setStatus(e.message || 'The tab couldn’t be loaded', true);
			return;
		}
		if (my !== token) return;
		if (!src) return showMissing();
		if (src.format !== 'score') return setStatus('Text tabs have no rhythm, so there’s nothing to play.');
		score = parseScore(src.data); // its own copy: the player's Tab view may hold the cached one
		track = src.track ?? 0;
		fileBars = sourceBars(src, track);
		beats = beatPoints(score, track);
		total = score.masterBars.length;
		const [a, b] = opts.initial?.bars ?? [];
		const r = opts.initial?.range;
		pos = !(a >= 1 && b >= a && b <= total) ? position(1) : r ? { cursor: a, sel: { start: a, end: b, range: { start: { ...r.start }, end: { ...r.end } } }, anchor: null } : selectBars(a, b);
		renderTracks();
		renderPos();
		renderSpeed();
		renderSelection();
		renderRec(true);
		setStatus('Drawing the tab…');
		try {
			mountScore(my);
		} catch (e) {
			setStatus(`Couldn’t draw this tab: ${e.message || e}`, true);
		}
	}

	load();

	return {
		// Keys while the Tab player is open (main.js routes them here).
		keydown(e) {
			const t = e.target;
			const field = Boolean(t?.closest?.('input, select, textarea, [contenteditable=""], [contenteditable="true"]'));
			const control = Boolean(t?.closest?.('button, summary, a[href], [role=button], [role=switch]'));
			const action = keyAction({ key: e.key, field, control, repeat: e.repeat, meta: e.metaKey || e.ctrlKey || e.altKey, shift: e.shiftKey });
			if (!action) {
				if ((e.key === ' ' || e.key === 'Enter') && !field && !control) e.preventDefault(); // held pedal / Space: no scroll
				return null;
			}
			e.preventDefault();
			if (action === 'toggle') toggle();
			else if (action === 'prev') move(-1);
			else if (action === 'next') move(1);
			else if (action === 'endPrev') stepEndBy(-1);
			else if (action === 'endNext') stepEndBy(1);
			else if (action === 'loopStart') setPos(setLoopStart(pos));
			else if (action === 'loopEnd') setPos(setLoopEnd(pos));
			return action;
		},
		reload: load,
		get playing() {
			return playing;
		},
		// Where the pedal records right now (captured at press time).
		target,
		// After a record, an undo or a tempo change: the lock follows the
		// chunk's new tempo live (no restart), and the record line updates.
		refresh() {
			if (!score) return;
			applyPrefs();
			renderSpeed();
			renderRec(true);
		},
		pending(on) {
			if (el.pending) el.pending.hidden = !on;
		},
		// Exit: stop everything and free alphaTab; nothing plays afterwards.
		destroy() {
			token++;
			try {
				api?.stop();
			} finally {
				api?.destroy();
				api = null;
				root.replaceChildren();
				posEl.textContent = '';
			}
		},
	};
}

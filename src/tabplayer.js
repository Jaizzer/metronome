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
import { playedBars, trackList } from './tabscore.js';
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
	SPEED_MIN,
	SPEED_MAX,
} from './tabplayerlogic.js';

const PREFS_KEY = 'metronome:tabplayer';
const PLAYING = 1; // alphaTab.synth.PlayerState.Playing
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadPrefs() {
	try {
		const v = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
		return { speed: clampSpeed(v.speed ?? 100), countIn: Boolean(v.countIn), metronome: Boolean(v.metronome), loop: v.loop !== false };
	} catch {
		return { speed: 100, countIn: false, metronome: false, loop: true };
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
//   initialBars: [start, end] to select on open (the player's section) or null,
//   toast, confirm, pickFile(), beforePlay(), practice(sectionIndex),
//   makeId(), insertSection(section, index) (adds it to the routine and saves)
// }
export function createTabPlayer(opts) {
	const { p, root, posEl } = opts;
	const prefs = loadPrefs();
	let token = 0; // bumped by destroy(): every await checks it
	let api = null;
	let host = null;
	let scoreEl = null;
	let marks = null;
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
		el.bar = h(
			'div',
			{ class: 'tp-bar' },
			h('div', { class: 'tp-sel' }, el.selLabel, el.selActions),
			h(
				'div',
				{ class: 'tp-transport' },
				h('div', { class: 'tp-main-ctl' }, el.stop, el.play),
				h('div', { class: 'tp-speed', role: 'group', 'aria-label': 'Speed' }, el.slower, el.speed, el.faster),
				h('div', { class: 'tp-toggles' }, el.countIn, el.metronome, el.loop),
			),
		);
		root.replaceChildren(h('div', { class: 'tp-top' }, el.chips, el.tracks), el.status, scoreEl, el.bar);
		renderPlay();
		renderSpeed();
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

	const fileTempo = () => tempoAt(fileBars, pos.cursor) || score?.tempo || 120;

	function renderSpeed() {
		// "75% · 75 BPM" (the BPM part wraps under the % on narrow phones).
		const [pct, bpm] = speedLabel(prefs.speed, fileTempo()).split(' · ');
		el.speed.replaceChildren(h('span', {}, pct), h('span', { class: 'tp-bpm' }, h('span', { class: 'tp-dot' }, ' · '), bpm));
		el.slower.disabled = prefs.speed <= SPEED_MIN;
		el.faster.disabled = prefs.speed >= SPEED_MAX;
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
				const on = pos.sel?.start === c.start && pos.sel?.end === c.end;
				return h(
					'button',
					{
						class: 'tp-chip',
						type: 'button',
						'aria-pressed': String(on),
						'data-bars': `${c.start}-${c.end}`,
						title: `${c.name} (${barRange(c.start, c.end)})`,
						onclick: () => {
							setPos(selectBars(c.start, c.end));
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
		} else if (anchor !== null) {
			el.selLabel.replaceChildren(h('b', {}, `Bar ${anchor}`), ' · Pending start · tap a bar or press ] to select up to it');
		} else {
			el.selLabel.replaceChildren('Tap a bar to start there · tap two to select and loop them');
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

	function drawMarks() {
		const look = api?.renderer?.boundsLookup;
		const surf = surface();
		if (!marks || !look || !surf) return;
		marks.style.left = `${surf.offsetLeft}px`;
		marks.style.top = `${surf.offsetTop}px`;
		const boxes = [];
		const box = (bar, cls) => {
			const b = look.findMasterBarByIndex(bar - 1);
			if (!b) return;
			const r = b.realBounds;
			const v = b.visualBounds;
			boxes.push(h('div', { class: cls, style: `left:${r.x}px;top:${v.y}px;width:${r.w}px;height:${v.h}px` }));
		};
		if (pos.sel) for (let bar = pos.sel.start; bar <= pos.sel.end; bar++) box(bar, 'tp-mark-sel');
		else if (pos.anchor !== null) box(pos.anchor, 'tp-mark-anchor');
		marks.replaceChildren(...boxes);
		host.dataset.sel = pos.sel ? `${pos.sel.start}-${pos.sel.end}` : '';
	}

	// The bar under a point (client coordinates), or null.
	function barAt(clientX, clientY) {
		const look = api?.renderer?.boundsLookup;
		const surf = surface();
		if (!look || !surf) return null;
		const r = surf.getBoundingClientRect();
		const x = clientX - r.left;
		const y = clientY - r.top;
		for (const sys of look.staffSystems ?? []) {
			const sb = sys.realBounds;
			if (y < sb.y || y > sb.y + sb.h) continue;
			for (const b of sys.bars ?? []) {
				const bb = b.realBounds;
				if (x >= bb.x && x <= bb.x + bb.w) return b.index + 1;
			}
		}
		return null;
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
		const selChanged = next.sel?.start !== pos.sel?.start || next.sel?.end !== pos.sel?.end;
		pos = next;
		if (selChanged) applyRange();
		if (seek) seekTo(pos.cursor);
		renderPos();
		renderSpeed();
		renderSelection();
		drawMarks();
	}

	function seekTo(bar) {
		if (!ready) return;
		const t = barStartTick(played, bar);
		if (t !== null) api.tickPosition = t;
	}

	function applyRange() {
		if (!api || !ready) return;
		const r = selectionTicks(played, pos.sel);
		api.playbackRange = r; // moves playback to its start
		api.isLooping = prefs.loop;
		host.dataset.range = r ? `${r.startTick}-${r.endTick}` : '';
	}

	function applyPrefs() {
		if (!api) return;
		api.playbackSpeed = prefs.speed / 100;
		api.countInVolume = prefs.countIn ? 1 : 0;
		api.metronomeVolume = prefs.metronome ? 1 : 0;
		api.isLooping = prefs.loop;
		host.dataset.speed = String(prefs.speed);
		host.dataset.loop = String(prefs.loop);
	}

	function applyMix() {
		if (!api || !score) return;
		score.tracks.forEach((t, i) => {
			api.changeTrackMute([t], mute.has(i));
			api.changeTrackSolo([t], solo.has(i));
		});
		host.dataset.mute = [...mute].sort().join(',');
		host.dataset.solo = [...solo].sort().join(',');
	}

	function setSpeed(pct) {
		prefs.speed = clampSpeed(pct);
		savePrefs(prefs);
		applyPrefs();
		renderSpeed();
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
			text: `Adds “Chunk · ${barRange(sel.start, sel.end)}” to “${p.name}” as a Song mode chunk you can practise.`,
			confirm: 'Add chunk',
			danger: false,
			onConfirm: () => {
				const section = newChunkSection(p.metronomes, sel, { bars: fileBars, makeId: opts.makeId });
				opts.insertSection(section, insertIndex(p.metronomes, sel.start));
				if (api) renderSelection();
			},
		});
	}

	// ---------- alphaTab ----------

	function showTrack(t) {
		track = t;
		api.settings.display.staveProfile = profileFor(score, t);
		api.updateSettings();
		api.renderScore(score, [t]);
	}

	function mountScore(my) {
		host = h('div', { class: 'tp-host' });
		marks = h('div', { class: 'tp-marks', 'aria-hidden': 'true' });
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
			// alphaTab calls this when playback pauses (scrollToCursor), also once
			// as the player gets ready, with the cursor still on bar 1.
			forceScrollTo: (bb) => {
				if (hold === null) scrollTo(bb, true);
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
		const release = () => (hold = null);
		scoreEl.addEventListener('wheel', release, { passive: true });
		scoreEl.addEventListener('touchstart', release, { passive: true });
		api.renderFinished.on(() => {
			if (my !== token) return;
			setStatus('');
			host.dataset.rendered = 'true';
			drawMarks();
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
			if (hold !== null) settle();
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
			if (!playing) return;
			const bar = barAtTick(played, e.currentTick);
			if (bar !== pos.cursor) {
				pos = { ...pos, cursor: bar };
				renderPos();
				renderSpeed();
			}
		});
		api.playerFinished.on(() => {
			if (my !== token || prefs.loop) return;
			setPos({ ...pos, cursor: stopBar(pos, playedFrom) });
		});

		// Taps and mouse drags pick bars. A touch drag is a scroll, never a selection.
		let down = null;
		host.addEventListener('pointerdown', (e) => {
			down = e.pointerType === 'mouse' && e.button === 0 ? barAt(e.clientX, e.clientY) : null;
		});
		host.addEventListener('pointerup', (e) => {
			if (down === null || e.pointerType !== 'mouse') return;
			const to = barAt(e.clientX, e.clientY);
			if (to !== null && to !== down) {
				setPos(dragBars(pos, down, to));
				host._dragged = true;
			}
			down = null;
		});
		host.addEventListener('click', (e) => {
			if (host._dragged) {
				host._dragged = false;
				return;
			}
			const bar = barAt(e.clientX, e.clientY);
			if (bar !== null) setPos(tapBar(pos, bar));
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
		total = score.masterBars.length;
		const [a, b] = opts.initialBars ?? [];
		pos = a >= 1 && b >= a && b <= total ? selectBars(a, b) : position(1);
		renderTracks();
		renderPos();
		renderSpeed();
		renderSelection();
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
			const action = keyAction({ key: e.key, field, control, repeat: e.repeat, meta: e.metaKey || e.ctrlKey || e.altKey });
			if (!action) {
				if ((e.key === ' ' || e.key === 'Enter') && !field && !control) e.preventDefault(); // held pedal / Space: no scroll
				return null;
			}
			e.preventDefault();
			if (action === 'toggle') toggle();
			else if (action === 'prev') move(-1);
			else if (action === 'next') move(1);
			else if (action === 'loopStart') setPos(setLoopStart(pos));
			else if (action === 'loopEnd') setPos(setLoopEnd(pos));
			return action;
		},
		reload: load,
		get playing() {
			return playing;
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

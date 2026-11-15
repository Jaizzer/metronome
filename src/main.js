// ============================================================
// main.js — app logic: auth flow, routine builder, audio engine,
// player, and the ✓/✗ record (buttons, foot pedal, undo).
// Persistence goes through db.js; gesture timing lives in pedal.js;
// tallies and the undo stack live in records.js.
// ============================================================
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import './style.css';
import {
	signUp,
	signIn,
	signOut,
	getSession,
	onAuthChange,
	verifyEmail,
	resendVerification,
	fetchPractices,
	fetchPractice,
	insertPractice,
	casUpdatePractice,
	deletePractice,
	fetchMasteryCounts,
	fetchTotalsRow,
	casUpdateTotals,
	insertTotals,
	fetchSettings,
	upsertSettings,
	setKeepalive,
} from './db.js';
import { createPedal } from './pedal.js';
import { createRecorder, sectionStats, routineStats, formatAccuracy } from './records.js';
import { createSync, ensureSectionIds, newSectionId, reconcileSections } from './sync.js';
import { icons } from './icons.js';

const $ = (id) => document.getElementById(id);

// Tiny element builder: h('button', { class: 'btn', onclick }, 'Label').
// Strings become text nodes, so user content is never parsed as HTML.
function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === 'class') el.className = v;
		else if (k === 'html') el.innerHTML = v; // only ever our own icon markup
		else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k in el && typeof v !== 'string') el[k] = v;
		else el.setAttribute(k, v === true ? '' : v);
	}
	for (const c of children.flat()) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return el;
}

const iconEl = (name) => h('span', { html: icons[name], style: 'display:contents' });

// ---------------- State ----------------

let practices = [];
const totals = { s: 0, f: 0 }; // all-time (mastery_counts)
let showStats = true;
let metVolume = 0.8;
let currentSession = null;
let booting = false;
const recorder = createRecorder(totals);

// The section records go to when nothing is playing.
let selectedPracticeId = null;
let selectedSection = null;

// ---------------- Saving (debounced per kind) ----------------

const pendingSaves = new Map(); // key → { timer, fn }
let savesInFlight = 0;

function debounce(key, fn, delay) {
	clearTimeout(pendingSaves.get(key)?.timer);
	const timer = setTimeout(() => {
		pendingSaves.delete(key);
		fn();
	}, delay);
	pendingSaves.set(key, { timer, fn });
}

// Run every queued save now (tab hidden, signing out).
function flushSaves() {
	for (const [key, { timer, fn }] of pendingSaves) {
		clearTimeout(timer);
		pendingSaves.delete(key);
		fn();
	}
}

function setSyncIndicator(state) {
	const el = $('sync-indicator');
	el.classList.toggle('error', state === 'error');
	el.textContent = state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved' : 'Synced';
}

// Wraps a write with sync-indicator feedback. Never alert(): a modal
// dialog in the middle of a run would stop the practice.
async function withSync(promise) {
	savesInFlight++;
	setSyncIndicator('saving');
	try {
		const result = await promise;
		if (--savesInFlight === 0) setSyncIndicator('synced');
		return result;
	} catch (e) {
		savesInFlight--;
		console.error('Sync failed:', e);
		setSyncIndicator('error');
		toast(`Couldn't save: ${e.message || e}. Retrying on your next change.`, 'error', 4000);
		throw e;
	}
}

// ✓/✗ counts are saved as deltas merged into the server's numbers, and
// routine edits with compare-and-swap, so two tabs/devices never
// overwrite each other's records (see sync.js).
const sync = createSync({
	fetchPractice,
	casUpdatePractice,
	fetchTotals: fetchTotalsRow,
	casUpdateTotals,
	insertTotals,
});

// One flush/refresh at a time from this tab.
let syncChain = Promise.resolve();
function serial(fn) {
	const run = syncChain.then(fn, fn);
	syncChain = run.catch(() => {});
	return run;
}

const RETRY_MS = 5000;

// A structure edit (name, loop, tempo, length, ramp, order, add/remove).
function savePractice(p) {
	if (!p?.id) return;
	sync.markStructure(p.id);
	debounce('practices', flushPractices, 500);
}

function noteSectionStats(p, section, kind, n) {
	if (!p?.id || !section?.id || !n) return;
	sync.addSectionDelta(p.id, section.id, kind, n);
	debounce('practices', flushPractices, 500);
}

function noteTotals(kind, n) {
	if (!n) return;
	sync.addTotalsDelta(kind, n);
	debounce('mastery', flushTotals, 300);
}

// Apply a fresh server row to the local routine in place (the undo stack
// and selection hold references to its section objects).
function applyServerRow(p, row) {
	ensureSectionIds(row.metronomes ?? (row.metronomes = []));
	// Keep local structure while it has unsaved edits, or while it's playing.
	const keep = sync.isStructDirty(p.id) || p === activePractice;
	if (!keep) {
		p.name = row.name;
		p.loop = row.loop;
	}
	p.updated_at = row.updated_at;
	p.metronomes = reconcileSections(p.metronomes, row.metronomes, sync.pendingFor(p.id), keep);
}

function removeLocalPractice(p) {
	const idx = practices.indexOf(p);
	if (idx >= 0) practices.splice(idx, 1);
	sync.forget(p.id);
	if (selectedPracticeId === p.id) restoreSelection();
}

async function flushPractices() {
	await serial(async () => {
		const list = practices.filter((p) => sync.hasPending(p.id));
		if (!list.length) return;
		try {
			await withSync(
				(async () => {
					for (const p of list) {
						const row = await sync.flushPractice(p);
						if (row) applyServerRow(p, row);
						else if (p !== activePractice) removeLocalPractice(p); // deleted on another device
					}
				})(),
			);
			refreshViews();
		} catch {
			debounce('practices', flushPractices, RETRY_MS); // deltas stay pending
		}
	});
}

function showTotals(server) {
	const pend = sync.totalsPending();
	totals.s = Math.max(0, server.s + pend.s);
	totals.f = Math.max(0, server.f + pend.f);
}

async function flushTotals() {
	await serial(async () => {
		try {
			showTotals(await withSync(sync.flushTotals()));
			refreshViews();
		} catch {
			debounce('mastery', flushTotals, RETRY_MS);
		}
	});
}

function saveSettings() {
	debounce('settings', () => withSync(upsertSettings(showStats, metVolume)).catch(() => {}), 300);
}

// Pull what other tabs/devices saved (on focus / tab shown).
let lastRefresh = 0;
async function refreshFromServer() {
	if (!currentSession || booting || Date.now() - lastRefresh < 2000) return;
	lastRefresh = Date.now();
	flushSaves(); // queued saves go first; they merge with the server anyway
	await serial(async () => {
		try {
			const [rows, t] = await Promise.all([fetchPractices(), fetchTotalsRow()]);
			const byId = new Map(practices.map((p) => [p.id, p]));
			practices = rows.map((row) => {
				const p = byId.get(row.id);
				if (!p) {
					ensureSectionIds((row.metronomes ??= []));
					return row;
				}
				applyServerRow(p, row);
				return p;
			});
			showTotals({ s: t?.success ?? 0, f: t?.fail ?? 0 });
			if (!practices.some((p) => p.id === selectedPracticeId)) restoreSelection();
			refreshViews();
		} catch (e) {
			console.error('Refresh failed:', e);
		}
	});
}

// Re-render after background changes without yanking an input the user
// is typing in: wait until they leave it.
let renderDeferred = false;
function refreshViews() {
	if (view === 'player') return updateTally();
	if (view !== 'builder') return;
	if (document.activeElement?.closest?.('#app input')) {
		renderDeferred = true;
		return;
	}
	renderBuilder({ keepFocus: true });
}
document.addEventListener('focusout', () => {
	if (!renderDeferred) return;
	setTimeout(() => {
		if (renderDeferred && !document.activeElement?.closest?.('#app input')) {
			renderDeferred = false;
			if (view === 'builder') renderBuilder({ keepFocus: true });
		}
	}, 0);
});

document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') {
		setKeepalive(true); // final saves must survive the page going away
		flushSaves();
	} else {
		setKeepalive(false);
		refreshFromServer();
	}
});
window.addEventListener('pagehide', () => {
	setKeepalive(true);
	flushSaves();
});
window.addEventListener('focus', refreshFromServer);

// ---------------- Views + toast ----------------

const VIEWS = ['auth', 'verify', 'builder', 'player'];
let view = 'auth';

function showView(name) {
	view = name;
	for (const v of VIEWS) $(v).hidden = v !== name;
	window.scrollTo(0, 0);
}

let toastTimer = null;
// kind: 'good' | 'bad' | 'undo' | 'error' | ''. content: string or Node.
function toast(content, kind = '', ms = 1400) {
	const el = $('toast');
	el.className = `toast ${kind}`;
	el.replaceChildren(content instanceof Node ? content : document.createTextNode(content));
	void el.offsetWidth; // restart the slide-in
	el.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------------- Auth flow ----------------

let authMode = 'signin'; // or 'signup'
let pendingVerifyEmail = null;
let pendingPassword = null; // kept in memory only, to sign in right after verifying

function setAuthMode(mode) {
	authMode = mode;
	const signup = mode === 'signup';
	$('auth-title').textContent = signup ? 'Create account' : 'Sign in';
	$('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
	$('auth-toggle').textContent = signup ? 'Have an account? Sign in' : 'New here? Create an account';
	$('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
	showAuthError('');
}

function showAuthError(msg) {
	$('auth-error').textContent = msg || '';
}

function showVerifyError(msg) {
	$('verify-error').textContent = msg || '';
}

function showVerifyScreen(email, instructions) {
	pendingVerifyEmail = email;
	$('verify-instructions').textContent = instructions;
	$('verify-code').value = '';
	showVerifyError('');
	showView('verify');
	$('verify-code').focus();
}

// Neon Auth returns a distinct error for "signed up but not verified" —
// route to the code screen instead of showing the raw error.
function isUnverifiedEmailError(e) {
	const msg = (e?.message || '').toLowerCase();
	const code = (e?.code || '').toLowerCase();
	return msg.includes('verif') || code.includes('verif') || code.includes('email_not_verified');
}

function friendlyAuthError(e) {
	const code = (e?.code || e?.body?.code || '').toUpperCase();
	if (code === 'INVALID_EMAIL_OR_PASSWORD') return 'That email and password don’t match. Check both and try again.';
	if (code === 'USER_ALREADY_EXISTS' || code.includes('ALREADY_EXISTS'))
		return 'An account with this email already exists. Sign in instead.';
	if (code === 'PASSWORD_TOO_SHORT') return 'Use a password of at least 8 characters.';
	if (code === 'INVALID_EMAIL') return 'That email address doesn’t look right.';
	return e?.message || 'Something went wrong. Try again.';
}

$('auth-toggle').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');

$('auth-form').onsubmit = async (e) => {
	e.preventDefault();
	const email = $('auth-email').value.trim();
	const password = $('auth-password').value;
	if (!email || !password) return showAuthError('Enter your email and password.');
	if (authMode === 'signup' && password.length < 8)
		return showAuthError('Use a password of at least 8 characters.');

	const submit = $('auth-submit');
	submit.disabled = true;
	$('auth-status').textContent = authMode === 'signup' ? 'Creating your account…' : 'Signing in…';
	showAuthError('');
	try {
		if (authMode === 'signup') {
			await signUp(email, password);
			pendingPassword = password;
			showVerifyScreen(email, `We emailed a 6-digit code to ${email}. Enter it to finish creating your account.`);
		} else {
			await signIn(email, password);
			const session = await getSession();
			if (session) await bootApp(session);
		}
	} catch (err) {
		if (isUnverifiedEmailError(err)) {
			pendingPassword = password;
			showVerifyScreen(email, `Your email isn’t verified yet. Enter the code we sent to ${email}, or send a new one.`);
		} else {
			showAuthError(friendlyAuthError(err));
		}
	} finally {
		submit.disabled = false;
		$('auth-status').textContent = '';
	}
};

$('verify-form').onsubmit = async (e) => {
	e.preventDefault();
	const code = $('verify-code').value.trim();
	if (!/^\d{6}$/.test(code)) return showVerifyError('Enter the 6-digit code from the email.');
	if (!pendingVerifyEmail) return showVerifyError('Go back and sign in again.');

	const submit = $('verify-submit');
	submit.disabled = true;
	showVerifyError('');
	try {
		await verifyEmail(pendingVerifyEmail, code);
		let session = await getSession();
		if (!session && pendingPassword) {
			await signIn(pendingVerifyEmail, pendingPassword);
			session = await getSession();
		}
		pendingPassword = null;
		if (session) return bootApp(session);
		// Verified but not signed in: back to sign-in with the email filled.
		setAuthMode('signin');
		$('auth-email').value = pendingVerifyEmail;
		showView('auth');
		$('auth-status').textContent = 'Email verified. Sign in to continue.';
		$('auth-password').focus();
	} catch (err) {
		showVerifyError(err.message || 'That code didn’t work. Check it, or send a new one.');
	} finally {
		submit.disabled = false;
	}
};

$('verify-resend').onclick = async () => {
	if (!pendingVerifyEmail) return;
	showVerifyError('');
	try {
		await resendVerification(pendingVerifyEmail);
		showVerifyError('New code sent. Check your email (and spam).');
	} catch (err) {
		showVerifyError(err.message || 'Couldn’t send a new code. Wait a minute and try again.');
	}
};

$('verify-back').onclick = () => {
	pendingVerifyEmail = null;
	pendingPassword = null;
	showView('auth');
};

$('signOutBtn').onclick = async () => {
	flushSaves();
	await signOut();
	location.reload();
};

async function bootApp(session) {
	if (currentSession || booting) return;
	booting = true;
	currentSession = session;
	showView('builder');
	setSyncIndicator('saving');

	try {
		const [fetchedPractices, masteryCounts, settings] = await Promise.all([
			fetchPractices(),
			fetchMasteryCounts(),
			fetchSettings(),
		]);
		practices = fetchedPractices.map((p) => {
			const row = { ...p, metronomes: p.metronomes ?? [] };
			ensureSectionIds(row.metronomes);
			return row;
		});
		totals.s = masteryCounts.success;
		totals.f = masteryCounts.fail;
		showStats = settings.show_stats;
		metVolume = parseFloat(settings.volume);
		setSyncIndicator('synced');
	} catch (e) {
		console.error('Initial load failed:', e);
		setSyncIndicator('error');
		toast(`Couldn't load your data: ${e.message || e}`, 'error', 5000);
		practices = [];
	}

	restoreSelection();
	renderBuilder();
	applyStatsVisibility();
	$('volumeSlider').value = metVolume;
	updateVolumeLabel();
	booting = false;
}

async function init() {
	onAuthChange((session) => {
		if (session && !currentSession) bootApp(session);
		if (!session && currentSession) location.reload();
	});
	setAuthMode('signin');
	$('auth-status').textContent = 'Checking your session…';
	try {
		const session = await getSession();
		if (session) await bootApp(session);
	} catch (e) {
		console.error('Session check failed:', e);
	}
	$('auth-status').textContent = '';
}

// ---------------- Selection (where records go when not playing) ----------------

const SELECTION_KEY = 'metronome:selection';

function restoreSelection() {
	let saved = null;
	try {
		saved = JSON.parse(localStorage.getItem(SELECTION_KEY) || 'null');
	} catch {
		saved = null;
	}
	const p = practices.find((x) => x.id === saved?.practiceId) || practices[0];
	selectedPracticeId = p?.id ?? null;
	selectedSection = p?.metronomes[Math.min(saved?.index ?? 0, p.metronomes.length - 1)] ?? null;
}

function selectSection(p, section) {
	selectedPracticeId = p.id;
	selectedSection = section;
	try {
		localStorage.setItem(
			SELECTION_KEY,
			JSON.stringify({ practiceId: p.id, index: p.metronomes.indexOf(section) }),
		);
	} catch {
		// private mode etc. — selection just won't persist
	}
	document.querySelectorAll('.sec').forEach((li) => {
		li.classList.toggle('is-selected', li._section === section);
	});
	renderRecordBar();
}

// The section a record is attributed to: the playing one, else the selected one.
function currentTarget() {
	if (view === 'player' && activePractice && activeMetIndex >= 0) {
		return { practice: activePractice, section: activePractice.metronomes[activeMetIndex] ?? null };
	}
	const p = practices.find((x) => x.id === selectedPracticeId) || practices[0];
	if (!p) return null;
	const section = p.metronomes.includes(selectedSection) ? selectedSection : (p.metronomes[0] ?? null);
	return { practice: p, section };
}

// ---------------- Recording ✓ / ✗ ----------------

// target: captured when the pedal was pressed (so a section change during
// the double-tap window can't steal the record); defaults to "now".
function record(kind, target = currentTarget()) {
	recorder.record(kind, target);
	noteSectionStats(target?.practice, target?.section, kind, 1);
	noteTotals(kind, 1);
	refreshStats();

	const good = kind === 's';
	strike(good ? 'success-zone' : 'fail-zone', 'is-struck', 450);
	strike(good ? 'bar-good' : 'bar-bad', 'is-struck', 450);
	const where = target?.section?.name ? ` · ${target.section.name}` : '';
	toast(`${good ? '✓ Good run' : '✗ Bad run'}${where}`, good ? 'good' : 'bad');
}

function undoLast() {
	const entry = recorder.undo();
	if (!entry) {
		toast('Nothing to undo');
		return;
	}
	if (!entry.sectionGone) noteSectionStats(entry.practice, entry.section, entry.kind, -1);
	noteTotals(entry.kind, -1);
	refreshStats();

	const good = entry.kind === 's';
	$(good ? 'success-zone' : 'fail-zone').classList.remove('is-struck');
	strike(good ? 'success-zone' : 'fail-zone', 'is-undone', 900);
	const msg = h(
		'span',
		{},
		'Undone: ',
		h('s', {}, good ? '✓ Good run' : '✗ Bad run'),
		entry.sectionName ? ` · ${entry.sectionName}` : '',
	);
	toast(msg, 'undo', 2000);
}

function cancelPendingToast() {
	toast(h('span', {}, 'Undone: ', h('s', {}, 'pending ✓')), 'undo', 1600);
}

// Re-trigger a one-shot class (the overprint flash, the struck-out undo).
function strike(id, cls, ms) {
	const el = $(id);
	if (!el || el.offsetParent === null) return;
	el.classList.remove(cls);
	void el.offsetWidth;
	el.classList.add(cls);
	el._strikeTimers ??= {};
	clearTimeout(el._strikeTimers[cls]); // one timer per class: a flash must not strand an undo mark
	el._strikeTimers[cls] = setTimeout(() => el.classList.remove(cls), ms);
}

const pedal = createPedal({
	onGood: () => record('s'),
	onBad: () => record('f'),
	onUndo: ({ cancelledPending }) => (cancelledPending ? cancelPendingToast() : undoLast()),
	onPending: (on) => {
		for (const id of ['pedal-pending', 'bar-pending']) {
			const el = $(id);
			el.hidden = !on; // un-hiding restarts the shrinking dot that times the window
		}
		$('pedal-hint').hidden = on;
	},
});

$('success-zone').onclick = () => record('s');
$('fail-zone').onclick = () => record('f');
$('bar-good').onclick = () => record('s');
$('bar-bad').onclick = () => record('f');
$('undoBtn').onclick = undoLast;
$('bar-undo').onclick = undoLast;

// Text-entry targets keep Enter and Cmd/Ctrl+Z for themselves.
function isTypingTarget(el) {
	return Boolean(
		el?.closest?.(
			'input:not([type=range]):not([type=checkbox]):not([type=button]), textarea, select, [contenteditable=""], [contenteditable="true"]',
		),
	);
}

window.addEventListener('keydown', (e) => {
	if (!currentSession || $('modal').open) return;
	if (isTypingTarget(e.target)) return;

	// Foot pedal (sends Enter). Handled on keydown + keyup in pedal.js.
	if (e.key === 'Enter') {
		e.preventDefault(); // don't also "click" whatever button has focus
		pedal.keydown(e);
		return;
	}
	if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
		e.preventDefault();
		if (!e.repeat) undoLast();
		return;
	}
	if (view !== 'player') return;
	const onRange = e.target?.type === 'range';
	if (e.key === ' ' && !(e.target instanceof HTMLButtonElement) && !onRange) {
		e.preventDefault();
		if (!e.repeat) togglePause();
	} else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !onRange) {
		e.preventDefault();
		adjustBPM((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 1));
	} else if (e.key === 'PageUp' || e.key === 'PageDown') {
		e.preventDefault();
		adjustBPM(e.key === 'PageUp' ? 5 : -5);
	}
});

window.addEventListener('keyup', (e) => {
	if (e.key === 'Enter') pedal.keyup();
});
window.addEventListener('blur', () => pedal.cancelPress());

// ---------------- Stats display ----------------

function tallyInline(st) {
	return h(
		'span',
		{ class: 'tally-inline', title: `${st.s} good, ${st.f} bad` },
		h('span', { class: 'g' }, `✓ ${st.s}`),
		h('span', { class: 'b' }, `✗ ${st.f}`),
		h('span', { class: 'a' }, formatAccuracy(st)),
	);
}

function renderAlltime() {
	$('alltime').replaceChildren(
		h('span', {}, 'All-time '),
		h('b', {}, `✓ ${totals.s}`),
		h('b', {}, `✗ ${totals.f}`),
		h('span', {}, 'accuracy ', h('b', {}, formatAccuracy(totals))),
	);
}

function refreshStats() {
	if (view === 'player') updateTally();
	else renderBuilder({ keepFocus: true });
}

function applyStatsVisibility() {
	$('stats-ui').hidden = !showStats;
	$('tally-foot').hidden = !showStats;
	$('toggleStats').setAttribute('aria-checked', String(showStats));
}

$('toggleStats').onclick = () => {
	showStats = !showStats;
	applyStatsVisibility();
	saveSettings();
};

$('resetStats').onclick = () => {
	confirmDialog({
		title: 'Reset all-time stats?',
		text: `Sets your all-time ✓ ${totals.s} / ✗ ${totals.f} back to zero. Per-section stats are kept.`,
		confirm: 'Reset',
		onConfirm: () => {
			noteTotals('s', -totals.s);
			noteTotals('f', -totals.f);
			totals.s = 0;
			totals.f = 0;
			recorder.clear();
			refreshStats();
		},
	});
};

function updateVolumeLabel() {
	$('volume-pct').textContent = Math.round((metVolume / 3) * 100) + '%';
}

$('volumeSlider').oninput = (e) => {
	metVolume = parseFloat(e.target.value);
	updateVolumeLabel();
	saveSettings();
};

// ---------------- Audio engine ----------------

let audioCtx,
	nextTickTime = 0,
	schedulerInterval,
	countdownInterval;
let currentBPM = 120,
	activePractice = null,
	activeMetIndex = -1;
let beatCounter = 0,
	isPaused = false,
	timeLeftInSection = 0,
	totalSectionTime = 0;
let sectionStartBPM = 120,
	sectionEndBPM = 120,
	isRamping = false;

function initAudio() {
	if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playClick(time, accented) {
	const osc = audioCtx.createOscillator();
	const gain = audioCtx.createGain();
	osc.type = 'triangle';
	osc.frequency.setValueAtTime(accented ? 1600 : 900, time);
	gain.gain.setValueAtTime(Math.max(0.0001, metVolume), time);
	gain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
	osc.connect(gain);
	gain.connect(audioCtx.destination);
	osc.start(time);
	osc.stop(time + 0.1);
}

function lightUpDot(beatIndex) {
	for (let i = 0; i < 4; i++) $(`dot-${i}`).classList.toggle('on', i === beatIndex);
}

function scheduler() {
	if (isPaused) return;
	while (nextTickTime < audioCtx.currentTime + 0.1) {
		const beat = beatCounter % 4;
		const tickTime = nextTickTime;
		playClick(tickTime, beat === 0);
		if (isRamping && totalSectionTime > 0) {
			const elapsed = totalSectionTime - timeLeftInSection;
			const t = Math.min(elapsed / totalSectionTime, 1);
			currentBPM = Math.round(sectionStartBPM + (sectionEndBPM - sectionStartBPM) * t);
			adjustBPMDisplay();
		}
		nextTickTime += 60 / currentBPM;
		setTimeout(
			() => {
				if (!isPaused) lightUpDot(beat);
			},
			Math.max(0, (tickTime - audioCtx.currentTime) * 1000),
		);
		beatCounter++;
	}
}

function runSection(index) {
	if (!activePractice || !activePractice.metronomes.length) return stopEverything();
	if (index < 0) index = 0;
	if (index >= activePractice.metronomes.length) {
		if (activePractice.loop) index = 0;
		else return stopEverything({ finished: true });
	}
	activeMetIndex = index;
	const met = activePractice.metronomes[index];
	sectionStartBPM = met.startBPM;
	sectionEndBPM = met.ramp ? met.endBPM || met.startBPM : met.startBPM;
	isRamping = Boolean(met.ramp && met.endBPM && met.endBPM !== met.startBPM);
	currentBPM = sectionStartBPM;
	timeLeftInSection = met.duration;
	totalSectionTime = met.duration;
	adjustBPMDisplay();
	updatePlayerUI();
	beatCounter = 0;
	nextTickTime = audioCtx.currentTime + 0.05;
	updateProgressBar(1);

	if (!schedulerInterval) schedulerInterval = setInterval(scheduler, 25);
	startCountdown();
}

function formatClock(seconds) {
	const s = Math.max(0, seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, '0');
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function startCountdown() {
	clearInterval(countdownInterval);
	$('remaining').textContent = formatClock(timeLeftInSection);
	countdownInterval = setInterval(() => {
		if (isPaused) return;
		timeLeftInSection--;
		$('remaining').textContent = formatClock(timeLeftInSection);
		updateProgressBar(totalSectionTime > 0 ? timeLeftInSection / totalSectionTime : 0);
		if (timeLeftInSection <= 0) {
			clearInterval(countdownInterval);
			runSection(activeMetIndex + 1);
		}
	}, 1000);
}

function updateProgressBar(fraction) {
	$('progress-bar').style.width = Math.max(0, fraction) * 100 + '%';
}

function adjustBPMDisplay() {
	currentBPM = Math.round(Math.max(20, Math.min(300, currentBPM)));
	const el = $('bpm-display');
	el.textContent = currentBPM;
	el.setAttribute('aria-valuenow', currentBPM);
}

// Manual tempo change during playback: stops any ramp and becomes the
// section's tempo (persisted), same as before the redesign.
function adjustBPM(amount) {
	if (!activePractice || activeMetIndex < 0) return;
	currentBPM = Math.round(Math.max(20, Math.min(300, currentBPM + amount)));
	isRamping = false;
	adjustBPMDisplay();
	const met = activePractice.metronomes[activeMetIndex];
	met.startBPM = currentBPM;
	met.ramp = false;
	$('bpm-unit').textContent = 'BPM';
	savePractice(activePractice);
}

function togglePause() {
	isPaused = !isPaused;
	if (!isPaused && audioCtx) nextTickTime = audioCtx.currentTime + 0.05; // no catch-up burst
	renderPlayButton();
	if (isPaused) lightUpDot(-1);
}

function renderPlayButton() {
	const btn = $('playPause');
	btn.innerHTML = isPaused ? icons.play : icons.pause;
	btn.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
}

function updatePlayerUI() {
	if (activeMetIndex === -1) return;
	const list = activePractice.metronomes;
	const met = list[activeMetIndex];
	$('player-title').textContent = activePractice.name;
	$('player-pos').textContent = `${activeMetIndex + 1}/${list.length}`;
	$('label').textContent = met.name;
	$('bpm-unit').textContent =
		met.ramp && met.endBPM && met.endBPM !== met.startBPM ? `BPM · ramp ${met.startBPM} → ${met.endBPM}` : 'BPM';

	const next = list[activeMetIndex + 1] || (activePractice.loop ? list[0] : null);
	$('upcoming-details').textContent = next
		? `Next: ${next.name} · ${next.startBPM} BPM · ${formatClock(next.duration)}${list[activeMetIndex + 1] ? '' : ' (loop)'}`
		: 'Last section';
	$('prevBtn').disabled = activeMetIndex === 0;

	$('stops').replaceChildren(
		...list.map((m, i) =>
			h(
				'li',
				{ class: i < activeMetIndex ? 'is-done' : i === activeMetIndex ? 'is-current' : '' },
				h('button', {
					class: 'stop',
					type: 'button',
					'aria-label': `Go to section ${i + 1}: ${m.name}`,
					'aria-current': i === activeMetIndex ? 'step' : null,
					onclick: () => runSection(i),
				}),
			),
		),
	);
	updateTally();
}

function updateTally() {
	if (!activePractice || activeMetIndex < 0) return;
	const sec = sectionStats(activePractice.metronomes[activeMetIndex]);
	const rt = routineStats(activePractice);
	$('success-count').textContent = sec.s;
	$('fail-count').textContent = sec.f;
	$('success-sub').textContent = `Section · routine ${rt.s}`;
	$('fail-sub').textContent = `Section · routine ${rt.f}`;
	$('tally-foot').replaceChildren(
		h('span', {}, 'Section ', h('b', {}, formatAccuracy(sec))),
		h('span', {}, 'Routine ', h('b', {}, formatAccuracy(rt))),
		h('span', {}, 'All-time ', h('b', {}, `${formatAccuracy(totals)} of ${totals.s + totals.f}`)),
	);
	$('undoBtn').disabled = recorder.size === 0;
}

// Keep the phone screen awake while a routine plays (music-stand use).
let wakeLock = null;
async function requestWakeLock() {
	try {
		wakeLock = await navigator.wakeLock?.request('screen');
	} catch {
		wakeLock = null; // not supported or denied: fine
	}
}
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible' && view === 'player') requestWakeLock();
});

function startRoutine(p) {
	if (!p.metronomes.length) return toast('Add a section first');
	initAudio();
	activePractice = p;
	isPaused = false;
	renderPlayButton();
	showView('player');
	runSection(0);
	requestWakeLock();
	$('playPause').focus();
}

function stopEverything({ finished = false } = {}) {
	isPaused = false;
	clearInterval(schedulerInterval);
	clearInterval(countdownInterval);
	schedulerInterval = null;
	lightUpDot(-1);
	wakeLock?.release?.().catch(() => {});
	wakeLock = null;
	if (activePractice && activeMetIndex >= 0) {
		// Records made while playing go to the selected section afterwards too.
		const sec = activePractice.metronomes[activeMetIndex];
		if (sec) selectSection(activePractice, sec);
	}
	activePractice = null;
	activeMetIndex = -1;
	showView('builder');
	renderBuilder();
	if (finished) toast('Routine finished');
}

$('stop').onclick = () => stopEverything();
$('playPause').onclick = togglePause;
$('plus').onclick = () => adjustBPM(1);
$('minus').onclick = () => adjustBPM(-1);
$('nextBtn').onclick = () => runSection(activeMetIndex + 1);
$('prevBtn').onclick = () => runSection(activeMetIndex - 1);

// Drag the BPM numeral up/down like a knob (1 BPM per 4px).
{
	const bpmEl = $('bpm-display');
	let dragY = null;
	let carry = 0;
	bpmEl.addEventListener('pointerdown', (e) => {
		dragY = e.clientY;
		carry = 0;
		bpmEl.setPointerCapture(e.pointerId);
		initAudio();
	});
	bpmEl.addEventListener('pointermove', (e) => {
		if (dragY === null) return;
		carry += dragY - e.clientY;
		dragY = e.clientY;
		const steps = Math.trunc(carry / 4);
		if (steps) {
			carry -= steps * 4;
			adjustBPM(steps);
		}
	});
	const end = () => (dragY = null);
	bpmEl.addEventListener('pointerup', end);
	bpmEl.addEventListener('pointercancel', end);
}

// ---------------- Dialogs ----------------

const modal = $('modal');

function openDialog(title, ...content) {
	$('modal-title').textContent = title;
	$('modal-content').replaceChildren(...content);
	if (!modal.open) modal.showModal();
}

function closeDialog() {
	if (modal.open) modal.close();
}

modal.addEventListener('click', (e) => {
	if (e.target === modal) closeDialog(); // click on the backdrop
});

function confirmDialog({ title, text, confirm, onConfirm }) {
	openDialog(
		title,
		h('p', {}, text),
		h(
			'div',
			{ class: 'dialog-actions' },
			h('button', { class: 'btn', type: 'button', onclick: closeDialog, autofocus: true }, 'Cancel'),
			h(
				'button',
				{
					class: 'btn btn-danger',
					type: 'button',
					onclick: () => {
						closeDialog();
						onConfirm();
					},
				},
				confirm,
			),
		),
	);
}

// ---------------- Duration drum-roll picker ----------------

const ITEM_H = 44;

function buildDrum(id, count, label) {
	return h(
		'div',
		{ class: 'drum' },
		h('span', { id: `${id}-label` }, label),
		h(
			'div',
			{ class: 'drum-window' },
			h(
				'div',
				{ class: 'drum-scroll', id, tabindex: '0', role: 'group', 'aria-labelledby': `${id}-label` },
				h('div', { class: 'drum-pad' }),
				Array.from({ length: count }, (_, i) => h('div', { class: 'drum-item' }, String(i).padStart(2, '0'))),
				h('div', { class: 'drum-pad' }),
			),
		),
	);
}

const drumValue = (id) => Math.round($(id).scrollTop / ITEM_H);

function openTimePicker(p, section) {
	const total = section.duration;
	const parts = { 'drum-h': Math.floor(total / 3600), 'drum-m': Math.floor((total % 3600) / 60), 'drum-s': total % 60 };
	openDialog(
		'Section length',
		h('div', { class: 'drums' }, buildDrum('drum-h', 24, 'Hours'), buildDrum('drum-m', 60, 'Minutes'), buildDrum('drum-s', 60, 'Seconds')),
		h(
			'div',
			{ class: 'dialog-actions' },
			h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
			h(
				'button',
				{
					class: 'btn btn-primary',
					type: 'button',
					onclick: () => {
						const seconds = drumValue('drum-h') * 3600 + drumValue('drum-m') * 60 + drumValue('drum-s');
						section.duration = Math.max(1, seconds);
						savePractice(p);
						closeDialog();
						renderBuilder();
					},
				},
				'Set',
			),
		),
	);
	requestAnimationFrame(() => {
		for (const [id, v] of Object.entries(parts)) $(id).scrollTop = v * ITEM_H;
		$('drum-m').focus();
	});
}

// Arrow keys step a focused drum by one item.
modal.addEventListener('keydown', (e) => {
	const drum = e.target.closest?.('.drum-scroll');
	if (!drum || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
	e.preventDefault();
	drum.scrollTop = (Math.round(drum.scrollTop / ITEM_H) + (e.key === 'ArrowDown' ? 1 : -1)) * ITEM_H;
});

// ---------------- Section reorder (mouse drag, touch drag, keyboard) ----------------

function moveSection(p, from, to) {
	if (to < 0 || to >= p.metronomes.length || from === to) return;
	const [moved] = p.metronomes.splice(from, 1);
	p.metronomes.splice(to, 0, moved);
	savePractice(p);
	renderBuilder();
}

let dragFrom = null; // { pIdx, mIdx }

function clearDropMarks() {
	document.querySelectorAll('.sec').forEach((el) => el.classList.remove('is-dragging', 'is-drop-target'));
}

// Touch: a floating clone follows the finger; drop on another row.
let touchDrag = null; // { pIdx, mIdx, el, clone }

function onTouchDragStart(e, pIdx, mIdx) {
	const el = e.currentTarget.closest('.sec');
	const rect = el.getBoundingClientRect();
	const clone = el.cloneNode(true);
	clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.85;pointer-events:none;z-index:99;background:var(--stock-raised);box-shadow:0 12px 32px rgba(0,0,0,.5);`;
	document.body.appendChild(clone);
	el.classList.add('is-dragging');
	touchDrag = { pIdx, mIdx, el, clone };
	e.preventDefault();
}

window.addEventListener(
	'touchmove',
	(e) => {
		if (!touchDrag) return;
		const t = e.touches[0];
		touchDrag.clone.style.top = t.clientY - 24 + 'px';
		document.querySelectorAll('.sec').forEach((el) => el.classList.remove('is-drop-target'));
		const target = document.elementFromPoint(t.clientX, t.clientY)?.closest('.sec');
		if (target && target !== touchDrag.el) target.classList.add('is-drop-target');
		e.preventDefault();
	},
	{ passive: false },
);

window.addEventListener('touchend', (e) => {
	if (!touchDrag) return;
	const t = e.changedTouches[0];
	const target = document.elementFromPoint(t.clientX, t.clientY)?.closest('.sec');
	const { pIdx, mIdx, clone } = touchDrag;
	clone.remove();
	touchDrag = null;
	clearDropMarks();
	if (target && Number(target.dataset.pidx) === pIdx) {
		moveSection(practices[pIdx], mIdx, Number(target.dataset.midx));
	}
});

// ---------------- Builder render ----------------

function formatDuration(seconds) {
	const hh = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (hh > 0) return `${hh}h ${m}m ${s}s`;
	if (m > 0) return s ? `${m}m ${s}s` : `${m}m`;
	return `${s}s`;
}

function clampBPM(v, fallback) {
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? Math.max(20, Math.min(300, n)) : fallback;
}

function renderSection(p, pIdx, m, mIdx) {
	const st = sectionStats(m);
	const li = h('li', {
		class: `sec${m === currentTarget()?.section ? ' is-selected' : ''}`,
		'data-pidx': pIdx,
		'data-midx': mIdx,
		onclick: () => selectSection(p, m),
		onfocusin: () => selectSection(p, m),
		ondragover: (e) => {
			if (!dragFrom || dragFrom.pIdx !== pIdx) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			document.querySelectorAll('.sec').forEach((el) => el.classList.remove('is-drop-target'));
			li.classList.add('is-drop-target');
		},
		ondrop: (e) => {
			e.preventDefault();
			if (dragFrom && dragFrom.pIdx === pIdx) moveSection(p, dragFrom.mIdx, mIdx);
		},
		ondragstart: (e) => {
			dragFrom = { pIdx, mIdx };
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', m.name);
			setTimeout(() => li.classList.add('is-dragging'), 0);
		},
		ondragend: () => {
			dragFrom = null;
			li.draggable = false;
			clearDropMarks();
		},
	});
	li._section = m;

	const grip = h('button', {
		class: 'grip',
		type: 'button',
		html: icons.grip,
		'aria-label': `Move ${m.name}. Drag, or press arrow up or down.`,
		// Only the grip starts a mouse drag, so inputs stay selectable.
		onmousedown: () => (li.draggable = true),
		onmouseup: () => (li.draggable = false),
		onkeydown: (e) => {
			if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
			e.preventDefault();
			const to = mIdx + (e.key === 'ArrowUp' ? -1 : 1);
			moveSection(p, mIdx, to);
			document.querySelector(`.sec[data-pidx="${pIdx}"][data-midx="${Math.max(0, Math.min(to, p.metronomes.length - 1))}"] .grip`)?.focus();
		},
	});
	grip.addEventListener('touchstart', (e) => onTouchDragStart(e, pIdx, mIdx), { passive: false });

	const fields = h(
		'div',
		{ class: 'sec-fields' },
		h(
			'label',
			{ class: 'mini' },
			h('input', {
				type: 'number',
				min: '20',
				max: '300',
				step: '1',
				inputmode: 'numeric',
				value: String(m.startBPM),
				'aria-label': `${m.name} tempo (BPM)`,
				onchange: (e) => {
					m.startBPM = clampBPM(e.target.value, m.startBPM);
					e.target.value = m.startBPM;
					savePractice(p);
				},
			}),
			'BPM',
		),
		h(
			'button',
			{
				class: 'duration-btn',
				type: 'button',
				'aria-label': `${m.name} length ${formatDuration(m.duration)}. Change`,
				onclick: () => openTimePicker(p, m),
			},
			formatDuration(m.duration),
		),
		h(
			'button',
			{
				class: 'ramp-btn',
				type: 'button',
				'aria-pressed': String(Boolean(m.ramp)),
				onclick: () => {
					m.ramp = !m.ramp;
					if (m.ramp && !m.endBPM) m.endBPM = m.startBPM;
					savePractice(p);
					renderBuilder();
				},
			},
			'Ramp',
		),
		m.ramp &&
			h(
				'label',
				{ class: 'mini' },
				'to',
				h('input', {
					type: 'number',
					min: '20',
					max: '300',
					step: '1',
					inputmode: 'numeric',
					value: String(m.endBPM || m.startBPM),
					'aria-label': `${m.name} end tempo (BPM)`,
					onchange: (e) => {
						m.endBPM = clampBPM(e.target.value, m.endBPM || m.startBPM);
						e.target.value = m.endBPM;
						savePractice(p);
					},
				}),
				'BPM',
			),
	);

	li.append(
		grip,
		h('input', {
			class: 'sec-name',
			type: 'text',
			value: m.name,
			'aria-label': 'Section name',
			onchange: (e) => {
				m.name = e.target.value.trim() || 'Section';
				savePractice(p);
			},
		}),
		tallyInline(st),
		h('button', {
			class: 'btn btn-quiet btn-icon sec-remove',
			type: 'button',
			html: icons.cross,
			'aria-label': `Remove section ${m.name}`,
			onclick: (e) => {
				e.stopPropagation();
				p.metronomes.splice(mIdx, 1);
				savePractice(p);
				renderBuilder();
			},
		}),
		fields,
	);
	return li;
}

function renderRoutine(p, pIdx) {
	const rt = routineStats(p);
	const totalTime = p.metronomes.reduce((a, m) => a + (m.duration || 0), 0);
	const loopSwitch = h(
		'button',
		{
			class: 'switch',
			type: 'button',
			role: 'switch',
			'aria-checked': String(Boolean(p.loop)),
			onclick: () => {
				p.loop = !p.loop;
				loopSwitch.setAttribute('aria-checked', String(p.loop));
				savePractice(p);
			},
		},
		h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
		'Loop',
	);

	return h(
		'article',
		{ class: 'routine', 'aria-label': p.name },
		h(
			'div',
			{ class: 'routine-head' },
			h('input', {
				class: 'routine-name',
				type: 'text',
				value: p.name,
				'aria-label': 'Routine name',
				onchange: (e) => {
					p.name = e.target.value.trim() || 'Untitled routine';
					savePractice(p);
					renderRecordBar();
				},
			}),
			h(
				'div',
				{ class: 'routine-tools' },
				h('button', {
					class: 'btn btn-quiet btn-icon',
					type: 'button',
					html: icons.reset,
					title: 'Reset stats',
					'aria-label': `Reset stats for ${p.name}`,
					disabled: rt.s + rt.f === 0,
					onclick: () =>
						confirmDialog({
							title: 'Reset routine stats?',
							text: `Clears ✓ ${rt.s} / ✗ ${rt.f} from every section of “${p.name}”. Your all-time total is kept.`,
							confirm: 'Reset',
							onConfirm: () => {
								for (const m of p.metronomes) {
									const st = sectionStats(m);
									noteSectionStats(p, m, 's', -st.s);
									noteSectionStats(p, m, 'f', -st.f);
									m.stats = { s: 0, f: 0 };
								}
								recorder.clear();
								renderBuilder();
							},
						}),
				}),
				h('button', {
					class: 'btn btn-quiet btn-icon',
					type: 'button',
					html: icons.trash,
					title: 'Delete routine',
					'aria-label': `Delete routine ${p.name}`,
					onclick: () => openDeleteDialog(p),
				}),
			),
			h(
				'div',
				{ class: 'routine-meta' },
				tallyInline(rt),
				h('span', {}, `${p.metronomes.length} ${p.metronomes.length === 1 ? 'section' : 'sections'} · ${formatDuration(totalTime)}`),
				loopSwitch,
			),
		),
		h('ol', { class: 'sections' }, p.metronomes.map((m, mIdx) => renderSection(p, pIdx, m, mIdx))),
		h(
			'div',
			{ class: 'routine-actions' },
			h(
				'button',
				{
					class: 'btn add',
					type: 'button',
					onclick: () => {
						const last = p.metronomes[p.metronomes.length - 1];
						const section = {
							id: newSectionId(),
							name: `Exercise ${p.metronomes.length + 1}`,
							startBPM: last?.startBPM ?? 100,
							duration: last?.duration ?? 60,
							ramp: false,
						};
						p.metronomes.push(section);
						selectSection(p, section);
						savePractice(p);
						renderBuilder();
					},
				},
				iconEl('plus'),
				'Add section',
			),
			h(
				'button',
				{
					class: 'btn btn-primary start',
					type: 'button',
					disabled: !p.metronomes.length,
					onclick: () => startRoutine(p),
				},
				iconEl('play'),
				'Start routine',
			),
		),
	);
}

function renderRecordBar() {
	const t = currentTarget();
	const label = $('record-target');
	if (!t) label.replaceChildren('No routine yet', h('b', {}, 'Records count toward all-time'));
	else
		label.replaceChildren(
			'Pedal records to',
			h('b', {}, t.section ? `${t.practice.name} › ${t.section.name}` : t.practice.name),
		);
	$('bar-undo').disabled = recorder.size === 0;
}

function renderBuilder({ keepFocus = false } = {}) {
	// Re-rendering replaces the controls; remember which one had focus
	// (by section position + class) so the pedal/keyboard user keeps their place.
	const active = keepFocus ? document.activeElement : null;
	const sec = active?.closest?.('#app .sec');
	const focusSelector =
		sec && active.classList[0]
			? `.sec[data-pidx="${sec.dataset.pidx}"][data-midx="${sec.dataset.midx}"] .${active.classList[0]}`
			: null;

	renderAlltime();
	const app = $('app');
	if (!practices.length) {
		app.replaceChildren(
			h(
				'div',
				{ class: 'empty' },
				h('p', {}, 'No routines yet. A routine is a list of timed sections, each with its own tempo.'),
				h('button', { class: 'btn btn-primary', type: 'button', onclick: addRoutine }, 'Create your first routine'),
			),
		);
	} else {
		app.replaceChildren(...practices.map((p, pIdx) => renderRoutine(p, pIdx)));
	}
	renderRecordBar();
	if (focusSelector) document.querySelector(focusSelector)?.focus();
}

// ---------------- Delete routine ----------------

function openDeleteDialog(p) {
	confirmDialog({
		title: 'Delete routine?',
		text: `“${p.name}” and its per-section stats will be deleted. Your all-time total is kept.`,
		confirm: 'Delete',
		onConfirm: async () => {
			removeLocalPractice(p);
			renderBuilder();
			if (p.id) await withSync(deletePractice(p.id)).catch(() => {});
		},
	});
}

// ---------------- Top-level buttons ----------------

async function addRoutine() {
	const draft = {
		name: 'New routine',
		loop: false,
		metronomes: [{ id: newSectionId(), name: 'Exercise 1', startBPM: 100, duration: 60, ramp: false }],
		position: practices.length,
	};
	try {
		const created = await withSync(insertPractice(draft));
		practices.push({ ...created, metronomes: created.metronomes ?? [] });
		ensureSectionIds(practices[practices.length - 1].metronomes);
		const p = practices[practices.length - 1];
		selectSection(p, p.metronomes[0]);
		renderBuilder();
		document.querySelector('.routine:last-of-type .routine-name')?.select();
	} catch {
		// withSync already reported it
	}
}

$('addPracticeBtn').onclick = addRoutine;

// Static icons in the markup.
$('bar-good').innerHTML = icons.check;
$('bar-bad').innerHTML = icons.cross;
$('bar-undo').innerHTML = icons.undo;
$('stop').replaceChildren(iconEl('back'), 'Exit');
$('undoBtn').replaceChildren(iconEl('undo'), 'Undo');
$('minus').innerHTML = icons.minus;
$('plus').innerHTML = icons.plus;
$('prevBtn').innerHTML = icons.prev;
$('nextBtn').innerHTML = icons.next;
document.querySelector('.ico-good').outerHTML = icons.check;
document.querySelector('.ico-bad').outerHTML = icons.cross;
renderPlayButton();

init();

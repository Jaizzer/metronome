// ============================================================
// main.js — app logic: auth flow, routine builder, audio engine,
// player, and the ✓/✗ record (buttons, foot pedal, undo).
// Persistence goes through db.js; gesture timing lives in pedal.js;
// tallies and the undo stack live in records.js.
// ============================================================
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import './style.css';
import { parseSpotifyLink, podcastShouldPlay, createPodcastPlayer, store as podStore, KEY_LINK, KEY_AUTO, KEY_CLICK } from './podcast.js';
import { createSpotifyRemote } from './spotify.js';
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
import { h, iconEl } from './dom.js';
import { createImporter } from './importer.js';
import { createTabPanel } from './tabpanel.js';
import { saveTab, deleteTab, tabRecord, routineTab } from './tabstore.js';
import { barRange, rangeText } from './slicer.js';
import {
	newAttemptId,
	mergeLog,
	songState,
	nextStep,
	chunkStatus,
	sessionStart,
	streak,
	dayKey,
	coldDoneToday,
	coldThreshold,
	checkCapFor,
} from './engine.js';

const $ = (id) => document.getElementById(id);

// h() and iconEl() live in dom.js (shared with the tab import modules).

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
	const text = state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved' : 'Synced';
	if (state === 'synced') el.replaceChildren(iconEl('cloud'), text);
	else el.textContent = text;
}

// Failed saves retry with backoff and only the first failure in a row
// shows a toast, so a dead connection doesn't bury the ✓/✗ flashes.
const BACKOFF_MS = [5000, 10000, 30000, 60000];
let failStreak = 0;
const retryDelay = () => BACKOFF_MS[Math.min(Math.max(failStreak, 1), BACKOFF_MS.length) - 1];

function isAuthError(e) {
	const text = `${e?.name ?? ''} ${e?.message ?? ''} ${e?.code ?? ''}`;
	return e?.status === 401 || /AuthRequired|Authentication required|JWT|PGRST301/i.test(text);
}

// Wraps a write with sync-indicator feedback. Never alert(): a modal
// dialog in the middle of a run would stop the practice.
async function withSync(promise) {
	savesInFlight++;
	setSyncIndicator('saving');
	try {
		const result = await promise;
		if (--savesInFlight === 0) setSyncIndicator('synced');
		failStreak = 0;
		return result;
	} catch (e) {
		savesInFlight--;
		failStreak++;
		console.error('Sync failed:', e);
		setSyncIndicator('error');
		if (isAuthError(e)) sessionLost();
		else if (failStreak === 1) toast('Couldn’t save. Your records are kept on this device; retrying.', 'error', 4000);
		throw e;
	}
}

// ✓/✗ counts are saved as deltas merged into the server's numbers, and
// routine edits with compare-and-swap, so two tabs/devices never
// overwrite each other's records (see sync.js).
const sync = createSync(
	{
		fetchPractice,
		casUpdatePractice,
		fetchTotals: fetchTotalsRow,
		casUpdateTotals,
		insertTotals,
	},
	(state) => persistPending(state),
);

// ---- Unsaved counts survive closing the tab ----
// Every change to the unsaved ✓/✗ counts is mirrored to localStorage under
// a per-tab key (per user). Each tab holds a Web Lock named after its key
// for as long as it lives; the browser releases it when the tab closes or
// crashes. Another load (or focus) for that user claims keys whose lock is
// free (or that are marked `closed`) and saves them.
// A tab whose key was claimed drops its in-memory copy instead of saving
// it, so counts are never applied twice. Nothing is sent on pagehide: a
// request whose answer never arrives can't be confirmed.
const PENDING_PREFIX = 'metronome:pending:';
const ORPHAN_AFTER_MS = 10 * 60 * 1000;
let tabKey = null;
let storageOk = false;

function lsGet(k) {
	try {
		return JSON.parse(localStorage.getItem(k));
	} catch {
		return null;
	}
}

function persistPending(state = sync.exportState(), closed = false) {
	if (!tabKey || !storageOk) return;
	try {
		if (sync.isEmptyState(state)) localStorage.removeItem(tabKey);
		else localStorage.setItem(tabKey, JSON.stringify({ beat: Date.now(), closed, state }));
	} catch {
		// quota/private mode: counts still save normally while the tab is open
	}
}

// False when another tab has claimed (and will save) our unsaved counts.
function ownsPending() {
	if (!storageOk || !tabKey) return true;
	return sync.isEmptyState(sync.exportState()) || lsGet(tabKey) !== null;
}

const hasLocks = Boolean(navigator.locks?.request);
let pendingUserId = null;

function takeOver(k) {
	const v = lsGet(k);
	localStorage.removeItem(k); // claim first, then take over the counts
	if (v?.state) sync.importState(v.state);
}

async function claimOrphans() {
	if (!storageOk || !tabKey || !pendingUserId) return;
	const prefix = `${PENDING_PREFIX}${pendingUserId}:`;
	let keys = [];
	try {
		keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix) && k !== tabKey);
	} catch {
		return;
	}
	let claimed = false;
	for (const k of keys) {
		const v = lsGet(k);
		if (!v || v.closed) {
			takeOver(k);
			claimed = true;
		} else if (hasLocks) {
			// Free lock = the owning tab is gone. Holding it while we take over
			// means the owner can't come back mid-claim.
			await navigator.locks.request(k, { ifAvailable: true }, (lock) => {
				if (lock && lsGet(k)) {
					takeOver(k);
					claimed = true;
				}
			});
		} else if (Date.now() - (v.beat ?? 0) > ORPHAN_AFTER_MS) {
			takeOver(k);
			claimed = true;
		}
	}
	if (claimed) scheduleCountFlushes();
}

async function startPendingStore(userId) {
	try {
		localStorage.setItem(PENDING_PREFIX + 'probe', '1');
		localStorage.removeItem(PENDING_PREFIX + 'probe');
		storageOk = true;
	} catch {
		storageOk = false;
	}
	pendingUserId = userId;
	tabKey = `${PENDING_PREFIX}${userId}:${crypto.randomUUID()}`;
	// Hold our key's lock for the life of this tab (released on close/crash).
	if (hasLocks) navigator.locks.request(tabKey, () => new Promise(() => {})).catch(() => {});
	await claimOrphans();
	persistPending();
}

// Heartbeat so a live tab's counts aren't mistaken for an orphan.
setInterval(() => {
	if (tabKey && !sync.isEmptyState(sync.exportState())) persistPending();
}, 60 * 1000);

function scheduleCountFlushes(delay = 300) {
	if (sync.pendingPracticeIds().length) debounce('practices', flushPractices, delay);
	if (sync.hasTotalsPending()) debounce('mastery', flushTotals, delay);
}

// Signed out or the session expired: keep the counts on this device for
// the next sign-in, and say so once.
function sessionLost() {
	if (!currentSession) return;
	persistPending(sync.exportState(), true); // claimable by the next sign-in
	tabKey = null;
	sync.dropCounts();
	for (const key of ['practices', 'mastery']) {
		clearTimeout(pendingSaves.get(key)?.timer);
		pendingSaves.delete(key);
	}
	if (view === 'player') stopEverything();
	recorder.clear();
	currentSession = null;
	setAuthMode('signin');
	showView('auth');
	$('auth-status').textContent = 'Your session ended. Sign in again; unsaved records are kept on this device.';
}

// One flush/refresh at a time from this tab.
let syncChain = Promise.resolve();
function serial(fn) {
	const run = syncChain.then(fn, fn);
	syncChain = run.catch(() => {});
	return run;
}

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

function noteAttempt(p, section, attempt) {
	if (!p?.id || !section?.id) return;
	sync.addAttempt(p.id, section.id, attempt);
	debounce('practices', flushPractices, 500);
}

function noteAttemptRemoved(p, section, attemptId) {
	if (!p?.id || !section?.id) return;
	sync.removeAttempt(p.id, section.id, attemptId);
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
		if (!currentSession || booting) return; // bootApp schedules a flush once routines are loaded
		if (!ownsPending()) return sync.dropCounts(); // another tab took them over
		// Counts for routines that no longer exist can't be saved anywhere.
		for (const id of sync.pendingPracticeIds()) if (!practices.some((p) => p.id === id)) sync.forget(id);
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
			if (currentSession) debounce('practices', flushPractices, retryDelay()); // deltas stay pending
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
		if (!currentSession || !sync.hasTotalsPending()) return;
		if (!ownsPending()) return sync.dropCounts();
		try {
			showTotals(await withSync(sync.flushTotals()));
			refreshViews();
		} catch {
			if (currentSession) debounce('mastery', flushTotals, retryDelay());
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
	await claimOrphans(); // a tab closed since we loaded may have left counts
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
			prepareAllSongSessions();
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
		persistPending();
		setKeepalive(true); // the page is still alive; give saves the best chance
		flushSaves();
	} else {
		setKeepalive(false);
		refreshFromServer();
	}
});
window.addEventListener('pagehide', () => {
	// Hand unsaved counts to the next load instead of sending them now.
	for (const key of ['practices', 'mastery']) {
		clearTimeout(pendingSaves.get(key)?.timer);
		pendingSaves.delete(key);
	}
	persistPending(sync.exportState(), true);
	setKeepalive(true);
	flushSaves(); // settings only: an idempotent upsert
});
window.addEventListener('pageshow', (e) => {
	if (!e.persisted || !tabKey) return; // back from the back/forward cache
	if (ownsPending()) {
		persistPending();
		scheduleCountFlushes();
	} else {
		sync.dropCounts();
	}
});
window.addEventListener('focus', refreshFromServer);
window.addEventListener('online', () => scheduleCountFlushes(0));

// ---------------- Views + toast ----------------

const VIEWS = ['auth', 'verify', 'builder', 'player', 'importer', 'tabplayer'];
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
	// In the Tab player it sits over the score, under the top bar and the
	// chips / Tracks row, so Exit and the chips stay uncovered.
	let top = '';
	if (view === 'tabplayer') {
		const bottoms = ['#tabplayer .player-top', '#tabplayer .tp-top'].map((s) => document.querySelector(s)?.getBoundingClientRect()).filter((r) => r && r.height > 0).map((r) => r.bottom);
		if (bottoms.length) top = `${Math.round(Math.max(...bottoms) + 8)}px`;
	}
	el.style.top = top;
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
	await serial(() => {}); // let queued saves finish while still signed in
	persistPending(sync.exportState(), true); // anything unsaved waits for the next sign-in
	tabKey = null;
	await signOut();
	location.reload();
};

async function bootApp(session) {
	if (currentSession || booting) return;
	booting = true;
	currentSession = session;
	// Pick up counts a closed tab (or an expired session) left unsaved.
	await startPendingStore(session?.user?.id ?? 'anon');
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
		for (const p of practices) {
			p.metronomes = reconcileSections(p.metronomes, p.metronomes.map((m) => ({ ...m })), sync.pendingFor(p.id), true);
		}
		showTotals({ s: masteryCounts.success, f: masteryCounts.fail });
		prepareAllSongSessions();
		scheduleCountFlushes();
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
	slideIndex = Math.max(0, practices.findIndex((p) => p.id === selectedPracticeId));
	renderBuilder();
	applyStatsVisibility();
	$('volumeSlider').value = metVolume;
	updateVolumeLabel();
	booting = false;
}

async function init() {
	onAuthChange((session) => {
		if (session && !currentSession) bootApp(session);
		if (!session && currentSession) sessionLost();
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
// bpm: the tempo the run was played at (live tempo while playing).
// In the Tab player: its selected chunk or the chunk under the cursor at its
// speed (docs/TAB-PRACTICE.md); `none` when there is none (nothing records).
function currentTarget() {
	if (view === 'tabplayer' && tabPlayerFor) {
		const t = tabPlayer?.target?.() ?? null;
		const section = t ? tabPlayerFor.metronomes[t.index] : null;
		return section ? { practice: tabPlayerFor, section, bpm: t.bpm } : { practice: tabPlayerFor, section: null, bpm: null, none: true };
	}
	if (view === 'player' && activePractice && activeMetIndex >= 0) {
		return { practice: activePractice, section: activePractice.metronomes[activeMetIndex] ?? null, bpm: currentBPM };
	}
	const p = practices.find((x) => x.id === selectedPracticeId) || practices[0];
	if (!p) return null;
	const section = p.metronomes.includes(selectedSection) ? selectedSection : (p.metronomes[0] ?? null);
	return { practice: p, section, bpm: section?.startBPM ?? null };
}

// ---------------- Song mode (docs/PRACTICE-ALGORITHM.md, src/engine.js) ----------------
// Routine settings are mirrored on every section as `song: { on, target }`
// (the row has no other place for them); read from the first section that
// has them, written to all.

const songOf = (p) => p?.metronomes?.find((m) => m.song)?.song ?? null;
const isSong = (p) => Boolean(songOf(p)?.on);
const songTarget = (p) => songOf(p)?.target ?? null;
const isRun = (m) => (m?.kind ?? 'chunk') === 'run';
const songNow = (p) => songState(p.metronomes, songTarget(p));

function setSong(p, patch) {
	const next = { on: false, target: null, ...songOf(p), ...patch };
	for (const m of p.metronomes) m.song = { ...next };
	savePractice(p);
}

const playingSection = () => (view === 'player' && activePractice ? activePractice.metronomes[activeMetIndex] : null);

// A short two-note cue for a tempo change, only if the click (or the Tab
// player's playback) is running.
function cueTone(dir) {
	if (view === 'tabplayer' && !tabPlayer?.playing) return;
	if (!audioCtx || audioCtx.state !== 'running') return;
	const t = audioCtx.currentTime + 0.02;
	const [a, b] = dir === 'up' ? [660, 990] : [990, 660];
	const osc = audioCtx.createOscillator();
	const gain = audioCtx.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(a, t);
	osc.frequency.setValueAtTime(b, t + 0.09);
	gain.gain.setValueAtTime(Math.max(0.0001, Math.min(0.5, metVolume * 0.25)), t);
	gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
	osc.connect(gain);
	gain.connect(clickBus ?? audioCtx.destination);
	osc.start(t);
	osc.stop(t + 0.25);
}

// After an attempt on a chunk: climb/drop the tempo, prompt a shrink, join
// the song (engine.nextStep decides). Returns a toast message or null.
// Undo doesn't revert these.
const STEP_MSG = {
	up: (to) => `↑ ${to} BPM · 2 ✓ in a row`,
	down: (to) => `↓ ${to} BPM · 4 ✗ in a row`,
	'cold-miss': (to) => `↓ ${to} BPM · missed the daily check`,
};

function afterAttempt(p, m, attempt) {
	const r = nextStep(m, p.metronomes, songTarget(p), attempt);
	const msgs = [];
	let changed = false;
	if (STEP_MSG[r.action]) {
		m.startBPM = r.to;
		changed = true;
		if (playingSection() === m) {
			currentBPM = r.to;
			isRamping = false;
			adjustBPMDisplay();
		}
		cueTone(r.action === 'up' ? 'up' : 'down');
		msgs.push(STEP_MSG[r.action](r.to));
	} else if (r.action === 'shrink') {
		msgs.push('2 ✗ in a row · try half the chunk');
	}
	if (r.join) {
		m.joined = true;
		changed = true;
		msgs.push(`Joined the song at ${r.owned} BPM`);
	}
	if (changed) savePractice(p);
	return msgs.length ? msgs.join(' · ') : null;
}

// A new day: each practised chunk starts at its probe tempo (yesterday's top
// ✓, capped) so the builder shows the tempo the player will use and the
// day's first attempt is the cold check. Once per section per day (per tab),
// and never after it was played today, so a manual change sticks.
const sessionPrepared = new Set();

function prepareSongSession(p) {
	if (!isSong(p) || p === activePractice) return false;
	const song = songNow(p);
	const today = dayKey(Date.now());
	let changed = false;
	for (const m of p.metronomes) {
		const key = `${p.id}:${m.id}:${today}`;
		if (isRun(m) || sessionPrepared.has(key)) continue;
		sessionPrepared.add(key);
		const log = m.log ?? [];
		if (!log.length || log.some((a) => dayKey(a.t) === today)) continue;
		const start = sessionStart(m, song);
		if (start !== m.startBPM) {
			m.startBPM = start;
			changed = true;
		}
	}
	if (changed) savePractice(p);
	return changed;
}

function prepareAllSongSessions() {
	let changed = false;
	for (const p of practices) if (prepareSongSession(p)) changed = true;
	return changed;
}

// The day can change while the app stays open.
setInterval(() => {
	if (currentSession && !booting && prepareAllSongSessions()) refreshViews();
}, 60 * 1000);

// ---------------- Recording ✓ / ✗ ----------------

// target: captured when the pedal was pressed (so a section change during
// the double-tap window can't steal the record); defaults to "now".
function record(kind, target = currentTarget()) {
	// The Tab player with no chunk to record to: nothing is counted.
	if (target?.none) return toast('Select a chunk to record', '', 1800);
	const entry = recorder.record(kind, target);
	noteSectionStats(target?.practice, target?.section, kind, 1);
	noteTotals(kind, 1);

	// Song mode: every run is also an attempt in the section's log.
	let songMsg = null;
	const { practice: p, section: m } = target ?? {};
	if (m && isSong(p) && p.metronomes.includes(m)) {
		const attempt = { id: newAttemptId(), t: Date.now(), k: kind, bpm: target.bpm ?? m.startBPM };
		entry.attemptId = attempt.id;
		m.log = mergeLog(m.log ?? [], [attempt]);
		noteAttempt(p, m, attempt);
		songMsg = afterAttempt(p, m, attempt);
	}
	refreshStats();

	const good = kind === 's';
	strike(good ? 'success-zone' : 'fail-zone', 'is-struck', 450);
	strike(good ? 'bar-good' : 'bar-bad', 'is-struck', 450);
	if (view === 'tabplayer') tabPlayer?.refresh(); // live speed + record line
	if (songMsg) return toast(songMsg, '', 2200);
	const where = m?.name ? ` · ${m.name}` : '';
	toast(`${good ? '✓ Good run' : '✗ Bad run'}${where}`, good ? 'good' : 'bad');
}

function undoLast() {
	// A ✓ still waiting out the double-tap window is the newest record:
	// cancel it instead of undoing the one before it.
	if (pedal.cancelPending()) {
		cancelPendingToast();
		return;
	}
	const entry = recorder.undo();
	if (!entry) {
		toast('Nothing to undo');
		return;
	}
	if (!entry.sectionGone) noteSectionStats(entry.practice, entry.section, entry.kind, -1);
	// Removes the attempt; a tempo change it caused stays (see docs).
	if (entry.attemptId && !entry.sectionGone) {
		entry.section.log = (entry.section.log ?? []).filter((a) => a.id !== entry.attemptId);
		noteAttemptRemoved(entry.practice, entry.section, entry.attemptId);
	}
	noteTotals(entry.kind, -1);
	refreshStats();
	if (view === 'tabplayer') tabPlayer?.refresh();

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

let pedalPending = false;
// Undo is possible with a saved record or a ✓ still pending.
const canUndo = () => recorder.size > 0 || pedalPending;

const pedal = createPedal({
	capture: () => currentTarget(),
	onGood: (target) => record('s', target),
	onBad: (target) => record('f', target),
	onUndo: ({ cancelledPending }) => (cancelledPending ? cancelPendingToast() : undoLast()),
	onPending: (on) => {
		pedalPending = on;
		tabPlayer?.pending(on);
		$('undoBtn').disabled = !canUndo();
		$('bar-undo').disabled = !canUndo();
		for (const id of ['pedal-pending', 'bar-pending']) {
			const el = $(id);
			el.hidden = !on; // un-hiding restarts the shrinking dot that times the window
		}
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

// Controls where Enter already means something (activate / submit).
// With focus on one of these, Enter is the keyboard's, not the pedal's.
function isInteractiveTarget(el) {
	return Boolean(
		el?.closest?.(
			'button, a[href], input, select, textarea, summary, [contenteditable=""], [contenteditable="true"], [role=button], [role=switch], [role=link], [role=checkbox], [role=menuitem]',
		),
	);
}

window.addEventListener('keydown', (e) => {
	if (!currentSession || $('modal').open) return;
	// The import screen is a form: Enter keeps its normal meaning, Escape leaves.
	if (view === 'importer') {
		if (e.key === 'Escape' && !e.target.closest?.('details[open] textarea')) importer.close();
		return;
	}
	// The Tab player: Space plays/pauses, the pedal's Enter records ✓/✗/undo
	// to its chunk (docs/TAB-PRACTICE.md), Cmd/Ctrl+Z undoes.
	if (view === 'tabplayer') {
		if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !isTypingTarget(e.target)) {
			e.preventDefault();
			if (!e.repeat) undoLast();
			return;
		}
		const action = tabPlayer ? tabPlayer.keydown(e) : e.key === 'Escape' ? 'exit' : null;
		if (action === 'exit') closeTabPlayer();
		else if (action === 'pedal') {
			if (audioCtx) initAudio(); // a key press may resume it, for the tempo tone
			else if (tabPlayer.playing) initAudio();
			pedal.keydown(e);
		}
		return;
	}

	// Foot pedal (sends Enter). Handled on keydown + keyup in pedal.js.
	if (e.key === 'Enter') {
		if (isInteractiveTarget(e.target)) return;
		e.preventDefault();
		pedal.keydown(e);
		return;
	}
	if (isTypingTarget(e.target)) return;
	if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
		e.preventDefault();
		if (!e.repeat) undoLast();
		return;
	}
	if (view !== 'player') return;
	const onRange = e.target?.type === 'range';
	if (e.key === ' ' && !(e.target instanceof HTMLButtonElement) && !e.target?.closest?.('summary') && !onRange) {
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

// A mouse/touch click leaves focus on a button (or a <details> summary),
// which would swallow the next pedal press (Enter would re-click it) or
// Space. After any pointer click, whatever button-like control holds focus
// is blurred: the clicked one, its re-drawn copy (keepFocus after Loop,
// Song mode, Ramp, Chunk | Run), or one whose icon was swapped out from
// under the pointer (Play/Pause). Controls inside an open dialog keep
// focus. Keyboard clicks (detail 0) keep focus where it is.
const FOCUS_HOLDERS = 'button, summary, [role=button], [role=switch]';
document.addEventListener('click', (e) => {
	if (e.detail === 0) return;
	const el = document.activeElement;
	if (el?.matches?.(FOCUS_HOLDERS) && !el.closest('dialog[open]')) el.blur();
});

// After editing a field (Enter, or the value committed), hand focus back so
// the pedal works again. The auth forms are left alone.
document.addEventListener('keydown', (e) => {
	if (e.key !== 'Enter' || e.repeat) return;
	const input = e.target.closest?.('#app input, #player input');
	if (!input) return;
	e.preventDefault();
	input.blur(); // fires change
});
document.addEventListener('change', (e) => {
	const input = e.target.closest?.('#app input, #player input');
	if (input && document.activeElement === input) input.blur();
});

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

// All-time ✓/✗: one quiet line under the builder heading, and beside
// "Reset all-time" in the player's settings.
function renderAlltime() {
	const line = () => [
		'All-time ',
		h('b', { class: 'g' }, `✓ ${totals.s}`),
		' ',
		h('b', { class: 'b' }, `✗ ${totals.f}`),
		' · ',
		h('b', {}, formatAccuracy(totals)),
	];
	$('alltime').replaceChildren(...line());
	$('player-alltime').replaceChildren(...line());
}

function refreshStats() {
	renderAlltime();
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

let clickBus = null;
let clickGain = 1;
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
	mixWithOtherAudio();
	if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	if (audioCtx.state === 'suspended') audioCtx.resume();
	if (!clickBus) {
		// Click output: gain (0–200%) -> limiter -> speakers, so 200% doesn't clip.
		clickBus = audioCtx.createGain();
		clickBus.gain.value = clickGain;
		const lim = audioCtx.createDynamicsCompressor();
		lim.threshold.value = -6;
		lim.knee.value = 0;
		lim.ratio.value = 20;
		lim.attack.value = 0.001;
		lim.release.value = 0.1;
		clickBus.connect(lim);
		lim.connect(audioCtx.destination);
	}
}

// iOS: 'ambient' lets the click mix with Spotify instead of stopping it.
function mixWithOtherAudio() {
	try {
		if (navigator.audioSession) navigator.audioSession.type = 'ambient';
	} catch {
		/* unsupported */
	}
}

function playClick(time, accented) {
	const osc = audioCtx.createOscillator();
	const gain = audioCtx.createGain();
	osc.type = 'triangle';
	osc.frequency.setValueAtTime(accented ? 1600 : 900, time);
	gain.gain.setValueAtTime(Math.max(0.0001, metVolume), time);
	gain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
	osc.connect(gain);
	gain.connect(clickBus ?? audioCtx.destination);
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
		if (!tabPanel.alongPlaying) playClick(tickTime, beat === 0); // with "Play with metronome", alphaTab clicks
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
	const ramp = met.ramp && !isSong(activePractice); // song mode plays every section at its tempo
	sectionStartBPM = met.startBPM;
	sectionEndBPM = ramp ? met.endBPM || met.startBPM : met.startBPM;
	isRamping = Boolean(ramp && met.endBPM && met.endBPM !== met.startBPM);
	currentBPM = sectionStartBPM;
	timeLeftInSection = met.duration;
	totalSectionTime = met.duration;
	adjustBPMDisplay();
	updatePlayerUI();
	podcastOverride = false;
	syncPodcast();
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

let onTempoChange = null; // set once the Tab panel exists ("Play with metronome" follows the tempo)
function adjustBPMDisplay() {
	currentBPM = Math.round(Math.max(20, Math.min(300, currentBPM)));
	onTempoChange?.(currentBPM);
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
	updateSongLine();
}

function togglePause() {
	isPaused = !isPaused;
	// The click and "Hear it" never play together; "Play with metronome" follows Play/Pause.
	if (!isPaused) {
		if (tabPanel.wantsAlong()) tabPanel.resumeAlong();
		else tabPanel.stop();
	} else tabPanel.pauseAlong();
	if (!isPaused && audioCtx) nextTickTime = audioCtx.currentTime + 0.05; // no catch-up burst
	renderPlayButton();
	if (isPaused) lightUpDot(-1);
	syncPodcast();
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
		met.ramp && !isSong(activePractice) && met.endBPM && met.endBPM !== met.startBPM
			? `BPM · ramp ${met.startBPM} → ${met.endBPM}`
			: 'BPM';

	const next = list[activeMetIndex + 1] || (activePractice.loop ? list[0] : null);
	$('upcoming-details').textContent = next
		? `Next: ${next.name} · ${next.startBPM} BPM · ${formatClock(next.duration)}${list[activeMetIndex + 1] ? '' : ' (loop)'}`
		: 'Last section';
	$('prevBtn').disabled = activeMetIndex === 0;
	tabPanel.update(activePractice, met);

	renderStops();
	updateTally();
}

// The stop strip: one dot per section while they fit (about 28px each);
// longer routines get "Section n / N" and a thin bar instead, so nothing in
// the player is wider than the screen. Prev / Next stay in the transport.
const STOP_MIN_PX = 28; // 24px dot + a short connecting line
let stopsRecheck = 0;
function renderStops() {
	if (!activePractice || activeMetIndex < 0) return;
	const list = activePractice.metronomes;
	const width = $('stops').parentElement.clientWidth;
	// Not laid out yet (player just shown): decide again on the next frame.
	if (!width) {
		cancelAnimationFrame(stopsRecheck);
		stopsRecheck = requestAnimationFrame(renderStops);
	}
	// Every dot needs STOP_MIN_PX, plus a little for the larger current dot.
	const compact = !width ? list.length > 12 : list.length * STOP_MIN_PX + 8 > width;
	if (!compact) renderStopDots(list);
	$('stops').hidden = compact;
	$('stops-compact').hidden = !compact;
	if (compact) {
		$('stops').replaceChildren();
		const n = list.length;
		$('stops-pos').replaceChildren('Section ', h('b', {}, String(activeMetIndex + 1)), ` / ${n}`);
		$('stops-done').style.width = `${(activeMetIndex / n) * 100}%`;
		$('stops-cur').style.left = `${(activeMetIndex / n) * 100}%`;
		$('stops-cur').style.width = `${100 / n}%`;
	}
}

function renderStopDots(list) {
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
}

addEventListener('resize', () => view === 'player' && renderStops());

function updateTally() {
	if (!activePractice || activeMetIndex < 0) return;
	const sec = sectionStats(activePractice.metronomes[activeMetIndex]);
	const rt = routineStats(activePractice);
	$('success-count').textContent = sec.s;
	$('fail-count').textContent = sec.f;
	$('tally-foot').replaceChildren(
		h('span', {}, 'Section ', h('b', {}, formatAccuracy(sec))),
		h('span', {}, 'Routine ', h('b', {}, formatAccuracy(rt))),
	);
	$('undoBtn').disabled = !canUndo();
	updateSongLine();
	syncPodcast();
}

// One line under the beats in song mode: what the next attempt is for.
// bpm: the tempo of the next attempt (the Tab player passes its own).
function songLineText(p, m, currentBPM = currentBPMNow()) {
	if (isRun(m)) return 'Run · tap ✗ and keep playing';
	const log = m.log ?? [];
	const song = songNow(p);
	const cc = checkCapFor(m, song);
	if (!coldDoneToday(log, Date.now(), cc)) {
		const min = coldThreshold(log, dayKey(Date.now()), cc);
		return min !== null && currentBPM < min
			? `Warm-up · daily check from ${min} BPM`
			: 'First try today · this is your daily check';
	}
	const cap = cc; // the same cap as the daily check and the ladder
	if (currentBPM >= cap) return `Work · at the cap (${cap} BPM)`;
	const st = streak(log, currentBPM);
	if (st.kind === 's') return `Work · ${Math.max(1, 2 - st.n)} more ✓ to go up`;
	if (st.kind === 'f') return `Work · ✗ ${st.n} in a row`;
	return 'Work · 2 ✓ in a row to go up';
}

function currentBPMNow() {
	return currentBPM;
}

function updateSongLine() {
	const el = $('song-line');
	const m = playingSection();
	const on = Boolean(m && isSong(activePractice));
	el.hidden = !on;
	// Each phrase stays whole; the line only wraps at a "·".
	if (on) {
		const parts = songLineText(activePractice, m).split(' · ');
		el.replaceChildren(...parts.flatMap((t, i) => [i ? ' · ' : '', h('span', {}, t)]));
	}
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

function startRoutine(p, index = 0) {
	if (!p.metronomes.length) return toast('Add a section first');
	initAudio();
	prepareSongSession(p);
	activePractice = p;
	isPaused = false;
	renderPlayButton();
	showView('player');
	runSection(index);
	requestWakeLock();
	// Focus somewhere neutral: Enter (the pedal) must record, not press a button.
	$('player-title').focus();
}

function stopEverything({ finished = false } = {}) {
	tabPanel.close();
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
	syncPodcast();
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

// How the last click happened (pointer or keyboard), so a dialog knows
// whether its opener should keep focus when it closes.
let lastClickByPointer = false;
document.addEventListener('click', (e) => (lastClickByPointer = e.detail > 0), true);

function openDialog(title, ...content) {
	$('modal-title').textContent = title;
	$('modal-content').replaceChildren(...content);
	if (!modal.open) {
		modal._byPointer = lastClickByPointer;
		modal.showModal();
	}
}

function closeDialog() {
	if (modal.open) modal.close();
}

modal.addEventListener('click', (e) => {
	if (e.target === modal) closeDialog(); // click on the backdrop
});

// Closing returns focus to the opener (Remove, Reset, Delete, the length
// button). If a pointer opened the dialog, drop that focus so the next
// pedal Enter records instead of reopening it; keyboard users keep it.
modal.addEventListener('close', () => {
	const el = document.activeElement;
	if (modal._byPointer && el?.matches?.(FOCUS_HOLDERS)) el.blur();
});

function confirmDialog({ title, text, confirm, onConfirm, danger = true }) {
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
					class: danger ? 'btn btn-danger' : 'btn btn-primary',
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

// Progressive disclosure: one section is open for editing at a time, and
// each routine's options open on demand; both survive re-renders.
let openSectionId = null;
const openOptions = new Set();

// Long routines show a window of parts; "Show all" is remembered per device.
const LONG_ROUTINE = 8;
const WINDOW_ROWS = 6;
const EXPANDED_KEY = 'metronome:expanded-routines';
const expandedRoutines = new Set(lsGet(EXPANDED_KEY) ?? []);
function setExpanded(p, on) {
	if (on) expandedRoutines.add(p.id);
	else expandedRoutines.delete(p.id);
	try {
		localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedRoutines]));
	} catch {
		// private mode: just not remembered
	}
	renderBuilder();
}

// The rows a long routine shows: around the open or selected part.
function visibleRows(p) {
	const n = p.metronomes.length;
	if (n <= LONG_ROUTINE || expandedRoutines.has(p.id)) return { from: 0, to: n };
	let focus = p.metronomes.findIndex((m) => m.id === openSectionId);
	if (focus < 0 && p.id === selectedPracticeId) focus = p.metronomes.indexOf(selectedSection);
	const from = Math.max(0, Math.min(Math.max(focus, 0) - 2, n - WINDOW_ROWS));
	return { from, to: Math.min(n, from + WINDOW_ROWS) };
}

const STATE_LABEL = { new: '○ New', joined: '● Joined', bottleneck: '▼ Bottleneck', run: '→ Run' };

function shortDate(key) {
	const [y, mo, d] = key.split('-').map(Number);
	return new Date(y, mo - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// The short status on a song section's row: its state, plus "Due today".
const songRowStatus = (cs) => [STATE_LABEL[cs.state], cs.due && 'Due today'].filter(Boolean).join(' · ');

// Inside an open song section: owned tempo, band, next review, attempts,
// plateau advice, and the Chunk | Run choice.
function songDetailsEl(p, m, cs) {
	const facts = [];
	if (Array.isArray(m.bars)) {
		const r = m.range ? rangeText(m.range) : barRange(m.bars[0], m.bars[1]);
		facts.push(`${m.seam ? 'Seam, ' + r : r[0].toUpperCase() + r.slice(1)}${m.dense ? ' · likely bottleneck' : ''}`);
	}
	if (cs.state !== 'run') facts.push(cs.owned === null ? 'Owned –' : `Owned ${cs.owned} BPM`);
	facts.push(cs.band === null ? 'Band –' : `Band ${Math.round(cs.band * 100)}%`);
	const review = cs.state === 'run' || cs.due ? null : cs.review ? `Next review ${shortDate(cs.review)}` : 'Review starts once owned';
	if (review) facts.push(review);
	facts.push(`${cs.attempts} ${cs.attempts === 1 ? 'attempt' : 'attempts'}`);
	return h(
		'div',
		{ class: 'sec-song' },
		h('p', {}, facts.join(' · ')),
		cs.plateau && cs.state !== 'run' && h('p', { class: 'sec-advice' }, 'Plateau · film your hands, check tension'),
		h(
			'div',
			{ class: 'seg sec-kind', role: 'group', 'aria-label': `${m.name}: chunk or run` },
			[
				['chunk', 'Chunk', 'Work on it: stop at a ✗; the tempo climbs'],
				['run', 'Run', 'Play-through: tap ✗ and keep playing; the tempo stays'],
			].map(([kind, label, title]) =>
				h(
					'button',
					{
						class: 'seg-btn',
						type: 'button',
						title,
						'aria-pressed': String((m.kind ?? 'chunk') === kind),
						onclick: () => {
							if ((m.kind ?? 'chunk') === kind) return;
							m.kind = kind;
							savePractice(p);
							renderBuilder({ keepFocus: true });
						},
					},
					label,
				),
			),
		),
	);
}

function setSectionOpen(li, open) {
	li.classList.toggle('is-open', open);
	li.querySelector('.sec-open').setAttribute('aria-expanded', String(open));
	li.querySelector('.sec-panel').hidden = !open;
}

function toggleSection(li, m) {
	const open = openSectionId !== m.id;
	document.querySelectorAll('#app .sec.is-open').forEach((el) => setSectionOpen(el, false));
	openSectionId = open ? m.id : null;
	if (open) setSectionOpen(li, true);
}

// The row's tempo: "60", or "60→80" with a small arrow when it ramps.
function fillTempo(el, m, song) {
	const ramps = !song && m.ramp && m.endBPM && m.endBPM !== m.startBPM;
	el.replaceChildren(
		String(m.startBPM),
		...(ramps ? [h('i', { 'aria-hidden': 'true' }, '→'), h('span', { class: 'sr-only' }, ' to '), String(m.endBPM)] : []),
	);
}

function bpmInput(props) {
	return h('input', { type: 'number', min: '20', max: '300', step: '1', inputmode: 'numeric', ...props });
}

// A section is one calm row (name, tempo, length, song status); tapping it
// opens its editing panel (name, tempo, ramp, length, ✓/✗, song details,
// move, remove). Tapping a row also makes it the section the pedal records to.
function renderSection(p, pIdx, m, mIdx, song = null) {
	const st = sectionStats(m);
	const cs = song ? chunkStatus(m, song) : null;
	const open = openSectionId === m.id;
	const panelId = `sec-panel-${pIdx}-${mIdx}`;
	const li = h('li', {
		class: `sec${song ? ' is-song' : ''}${open ? ' is-open' : ''}${m === currentTarget()?.section ? ' is-selected' : ''}`,
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

	const rowName = h('span', { class: 'sec-label' }, m.name);
	const rowTempo = h('b');
	fillTempo(rowTempo, m, song);
	const head = h(
		'button',
		{
			class: 'sec-open',
			type: 'button',
			'aria-expanded': String(open),
			'aria-controls': panelId,
			onclick: () => toggleSection(li, m),
		},
		h('span', { class: 'sec-title' }, rowName, cs && h('span', { class: 'sec-status' }, songRowStatus(cs))),
		h('span', { class: 'sec-tempo' }, rowTempo, h('small', {}, 'BPM')),
		h('span', { class: 'sec-len' }, formatDuration(m.duration)),
		h('span', { class: 'chev', 'aria-hidden': 'true' }),
	);
	// Field edits update the row in place (a re-render here could swallow
	// the click that moved focus away).
	const syncRow = () => {
		rowName.textContent = m.name;
		fillTempo(rowTempo, m, song);
	};

	const grip = h(
		'button',
		{
			class: 'grip btn btn-quiet',
			type: 'button',
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
		},
		iconEl('grip'),
		'Move',
	);
	grip.addEventListener('touchstart', (e) => onTouchDragStart(e, pIdx, mIdx), { passive: false });

	const fields = h(
		'div',
		{ class: 'sec-fields' },
		h(
			'label',
			{ class: 'mini' },
			bpmInput({
				class: 'tempo-input',
				value: String(m.startBPM),
				'aria-label': `${m.name} tempo (BPM)`,
				onchange: (e) => {
					m.startBPM = clampBPM(e.target.value, m.startBPM);
					e.target.value = m.startBPM;
					savePractice(p);
					syncRow();
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
			iconEl('clock'),
			formatDuration(m.duration),
		),
		!song &&
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
						renderBuilder({ keepFocus: true });
					},
				},
				iconEl('ramp'),
				'Ramp',
			),
		!song &&
			m.ramp &&
			h(
				'label',
				{ class: 'mini' },
				'to',
				bpmInput({
					class: 'end-input',
					value: String(m.endBPM || m.startBPM),
					'aria-label': `${m.name} end tempo (BPM)`,
					onchange: (e) => {
						m.endBPM = clampBPM(e.target.value, m.endBPM || m.startBPM);
						e.target.value = m.endBPM;
						savePractice(p);
						syncRow();
					},
				}),
				'BPM',
			),
	);

	const remove = h(
		'button',
		{
			class: 'sec-remove btn btn-quiet',
			type: 'button',
			'aria-label': `Remove section ${m.name}`,
			onclick: (e) => {
				e.stopPropagation();
				const doRemove = () => {
					const i = p.metronomes.indexOf(m);
					if (i >= 0) p.metronomes.splice(i, 1);
					savePractice(p);
					renderBuilder();
				};
				if (st.s + st.f === 0) return doRemove();
				confirmDialog({
					title: 'Remove section?',
					text: `“${m.name}” has ✓ ${st.s} / ✗ ${st.f} recorded. Removing it deletes those stats. Your all-time total is kept.`,
					confirm: 'Remove',
					onConfirm: doRemove,
				});
			},
		},
		iconEl('trash'),
		'Remove',
	);

	const panel = h(
		'div',
		{ class: 'sec-panel', id: panelId, hidden: !open },
		h('input', {
			class: 'sec-name',
			type: 'text',
			value: m.name,
			'aria-label': 'Section name',
			onchange: (e) => {
				m.name = e.target.value.trim() || 'Section';
				e.target.value = m.name;
				savePractice(p);
				syncRow();
				renderRecordBar();
			},
		}),
		fields,
		h('p', { class: 'sec-tally' }, 'Runs', tallyInline(st)),
		cs && songDetailsEl(p, m, cs),
		h(
			'div',
			{ class: 'sec-actions' },
			h(
				'button',
				{ class: 'btn btn-quiet start-here', type: 'button', onclick: () => startRoutine(p, mIdx) },
				iconEl('play'),
				'Start here',
			),
			grip,
			remove,
		),
	);

	li.append(head, panel);
	return li;
}

// One summary line for a song-mode routine: song tempo first, then what's
// due; the bottleneck (also marked on its row) goes last, where truncation
// costs least. A tempo above a lowered target says so instead of a % > 100.
function songSummary(p, song) {
	const target = songTarget(p);
	const due = p.metronomes.filter((m) => chunkStatus(m, song).due).map((m) => m.name);
	const dueText = due.length ? `Due today: ${due.slice(0, 2).join(', ')}${due.length > 2 ? ` +${due.length - 2}` : ''}` : null;
	let tempoText;
	if (song.tempo === null) tempoText = 'Song tempo: not set yet · own a chunk on 2 days';
	else if (target && song.tempo > target) tempoText = `Song tempo ${song.tempo} · above target ${target}`;
	else if (song.pct !== null) tempoText = `Song tempo ${song.tempo} · ${song.pct}% of ${target}`;
	else tempoText = `Song tempo ${song.tempo}`;
	const parts = [tempoText, dueText, song.tempo !== null && song.bottleneck ? `Bottleneck: ${song.bottleneck.name}` : null];
	const text = parts.filter(Boolean).join(' · ');
	return h('p', { class: 'song-sum', title: text }, iconEl('song'), h('span', {}, text));
}

function targetField(p) {
	const target = songTarget(p);
	return h(
		'label',
		{ class: 'mini song-bar' },
		iconEl('target'),
		'Target',
		bpmInput({
			class: 'target-input',
			placeholder: '–',
			value: target === null ? '' : String(target),
			'aria-label': `${p.name} target tempo (BPM)`,
			onchange: (e) => {
				const v = e.target.value.trim();
				setSong(p, { target: v === '' ? null : clampBPM(v, target ?? 120) });
				renderBuilder({ keepFocus: true });
			},
		}),
		'BPM',
	);
}

function renderRoutine(p, pIdx) {
	const rt = routineStats(p);
	const totalTime = p.metronomes.reduce((a, m) => a + (m.duration || 0), 0);
	const songOn = isSong(p);
	const song = songOn ? songNow(p) : null;
	const optsOpen = openOptions.has(p.id);
	const optsId = `routine-opts-${pIdx}`;
	const n = p.metronomes.length;

	const loopSwitch = h(
		'button',
		{
			class: 'loop-switch switch',
			type: 'button',
			role: 'switch',
			'aria-checked': String(Boolean(p.loop)),
			onclick: () => {
				p.loop = !p.loop;
				savePractice(p);
				renderBuilder({ keepFocus: true });
			},
		},
		h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
		iconEl('loop'),
		'Loop',
	);
	const songSwitch = h(
		'button',
		{
			class: 'song-switch switch',
			type: 'button',
			role: 'switch',
			'aria-checked': String(songOn),
			disabled: !n,
			title: 'Song mode: tempo ladder, owned tempo and reviews per section',
			onclick: () => {
				setSong(p, { on: !songOn });
				renderBuilder({ keepFocus: true });
			},
		},
		h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
		iconEl('song'),
		'Song mode',
	);

	const playable = routineTab(p)?.format === 'score';
	const options = h(
		'div',
		{ class: 'routine-options', id: optsId, hidden: !optsOpen },
		playable &&
			h(
				'div',
				{ class: 'opt-row' },
				h('button', { class: 'play-tab btn', type: 'button', onclick: () => openTabPlayer(p) }, iconEl('tab'), 'Play tab'),
			),
		h('div', { class: 'opt-row' }, loopSwitch, songSwitch, songOn && targetField(p)),
		h(
			'div',
			{ class: 'opt-row' },
			h(
				'button',
				{
					class: 'reset-btn btn btn-quiet',
					type: 'button',
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
				},
				iconEl('reset'),
				'Reset stats',
			),
			h(
				'button',
				{ class: 'delete-btn btn btn-quiet', type: 'button', onclick: () => openDeleteDialog(p) },
				iconEl('trash'),
				'Delete routine',
			),
		),
	);
	const optsBtn = h(
		'button',
		{
			class: 'opts-btn btn btn-quiet',
			type: 'button',
			'aria-expanded': String(optsOpen),
			'aria-controls': optsId,
			onclick: () => {
				const next = !openOptions.has(p.id);
				if (next) openOptions.add(p.id);
				else openOptions.delete(p.id);
				optsBtn.setAttribute('aria-expanded', String(next));
				options.hidden = !next;
			},
		},
		iconEl('sliders'),
		'Options',
	);

	return h(
		'article',
		{ class: 'routine', 'aria-label': p.name, 'data-pidx': pIdx },
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
				{ class: 'head-actions' },
				n > LONG_ROUTINE &&
					h(
						'button',
						{ class: 'btn btn-primary head-start', type: 'button', onclick: () => startRoutine(p) },
						iconEl('play'),
						'Start',
					),
				optsBtn,
			),
			h(
				'p',
				{ class: 'routine-meta' },
				h('span', {}, `${n} ${n === 1 ? 'section' : 'sections'} · ${formatDuration(totalTime)}${p.loop ? ' · Loop' : ''}`),
				rt.s + rt.f > 0 && tallyInline(rt),
			),
			songOn && songSummary(p, song),
			options,
		),
		(() => {
			const { from, to } = visibleRows(p);
			const rows = p.metronomes.slice(from, to).map((m, i) => renderSection(p, pIdx, m, from + i, song));
			return h('ol', { class: 'sections', start: String(from + 1) }, rows);
		})(),
		n > LONG_ROUTINE &&
			(() => {
				const { from, to } = visibleRows(p);
				const all = expandedRoutines.has(p.id);
				return h(
					'div',
					{ class: 'sec-more' },
					!all && h('span', { class: 'sec-more-note' }, `Parts ${from + 1}–${to} of ${n}`),
					h(
						'button',
						{ class: 'btn btn-quiet', type: 'button', 'aria-expanded': String(all), onclick: () => setExpanded(p, !all) },
						all ? 'Show fewer' : `Show all ${n} parts`,
					),
				);
			})(),
		h(
			'div',
			{ class: 'routine-actions' },
			h(
				'button',
				{
					class: 'add btn btn-quiet',
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
						if (songOf(p)) section.song = { ...songOf(p) };
						p.metronomes.push(section);
						openSectionId = section.id; // open it, ready to name
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
					class: 'start btn btn-primary',
					type: 'button',
					disabled: !n,
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
	$('bar-undo').disabled = !canUndo();
}

function renderBuilder({ keepFocus = false } = {}) {
	// Re-rendering replaces the controls; remember which one had focus
	// (by section position + class) so the pedal/keyboard user keeps their place.
	// Inside a routine (not a section), the routine's position is the key.
	const active = keepFocus ? document.activeElement : null;
	const sec = active?.closest?.('#app .sec');
	const routine = active?.closest?.('#app .routine');
	const cls = active?.classList?.[0];
	let focusSelector = null;
	if (cls && sec) focusSelector = `.sec[data-pidx="${sec.dataset.pidx}"][data-midx="${sec.dataset.midx}"] .${cls}`;
	else if (cls && routine) focusSelector = `.routine[data-pidx="${routine.dataset.pidx}"] .${cls}`;
	// Same class twice in one place (Chunk | Run): come back to the same one.
	const focusIndex = focusSelector ? [...document.querySelectorAll(focusSelector)].indexOf(active) : -1;

	renderAlltime();
	const app = $('app');
	if (!practices.length) {
		app.replaceChildren(
			h(
				'div',
				{ class: 'empty' },
				h('span', { class: 'empty-art', html: icons.metronome }),
				h('p', {}, 'No routines yet. A routine is a list of timed sections, each with its own tempo.'),
				h(
					'div',
					{ class: 'empty-actions' },
					h('button', { class: 'btn btn-primary', type: 'button', onclick: addRoutine }, 'Create your first routine'),
					h('button', { class: 'btn', type: 'button', id: 'importTabEmpty', onclick: () => importer.open() }, iconEl('importFile'), 'Import tab'),
				),
			),
		);
	} else {
		app.replaceChildren(...practices.map((p, pIdx) => renderRoutine(p, pIdx)));
	}
	renderRecordBar();
	applyRoutineView();
	if (focusSelector) {
		const matches = document.querySelectorAll(focusSelector);
		(matches[Math.max(0, focusIndex)] ?? matches[0])?.focus({ preventScroll: routineView === 'slide' });
	}
}

// ---------------- Routine layout: vertical list or one-per-screen slides ----------------

const VIEW_KEY = 'metronome:routine-view';
let routineView = lsGet(VIEW_KEY) === 'slide' ? 'slide' : 'list';
let slideIndex = 0;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function setRoutineView(next) {
	routineView = next;
	try {
		localStorage.setItem(VIEW_KEY, JSON.stringify(next));
	} catch {
		// private mode: the choice just isn't remembered
	}
	applyRoutineView();
}

function applyRoutineView() {
	const slides = routineView === 'slide';
	const n = practices.length;
	$('app').classList.toggle('is-slides', slides);
	$('view-list').setAttribute('aria-pressed', String(!slides));
	$('view-slide').setAttribute('aria-pressed', String(slides));
	$('pager').hidden = !slides || n < 2;
	$('slide-dots').hidden = !slides || n < 2;
	$('slide-dots').replaceChildren(
		...practices.map((p, i) =>
			h('button', { class: 'dot', type: 'button', 'aria-label': `Go to ${p.name}`, onclick: () => goToSlide(i) }),
		),
	);
	if (slides) goToSlide(slideIndex, false);
}

function goToSlide(i, smooth = true) {
	const app = $('app');
	slideIndex = Math.max(0, Math.min(i, practices.length - 1));
	const target = app.children[slideIndex];
	if (routineView === 'slide' && target) {
		app.scrollTo({ left: target.offsetLeft, behavior: smooth && !reduceMotion.matches ? 'smooth' : 'auto' });
	}
	updatePager();
}

function updatePager() {
	const n = practices.length;
	$('slide-pos').textContent = n ? `${slideIndex + 1} / ${n}` : '';
	$('slide-prev').disabled = slideIndex <= 0;
	$('slide-next').disabled = slideIndex >= n - 1;
	[...$('slide-dots').children].forEach((d, i) => d.setAttribute('aria-current', String(i === slideIndex)));
	[...$('app').children].forEach((el, i) => {
		if (el.classList.contains('routine')) el.inert = routineView === 'slide' && i !== slideIndex;
	});
}

// Swiping: the nearest routine to the scroll position becomes the current slide.
let slideFrame = 0;
$('app').addEventListener('scroll', () => {
	if (routineView !== 'slide' || slideFrame) return;
	slideFrame = requestAnimationFrame(() => {
		slideFrame = 0;
		const app = $('app');
		let best = 0;
		[...app.children].forEach((el, i) => {
			if (Math.abs(el.offsetLeft - app.scrollLeft) < Math.abs(app.children[best].offsetLeft - app.scrollLeft)) best = i;
		});
		if (best !== slideIndex) {
			slideIndex = best;
			updatePager();
		}
	});
});

// Keep the current routine in place when the window (or phone) turns.
addEventListener('resize', () => routineView === 'slide' && goToSlide(slideIndex, false));

$('view-list').onclick = () => setRoutineView('list');
$('view-slide').onclick = () => setRoutineView('slide');
$('slide-prev').onclick = () => goToSlide(slideIndex - 1);
$('slide-next').onclick = () => goToSlide(slideIndex + 1);

// ---------------- Delete routine ----------------

function openDeleteDialog(p) {
	confirmDialog({
		title: 'Delete routine?',
		text: `“${p.name}” and its per-section stats will be deleted. Your all-time total is kept.`,
		confirm: 'Delete',
		onConfirm: async () => {
			removeLocalPractice(p);
			renderBuilder();
			if (p.id) {
				deleteTab(p.id).catch(() => {}); // the tab file stored on this device
				tabPanel.forget(p.id);
			}
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
		slideIndex = practices.length - 1;
		renderBuilder();
		document.querySelector('.routine:last-of-type .routine-name')?.select();
	} catch {
		// withSync already reported it
	}
}

// ---------------- Tab import (docs/TAB-IMPORT.md) ----------------

// A reviewed import becomes a routine through the same insert path as
// New routine; the tab file itself is kept on this device (IndexedDB).
async function createImportedRoutine(draft, source) {
	const created = await withSync(insertPractice({ ...draft, loop: false, position: practices.length }));
	const p = { ...created, metronomes: created.metronomes ?? [] };
	ensureSectionIds(p.metronomes);
	practices.push(p);
	let stored = true;
	try {
		await saveTab(tabRecord({ routineId: p.id, fileName: source.fileName, format: source.format, data: source.data, track: source.track, title: source.title, bars: source.bars }));
		tabPanel.remember(p.id, source);
	} catch (e) {
		console.error('Tab file not stored:', e);
		stored = false;
	}
	prepareSongSession(p);
	selectSection(p, p.metronomes[0]);
	slideIndex = practices.length - 1;
	showView('builder');
	renderBuilder();
	document.querySelector(`#app > .routine[data-pidx="${practices.length - 1}"]`)?.scrollIntoView({ block: 'start' });
	toast(
		stored ? `Routine created · ${p.metronomes.length} sections` : 'Routine created · the tab file couldn’t be kept on this device',
		stored ? '' : 'error',
		stored ? 2200 : 4000,
	);
	return p;
}

const importer = createImporter({
	toast,
	makeId: newSectionId,
	show: () => showView('importer'),
	close: () => {
		showView('builder');
		renderBuilder();
	},
	create: createImportedRoutine,
});

const tabPanel = createTabPanel({
	toast,
	confirm: confirmDialog,
	// From a section: the Tab player opens with that section's bars selected.
	openFull: () => activePractice && openTabPlayer(activePractice, activePractice.metronomes[activeMetIndex] ?? null),
	attached: (p) => {
		if (view === 'tabplayer' && tabPlayerFor === p) tabPlayer?.reload();
	},
	liveBpm: () => currentBPM,
	isPaused: () => isPaused,
	// "Hear it" pauses the click and resumes it afterwards (if it was running).
	pauseClick: () => {
		if (isPaused || view !== 'player') return false;
		togglePause();
		return true;
	},
	resumeClick: () => {
		if (isPaused && view === 'player') togglePause();
	},
});

onTempoChange = (bpm) => tabPanel.alongSpeed(bpm);

// ---------------- Tab player (docs/TAB-PLAYER.md) ----------------
// A full-screen view loaded on demand (src/tabplayer.js + alphaTab). The
// app's click never plays with it: opening pauses the click (and Hear it),
// and returning to the player leaves it paused.

let tabPlayer = null;
let tabPlayerFor = null; // the routine
let tabPlayerFrom = 'builder'; // the view Exit returns to
let tabPlayerToken = 0;
let tabPlayerWake = false;

function pauseClickForTab() {
	tabPanel.stop();
	if (view === 'player' || tabPlayerFrom === 'player') {
		if (activePractice && !isPaused) togglePause();
	}
}

// initial: the section to show selected ({ bars, range? }) or null.
async function openTabPlayer(p, initial = null) {
	if (view === 'tabplayer') return;
	const my = ++tabPlayerToken;
	tabPlayerFrom = view === 'player' ? 'player' : 'builder';
	pauseClickForTab();
	prepareSongSession(p); // today's start tempos, as when a routine starts
	tabPlayerFor = p;
	$('tp-title').textContent = p.name;
	$('tp-pos').textContent = '';
	$('tp-main').replaceChildren(h('p', { class: 'tab-note tp-status' }, 'Loading the tab player…'));
	showView('tabplayer');
	$('tp-title').focus();
	if (!wakeLock) {
		tabPlayerWake = true;
		requestWakeLock();
	}
	let mod;
	try {
		mod = await import('./tabplayer.js');
	} catch (e) {
		console.error('Tab player failed to load:', e);
		if (my === tabPlayerToken) $('tp-main').replaceChildren(h('p', { class: 'tab-note', role: 'alert' }, 'The tab player couldn’t load. Check your connection and try again.'));
		return;
	}
	if (my !== tabPlayerToken || view !== 'tabplayer') return;
	tabPlayer = mod.createTabPlayer({
		p,
		root: $('tp-main'),
		posEl: $('tp-pos'),
		source: () => tabPanel.sourceFor(p),
		initial: initial?.bars ? { bars: initial.bars, range: initial.range ?? null } : null,
		toast,
		confirm: confirmDialog,
		pickFile: () => tabPanel.pickFile(p),
		beforePlay: pauseClickForTab,
		practice: (index) => practiceFromTab(p, index),
		makeId: newSectionId,
		insertSection: (section, index) => insertSectionFromTab(p, section, index),
		isSong: () => isSong(p),
		songLine: (i, bpm) => (isSong(p) && p.metronomes[i] ? songLineText(p, p.metronomes[i], bpm) : null),
	});
}

// Exit: stop the tab audio and go back. The click stays paused.
function closeTabPlayer({ to = tabPlayerFrom } = {}) {
	tabPlayerToken++;
	tabPlayer?.destroy();
	tabPlayer = null;
	tabPlayerFor = null;
	if (tabPlayerWake && to !== 'player') {
		wakeLock?.release?.().catch(() => {});
		wakeLock = null;
	}
	tabPlayerWake = false;
	if (to === 'player' && activePractice) {
		// The Tab player's ladder may have moved this section's tempo:
		// pick it up before showing the player again (as runSection does).
		const met = activePractice.metronomes[activeMetIndex];
		if (met && !isRamping && met.startBPM !== currentBPM) {
			sectionStartBPM = met.startBPM;
			sectionEndBPM = met.startBPM;
			currentBPM = met.startBPM;
			adjustBPMDisplay();
		}
		showView('player');
		updatePlayerUI();
		$('player-title').focus();
	} else {
		showView('builder');
		renderBuilder();
	}
}

// "Practice this chunk": the normal player on that section, playing.
function practiceFromTab(p, index) {
	const fromPlayer = tabPlayerFrom === 'player' && activePractice === p;
	closeTabPlayer({ to: fromPlayer ? 'player' : 'builder' });
	if (fromPlayer) {
		if (isPaused) togglePause();
		runSection(index);
	} else {
		if (activePractice) stopEverything();
		startRoutine(p, index);
	}
}

// "Add as a new chunk" (confirmed): the Tab player builds the section
// (tabplayerlogic.newChunkSection); it is saved like any section edit.
function insertSectionFromTab(p, section, i) {
	p.metronomes.splice(i, 0, section);
	if (activePractice === p && activeMetIndex >= i) activeMetIndex++;
	savePractice(p);
	toast(`Added ${section.name}`, '', 2000);
	return i;
}

$('tp-exit').onclick = () => closeTabPlayer();
$('tp-exit').replaceChildren(iconEl('back'), 'Exit');

$('importTabBtn').onclick = () => importer.open();
$('importTabBtn').replaceChildren(iconEl('importFile'), 'Import tab');
$('import-cancel').onclick = () => importer.close();
$('import-cancel').replaceChildren(iconEl('back'), 'Cancel');

$('addPracticeBtn').onclick = addRoutine;
$('addPracticeTop').onclick = addRoutine;
$('addPracticeTop').innerHTML = icons.plus;
$('addPracticeBtn').replaceChildren(iconEl('plus'), 'New routine');
$('signOutBtn').replaceChildren(iconEl('signout'), 'Sign out');
$('view-list').replaceChildren(iconEl('list'), 'List');
$('view-slide').replaceChildren(iconEl('slides'), 'Slide');
$('slide-prev').innerHTML = icons.back;
$('slide-next').innerHTML = icons.forward;

// Static icons in the markup.
$('bar-good').innerHTML = icons.check;
$('bar-bad').innerHTML = icons.cross;
$('bar-undo').innerHTML = icons.undo;
$('stop').replaceChildren(iconEl('back'), 'Exit');
$('player-more-summary').replaceChildren(iconEl('sliders'), 'Settings');
$('undoBtn').replaceChildren(iconEl('undo'), 'Undo');
$('minus').innerHTML = icons.minus;
$('plus').innerHTML = icons.plus;
$('prevBtn').innerHTML = icons.prev;
$('nextBtn').innerHTML = icons.next;
document.querySelector('.ico-good').outerHTML = icons.check;
document.querySelector('.ico-bad').outerHTML = icons.cross;
renderPlayButton();

init();


// ---------------- Podcast (src/podcast.js) ----------------
// Drill / Maintain here = Song mode chunk status (engine.chunkStatus):
// 'new' and 'bottleneck' chunks are Drill; 'joined' chunks and Runs
// (cold full runs) are Maintain. Outside Song mode there is no context.
function podcastChunkState() {
	const m = playingSection();
	if (!m || !isSong(activePractice)) return null;
	if (isRun(m)) return 'maintain';
	const st = chunkStatus(m, songNow(activePractice)).state;
	return st === 'joined' ? 'maintain' : 'drill';
}

let podcastManualPaused = false;
let podcastWePaused = false;
let podcastOverride = false; // user pressed play during Drill: wins until the next chunk
let podcastAuto = podStore.get(KEY_AUTO, '1') !== '0';
const podcastPlayer = createPodcastPlayer({
	mount: $('podcast-embed'),
	onStatus: (t) => ($('podcast-msg').textContent = t),
});
podcastPlayer.onManual = (paused) => {
	podcastWePaused = false;
	podcastManualPaused = paused; // pressing play again re-enables auto-resume
	podcastOverride = !paused;
	syncPodcast();
};

// Logged in to Spotify: drive the Spotify app itself (Web API) instead of
// the embed. Calls are async, so they run one after another.
const spotifyRemote = createSpotifyRemote({
	redirectUri: location.origin + '/',
	onStatus: (t) => ($('podcast-msg').textContent = t),
});
let remoteQueue = Promise.resolve();

// Connected: play inside this page (embed, default) or on the Spotify app.
let spPlayHere = podStore.get('spotify.playHere', '1') !== '0';

function podcastTarget() {
	if (spotifyRemote.connected && !spPlayHere) return 'remote';
	return podcastPlayer.ready ? 'embed' : null;
}

function syncPodcast() {
	const target = podcastTarget();
	if (!target) return;
	const go = podcastShouldPlay({
		autoPause: podcastAuto,
		manualPaused: podcastManualPaused,
		running: Boolean(activePractice) && view === 'player' && !isPaused,
		chunkState: podcastChunkState(),
		resting: false,
		wePaused: podcastWePaused,
		userOverride: podcastOverride,
	});
	if (go === null) return;
	if (target === 'remote') {
		if (go) podcastWePaused = false;
		remoteQueue = remoteQueue.then(async () => {
			if (spotifyRemote.connected && (await spotifyRemote.setPlaying(go)) && !podcastManualPaused) podcastWePaused = true;
		});
		return;
	}
	if (go) {
		podcastWePaused = false;
		podcastPlayer.setPlaying(true);
	} else if (podcastPlayer.setPlaying(false) && !podcastManualPaused) {
		podcastWePaused = true; // only a pause of a playing embed is ours to undo
	}
}

// ---- Spotify card + show list (only while connected) ----
let spNow = null; // describePlayback() of the Spotify app
let spShows; // undefined = not loaded, null = Spotify refused, [] = none
let spOpenShow = null; // { id, name } while its episodes are listed
let spEpisodes;
let spPoll = null;
let spLibToken = 0;
let spLibShown = false;
let spCurrentUri = null; // highlighted in the episode list

const fmtMin = (ms) => `${Math.max(1, Math.round(ms / 60000))} min`;

function spAct(fn) {
	remoteQueue = remoteQueue
		.then(fn)
		.then(() => new Promise((r) => setTimeout(r, 500)))
		.then(refreshNowPlaying);
	return remoteQueue;
}

async function refreshNowPlaying() {
	if (!spotifyRemote.connected) return;
	spNow = await spotifyRemote.state();
	renderNowPlaying();
}

function renderNowPlaying() {
	const box = $('sp-now');
	if (!spNow) {
		box.replaceChildren(h('p', { class: 'sp-empty' }, 'Nothing playing. Pick an episode below, or press play in Spotify.'));
		return;
	}
	const toggle = () => {
		const play = !spNow.playing;
		podcastWePaused = false;
		podcastManualPaused = !play; // same rules as the embed's own buttons
		podcastOverride = play;
		spAct(() => spotifyRemote.setPlaying(play));
	};
	box.replaceChildren(
		spNow.image ? h('img', { class: 'sp-art', src: spNow.image, alt: '' }) : h('span', { class: 'sp-art' }),
		h(
			'div',
			{ class: 'sp-meta' },
			h('strong', {}, spNow.title),
			h('span', {}, [spNow.subtitle, spNow.device].filter(Boolean).join(' · ')),
		),
		h(
			'div',
			{ class: 'sp-ctrl' },
			h('button', { class: 'btn btn-quiet', type: 'button', 'aria-label': 'Back 15 seconds', onclick: () => spAct(() => spotifyRemote.seekBy(-15000)) }, '−15'),
			h('button', { class: 'sp-play', type: 'button', 'aria-label': spNow.playing ? 'Pause' : 'Play', onclick: toggle, html: spNow.playing ? icons.pause : icons.play }),
			h('button', { class: 'btn btn-quiet', type: 'button', 'aria-label': 'Forward 15 seconds', onclick: () => spAct(() => spotifyRemote.seekBy(15000)) }, '+15'),
		),
	);
}

function spPlay(ep) {
	podcastWePaused = false;
	podcastManualPaused = false;
	podcastOverride = true; // picked by hand: plays until the next chunk
	const startAt = ep.played ? 0 : ep.resumeAt;
	spCurrentUri = ep.uri;
	for (const row of document.querySelectorAll('#sp-lib .sp-row[data-uri]')) {
		row.classList.toggle('is-current', row.dataset.uri === ep.uri);
	}
	if (spPlayHere) {
		podcastPlayer.load(ep.uri, { startAt, play: true, video: true });
		spAct(() => spotifyRemote.setPlaying(false)); // one podcast at a time
	} else spAct(() => spotifyRemote.playUri(ep.uri, startAt));
}

function renderPlayWhere() {
	const sw = $('sp-here');
	sw.setAttribute('aria-checked', String(spPlayHere));
	$('sp-now').hidden = spPlayHere; // the embed is the player then
	$('sp-player').append($('podcast-embed'));
	$('podcast-embed').hidden = !spPlayHere || !podcastPlayer.ready;
}

const spMsg = (text, ...extra) => [h('p', { class: 'sp-empty' }, text), ...extra];

async function renderLibrary() {
	const box = $('sp-lib');
	const token = ++spLibToken; // a newer render wins
	if (!spotifyRemote.canBrowse) {
		box.replaceChildren(
			...spMsg(
				'Reconnect once to see your shows here.',
				h('button', { class: 'btn', type: 'button', onclick: () => spotifyRemote.login() }, 'Reconnect Spotify'),
			),
		);
		return;
	}
	const retry = h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => ((spShows = spEpisodes = undefined), renderLibrary()) }, 'Try again');
	if (spOpenShow) {
		if (spEpisodes === undefined) {
			box.replaceChildren(...spMsg('Loading episodes…'));
			spEpisodes = await spotifyRemote.showEpisodes(spOpenShow.id);
			if (token !== spLibToken) return;
		}
		const back = h('button', { class: 'btn btn-quiet sp-back', type: 'button', onclick: () => ((spOpenShow = null), (spEpisodes = undefined), renderLibrary()) }, iconEl('back'), spOpenShow.name);
		if (!spEpisodes) return box.replaceChildren(back, ...spMsg("Spotify didn't send the episodes.", retry));
		box.replaceChildren(
			back,
			h(
				'ul',
				{ class: 'sp-list' },
				spEpisodes.map((e) =>
					h(
						'li',
						{},
						h(
							'button',
							{ class: 'sp-row sp-ep' + (e.uri === spCurrentUri ? ' is-current' : ''), type: 'button', 'data-uri': e.uri, onclick: () => spPlay(e) },
							h('span', { class: 'sp-row-play', html: icons.play }),
							h('span', { class: 'sp-row-title' }, e.name),
							h('span', { class: 'sp-row-sub' }, [e.date, e.played ? 'Played' : e.resumeAt ? `${fmtMin(e.duration - e.resumeAt)} left` : fmtMin(e.duration)].filter(Boolean).join(' · ')),
						),
					),
				),
			),
		);
		return;
	}
	if (spShows === undefined) {
		box.replaceChildren(...spMsg('Loading your shows…'));
		spShows = await spotifyRemote.savedShows();
		if (token !== spLibToken) return;
	}
	if (!spShows) return box.replaceChildren(...spMsg("Spotify didn't send your shows.", retry));
	if (!spShows.length) return box.replaceChildren(...spMsg('No saved shows. Follow a podcast in Spotify and it shows up here.', retry));
	box.replaceChildren(
		h('p', { class: 'sp-head' }, 'Your shows'),
		h(
			'ul',
			{ class: 'sp-list' },
			spShows.map((sh) =>
				h(
					'li',
					{},
					h(
						'button',
						{ class: 'sp-row sp-show', type: 'button', onclick: () => ((spOpenShow = sh), (spEpisodes = undefined), renderLibrary()) },
						sh.image ? h('img', { class: 'sp-art', src: sh.image, alt: '' }) : h('span', { class: 'sp-art' }),
						h('span', { class: 'sp-row-title' }, sh.name),
						h('span', { class: 'sp-row-sub' }, sh.publisher),
					),
				),
			),
		),
	);
}

// Poll the now-playing card only while the panel is open and connected.
function syncSpotifyUi() {
	const live = spotifyRemote.connected && $('podcast-panel').open && !spPlayHere;
	$('spotify-ui').hidden = !spotifyRemote.connected;
	if (spotifyRemote.connected && $('podcast-panel').open && !spLibShown) {
		spLibShown = true;
		renderLibrary();
	}
	if (live && !spPoll) {
		refreshNowPlaying();
		spPoll = setInterval(() => !document.hidden && refreshNowPlaying(), 5000);
	} else if (!live && spPoll) {
		clearInterval(spPoll);
		spPoll = null;
	}
}

function renderSpotifyLogin() {
	syncSpotifyUi();
	const on = spotifyRemote.connected;
	$('spotify-connect').hidden = on;
	$('podcast-link-row').hidden = on;
	if (on) {
		renderPlayWhere();
		$('podcast-msg').textContent = '';
		return;
	}
	$('podcast-msg').after($('podcast-embed')); // back under the link field
	if ($('podcast-url').value.trim()) applyPodcastLink($('podcast-url').value, { save: false });
}

function applyPodcastLink(raw, { save = true } = {}) {
	const msg = $('podcast-msg');
	if (!raw.trim()) {
		msg.textContent = '';
		if (save) podStore.set(KEY_LINK, '');
		podcastWePaused = false;
		podcastPlayer.clear();
		return;
	}
	const uri = parseSpotifyLink(raw);
	if (!uri) {
		msg.textContent = 'That is not a Spotify episode, show or playlist link.';
		return;
	}
	msg.textContent = '';
	if (save) podStore.set(KEY_LINK, raw.trim());
	podcastManualPaused = false;
	podcastPlayer.load(uri);
}

{
	const panel = $('podcast-panel');
	const input = $('podcast-url');
	const saved = podStore.get(KEY_LINK, '');
	input.value = saved;
	$('podcast-link-row').open = Boolean(saved);
	let linkTimer;
	input.addEventListener('input', () => {
		clearTimeout(linkTimer);
		linkTimer = setTimeout(() => applyPodcastLink(input.value), 400);
	});
	const sw = $('podcast-auto');
	sw.setAttribute('aria-checked', String(podcastAuto));
	sw.onclick = () => {
		podcastAuto = !podcastAuto;
		podStore.set(KEY_AUTO, podcastAuto ? '1' : '0');
		sw.setAttribute('aria-checked', String(podcastAuto));
		syncPodcast();
	};
	const g = parseFloat(podStore.get(KEY_CLICK, '1'));
	clickGain = Number.isFinite(g) ? Math.min(2, Math.max(0, g)) : 1;
	const slider = $('clickGainSlider');
	slider.value = clickGain;
	const label = () => ($('click-gain-pct').textContent = Math.round(clickGain * 100) + '%');
	label();
	slider.oninput = () => {
		clickGain = parseFloat(slider.value);
		if (clickBus) clickBus.gain.value = clickGain;
		podStore.set(KEY_CLICK, clickGain);
		label();
	};
	$('sp-here').onclick = () => {
		spPlayHere = !spPlayHere;
		podStore.set('spotify.playHere', spPlayHere ? '1' : '0');
		podcastWePaused = false;
		if (!spPlayHere) podcastPlayer.setPlaying(false); // hidden embed must not keep playing
		renderPlayWhere();
		syncSpotifyUi();
	};
	$('spotify-connect').onclick = () => spotifyRemote.login();
	$('spotify-disconnect').onclick = () => {
		podcastPlayer.clear();
		spotifyRemote.logout();
		podcastWePaused = false;
		spShows = spEpisodes = undefined;
		spOpenShow = null;
		spLibShown = false;
		spCurrentUri = null;
		$('podcast-msg').textContent = '';
		renderSpotifyLogin();
	};
	const linked = () => !spotifyRemote.connected;
	// Lazy: Spotify's script loads only when the panel opens or a link was saved.
	panel.addEventListener('toggle', () => {
		syncSpotifyUi();
		if (panel.open && linked()) applyPodcastLink(input.value, { save: false });
	});
	if (saved && linked()) applyPodcastLink(saved, { save: false });
	renderSpotifyLogin();
	// Back from Spotify's login page: finish, clean the URL, open the panel.
	if (/[?&]state=/.test(location.search)) {
		spotifyRemote.finishLogin(location.search).then((ok) => {
			history.replaceState(null, '', location.pathname + location.hash);
			if (ok) panel.open = true;
			renderSpotifyLogin();
		});
	}
}

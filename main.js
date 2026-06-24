// ============================================================
// main.js — app logic. Metronome engine, builder UI, and mastery
// tracking are unchanged from the original; only persistence has
// moved from localStorage to Neon (via db.js).
// ============================================================
import {
	signUp,
	signIn,
	signOut,
	getSession,
	onAuthChange,
	fetchPractices,
	insertPractice,
	updatePractice,
	deletePractice,
	reorderPractices,
	fetchMasteryCounts,
	upsertMasteryCounts,
	fetchSettings,
	upsertSettings,
} from './db.js';

window.practices = [];
let counts = { s: 0, f: 0 };
let showStats = true;
let metVolume = 0.8;
let currentSession = null;

// Debounce writes so typing in a name field doesn't fire a request per keystroke.
let saveTimer = null;
function scheduleSave(fn, delay = 500) {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(fn, delay);
}

function setSyncIndicator(state) {
	const el = document.getElementById('sync-indicator');
	if (!el) return;
	el.classList.remove('error');
	if (state === 'saving') el.textContent = 'SAVING…';
	else if (state === 'synced') el.textContent = 'SYNCED';
	else if (state === 'error') {
		el.textContent = 'SYNC FAILED';
		el.classList.add('error');
	}
}

// Wraps a write call with sync-indicator feedback + error surfacing.
async function withSync(promise) {
	setSyncIndicator('saving');
	try {
		const result = await promise;
		setSyncIndicator('synced');
		return result;
	} catch (e) {
		console.error('Sync failed:', e);
		setSyncIndicator('error');
		alert('Could not save to the server: ' + (e.message || e));
		throw e;
	}
}

window.save = function () {
	// Persists the *entire* practices array's metronomes/name/loop fields
	// for every practice — used after bulk operations like delete/reorder
	// where diffing individual fields isn't worth the complexity.
	scheduleSave(async () => {
		await withSync(
			Promise.all(
				window.practices.map((p) =>
					updatePractice(p.id, { name: p.name, loop: p.loop, metronomes: p.metronomes }),
				),
			),
		);
	});
};

function saveMasteryCounts() {
	scheduleSave(() => withSync(upsertMasteryCounts(counts.s, counts.f)), 300);
}

function saveSettings() {
	scheduleSave(() => withSync(upsertSettings(showStats, metVolume)), 300);
}

// ---------------- Auth flow ----------------

let authMode = 'signin'; // or "signup"

function showAuthError(msg) {
	document.getElementById('auth-error').textContent = msg || '';
}

document.getElementById('auth-toggle').onclick = () => {
	authMode = authMode === 'signin' ? 'signup' : 'signin';
	document.getElementById('auth-submit').textContent =
		authMode === 'signin' ? 'SIGN IN' : 'CREATE ACCOUNT';
	document.getElementById('auth-toggle').textContent =
		authMode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in';
	showAuthError('');
};

document.getElementById('auth-submit').onclick = async () => {
	const email = document.getElementById('auth-email').value.trim();
	const password = document.getElementById('auth-password').value;
	if (!email || !password) return showAuthError('Enter an email and password.');

	document.getElementById('auth-status').textContent = 'Connecting…';
	showAuthError('');
	try {
		if (authMode === 'signup') {
			await signUp(email, password);
			document.getElementById('auth-status').textContent =
				'Check your email to confirm, then sign in.';
		} else {
			await signIn(email, password);
			// onAuthChange fires and boots the app
		}
	} catch (e) {
		showAuthError(e.message || 'Something went wrong.');
		document.getElementById('auth-status').textContent = '';
	}
};

document.getElementById('signOutBtn').onclick = async () => {
	await signOut();
	location.reload();
};

async function bootApp(session) {
	currentSession = session;
	document.getElementById('auth').style.display = 'none';
	document.getElementById('builder').style.display = 'block';

	try {
		const [fetchedPractices, masteryCounts, settings] = await Promise.all([
			fetchPractices(),
			fetchMasteryCounts(),
			fetchSettings(),
		]);
		window.practices = fetchedPractices;
		counts = { s: masteryCounts.success, f: masteryCounts.fail };
		showStats = settings.show_stats;
		metVolume = parseFloat(settings.volume);
	} catch (e) {
		console.error('Initial load failed:', e);
		alert('Could not load your data from the server: ' + (e.message || e));
		window.practices = [];
	}

	render();
	updateMasteryUI();
	applyStatsVisibility();
	const slider = document.getElementById('volumeSlider');
	slider.value = metVolume;
	document.getElementById('volume-pct').textContent = Math.round((metVolume / 3) * 100) + '%';
}

async function init() {
	onAuthChange((session) => {
		if (session && !currentSession) bootApp(session);
		if (!session && currentSession) location.reload();
	});
	const session = await getSession();
	if (session) {
		await bootApp(session);
	} else {
		document.getElementById('auth-status').textContent = '';
	}
}

// ---------------- Mastery UI ----------------

function updateMasteryUI() {
	document.getElementById('success-count').textContent = counts.s;
	document.getElementById('fail-count').textContent = counts.f;
	const total = counts.s + counts.f;
	const acc = total === 0 ? 0 : Math.round((counts.s / total) * 100);
	document.getElementById('accuracy-box').textContent = acc + '%';
	document.getElementById('accuracy-box').style.opacity = acc >= 80 ? '1' : '0.6';
}

function applyStatsVisibility() {
	document.getElementById('stats-ui').style.display = showStats ? 'flex' : 'none';
	document.getElementById('mastery-layer').style.display = showStats ? 'flex' : 'none';
	document.getElementById('toggleStats').textContent = `STATS: ${showStats ? 'ON' : 'OFF'}`;
}

document.getElementById('success-zone').onclick = () => {
	counts.s++;
	flashZone('success-zone', 'success-flash');
	saveMasteryCounts();
	updateMasteryUI();
};
document.getElementById('fail-zone').onclick = () => {
	counts.f++;
	flashZone('fail-zone', 'fail-flash');
	saveMasteryCounts();
	updateMasteryUI();
};

// Foot pedal (Enter key) with 1-second window for consecutive detection
let lastPedalPressTime = 0;
let pendingSuccessTimeout = null;
window.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		const now = Date.now();
		const timeSinceLastPress = now - lastPedalPressTime;

		if (timeSinceLastPress < 1000) {
			clearTimeout(pendingSuccessTimeout);
			counts.f++;
			flashZone('fail-zone', 'fail-flash');
			lastPedalPressTime = now;
			saveMasteryCounts();
			updateMasteryUI();
		} else {
			lastPedalPressTime = now;
			clearTimeout(pendingSuccessTimeout);
			pendingSuccessTimeout = setTimeout(() => {
				counts.s++;
				flashZone('success-zone', 'success-flash');
				saveMasteryCounts();
				updateMasteryUI();
			}, 1000);
		}
		e.preventDefault();
	}
});

function flashZone(id, cls) {
	const el = document.getElementById(id);
	el.classList.add(cls);
	setTimeout(() => el.classList.remove(cls), 150);
}

document.getElementById('resetStats').onclick = () => {
	counts = { s: 0, f: 0 };
	saveMasteryCounts();
	updateMasteryUI();
};
document.getElementById('toggleStats').onclick = () => {
	showStats = !showStats;
	applyStatsVisibility();
	saveSettings();
};

document.getElementById('volumeSlider').oninput = (e) => {
	metVolume = parseFloat(e.target.value);
	document.getElementById('volume-pct').textContent = Math.round((metVolume / 3) * 100) + '%';
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
	gain.gain.setValueAtTime(metVolume, time);
	gain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
	osc.connect(gain);
	gain.connect(audioCtx.destination);
	osc.start(time);
	osc.stop(time + 0.1);
}

function lightUpDot(beatIndex) {
	document.querySelectorAll('.dot').forEach((d) => (d.className = 'dot'));
	const dot = document.getElementById(`dot-${beatIndex}`);
	if (dot) dot.classList.add(beatIndex === 0 ? 'active-accent' : 'active-normal');
}

function scheduler() {
	if (isPaused) return;
	while (nextTickTime < audioCtx.currentTime + 0.1) {
		const beat = beatCounter % 4;
		playClick(nextTickTime, beat === 0);
		if (isRamping && totalSectionTime > 0) {
			const elapsed = totalSectionTime - timeLeftInSection;
			const t = Math.min(elapsed / totalSectionTime, 1);
			currentBPM = Math.round(sectionStartBPM + (sectionEndBPM - sectionStartBPM) * t);
			adjustBPMDisplay();
		}
		nextTickTime += 60 / currentBPM;
		const capturedBeat = beat;
		setTimeout(
			() => {
				if (!isPaused) lightUpDot(capturedBeat);
			},
			(nextTickTime - audioCtx.currentTime) * 1000 - (60 / currentBPM) * 1000,
		);
		beatCounter++;
	}
}

function runSection(index) {
	if (!activePractice || index >= activePractice.metronomes.length) {
		if (activePractice?.loop) return runSection(0);
		return stopEverything();
	}
	activeMetIndex = index;
	const met = activePractice.metronomes[index];
	sectionStartBPM = met.startBPM;
	sectionEndBPM = met.ramp ? met.endBPM : met.startBPM;
	isRamping = met.ramp && met.endBPM && met.endBPM !== met.startBPM;
	currentBPM = sectionStartBPM;
	timeLeftInSection = met.duration;
	totalSectionTime = met.duration;
	adjustBPMDisplay();
	updatePlayerUI();
	beatCounter = 0;
	nextTickTime = audioCtx.currentTime;
	updateProgressBar(1);

	if (!schedulerInterval) schedulerInterval = setInterval(scheduler, 25);
	startCountdown();
}

function startCountdown() {
	clearInterval(countdownInterval);
	document.getElementById('remaining').textContent = `${timeLeftInSection}s`;
	countdownInterval = setInterval(() => {
		if (!isPaused) {
			timeLeftInSection--;
			document.getElementById('remaining').textContent = `${Math.max(0, timeLeftInSection)}s`;
			const fraction = totalSectionTime > 0 ? timeLeftInSection / totalSectionTime : 0;
			updateProgressBar(fraction);
			if (timeLeftInSection <= 0) {
				clearInterval(countdownInterval);
				runSection(activeMetIndex + 1);
			}
		}
	}, 1000);
}

function updateProgressBar(fraction) {
	document.getElementById('progress-bar').style.width = fraction * 100 + '%';
}

function adjustBPMDisplay() {
	currentBPM = Math.round(Math.max(20, Math.min(300, currentBPM)));
	const rotation = ((currentBPM - 20) / (300 - 20)) * 300 - 150;
	document.getElementById('knob').style.transform = `rotate(${rotation}deg)`;
	document.getElementById('bpm-display').textContent = currentBPM;
}

function adjustBPM(amount) {
	currentBPM = Math.round(Math.max(20, Math.min(300, currentBPM + amount)));
	isRamping = false;
	adjustBPMDisplay();
	if (activePractice && activeMetIndex >= 0) {
		activePractice.metronomes[activeMetIndex].startBPM = currentBPM;
		activePractice.metronomes[activeMetIndex].ramp = false;
		window.save();
	}
}

function updatePlayerUI() {
	if (activeMetIndex === -1) return;
	const met = activePractice.metronomes[activeMetIndex];
	let labelText = met.name;
	if (met.ramp && met.endBPM) labelText += ` (${met.startBPM}→${met.endBPM})`;
	document.getElementById('label').textContent = labelText;
	const next =
		activePractice.metronomes[activeMetIndex + 1] ||
		(activePractice.loop ? activePractice.metronomes[0] : null);
	document.getElementById('upcoming-details').textContent = next
		? `NEXT: ${next.name} (${next.startBPM} BPM)`
		: 'FINAL PART';
}

function stopEverything() {
	isPaused = false;
	clearInterval(schedulerInterval);
	clearInterval(countdownInterval);
	schedulerInterval = null;
	document.getElementById('builder').style.display = 'block';
	document.getElementById('player').style.display = 'none';
	render();
}

// ---------------- Drag-to-reorder (desktop) ----------------

let dragSrcPIdx = null,
	dragSrcMIdx = null;

function onDragStart(e, pIdx, mIdx) {
	dragSrcPIdx = pIdx;
	dragSrcMIdx = mIdx;
	e.dataTransfer.effectAllowed = 'move';
	setTimeout(() => e.target.closest('.met').classList.add('dragging'), 0);
}

function onDragEnd() {
	document.querySelectorAll('.met').forEach((el) => el.classList.remove('dragging', 'drag-over'));
}

function onDragOver(e) {
	e.preventDefault();
	e.dataTransfer.dropEffect = 'move';
	document.querySelectorAll('.met').forEach((el) => el.classList.remove('drag-over'));
	e.currentTarget.classList.add('drag-over');
}

function onDrop(e, pIdx, mIdx) {
	e.preventDefault();
	if (dragSrcPIdx !== pIdx || dragSrcMIdx === mIdx) return;
	const arr = practices[pIdx].metronomes;
	const [moved] = arr.splice(dragSrcMIdx, 1);
	arr.splice(mIdx, 0, moved);
	window.save();
	render();
}

// ---------------- Touch drag-to-reorder ----------------

let touchDragPIdx = null,
	touchDragMIdx = null,
	touchDragEl = null,
	touchClone = null;

function onTouchDragStart(e, pIdx, mIdx) {
	touchDragPIdx = pIdx;
	touchDragMIdx = mIdx;
	touchDragEl = e.currentTarget.closest('.met');

	const rect = touchDragEl.getBoundingClientRect();
	touchClone = touchDragEl.cloneNode(true);
	touchClone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.7;pointer-events:none;z-index:9999;`;
	document.body.appendChild(touchClone);
	touchDragEl.classList.add('dragging');
	e.preventDefault();
}

function onTouchDragMove(e) {
	if (!touchClone) return;
	const touch = e.touches[0];
	touchClone.style.left = touch.clientX - touchClone.offsetWidth / 2 + 'px';
	touchClone.style.top = touch.clientY - 20 + 'px';

	document.querySelectorAll('.met').forEach((el) => el.classList.remove('drag-over'));
	const el = document.elementFromPoint(touch.clientX, touch.clientY);
	const target = el && el.closest('.met');
	if (target) target.classList.add('drag-over');
	e.preventDefault();
}

function onTouchDragEnd(e) {
	if (!touchClone) return;
	const touch = e.changedTouches[0];
	const el = document.elementFromPoint(touch.clientX, touch.clientY);
	const target = el && el.closest('.met');

	if (target) {
		const dropMIdx = parseInt(target.dataset.midx);
		const dropPIdx = parseInt(target.dataset.pidx);
		if (dropPIdx === touchDragPIdx && dropMIdx !== touchDragMIdx) {
			const arr = practices[touchDragPIdx].metronomes;
			const [moved] = arr.splice(touchDragMIdx, 1);
			arr.splice(dropMIdx, 0, moved);
			window.save();
		}
	}

	touchClone.remove();
	touchClone = null;
	if (touchDragEl) touchDragEl.classList.remove('dragging');
	document.querySelectorAll('.met').forEach((el) => el.classList.remove('drag-over'));
	render();
}

// ---------------- Name field lock/unlock ----------------

function toggleNameEdit(nameInput) {
	nameInput.classList.toggle('unlocked');
	if (nameInput.classList.contains('unlocked')) {
		nameInput.focus();
		nameInput.select();
	}
}

// ---------------- Duration formatting + drum-roll picker ----------------

function formatDuration(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

const ITEM_H = 40;

function buildDrum(id, count, selected, label) {
	return `
		<div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
			<div style="font-size:9px;color:#555;font-weight:800;letter-spacing:1px;text-transform:uppercase;">${label}</div>
			<div style="position:relative;height:${ITEM_H * 3}px;overflow:hidden;width:64px;">
				<div style="position:absolute;top:${ITEM_H}px;left:0;right:0;height:${ITEM_H}px;border-top:1px solid #333;border-bottom:1px solid #333;pointer-events:none;z-index:2;"></div>
				<div id="${id}" style="position:absolute;top:0;left:0;right:0;overflow-y:scroll;height:${ITEM_H * 3}px;scroll-snap-type:y mandatory;-webkit-overflow-scrolling:touch;">
					<div style="height:${ITEM_H}px;"></div>
					${Array.from(
						{ length: count },
						(_, i) => `
						<div style="height:${ITEM_H}px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;scroll-snap-align:center;color:#eee;">${String(i).padStart(2, '0')}</div>
					`,
					).join('')}
					<div style="height:${ITEM_H}px;"></div>
				</div>
			</div>
		</div>`;
}

function drumScrollTo(id, value) {
	document.getElementById(id).scrollTop = value * ITEM_H;
}

function drumValue(id) {
	return Math.round(document.getElementById(id).scrollTop / ITEM_H);
}

window.openTimePicker = function (pIdx, mIdx, currentSeconds) {
	const h = Math.floor(currentSeconds / 3600);
	const m = Math.floor((currentSeconds % 3600) / 60);
	const s = currentSeconds % 60;

	document.getElementById('modal-title').textContent = 'Set Duration';
	document.getElementById('modal-content').innerHTML = `
		<div style="display:flex;gap:12px;justify-content:center;margin:16px 0;">
			${buildDrum('drum-h', 24, h, 'hrs')}
			${buildDrum('drum-m', 60, m, 'min')}
			${buildDrum('drum-s', 60, s, 'sec')}
		</div>
		<div style="display:flex;gap:10px;margin-top:16px;">
			<button onclick="closeTimePicker()" style="flex:1;padding:12px;background:#333;color:#fff;border:none;border-radius:8px;">CANCEL</button>
			<button onclick="saveTimePicker(${pIdx},${mIdx})" style="flex:1;padding:12px;background:var(--primary);color:#fff;border:none;border-radius:8px;">OK</button>
		</div>
	`;
	document.getElementById('modal-overlay').style.display = 'flex';
	requestAnimationFrame(() => {
		drumScrollTo('drum-h', h);
		drumScrollTo('drum-m', m);
		drumScrollTo('drum-s', s);
	});
};

window.closeTimePicker = function () {
	document.getElementById('modal-overlay').style.display = 'none';
};

window.saveTimePicker = function (pIdx, mIdx) {
	const h = drumValue('drum-h');
	const m = drumValue('drum-m');
	const s = drumValue('drum-s');
	const totalSeconds = h * 3600 + m * 60 + s;
	practices[pIdx].metronomes[mIdx].duration = Math.max(1, totalSeconds);
	window.save();
	render();
	window.closeTimePicker();
};

// ---------------- Render ----------------

function render() {
	const app = document.getElementById('app');
	app.innerHTML = '';
	practices.forEach((p, pIdx) => {
		const card = document.createElement('div');
		card.className = 'practice';
		card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;">
                    <input type="text" value="${p.name}" data-pidx="${pIdx}" class="practice-name-input" style="font-weight:900;border:none;background:transparent;color:var(--primary);width:60%">
                    <div style="display:flex;gap:12px;align-items:center;">
                        <span style="font-size:9px;font-weight:900;color:#444">LOOP</span>
                        <input type="checkbox" ${p.loop ? 'checked' : ''} data-pidx="${pIdx}" class="practice-loop-input" style="width:16px;height:16px;">
                        <button data-pidx="${pIdx}" class="delete-practice-btn" style="background:none;border:none;color:#555;font-size:16px;">🗑</button>
                    </div>
                </div>`;

		card.querySelector('.practice-name-input').onchange = function () {
			practices[pIdx].name = this.value;
			window.save();
		};
		card.querySelector('.practice-loop-input').onchange = function () {
			practices[pIdx].loop = this.checked;
			window.save();
		};
		card.querySelector('.delete-practice-btn').onclick = () => openDeleteModal(pIdx);

		p.metronomes.forEach((m, mIdx) => {
			const mDiv = document.createElement('div');
			mDiv.className = 'met';
			mDiv.draggable = true;
			mDiv.dataset.pidx = pIdx;
			mDiv.dataset.midx = mIdx;

			mDiv.addEventListener('dragstart', (e) => onDragStart(e, pIdx, mIdx));
			mDiv.addEventListener('dragend', onDragEnd);
			mDiv.addEventListener('dragover', (e) => onDragOver(e, pIdx, mIdx));
			mDiv.addEventListener('drop', (e) => onDrop(e, pIdx, mIdx));

			const rampActive = m.ramp ? 'active' : '';
			const rampVisible = m.ramp ? 'visible' : '';

			mDiv.innerHTML = `
				<div class="met-name-row">
					<span class="drag-handle" title="Drag to reorder">⠿</span>
					<input class="met-name" type="text" value="${m.name}">
					<button class="remove-met-btn" style="border:none;background:none;color:#444">✕</button>
				</div>
				<div class="met-row">
					<span></span>
					<input type="number" value="${m.startBPM}" min="20" max="300" step="1" placeholder="BPM" class="met-bpm-input">
					<input type="text" value="${formatDuration(m.duration)}" readonly style="cursor:pointer;text-align:center;" class="met-duration-input">
					<button class="ramp-toggle ${rampActive}">RAMP ${m.ramp ? 'ON' : 'OFF'}</button>
				</div>
				<div class="met-ramp-row ${rampVisible}" id="ramp-row-${pIdx}-${mIdx}">
					<span>End BPM</span>
					<input type="number" value="${m.endBPM || m.startBPM}" min="20" max="300" step="1" class="met-end-bpm-input">
				</div>`;

			mDiv.querySelector('.met-name').onchange = function () {
				practices[pIdx].metronomes[mIdx].name = this.value;
				window.save();
			};
			mDiv.querySelector('.met-name').onblur = function () {
				this.classList.remove('unlocked');
			};
			mDiv.querySelector('.remove-met-btn').onclick = () => {
				practices[pIdx].metronomes.splice(mIdx, 1);
				window.save();
				render();
			};
			mDiv.querySelector('.met-bpm-input').onchange = function () {
				practices[pIdx].metronomes[mIdx].startBPM = parseInt(this.value);
				window.save();
			};
			mDiv.querySelector('.met-duration-input').onclick = () => {
				window.openTimePicker(pIdx, mIdx, m.duration);
			};
			mDiv.querySelector('.ramp-toggle').onclick = () => {
				practices[pIdx].metronomes[mIdx].ramp = !practices[pIdx].metronomes[mIdx].ramp;
				window.save();
				render();
			};
			mDiv.querySelector('.met-end-bpm-input').onchange = function () {
				practices[pIdx].metronomes[mIdx].endBPM = parseInt(this.value);
				window.save();
			};

			const handle = mDiv.querySelector('.drag-handle');
			handle.addEventListener('touchstart', (e) => onTouchDragStart(e, pIdx, mIdx), {
				passive: false,
			});

			const nameInput = mDiv.querySelector('.met-name');
			nameInput.addEventListener('click', (e) => {
				e.stopPropagation();
				toggleNameEdit(nameInput);
			});

			card.appendChild(mDiv);
		});

		const addSectionBtn = document.createElement('button');
		addSectionBtn.textContent = '+ ADD SECTION';
		addSectionBtn.style.cssText =
			'width:100%;padding:10px;margin-top:10px;border-radius:12px;background:none;color:#555;border:1px dashed #333;font-weight:900;letter-spacing:1px;font-size:11px';
		addSectionBtn.onclick = () => {
			practices[pIdx].metronomes.push({
				name: 'Exercise',
				startBPM: 100,
				duration: 60,
				ramp: false,
			});
			window.save();
			render();
		};
		card.appendChild(addSectionBtn);

		const startBtn = document.createElement('button');
		startBtn.textContent = 'START ROUTINE';
		startBtn.style.cssText =
			'width:100%;padding:14px;margin-top:10px;border-radius:12px;background:var(--primary);color:white;border:none;font-weight:900;letter-spacing:1px;font-size:12px';
		startBtn.onclick = () => {
			document.getElementById('builder').style.display = 'none';
			document.getElementById('player').style.display = 'flex';
			initAudio();
			activePractice = p;
			isPaused = false;
			runSection(0);
		};
		card.appendChild(startBtn);
		app.appendChild(card);
	});

	window.ontouchmove = onTouchDragMove;
	window.ontouchend = onTouchDragEnd;
}

// ---------------- Knob controls ----------------

let isDragging = false,
	lastY = 0;
document.getElementById('knobContainer').onmousedown = (e) => {
	isDragging = true;
	lastY = e.clientY;
	initAudio();
};
window.onmousemove = (e) => {
	if (isDragging) {
		adjustBPM(lastY - e.clientY);
		lastY = e.clientY;
	}
};
window.onmouseup = () => (isDragging = false);

document.getElementById('knobContainer').addEventListener(
	'touchstart',
	(e) => {
		isDragging = true;
		lastY = e.touches[0].clientY;
		initAudio();
		e.preventDefault();
	},
	{ passive: false },
);
window.addEventListener(
	'touchmove',
	(e) => {
		if (isDragging) {
			adjustBPM(lastY - e.touches[0].clientY);
			lastY = e.touches[0].clientY;
			e.preventDefault();
		}
	},
	{ passive: false },
);
window.addEventListener('touchend', () => (isDragging = false));

// ---------------- Delete-routine modal ----------------

let pendingDeleteIndex = null;

function openDeleteModal(i) {
	pendingDeleteIndex = i;
	document.getElementById('modal-title').textContent = 'Delete Routine?';
	document.getElementById('modal-content').innerHTML = `
		<div style="display:flex; gap:10px; margin-top:20px;">
			<button id="modal-cancel-btn" style="flex:1; padding:12px; background:#333; color:#fff; border:none; border-radius:8px;">CANCEL</button>
			<button id="modal-confirm-btn" style="flex:1; padding:12px; background:#ff4444; color:#fff; border:none; border-radius:8px;">DELETE</button>
		</div>
	`;
	document.getElementById('modal-cancel-btn').onclick = closeModal;
	document.getElementById('modal-confirm-btn').onclick = confirmDelete;
	document.getElementById('modal-overlay').style.display = 'flex';
}

function closeModal() {
	document.getElementById('modal-overlay').style.display = 'none';
}

async function confirmDelete() {
	const [removed] = practices.splice(pendingDeleteIndex, 1);
	render();
	closeModal();
	if (removed?.id) {
		try {
			await withSync(deletePractice(removed.id));
		} catch {
			// withSync already alerted; nothing further to do
		}
	}
}

// ---------------- Top-level buttons ----------------

document.getElementById('addPracticeBtn').onclick = async () => {
	const draft = {
		name: 'New Routine',
		loop: false,
		metronomes: [{ name: 'Exercise 1', startBPM: 100, duration: 60, ramp: false }],
		position: practices.length,
	};
	try {
		const created = await withSync(insertPractice(draft));
		practices.push(created);
		render();
	} catch {
		// withSync already alerted
	}
};

document.getElementById('playPause').onclick = () => {
	isPaused = !isPaused;
	document.getElementById('playPause').textContent = isPaused ? '▶' : 'II';
};
document.getElementById('plus').onclick = () => adjustBPM(1);
document.getElementById('minus').onclick = () => adjustBPM(-1);
document.getElementById('stop').onclick = stopEverything;
document.getElementById('nextBtn').onclick = () => runSection(activeMetIndex + 1);
document.getElementById('prevBtn').onclick = () => runSection(activeMetIndex - 1);

init();

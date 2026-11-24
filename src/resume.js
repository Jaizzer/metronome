// resume.js — pick a practice back up after a reload.
// main.js saves a snapshot while a routine plays (or the Tab player is
// open); on the next load resumable() says whether it can still continue.

export const SESSION_KEY = 'metronome:session';
export const RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// The object saved under SESSION_KEY.
export function snapshot({ view, practiceId, index = null, timeLeft = null, bpm = null }, now = Date.now()) {
	if (view === 'tabplayer') return { v: 1, view, practiceId, savedAt: now };
	return { v: 1, view: 'player', practiceId, index, timeLeft, bpm: bpm ?? null, savedAt: now };
}

// The tempo a ramp has reached with `left` of `total` seconds to go
// (the scheduler uses the same formula on every tick).
export function rampBpm(startBPM, endBPM, total, left) {
	if (!(total > 0)) return startBPM;
	const t = Math.min(Math.max((total - left) / total, 0), 1);
	return Math.round(startBPM + (endBPM - startBPM) * t);
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// null, or { practice, view, index, timeLeft, bpm } to continue from.
export function resumable(saved, practices, now = Date.now()) {
	if (!saved || typeof saved !== 'object' || saved.v !== 1) return null;
	if (saved.view !== 'player' && saved.view !== 'tabplayer') return null;
	if (!isNum(saved.savedAt) || now - saved.savedAt > RESUME_MAX_AGE_MS) return null;
	const practice = (practices ?? []).find((p) => p.id === saved.practiceId);
	if (!practice) return null;
	if (saved.view === 'tabplayer') return { practice, view: 'tabplayer', index: null, timeLeft: null, bpm: null };

	const list = practice.metronomes ?? [];
	let index = saved.index;
	if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
	if (!isNum(saved.timeLeft)) return null;
	let timeLeft = Math.round(saved.timeLeft);
	let bpm = isNum(saved.bpm) ? Math.round(Math.max(20, Math.min(300, saved.bpm))) : null;
	if (timeLeft < 1) {
		// That section was over: start the next one from the top.
		index++;
		if (index >= list.length) {
			if (!practice.loop) return null;
			index = 0;
		}
		timeLeft = list[index].duration;
		bpm = null; // a hand-set tempo belonged to the finished section
	}
	const dur = list[index].duration;
	timeLeft = Math.max(1, isNum(dur) ? Math.min(timeLeft, dur) : timeLeft);
	return { practice, view: 'player', index, timeLeft, bpm };
}

// Card text: { title, subtitle }. clock formats seconds (m:ss).
export function cardText(r, clock) {
	const title = `Continue ${r.practice.name}`;
	if (r.view === 'tabplayer') return { title, subtitle: 'Tab player' };
	return { title, subtitle: `Section ${r.index + 1} / ${r.practice.metronomes.length} · ${clock(r.timeLeft)} left` };
}

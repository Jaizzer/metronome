// ============================================================
// tabscore.js — read what the slicer needs out of an alphaTab score
// model (tracks, master bars, beats, notes). No alphaTab import: it
// works on the parsed object, so node tests can feed it a score that
// alphaTab parsed, and the main bundle stays small.
// ============================================================

export const TICKS_PER_QUARTER = 960; // alphaTab's MIDI resolution
const SIXTEENTH = TICKS_PER_QUARTER / 4;
const HALF = TICKS_PER_QUARTER * 2;
const SLIDE_SHIFT = 1; // alphaTab SlideOutType.Shift
const SLIDE_LEGATO = 2; // alphaTab SlideOutType.Legato

const isGuitarProgram = (p) => p >= 24 && p <= 31;
// alphaTab keeps no-break spaces in titles and names; plain spaces read better.
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Tracks the owner can pick: index, name, and whether it looks like a guitar.
export function trackList(score) {
	return (score?.tracks ?? []).map((t, index) => {
		const staff = t.staves?.[0];
		const strings = staff?.tuning?.length ?? 0;
		const percussion = Boolean(staff?.isPercussion);
		return {
			index,
			name: clean(t.name || t.shortName) || `Track ${index + 1}`,
			strings,
			percussion,
			guitar: !percussion && strings >= 6 && (isGuitarProgram(t.playbackInfo?.program ?? -1) || strings <= 8),
		};
	});
}

// The first guitar track, else the first stringed track, else the first non-drum track.
export function defaultTrack(score) {
	const list = trackList(score);
	return (
		list.find((t) => t.guitar) ?? list.find((t) => t.strings > 0 && !t.percussion) ?? list.find((t) => !t.percussion) ?? list[0]
	)?.index ?? 0;
}

const beatsWithNotes = (bar) =>
	(bar?.voices ?? []).flatMap((v) => (v.beats ?? []).filter((b) => !b.isRest && (b.notes?.length ?? 0) > 0 && !b.graceType));

const isLegatoNote = (n) => Boolean(n.isHammerPullOrigin) || n.slideOutType === SLIDE_LEGATO || n.slideOutType === SLIDE_SHIFT;

// Phrase end: the bar's last event is a rest, or its last note lasts a
// half note or more.
function endsPhrase(bar) {
	const beats = (bar?.voices?.[0]?.beats ?? []).filter((b) => !b.graceType);
	const last = beats[beats.length - 1];
	if (!last) return true;
	if (last.isRest || !(last.notes?.length > 0)) return true;
	return (last.playbackDuration ?? 0) >= HALF;
}

// The slicer's bar list for one track (see src/slicer.js).
export function barsFromScore(score, trackIndex = 0) {
	const track = score?.tracks?.[trackIndex];
	if (!track) throw new Error('That track is missing from the file');
	const staff = track.staves?.[0];
	let tempo = score.tempo > 0 ? score.tempo : null;
	const masterBars = score.masterBars ?? [];
	return masterBars.map((mb, i) => {
		const auto = (mb.tempoAutomations ?? []).find((a) => a.value > 0);
		const changed = auto && auto.value !== tempo;
		if (auto) tempo = auto.value;
		const bar = staff?.bars?.[i];
		// Distinct onsets across voices (a chord or two voices together count once).
		const onsets = new Map();
		let legato = 0;
		for (const b of beatsWithNotes(bar)) {
			const at = b.playbackStart ?? b.displayStart ?? onsets.size;
			const dur = b.playbackDuration ?? TICKS_PER_QUARTER;
			onsets.set(at, Math.min(onsets.get(at) ?? Infinity, dur));
			legato += b.notes.filter(isLegatoNote).length;
		}
		const durations = [...onsets.values()];
		const ticks = typeof mb.calculateDuration === 'function' ? mb.calculateDuration() : TICKS_PER_QUARTER * 4;
		const section = mb.section;
		const marker = clean(section?.text || section?.marker) || null;
		return {
			index: i + 1,
			beats: ticks / TICKS_PER_QUARTER,
			notes: onsets.size,
			shortNotes: durations.filter((d) => d <= SIXTEENTH).length,
			legato,
			marker,
			tempo: i === 0 || changed ? tempo : null,
			phraseEnd: endsPhrase(bar) || Boolean(masterBars[i + 1]?.section) || i === masterBars.length - 1,
			start: mb.start ?? null, // tick where the bar starts (for playback ranges)
			ticks,
		};
	});
}

export function scoreTitle(score, fileName = '') {
	const t = clean(score?.title);
	if (t) return t;
	return String(fileName).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported tab';
}

// Ticks to play for bars [start, end] (1-based). A seam ends on the first
// beat of its second bar.
export function tickRange(bars, start, end, seam = false) {
	const a = bars.find((b) => b.index === start);
	const z = bars.find((b) => b.index === end);
	if (!a || !z || a.start === null || z.start === null) return null;
	const beat = z.ticks / Math.max(1, Math.round(z.beats)) || TICKS_PER_QUARTER;
	return { startTick: a.start, endTick: seam ? z.start + beat : z.start + z.ticks };
}

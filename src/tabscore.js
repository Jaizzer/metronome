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
// tempoKnown: false when the file states no tempo (alphaTab then assumes
// 120 at bar 1, which must not count as the file's tempo).
export function barsFromScore(score, trackIndex = 0, { tempoKnown = true } = {}) {
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
			tempo: (i === 0 && tempoKnown) || (i > 0 && changed) ? tempo : null,
			phraseEnd: endsPhrase(bar) || Boolean(masterBars[i + 1]?.section) || i === masterBars.length - 1,
			ticks,
		};
	});
}

export function scoreTitle(score, fileName = '') {
	const t = clean(score?.title);
	if (t) return t;
	return String(fileName).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported tab';
}

// Does a MusicXML file state a tempo? Plain XML is checked directly; for
// compressed .mxl only a tempo other than alphaTab's default 120 proves it.
// Guitar Pro files always carry one.
export function fileStatesTempo(format, rawText, score) {
	if (format === 'gp') return true;
	if (rawText !== null && rawText !== undefined) return /<per-minute>|<sound[^>]*\btempo\s*=/.test(rawText);
	return (score?.tempo ?? 120) !== 120;
}

// Where bars [start, end] (1-based) are played: indexes into `played`
// (alphaTab's bars in playing order, repeats expanded:
// [{ index (0-based master bar), start, end }]) of the start and end bar of
// the FIRST pass that plays them straight through, else the first start
// bar and the first end bar after it. Null when they're never played.
function findPass(played, start, end) {
	const a = start - 1;
	const z = end - 1;
	const len = z - a + 1;
	for (let i = 0; i + len <= played.length; i++) {
		let ok = true;
		for (let k = 0; k < len; k++) {
			if (played[i + k].index !== a + k) {
				ok = false;
				break;
			}
		}
		if (ok) return [i, i + len - 1];
	}
	const i = played.findIndex((p) => p.index === a);
	if (i < 0) return null;
	const j = played.findIndex((p, k) => k >= i && p.index === z);
	return j < 0 ? null : [i, j];
}

// The MIDI ticks to play for bars [start, end] (1-based), from alphaTab's
// tick lookup (see findPass). Uses the FIRST time the range is played
// straight through; a seam ends one beat into its second bar (`beatTicks`).
// Null when the bars are never played.
export function playedRange(played, start, end, { seam = false, beatTicks = 960 } = {}) {
	const pass = findPass(played, start, end);
	if (!pass) return null;
	const [i, j] = pass;
	return { startTick: played[i].start, endTick: seam ? played[j].start + beatTicks : played[j].end };
}

// The ticks of a selection or section: bars { start, end } or a beat range
// (docs/TAB-PRACTICE.md): range.start.tick / range.end.tick are offsets
// from the start of its first / last bar, in the same pass as playedRange.
export function playedSpan(played, sel, opts) {
	if (!sel) return null;
	if (!sel.range) return playedRange(played, sel.start, sel.end, opts);
	const { start, end } = sel.range;
	const pass = findPass(played, start.bar, end.bar);
	if (!pass) return null;
	const [i, j] = pass;
	return { startTick: played[i].start + start.tick, endTick: played[j].start + end.tick };
}

// Every beat (note, chord or rest; no grace notes) of one track's first
// voice, in score order, as beat points { bar, beat, tick, end }: bar and
// beat 1-based, tick / end = ticks from the bar's start to where the beat
// starts / ends. `beatRef` keeps alphaTab's Beat (for its drawn bounds).
export function beatPoints(score, trackIndex = 0) {
	const staff = score?.tracks?.[trackIndex]?.staves?.[0];
	const out = [];
	(staff?.bars ?? []).forEach((bar, i) => {
		let n = 0;
		for (const b of bar.voices?.[0]?.beats ?? []) {
			if (b.graceType) continue;
			const tick = b.playbackStart ?? 0;
			out.push({ bar: i + 1, beat: ++n, tick, end: tick + (b.playbackDuration ?? 0), beatRef: b });
		}
	});
	return out;
}

// alphaTab's MidiTickLookup → the `played` list above.
export const playedBars = (tickLookup) => (tickLookup?.masterBars ?? []).map((m) => ({ index: m.masterBar.index, start: m.start, end: m.end }));

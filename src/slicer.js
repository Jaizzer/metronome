// ============================================================
// slicer.js — tab import: cut a piece into Song mode practice chunks
// (docs/TAB-IMPORT.md). Pure, no DOM, no alphaTab: it works on a
// simplified bar list so it can be unit-tested in node.
//
// A bar: { index (1-based), beats (quarter-note beats in the bar),
//          notes (note onsets), shortNotes (onsets of a 16th or shorter),
//          legato (hammer-on / pull-off / legato-slide starts),
//          marker (section name or null), tempo (BPM or null),
//          phraseEnd (bar ends on a rest or a long note) }
// A chunk (what the review screen edits):
//          { start, end, label, dense, name, auto }
//          auto = the name was generated (merge/split may regenerate it).
// ============================================================

export const START_SHARE = 0.7; // start tempo = 70% of target (PRACTICE-ALGORITHM §1.4)
export const ATTEMPTS = 4; // a chunk's length gives ~4 attempts per visit (3–5)
export const SECTION_BARS = 8; // no markers → 8-bar sections
export const MIN_SECONDS = 15;

// Dense bar = likely bottleneck: many notes for its length, mostly 16ths
// or shorter, or a legato run.
export const DENSE_NOTES_PER_44 = 12;
export const DENSE_LEGATO = 3;

export function isDense(bar) {
	const notes = bar.notes ?? 0;
	const beats = bar.beats > 0 ? bar.beats : 4;
	if ((notes * 4) / beats >= DENSE_NOTES_PER_44) return true;
	if (notes >= 6 && (bar.shortNotes ?? 0) >= notes / 2) return true;
	return (bar.legato ?? 0) >= DENSE_LEGATO;
}

export const barRange = (start, end) => (start === end ? `bar ${start}` : `bars ${start}–${end}`);

export function chunkName(label, start, end) {
	return `${label} · ${barRange(start, end)}`;
}

// The piece's sections: from markers, else 8-bar blocks ("Part 1", …).
export function sectionsOf(bars, sectionBars = SECTION_BARS) {
	if (!bars.length) return [];
	const hasMarkers = bars.some((b) => b.marker);
	const out = [];
	bars.forEach((b, i) => {
		const starts = i === 0 || (hasMarkers ? Boolean(b.marker) : i % sectionBars === 0);
		if (starts) {
			const label = b.marker || (hasMarkers ? 'Start' : `Part ${out.length + 1}`);
			out.push({ label, bars: [] });
		}
		out[out.length - 1].bars.push(b);
	});
	return out;
}

// Lengths for a run of plain (not dense) bars: 2–4 bars each, cut after a
// phrase end where possible, never leaving a lone bar at the end when the
// run is longer than one bar. `size` forces a fixed length (plain-text tabs).
export function cutRun(run, size = null) {
	const out = [];
	let i = 0;
	while (i < run.length) {
		const rem = run.length - i;
		let len;
		if (size) len = Math.min(size, rem);
		else if (rem <= 4) len = rem;
		else {
			const ok = [4, 3, 2].filter((L) => rem - L !== 1);
			len = ok.find((L) => run[i + L - 1].phraseEnd) ?? ok[0];
		}
		out.push(run.slice(i, i + len));
		i += len;
	}
	return out;
}

// Dense bars: their own chunks of 1–2 bars.
function cutDense(run) {
	const out = [];
	for (let i = 0; i < run.length; i += 2) out.push(run.slice(i, i + 2));
	return out;
}

// bars → chunks. opts.size: fixed plain chunk length; opts.density: false
// turns the dense-bar rule off, or a function(bar) replaces isDense.
export function planChunks(bars, { size = null, density = true, sectionBars = SECTION_BARS } = {}) {
	const denseFn = typeof density === 'function' ? density : density ? isDense : () => false;
	const chunks = [];
	for (const sec of sectionsOf(bars, sectionBars)) {
		let run = [];
		let runDense = null;
		const flush = () => {
			if (!run.length) return;
			for (const part of runDense ? cutDense(run) : cutRun(run, size)) {
				const start = part[0].index;
				const end = part[part.length - 1].index;
				chunks.push({ start, end, label: sec.label, dense: Boolean(runDense), name: chunkName(sec.label, start, end), auto: true });
			}
			run = [];
		};
		for (const b of sec.bars) {
			const dense = denseFn(b);
			if (run.length && dense !== runDense) flush();
			runDense = dense;
			run.push(b);
		}
		flush();
	}
	return chunks;
}

// ---- Review-screen edits (each returns a new array) ----

// Merging joins only neighbouring bars: after a delete, the chunks on either
// side of the gap stay separate, so deleted bars never come back.
export const canMerge = (chunks, i) => Boolean(chunks[i] && chunks[i + 1] && chunks[i + 1].start === chunks[i].end + 1);

export function mergeWithNext(chunks, i) {
	const a = chunks[i];
	const b = chunks[i + 1];
	if (!canMerge(chunks, i)) return chunks;
	const merged = {
		start: Math.min(a.start, b.start),
		end: Math.max(a.end, b.end),
		label: a.label,
		dense: a.dense || b.dense,
		auto: a.auto,
	};
	merged.name = a.auto ? chunkName(a.label, merged.start, merged.end) : a.name;
	return [...chunks.slice(0, i), merged, ...chunks.slice(i + 2)];
}

export const canSplit = (c) => Boolean(c) && c.end - c.start + 1 >= 2;

export function splitChunk(chunks, i) {
	const c = chunks[i];
	if (!canSplit(c)) return chunks;
	const mid = c.start + Math.floor((c.end - c.start + 1) / 2) - 1;
	const part = (start, end, n) => ({
		start,
		end,
		label: c.label,
		dense: c.dense,
		auto: c.auto,
		name: c.auto ? chunkName(c.label, start, end) : `${c.name} (${n})`,
	});
	return [...chunks.slice(0, i), part(c.start, mid, 1), part(mid + 1, c.end, 2), ...chunks.slice(i + 1)];
}

export function renameChunk(chunks, i, name) {
	const clean = String(name ?? '').trim();
	if (!chunks[i]) return chunks;
	const c = chunks[i];
	const next = clean ? { ...c, name: clean, auto: false } : { ...c, name: chunkName(c.label, c.start, c.end), auto: true };
	return chunks.map((x, j) => (j === i ? next : x));
}

export function deleteChunk(chunks, i) {
	return chunks.filter((_, j) => j !== i);
}

// Seams between neighbouring chunks (B starts right after A ends):
// last bar of A + first beat of B.
export function seamsOf(chunks) {
	const out = [];
	for (let i = 0; i + 1 < chunks.length; i++) {
		const a = chunks[i];
		const b = chunks[i + 1];
		if (b.start === a.end + 1) out.push({ after: i, start: a.end, end: b.start });
	}
	return out;
}

// ---- Durations ----

const barsBetween = (bars, start, end) => bars.filter((b) => b.index >= start && b.index <= end);
const beatsOf = (b) => (b?.beats > 0 ? b.beats : 4);

// Seconds for `attempts` attempts at `bpm`: each attempt plays `beats`
// beats plus one bar of rest. Rounded up to whole seconds, then up to a
// multiple of 5, and never under MIN_SECONDS.
export function practiceSeconds(beats, restBeats, bpm, attempts = ATTEMPTS) {
	const raw = Math.ceil((attempts * (beats + restBeats) * 60) / bpm);
	return Math.max(MIN_SECONDS, Math.ceil(raw / 5) * 5);
}

export function chunkSeconds(bars, chunk, bpm) {
	const list = barsBetween(bars, chunk.start, chunk.end);
	const beats = list.reduce((n, b) => n + beatsOf(b), 0);
	return practiceSeconds(beats, beatsOf(list[list.length - 1]), bpm);
}

// A seam plays the last bar of A and the first beat of B.
export function seamSeconds(bars, seam, bpm) {
	const a = bars.find((b) => b.index === seam.start);
	return practiceSeconds(beatsOf(a) + 1, beatsOf(a), bpm);
}

// The full run: the whole piece once, plus a bar to breathe.
export function runSeconds(bars, bpm) {
	const beats = bars.reduce((n, b) => n + beatsOf(b), 0);
	return practiceSeconds(beats, beatsOf(bars[bars.length - 1]), bpm, 1);
}

export const startTempo = (target) => Math.max(20, Math.round(target * START_SHARE));

// First tempo in the file (or null).
export function targetTempo(bars) {
	return bars.find((b) => b.tempo > 0)?.tempo ?? null;
}

// Tempo in effect at a bar (later tempo changes in the file).
export function tempoAt(bars, index) {
	let t = null;
	for (const b of bars) {
		if (b.index > index) break;
		if (b.tempo > 0) t = b.tempo;
	}
	return t;
}

// ---- Routine sections ----

// The Song-mode sections for the reviewed chunks: each chunk, then the
// seam that joins it to the chunk before; one full run at the end.
// `tab` (optional) is mirrored on every section: { title, track, bars, format }.
export function buildSections(chunks, bars, { target, makeId = () => undefined, tab = null } = {}) {
	if (!(target > 0)) throw new Error('A target BPM is needed');
	if (!chunks.length || !bars.length) throw new Error('Nothing to practise');
	const bpm = startTempo(target);
	const song = { on: true, target: Math.round(target) };
	const base = (extra) => ({
		id: makeId(),
		startBPM: bpm,
		ramp: false,
		song: { ...song },
		...(tab ? { tab: { ...tab } } : {}),
		...extra,
	});
	const seamAfter = new Map(seamsOf(chunks).map((s) => [s.after + 1, s]));
	const out = [];
	chunks.forEach((c, i) => {
		out.push(
			base({
				name: c.name,
				duration: chunkSeconds(bars, c, bpm),
				kind: 'chunk',
				bars: [c.start, c.end],
				...(c.dense ? { dense: true } : {}),
			}),
		);
		const seam = seamAfter.get(i);
		if (seam) {
			out.push(
				base({
					name: `Seam · ${barRange(seam.start, seam.end)}`,
					duration: seamSeconds(bars, seam, bpm),
					kind: 'chunk',
					bars: [seam.start, seam.end],
					seam: true,
				}),
			);
		}
	});
	const first = bars[0].index;
	const last = bars[bars.length - 1].index;
	out.push(base({ name: `Full run · ${barRange(first, last)}`, duration: runSeconds(bars, bpm), kind: 'run', bars: [first, last] }));
	for (const m of out) if (m.id === undefined) delete m.id;
	return out;
}

// Short summary for the review screen.
export function planSummary(chunks, bars) {
	const seams = seamsOf(chunks).length;
	const dense = chunks.filter((c) => c.dense).length;
	return { bars: bars.length, chunks: chunks.length, seams, dense, sections: chunks.length + seams + 1 };
}

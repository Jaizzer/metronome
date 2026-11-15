// ============================================================
// tabtext.js — plain-text tabs (Ultimate Guitar style): find the bar
// lines and turn them into the slicer's bar list. Pure, no DOM.
//
//   [Intro]
//   e|-----0-----|---0---0---|
//   B|---1---1---|-1---1-----|
//   …
// A "system" is 4–8 consecutive string lines; bar lines are the `|`
// columns shared by its lines. Rhythm is unknown: every bar counts as
// 4 beats and the owner types the tempo.
// ============================================================

// A string line: optional tuning letter, then mostly dashes with at least
// two bar lines.
const STRING_LINE = /^\s*[A-Ga-g]?[#b]?\s*[|:]/;

function isStringLine(line) {
	if (!STRING_LINE.test(line)) return false;
	const bars = (line.match(/\|/g) ?? []).length;
	const dashes = (line.match(/-/g) ?? []).length;
	return bars >= 2 && dashes >= 4 && dashes >= line.replace(/\s/g, '').length * 0.3;
}

const MARKER = /^\s*\[([^\]]{1,40})\]\s*$|^\s*([A-Za-z][\w '’&-]{0,30}):\s*$/;
const TEMPO = /(?:tempo|bpm)\s*[:=]?\s*(\d{2,3})\b|\b(\d{2,3})\s*bpm\b/i;

// Hand-typed tabs are often ragged: strings of one system with bars of
// different widths. Each line is split at its own `|`s and every bar is
// padded with dashes to the widest copy of it, so the columns line up.
// Returns the aligned lines, or throws when the strings don't have the
// same number of bars (nothing sensible to line up).
export function alignSystem(lines, lineNo = 0) {
	const split = lines.map((l) => {
		const first = l.indexOf('|');
		const label = l.slice(0, first).trimEnd();
		const parts = l.slice(first + 1).split('|');
		// After the last `|`: an unclosed bar if it has tab in it, else nothing.
		if (!/[-\d]/.test(parts[parts.length - 1])) parts.pop();
		// `||` (double bar line) leaves an empty part: not a bar.
		return { label, bars: parts.filter((x) => x.length > 0) };
	});
	const counts = split.map((x) => x.bars.length);
	if (new Set(counts).size > 1) {
		const where = lineNo ? ` (the tab starting on line ${lineNo})` : '';
		throw new Error(`The strings of one tab system${where} have different numbers of bars (${counts.join(', ')}). Fix the bar lines (|) so every string has the same bars, then try again.`);
	}
	const labelW = Math.max(...split.map((x) => x.label.length));
	const widths = split[0].bars.map((_, k) => Math.max(...split.map((x) => x.bars[k].length)));
	return split.map((x) => `${x.label.padEnd(labelW)}|${x.bars.map((b, k) => b.padEnd(widths[k], '-')).join('|')}|`);
}

// Bar line columns of an aligned system (every line has them).
function barColumns(lines) {
	const cols = [];
	for (let c = 0; c < lines[0].length; c++) if (lines[0][c] === '|') cols.push(c);
	return cols;
}

// Note onsets in one bar: columns where any string starts a fret number
// (a chord counts once); legato marks: h, p, / and \ between numbers.
function countBar(lines, from, to) {
	let notes = 0;
	let legato = 0;
	for (let c = from; c < to; c++) {
		let onset = false;
		for (const l of lines) {
			const ch = l[c] ?? '';
			if (/\d/.test(ch) && !/\d/.test(l[c - 1] ?? '')) onset = true;
			if (/[hp/\\]/.test(ch) && /\d/.test(l[c - 1] ?? '') && /\d/.test(l[c + 1] ?? '')) legato++;
		}
		if (onset) notes++;
	}
	return { notes, legato };
}

export const TEXT_DENSE_NOTES = 12;

// Returns { title, tempo, bars, systems } or throws when no bars are found.
// bars: the slicer's bar list (+ `dense` set only when it's obvious).
// systems: [{ lines: [string], cols: [barline columns], first: bar index }]
// so a range of bars can be shown later (textBarsSlice).
export function parseTextTab(text) {
	const lines = String(text ?? '').replace(/\t/g, '    ').split(/\r?\n/);
	const systems = [];
	const bars = [];
	let title = null;
	let tempo = null;
	let pendingMarker = null;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (isStringLine(line)) {
			const group = [];
			while (i < lines.length && isStringLine(lines[i])) group.push(lines[i++]);
			if (group.length < 4 || group.length > 8) continue; // not a guitar/bass system
			const aligned = alignSystem(group, i - group.length + 1);
			group.splice(0, group.length, ...aligned);
			const cols = barColumns(group);
			const first = bars.length + 1;
			for (let k = 0; k + 1 < cols.length; k++) {
				const { notes, legato } = countBar(group, cols[k] + 1, cols[k + 1]);
				// Empty trailing segments (`|` then spaces) aren't bars.
				const seg = group.map((l) => l.slice(cols[k] + 1, cols[k + 1])).join('');
				if (!/[-\d]/.test(seg)) continue;
				bars.push({
					index: bars.length + 1,
					beats: 4,
					notes,
					shortNotes: 0,
					legato,
					marker: k === 0 ? pendingMarker : null,
					tempo: null,
					phraseEnd: false,
				});
			}
			if (bars.length >= first) systems.push({ lines: group, cols, first, last: bars.length });
			pendingMarker = null;
			continue;
		}
		const t = line.trim();
		if (t) {
			const m = t.match(MARKER);
			const tm = t.match(TEMPO);
			if (tm && tempo === null) tempo = Number(tm[1] ?? tm[2]);
			if (m) pendingMarker = (m[1] ?? m[2]).trim();
			else if (!tm && title === null && !bars.length && t.length <= 80) title = t;
		}
		i++;
	}
	if (!bars.length) throw new Error('No tab found: no lines with bar lines (|) across 4–8 strings');
	if (tempo !== null && (tempo < 20 || tempo > 300)) tempo = null;
	return { title, tempo, bars, systems };
}

// Plain-text density: only when a bar obviously has many notes.
export const textDense = (bar) => bar.notes >= TEXT_DENSE_NOTES;

// The text lines for bars start..end (one block per system they span),
// each line keeping its tuning label.
export function textBarsSlice(parsed, start, end) {
	const out = [];
	for (const sys of parsed.systems) {
		if (sys.last < start || sys.first > end) continue;
		// Map bar index → column span inside this system.
		const spans = [];
		for (let k = 0, bar = sys.first; k + 1 < sys.cols.length && bar <= sys.last; k++) {
			const seg = sys.lines.map((l) => l.slice(sys.cols[k] + 1, sys.cols[k + 1])).join('');
			if (!/[-\d]/.test(seg)) continue;
			spans.push({ bar: bar++, from: sys.cols[k], to: sys.cols[k + 1] });
		}
		const inRange = spans.filter((s) => s.bar >= start && s.bar <= end);
		if (!inRange.length) continue;
		const from = inRange[0].from;
		const to = inRange[inRange.length - 1].to;
		out.push(sys.lines.map((l) => (l.slice(0, sys.cols[0]) + l.slice(from, to + 1)).trimEnd()));
	}
	return out;
}

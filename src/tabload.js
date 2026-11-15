// ============================================================
// tabload.js — the one place that lazy-loads tabview.js (and with it
// alphaTab), with a plain error when it can't (offline, blocked).
// ============================================================

import { parseTextTab } from './tabtext.js';
import { barsFromScore, trackList, defaultTrack, scoreTitle } from './tabscore.js';

let pending = null;

export function loadTabView() {
	pending ??= import('./tabview.js').catch((e) => {
		pending = null;
		console.error('alphaTab failed to load:', e);
		throw new Error('The tab reader couldn’t load. Check your connection and try again.');
	});
	return pending;
}

export const SCORE_EXT = ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'musicxml', 'xml', 'mxl'];
export const ACCEPT = '.gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.xml,.mxl,.txt';
export const MAX_BYTES = 20 * 1024 * 1024;

const ext = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');

// Which reader a file needs: 'text' for .txt, 'score' for Guitar Pro /
// MusicXML, null for anything else.
export function formatOf(fileName) {
	const e = ext(fileName);
	if (e === 'txt') return 'text';
	if (SCORE_EXT.includes(e)) return 'score';
	return null;
}

const baseName = (name) => String(name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

function textSource(text, fileName = '') {
	const parsed = parseTextTab(text);
	return {
		format: 'text',
		data: text,
		fileName,
		parsed,
		title: parsed.title || baseName(fileName) || 'Pasted tab',
		tempo: parsed.tempo,
		tracks: [],
		track: 0,
	};
}

async function scoreSource(data, fileName = '') {
	const tv = await loadTabView();
	const score = tv.parseScore(data);
	return { format: 'score', data, fileName, score, title: scoreTitle(score, fileName), tempo: null, tracks: trackList(score), track: defaultTrack(score) };
}

// A picked file or pasted text → a tab source:
// { format, data, fileName, title, tempo, tracks, track, score | parsed }.
// Throws a plain-language error; nothing is stored or created here.
export async function readTab({ file = null, text = null }) {
	if (text !== null) return textSource(text);
	if (!file) throw new Error('No file picked');
	if (file.size > MAX_BYTES) throw new Error('That file is too big for a tab (over 20 MB).');
	const format = formatOf(file.name);
	if (!format) throw new Error('Pick a Guitar Pro (.gp, .gp3–.gp5, .gpx), MusicXML (.musicxml, .xml, .mxl) or text (.txt) tab.');
	if (format === 'text') return textSource(await file.text(), file.name);
	return scoreSource(await file.arrayBuffer(), file.name);
}

// A stored record (tabstore) → a tab source.
export async function sourceFromRecord(rec) {
	const src = rec.format === 'text' ? textSource(rec.data, rec.fileName) : await scoreSource(rec.data, rec.fileName);
	src.track = rec.track ?? src.track;
	return src;
}

// The slicer's bar list for a source and track.
export const sourceBars = (src, track = src.track) => (src.format === 'text' ? src.parsed.bars : barsFromScore(src.score, track));

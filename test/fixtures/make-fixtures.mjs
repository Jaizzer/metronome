// Writes the tab-import fixtures: etude.musicxml (a hand-designed 10-bar
// guitar etude: Intro + Verse markers, tempo 100 → 90, a 16th-note bar,
// a hammer-on/pull-off bar) and etude.gp (the same score exported by
// alphaTab's Gp7Exporter). riff.txt is written by hand.
// Run from the repo root: node test/fixtures/make-fixtures.mjs
import fs from 'node:fs';
const OPEN = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };
const NAMES = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const DUR = { whole: 16, half: 8, quarter: 4, eighth: 2, '16th': 1 };
function note([s, f, type, tech = ''], chord = false) {
	if (s === 'r') return `      <note><rest/><duration>${DUR[f]}</duration><voice>1</voice><type>${f}</type></note>`;
	const midi = OPEN[s] + f;
	const pc = midi % 12, oct = Math.floor(midi / 12) - 1;
	const alter = ALTER[pc] ? `<alter>1</alter>` : '';
	const t = tech === 'h' ? '<hammer-on type="start">H</hammer-on>' : tech === 'p' ? '<pull-off type="start">P</pull-off>' : tech === 'x' ? '<hammer-on type="stop"/>' : '';
	const slur = tech === 'h' || tech === 'p' ? '<slur type="start" number="1"/>' : tech === 'x' ? '<slur type="stop" number="1"/>' : '';
	return `      <note>${chord ? '<chord/>' : ''}<pitch><step>${NAMES[pc]}</step>${alter}<octave>${oct}</octave></pitch><duration>${DUR[type]}</duration><voice>1</voice><type>${type}</type><notations>${slur}<technical>${t}<string>${s}</string><fret>${f}</fret></technical></notations></note>`;
}
const dir = (inner, sound = '') => `      <direction placement="above"><direction-type>${inner}</direction-type>${sound}</direction>`;
const q = (s, f, t) => [s, f, 'quarter', t];
const e = (s, f, t) => [s, f, 'eighth', t];
const x = (s, f, t) => [s, f, '16th', t];
const bars = [
	{ marker: 'Intro', tempo: 100, notes: [q(5, 3), q(4, 2), q(3, 0), q(2, 1)] },
	{ notes: [q(2, 0), q(3, 2), ['r', 'half']] }, // phrase end: rest
	{ notes: [e(5, 3), e(4, 2), e(3, 0), e(2, 1), e(5, 3), e(4, 2), e(3, 0), e(2, 1)] },
	{ notes: [[2, 1, 'half'], ['r', 'half']] }, // phrase end
	{ marker: 'Verse', notes: [q(6, 3), q(5, 2), q(4, 0), q(3, 0)] },
	{ notes: [e(6, 3), e(5, 2), e(4, 0), e(3, 0), [2, 0, 'half']] }, // phrase end: long note
	{ notes: [x(1, 5), x(2, 8), x(3, 7), x(1, 5), x(2, 8), x(3, 7), x(1, 5), x(2, 8), x(1, 7), x(2, 8), x(3, 7), x(1, 7), x(2, 8), x(3, 7), x(1, 8), x(2, 8)] }, // dense: 16 sixteenths
	{ notes: [e(1, 5, 'h'), e(1, 8, 'x'), e(1, 7, 'p'), e(1, 5, 'x'), e(2, 5, 'h'), e(2, 8, 'x'), e(2, 7, 'p'), e(2, 5, 'x')] }, // legato run: 4 hammer/pull origins
	{ tempo: 90, notes: [q(3, 2), q(2, 3), q(1, 2), q(2, 3)] }, // ritardando
	{ notes: [[2, 1, 'whole']] }, // ending
];
let out = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<!-- Test fixture written for this repo (not a transcription of any published piece). -->
<score-partwise version="4.0">
  <work><work-title>Fixture Etude</work-title></work>
  <identification><creator type="composer">Metronome tests</creator></identification>
  <part-list><score-part id="P1"><part-name>Guitar</part-name><score-instrument id="P1-I1"><instrument-name>Acoustic Guitar</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>26</midi-program></midi-instrument></score-part></part-list>
  <part id="P1">
`;
bars.forEach((b, i) => {
	out += `    <measure number="${i + 1}">\n`;
	if (i === 0) out += `      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines>${[[1, 'E', 2], [2, 'A', 2], [3, 'D', 3], [4, 'G', 3], [5, 'B', 3], [6, 'E', 4]].map(([l, s, o]) => `<staff-tuning line="${l}"><tuning-step>${s}</tuning-step><tuning-octave>${o}</tuning-octave></staff-tuning>`).join('')}</staff-details></attributes>\n`;
	if (b.marker) out += dir(`<rehearsal>${b.marker}</rehearsal>`) + '\n';
	if (b.tempo) out += dir(`<metronome><beat-unit>quarter</beat-unit><per-minute>${b.tempo}</per-minute></metronome>`, `<sound tempo="${b.tempo}"/>`) + '\n';
	out += b.notes.map((n) => note(n)).join('\n') + '\n';
	if (i === bars.length - 1) out += '      <barline location="right"><bar-style>light-heavy</bar-style></barline>\n';
	out += '    </measure>\n';
});
out += '  </part>\n</score-partwise>\n';
const here = new URL('./', import.meta.url);
fs.writeFileSync(new URL('etude.musicxml', here), out);
const at = await import('@coderline/alphatab/core');
const settings = new at.Settings();
const score = at.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(out), settings);
fs.writeFileSync(new URL('etude.gp', here), new at.exporter.Gp7Exporter().export(score, settings));

// duet.musicxml: two tracks, bass first, so the importer has to pick the
// guitar (track 2) by default and offer a track picker.
{
	const BASS = { 1: 43, 2: 38, 3: 33, 4: 28 };
	const pitch = (midi) => `<pitch><step>${NAMES[midi % 12]}</step>${ALTER[midi % 12] ? '<alter>1</alter>' : ''}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`;
	const n = (open, s, f) => `<note>${pitch(open[s] + f)}<duration>4</duration><voice>1</voice><type>quarter</type><notations><technical><string>${s}</string><fret>${f}</fret></technical></notations></note>`;
	const tuning = (list) => `<staff-details><staff-lines>${list.length}</staff-lines>${list.map(([s, o], i) => `<staff-tuning line="${i + 1}"><tuning-step>${s}</tuning-step><tuning-octave>${o}</tuning-octave></staff-tuning>`).join('')}</staff-details>`;
	const part = (id, open, tune, frets) =>
		`<part id="${id}">${frets
			.map((bar, i) => `<measure number="${i + 1}">${i === 0 ? `<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef>${tune}</attributes>${id === 'P1' ? '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>132</per-minute></metronome></direction-type><sound tempo="132"/></direction>' : ''}` : ''}${bar.map(([s, f]) => n(open, s, f)).join('')}</measure>`)
			.join('')}</part>`;
	const duet = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<!-- Test fixture written for this repo (not a transcription of any published piece). -->
<score-partwise version="4.0"><work><work-title>Fixture Duet</work-title></work>
<part-list><score-part id="P1"><part-name>Bass</part-name><midi-instrument id="P1-I1"><midi-program>34</midi-program></midi-instrument></score-part><score-part id="P2"><part-name>Lead guitar</part-name><midi-instrument id="P2-I1"><midi-program>30</midi-program></midi-instrument></score-part></part-list>
${part('P1', BASS, tuning([['E', 1], ['A', 1], ['D', 2], ['G', 2]]), [[[4, 3], [4, 3], [3, 3], [3, 3]], [[4, 5], [4, 5], [3, 5], [3, 5]]])}
${part('P2', OPEN, tuning([['E', 2], ['A', 2], ['D', 3], ['G', 3], ['B', 3], ['E', 4]]), [[[2, 1], [2, 3], [1, 0], [1, 1]], [[1, 3], [1, 1], [1, 0], [2, 3]]])}
</score-partwise>
`;
	fs.writeFileSync(new URL('duet.musicxml', here), duet);
}

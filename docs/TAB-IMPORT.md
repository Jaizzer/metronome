# Tab import (phase 3, planned 2026-11-15)

## Implementation status

Running checklist so work can resume after an interruption (update it with every commit).

- [x] alphaTab 1.9.0 (MPL-2.0) + `@coderline/alphatab-vite`; Vite 5 → 6.4.5 (the plugin needs Vite 6+)
- [x] `src/slicer.js` (pure: dense bars, sections, chunks, seams, run, durations, merge/split/rename/delete) + `test/slicer.test.js`
- [x] `src/tabtext.js` (plain-text bar lines, slices for display) + `test/tabtext.test.js`
- [x] `src/tabscore.js` (alphaTab score → bar list, tracks, tick ranges) + `test/tabscore.test.js` on the fixtures
- [x] `src/tabstore.js` (IndexedDB per routine, re-attach check) + `test/tabstore.test.js`
- [x] Fixtures: `test/fixtures/etude.musicxml` (hand-made), `etude.gp` (exported by alphaTab), `riff.txt`; `make-fixtures.mjs`
- [x] Lazy alphaTab module (`src/tabview.js`, loaded only through `src/tabload.js`): parse, render a bar range, reference playback over a tick range
- [x] Import entry points (builder head + empty state), import view, review screen (`src/importer.js`), Create routine
- [x] Player: Tab disclosure (`src/tabpanel.js`), Hear it (pauses the click), "not on this device" + re-attach
- [x] Harness flows (MusicXML + text + paste + bad file), screenshots 390/1280, pedal focus checks, old harness scripts
- [x] README, DESIGN.md
- [ ] Deploy check (Vercel production + 200)

**Built (as decided 2026-11-15)**
- Library: alphaTab 1.9.0, imported only by `src/tabview.js`, which only `src/tabload.js` loads (dynamic import), so it is a separate chunk; its worker/worklet go through `@coderline/alphatab-vite`; Bravura and the SONiVOX soundfont are `?url` imports, fetched only when a tab is drawn / Hear it is pressed. The "♪ alphaTab.net" attribution is never hidden.
- Slicing (`src/slicer.js`, bar list `{ index, beats, notes, shortNotes, legato, marker, tempo, phraseEnd }`): target = first tempo; sections = markers (bars before the first marker: "Start"), else 8-bar "Part n"; plain runs cut into 2–4 bars, preferring a cut after a phrase end (rest or a note ≥ a half at the bar's end, or the bar before a marker) and never leaving a lone bar; a bar is dense with ≥ 12 onsets per 4/4-equivalent bar, or ≥ 6 onsets of which half are 16ths or shorter, or ≥ 3 hammer-on/pull-off/legato-slide starts; dense runs become 1–2 bar chunks flagged "likely bottleneck"; a seam (last bar of A + first beat of B) after each pair of neighbouring chunks (none across a gap left by a delete); one run (whole piece) last.
- Sections: `startBPM` = 70% of target for chunks, seams and the run; chunk/seam duration = 4 attempts × (bars + 1 bar of rest) at that tempo, rounded up to whole seconds then to a multiple of 5, at least 15 s; the run = the piece once + a bar. Section JSON gains `bars`, `seam`, `dense`, `tab: { title, track, bars, format }`; `song: { on: true, target }` and `kind` as in Song mode. No schema change.
- Plain text (`src/tabtext.js`): 4–8 string lines with ≥ 2 `|`; bar lines = `|` columns shared by at least half the lines; `[Intro]` / `Solo:` lines become markers; "Tempo: 96" / "96 bpm" pre-fills the target (it stays required); 2-bar chunks; dense only with ≥ 12 note columns in a bar. The Tab view shows the text lines for the bars; no Hear it (no rhythm).
- Review screen and player: see DESIGN.md "Tab import (phase 3)". Hear it plays the section's tick range (seams end one beat into the second bar) at `live BPM / file tempo there` speed, with the click paused and resumed afterwards.
- Storage (`src/tabstore.js`): IndexedDB `metronome-tabs` / `tabs`, key = routine id; deleted with the routine on this device. Re-attach checks the format and that the file has enough bars; a different title is allowed and named in the toast.
- Tests: `test/slicer.test.js`, `test/tabtext.test.js`, `test/tabscore.test.js` (alphaTab parses the fixtures in node), `test/tabstore.test.js`; fixtures `etude.musicxml`, `etude.gp` (alphaTab's Gp7Exporter), `duet.musicxml`, `riff.txt`, rebuilt by `test/fixtures/make-fixtures.mjs`.

**Not built yet / known limits**
- TODO: full-run ✗ taps attributed to chunks by bar ranges (needs a bar position during the run, e.g. from the click's beat count).
- Mini tab previews show only in the open review row, not in every row.
- Changing the track in review re-plans the chunks (earlier merges/renames are dropped).
- Hear it needs the soundfont (1.35 MB) once per session; offline it reports an error and the click resumes.
- One tempo per section: a chunk whose bars change tempo in the file plays at its section tempo; the review row notes `♩ 90 here`.
- The routine keeps only bar ranges: a re-imported file with different bar numbering would show the wrong bars (the bar-count check catches only files that are too short).

Owner approved. Build after Song mode (phase 1) and the UI simplification (phase 2).

## Input
- **Guitar Pro** (.gp3, .gp4, .gp5, .gpx, .gp) and **MusicXML** via **alphaTab** (open source, browser). Best: rhythm, sections, tempo.
- **Plain-text tabs** (Ultimate Guitar style): rough fallback, slice by bar lines only, owner enters the tempo.
- Songsterr links can't be read; owner exports a file instead.

## Slicing (automatic, then reviewed)
1. **Target BPM** = the file's tempo (first tempo marking; note later tempo changes per chunk).
2. **Sections** = the file's markers (Intro, Theme A…); no markers → 8-bar sections.
3. **Chunks** = 2–4 bars inside a section, cut at bar lines, preferring phrase ends (rests, long notes).
4. **Dense bars** (many 16th/32nd notes or long legato runs: hammer-on/pull-off/slide marks in the file) → their own 1–2 bar chunk, flagged "likely bottleneck".
5. **Seams** between neighbouring chunks: last bar of A + first beat of B.
6. **One run section** for the whole piece (kind 'run').
7. Chunk duration = bars × beats per bar × 60 / tempo, then rounded to give ~3–5 attempts per visit (Song mode rotation).

## Review screen
- List of proposed chunks with bar ranges, density flag, and a mini tab preview.
- One tap to **merge** with the next chunk or **split** in half; rename; delete.
- "Create routine" → a Song-mode routine (`song: { on: true, target }`), sections with `kind`, bar ranges stored on each section (`bars: [start, end]`, inside the section JSON; no schema change).

## Practice view
- Shows the current chunk's tab (alphaTab render, bar range only), readable at phone width.
- **Reference playback**: play the chunk with alphaTab's synth at the live tempo before an attempt (button, never during the metronome click unless asked).
- Full-run ✗ taps map to chunks by bar ranges.

## Storage
- The tab file itself stays on the device (IndexedDB), keyed by routine; sections keep only bar ranges, so other devices need the file once (re-import) to show tab/playback. Cloud copy comes with the Mac server (TAKES-PLAN.md).

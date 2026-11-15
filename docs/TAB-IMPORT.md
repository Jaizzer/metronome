# Tab import (phase 3, planned 2026-11-15)

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

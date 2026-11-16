# Tab player (phase 4, decided 2026-11-16)

## Tab player (phase 4) status

Running checklist so work can resume after an interruption (update it with every commit).

- [x] Spec (this file)
- [x] Pure rules `src/tabplayerlogic.js` + `test/tabplayer.test.js` (taps → cursor/selection, [ ], arrows, speed → BPM label, chunk chips + matching, new chunk section, ticks ↔ bars, key mapping)
- [x] Lazy `src/tabplayer.js` view: whole track with alphaTab's cursor + auto-scroll, track picker, transport, selection/loop, chips, mute/solo
- [x] Entry points: builder Options **Play tab**, player Tab disclosure **Open full tab**; missing file → Import again
- [x] Keys (Space / pedal Enter / ← → / [ ] / Escape), blur after pointer clicks
- [x] Practice this chunk / Add as a new chunk (confirm)
- [x] Audio: app click paused while the Tab player is open, never both; cancel token; shared soundfont bytes
- [x] Harness `tabplayer.mjs` (all pass), screenshots 390 / 820 / 1280
- [x] Old harness scripts re-run: tabflow, p2keys, p2extra, slidetest, songflow, a11y, tabfix, stops33 all pass; `tabplayer.mjs` also passes on a production build (vite preview)
- [x] README + DESIGN.md
- [x] Deploy check (Vercel production 75f3719: success, URL 200, no console errors, lazy `tabplayer-*.js` served)
- [x] Review round 1 M1: fixed transport grid; Play/Pause keeps its place and the bar its height (harness: tap Play, tap the same spot → paused, speed unchanged, at 360 and 390)
- [x] Review round 1 M2: chips, Stop and arrow keys scroll to the target bar's box (harness on a 400-bar file: chip 201–204, Stop, →/← with and without a selection, playback)
- [x] Review round 1 minors: m1 arrows clamp to the selection, `[` marks a pending start; m2 reduced motion → scrollSpeed 0; m3 Play/Pause label without aria-pressed; m4 DESIGN.md; Open full tab selects the section's bars; `Bars 5–6 · Verse`; toast under the Tab player's header
- [ ] Review round 1 deploy check

## Known limits

- Mute/solo are checked in the harness through what was handed to alphaTab (`changeTrackMute` / `changeTrackSolo`), not by listening to the synth output.
- Speed and loop are alphaTab's: count-in plays only when playback starts, not before every loop pass.
- A selection plays the first time the piece plays its bars straight through (repeats expanded), like Hear it.
- Text-tab routines get no Tab player (no rhythm).

## Spec

A full-song tab player for routines made by Import tab from a Guitar Pro / MusicXML file (sections with `bars` + the tab file stored on this device). Text tabs have no rhythm, so they get no Tab player.

- **Entry:** **Play tab** (icon + word) in the routine's Options (builder), and **Open full tab** in the player's Tab disclosure (opens with that section's bars selected). Opens a full-screen view; **Exit** (or Escape) returns to where it was opened from.
- **Rendering:** the whole chosen track, alphaTab's beat cursor + bar highlight, auto-scroll that follows playback (alphaTab's continuous scroll on the score area). Page layout, so bars wrap to the width (readable at 390px, wide on desktop). Track picker when the file has several tracks.
- **Transport (sticky bottom):** Play/Pause, Stop (back to the selection start, else where playback started), speed 50–150% in 5% steps with the BPM it equals (`75% · 75 BPM`, from the file tempo at the cursor), Count-in (one bar of clicks, alphaTab's count-in), Metronome (alphaTab's metronome volume), Loop.
- **Selection:** tap a bar = the cursor moves there; tap another bar (or the same one again) = the bars between are selected; a tap with a selection clears it. Mouse drag from bar to bar selects too. Loop plays the selection over and over (without a selection, the whole piece). A selection limits playback to its bars, as it plays the first time the piece plays them straight through (repeats expanded, `playedRange`). Chips for the routine's chunks select one in a tap.
- **Practice link:** a selection equal to a section's bars shows **Practice this chunk** (opens the player on that section, playing). Any other selection shows **Add as a new chunk**, which asks first, then adds a Song-mode chunk (`kind: 'chunk'`, 70% start tempo, ~4 attempts long, Song settings and tab ref copied) before the first later section (else before the full run) through the normal save path.
- **Keys:** Space and the pedal's Enter = Play/Pause (the pedal does not record ✓/✗ here); ← / → = cursor one bar (inside the selection when there is one); `[` = selection start at the cursor (a pending start without a selection); `]` = selection end at the cursor; Escape = Exit. Nothing fires from a field (the track select). Every new control is blurred after a pointer click, the select after a change.
- **Audio:** opening the Tab player pauses the app's click (and Hear it); returning to the player leaves it paused (press Play). The soundfont bytes are fetched once and shared with Hear it. Loading, Stop and Exit go through a cancel token, so nothing plays after Exit.
- **Missing file:** `Tab file not on this device` + **Import again** (same re-attach path as the player).
- **Bundle:** the view is `src/tabplayer.js`, loaded with a dynamic import; alphaTab stays in its own chunk.

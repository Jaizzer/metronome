# Practice in the Tab player (phase 5, decided 2026-11-16)

## Implementation status

Running checklist so work can resume after an interruption (update it with every commit).

- [x] Spec (this file)
- [x] Pure rules + unit tests: pedal target, speed lock, beat points/ranges ↔ ticks (repeats), labels, durations from ticks, chunks with `range`
- [ ] 5a in the view: pedal ✓/✗/undo records in the Tab player (target captured at press), record line, speed lock + Free speed, live ladder speed + toast + tone, Click only
- [ ] 5b in the view: beat taps, second tap, mouse drag, handles (drag), Shift+← / Shift+→, bar-number taps stay bar-level, beat-level highlight, Add as a new chunk saves `range`
- [ ] Beat-level chunks elsewhere: chips, Practice this chunk, Open full tab, Tab panel (touched bars + beat highlight), Hear it (exact ticks), builder details line
- [ ] Harness: `tabpractice.mjs` (new) passes; `tabplayer.mjs` updated (Enter records now); old scripts re-run
- [ ] README, DESIGN.md, docs/TAB-PLAYER.md
- [ ] Deploy check

Not in this phase: 5c (Tab follows the click in the normal player) and phase 6 (tab files on every device).

## 5a. Pedal ✓/✗ in the Tab player

- **Keys:** the pedal's Enter records here, as everywhere: tap ✓, double-tap ✗, hold undo (`pedal.js`, the same `record()` / `undoLast()` / sync paths as the normal player). Space and the on-screen Play/Pause button play and pause. Cmd/Ctrl+Z undoes. With focus on a control, Enter is the keyboard's (it presses the control), as everywhere.
- **Target, captured at press time** (with the BPM): the selected chunk (the section whose bars, or beat range, equal the selection); with no selection, the chunk under the cursor (while playing: the playback position; stopped: the cursor bar's start). Several contain it: chunks before seams before the full run, then the shortest (in ticks), then routine order. A selection that matches no section, or a cursor in no section: no record, toast **Select a chunk to record**. A hold (undo) always works.
- **BPM recorded:** with the speed locked, the chunk's practice BPM; otherwise the effective BPM = the file tempo at the chunk's first bar × the speed.
- **Speed lock:** a selection matching a section of a Song-mode routine locks the speed to that section's practice BPM (its `startBPM`, which the day's start sets to `engine.sessionStart`): speed = BPM ÷ file tempo at its first bar (any ratio from 25% to 200%; not rounded to 5%). The speed shows `73% · 73 BPM` with − / + disabled. A small **Free speed** toggle (record line) unlocks manual speed: attempts still record at the effective BPM, the ladder still updates the chunk's tempo, but playback speed stays where the user put it. Free speed is per view (off each time the Tab player opens).
- **Ladder live:** after each attempt the engine's result (up / down / cold miss, shrink prompt, join) is applied as in the normal player: the section's tempo changes and is saved, the toast says why (`↑ 76 BPM · 2 ✓ in a row`), the same two-note tone plays (while the tab plays), and with the speed locked the playback speed changes at once without restarting. Warm-ups and the daily check behave exactly as in the normal player (the engine decides from the recorded BPM).
- **Record line** (bottom bar, between the selection line and the transport; always shown, fixed 44px, text clamped to 2 lines so the bar never changes height while playing): the target's short name and, in Song mode, the same line as the player (`Verse · Work · 1 more ✓ to go up`, `First try today · this is your daily check`, `Warm-up · daily check from 70 BPM`, `Run · tap ✗ and keep playing`); outside Song mode `Verse · pedal ✓ ✗ record here`; with no target `Select a chunk to record`. A green pending dot shows while a ✓ waits out the double-tap window. Free speed sits at its right end when the speed is locked (or unlocked by it).
- **Click only** toggle (with Count-in, Metronome, Loop; remembered per device): mutes every track and turns the metronome on; off restores the Mute/Solo choices and the Metronome setting. The Metronome toggle reads pressed (and is disabled) while Click only is on.
- ✓/✗ while not playing still record (like the normal player).

## 5b. Beat-level selection

- **Beat** = one note, chord or rest of the shown track (alphaTab's Beat, voice 1), numbered from 1 in its bar. A beat point: `{ bar, beat, tick, end }`: `tick` / `end` = ticks from the bar's start to where the beat starts / ends.
- **Taps on the score:** a tap selects the nearest beat (alphaTab `boundsLookup`, the beat's x on the tapped staff line) and marks it as a pending start; a second tap selects from it to that beat (either order; both beats included); a tap while something is selected clears it and starts over. A mouse drag from beat to beat selects in one go; a touch drag scrolls.
- **Bar-level stays:** a tap on a bar number (the band above the staff lines at the bar's left, 44px wide) selects bars exactly as before (first tap pending, second tap the bars between), and so do the chips, `[` and `]`. A beat range that covers whole bars (first beat of its first bar to the last beat of its last bar) is a bar selection.
- **Handles:** a beat-level selection gets a 44×44px handle at each end (pointer only; amber bar with a grip). Dragging one moves that end to the nearest beat (never past the other end). **Shift+→ / Shift+←** move the end by one beat (from a bar selection: its last beat; with nothing selected: the cursor bar's first beat is selected first).
- **Highlight:** the span is drawn beat-exact (from the start beat's left edge to the end beat's right edge on each line), amber at 16% with the 3px underline; the label reads `Bar 5 beat 3 → bar 7 beat 2` (`Bar 5 beats 3–6` inside one bar).
- **Stored on the section** (no schema change): `range: { start: { bar, beat, tick }, end: { bar, beat, tick } }` with `start.tick` = where the span starts in its bar and `end.tick` = where it ends in its bar (after the end beat); `bars: [start.bar, end.bar]` = the bars it touches (labels, the Tab panel, older code).
- **Ticks:** played-out ticks (repeats expanded): the first time the piece plays bars start..end straight through, `startTick = that pass's start-bar tick + start.tick`, `endTick = that pass's end-bar tick + end.tick` (same fallback as `playedRange` when never played straight through).
- **Add as a new chunk** saves the range: name `Chunk · bar 5 beat 3 → bar 7 beat 2`, 70% tempo, duration from ticks (span in quarter beats + one bar of rest, ~4 attempts), Song settings and tab ref copied, inserted before the first later section.
- **Everywhere a chunk goes:** chips (selects the exact range), matching (`Practice this chunk`), the pedal target, the speed lock, **Open full tab** (opens with the range selected), the player's Tab panel (draws the touched bars, highlights the span, summary `Tab · bar 5 beat 3 → bar 7 beat 2`), **Hear it** (plays exactly the span's ticks), the engine (a chunk like any other).

## Known limits

- The beat number counts the notes/rests of the track shown when the chunk was made; the ticks (not the number) drive playback, highlight and matching, so another track still plays and highlights the same span.
- A beat-level chunk's tempo is taken at its first bar (as for bar chunks).
- Free speed is not remembered between openings (the lock is the default).

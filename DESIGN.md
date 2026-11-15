# Design

Two inks on black stock, like a screen-printed gig poster: read from a music stand two metres away, operated mostly by foot. Tokens live as CSS custom properties at the top of `src/style.css`; change them there and here together.

## Two densities

- **Playing (player) is glanceable.** Tempo, time left, the one Song mode line and the ✓/✗ counts are all that compete for the eye. Everything else is quieter or one tap away.
- **Editing (builder) is a calm list.** A section row shows only name, tempo, length and (in Song mode) a short status. Tapping a row opens its editing panel; a routine's settings open from **Options**. Nothing is removed, only disclosed on demand.
- **One primary action per screen:** Start routine on each routine, Pause/Play in the player. Amber is reserved for those, the tempo, the selected/current thing and pressed toggles.

## Colour

| Token | Value | Use |
|---|---|---|
| `--stock` | `#121110` | Page ground (warm near-black) |
| `--stock-raised` | `#1b1917` | Record bar, tally panels, dialogs, the open section, routine options |
| `--stock-input` | `#25221f` | Inputs, duration buttons, drums |
| `--rule` / `--rule-strong` | `#36322d` / `#514a42` | 1–2px rules, resting borders, tracks |
| `--paper` | `#f4efe6` | Primary text |
| `--paper-2` | `#c2baad` | Secondary text (≥ 8:1 on stock) |
| `--paper-3` | `#968d80` | Tertiary text, idle icons (≥ 4.5:1 on stock) |
| `--amber` | `#ffb224` | The spot ink: masthead band, tempo numeral, primary actions, current stop, focus ring, selection |
| `--amber-press` | `#e89a0c` | Hover/press on amber |
| `--good` | `#3dd68c` | ✓ state only |
| `--bad` | `#ff6450` | ✗ state only |
| `--on-ink` | `#121110` | Text on any ink fill |

Rules: amber appears only on the tempo and on things you can press or that are current. Green and red carry meaning only (✓ / ✗), always with a glyph and a word, never colour alone.

## Type

- **Numerals and display**: Barlow Condensed 600/700, self-hosted via `@fontsource/barlow-condensed`, tabular figures. BPM `clamp(104px, 33vw, 176px)`, tally `clamp(72px, 22vw, 120px)`, clock 44px, headings 28–44px uppercase.
- **UI text**: system UI stack, 16px body (inputs stay 16px so iOS doesn't zoom), 13–15px labels.

## Space and shape

- Spacing scale `--s1…--s7`: 4, 8, 12, 16, 24, 32, 48px. Page gutter 16px.
- Radius `--radius: 6px` everywhere; round only for transport buttons, stops, and switches.
- Touch targets ≥ 44px (`--tap: 48px` for primary controls; transport 56px, play 76px).
- No cards: a routine is a block under a 2px rule; sections are rows between 1px rules. The one open section and a routine's options sit on `--stock-raised` (radius 6px) instead of gaining borders.

## Signature move: the overprint

Every ✓/✗ record floods its panel (and the record-bar button) with solid ink and knocks the numerals out to stock colour for 450 ms. Undo strikes the count through for 900 ms and the toast shows the undone record struck out, so nothing silently disappears.

## Other patterns

- **Stop strip**: the routine drawn as a line of stops; done = filled amber, current = ringed, ahead = hollow. Each stop jumps to that section.
- **Beat blocks**: four bars; beat 1 lights amber, others paper.
- **Pending chip**: a green dot that shrinks over the 600 ms double-tap window.
- **Toast**: top-centre, ink-coloured by kind, 1.4–2 s, `role=status`.
- **Focus**: 3px amber outline, 2px offset. A mouse/touch click blurs the button, switch or `<summary>` it hit (or, when the click re-drew the builder, the re-drawn copy keepFocus focused), so the next pedal Enter records and Space pauses instead of re-pressing it. Keyboard activation keeps focus on the same control, including the same half of Chunk | Run. Text selection is amber with stock text.
- **Motion**: only the overprint, toast slide (250 ms ease-out), and switch thumb; all disabled under `prefers-reduced-motion`.
- **Layout**: single column, max 640px for routines; player goes two-column (tempo | tally) from 900px.
- **Builder head**: "Routines" with the List | Slide switch and a 48px **+** button (aria-label and title "New routine", the one icon-only control) beside it; under it one quiet all-time line (`All-time ✓ 19 ✗ 6 · 76%`, no rules). **New routine** is also a dashed full-width button after the last routine. Slide mode adds ‹ n / N › above the track and dots below it; off-screen routines are `inert`, the choice is per device (`localStorage`), and the slide follows the routine the pedal records to.
- **Routine head**: the name (an inline-editable display heading) and an **Options** button; one meta line (`4 sections · 8m · Loop` + `✓ ✗ %` once there are records); in Song mode one summary line. **Options** (aria-expanded, stays open across re-renders) holds Loop, Song mode, Target BPM (Song mode only), Reset stats and Delete routine, each icon + word.
- **Section row**: a full-width button (≥ 60px tall, `aria-expanded`): selected dot (amber = where the pedal records) · name (wraps to 2 lines, never cut mid-word; + status line in Song mode) · tempo numeral with small `BPM` (visually hidden under 560px, still read out; `60→80` with a small UI-font arrow when ramping, read as "60 to 80") · length · chevron. Tempo and length columns align row to row. One section is open at a time; while open, the row's name is visually hidden (kept for screen readers) because the name field directly below shows it. The panel holds the name field, tempo, length (time picker), Ramp + end tempo, `Runs ✓ ✗ %`, the Song mode details and Chunk | Run, then **Move** (drag handle, or arrow keys while focused) and **Remove** (confirms when the section has records). Field edits update the row in place. A new section opens ready to name.
- **Player**: stop strip · section name · BPM with − / + · unit (or ramp range) · beats · Song mode line · clock + progress + Next · transport · Good / Bad panels (glyph + word + count, nothing else) · one row with `Section % · Routine %`, the pending chip and Undo · a **Settings** disclosure holding Volume, Show stats, all-time ✓/✗ with Reset all-time, and the pedal hint. At 390×844 everything down to Settings fits one screen.
- **Icons beside words**: every icon sits next to its label (the header **+** for New routine is the one exception, labelled by aria-label/title, with the worded New routine button at the end of the list) (Sign out, Synced, Options, Loop, Song mode, Target, Ramp, Move, Remove, Reset stats, Delete routine, Settings, Add section, Start routine), drawn at 16–18px in `--paper-3` or `currentColor`.
- **Song mode** (opt-in per routine under Options, nothing changes when it's off): a Target BPM field in Options and one summary line under the routine head (`Song tempo 68 · 57% of 120`, or `· above target 60` after the target was lowered below it; then due sections by name with "+N", bottleneck last; truncated with an ellipsis rather than wrapping). Song mode hides Ramp (it plays every section at its tempo). Each section row's status: `○ New` / `● Joined` / `▼ Bottleneck` / `→ Run`, plus `Due today`; owned tempo, band, next review, attempt count, plateau advice and Chunk | Run are in the open panel. The player shows one 22–24px line under the beats saying what the next attempt is for; it wraps only at a "·". Tempo changes from the ladder toast in paper (`↑ 77 BPM · 2 ✓ in a row`), never amber.

## UI simplification (phase 2)

Owner's complaint: "clunky and overwhelming". Critique: every section showed all its controls at once (grip, name field, tally, remove, BPM, length, Ramp, status) so the list read as a form; the routine head stacked ~10 items plus a share bar; the builder header spent ~600px before the first routine; the player showed three layers of stats, a pedal hint and settings at once and scrolled on a phone. Checklist (update with each commit so work can resume):

- [x] Engine: start tempo + ladder use the daily-check cap (no warm-up stall), test added
- [x] Song summary: "above target" instead of a % over 100
- [x] Builder: collapsed section rows + one open panel (Move/Remove inside), Options disclosure per routine, compact head, New routine at the end, share bar removed
- [x] Player: panels show counts only, one accuracy/Undo row, Settings disclosure (volume, stats switch, all-time + reset, pedal hint)
- [x] 44px targets: Sign out and List/Slide raised from 40px (Chunk | Run "Run" was still 42px wide at 390 until review round 1)
- [x] No horizontal scroll at 390/1280
- [x] Harness: before/after screenshots, songflow + slidetest updated and passing, pedal/keyboard check (`p2keys.mjs`)
- [x] DESIGN.md + README updated
- [x] Deploy check, first pass (Vercel production 09d159e: success, URL 200)
- [x] Review round 1: Settings `<summary>` blurred after a click (pedal Enter records, Space pauses; harness check in `p2keys.mjs`); segmented buttons ≥ 44px wide; row names wrap to 2 lines instead of truncating; open row shows the name once; header **+** New routine button
- [x] Review round 1 deploy check (Vercel production bf3b4b5: success, URL 200)
- [x] Review round 2: clicks/taps on Loop, Song mode, Ramp, Chunk | Run no longer leave focus on the re-drawn control (pedal Enter records, setting unchanged; `p2keys.mjs` checks mouse, touch and keyboard); keyboard focus stays on the same Chunk | Run button; row BPM unit and ramp "to" kept for screen readers
- [ ] Review round 2 deploy check

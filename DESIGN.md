# Design

Two inks on black stock, like a screen-printed gig poster: read from a music stand two metres away, operated mostly by foot. Tokens live as CSS custom properties at the top of `src/style.css`; change them there and here together.

## Colour

| Token | Value | Use |
|---|---|---|
| `--stock` | `#121110` | Page ground (warm near-black) |
| `--stock-raised` | `#1b1917` | Record bar, tally panels, dialogs |
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
- No cards: a routine is a block between 2px rules; sections are rows between 1px rules.

## Signature move: the overprint

Every ✓/✗ record floods its panel (and the record-bar button) with solid ink and knocks the numerals out to stock colour for 450 ms. Undo strikes the count through for 900 ms and the toast shows the undone record struck out, so nothing silently disappears.

## Other patterns

- **Stop strip**: the routine drawn as a line of stops; done = filled amber, current = ringed, ahead = hollow. Each stop jumps to that section.
- **Beat blocks**: four bars; beat 1 lights amber, others paper.
- **Pending chip**: a green dot that shrinks over the 600 ms double-tap window.
- **Toast**: top-centre, ink-coloured by kind, 1.4–2 s, `role=status`.
- **Focus**: 3px amber outline, 2px offset. Text selection is amber with stock text.
- **Motion**: only the overprint, toast slide (250 ms ease-out), and switch thumb; all disabled under `prefers-reduced-motion`.
- **Layout**: single column, max 640px for routines; player goes two-column (tempo | tally) from 900px. Under 560px a section's name takes the whole row and its ✓/✗ tally drops beneath it.
- **List / Slide**: a segmented switch under the all-time line. List = routines stacked vertically; Slide = one routine per screen in a scroll-snap track with ‹ n / N › and dots (off-screen routines are `inert`). The choice is per device (`localStorage`), and the slide follows the routine the pedal records to.
- **Icons beside words**: every icon sits next to its label (New routine, Sign out, Synced, Loop, Ramp, length, sections), drawn at 16–18px in `--paper-3` except on ink fills.
- **Share bar**: a 6px ✓/✗ split under each routine's tally; the counts in text sit right above it, so colour is never the only cue.

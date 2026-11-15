# Product

> Facts below were inferred from the owner's written brief (owner away, "make all the decisions"); no interview round took place. Items marked *(inferred)* should be confirmed.

## Platform

web

## Stack

Vanilla JS + Vite 5, single page (`index.html` + `src/`), Neon Auth + Neon Data API via `@neondatabase/neon-js`, deployed on Vercel with one serverless auth proxy (`api/auth`).

## Users

One guitarist (the owner) practising daily, on a phone on a music stand or a laptop beside the amp, hands busy with the instrument. A USB/Bluetooth foot pedal that sends the Enter key records results hands-free. Other people may sign up, but the product is shaped for a single dedicated practiser. *(inferred)*

## Product Purpose

Run structured practice routines: an ordered list of timed sections, each with a tempo (optionally ramping from a start BPM to an end BPM), played back as an accented click with a countdown, and record every run of a passage as good (✓) or bad (✗) so accuracy per section and per routine shows where the work is.

## Positioning

A personal practice instrument, not a generic metronome: the routine and the run-by-run ✓/✗ record are the point.

## Operating Context

Glanced at from 1 to 2 metres while playing, often in a dim room; touched rarely and briefly; feet do most of the input. Sessions last 20 to 90 minutes. *(inferred)*

## Capabilities and Constraints

- Routines ("practices") of sections stored as a `metronomes` jsonb array; per-section stats live inside each section object (`stats: { s, f }`).
- Global all-time ✓/✗ lives in `mastery_counts`; volume and the stats toggle in `user_settings`.
- No database schema changes are possible; Neon Auth trusts only `http://localhost:5173`, hence the same-origin proxy.
- Email + password sign-up with a 6-digit email code.

## Brand Commitments

None stated beyond "fresh, clean, modern dark theme, mobile-first". Name in the UI: "Metronome".

## Evidence on Hand

The previous implementation (dark, blue accent, knob control) is reference only for this redesign.

## Product Principles

1. Readable from the music stand: tempo, time left, and ✓/✗ are the largest things on screen.
2. Every record is acknowledged visibly and can be undone.
3. Nothing interrupts playing: no confirmation dialogs during a run, no accidental input from the pedal while typing.

## Accessibility & Inclusion

WCAG AA contrast, full keyboard operation, visible focus, `prefers-reduced-motion` respected, state never conveyed by colour alone (✓/✗ glyphs and words alongside green/red).

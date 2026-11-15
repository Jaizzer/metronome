# Metronome

A practice metronome for guitar routines, with a foot-pedal ✓/✗ record of every run.

**Live:** https://metronome-navy.vercel.app

## What it does

- **Routines** of timed **sections**. Each section has a name, a tempo, a length, and an optional ramp from a start BPM to an end BPM over the section. Routines can loop. The list shows one calm row per section (name, tempo, length); tap a row to edit it. Sections reorder by dragging **Move** (mouse or touch) in the open row, or with arrow keys on it. Loop, Song mode, reset and delete live under each routine's **Options**.
- **Player**: accented click (beat 1 of 4), beat blocks, countdown and progress, a stop strip to jump between sections, prev / play-pause / next. Change the tempo with − / +, by dragging the BPM number up or down, or with ↑ / ↓ (Shift = 5). A manual change stops the ramp and becomes the section's tempo. Space toggles play. The screen stays awake while playing.
- **✓ / ✗ record**: every run is recorded against the current section (the playing one, or the selected one in the routine list). Per-section and per-routine totals and accuracy show in both views; the all-time total is kept separately. Undo with the Undo button, Cmd/Ctrl+Z, or a pedal hold (last 50 records).
- **Song mode** (per routine): set a target BPM; each section is a chunk (or a Run play-through). Every ✓/✗ is logged with its tempo; 2 ✓ in a row raises the chunk's tempo, 2 ✗ suggests a smaller chunk, 4 ✗ lowers it. A tempo passed cold (first try of the day) on 2 days is *owned*; the song tempo is the lowest owned tempo among joined chunks, and each section shows its state, owned tempo and when it's due for review. Rules: `docs/PRACTICE-ALGORITHM.md`; logic: `src/engine.js`.
- **Tab import**: **Import tab** reads a Guitar Pro (.gp, .gp3–.gp5, .gpx) or MusicXML (.musicxml, .xml, .mxl) file, or a plain-text tab (.txt or pasted), and proposes a Song-mode routine: sections from the file's markers (else 8 bars each), chunks of 2–4 bars cut at phrase ends, dense bars (many notes, mostly 16ths, legato runs) as their own 1–2 bar "likely bottleneck" chunks, a seam for every pair of neighbouring chunks, and one full run. Review it (merge, split, rename, delete, pick the track, set the target BPM), then **Create routine**. In the player, **Tab** shows the section's bars and **Hear it** plays them at the live tempo with the click paused. The tab file stays on the device (IndexedDB); another device shows "Tab file not on this device · Import again". Rules: `docs/TAB-IMPORT.md`; slicing: `src/slicer.js`.
- **Tab player** (Guitar Pro / MusicXML routines): **Play tab** in the routine's Options, or **Open full tab** in the player's Tab disclosure, opens the whole song with alphaTab's cursor and a score that scrolls with the playback. Play/Pause, Stop (back to the selection start), speed 50–150% (shown with the BPM it equals), Count-in, Metronome and Loop sit in a bar at the bottom. Tap a bar to start there; tap a second bar (or the same one again) to select the bars between and loop them; chips select a routine chunk in one tap. **Practice this chunk** opens the player on the matching section; any other selection can be **Add as a new chunk** (asks first). Several tracks: pick the one shown, mute or solo any. Keys: Space or the pedal = play/pause (no ✓/✗ here), ← / → one bar, `[` / `]` loop start / end at the cursor, Escape = Exit. Opening it pauses the click; Exit leaves the click paused. Rules: `docs/TAB-PLAYER.md`.
- Volume, show/hide stats and reset all-time (player **Settings**), reset per routine (**Options**), sign up with an emailed 6-digit code, sign in, sign out. Data syncs through Neon, so it follows you across devices.

## Foot pedal

The pedal must send the **Enter** key.

| Pedal | Result |
|---|---|
| Tap | ✓ good run (recorded when the 600 ms double-tap window ends; a "Pending…" dot shows meanwhile) |
| Double-tap | ✗ bad run (recorded at once; further taps in the same window are ignored) |
| Hold ≥ 0.8 s | Undo the last record (a tap followed by a hold just cancels that tap) |

In the **Tab player** the pedal plays and pauses the tab instead (nothing is recorded there).

A record goes to the section that was current when the pedal went down, even if the section changes during the window. Undo (button or Cmd/Ctrl+Z) during the window cancels the pending ✓. Key auto-repeat is ignored. The pedal does nothing while a dialog is open or while focus is on a button, link, or field (there Enter keeps its normal meaning); mouse clicks and finished edits hand focus back so the pedal keeps working. Timings are `DOUBLE_TAP_MS` and `HOLD_MS` in `src/pedal.js`.

## Data

Tables (see `sql/schema.sql`, reference only): `practices` (a routine; its sections are the `metronomes` jsonb array), `mastery_counts` (all-time ✓/✗), `user_settings` (volume, show stats). Row-level security scopes every row to `auth.user_id()`.

Per-section stats live inside each section object as `stats: { s, f }`, with an `id` to match sections across devices, so no schema change was needed:

```json
{ "id": "6f1c…", "name": "Exercise 1", "startBPM": 100, "endBPM": 120, "ramp": true, "duration": 60, "stats": { "s": 12, "f": 3 } }
```

Song mode adds, inside the same section objects: `song: { on, target }` (mirrored on every section of the routine), `kind` (`chunk` or `run`), `joined`, and `log`: attempts `{ id, t, k: 's'|'f', bpm }`, newest 400 kept. Attempts sync as add/remove-by-id changes merged into the server's log, so they're never duplicated or lost across tabs.

Tab import adds, still inside the section objects: `bars: [start, end]` (1-based, inclusive), `seam: true` on seam chunks, `dense: true` on likely bottlenecks, and `tab: { title, track, bars, format }` (mirrored on every section, like `song`) so another device can check a re-imported file. The file itself is only in the browser's IndexedDB (`metronome-tabs`, keyed by routine id).

**Several tabs or devices at once** (`src/sync.js`): records and undos are saved as deltas. Each save re-reads the row, adds the deltas to the server's counts, and writes with compare-and-swap on `updated_at`, retrying if another device wrote first, so no record is lost. Routine edits (names, tempos, order) are last-writer-wins. Tabs re-read when focused or shown. Unsaved counts are mirrored to localStorage (per tab, per user), so closing the tab, going offline, or an expired session doesn't lose them: the next load or sign-in on that device saves them, once. A write whose response never arrives is checked against the server before anything is re-sent. Failed saves retry with backoff (5 s up to 60 s) and toast once.

## The auth proxy (and how to remove it)

Neon Auth only accepts requests whose `Origin` is in its trusted domains, which currently holds only `http://localhost:5173`. Every other origin gets `403 INVALID_ORIGIN`.

So in production the browser talks to **`/api/auth/*` on the app's own domain**. `vercel.json` rewrites that to `api/auth-proxy.js`, a Vercel function that:

- rejects any request whose `Origin` isn't the app's own origin (requests without `Origin` are allowed only for GET/HEAD), which keeps the CSRF protection Better Auth would otherwise give;
- forwards method, path, query, body, cookies, and auth headers to `NEON_AUTH_URL` with `Origin: http://localhost:5173`;
- passes response headers through (including `set-auth-jwt`, which neon-js uses as the Bearer token for the Data API) and rewrites `Set-Cookie` without a `Domain`, so the session cookie is first-party on the app's domain.

`src/db.js` uses the proxy whenever the page isn't on `http://localhost:5173`; on the Vite dev server it talks to Neon directly.

**To remove it** once `https://metronome-navy.vercel.app` is added to Neon Auth's trusted domains in the Neon console (Auth settings):

1. Delete `api/auth-proxy.js` and the `rewrites` entry in `vercel.json`.
2. In `src/db.js`, set `AUTH_URL = DIRECT_AUTH_URL` (drop `useProxy`).
3. Remove the `NEON_AUTH_URL` env var from Vercel, redeploy, and check sign-in.

## Develop

```bash
cp .env.example .env   # public Neon endpoints
npm install
npm run dev            # http://localhost:5173 (must be this port: Neon trusts it)
npm test               # pedal, records, sync, song-engine, tab-import and tab-player unit tests
node test/fixtures/make-fixtures.mjs   # rebuild the tab fixtures (hand-made MusicXML, its .gp export)
```

## Deploy

Production is Vercel (project `jaizzers-projects/metronome`). Pushing to `main` deploys through the GitHub integration, or deploy by hand:

```bash
vercel --prod --yes
```

Environment variables (Production and Preview): `VITE_NEON_AUTH_URL`, `VITE_NEON_DATA_API_URL` (baked into the bundle at build time) and `NEON_AUTH_URL` (read by the proxy at runtime). Values are in `.env.example`. Vercel deployment protection is off so the site is public.

The old GitHub Pages site serves the unbuilt source and doesn't work; use the Vercel URL.

## Third-party: alphaTab

Tab reading, drawing and playback use [alphaTab](https://alphatab.net) 1.9.0 (MPL-2.0; its source and licence ship in `node_modules/@coderline/alphatab`), loaded only when the import screen, a Tab view or the Tab player needs it, in its own chunk. Its code is MPL-2.0. Separately, alphaTab's notice asks that the "♪ alphaTab.net" credit it draws in longer scores stays visible (hiding it needs the maintainers' permission, see https://alphatab.net/docs/attribution); the app never hides it. It bundles the Bravura font (SIL OFL 1.1) and the SONiVOX soundfont used by Hear it and the Tab player (fetched once per session, shared). `@coderline/alphatab-vite` wires its worker into the build (it needs Vite 6+).

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup for the views (sign in, verify, routines, player, import, Tab player shell) |
| `src/main.js` | UI, audio engine, player, recording, saving |
| `src/pedal.js` | Pedal gesture timing (tap / double-tap / hold) |
| `src/records.js` | ✓/✗ tallies and the undo stack |
| `src/sync.js` | Conflict-safe saving (deltas + compare-and-swap) |
| `src/engine.js` | Song mode practice rules (ladder, owned tempo, reviews, song tempo); pure, no DOM |
| `src/slicer.js` | Tab import: chunks, seams, run, durations, review edits; pure |
| `src/tabtext.js`, `src/tabscore.js` | Plain-text tab parser; alphaTab score → bar list (pure, no alphaTab import) |
| `src/tabstore.js` | IndexedDB store for tab files (per routine) + re-attach check |
| `src/tabload.js`, `src/tabview.js` | Lazy loading of alphaTab; `tabview.js` is the only module that imports it (parse, draw, Hear it) |
| `src/importer.js`, `src/tabpanel.js` | Import view + review; the player's Tab disclosure |
| `src/tabplayer.js`, `src/tabplayer.css` | The full-song Tab player (lazy chunk, with its own styles) |
| `src/tabplayerlogic.js` | Tab player rules: bar taps → selection, loop ends, speed, chunk matching, keys; pure |
| `src/dom.js` | The `h()` element builder shared by the modules |
| `src/db.js` | All Neon calls (auth + Data API) |
| `src/style.css`, `src/icons.js` | Styles and the SVG icon set; tokens in `DESIGN.md` |
| `api/auth-proxy.js` | Same-origin Neon Auth proxy (see above) |
| `test/` | `node:test` unit tests; `test/fixtures/` tab files made for the tests (no copyrighted tabs) |
| `PRODUCT.md`, `DESIGN.md` | Product and design notes |

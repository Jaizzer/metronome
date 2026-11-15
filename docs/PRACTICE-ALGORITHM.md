# Practice algorithm v2 (research-based, 2026-11-15)

## Implementation status (phase 1)

Running checklist so work can resume after an interruption (update it with every commit).

- [x] `src/engine.js`: pure logic + tests (`test/engine.test.js`)
- [x] Sync: attempts (`log`) as idempotent add/del deltas in `src/sync.js` + tests
- [x] Recording: attempt per ✓/✗ in song-mode routines, undo removes it
- [x] Ladder after each chunk attempt (up/down/shrink toasts + tone), join the song
- [x] startRoutine: chunks start at their owned tempo (capped) on a new day
- [x] Builder UI: Song mode switch, target BPM, song summary, Chunk/Run toggle, one-line status per section (details behind a disclosure), Ramp hidden
- [x] Player status line
- [x] Harness check (screenshots 390/1280, scripted flow), docs (README, DESIGN)
- [x] Deploy check (Vercel production + 200)

**Built (phase 1)**
- Song mode per routine (switch in the routine head), stored as `song: { on, target }` on every section; sections carry `kind` ('chunk' | 'run'), `joined` and `log` (attempts `{ id, t, k, bpm }`, newest 400 kept). No schema change.
- Every ✓/✗ in a song routine is an attempt at the tempo it was played at (live tempo, captured at pedal press). Undo removes the attempt.
- §3 ladder per chunk: 2 ✓ in a row → +3/4/5% by band (capped: ceiling = 110% of target; joined chunks: song tempo +10%); 2 ✗ → "try half the chunk" prompt; 4 ✗ → −4%. Streaks count within one day only (today's first attempt is the cold check). Short rising/falling tone when the click is running.
- §4 owned tempo, cold attempts, review gaps 1/3/7/14/30 days, "Due today"; a new day starts each owned chunk at its owned tempo (capped).
- §5 song tempo, bottleneck, joining; plateau flag with the advice line (§3).
- §7 displays: song summary line, one status line per section (band, next review, attempts and plateau advice behind a disclosure), player line ("Work · ✓ 1 of 2 to go up · Band 82% · Owned 72", "Cold attempt · …", "Run · tap ✗ and keep playing").
- Run sections: record only, no ladder, never join, ✗ never stops playback. Song mode ignores Ramp (sections play at their tempo).

**Not built yet**
- Session planner automation (§6: cold checks → work → trouble cycle → run → finish, interleaving every 3–5 attempts, ~10 min caps).
- Rest timer between attempts (§2).
- Entry-point rotation for links (§5) and seams as automatic chunks (§1.3).
- Mixed-tempo checks every 3rd visit (§3).
- Burst chunk type (§1.5) and rhythm variations.
- Automatic chunk halving (the app only prompts "try half the chunk"; splitting is manual).
- Start-tempo calibration from 70% (§1.4), ✗ taps in runs attributed to chunks by bars, history view.

**Known limits**
- Undo removes the attempt and its ✓/✗ but does not revert a tempo change or a join the attempt already caused.
- "Reset stats" clears ✓/✗ counts only; attempt logs (and owned tempos) are kept.
- Song settings live on the sections, so a routine with no sections can't turn Song mode on (the switch is disabled).

Supersedes the scoring, tempo and planner rules in `PRACTICE-ENGINE.md` (its takes, auto-judge and display notes still apply). Sources and evidence strength: `PRACTICE-RESEARCH.md`. Numbers marked *(default)* are tunable starting settings, not research facts.

## 0. Ideas it rests on
- **Share of correct attempts predicts learning, not hours or reps** (Duke 2009). Keep most attempts clean.
- **In-session gains mislead; next-day cold performance is the real test** (Soderstrom & Bjork 2015).
- **Rotate items rather than grinding one** (contextual interference; moderate, weaker in music).
- **Stop at errors in work mode; play through in run mode** (expert pianists and trumpeters).
- **Rest between attempts**: early gains appear during short rests (Bönstrup 2019).
- **Very slow playing can use a different motion than fast playing** (Grady); bursts at target build the fast motion.

## 1. Setup (once per song)
1. **Target BPM** from the tab. **Ceiling = 110% of target** (overspeed).
2. **Chunks:** one phrase, about 1–4 bars, cut at phrase/section boundaries. Each fast legato run is its own chunk. Enter bars per chunk.
3. **Seams:** an automatic chunk for every join: last bar of A + first downbeat of B.
4. **Start tempo per chunk:** begin at 70% of target. 2 clean in a row → +4% and repeat; 2 ✗ in a row → −10%. The first tempo where you get 2 clean in a row **with relaxed, fast-type motion** is the start. Below ~50% of target counts as warm-up only.
5. **Hardest 1–3 spots** also get a **burst** chunk (2–8 notes at target tempo).

## 2. One attempt
- Loop = chunk bars + 1 bar rest; **hands off 10–30 s** between attempts *(default 1 bar + optional rest timer)*.
- **✓ = right notes + on the click + relaxed hands.** ✗ = anything else.
- **Work mode** (chunks, seams, bursts): on a ✗ **stop at once** and restart the chunk.
  - **2 ✗ in a row → simplify only as much as needed:** halve the chunk (min 2 notes); if already minimal, −4%. After 2 ✓ in a row, grow back.
- **Run mode** (links, full run): **tap ✗ and keep playing.**

## 3. Tempo ladder (in session, per chunk)
- **2 ✓ in a row → +4%** *(3–5%, default 4%; min +1 BPM)*, up to the ceiling.
- **Mixed-tempo check** every 3rd visit to a chunk: one attempt −15%, one at current, one at +5% (test).
- **Success band** (rolling 30 attempts, all sessions): **70–90% = good.**
  - Above 90% → steps become 5% and overspeed attempts are allowed.
  - Below 70% → steps become 3% and shrinking kicks in sooner.
- **Plateau:** session top tempo unchanged for **3 sessions** → stop climbing. Prompt: film your hands, check tension; legato: fretting hand alone; then bursts and rhythm variations (dotted, reversed). Variations never count toward progress.

## 4. Owned tempo (retention)
- **Cold attempt** = the first attempt of the day on a chunk, at its owned tempo.
- **Owned tempo** = the highest tempo whose **cold attempt passed on 2 separate days**.
- Each session **starts at the owned tempo** (warm-up below it allowed); the ladder climbs from there.
- A cold ✗ moves the chunk into today's work queue.

## 5. Song tempo and assembly
- **Song tempo = lowest owned tempo among joined chunks.** A new chunk joins when its owned tempo ≥ song tempo.
- **Joined chunks stop climbing at song tempo +10%** (110% of target once the song reaches target). Time flows to the **bottleneck** chunk.
- **Links** (2 chunks, then whole sections) run at the song tempo in run mode. If a link breaks twice at the same place → that seam goes back to work mode.
- **Entry points:** links start from every section boundary in rotation, so you can come in anywhere.
- **Order:** hardest spots first (islands); then chain forward; link from each boundary.

## 6. Session planner
| Step | Share | What |
|---|---|---|
| 1. Cold checks | ~10% | 1 attempt on each chunk **due for review**. Review gaps for owned chunks: **1, 3, 7, 14, 30 days** *(default; no study fixes them)*; a cold ✗ resets the gap to 1. |
| 2. Work | ~60% | The bottleneck chunk, the newest chunk, their seams. **Interleave 2–3 items, switching every 3–5 attempts**. A brand-new chunk gets a short block first (about 5 attempts). **Max ~10 min per item** per session. |
| 3. Trouble cycle | ~15% | 3–5 spots in order, each until 5 ✓. Bursts for the hardest legato spots. |
| 4. Run | ~10% | One full run (or the longest joined stretch) at song tempo, run mode, ✗ taps attributed to chunks by bars. |
| 5. Finish | ~5% | End on the **target chunk** (the bottleneck), never on new material. |

Weekday 6-minute break: step 2 only, on the bottleneck chunk (or its bursts).

## 7. What the app shows
- Player: `Chunk 7 · 74 BPM · work · 2 ✓ in a row → 77 · band 82%` + rest countdown.
- Song: `Song tempo 72 (60% of 120) · bottleneck: Legato run · owned today: 4 of 9`.
- Chunk list: owned tempo, session top, band %, last cold ✓/✗, next review date.
- History: owned tempo per chunk over time; plateau flags.

## 8. What changed from v1 (and why)
| v1 | v2 | Why |
|---|---|---|
| Pass = 24 of last 30 before any tempo change | In-session: 2 ✓ in a row → +4%; the 80% becomes the **70–90% band** that tunes step size | Experts raise tempo quickly after clean attempts and keep the success share high; the 85% figure comes from a learning model, not instruments |
| Pass on 2 days → +4% | **Owned tempo = cold first attempt on 2 days** | Cold next-day performance measures learning; session performance doesn't |
| Rounds of 10 | Switch every 3–5 attempts, ~10 min max per item | Interleaving research |
| Calibrate from 50% | Start at 70%, find the relaxed fast-motion tempo; slow = warm-up | Slow motion may not transfer (Grady, Kageyama) |
| Daily cold runs on all parts | Spaced reviews 1, 3, 7, 14, 30 days | Learned motor skills fade slowly |
| Restart from part before | Work mode: restart the chunk; run mode: keep playing | Expert stop-and-fix vs performance practice |

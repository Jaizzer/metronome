# Practice engine: ✓/✗ drive what you practise and at what tempo

Design agreed in conversation 2026-11-15 (owner's 80% / 30-attempt rule, improved). Defaults stand unless the owner changes them by 2026-11-17. Supersedes "Block mode" in TAKES-PLAN.md.

## Units
- A **piece** (e.g. Wonderful Slippery Thing) is split into **parts** 1..n. Each part is a section with its own BPM.
- The app adds a **seam** section between neighbours (last beat of part k + first beat of part k+1).
- One **full run** section (all parts, play-through, never restarted).
- Every attempt is stored: `{ t, kind: 'g'|'b', bpm, cold }` inside the section JSON (no schema change).

## Scoring
- **Rolling window: the last 30 attempts at the current BPM.** Pass = **≥ 24 ✓ (80%)**. No restarts: old attempts simply roll off.
- Fewer than 30 attempts at this BPM → "Warming up · n/30", no verdict.
- **✓ = right notes + on the click + relaxed hands.** Shown as a reminder line in the player.
- **Cold run** = the first attempt of the day on a section; tracked separately (cold accuracy over the last 10 cold runs).

## Tempo
- Pass at a BPM **two different days in a row** (next-day confirm) → **+4%** (rounded, min +1).
- **2 failed windows in a row** (30 more attempts after a window under 80%) → **−10%**.
- Step sizes and the pass mark are editable per section. Ramp sections are excluded.
- The earned BPM becomes the section's start BPM; each section keeps "best confirmed BPM".

## States (per part / seam)
| State | Rule | Practice |
|---|---|---|
| **New** | Not passed at its first tempo | Main focus |
| **Drill** | Newest unpassed part, any seam under 80%, or a maintained part whose **cold accuracy < 80%** | Main focus |
| **Maintain** | Passed and cold accuracy ≥ 80% | One cold run a day |
| **Target** | Confirmed at the song's real tempo | Cold run every few days |

## Session planner (what the routine plays today)
1. **Cold runs first**: one attempt on every Maintain part (records cold accuracy).
2. **Rounds of 10** rotating through Drill items (interleaved, not 30 in a row): ~60% of attempts on the newest part + its seam, ~25% on short links (k-1+k, k+k+1).
3. **Cap:** 2 failed windows on the same item in a session → it leaves today's rotation.
4. **Full run last**: one play-through at the lowest BPM among parts, no stopping (~15% with step 1).
- In a full run or link, a ✗ in part k means **restart from part k−1**, never from part 1 (the player shows "Resume from Part k−1").
- Optional **backward chaining**: new parts are linked as k+(k+1)… so the newest material comes first.

## Techniques built in
- **Burst section type**: a 2–4 note chunk at target tempo, auto-stop on the next beat, ✓/✗ per burst.
- **Rhythm variations**: a per-section toggle cycling straight / long-short / short-long accents.
- **Fewer clicks**: after a tempo is confirmed, offer click on 2 & 4, then once per bar.

## Player display
`Part 4 · 74 BPM · ✓ 19/24 in last 27 · Drill` + "Resume from Part 3" after a full-run ✗ + sound cues for pass / tempo change. No dialogs mid-run.

## Routine list / summary
- Each part row: state, BPM, rolling %, cold %, best confirmed BPM.
- End-of-session summary: attempts, rolling %, cold %, tempo moves, items that left the rotation.

# Takes: auto-recorded practice audio (plan, agreed 2026-11-15)

Status: planned, not built. Owner approved the design; build starts on "go".

## What the player does
- Toggle **Record takes** in the player. Each section records on its own while it plays (click included, so timing is audible). Pause pauses the take; section end / skip / Exit saves it. Takes under 3 s are dropped.
- **● REC** chip in amber (red means ✗ in this app).
- **✓/✗ marks inside the take** (added 2026-11-15): every ✓/✗ recorded during a take is stored with its time offset (`marks: [{ t, kind }]`). Playback shows them as ✓/✗ ticks on the seek bar; tap a tick to jump 3 s before it. Counting still works exactly as today.
- Section rows: **Takes (n)** → dialog: play/pause, seek, time, prev/next take, 0.75×/1×, ⭐ keep, delete, Save/Share.

## Audio
- `getUserMedia` with echoCancellation/noiseSuppression/autoGainControl **off** (guitar).
- `MediaRecorder` at 64 kbps: `audio/mp4` on Safari, `audio/webm;codecs=opus` elsewhere. ≈ 0.48 MB/min, ≈ 25 MB on an average practice day.
- Chunks every 1 s into IndexedDB, so a take cut short by a crash or dead battery is recovered on next open, marked "(cut short)".

## Storage: device first, then the Mac
```
iPad / phone (app)  ──HTTPS over Tailscale──>  Mac: Node server (launchd, KeepAlive)
  IndexedDB copy + outbox                         ├─ ~/MetronomeTakes/                       every take
                                                  └─ iCloud Drive/Metronome Keepers/          ⭐ takes (macOS syncs)
```
- Take record: `{ id, userId, routineId, sectionId, section, bpm, recordedAt, durationMs, mime, starred, sha256, marks, audio }`.
- **Outbox** (pending → uploading → done). Retries on: app open, `visibilitychange`, `online`, every 60 s while open, after each take, **Sync now**. `GET /health` first.
- **Resumable uploads**: 512 KB chunks; `HEAD /takes/:id` returns the received offset; resume from there. Take id makes retries idempotent. The device copy is deleted only after the server confirms the sha256.
- Status chip: `Mac ● online` / `Mac ○ offline · n takes waiting`.
- Playback: device copy if present (instant, offline); else stream from the Mac with HTTP Range; cache after first play.

## Mac server
- Node, one folder per routine/section, JSON index. Endpoints: `/health`, `PUT/HEAD /takes/:id` (chunked), `GET /takes?section=` , `GET /takes/:id/audio` (Range), `PATCH /takes/:id` (star), `DELETE /takes/:id`.
- Private: reachable only over **Tailscale** (`tailscale serve` HTTPS); plus a bearer token. Never exposed publicly.
- launchd agent: RunAtLoad + KeepAlive; `caffeinate -s` so the Mac doesn't system-sleep on AC power (display sleep still allowed). `pmset autorestart` if the model supports it.
- On start: copy any ⭐ take missing from the iCloud Keepers folder.
- Retention: delete unstarred takes older than 6 months (≈ 4–5 GB on disk). ⭐ kept forever.

## When the Mac is off
Recording, device copies and same-device playback keep working; uploads and cross-device playback wait and resume automatically.

## Cost
₱0: browser APIs, Tailscale free personal plan, Mac disk, iCloud for keepers only (≈ 10–30 MB/month).

## Build order
1. Recording + device copy + crash recovery + Takes dialog + ⭐ (app only).
2. Mac server + launchd.
3. Tailscale + HTTPS.
4. Outbox sync, resumable uploads, streaming, iCloud keepers, status chip.

## Block mode (✓/✗ drive the tempo), added 2026-11-15 — superseded by PRACTICE-ENGINE.md
Owner's own rule, replacing the rolling-10 idea:
- A **block** = 30 attempts at one BPM. Pass = **24 ✓** (80%). Both editable per section.
- The **7th ✗ fails the block at once** → sound cue, counters reset, same BPM. Reaching 24 ✓ with ≤ 6 ✗ passes it at once.
- Pass → **+5 BPM** (default). **2 failed blocks in a row** at the same BPM → **−5 BPM** (default). Step sizes editable.
- Player: `Block 3 · ✓ 18 / 24 · ✗ 4 of 6` plus "6 more ✓ to pass · 2 ✗ left". Sound cues for pass / fail / tempo change; never a dialog mid-run.
- Every attempt is stored with its BPM inside the section JSON (no schema change). The earned BPM becomes the section's start BPM; each section keeps a "best passed BPM".
- End-of-routine summary: blocks passed/failed and tempo moves per section.
- Built in step 1 together with takes (same per-attempt data).

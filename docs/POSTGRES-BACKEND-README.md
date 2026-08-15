# opencode Postgres backend — operating & maintenance README

This fork adds an optional **Postgres storage backend** to opencode. It is the
daily driver on Gregory's setup (default flipped stock→pg on 2026-08-14). This
README is the map: what the pieces are, how the backend is kept alive and in
sync with canonical (upstream) opencode, and how to operate/roll back.

> Companion docs:
> - `docs/POSTGRES-FORK-SYNC.md` — the detailed, canonical **resync + side-by-side deploy** procedure (rebase, regenerate migration, build, soak).
> - Memory-module integration + power-use caveat: `opencode-memory` repo → `docs/postgres-backend-integration.md`.

---

## Why this exists

Upstream opencode is SQLite-only. Running many concurrent opencode TUIs +
`serve` + background workers against one SQLite file causes:

- single-writer lock contention (`database is locked`, slow session starts),
- an event-sourced write race that surfaced as the Anthropic/Bedrock
  **`this model does not support assistant message prefill`** error, which broke
  the LLM stream mid-turn (see "Event-write race" below), and
- maintenance-vs-live-session collisions: a `VACUUM`/backup of the multi-GB
  single file contends with live writers — the window in which sessions were
  left corrupted (last message a dangling assistant tool-call) at cutover.

**Honest framing (measured):** on raw event-append throughput, SQLite is
*faster* (3–4×, see `script/pg-cutover/backend-compare*.ts`). Postgres wins on
the **operational** axis — online `VACUUM`/backup (MVCC, no writer stall),
point-in-time recovery, no single-file write lock, and robustness of opencode's
(non-retrying) event write path once the per-aggregate lock is in place. At real
interactive event rates the throughput cost is irrelevant.

### Prior predicate (this is a well-trodden path)

Choosing a local Postgres over SQLite specifically because of **write
contention** is documented, mainstream practice — not a novel workaround:

- **SQLite's own maintainers** say so. [`sqlite.org/whentouse.html`](https://www.sqlite.org/whentouse.html)
  — *"SQLite supports an unlimited number of simultaneous readers, but it will
  only allow one writer at any instant in time… some applications require more
  concurrency, and those applications may need to seek a different solution."*
  Their decision checklist is explicit: **"Many concurrent writers? → choose
  client/server,"** because a client/server engine *"has a long-running server
  process at hand to coordinate access [and] can usually handle far more write
  concurrency than SQLite ever will."* Our symptom — many concurrent opencode
  processes hitting one file, `database is locked`, slow session starts — is the
  textbook case they point to Postgres for.
- **The industry consensus nuance** (e.g. Fly.io's widely-discussed
  "all-in on server-side SQLite" thread) is the same trade we measured: SQLite
  excels at **read latency + single-writer operational simplicity**; under
  **multi-writer** load its database-level locking makes it *marginally poorer
  than Postgres*, and write traffic is where people reach for a server engine.
- **Maintenance/HA dimension:** SQLite `VACUUM` takes a whole-database lock and
  the single-file model complicates online backup — well-known reasons
  write-heavy local workloads outgrow it. Postgres does `VACUUM`/backup online.

Net: the migration is defensible by the primary source (SQLite's own guidance)
and by common practice. The measured throughput cost is the expected, accepted
trade for the concurrency + operational headroom — and is irrelevant at
opencode's real interactive event rates.

---

## The pieces

| Piece | Where | Purpose |
|---|---|---|
| **Launch shim** | `~/.opencode/bin/opencode` (POSIX sh) | Owns the `opencode` name on PATH; dispatches to `opencode-pg` (default) or `opencode-stock` (`--sqlite`). Survives upstream auto-updates because it EXECs the real binary, so `process.execPath` (what self-upgrade overwrites) is always the real binary, never the shim. |
| **`opencode-pg`** | `~/.opencode/bin/opencode-pg` | The fork build (Postgres-capable). |
| **`opencode-stock`** | `~/.opencode/bin/opencode-stock` | Unmodified upstream build (SQLite). Auto-updates in place; the `--sqlite` escape hatch + upgrade target. |
| **pg env** | `~/.config/opencode-pg/env` (mode 600) | `OPENCODE_DATABASE_URL=postgres://…` + `OPENCODE_DISABLE_AUTOUPDATE=1`. Sourced by the shim only in pg mode. |
| **Postgres** | docker `opencode-pg`, `postgres:16`, `127.0.0.1:55432`, volume `opencode-pg-data`, `--restart unless-stopped` | The store. |
| **Fork source** | `~/opencode-fix` (remote `fork`=OddballGreg/opencode, `origin`=anomalyco/opencode) | Patch set + tooling. |
| **Sync objective** | opencode-memory objective (keep-fork-synced) | Periodically rebases the patch set onto new upstream, rebuilds `opencode-pg`, soaks; promotion is gated on approval. |

### Shim usage

```
opencode [args...]                 # DEFAULT → Postgres (opencode-pg)
opencode --sqlite [args...]        # escape hatch → stock/SQLite
opencode --postgres [args...]      # force pg explicitly (same as default)
opencode --which                   # print which backend/binary would run
OPENCODE_BACKEND=stock opencode …  # env override → SQLite
```

`upgrade` is always forced onto `opencode-stock` (the fork is managed by the
sync script, never by `opencode upgrade`).

---

## Keeping it in sync with canonical opencode

The pg backend is a **small, isolated patch set** layered on an upstream base,
so it rebases cleanly. On each upstream release you care about:

```bash
cd ~/opencode-fix
git fetch origin --tags
scripts/sync-pg-fork.sh            # rebase → regenerate 0001_init.sql → rebuild opencode-pg → verify + 20-writer soak
# review the new feat/postgres-backend-v<ver> branch, then promote manually.
```

Full detail (conflict hot-zones, build, soak, promote) is in
`docs/POSTGRES-FORK-SYNC.md`. Key durability facts:

- **`PATCH_SOURCE` defaults to `feat/pg-to-sqlite-migrator`** — the local
  superset branch that carries BOTH the pg backend AND the fixes below. This is
  what makes the fixes survive upstream rebases. Do not point the sync at the
  bare `fork/feat/postgres-backend` remote (it only has the original backend
  commits, not the fixes/tooling).
- **Autoupdate stays disabled** (`OPENCODE_DISABLE_AUTOUPDATE=1` in the pg env +
  `autoupdate:false` in `~/.config/opencode/opencode.json`). An autoupdate on
  2026-08-05 clobbered the fork binary back to stock SQLite; the shim design
  now prevents that even if an update slips through (it can only overwrite
  `opencode-stock`).
- The sync is also driven automatically by the keep-fork-synced objective
  (single-flight, promotion-gated). It has already rebased the fork across
  releases (e.g. v1.18.14 → v1.18.18) with the fixes intact.

### The critical fix that MUST survive every rebase

**Event-write race** (`packages/core/src/event.ts`). opencode's durable-event
write is a transaction: read the aggregate's latest `seq`, insert at `latest+1`.
On SQLite the single writer serializes this; on Postgres two concurrent writers
in one active session race, one hits the `(aggregate_id, seq)` unique index, and
`Effect.orDie` turns it into a defect that **kills the streaming turn** — the
`assistant message prefill` symptom. Fix: on pg only, at the top of the
transaction, **upsert-and-lock** the aggregate's `event_sequence` row:

```sql
insert into event_sequence (aggregate_id, seq) values ($agg, -1)
  on conflict (aggregate_id) do update set seq = event_sequence.seq
-- (creates-if-missing AND row-locks it; no-op update never regresses seq)
```

This serializes concurrent writers per aggregate and also closes the
brand-new-aggregate first-event case (plain `FOR UPDATE` locks nothing when the
row doesn't exist yet). After any rebase, verify it is still present:

```bash
grep -c 'for update' ~/.opencode/bin/opencode-pg                                   # compiled-in
grep -c 'on conflict (aggregate_id) do update set seq' ~/.opencode/bin/opencode-pg
```

---

## Operating: cutover, rollback, monitoring

The one-time SQLite→pg cutover and its tooling live in `script/pg-cutover/`.
**The cutover has been run exactly once (2026-08-14).** The scripts are kept for
reference / disaster recovery, not routine use.

| Script | What it does |
|---|---|
| `orchestrate.sh` | Fully hand-held, detached cutover: snapshot open sessions → stop memory + oom-guard + all TUIs/serve → checkpoint/backup/fresh-init pg → migrate → restart services → auto-reopen sessions on pg. |
| `cutover.sh` | The quiescence-gated migrate+verify core (called by orchestrate). |
| `migrate-sqlite-to-pg.ts` / `migrate-pg-to-sqlite.ts` | Offline bidirectional migrators (the "no one-way door" — see POSTGRES-FORK-SYNC.md). |
| `detect-open-sessions.sh` / `detect-corrupted-sessions.sh` | Identify live TUIs→sessions, and the dangling-assistant corruption signature. |
| `reopen.sh` / `repair-session.sh` | Reopen sessions on pg; RevertEvent fallback for any that don't self-heal. |
| `memory-ingest-bridge.sh` | Interim: export pg→a SQLite file that opencode-memory watches (see integration doc). |
| `backend-compare.ts`, `backend-compare-mp.ts`, `maintenance-under-load.ts` | The benchmarks behind the "operational, not throughput" verdict. |
| `backend-health-probe.ts` | Ongoing 10-min probe → `~/.local/share/opencode/backend-health.jsonl`: write latency, db-locked errors, live process count, store size, maintenance-active. **This is the durable "is it still worth it" evidence.** |

**Rollback (one flag):** `opencode --sqlite`, or `OPENCODE_BACKEND=stock`, or
flip the shim default back to `stock`. The original SQLite db
(`~/.local/share/opencode/opencode.db`) was never modified by the cutover — it
is frozen at cutover and remains a full rollback point, alongside
`~/.local/share/opencode/cutover-backups/<stamp>/`.

**Verdict check:** analyze `backend-health.jsonl` — on pg, `write_probe_ms` and
`db_locked_errors` stay flat even when `maintenance_active=true` and
`live_processes` is high; on SQLite those spike. A stretch of flat pg samples
during maintenance-under-load is the real evidence the migration was worth it.

---

## Known follow-ups

- **Native pg ingestion for opencode-memory** (`opencode-memory#116`) — memory
  currently reads SQLite; the `memory-ingest-bridge.sh` timer is the interim
  workaround. See the integration doc.
- **Bridge efficiency** — the reverse migrator re-scans all events per run; add a
  `since`/max-seq cursor, or retire the bridge once #116 lands.
- **Workflow MCP objective params** (`opencode-memory#348`) — unrelated tooling gap noted during this work.
- **1-month health review** scheduled 2026-09-14 (memory reminder) to read the
  probe data and decide the above.

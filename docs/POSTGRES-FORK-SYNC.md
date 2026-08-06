# opencode Postgres backend fork — sync & side-by-side deploy

This fork adds an optional **Postgres storage backend** to opencode. Upstream is
SQLite-only, and running many concurrent `opencode` TUIs/servers causes SQLite
WAL lock contention (`database is locked`, slow session starts). The Postgres
backend removes that contention (proven: a 20-writer concurrency soak passes
20/20 with zero lock errors).

This document is the canonical, repeatable procedure for keeping the fork in
step with upstream and deploying it **side-by-side** with the stock binary.

> Memory refs: `#129961` (plan), `#56754` (original cutover). Keep both current.

---

## TL;DR — resync on a new upstream release

```bash
cd ~/opencode-fix
git fetch origin --tags
scripts/sync-pg-fork.sh            # rebase pg patch set -> rebuild opencode-pg -> verify + soak
# review the new branch feat/postgres-backend-v<ver>, then (only if happy) promote manually.
```

1. **Fetch** upstream (`origin/dev` + tags).
2. **Rebase** the pg patch set onto the new upstream on a fresh branch
   `feat/postgres-backend-v<ver>` (resolve DB-layer conflicts — see below).
3. **Regenerate** `packages/core/src/database/migration-pg/0001_init.sql` from the
   current dialect-aware schema (absorbs upstream schema drift).
4. **Rebuild** the separate binary to `~/.opencode/bin/opencode-pg` (never the live one).
5. **Verify** (pg read + sqlite fallback) and run the **soak on a throwaway db**.

The script does all five. Promotion to the live binary is always manual.

---

## Safety rules (non-negotiable)

- **Never** overwrite `~/.opencode/bin/opencode` (the daily driver) automatically.
  The fork installs to `~/.opencode/bin/opencode-pg` only.
- **Never** run destructive migrations against the real `opencode` pg database.
  The soak uses a throwaway db (`opencode_soak_*`) that is dropped afterward.
- The fork uses Postgres **only** when `OPENCODE_DATABASE_URL` is a `postgres://`
  URL. With no env it falls back to SQLite exactly like stock — and, because its
  installation channel is `feat-postgres-backend-v<ver>`, its SQLite path is a
  **channel-specific** db (`opencode-feat-postgres-backend-v<ver>.db`), so it
  never touches the live `opencode.db` even in SQLite mode. (Double safety.)
- **Never** push the fork branch to a remote or open MRs without asking first.
- **Never** print the Postgres password. Redact URLs in all logs.
- Keep **autoupdate disabled** (`OPENCODE_DISABLE_AUTOUPDATE=1` in the pg env, and
  `autoupdate: false` in `~/.config/opencode/opencode.json`). An autoupdate on
  2026-08-05 silently clobbered the fork binary back to stock SQLite.

---

## The pg patch set (what to keep small)

The backend is a short run of commits on `fork/feat/postgres-backend`, layered on
an upstream base (originally `v1.17.1`). Keep it small and isolated to minimize
rebase pain. Files touched, by purpose:

| Area | Files | Purpose |
|------|-------|---------|
| **New pg driver** | `packages/core/src/database/pg.bun.ts`, `pg.ts`, `pg.smoke.ts` | Bun.sql-backed effect `SqlClient` layer. Pool capped (`max` default 8, override `OPENCODE_DB_POOL_MAX`) + idle/connect timeouts to avoid `max_connections` exhaustion during startup bursts. |
| **Dialect-aware schema** | `packages/core/src/database/schema-dialect.ts` (new) + edits to `account/sql.ts`, `event/sql.ts`, `session/sql.ts`, `project/sql.ts`, `permission/sql.ts`, `share/sql.ts`, `control-plane/workspace.sql.ts`, `data-migration.sql.ts`, `database/path.ts`, `database/schema.sql.ts`, `flag/flag.ts` | One import surface (`table`, `text`, `json`, `integer`, `double`, `bool`, `index`, …) that resolves to SQLite **or** pg builders at runtime based on `OPENCODE_DATABASE_URL`. `json()` -> `text({mode:"json"})` on sqlite / `jsonb` on pg; `double()` -> `real`/`double precision`. Adds the `OPENCODE_DATABASE_URL` flag. |
| **Backend wiring** | `packages/core/src/database/database.ts`, `pg-effect-db.ts` (new), `migration.pg.ts` (new), `migration-pg/0001_init.sql` (new) | `database.ts` branches on `OPENCODE_DATABASE_URL` (`resolvedLayer()`): pg URL -> `pgLayer`, else SQLite as before. `pg-effect-db.ts` builds the effect-drizzle pg db over opencode's own pg `SqlClient` and wraps it with the SQLite-style `.run/.all/.get/.values` surface so downstream code is unchanged (also fixes jsonb encoding for Bun.SQL). `migration.pg.ts` applies a **single squashed** `0001_init.sql`. |
| **Concurrency safety** | `migration.pg.ts`, `pg.bun.ts` | `pg_advisory_xact_lock` guards the bootstrap transaction so N processes booting at once don't race on `CREATE TABLE`; a `to_regclass('migration')` + completed-set **fast path** skips the heavyweight lock tx on steady-state boots. |
| **Migrator (offline)** | `script/migrate-sqlite-to-pg.ts` | One-shot SQLite→pg data migrator. Reads `OPENCODE_DATABASE_URL`. Not part of boot. |
| **Sync tooling** | `packages/core/drizzle.pg.config.ts`, `scripts/sync-pg-fork.sh`, `docs/POSTGRES-FORK-SYNC.md` | pg drizzle config used to regenerate `0001_init.sql`; the sync script; this doc. |

### Why a squashed `0001_init.sql`?

The pg backend cannot replay upstream's SQLite-flavoured TypeScript migrations
(they contain SQLite-specific DDL). Instead it applies one squashed pg bootstrap
generated from the dialect-aware schema. **This is the main sync chore:** every
time upstream changes the schema, regenerate `0001_init.sql` (the script does
this via `drizzle.pg.config.ts`). If you'd rather keep history, add a new
numbered `000N_*.sql` to `migration-pg/` and to the `pgMigrations` list in
`migration.pg.ts` instead of overwriting `0001_init.sql`.

---

## Resolving rebase conflicts (the DB-layer hot zone)

Upstream churns the DB layer, so expect conflicts in these three files. The rule
is always: **keep the fork's dialect API, take upstream's column TYPES/shape.**

- `packages/core/src/project/sql.ts` — keep `table(...)` (dialect), take upstream's
  type names (e.g. `ProjectSchema.ID` vs `ProjectV2.ID`).
- `packages/core/src/session/sql.ts` — keep `json()` / `double()` (dialect), take
  upstream's `$type<...>()` and any added/removed columns (e.g. upstream dropped
  `session_context_epoch.agent`).
- `packages/core/src/database/database.ts` — keep `isPostgres()` + `resolvedLayer()`
  (pg-vs-sqlite branch) and `layerFromUrl` / `pgLayer`, but build the exported
  `node` with **upstream's** node factory (e.g. `makeGlobalNode({ service, layer:
  resolvedLayer(), deps: [] })`), not the fork's old `LayerNode.make`.

After resolving: `git add <files>` then `GIT_EDITOR=true git rebase --continue`.

---

## Build

```bash
cd packages/opencode
bun install                       # only if deps drifted (new upstream)
bun run script/build.ts --single  # embeds web UI; ~180MB binary
# or, faster CLI-only test binary:
bun run script/build.ts --single --skip-embed-web-ui
```

Output: `packages/opencode/dist/opencode-linux-x64/bin/opencode`. Install it to
the **separate** path:

```bash
cp packages/opencode/dist/opencode-linux-x64/bin/opencode ~/.opencode/bin/opencode-pg
chmod +x ~/.opencode/bin/opencode-pg
```

---

## Test / verify (side-by-side, non-destructive)

```bash
# pg env (mode 600, do not print the password):
set -a; . ~/.config/opencode-pg/env; set +a

# 1. reads existing pg data:
opencode-pg db "SELECT count(*)::int AS n FROM session" --format tsv     # -> 13260

# 2. SQLite fallback intact (no env -> channel-specific sqlite, count 0, never touches pg):
env -u OPENCODE_DATABASE_URL opencode-pg db "SELECT count(*)::int AS n FROM session" --format tsv
rm -f ~/.local/share/opencode/opencode-feat-postgres-backend-*.db*   # clean the throwaway channel db

# 3. concurrency soak on a THROWAWAY db (the script does this automatically):
#    creates opencode_soak_*, runs 20 concurrent boots, checks 20/20 clean, drops it.
```

Use `::int` casts on `count(*)` — Postgres returns `bigint`, which the CLI's JSON
formatter can't serialize (TSV is fine; the cast makes JSON work too).

---

## Postgres container

- `docker` container `opencode-pg`, image `postgres:16`, `--restart unless-stopped`,
  named volume `opencode-pg-data`, listening on `127.0.0.1:55432`.
- Real db: `opencode` (user `opencode`) — holds the migrated session history. **Do
  not** run destructive migrations against it.
- Connection string lives in `~/.config/opencode-pg/env` (mode 600):
  `OPENCODE_DATABASE_URL=postgres://opencode:<pw>@127.0.0.1:55432/opencode`.

---

## Promote to daily driver (manual, only when approved)

```bash
cp ~/.opencode/bin/opencode ~/.opencode/bin/opencode.sqlite-backup-$(date +%Y%m%d)  # rollback point
cp ~/.opencode/bin/opencode-pg ~/.opencode/bin/opencode                              # promote
# ensure ~/.zshrc sources ~/.config/opencode-pg/env so new shells get OPENCODE_DATABASE_URL
```

Rollback: `cp ~/.opencode/bin/opencode.sqlite-backup-<date> ~/.opencode/bin/opencode`
(or simply `unset OPENCODE_DATABASE_URL` to run the fork binary in SQLite mode).

Keep autoupdate disabled so it can't overwrite the promoted fork binary.

---

## Known follow-ups / gaps

- **SQLite→pg session delta.** The pg `opencode` db holds history migrated on
  2026-06-10 (13,260 sessions). Sessions created in stock SQLite since then are
  not yet in pg. Migrate with `script/migrate-sqlite-to-pg.ts` as a separate,
  explicit step (not done by this sync).
- **Existing pg db schema drift.** The live `opencode` pg db was bootstrapped from
  the `v1.17.1` `0001_init.sql`. Newer columns (e.g. `project_directory.strategy`)
  and the simplified `session_context_epoch` are absent. Core session reads work,
  but before promoting, either apply the delta DDL to the `opencode` db or
  re-migrate from SQLite into a freshly-initialised pg db.
- **memory ingestion.** opencode-memory reads SQLite (`opencode_db.rs`); pg-native
  session ingestion is tracked in `ghavenga/opencode-memory#116`.

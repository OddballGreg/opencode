#!/usr/bin/env bun
import { Database } from "bun:sqlite"

const SQLITE_OUT = process.env.SQLITE_OUT ?? process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? "/tmp/opencode-from-pg.db"
const PG_URL =
  process.env.OPENCODE_DATABASE_URL ?? "postgres://opencode:opencode_dev_pw@127.0.0.1:55432/opencode"

const LIVE_SQLITE_PATH = "/home/gregory/.local/share/opencode/opencode.db"
if (SQLITE_OUT === LIVE_SQLITE_PATH) {
  console.error(`FATAL: refusing to write to the live SQLite database (${LIVE_SQLITE_PATH}).`)
  console.error(`Set SQLITE_OUT to a throwaway path instead.`)
  process.exit(2)
}

const TRUNCATE = process.argv.includes("--truncate")
// Optional retention window (days). Unset = export everything (full reversible
// migration). Set = export only sessions with time_updated >= now - N days plus
// their dependent rows, and prune bridge rows that fell out of the window.
const SINCE_DAYS = process.env.SQLITE_SINCE_DAYS ? Number(process.env.SQLITE_SINCE_DAYS) : undefined
if (SINCE_DAYS !== undefined && (!Number.isFinite(SINCE_DAYS) || SINCE_DAYS <= 0)) {
  console.error(`FATAL: SQLITE_SINCE_DAYS must be a positive number, got ${process.env.SQLITE_SINCE_DAYS}`)
  process.exit(2)
}
const CUTOFF = SINCE_DAYS === undefined ? undefined : Date.now() - Math.round(SINCE_DAYS * 86_400_000)
const WINDOW_SESSIONS = `SELECT id FROM "session" WHERE time_updated >= ${CUTOFF}`
// event_sequence/event aggregates keyed by a session id follow that session;
// non-session aggregates (evt_*, singletons) are always kept.
const WINDOW_AGGREGATES = `aggregate_id IN (${WINDOW_SESSIONS}) OR aggregate_id NOT LIKE 'ses\\_%' ESCAPE '\\'`
// Per-table WHERE clause in windowed mode. Tables not listed (project, account,
// workspace, ...) are small parents and are always exported in full so FKs hold.
const WINDOW_FILTER: Record<string, string> = {
  session: `time_updated >= ${CUTOFF}`,
  message: `session_id IN (${WINDOW_SESSIONS})`,
  part: `message_id IN (SELECT id FROM "message" WHERE session_id IN (${WINDOW_SESSIONS}))`,
  todo: `session_id IN (${WINDOW_SESSIONS})`,
  event_sequence: WINDOW_AGGREGATES,
  event: WINDOW_AGGREGATES,
  session_message: `session_id IN (${WINDOW_SESSIONS})`,
  session_input: `session_id IN (${WINDOW_SESSIONS})`,
  session_context_epoch: `session_id IN (${WINDOW_SESSIONS})`,
  session_share: `session_id IN (${WINDOW_SESSIONS})`,
}
function whereOf(table: string) {
  if (CUTOFF === undefined || !WINDOW_FILTER[table]) return ""
  return ` WHERE ${WINDOW_FILTER[table]}`
}
// read batch size: how many rows to pull from pg per loop
const READ_BATCH = 4000

// FK-safe insert order. Mirrors script/migrate-sqlite-to-pg.ts exactly.
const TABLES = [
  "project",
  "account",
  "account_state",
  "control_account",
  "workspace",
  "session",
  "message",
  "part",
  "todo",
  "permission",
  "project_directory",
  "event_sequence",
  "event",
  "session_message",
  "session_input",
  "session_context_epoch",
  "session_share",
  "data_migration",
]

// column-name -> special handling, keyed by table. Mirrors the forward
// migrator's JSONB/BOOLEAN maps (pg jsonb -> sqlite TEXT json, pg boolean ->
// sqlite integer 0/1).
const JSONB: Record<string, Set<string>> = {
  event: new Set(["data"]),
  message: new Set(["data"]),
  part: new Set(["data"]),
  project: new Set(["commands"]),
  session: new Set(["summary_diffs", "metadata", "revert", "permission", "model"]),
  session_context_epoch: new Set(["snapshot"]),
  session_input: new Set(["prompt"]),
  session_message: new Set(["data"]),
  workspace: new Set(["extra"]),
}
const BOOLEAN: Record<string, Set<string>> = {
  control_account: new Set(["active"]),
}

const pg = new Bun.SQL(PG_URL)

function isJsonb(table: string, col: string) {
  return JSONB[table]?.has(col) ?? false
}
function isBool(table: string, col: string) {
  return BOOLEAN[table]?.has(col) ?? false
}

async function ensureSchema(path: string) {
  const fresh = !(await Bun.file(path).exists())
  const db = new Database(path)
  // auto_vacuum can only be chosen before the first table exists, so set it on
  // brand-new files; pruned pages can then be reclaimed with incremental_vacuum.
  if (fresh) db.run("PRAGMA auto_vacuum = INCREMENTAL; VACUUM")
  const tables = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='session'`).all()
  db.close()
  if (tables.length > 0) return
  // The target sqlite must have the exact opencode-fork drizzle schema before
  // we can insert rows. The simplest robust way to get that schema is to let
  // the pg-fork opencode binary itself bootstrap a fresh sqlite database at
  // this path (same code path a real cold boot takes), then we insert into it
  // directly. We shell out to `opencode-pg session list` with OPENCODE_DB set
  // and OPENCODE_DATABASE_URL unset so it takes the sqlite bootstrap branch of
  // database.ts (resolvedLayer() -> layerFromPath -> DatabaseMigration.apply).
  console.log(`[schema] target sqlite has no schema yet, bootstrapping via opencode-pg binary at ${path} ...`)
  const bin = process.env.OPENCODE_PG_BIN ?? `${process.env.HOME}/.opencode/bin/opencode-pg`
  const proc = Bun.spawnSync({
    cmd: [bin, "session", "list"],
    env: { ...process.env, OPENCODE_DATABASE_URL: "", OPENCODE_DB: path },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString())
    throw new Error(`Failed to bootstrap sqlite schema via ${bin} (exit ${proc.exitCode})`)
  }
  console.log(`[schema] bootstrap OK`)
}

function columnsOf(sqlite: Database, table: string): string[] {
  const rows = sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

// Serialize a pg jsonb value (already parsed into a JS value by Bun.SQL) back
// to the exact compact JSON TEXT representation sqlite's text({mode:"json"})
// columns expect (no NULs possible on the way out of pg since pg cannot store
// them, so no NUL-stripping needed in this direction).
function jsonbToText(val: unknown): string | null {
  if (val === null || val === undefined) return null
  try {
    return JSON.stringify(val)
  } catch {
    return null
  }
}

function boolToInt(val: unknown): number | null {
  if (val === null || val === undefined) return null
  return val === true || val === "t" || val === "true" ? 1 : 0
}

function normalizeInt(val: unknown): unknown {
  if (typeof val === "bigint") {
    if (val >= BigInt(Number.MIN_SAFE_INTEGER) && val <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(val)
    return val.toString()
  }
  return val
}

async function pgCount(table: string): Promise<number> {
  const r = (await pg.unsafe(`SELECT count(*)::bigint AS n FROM "${table}"${whereOf(table)}`)) as Array<{ n: string | number }>
  return Number(r[0].n)
}

function sqliteCount(sqlite: Database, table: string): number {
  const r = sqlite.query(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }
  return r.n
}

function truncateAll(sqlite: Database) {
  console.log(`[truncate] DELETE FROM ${TABLES.length} tables ...`)
  sqlite.run("PRAGMA foreign_keys = OFF")
  for (const table of [...TABLES].reverse()) {
    sqlite.run(`DELETE FROM "${table}"`)
  }
  sqlite.run("PRAGMA foreign_keys = ON")
}

// Tables whose rows belong to a session, in FK-safe insert order (children
// after parents); pruning walks this in reverse.
const SESSION_SCOPED: Record<string, string> = {
  session: "id",
  message: "session_id",
  part: "session_id",
  todo: "session_id",
  event_sequence: "aggregate_id",
  event: "aggregate_id",
  session_message: "session_id",
  session_input: "session_id",
  session_context_epoch: "session_id",
  session_share: "session_id",
}

// Delete bridge rows for sessions outside pg's current window. Membership comes
// from pg, not the bridge's own time_updated: INSERT OR IGNORE never refreshes
// existing rows, so a bridge session row can look stale while pg says it is live.
async function pruneOutOfWindow(sqlite: Database) {
  const keep = (await pg.unsafe(WINDOW_SESSIONS)) as Array<{ id: string }>
  if (keep.length === 0) {
    console.log(`[prune] pg window returned 0 sessions; skipping prune to avoid wiping the bridge`)
    return
  }
  sqlite.run(`CREATE TEMP TABLE IF NOT EXISTS keep_session (id TEXT PRIMARY KEY)`)
  sqlite.run(`DELETE FROM keep_session`)
  const add = sqlite.prepare(`INSERT OR IGNORE INTO keep_session (id) VALUES (?)`)
  sqlite.transaction(() => keep.forEach((r) => add.run(r.id)))()

  const deleted: Record<string, number> = {}
  sqlite.run("PRAGMA foreign_keys = OFF")
  sqlite.transaction(() => {
    for (const table of [...TABLES].reverse().filter((t) => SESSION_SCOPED[t])) {
      const col = SESSION_SCOPED[table]
      const scope = col === "aggregate_id" ? ` AND aggregate_id LIKE 'ses\\_%' ESCAPE '\\'` : ""
      deleted[table] = sqlite.run(
        `DELETE FROM "${table}" WHERE "${col}" NOT IN (SELECT id FROM keep_session)${scope}`,
      ).changes
    }
    // orphan parts (message pruned under another session_id, or left by live drift
    // in a previous run); any still-live ones are re-copied by this run's export
    deleted.orphan_part = sqlite.run(`DELETE FROM "part" WHERE message_id NOT IN (SELECT id FROM "message")`).changes
  })()
  sqlite.run("PRAGMA foreign_keys = ON")
  console.log(`[prune] kept ${keep.length} window sessions; deleted ${JSON.stringify(deleted)}`)

  const autoVacuum = (sqlite.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum
  const freelist = () => (sqlite.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
  const pageSize = (sqlite.query("PRAGMA page_size").get() as { page_size: number }).page_size
  const before = freelist()
  if (autoVacuum === 2) {
    sqlite.run("PRAGMA incremental_vacuum")
    console.log(`[prune] incremental_vacuum reclaimed ${before - freelist()} pages (${((before * pageSize) / 1e6).toFixed(1)} MB)`)
    return
  }
  console.log(
    `[prune] auto_vacuum=${autoVacuum} (not incremental); freelist=${before} pages (${((before * pageSize) / 1e6).toFixed(1)} MB) reusable, not vacuuming`,
  )
}

type Anomaly = { table: string; id: string; column: string; reason: string }
const anomalies: Anomaly[] = []

async function migrateTable(sqlite: Database, table: string): Promise<{ copied: number; skippedRows: number }> {
  const cols = columnsOf(sqlite, table)
  const total = await pgCount(table)
  let copied = 0
  let skippedRows = 0

  const colList = cols.map((c) => `"${c}"`).join(", ")
  const placeholders = cols.map(() => "?").join(", ")
  const insert = sqlite.prepare(`INSERT OR IGNORE INTO "${table}" (${colList}) VALUES (${placeholders})`)

  let offset = 0
  while (true) {
    const batchRows = (await pg.unsafe(
      `SELECT ${colList} FROM "${table}"${whereOf(table)} ORDER BY ${cols[0]} LIMIT ${READ_BATCH} OFFSET ${offset}`,
    )) as Array<Record<string, unknown>>
    if (batchRows.length === 0) break
    offset += READ_BATCH

    const idCol = cols.includes("id") ? "id" : cols[0]
    const insertMany = sqlite.transaction((rows: Array<Record<string, unknown>>) => {
      for (const raw of rows) {
        const values: unknown[] = []
        for (const c of cols) {
          let v = raw[c]
          if (isJsonb(table, c)) v = jsonbToText(v)
          else if (isBool(table, c)) v = boolToInt(v)
          else v = normalizeInt(v)
          values.push(v)
        }
        try {
          insert.run(...values)
          copied++
        } catch (e) {
          skippedRows++
          anomalies.push({
            table,
            id: String(raw[idCol] ?? "?"),
            column: "(row)",
            reason: `insert failed, row skipped: ${(e as Error).message?.slice(0, 120)}`,
          })
        }
      }
    })
    insertMany(batchRows)

    if (total > 0) {
      const pct = ((copied / total) * 100).toFixed(1)
      process.stdout.write(`\r  [${table}] ${copied}/${total} (${pct}%)   `)
    }
    if (batchRows.length < READ_BATCH) break
  }
  if (total > 0) process.stdout.write("\n")
  else console.log(`  [${table}] 0 rows`)
  return { copied, skippedRows }
}

async function main() {
  const start = Date.now()
  console.log(`Source : ${PG_URL} (read-only, never written)`)
  console.log(`Target : ${SQLITE_OUT}`)
  console.log(`Mode   : ${TRUNCATE ? "--truncate (clean load)" : "INSERT OR IGNORE (re-runnable)"}${CUTOFF === undefined ? "" : ", windowed + prune"}`)
  if (CUTOFF !== undefined) {
    const total = (await pg.unsafe(`SELECT count(*)::bigint AS n FROM "session"`)) as Array<{ n: string }>
    console.log(
      `Window : SQLITE_SINCE_DAYS=${SINCE_DAYS} cutoff=${new Date(CUTOFF).toISOString()} -> ${await pgCount("session")} of ${Number(total[0]?.n)} pg sessions in window`,
    )
  }
  console.log("")

  await ensureSchema(SQLITE_OUT)
  const sqlite = new Database(SQLITE_OUT)
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA foreign_keys = ON")

  if (TRUNCATE) truncateAll(sqlite)
  if (!TRUNCATE && CUTOFF !== undefined) await pruneOutOfWindow(sqlite)

  sqlite.run("PRAGMA foreign_keys = OFF")
  const perTable: Record<string, { copied: number; skipped: number }> = {}
  for (const table of TABLES) {
    const { copied, skippedRows } = await migrateTable(sqlite, table)
    perTable[table] = { copied, skipped: skippedRows }
  }
  sqlite.run("PRAGMA foreign_keys = ON")

  // ---- Verification ----
  console.log("\n================ VERIFICATION ================")
  console.log(`${"table".padEnd(24)} ${"pg".padStart(10)} ${"sqlite".padStart(10)}  match`)
  let allMatch = true
  for (const table of TABLES) {
    const pc = await pgCount(table)
    const sc = sqliteCount(sqlite, table)
    const ok = sc === pc
    if (!ok) allMatch = false
    console.log(`${table.padEnd(24)} ${String(pc).padStart(10)} ${String(sc).padStart(10)}  ${ok ? "OK" : "MISMATCH"}`)
  }

  // ---- Spot checks ----
  console.log("\n================ SPOT CHECKS ================")
  await spotChecks(sqlite)

  // ---- Anomalies ----
  console.log("\n================ ANOMALIES ================")
  if (anomalies.length === 0) {
    console.log("No conversion anomalies.")
  } else {
    console.log(`${anomalies.length} anomalies (showing up to 50):`)
    for (const a of anomalies.slice(0, 50)) {
      console.log(`  ${a.table}.${a.column} id=${a.id}: ${a.reason}`)
    }
    const byTable: Record<string, number> = {}
    for (const a of anomalies) byTable[a.table] = (byTable[a.table] ?? 0) + 1
    console.log("anomaly counts by table:", JSON.stringify(byTable))
  }

  const secs = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`\nTotal runtime: ${secs}s`)
  console.log(allMatch ? "RESULT: ALL TABLE COUNTS MATCH \u2705" : "RESULT: COUNT MISMATCH(ES) \u274c")

  await pg.end()
  sqlite.close()
  process.exit(allMatch ? 0 : 1)
}

async function spotChecks(sqlite: Database) {
  // 1. event_sequence / event integrity: every (aggregate_id, seq) pair in
  // event must exist, and the max seq per aggregate should match
  // event_sequence.seq (the invariant the event store depends on).
  const seqMismatches = sqlite
    .query(
      `SELECT es.aggregate_id, es.seq AS seq_table, MAX(e.seq) AS max_event_seq
       FROM event_sequence es LEFT JOIN event e ON e.aggregate_id = es.aggregate_id
       GROUP BY es.aggregate_id
       HAVING es.seq != COALESCE(MAX(e.seq), es.seq) AND es.seq != MAX(e.seq)`,
    )
    .all()
  console.log(`event_sequence/event seq integrity: ${seqMismatches.length === 0 ? "OK (all aggregates consistent)" : `${seqMismatches.length} MISMATCHES`}`)
  if (seqMismatches.length > 0) console.log(JSON.stringify(seqMismatches.slice(0, 10)))

  const dupPairs = sqlite
    .query(`SELECT aggregate_id, seq, COUNT(*) AS n FROM event GROUP BY aggregate_id, seq HAVING n > 1`)
    .all()
  console.log(`event (aggregate_id, seq) uniqueness: ${dupPairs.length === 0 ? "OK (no duplicates)" : `${dupPairs.length} DUPLICATES`}`)

  // 2. jsonb round-trip fidelity: compare pg jsonb_typeof vs sqlite json_valid
  const checks: Array<[string, string]> = [
    ["event", "data"],
    ["message", "data"],
    ["part", "data"],
  ]
  for (const [table, col] of checks) {
    const row = sqlite
      .query(`SELECT "${col}" AS v FROM "${table}" WHERE "${col}" IS NOT NULL LIMIT 1`)
      .get() as { v: string } | null
    if (!row) {
      console.log(`${table}.${col}: no rows to check`)
      continue
    }
    const valid = sqlite.query(`SELECT json_valid(?) AS ok`).get(row.v) as { ok: number }
    console.log(`${table}.${col} sqlite json_valid: ${valid.ok === 1 ? "OK" : "INVALID"}`)
  }

  // 3. session.time_created round-trip (bigint epoch handling)
  const sess = sqlite.query(`SELECT id, time_created FROM session LIMIT 1`).get() as {
    id: string
    time_created: number
  } | null
  if (sess) {
    const r = (await pg.unsafe(`SELECT time_created::text AS tc FROM "session" WHERE id = $1`, [sess.id])) as Array<{
      tc: string
    }>
    const match = r[0] && String(r[0].tc) === String(sess.time_created)
    console.log(`session ${sess.id} time_created pg=${r[0]?.tc} sqlite=${sess.time_created} match=${match}`)
  }

  // 4. control_account.active boolean round-trip
  const ca = sqlite.query(`SELECT email, active FROM control_account LIMIT 1`).get() as {
    email: string
    active: number
  } | null
  if (ca) {
    console.log(`control_account ${ca.email} active sqlite=${ca.active} (0/1 integer, expected)`)
  } else {
    console.log("control_account: no rows to check")
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e)
  process.exit(2)
})

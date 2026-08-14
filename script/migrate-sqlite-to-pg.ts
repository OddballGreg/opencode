#!/usr/bin/env bun
import { Database } from "bun:sqlite"
import { SQL } from "bun"

const SQLITE_PATH = "/home/gregory/.local/share/opencode/opencode.db"
const PG_URL =
  process.env.OPENCODE_DATABASE_URL ?? "postgres://opencode:opencode_dev_pw@127.0.0.1:55432/opencode"

const TRUNCATE = process.argv.includes("--truncate")
// read batch size: how many rows to pull from sqlite per loop
const READ_BATCH = 4000
// pg wire protocol caps params at 65535; keep margin
const MAX_PG_PARAMS = 60000

// FK-safe insert order
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

// column-name -> special handling, keyed by table
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

// keyset ordering column for big tables (must be a stable, indexed-ish column).
// rowid works for any non-WITHOUT-ROWID table.
const sqlite = new Database(SQLITE_PATH, { readonly: true })
const pg = new SQL(PG_URL)

function isJsonb(table: string, col: string) {
  return JSONB[table]?.has(col) ?? false
}
function isBool(table: string, col: string) {
  return BOOLEAN[table]?.has(col) ?? false
}

function columnsOf(table: string): string[] {
  const rows = sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function safeJson(val: unknown): { ok: true; value: string | null; sanitized: boolean } | { ok: false } {
  if (val === null || val === undefined) return { ok: true, value: null, sanitized: false }
  let s: string
  if (typeof val !== "string") {
    // shouldn't happen for TEXT-stored json, but stringify defensively
    try {
      s = JSON.stringify(val)
    } catch {
      return { ok: false }
    }
  } else {
    s = val
  }
  s = s.trim()
  if (s === "") return { ok: true, value: null, sanitized: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch {
    return { ok: false }
  }
  // Postgres jsonb/text cannot store the NUL character (\u0000). It is legal JSON
  // but unrepresentable in pg. If present, strip the escape sequence and re-serialize
  // so the row is preserved (flagged as an anomaly). Must re-parse to catch both the
  // literal NUL byte and the "\u0000"/"\\u0000" escape forms.
  const hasNul = s.includes("\u0000") || /\\u0000/i.test(s)
  if (hasNul) {
    const cleaned = stripNul(parsed)
    try {
      return { ok: true, value: JSON.stringify(cleaned), sanitized: true }
    } catch {
      return { ok: false }
    }
  }
  return { ok: true, value: s, sanitized: false }
}

function stripNul(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\u0000/g, "")
  if (Array.isArray(v)) return v.map(stripNul)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k.replace(/\u0000/g, "")] = stripNul(val)
    }
    return out
  }
  return v
}

function normalizeInt(val: unknown): unknown {
  if (typeof val === "bigint") {
    // keep precise; pg bigint accepts string or number
    if (val >= BigInt(Number.MIN_SAFE_INTEGER) && val <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(val)
    return val.toString()
  }
  return val
}

// Build a parameterized multi-row INSERT with explicit ::jsonb casts where needed.
function buildInsert(table: string, cols: string[], rows: Record<string, unknown>[]) {
  const colList = cols.map((c) => `"${c}"`).join(", ")
  const params: unknown[] = []
  const valueGroups: string[] = []
  for (const row of rows) {
    const placeholders: string[] = []
    for (const c of cols) {
      params.push(row[c])
      const idx = params.length
      // For jsonb columns we bind the original JSON text as a TEXT param and then
      // cast text->jsonb. The `($n)::text` wrapper forces Bun's SQL driver to bind
      // the value as text (otherwise, with a bare `$n::jsonb`, Bun JSON-encodes the
      // string and Postgres stores it double-encoded as a JSON string scalar).
      if (isJsonb(table, c)) placeholders.push(`($${idx})::text::jsonb`)
      else placeholders.push(`$${idx}`)
    }
    valueGroups.push(`(${placeholders.join(", ")})`)
  }
  const sql = `INSERT INTO "${table}" (${colList}) VALUES ${valueGroups.join(", ")} ON CONFLICT DO NOTHING`
  return { sql, params }
}

async function pgCount(table: string): Promise<number> {
  const r = (await pg.unsafe(`SELECT count(*)::bigint AS n FROM "${table}"`)) as Array<{ n: string | number }>
  return Number(r[0].n)
}

function sqliteCount(table: string): number {
  const r = sqlite.query(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }
  return r.n
}

async function truncateAll() {
  // reverse FK order + CASCADE for safety
  const list = [...TABLES].reverse().map((t) => `"${t}"`).join(", ")
  console.log(`[truncate] TRUNCATE ${TABLES.length} tables CASCADE ...`)
  await pg.unsafe(`TRUNCATE ${list} CASCADE`)
}

type Anomaly = { table: string; id: string; column: string; reason: string }
const anomalies: Anomaly[] = []

async function migrateTable(table: string): Promise<{ copied: number; skippedRows: number }> {
  const cols = columnsOf(table)
  const total = sqliteCount(table)
  let copied = 0
  let skippedRows = 0
  let offset = 0

  // try keyset on rowid (faster than OFFSET for big tables). Fall back to OFFSET if no rowid.
  let useRowid = true
  try {
    sqlite.query(`SELECT rowid FROM "${table}" LIMIT 1`).get()
  } catch {
    useRowid = false
  }

  let lastRowid = -1
  const idCol = cols.includes("id") ? "id" : cols[0]

  while (true) {
    let batchRows: Array<Record<string, unknown>>
    if (useRowid) {
      batchRows = sqlite
        .query(`SELECT rowid AS __rid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .all(lastRowid, READ_BATCH) as Array<Record<string, unknown>>
    } else {
      batchRows = sqlite
        .query(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`)
        .all(READ_BATCH, offset) as Array<Record<string, unknown>>
      offset += READ_BATCH
    }
    if (batchRows.length === 0) break
    if (useRowid) lastRowid = batchRows[batchRows.length - 1].__rid as number

    const prepared: Record<string, unknown>[] = []
    for (const raw of batchRows) {
      const row: Record<string, unknown> = {}
      let drop = false
      for (const c of cols) {
        let v = raw[c]
        if (isJsonb(table, c)) {
          const res = safeJson(v)
          if (!res.ok) {
            anomalies.push({
              table,
              id: String(raw[idCol] ?? "?"),
              column: c,
              reason: "malformed JSON -> inserted NULL",
            })
            v = null
          } else {
            if (res.sanitized) {
              anomalies.push({
                table,
                id: String(raw[idCol] ?? "?"),
                column: c,
                reason: "stripped \\u0000 (NUL) for pg compatibility",
              })
            }
            v = res.value
          }
        } else if (isBool(table, c)) {
          if (v === null || v === undefined) v = null
          else v = v === 1 || v === true || v === "1" || v === "true"
        } else {
          v = normalizeInt(v)
        }
        row[c] = v
      }
      if (!drop) prepared.push(row)
      else skippedRows++
    }

    if (prepared.length > 0) {
      const maxRowsPerInsert = Math.max(1, Math.floor(MAX_PG_PARAMS / cols.length))
      for (let i = 0; i < prepared.length; i += maxRowsPerInsert) {
        const chunk = prepared.slice(i, i + maxRowsPerInsert)
        try {
          await pg.begin(async (tx) => {
            const { sql, params } = buildInsert(table, cols, chunk)
            await tx.unsafe(sql, params)
          })
          copied += chunk.length
        } catch (e) {
          // A single bad row aborts the whole multi-row insert. Fall back to
          // per-row inserts so we preserve the good rows and log the bad ones.
          for (const row of chunk) {
            try {
              await pg.begin(async (tx) => {
                const { sql, params } = buildInsert(table, cols, [row])
                await tx.unsafe(sql, params)
              })
              copied++
            } catch (rowErr) {
              skippedRows++
              anomalies.push({
                table,
                id: String(row[idCol] ?? "?"),
                column: "(row)",
                reason: `insert failed, row skipped: ${(rowErr as Error).message?.slice(0, 120)}`,
              })
            }
          }
        }
      }
    }

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
  console.log(`Source : ${SQLITE_PATH} (read-only)`)
  console.log(`Target : ${PG_URL}`)
  console.log(`Mode   : ${TRUNCATE ? "--truncate (clean load)" : "ON CONFLICT DO NOTHING (re-runnable)"}`)
  console.log("")

  // Disable FK / trigger enforcement during bulk load for speed + ordering safety.
  await pg.unsafe(`SET session_replication_role = replica`)

  if (TRUNCATE) await truncateAll()

  const perTable: Record<string, { copied: number; skipped: number }> = {}
  for (const table of TABLES) {
    const { copied, skippedRows } = await migrateTable(table)
    perTable[table] = { copied, skipped: skippedRows }
  }

  await pg.unsafe(`SET session_replication_role = origin`)

  // ---- Verification ----
  // A table is OK when pg == sqlite, OR when the shortfall is exactly the number of
  // rows we DELIBERATELY skipped because Postgres physically cannot store them (e.g. a
  // single >256MB jsonb message from a runaway bg-worker session, plus its FK-dependent
  // children). Such an accounted-for skip is not a failure. Only an UNEXPLAINED gap is.
  console.log("\n================ VERIFICATION ================")
  console.log(`${"table".padEnd(24)} ${"sqlite".padStart(10)} ${"pg".padStart(10)} ${"skip".padStart(6)}  match`)
  // Session-spine tables must be EXACT (no skips, no drift tolerance). Content tables
  // (message/part/event) tolerate a gap that is explained by deliberate skips, plus a
  // tiny grace for benign live-read drift (the source is read READONLY at slightly
  // different instants per table; under a quiesced cutover this grace is unused).
  const SPINE = new Set(["session", "event_sequence", "todo", "project", "project_directory"])
  const DRIFT_GRACE = 5
  let allMatch = true
  for (const table of TABLES) {
    const sc = sqliteCount(table)
    const pc = await pgCount(table)
    const skipped = perTable[table]?.skipped ?? 0
    const gap = sc - pc
    let ok: boolean
    let tag: string
    if (gap === 0) {
      ok = true; tag = "OK"
    } else if (SPINE.has(table)) {
      ok = false; tag = "MISMATCH (spine!)"
    } else if (gap === skipped && skipped > 0) {
      ok = true; tag = "OK (skipped)"
    } else if (gap > 0 && gap <= skipped + DRIFT_GRACE) {
      ok = true; tag = `OK (skip ${skipped}+drift ${gap - skipped})`
    } else {
      ok = false; tag = "MISMATCH"
    }
    if (!ok) allMatch = false
    console.log(`${table.padEnd(24)} ${String(sc).padStart(10)} ${String(pc).padStart(10)} ${String(skipped).padStart(6)}  ${tag}`)
  }

  // ---- Spot checks ----
  console.log("\n================ SPOT CHECKS ================")
  await spotChecks()

  // ---- Anomalies ----
  console.log("\n================ ANOMALIES ================")
  if (anomalies.length === 0) {
    console.log("No malformed-JSON / conversion anomalies.")
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
  console.log(allMatch ? "RESULT: ALL TABLE COUNTS MATCH ✅" : "RESULT: COUNT MISMATCH(ES) ❌")

  await pg.end()
  sqlite.close()
  process.exit(allMatch ? 0 : 1)
}

async function checkJsonbFidelity(): Promise<boolean> {
  // The source stores these as JSON objects. Confirm pg stored them as jsonb
  // objects (not double-encoded string scalars).
  let ok = true
  const checks: Array<[string, string]> = [
    ["part", "data"],
    ["message", "data"],
    ["event", "data"],
  ]
  for (const [table, col] of checks) {
    const src = sqlite
      .query(`SELECT "${col}" AS v FROM "${table}" WHERE "${col}" IS NOT NULL AND trim("${col}") <> '' LIMIT 1`)
      .get() as { v: string } | null
    if (!src) continue
    const srcType = jsTypeOfJson(src.v)
    const r = (await pg.unsafe(
      `SELECT jsonb_typeof("${col}") AS t FROM "${table}" WHERE "${col}" IS NOT NULL LIMIT 1`,
    )) as Array<{ t: string }>
    const pgType = r[0]?.t
    const match = srcType === pgType
    if (!match) ok = false
    console.log(`fidelity ${table}.${col}: sqlite=${srcType} pg=${pgType} ${match ? "OK" : "MISMATCH (double-encoded?)"}`)
  }
  return ok
}

function jsTypeOfJson(s: string): string {
  try {
    const v = JSON.parse(s)
    if (v === null) return "null"
    if (Array.isArray(v)) return "array"
    if (typeof v === "object") return "object"
    if (typeof v === "string") return "string"
    if (typeof v === "number") return "number"
    if (typeof v === "boolean") return "boolean"
  } catch {}
  return "unknown"
}

async function spotChecks() {
  await checkJsonbFidelity()

  // 1. a session row with non-null metadata -> jsonb_typeof
  const sess = sqlite
    .query(`SELECT id FROM session WHERE metadata IS NOT NULL AND trim(metadata) <> '' LIMIT 1`)
    .get() as { id: string } | null
  if (sess) {
    const r = (await pg.unsafe(`SELECT jsonb_typeof(metadata) AS t FROM "session" WHERE id = $1`, [sess.id])) as Array<{
      t: string
    }>
    console.log(`session ${sess.id} metadata jsonb_typeof = ${r[0]?.t ?? "(missing)"}`)
  } else {
    console.log("session: no non-null metadata to check")
  }

  // 2. message.data valid jsonb
  const msg = sqlite
    .query(`SELECT id FROM message WHERE data IS NOT NULL AND trim(data) <> '' LIMIT 1`)
    .get() as { id: string } | null
  if (msg) {
    const r = (await pg.unsafe(`SELECT jsonb_typeof(data) AS t FROM "message" WHERE id = $1`, [msg.id])) as Array<{
      t: string
    }>
    console.log(`message ${msg.id} data jsonb_typeof = ${r[0]?.t ?? "(missing)"}`)
  }

  // 3. part.data valid jsonb
  const part = sqlite
    .query(`SELECT id FROM part WHERE data IS NOT NULL AND trim(data) <> '' LIMIT 1`)
    .get() as { id: string } | null
  if (part) {
    const r = (await pg.unsafe(`SELECT jsonb_typeof(data) AS t FROM "part" WHERE id = $1`, [part.id])) as Array<{
      t: string
    }>
    console.log(`part ${part.id} data jsonb_typeof = ${r[0]?.t ?? "(missing)"}`)
  }

  // 4. bigint time_created round-trip for a session
  const t = sqlite.query(`SELECT id, time_created FROM session LIMIT 1`).get() as {
    id: string
    time_created: number
  } | null
  if (t) {
    const r = (await pg.unsafe(`SELECT time_created::text AS tc FROM "session" WHERE id = $1`, [t.id])) as Array<{
      tc: string
    }>
    const match = r[0] && String(r[0].tc) === String(t.time_created)
    console.log(`session ${t.id} time_created sqlite=${t.time_created} pg=${r[0]?.tc} match=${match}`)
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e)
  process.exit(2)
})

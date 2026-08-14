#!/usr/bin/env bun
/**
 * backend-compare.ts - Stability & performance comparison: SQLite vs Postgres
 * for the opencode workload, using THROWAWAY databases (never touches live data).
 *
 * Measures the three things that actually distinguish the backends for opencode:
 *   1. CONCURRENT-WRITE STABILITY - N writers doing the event-append read-modify-write
 *      (read latest seq -> insert latest+1) against the same aggregate. This is the
 *      exact operation that broke on pg pre-fix and serializes silently on SQLite.
 *   2. WRITE THROUGHPUT under concurrency - events/sec with N concurrent writers.
 *   3. READ LATENCY - a representative "load a session's messages" query.
 *
 * SQLite is exercised in WAL mode (opencode's mode). Postgres uses a throwaway db.
 *
 * Usage: bun run backend-compare.ts [--writers N] [--events-per-writer M]
 */
import { Database } from "bun:sqlite"
import { SQL } from "bun"

const WRITERS = Number(process.argv.find((a, i) => process.argv[i - 1] === "--writers") ?? 20)
const EPW = Number(process.argv.find((a, i) => process.argv[i - 1] === "--events-per-writer") ?? 25)
const PG_URL = process.env.OPENCODE_DATABASE_URL

function pct(sorted: number[], p: number) {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const sum = s.reduce((a, b) => a + b, 0)
  return { n: s.length, mean: sum / s.length, p50: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1] }
}

// ---------------- SQLite ----------------
async function sqliteSuite() {
  const path = `/tmp/backend-cmp-${process.pid}.db`
  for (const suffix of ["", "-wal", "-shm"]) try { require("fs").unlinkSync(path + suffix) } catch {}
  const db = new Database(path)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000")
  db.exec(`CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT, data TEXT,
           UNIQUE(aggregate_id, seq))`)
  db.exec(`CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`)
  const AGG = "agg_sqlite"
  db.query(`INSERT INTO event_sequence VALUES (?, -1)`).run(AGG)

  // 1+2. concurrent-ish writers. bun:sqlite is synchronous, so true parallelism
  // isn't possible in-process; we interleave to exercise the busy/lock path and
  // measure serialized throughput + any lock failures (SQLite's real behavior:
  // it serializes, so failures should be ~0 but throughput is single-writer bound).
  let fail = 0
  const lat: number[] = []
  const t0 = performance.now()
  const insTx = db.transaction((agg: string, i: number) => {
    const row = db.query(`SELECT seq FROM event_sequence WHERE aggregate_id=?`).get(agg) as any
    const next = (row?.seq ?? -1) + 1
    db.query(`INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?,?,?,?,?)`).run(
      `e_${i}_${next}`, agg, next, "t.e", JSON.stringify({ i }))
    db.query(`UPDATE event_sequence SET seq=? WHERE aggregate_id=?`).run(next, agg)
  })
  for (let w = 0; w < WRITERS; w++) {
    for (let e = 0; e < EPW; e++) {
      const s = performance.now()
      try { insTx(AGG, w * EPW + e) } catch { fail++ }
      lat.push(performance.now() - s)
    }
  }
  const wall = performance.now() - t0
  const total = WRITERS * EPW
  // seed some messages for the read test
  const seed = db.transaction(() => {
    for (let i = 0; i < 500; i++) db.query(`INSERT INTO message VALUES(?,?,?,?)`).run(
      `m${i}`, "sess1", Date.now(), JSON.stringify({ role: "assistant", body: "x".repeat(200) }))
  })
  seed()
  const rlat: number[] = []
  for (let i = 0; i < 200; i++) {
    const s = performance.now()
    db.query(`SELECT id,data FROM message WHERE session_id=? ORDER BY time_created`).all("sess1")
    rlat.push(performance.now() - s)
  }
  db.close()
  for (const suffix of ["", "-wal", "-shm"]) try { require("fs").unlinkSync(path + suffix) } catch {}
  return { fail, total, wall, throughput: total / (wall / 1000), writeLat: stats(lat), readLat: stats(rlat) }
}

// ---------------- Postgres ----------------
async function pgSuite() {
  if (!PG_URL) return null
  const admin = new SQL(PG_URL)
  const dbname = `backend_cmp_${process.pid}`
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${dbname}`)
  await admin.end()
  const url = PG_URL.replace(/\/[^/]+$/, `/${dbname}`)
  const sql = new SQL(url)
  await sql.unsafe(`CREATE TABLE event_sequence(aggregate_id text PRIMARY KEY, seq bigint NOT NULL)`)
  await sql.unsafe(`CREATE TABLE event(id text PRIMARY KEY, aggregate_id text NOT NULL, seq bigint NOT NULL, type text, data jsonb, UNIQUE(aggregate_id, seq))`)
  await sql.unsafe(`CREATE TABLE message(id text PRIMARY KEY, session_id text, time_created bigint, data jsonb)`)
  const AGG = "agg_pg"
  await sql.unsafe(`INSERT INTO event_sequence VALUES ($1, -1)`, [AGG])

  const lat: number[] = []
  let fail = 0
  // TRUE concurrency: fire all writer*event ops with the upsert-and-lock fix.
  const t0 = performance.now()
  const ops: Promise<void>[] = []
  for (let w = 0; w < WRITERS; w++) {
    ops.push((async () => {
      for (let e = 0; e < EPW; e++) {
        const s = performance.now()
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(`INSERT INTO event_sequence(aggregate_id,seq) VALUES($1,-1) ON CONFLICT (aggregate_id) DO UPDATE SET seq=event_sequence.seq`, [AGG])
            const r = await tx.unsafe(`SELECT seq FROM event_sequence WHERE aggregate_id=$1`, [AGG]) as any[]
            const next = Number(r[0]?.seq ?? -1) + 1
            await tx.unsafe(`INSERT INTO event(id,aggregate_id,seq,type,data) VALUES($1,$2,$3,$4,$5)`, [`e_${w}_${e}_${next}`, AGG, next, "t.e", { i: w * EPW + e }])
            await tx.unsafe(`UPDATE event_sequence SET seq=$1 WHERE aggregate_id=$2`, [next, AGG])
          })
        } catch { fail++ }
        lat.push(performance.now() - s)
      }
    })())
  }
  await Promise.all(ops)
  const wall = performance.now() - t0
  const total = WRITERS * EPW
  const cnt = (await sql.unsafe(`SELECT count(*)::int c, count(DISTINCT seq)::int d FROM event`) as any[])[0]
  // read test
  for (let i = 0; i < 500; i++) await sql.unsafe(`INSERT INTO message VALUES($1,$2,$3,$4)`, [`m${i}`, "sess1", Date.now(), { role: "assistant", body: "x".repeat(200) }])
  const rlat: number[] = []
  for (let i = 0; i < 200; i++) {
    const s = performance.now()
    await sql.unsafe(`SELECT id,data FROM message WHERE session_id=$1 ORDER BY time_created`, ["sess1"])
    rlat.push(performance.now() - s)
  }
  await sql.end()
  const admin2 = new SQL(PG_URL)
  await admin2.unsafe(`DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)`)
  await admin2.end()
  return { fail, total, wall, throughput: total / (wall / 1000), distinctSeq: cnt.d, rows: cnt.c, writeLat: stats(lat), readLat: stats(rlat) }
}

const fmt = (s: any) => `n=${s.n} mean=${s.mean.toFixed(2)}ms p50=${s.p50.toFixed(2)} p95=${s.p95.toFixed(2)} max=${s.max.toFixed(2)}`
console.log(`\n=== Backend comparison: ${WRITERS} writers x ${EPW} events (${WRITERS * EPW} total) ===\n`)
const sq = await sqliteSuite()
console.log("SQLite (WAL, in-process serialized):")
console.log(`  write failures : ${sq.fail}/${sq.total}`)
console.log(`  throughput     : ${sq.throughput.toFixed(0)} events/sec (wall ${sq.wall.toFixed(0)}ms)`)
console.log(`  write latency  : ${fmt(sq.writeLat)}`)
console.log(`  read latency   : ${fmt(sq.readLat)}`)
const pg = await pgSuite()
if (pg) {
  console.log("\nPostgres (true concurrency, upsert-and-lock fix):")
  console.log(`  write failures : ${pg.fail}/${pg.total}  ${pg.fail === 0 && pg.distinctSeq === pg.rows ? "(0 fail, contiguous seq)" : "(!)"}`)
  console.log(`  throughput     : ${pg.throughput.toFixed(0)} events/sec (wall ${pg.wall.toFixed(0)}ms)`)
  console.log(`  write latency  : ${fmt(pg.writeLat)}`)
  console.log(`  read latency   : ${fmt(pg.readLat)}`)
} else console.log("\nPostgres: SKIPPED (OPENCODE_DATABASE_URL not set)")
console.log("")

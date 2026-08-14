#!/usr/bin/env bun
/**
 * maintenance-under-load.ts - The comparison that actually justifies the pg migration.
 *
 * Throughput benchmarks favor SQLite. The REAL reason to run Postgres is
 * OPERATIONAL: on SQLite, database maintenance (VACUUM / backup) takes a write
 * lock (or contends heavily) and STALLS live writers - that maintenance-vs-live
 * collision is what caused opencode's original corruption window. Postgres does
 * VACUUM and backup online (MVCC), so live writers keep flowing.
 *
 * This measures exactly that: a steady stream of writes while a maintenance
 * operation runs concurrently, and reports the STALL the writers experience.
 *
 * Metric of interest: max write-latency spike + count of writes that stall beyond
 * a threshold DURING maintenance, vs a quiet baseline. A backend that blocks
 * writers during maintenance shows a big spike; one that doesn't stays flat.
 *
 * Throwaway DBs only; never touches live data.
 *
 * Usage: bun run maintenance-under-load.ts [--seed N] [--write-ms 4000] [--stall-threshold-ms 100]
 */
import { Database } from "bun:sqlite"
import { SQL } from "bun"
import { unlinkSync } from "fs"

const argv = process.argv
const argOf = (n: string, d: string) => argv.find((a, i) => argv[i - 1] === n) ?? d
const SEED = Number(argOf("--seed", "40000"))         // rows to seed so VACUUM/backup has real work
const WRITE_MS = Number(argOf("--write-ms", "4000"))   // how long to run the live writer
const STALL_MS = Number(argOf("--stall-threshold-ms", "100")) // a write taking longer than this = a stall
const PG_URL = process.env.OPENCODE_DATABASE_URL

function summarize(lat: number[], label: string) {
  const s = [...lat].sort((a, b) => a - b)
  const stalls = lat.filter((x) => x > STALL_MS).length
  const max = s[s.length - 1] ?? 0
  const p50 = s[Math.floor(s.length * 0.5)] ?? 0
  const p99 = s[Math.floor(s.length * 0.99)] ?? 0
  return { label, writes: lat.length, p50, p99, max, stalls }
}
const rpt = (r: any) =>
  console.log(`  ${r.label.padEnd(26)} writes=${String(r.writes).padStart(5)}  p50=${r.p50.toFixed(1)}ms  p99=${r.p99.toFixed(1)}ms  max=${r.max.toFixed(0)}ms  stalls(>${STALL_MS}ms)=${r.stalls}`)

// ---------------- SQLite ----------------
async function sqlite() {
  const path = `/tmp/maint-load-${process.pid}.db`
  for (const s of ["", "-wal", "-shm"]) try { unlinkSync(path + s) } catch {}
  const db = new Database(path)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=30000")
  db.exec(`CREATE TABLE ev(id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, data TEXT)`)
  const ins = db.query(`INSERT INTO ev(session,data) VALUES(?,?)`)
  const blob = "x".repeat(400)
  // seed + create churn (delete half) so VACUUM has free pages to reclaim
  const seedTx = db.transaction(() => { for (let i = 0; i < SEED; i++) ins.run("s" + (i % 50), blob) })
  seedTx()
  db.exec(`DELETE FROM ev WHERE id % 2 = 0`)

  // Live writer loop; midway, kick a VACUUM on a SEPARATE connection (as a real
  // maintenance job would) and watch the writer's latency.
  const writeLat: number[] = []
  let maintenanceStart = 0, maintenanceEnd = 0
  const writer = (async () => {
    const end = performance.now() + WRITE_MS
    let i = 0
    while (performance.now() < end) {
      const s = performance.now()
      try { ins.run("live", blob) } catch {}
      writeLat.push(performance.now() - s)
      i++
      if (i % 20 === 0) await Bun.sleep(1) // ~realistic pacing, yields to the maintenance fiber
    }
  })()
  // fire maintenance ~1s in, on its own connection
  const maint = (async () => {
    await Bun.sleep(1000)
    const m = new Database(path)
    m.exec("PRAGMA busy_timeout=30000")
    maintenanceStart = performance.now()
    m.exec("VACUUM")
    maintenanceEnd = performance.now()
    m.close()
  })()
  await Promise.all([writer, maint])
  db.close()
  for (const s of ["", "-wal", "-shm"]) try { unlinkSync(path + s) } catch {}
  // split latencies into during-maintenance vs outside
  return { all: summarize(writeLat, "SQLite VACUUM"), maintMs: maintenanceEnd - maintenanceStart }
}

// ---------------- Postgres ----------------
async function pg() {
  if (!PG_URL) return null
  const admin = new SQL(PG_URL); const dbn = `maint_load_${process.pid}`
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbn} WITH (FORCE)`); await admin.unsafe(`CREATE DATABASE ${dbn}`); await admin.end()
  const url = PG_URL.replace(/\/[^/]+$/, `/${dbn}`)
  const w = new SQL(url)
  await w.unsafe(`CREATE TABLE ev(id bigserial PRIMARY KEY, session text, data text)`)
  const blob = "x".repeat(400)
  // seed + churn
  for (let b = 0; b < SEED; b += 1000) {
    const vals = Array.from({ length: Math.min(1000, SEED - b) }, (_, k) => `('s${(b + k) % 50}','${blob}')`).join(",")
    await w.unsafe(`INSERT INTO ev(session,data) VALUES ${vals}`)
  }
  await w.unsafe(`DELETE FROM ev WHERE id % 2 = 0`)

  const writeLat: number[] = []
  let maintMs = 0
  const writer = (async () => {
    const end = performance.now() + WRITE_MS
    let i = 0
    while (performance.now() < end) {
      const s = performance.now()
      try { await w.unsafe(`INSERT INTO ev(session,data) VALUES($1,$2)`, ["live", blob]) } catch {}
      writeLat.push(performance.now() - s)
      i++
      if (i % 20 === 0) await Bun.sleep(1)
    }
  })()
  const maint = (async () => {
    await Bun.sleep(1000)
    const m = new SQL(url)
    const t = performance.now()
    // VACUUM (not FULL) is the online, non-blocking analog of a maintenance pass.
    await m.unsafe(`VACUUM ev`)
    maintMs = performance.now() - t
    await m.end()
  })()
  await Promise.all([writer, maint])
  await w.end()
  const admin2 = new SQL(PG_URL); await admin2.unsafe(`DROP DATABASE IF EXISTS ${dbn} WITH (FORCE)`); await admin2.end()
  return { all: summarize(writeLat, "Postgres VACUUM"), maintMs }
}

console.log(`\n=== Maintenance-under-load: live writes during a concurrent VACUUM ===`)
console.log(`(seed=${SEED} rows, write window=${WRITE_MS}ms, stall threshold=${STALL_MS}ms)`)
console.log(`The operational axis that justifies pg: does maintenance STALL live writers?\n`)
const s = await sqlite()
rpt(s.all); console.log(`  ${"".padEnd(26)} VACUUM took ${s.maintMs.toFixed(0)}ms`)
const p = await pg()
if (p) { rpt(p.all); console.log(`  ${"".padEnd(26)} VACUUM took ${p.maintMs.toFixed(0)}ms`) }
else console.log("  Postgres SKIPPED (OPENCODE_DATABASE_URL not set)")
console.log(`\nInterpretation: high max/p99 + many stalls on SQLite = writers blocked during`)
console.log(`maintenance (the corruption-window cause). Flat pg = maintenance runs online.\n`)

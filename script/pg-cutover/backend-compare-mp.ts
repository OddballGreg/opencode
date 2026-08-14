#!/usr/bin/env bun
/**
 * backend-compare-mp.ts - MULTI-PROCESS backend comparison: SQLite vs Postgres.
 *
 * Unlike backend-compare.ts (in-process, which can't exercise SQLite's real
 * weakness), this spawns N real OS worker PROCESSES that write concurrently -
 * the actual opencode scenario (many TUIs + serve + bg workers hitting one store).
 *
 * Two modes per backend:
 *   --scenario distinct : each process writes to its OWN session (realistic:
 *                         independent sessions writing in parallel). This is where
 *                         SQLite's single-writer lock serializes everyone and pg's
 *                         MVCC lets them proceed in parallel.
 *   --scenario shared   : all processes hammer ONE session (contention worst case).
 *
 * Throwaway DBs only; never touches live data.
 *
 * Usage: bun run backend-compare-mp.ts [--procs N] [--events-per-proc M] [--scenario distinct|shared]
 */
import { Database } from "bun:sqlite"
import { SQL } from "bun"
import { unlinkSync } from "fs"

const argv = process.argv
const argOf = (name: string, def: string) => argv.find((a, i) => argv[i - 1] === name) ?? def
const PROCS = Number(argOf("--procs", "20"))
const EPP = Number(argOf("--events-per-proc", "25"))
const SCENARIO = argOf("--scenario", "distinct")
const PG_URL = process.env.OPENCODE_DATABASE_URL
const SQLITE_PATH = `/tmp/backend-cmp-mp-${process.pid}.db`

// ------- worker mode: invoked as a child with env WORKER=1 -------
if (process.env.CMP_WORKER === "1") {
  const backend = process.env.CMP_BACKEND!
  const idx = Number(process.env.CMP_IDX!)
  const epp = Number(process.env.CMP_EPP!)
  const scenario = process.env.CMP_SCENARIO!
  const agg = scenario === "shared" ? "shared_agg" : `agg_${idx}`
  let fail = 0
  const lat: number[] = []

  if (backend === "sqlite") {
    const db = new Database(process.env.CMP_SQLITE_PATH!)
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000")
    const tx = db.transaction((a: string, i: number) => {
      const row = db.query(`SELECT seq FROM event_sequence WHERE aggregate_id=?`).get(a) as any
      const next = (row?.seq ?? -1) + 1
      db.query(`INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?,?,?,?,?)`).run(`e_${i}_${a}_${next}`, a, next, "t", "{}")
      db.query(`INSERT INTO event_sequence(aggregate_id,seq) VALUES(?,?) ON CONFLICT(aggregate_id) DO UPDATE SET seq=?`).run(a, next, next)
    })
    for (let e = 0; e < epp; e++) {
      const s = performance.now()
      // Retry on SQLITE_BUSY/locked (mirrors a real client that would retry),
      // but cap retries so a genuinely stuck writer still counts as a failure.
      let ok = false
      for (let attempt = 0; attempt < 5 && !ok; attempt++) {
        try { tx(agg, idx * epp + e); ok = true }
        catch (err: any) {
          const m = String(err?.message || err)
          if (/lock|busy/i.test(m) && attempt < 4) { await Bun.sleep(5 + attempt * 10); continue }
          break
        }
      }
      if (!ok) fail++
      lat.push(performance.now() - s)
    }
    db.close()
  } else {
    const sql = new SQL(process.env.CMP_PG_URL!)
    for (let e = 0; e < epp; e++) {
      const s = performance.now()
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`INSERT INTO event_sequence(aggregate_id,seq) VALUES($1,-1) ON CONFLICT(aggregate_id) DO UPDATE SET seq=event_sequence.seq`, [agg])
          const r = await tx.unsafe(`SELECT seq FROM event_sequence WHERE aggregate_id=$1`, [agg]) as any[]
          const next = Number(r[0]?.seq ?? -1) + 1
          await tx.unsafe(`INSERT INTO event(id,aggregate_id,seq,type,data) VALUES($1,$2,$3,$4,$5)`, [`e_${idx}_${e}_${next}`, agg, next, "t", {}])
          await tx.unsafe(`UPDATE event_sequence SET seq=$1 WHERE aggregate_id=$2`, [next, agg])
        })
      } catch { fail++ }
      lat.push(performance.now() - s)
    }
    await sql.end()
  }
  const sum = lat.reduce((a, b) => a + b, 0)
  process.stdout.write(JSON.stringify({ fail, n: lat.length, mean: sum / lat.length, max: Math.max(...lat) }) + "\n")
  process.exit(0)
}

// ------- coordinator -------
function pctl(xs: number[], p: number) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] ?? 0 }

async function runBackend(backend: "sqlite" | "pg"): Promise<any> {
  // setup
  let sqlitePath = "", pgUrl = "", dbname = ""
  if (backend === "sqlite") {
    sqlitePath = SQLITE_PATH
    for (const s of ["", "-wal", "-shm"]) try { unlinkSync(sqlitePath + s) } catch {}
    const db = new Database(sqlitePath)
    db.exec("PRAGMA journal_mode=WAL")
    db.exec(`CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)`)
    db.exec(`CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT, data TEXT, UNIQUE(aggregate_id,seq))`)
    db.close()
  } else {
    if (!PG_URL) return null
    const admin = new SQL(PG_URL); dbname = `backend_cmp_mp_${process.pid}`
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)`); await admin.unsafe(`CREATE DATABASE ${dbname}`); await admin.end()
    pgUrl = PG_URL.replace(/\/[^/]+$/, `/${dbname}`)
    const sql = new SQL(pgUrl)
    await sql.unsafe(`CREATE TABLE event_sequence(aggregate_id text PRIMARY KEY, seq bigint NOT NULL)`)
    await sql.unsafe(`CREATE TABLE event(id text PRIMARY KEY, aggregate_id text NOT NULL, seq bigint NOT NULL, type text, data jsonb, UNIQUE(aggregate_id,seq))`)
    await sql.end()
  }

  const t0 = performance.now()
  const procs = Array.from({ length: PROCS }, (_, i) =>
    Bun.spawn(["bun", "run", import.meta.path], {
      env: { ...process.env, CMP_WORKER: "1", CMP_BACKEND: backend, CMP_IDX: String(i), CMP_EPP: String(EPP), CMP_SCENARIO: SCENARIO, CMP_SQLITE_PATH: sqlitePath, CMP_PG_URL: pgUrl },
      stdout: "pipe", stderr: "pipe",
    }))
  const results = await Promise.all(procs.map(async (p) => {
    const out = await new Response(p.stdout).text()
    await p.exited
    try { return JSON.parse(out.trim().split("\n").pop()!) } catch { return { fail: EPP, n: 0, mean: 0, max: 0, crashed: true } }
  }))
  const wall = performance.now() - t0

  // verify integrity
  let rows = 0, fail = 0, crashed = 0
  const means: number[] = [], maxes: number[] = []
  for (const r of results) { fail += r.fail; if (r.crashed) crashed++; if (r.mean) means.push(r.mean); if (r.max) maxes.push(r.max) }
  let dup = 0
  if (backend === "sqlite") {
    const db = new Database(sqlitePath)
    rows = (db.query(`SELECT count(*) c FROM event`).get() as any).c
    dup = (db.query(`SELECT count(*) c FROM (SELECT aggregate_id,seq,count(*) n FROM event GROUP BY aggregate_id,seq HAVING n>1)`).get() as any).c
    db.close()
    for (const s of ["", "-wal", "-shm"]) try { unlinkSync(sqlitePath + s) } catch {}
  } else {
    const sql = new SQL(pgUrl)
    rows = Number((await sql.unsafe(`SELECT count(*)::int c FROM event`) as any[])[0].c)
    dup = Number((await sql.unsafe(`SELECT count(*)::int c FROM (SELECT aggregate_id,seq FROM event GROUP BY aggregate_id,seq HAVING count(*)>1) x`) as any[])[0].c)
    await sql.end()
    const admin = new SQL(PG_URL!); await admin.unsafe(`DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)`); await admin.end()
  }
  const expected = PROCS * EPP
  return { wall, throughput: rows / (wall / 1000), rows, expected, fail, crashed, dup,
    procMeanLat: means.reduce((a, b) => a + b, 0) / (means.length || 1), worstProcMax: Math.max(...maxes, 0) }
}

console.log(`\n=== MULTI-PROCESS comparison: ${PROCS} processes x ${EPP} events, scenario=${SCENARIO} (${PROCS * EPP} expected) ===\n`)
const rpt = (name: string, r: any) => {
  if (!r) { console.log(`${name}: SKIPPED`); return }
  const ok = r.rows === r.expected && r.fail === 0 && r.dup === 0 && r.crashed === 0
  console.log(`${name}:`)
  console.log(`  integrity      : rows=${r.rows}/${r.expected} failures=${r.fail} dup_seq=${r.dup} crashed_procs=${r.crashed}  ${ok ? "CLEAN ✓" : "DEGRADED ✗"}`)
  console.log(`  wall time      : ${r.wall.toFixed(0)}ms`)
  console.log(`  throughput     : ${r.throughput.toFixed(0)} events/sec`)
  console.log(`  per-proc mean latency: ${r.procMeanLat.toFixed(2)}ms  worst op: ${r.worstProcMax.toFixed(0)}ms`)
}
const sq = await runBackend("sqlite")
rpt("SQLite (WAL, multi-process)", sq)
const pg = await runBackend("pg")
rpt("Postgres (multi-process)", pg)
console.log("")

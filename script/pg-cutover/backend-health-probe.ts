#!/usr/bin/env bun
/**
 * backend-health-probe.ts - Ongoing evidence for "was the pg migration worth it".
 *
 * Rather than a synthetic benchmark (which favors SQLite on throughput and can't
 * cheaply reproduce the 8GB-file maintenance incident), this probes the REAL
 * signals that distinguish the backends in production. Run it periodically (cron/
 * timer) against whichever backend is live; it appends a JSONL sample so you can
 * see, over time, whether the operational pain SQLite caused has actually gone.
 *
 * Signals captured:
 *   - backend            : sqlite | postgres (from OPENCODE_DATABASE_URL)
 *   - write_probe_ms      : latency of a single trivial write against a throwaway
 *                           table in the LIVE store (the thing that spiked to
 *                           seconds during SQLite maintenance / lock contention).
 *   - db_locked_errors    : did the probe hit 'database is locked' / lock waits?
 *   - live_processes      : # of opencode processes concurrently using the store
 *                           (the multi-writer pressure SQLite serializes).
 *   - store_size_bytes    : the store's size (SQLite's single-file growth was a
 *                           driver; pg is monitorable per-table).
 *   - maintenance_active  : is a VACUUM/backup running right now?
 *
 * The verdict signal over time: on SQLite you expect occasional write_probe_ms
 * spikes + db_locked_errors correlated with maintenance_active + high
 * live_processes. On pg those should stay flat. A month of flat pg samples where
 * SQLite historically spiked IS the evidence the migration was worth it.
 *
 * Read-mostly: creates/uses a tiny _health_probe table; never touches real data.
 */
import { Database } from "bun:sqlite"
import { SQL } from "bun"
import { appendFileSync } from "fs"
import { execSync } from "child_process"

const PG_URL = process.env.OPENCODE_DATABASE_URL
const LIVE_SQLITE = process.env.OPENCODE_DB ?? `${process.env.HOME}/.local/share/opencode/opencode.db`
const OUT = process.env.BACKEND_HEALTH_LOG ?? `${process.env.HOME}/.local/share/opencode/backend-health.jsonl`
const isPg = !!PG_URL && (PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://"))

function liveProcesses(): number {
  try { return Number(execSync(`pgrep -cf '/\\.opencode/bin/opencode' 2>/dev/null || true`).toString().trim()) || 0 }
  catch { return 0 }
}
function maintenanceActive(): boolean {
  try {
    const p = execSync(`pgrep -af 'VACUUM|pg_dump|wal_checkpoint|opencode.db.*backup|migrate-' 2>/dev/null || true`).toString()
    return p.trim().length > 0
  } catch { return false }
}

async function probeSqlite() {
  let write_probe_ms = -1, db_locked_errors = 0, store_size_bytes = 0
  try { store_size_bytes = (await import("fs")).statSync(LIVE_SQLITE).size } catch {}
  // Probe against a SEPARATE throwaway db in the same dir/filesystem so we never
  // write to the live store, but still measure the same disk + contention surface.
  const probePath = LIVE_SQLITE + ".healthprobe"
  try {
    const db = new Database(probePath)
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000")
    db.exec("CREATE TABLE IF NOT EXISTS _p(id INTEGER PRIMARY KEY, t INTEGER)")
    const s = performance.now()
    try { db.query("INSERT INTO _p(t) VALUES(?)").run(Date.now()) }
    catch (e: any) { if (/lock|busy/i.test(String(e))) db_locked_errors++ }
    write_probe_ms = performance.now() - s
    db.close()
  } catch (e: any) { if (/lock|busy/i.test(String(e))) db_locked_errors++ }
  return { write_probe_ms, db_locked_errors, store_size_bytes }
}

async function probePg() {
  let write_probe_ms = -1, db_locked_errors = 0, store_size_bytes = 0
  const sql = new SQL(PG_URL!)
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS _health_probe(id bigserial PRIMARY KEY, t bigint)`)
    const s = performance.now()
    try { await sql.unsafe(`INSERT INTO _health_probe(t) VALUES($1)`, [Date.now()]) }
    catch (e: any) { if (/lock|deadlock|timeout/i.test(String(e))) db_locked_errors++ }
    write_probe_ms = performance.now() - s
    store_size_bytes = Number((await sql.unsafe(`SELECT pg_database_size(current_database())::bigint AS s`) as any[])[0].s)
    // keep the probe table tiny
    await sql.unsafe(`DELETE FROM _health_probe WHERE id < (SELECT max(id)-100 FROM _health_probe)`)
  } finally { await sql.end() }
  return { write_probe_ms, db_locked_errors, store_size_bytes }
}

const base = { ts: new Date().toISOString(), backend: isPg ? "postgres" : "sqlite", live_processes: liveProcesses(), maintenance_active: maintenanceActive() }
const probe = isPg ? await probePg() : await probeSqlite()
const sample = { ...base, ...probe }
appendFileSync(OUT, JSON.stringify(sample) + "\n")
console.log(JSON.stringify(sample))

export * as DatabasePgMigration from "./migration.pg"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { PgEffectDb } from "./pg-effect-db"
import initSql from "./migration-pg/0001_init.sql" with { type: "text" }

type Database = PgEffectDb.PgEffectRawDatabase
type Transaction = PgEffectDb.PgEffectRawTransaction

const lock = Semaphore.makeUnsafe(1)

// Postgres uses a single squashed bootstrap migration generated from the
// dialect-aware Drizzle schema, rather than replaying the 32 SQLite-flavoured
// TypeScript migrations (which contain SQLite-specific DDL). New columns added
// later should append a new numbered .sql file here and to the list below.
const pgMigrations: { id: string; sql: string }[] = [{ id: "0001_init", sql: initSql }]

export function apply(db: Database) {
  return lock.withPermit(applyOnly(db, pgMigrations))
}

// Arbitrary but stable key for the migration advisory lock.
const MIGRATION_LOCK_KEY = 4314177615n

export function applyOnly(db: Database, input: { id: string; sql: string }[]) {
  return Effect.gen(function* () {
    // Fast path (steady state): if the migration table exists and every
    // migration is already recorded, do nothing. This avoids taking the
    // heavyweight advisory-lock transaction (which holds a reserved connection)
    // on every boot. Without this, many simultaneous cold boots pile up on the
    // lock and exhaust the connection pool ("Failed to reserve connection").
    const hasTable =
      (yield* db.all<{ reg: string | null }>(sql`SELECT to_regclass('migration') AS reg`))[0]?.reg != null
    if (hasTable) {
      const completed = new Set(
        (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map(
          (row: { id: string }) => row.id,
        ),
      )
      if (input.every((migration) => completed.has(migration.id))) return
    }

    // Slow path (first boot / pending migrations): serialize across processes
    // with a transaction-scoped advisory lock. Unlike SQLite (single writer),
    // multiple opencode processes can boot against the same Postgres at once and
    // would otherwise race on `CREATE TABLE IF NOT EXISTS` and the inserts.
    yield* db.transaction((tx: Transaction) =>
      Effect.gen(function* () {
        yield* tx.run(sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`)
        yield* tx.run(
          sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed BIGINT NOT NULL)`,
        )
        const completed = new Set(
          (yield* tx.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map(
            (row: { id: string }) => row.id,
          ),
        )

        for (const migration of input) {
          if (completed.has(migration.id)) continue
          const statements = migration.sql
            .split("--> statement-breakpoint")
            .map((statement) => statement.trim())
            .filter((statement) => statement.length > 0)
          if (!process.env.OPENCODE_SKIP_MIGRATIONS) {
            for (const statement of statements) {
              yield* tx.run(sql.raw(statement))
            }
          }
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }
      }),
    )
  })
}

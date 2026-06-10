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

export function applyOnly(db: Database, input: { id: string; sql: string }[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed BIGINT NOT NULL)`,
    )
    const completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map(
        (row: { id: string }) => row.id,
      ),
    )

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      const statements = migration.sql
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
      yield* db.transaction((tx: Transaction) =>
        Effect.gen(function* () {
          if (!process.env.OPENCODE_SKIP_MIGRATIONS) {
            for (const statement of statements) {
              yield* tx.run(sql.raw(statement))
            }
          }
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}

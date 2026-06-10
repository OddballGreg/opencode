/**
 * Dialect-aware Drizzle schema builders.
 *
 * The table/column definitions across `packages/core/src/**\/*.sql.ts` are written
 * once but need to materialize as either SQLite or Postgres tables depending on
 * `OPENCODE_DATABASE_URL`. This module is the single place where that decision is
 * made: it re-exports a unified set of builders that each schema file imports
 * instead of `drizzle-orm/sqlite-core`.
 *
 * Dialect is decided once at module load. The unified builders are statically
 * typed against the SQLite core's return types so that the downstream chains
 * (`.$type<>()`, `.notNull()`, `.references()`, ...) typecheck exactly as they
 * did before; the Postgres branch is cast to those same types. This keeps the
 * `as` casts localized here rather than leaking into the schema files.
 */
import * as Sqlite from "drizzle-orm/sqlite-core"
import * as Pg from "drizzle-orm/pg-core"
import { Flag } from "../flag/flag"

export type Dialect = "sqlite" | "pg"

function detectDialect(): Dialect {
  const url = Flag.OPENCODE_DATABASE_URL
  if (url && (url.startsWith("postgres://") || url.startsWith("postgresql://"))) return "pg"
  return "sqlite"
}

export const dialect: Dialect = detectDialect()
const isPg = dialect === "pg"

/**
 * Table builder: `sqliteTable` or `pgTable`. Same call shape
 * `table(name, columns, extra?)`. Typed as the SQLite builder; the pg builder is
 * cast to it so callers see one consistent signature.
 */
export const table: typeof Sqlite.sqliteTable = isPg
  ? (Pg.pgTable as unknown as typeof Sqlite.sqliteTable)
  : Sqlite.sqliteTable

/**
 * Plain string column. `text()` in both cores.
 */
export const text: typeof Sqlite.text = isPg ? (Pg.text as unknown as typeof Sqlite.text) : Sqlite.text

/**
 * JSON column. SQLite stores it as `text({ mode: "json" })`; Postgres uses a
 * native `jsonb` column. The generic is preserved so callers can write
 * `json<MyType>()` and keep the `.$type<>()`-style inference.
 *
 * Typed against the SQLite `text({mode:"json"})` overload so the returned builder
 * exposes the same chainable API (`.$type`, `.notNull`, `.default`, ...).
 */
type JsonBuilder = ReturnType<typeof sqliteJson>
const sqliteJson = () => Sqlite.text({ mode: "json" })
export function json<_T = unknown>(): JsonBuilder {
  if (isPg) return Pg.jsonb() as unknown as JsonBuilder
  return Sqlite.text({ mode: "json" }) as unknown as JsonBuilder
}

/**
 * Integer column used for millisecond timestamps and counters.
 *
 * CRITICAL: in SQLite this is `integer()`. In Postgres a plain `integer` is
 * int4 and `Date.now()` / cumulative token counters overflow it, so we map to
 * `bigint({ mode: "number" })` which still returns a JS `number` (not bigint)
 * on read, matching the SQLite behavior the rest of the code expects.
 */
type IntBuilder = ReturnType<typeof Sqlite.integer>
export function integer(): IntBuilder {
  if (isPg) return Pg.bigint({ mode: "number" }) as unknown as IntBuilder
  return Sqlite.integer()
}

/**
 * Boolean column. SQLite has no native boolean, so it is `integer({mode:"boolean"})`;
 * Postgres uses a native `boolean`.
 */
type BoolBuilder = ReturnType<typeof sqliteBool>
const sqliteBool = () => Sqlite.integer({ mode: "boolean" })
export function bool(): BoolBuilder {
  if (isPg) return Pg.boolean() as unknown as BoolBuilder
  return Sqlite.integer({ mode: "boolean" })
}

/**
 * Floating point column. `real()` in SQLite, `double precision` in Postgres.
 */
type DoubleBuilder = ReturnType<typeof Sqlite.real>
export function double(): DoubleBuilder {
  if (isPg) return Pg.doublePrecision() as unknown as DoubleBuilder
  return Sqlite.real()
}

/**
 * Custom column wrapper. The existing custom column definitions return
 * `dataType() => "text"`, which is valid in both cores, so the only difference is
 * which core's `customType` factory is used. Typed against the SQLite factory.
 */
export const customColumn: typeof Sqlite.customType = isPg
  ? (Pg.customType as unknown as typeof Sqlite.customType)
  : Sqlite.customType

/**
 * Index / constraint builders. Identical API in both cores; typed against SQLite.
 */
export const index: typeof Sqlite.index = isPg
  ? (Pg.index as unknown as typeof Sqlite.index)
  : Sqlite.index
export const uniqueIndex: typeof Sqlite.uniqueIndex = isPg
  ? (Pg.uniqueIndex as unknown as typeof Sqlite.uniqueIndex)
  : Sqlite.uniqueIndex
export const primaryKey: typeof Sqlite.primaryKey = isPg
  ? (Pg.primaryKey as unknown as typeof Sqlite.primaryKey)
  : Sqlite.primaryKey

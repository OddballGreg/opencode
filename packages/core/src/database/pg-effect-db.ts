export * as PgEffectDb from "./pg-effect-db"

/**
 * Thin wrapper that gives opencode's stock Postgres Effect-Drizzle database the
 * same raw query surface (`run` / `all` / `get` / `values`) as the vendored
 * SQLite database (`@opencode-ai/effect-drizzle-sqlite`).
 *
 * The stock `drizzle-orm/effect-postgres` database (`PgEffectDatabase`) only
 * exposes `.execute<TRow>(query): PgEffectRaw<TRow[]>` for raw SQL plus the
 * query builder (`select`/`insert`/`update`/`delete`) and `.transaction`. The
 * rest of opencode (and `migration.pg.ts`) instead calls the SQLite-flavoured
 * `.run` / `.all` / `.get` / `.values` methods. Each of those is implemented
 * here on top of `.execute`, which returns the row array directly (a
 * `PgEffectRaw` is itself a yieldable `Effect`).
 *
 * `.transaction` is wrapped too so the transaction object handed to callers is
 * itself wrapped (its `tx.run(...)` works inside `migration.pg.ts`).
 *
 * The return type mirrors the SQLite database method signatures so the result
 * is assignable where downstream code expects the SQLite database shape. The
 * `as` casts are localized here, exactly like `schema-dialect.ts`.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
// IMPORTANT: import only sql-pg-free submodules. `drizzle-orm/effect-postgres`
// (the package entry / `driver.js`) statically imports `@effect/sql-pg/PgClient`,
// which is NOT installed and crashes module load even in SQLite mode. The
// submodules below avoid that import, letting us construct the database from
// opencode's own effect `SqlClient` (`pg.bun.ts`).
import { PgDialect } from "drizzle-orm/pg-core"
import { PgEffectDatabase } from "drizzle-orm/pg-core/effect"
import { EffectPgSession } from "drizzle-orm/effect-postgres/session"
import { effectPgCodecs } from "drizzle-orm/effect-postgres/codecs"
import { EffectCache } from "drizzle-orm/cache/core/cache-effect"
import { EffectLogger } from "drizzle-orm/effect-core"
// Type-only: the stock concrete db type, used purely to mirror its method
// signatures in the wrapper interface. Type imports never load `driver.js`.
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres"

type RawQuery = SQL | SQLWrapper | string

/**
 * Construct a Postgres Effect-Drizzle database from opencode's own effect
 * `SqlClient`, replicating `drizzle-orm/effect-postgres`'s `make` (driver.js)
 * WITHOUT importing it (it pulls the missing `@effect/sql-pg`). The drizzle pg
 * session only ever uses the client as `client.unsafe(sql, params)` (-> a
 * yieldable `Statement` with `.values`/`.withoutTransform`) and
 * `client.withTransaction(...)`; effect's `SqlClient` satisfies that contract
 * at runtime.
 */
export const makeDatabase = Effect.gen(function* () {
  const client = yield* SqlClient.SqlClient
  const cache = yield* EffectCache.make
  const logger = yield* EffectLogger.make
  const dialect = new PgDialect({ codecs: effectPgCodecs } as any)
  const relations = {} as any
  const session = new EffectPgSession(client as any, dialect, relations, { logger, cache } as any)
  const db = new PgEffectDatabase(dialect, session as any, relations) as unknown as EffectPgDatabase
  ;(db as any).$client = client
  ;(db as any).$cache = cache
  if ((db as any).$cache) (db as any).$cache.invalidate = (cache as any).onMutate
  return db
})

function toSql(query: RawQuery): SQL {
  return typeof query === "string" ? sql.raw(query) : query.getSQL()
}

// The error/context channels of every pg raw query, derived from the stock pg
// db's own `.execute`. Crucially the context (`R`) channel must NOT be `any`:
// the migration layer `yield*`s these effects, and an `any` in `R` would leak
// out as the layer's requirement (defeating `LayerNode.make`'s dependency
// check). `PgEffectRaw` resolves to `Effect<T[], EffectDrizzleQueryError, never>`.
type PgExecuteEffect = ReturnType<EffectPgDatabase["execute"]>
type PgError = [PgExecuteEffect] extends [Effect.Effect<any, infer E, any>] ? E : never
type PgContext = [PgExecuteEffect] extends [Effect.Effect<any, any, infer R>] ? R : never
type PgEffect<A> = Effect.Effect<A, PgError, PgContext>

export interface PgEffectRawSurface {
  run(query: RawQuery): PgEffect<unknown>
  all<T = unknown>(query: RawQuery): PgEffect<T[]>
  get<T = unknown>(query: RawQuery): PgEffect<T | undefined>
  values<T extends unknown[] = unknown[]>(query: RawQuery): PgEffect<T[]>
}

// The transaction object handed to a `transaction(tx => ...)` callback is the
// underlying pg transaction (a `PgEffectDatabase`) re-wrapped with the raw
// surface, so it exposes both the query builder and `run`/`all`/`get`/`values`.
export interface PgEffectRawTransaction extends PgEffectRawSurface {
  select: EffectPgDatabase["select"]
  selectDistinct: EffectPgDatabase["selectDistinct"]
  insert: EffectPgDatabase["insert"]
  update: EffectPgDatabase["update"]
  delete: EffectPgDatabase["delete"]
  execute: EffectPgDatabase["execute"]
}

export interface PgEffectRawDatabase extends PgEffectRawSurface {
  transaction<A, E, R>(
    fn: (tx: PgEffectRawTransaction) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | import("effect/unstable/sql/SqlError").SqlError, R>
  select: EffectPgDatabase["select"]
  selectDistinct: EffectPgDatabase["selectDistinct"]
  insert: EffectPgDatabase["insert"]
  update: EffectPgDatabase["update"]
  delete: EffectPgDatabase["delete"]
  execute: EffectPgDatabase["execute"]
  query: EffectPgDatabase["query"]
  $with: EffectPgDatabase["$with"]
  with: EffectPgDatabase["with"]
  $count: EffectPgDatabase["$count"]
}

function makeRaw(db: { execute: (q: any) => any }) {
  return {
    run(query: RawQuery): PgEffect<unknown> {
      // DDL/insert callers ignore the result; return the executed rows as-is.
      return db.execute(toSql(query)) as PgEffect<unknown>
    },
    all<T = unknown>(query: RawQuery): PgEffect<T[]> {
      return db.execute(toSql(query)) as unknown as PgEffect<T[]>
    },
    get<T = unknown>(query: RawQuery): PgEffect<T | undefined> {
      const exec = db.execute(toSql(query)) as unknown as Effect.Effect<unknown[], PgError, PgContext>
      // Map the row array to its first element to mirror SQLite `.get`.
      return Effect.map(exec, (rows) => (rows.length > 0 ? (rows[0] as T) : undefined))
    },
    values<T extends unknown[] = unknown[]>(query: RawQuery): PgEffect<T[]> {
      const exec = db.execute(toSql(query)) as unknown as Effect.Effect<Array<Record<string, unknown>>, PgError, PgContext>
      // The pg db returns object rows; project each to a value array so callers
      // that asked for raw value rows still get arrays. (`db.values` is unused
      // by the app today; this exists purely for surface parity.)
      return Effect.map(exec, (rows) => rows.map((row) => Object.values(row) as T))
    },
  }
}

/**
 * Wrap a stock pg Effect-Drizzle database, adding the SQLite-style raw query
 * surface. The query-builder methods and `transaction`/`query` are forwarded
 * to the underlying db. `transaction` re-wraps the transaction object so nested
 * `tx.run/all/get/values` work too.
 */
export function wrap(db: EffectPgDatabase): PgEffectRawDatabase {
  const raw = makeRaw(db)

  const transaction: PgEffectRawDatabase["transaction"] = ((fn: any, ...rest: any[]) =>
    (db.transaction as any)((tx: any) => fn(wrapTransaction(tx)), ...rest)) as PgEffectRawDatabase["transaction"]

  return {
    ...raw,
    transaction,
    select: ((...args: any[]) => wrapBuilder((db.select as any)(...args))) as EffectPgDatabase["select"],
    selectDistinct: ((...args: any[]) =>
      wrapBuilder((db.selectDistinct as any)(...args))) as EffectPgDatabase["selectDistinct"],
    insert: ((...args: any[]) => wrapBuilder((db.insert as any)(...args))) as EffectPgDatabase["insert"],
    update: ((...args: any[]) => wrapBuilder((db.update as any)(...args))) as EffectPgDatabase["update"],
    delete: ((...args: any[]) => wrapBuilder((db.delete as any)(...args))) as EffectPgDatabase["delete"],
    execute: ((...args: any[]) => (db.execute as any)(...args)) as EffectPgDatabase["execute"],
    query: db.query,
    $with: db.$with,
    with: ((...args: any[]) => (db.with as any)(...args)) as EffectPgDatabase["with"],
    $count: ((...args: any[]) => (db.$count as any)(...args)) as EffectPgDatabase["$count"],
  }
}

// Query-builder methods that return another builder, so their result must stay
// wrapped to keep the SQLite-style `.all`/`.get`/`.values`/`.run` terminals
// available across the whole chain (select + insert/update/delete + returning).
const BUILDER_CHAINABLE = new Set([
  // select
  "from",
  "where",
  "having",
  "groupBy",
  "orderBy",
  "limit",
  "offset",
  "for",
  "$dynamic",
  "leftJoin",
  "rightJoin",
  "innerJoin",
  "fullJoin",
  "union",
  "unionAll",
  "intersect",
  "except",
  // insert / update / delete
  "values",
  "set",
  "onConflictDoNothing",
  "onConflictDoUpdate",
  "returning",
])

const BUILDER_TERMINALS = new Set(["all", "get", "values", "run"])

/**
 * The vendored SQLite query builders are terminated with `.all()` / `.get()` /
 * `.values()` / `.run()`; the stock pg builders are instead yieldable `Effect`s
 * that resolve to the row array. This proxy adds the SQLite-style terminals to
 * a pg builder (and re-wraps chainable methods so they survive the entire
 * `.from().where()...` / `.values().onConflict...().returning()` chain).
 *
 * Note `values` is BOTH a chainable insert method (`insert(t).values({...})`)
 * and a SQLite terminal. It is treated as a terminal only when called with no
 * arguments (the SQLite `.values()` terminal takes none); the chainable insert
 * `.values(rows)` always passes an argument.
 */
function wrapBuilder(builder: any): any {
  const asEffect = builder as Effect.Effect<any[], PgError, PgContext>
  const all = () => asEffect
  const get = () => Effect.map(asEffect, (rows) => (rows.length > 0 ? rows[0] : undefined))
  const valuesTerminal = () =>
    Effect.map(asEffect as unknown as Effect.Effect<Array<Record<string, unknown>>, PgError, PgContext>, (rows) =>
      rows.map((row) => Object.values(row)),
    )
  const run = () => asEffect

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "all") return all
      if (prop === "get") return get
      if (prop === "run") return run
      if (prop === "values") {
        const insertValues = Reflect.get(target, "values", receiver)
        // Chainable insert `.values(rows)` when an arg is given; SQLite terminal
        // `.values()` otherwise. Insert builders own a `values` method; result
        // builders (post-returning/select) do not, so fall back to terminal.
        return (...args: any[]) => {
          if (args.length > 0 && typeof insertValues === "function") {
            const next = insertValues.apply(target, args)
            return next === target ? receiver : wrapBuilder(next)
          }
          return valuesTerminal()
        }
      }
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === "function" && typeof prop === "string" && BUILDER_CHAINABLE.has(prop)) {
        return (...args: any[]) => {
          const next = value.apply(target, args)
          return next === target ? receiver : wrapBuilder(next)
        }
      }
      if (typeof value === "function") return value.bind(target)
      return value
    },
  })
}

function wrapTransaction(tx: { execute: (q: any) => any } & Record<string, any>) {
  const raw = makeRaw(tx)
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (BUILDER_TERMINALS.has(prop as string)) {
        return (raw as any)[prop]
      }
      if (prop === "select" || prop === "selectDistinct" || prop === "insert" || prop === "update" || prop === "delete") {
        const fn = Reflect.get(target, prop, receiver)
        return (...args: any[]) => wrapBuilder(fn.apply(target, args))
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

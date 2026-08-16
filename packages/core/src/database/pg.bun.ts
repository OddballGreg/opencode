import { SQL } from "bun"
import type { ReservedSQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Pg } from "./pg"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@opencode-ai/core/database/PgBun" as const
type TypeId = typeof TypeId

interface PgClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly json: (_: unknown) => Statement.Fragment
}

interface Config {
  readonly url: string
  readonly maxConnections?: number
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

const classifyPgError = (cause: unknown, message: string) =>
  new SqlError({ reason: new UnknownError({ cause, message, operation: "execute" }) })

/**
 * Build a diagnostic error message for a failed `db.unsafe(query, params)`.
 *
 * Without this, a failed statement surfaces as drizzle's generic
 * `EffectDrizzleQueryError`, whose formatter renders the params array via
 * template interpolation (`params: ${this.params}`) — i.e. `Array.toString()`,
 * so every object param prints as the useless `[object Object]` and the real
 * Postgres cause is buried. That makes transient contention failures (pool
 * reserve timeout, serialization/deadlock on an `onConflictDoUpdate`) look like
 * a jsonb-encoding bug when they are not.
 *
 * We capture: the SQL text, a JSON-serialized, size-bounded preview of the
 * params (objects become real JSON, not `[object Object]`), and the underlying
 * driver/Postgres error message so the true cause is visible in logs.
 */
const MAX_PARAM_PREVIEW = 200
const formatParamsPreview = (params: ReadonlyArray<unknown>): string => {
  try {
    return JSON.stringify(
      params.map((p) => {
        if (p === null || p === undefined) return p
        if (typeof p === "bigint") return p.toString()
        if (typeof p === "string") return p.length > MAX_PARAM_PREVIEW ? p.slice(0, MAX_PARAM_PREVIEW) + "…" : p
        if (typeof p === "object") {
          const json = (() => {
            try {
              return JSON.stringify(p)
            } catch {
              return String(p)
            }
          })()
          return json.length > MAX_PARAM_PREVIEW ? json.slice(0, MAX_PARAM_PREVIEW) + "…" : json
        }
        return p
      }),
    )
  } catch {
    return "<unserializable params>"
  }
}
const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`
  if (cause && typeof cause === "object") {
    try {
      return JSON.stringify(cause)
    } catch {
      return String(cause)
    }
  }
  return String(cause)
}
const executeErrorMessage = (query: string, params: ReadonlyArray<unknown>, cause: unknown): string =>
  `Failed to execute statement: ${describeCause(cause)}\nquery: ${query}\nparams: ${formatParamsPreview(params)}`

const escapePg = Statement.defaultEscape('"')

const makeCompiler = (transform?: (str: string) => string): Statement.Compiler =>
  Statement.makeCompiler({
    dialect: "pg",
    placeholder(index) {
      return `$${index}`
    },
    onIdentifier: transform
      ? (value, withoutTransform) => (withoutTransform ? escapePg(value) : escapePg(transform(value)))
      : escapePg,
    onRecordUpdate(placeholders, valueAlias, valueColumns, _values, returning) {
      return [
        returning
          ? `(values ${placeholders}) AS ${valueAlias}${valueColumns}${returning[0] ? ` RETURNING ${returning[0]}` : ""}`
          : `(values ${placeholders}) AS ${valueAlias}${valueColumns}`,
        returning ? returning[1] : [],
      ]
    },
    onCustom() {
      return ["", []]
    },
  })

interface PgConnection extends Connection {}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Pg.Native) as SQL

    const compiler = makeCompiler(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const runOn =
      (db: SQL) =>
      (query: string, params: ReadonlyArray<unknown> = []) =>
        Effect.tryPromise({
          try: () => db.unsafe(query, params as any[]) as unknown as Promise<Array<Record<string, unknown>>>,
          catch: (cause) => classifyPgError(cause, executeErrorMessage(query, params, cause)),
        }).pipe(Effect.map((rows) => (rows ?? []) as Array<Record<string, unknown>>))

    const runValuesOn =
      (db: SQL) =>
      (query: string, params: ReadonlyArray<unknown> = []) =>
        Effect.tryPromise({
          try: () => db.unsafe(query, params as any[]).values() as unknown as Promise<Array<unknown[]>>,
          catch: (cause) => classifyPgError(cause, executeErrorMessage(query, params, cause)),
        }).pipe(Effect.map((rows) => (rows ?? []) as Array<unknown[]>))

    const connectionFor = (db: SQL): PgConnection => {
      const run = runOn(db)
      const runValues = runValuesOn(db)
      return identity<PgConnection>({
        execute(query, params, transformRows) {
          return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
        },
        executeRaw(query, params) {
          return run(query, params)
        },
        executeValues(query, params) {
          return runValues(query, params)
        },
        executeUnprepared(query, params, transformRows) {
          return this.execute(query, params, transformRows)
        },
        executeStream() {
          return Stream.die("executeStream not implemented")
        },
      })
    }

    // Bun.sql manages its own connection pool, so the main acquirer does not
    // need the single-permit Semaphore that the sqlite driver uses.
    const acquirer = Effect.succeed(connectionFor(native))

    // A transaction must run all of its statements on a single dedicated
    // connection. Bun.sql exposes `.reserve()` to pull a connection out of the
    // pool; the reserved connection is released when the surrounding scope
    // closes (after COMMIT/ROLLBACK issued by the SqlClient transaction logic).
    const transactionAcquirer = Effect.acquireRelease(
      Effect.tryPromise({
        try: () => native.reserve(),
        catch: (cause) => classifyPgError(cause, "Failed to reserve connection"),
      }),
      (reserved) => Effect.sync(() => reserved.release()),
    ).pipe(Effect.map((reserved: ReservedSQL) => connectionFor(reserved as unknown as SQL)))

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "postgresql"],
        ],
        transformRows,
      })) as PgClient,
      {
        [TypeId]: TypeId,
        config: options,
        json: (_: unknown) => Statement.fragment([Statement.parameter(JSON.stringify(_))]),
      },
    )

    return client
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Pg.Native,
    Effect.gen(function* () {
      // Per-process pool size. Two competing constraints:
      //  - A single active session issues many concurrent DB ops during a turn
      //    (streaming parts + event-sourced writes + projector reads + a
      //    reserved transaction connection). Too small a pool starves it and
      //    breaks the instance mid-turn with "Failed to reserve connection".
      //  - opencode runs many processes against one Postgres, so the pool must
      //    not be so large that N processes exhaust server max_connections.
      // We use a moderate pool (8) and rely on a raised server max_connections
      // (500 on the dedicated local instance) for headroom (~60 processes).
      const native = new SQL({
        url: config.url,
        max: config.maxConnections ?? Number(process.env.OPENCODE_DB_POOL_MAX ?? 8),
        idleTimeout: 20,
        connectionTimeout: 30,
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => native.close()))
      return native
    }),
  )

const pgClientLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Pg.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Pg.Native) as SQL })
  }),
)

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(pgClientLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}

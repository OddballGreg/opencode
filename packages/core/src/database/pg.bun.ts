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
          catch: (cause) => classifyPgError(cause, "Failed to execute statement"),
        }).pipe(Effect.map((rows) => (rows ?? []) as Array<Record<string, unknown>>))

    const runValuesOn =
      (db: SQL) =>
      (query: string, params: ReadonlyArray<unknown> = []) =>
        Effect.tryPromise({
          try: () => db.unsafe(query, params as any[]).values() as unknown as Promise<Array<unknown[]>>,
          catch: (cause) => classifyPgError(cause, "Failed to execute statement"),
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
      // Cap the per-process pool. opencode runs many concurrent processes
      // against one Postgres; an unbounded/large pool per process can exhaust
      // server max_connections during a simultaneous-startup burst (surfaces as
      // a bare "Failed query" / "too many clients"). A small pool is plenty
      // since each session is effectively single-writer.
      const native = new SQL({
        url: config.url,
        max: config.maxConnections ?? 4,
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

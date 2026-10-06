import { describe, expect, test } from "bun:test"
import { SQL } from "bun"
import { Cause, Effect, Exit } from "effect"
import { isSqlError } from "effect/unstable/sql/SqlError"
import { PgRetry } from "@opencode-ai/core/database/pg-retry"

const pgError = (code: string, message: string, errno?: string) =>
  Object.assign(new Error(message), { name: "PostgresError", code, errno })

const idle = () => pgError("ERR_POSTGRES_IDLE_TIMEOUT", "Idle timeout reached after 20s")
const closed = () => pgError("ERR_POSTGRES_CONNECTION_CLOSED", "Connection closed")

describe("PgRetry.classify", () => {
  test("idle timeout is retryable even on COMMIT (Bun only fires it with no request in flight)", () => {
    expect(PgRetry.classify(idle(), "COMMIT")).toBe("connection")
    expect(PgRetry.classify(idle(), "insert into x values (1)")).toBe("connection")
  })

  test("a dead reserved handle never sent the statement", () => {
    const dead = new Error("connection must be a PostgresSQLConnection")
    expect(PgRetry.classify(dead, "COMMIT")).toBe("connection")
  })

  test("connection loss is retryable mid-transaction but ambiguous on COMMIT", () => {
    expect(PgRetry.classify(closed(), "select 1")).toBe("connection")
    expect(PgRetry.classify(closed(), "COMMIT")).toBe("commit-unknown")
    expect(PgRetry.classify(closed(), "  commit")).toBe("commit-unknown")
    expect(PgRetry.classify(pgError("ERR_POSTGRES_SERVER_ERROR", "terminating", "57P01"), "COMMIT")).toBe(
      "commit-unknown",
    )
  })

  test("serialization failure and deadlock are retryable", () => {
    expect(PgRetry.classify(pgError("ERR_POSTGRES_SERVER_ERROR", "could not serialize", "40001"), "COMMIT")).toBe(
      "serialization",
    )
    expect(PgRetry.classify(pgError("ERR_POSTGRES_SERVER_ERROR", "deadlock detected", "40P01"), "update")).toBe(
      "deadlock",
    )
  })

  test("data and constraint errors are fatal", () => {
    expect(PgRetry.classify(pgError("ERR_POSTGRES_SERVER_ERROR", "duplicate key", "23505"), "insert")).toBe("fatal")
    expect(PgRetry.classify(pgError("ERR_POSTGRES_SYNTAX_ERROR", "syntax error", "42601"), "selec")).toBe("fatal")
    expect(PgRetry.classify(new Error("boom"), "COMMIT")).toBe("fatal")
  })
})

describe("PgRetry.isRetryable / isCommitOutcomeUnknown", () => {
  test("finds retryable errors through defects and wrapper cause chains", () => {
    const err = PgRetry.toSqlError(idle(), "COMMIT", "Failed to execute statement")
    expect(isSqlError(err)).toBe(true)
    expect(PgRetry.isRetryable(Cause.fail(err))).toBe(true)
    expect(PgRetry.isRetryable(Cause.die(err))).toBe(true)
    const wrapped = Object.assign(new Error("EffectDrizzleQueryError"), { cause: err })
    expect(PgRetry.isRetryable(Cause.die(wrapped))).toBe(true)
  })

  test("event_sequence upsert on a dead reserved connection (production shape) is retryable", () => {
    const query = `insert into event_sequence (aggregate_id, seq) values ($1, -1)
                                    on conflict (aggregate_id) do update set seq = event_sequence.seq`
    const sqlError = PgRetry.toSqlError(new Error("connection must be a PostgresSQLConnection"), query, "m")
    const drizzle = Object.assign(new Error(`Failed query: ${query}\nparams: ses_x`), {
      name: "EffectDrizzleQueryError",
      cause: Cause.fail(sqlError),
    })
    expect(PgRetry.isRetryable(Cause.die(drizzle))).toBe(true)
    const rollback = PgRetry.toSqlError(new Error("connection must be a PostgresSQLConnection"), "ROLLBACK", "m")
    expect(PgRetry.isRetryable(Cause.die(rollback))).toBe(true)
  })

  test("fatal and ambiguous-commit errors are not retryable", () => {
    const fatal = PgRetry.toSqlError(pgError("X", "duplicate", "23505"), "insert", "m")
    expect(PgRetry.isRetryable(Cause.die(fatal))).toBe(false)
    const unknown = PgRetry.toSqlError(closed(), "COMMIT", "m")
    expect(PgRetry.isRetryable(Cause.die(unknown))).toBe(false)
    expect(PgRetry.isCommitOutcomeUnknown(Cause.die(unknown))).toBe(true)
    expect(PgRetry.isCommitOutcomeUnknown(Cause.die(fatal))).toBe(false)
  })
})

describe("PgRetry.retryTransaction", () => {
  const flaky = (failures: number, error: () => unknown, mode: "fail" | "die" = "die") => {
    let calls = 0
    const effect = Effect.suspend(() => {
      calls++
      if (calls <= failures) return mode === "die" ? Effect.die(error()) : Effect.fail(error())
      return Effect.succeed("ok")
    })
    return { effect, calls: () => calls }
  }
  const noDelay = { delayMs: () => 0 }

  test("replays a transaction that died on an idle-timed-out COMMIT", async () => {
    const tx = flaky(2, () => PgRetry.toSqlError(idle(), "COMMIT", "m"))
    const result = await Effect.runPromise(PgRetry.retryTransaction(tx.effect, noDelay))
    expect(result).toBe("ok")
    expect(tx.calls()).toBe(3)
  })

  test("replays typed failures too", async () => {
    const tx = flaky(1, () => PgRetry.toSqlError(pgError("S", "serialize", "40001"), "COMMIT", "m"), "fail")
    expect(await Effect.runPromise(PgRetry.retryTransaction(tx.effect, noDelay))).toBe("ok")
    expect(tx.calls()).toBe(2)
  })

  test("gives up after maxAttempts", async () => {
    const tx = flaky(10, () => PgRetry.toSqlError(idle(), "COMMIT", "m"))
    const exit = await Effect.runPromiseExit(PgRetry.retryTransaction(tx.effect, { ...noDelay, maxAttempts: 3 }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(tx.calls()).toBe(3)
  })

  test("does not replay fatal or ambiguous-commit failures", async () => {
    const fatal = flaky(1, () => PgRetry.toSqlError(pgError("X", "dup", "23505"), "insert", "m"))
    expect(Exit.isFailure(await Effect.runPromiseExit(PgRetry.retryTransaction(fatal.effect, noDelay)))).toBe(true)
    expect(fatal.calls()).toBe(1)
    const unknown = flaky(1, () => PgRetry.toSqlError(closed(), "COMMIT", "m"))
    const exit = await Effect.runPromiseExit(PgRetry.retryTransaction(unknown.effect, noDelay))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(unknown.calls()).toBe(1)
    if (Exit.isFailure(exit)) expect(PgRetry.isCommitOutcomeUnknown(exit.cause)).toBe(true)
  })

  test("nested transactions are not replayed on their own (the outer one is)", async () => {
    const inner = flaky(1, () => PgRetry.toSqlError(idle(), "select 1", "m"))
    let outerCalls = 0
    const outer = Effect.suspend(() => {
      outerCalls++
      return PgRetry.retryTransaction(inner.effect, noDelay)
    })
    expect(await Effect.runPromise(PgRetry.retryTransaction(outer, noDelay))).toBe("ok")
    expect(outerCalls).toBe(2)
    expect(inner.calls()).toBe(2)
  })
})

// Live Postgres: set OPENCODE_TEST_PG_URL to run. Reproduces the production
// failure — Bun's idleTimeout closes the reserved transaction connection, the
// COMMIT fails — and checks the transaction is replayed and committed once.
const PG_URL = process.env.OPENCODE_TEST_PG_URL
describe.skipIf(!PG_URL)("pg transaction recovery (live)", () => {
  test(
    "idle-timeout-killed transaction is replayed and committed exactly once",
    async () => {
      process.env.OPENCODE_DB_IDLE_TIMEOUT = "1"
      const { layer } = await import("@opencode-ai/core/database/pg.bun")
      const { PgEffectDb } = await import("@opencode-ai/core/database/pg-effect-db")
      const { sql } = await import("drizzle-orm")
      const table = `pg_retry_test_${process.pid}_${Date.now()}`
      const admin = new SQL({ url: PG_URL! })
      await admin.unsafe(`create table ${table} (id text primary key)`)
      try {
        let attempts = 0
        const program = Effect.gen(function* () {
          const db = PgEffectDb.wrap(yield* PgEffectDb.makeDatabase)
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              attempts++
              yield* tx.run(sql.raw(`insert into ${table} (id) values ('row')`))
              // First attempt only: go quiet past Bun's idle timeout.
              if (attempts === 1) yield* Effect.sleep("2500 millis")
            }),
          )
        }).pipe(Effect.provide(layer({ url: PG_URL! })), Effect.scoped)
        await Effect.runPromise(program as Effect.Effect<void>)
        expect(attempts).toBe(2)
        const rows = await admin.unsafe(`select id from ${table}`)
        expect(rows.length).toBe(1)
      } finally {
        await admin.unsafe(`drop table if exists ${table}`)
        await admin.close()
        delete process.env.OPENCODE_DB_IDLE_TIMEOUT
      }
    },
    { timeout: 30_000 },
  )
})

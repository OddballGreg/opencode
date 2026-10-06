export * as PgRetry from "./pg-retry"

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  ConnectionError,
  DeadlockError,
  SerializationError,
  SqlError,
  UnknownError,
  isSqlError,
} from "effect/unstable/sql/SqlError"

/**
 * Transient-failure handling for the Bun.SQL Postgres backend.
 *
 * Under heavy host contention a transaction's reserved connection can sit with
 * no traffic for longer than Bun's client-side `idleTimeout`. Bun then closes
 * it and fails the next statement — typically the `COMMIT` — with
 * `ERR_POSTGRES_IDLE_TIMEOUT`. The server sees the socket drop and rolls the
 * transaction back, so the whole transaction can safely be replayed on a fresh
 * connection. (Verified empirically against Bun 1.3.14: the row written before
 * the failed COMMIT is absent afterwards.)
 *
 * Classification of a driver failure for statement `query`:
 *
 *  - retryable: the statement provably never took effect — the connection was
 *    closed by Bun's idle timer (it only fires while no request is in flight),
 *    the reserved handle was already dead ("connection must be a
 *    PostgresSQLConnection"), connecting timed out, the pool could not reserve
 *    a connection, or Postgres aborted the transaction with a serialization
 *    failure (40001) / deadlock (40P01). Also any connection loss on a
 *    non-COMMIT statement: the open transaction dies with the socket.
 *  - commit outcome unknown: the connection dropped while COMMIT itself was in
 *    flight. Postgres may or may not have committed, so a blind replay could
 *    apply the transaction twice. Surfaced as `PgCommitOutcomeUnknown` for
 *    callers that can reconcile (see `event.ts`), never auto-retried here.
 *  - everything else (syntax, constraint, data errors): not retried.
 */

export class PgCommitOutcomeUnknown extends Error {
  override readonly name = "PgCommitOutcomeUnknown"
  constructor(override readonly cause: unknown) {
    super(`COMMIT outcome unknown: connection lost while COMMIT was in flight (${describe(cause)})`)
  }
}

const IDLE_CODES = new Set(["ERR_POSTGRES_IDLE_TIMEOUT", "ERR_POSTGRES_CONNECTION_TIMEOUT"])
const CONNECTION_LOST_CODES = new Set([
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
])
const NOT_SENT_MESSAGES = ["connection must be a PostgresSQLConnection"]
// 08xxx connection_exception, 57P01 admin_shutdown, 57P02 crash_shutdown,
// 57P03 cannot_connect_now: the server dropped/refused the session.
const CONNECTION_SQLSTATES = new Set(["08000", "08003", "08006", "08001", "08004", "57P01", "57P02", "57P03"])
const SERIALIZATION_SQLSTATE = "40001"
const DEADLOCK_SQLSTATE = "40P01"

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)

const field = (cause: unknown, key: string): string | undefined => {
  if (!cause || typeof cause !== "object") return undefined
  const value = (cause as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

const isCommit = (query: string) => /^\s*(commit|end)\b/i.test(query)

export type Kind = "connection" | "serialization" | "deadlock" | "commit-unknown" | "fatal"

/** Classify a raw Bun.SQL failure for the statement `query`. */
export const classify = (cause: unknown, query: string): Kind => {
  const code = field(cause, "code")
  const errno = field(cause, "errno")
  const message = field(cause, "message") ?? ""
  if (errno === SERIALIZATION_SQLSTATE) return "serialization"
  if (errno === DEADLOCK_SQLSTATE) return "deadlock"
  if (code && IDLE_CODES.has(code)) return "connection"
  if (NOT_SENT_MESSAGES.some((m) => message.includes(m))) return "connection"
  const lost =
    (code !== undefined && CONNECTION_LOST_CODES.has(code)) || (errno !== undefined && CONNECTION_SQLSTATES.has(errno))
  if (lost) return isCommit(query) ? "commit-unknown" : "connection"
  return "fatal"
}

/** Build the `SqlError` for a failed statement, with a reason reflecting `classify`. */
export const toSqlError = (cause: unknown, query: string, message: string, operation = "execute"): SqlError => {
  switch (classify(cause, query)) {
    case "connection":
      return new SqlError({ reason: new ConnectionError({ cause, message, operation }) })
    case "serialization":
      return new SqlError({ reason: new SerializationError({ cause, message, operation }) })
    case "deadlock":
      return new SqlError({ reason: new DeadlockError({ cause, message, operation }) })
    case "commit-unknown":
      return new SqlError({
        reason: new UnknownError({ cause: new PgCommitOutcomeUnknown(cause), message, operation }),
      })
    case "fatal":
      return new SqlError({ reason: new UnknownError({ cause, message, operation }) })
  }
}

/** Walk an error / Cause graph (fail + die reasons, `.cause` chains, wrappers). */
const visit = (root: unknown, test: (value: unknown) => boolean): boolean => {
  const seen = new Set<unknown>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    if (test(value)) return true
    if (Cause.isCause(value)) {
      for (const reason of value.reasons) {
        if (Cause.isFailReason(reason)) stack.push(reason.error)
        else if (Cause.isDieReason(reason)) stack.push(reason.defect)
      }
      continue
    }
    const record = value as Record<string, unknown>
    stack.push(record.cause, record.reason, record.error)
  }
  return false
}

/** True when the failure graph contains a retryable pg `SqlError`. */
export const isRetryable = (cause: unknown): boolean => visit(cause, (value) => isSqlError(value) && value.isRetryable)

/** True when the failure graph contains an ambiguous COMMIT. */
export const isCommitOutcomeUnknown = (cause: unknown): boolean =>
  visit(cause, (value) => value instanceof PgCommitOutcomeUnknown)

const InTransaction = Context.Reference<boolean>("@opencode-ai/core/database/PgRetry/InTransaction", {
  defaultValue: () => false,
})

export const MAX_ATTEMPTS = Number(process.env.OPENCODE_DB_TX_RETRIES ?? 5)
const BASE_DELAY_MS = 100
const MAX_DELAY_MS = 10_000

const delay = (attempt: number) => {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1))
  return Math.round(exp / 2 + Math.random() * (exp / 2))
}

/**
 * Run a top-level transaction, replaying it on a fresh connection when it
 * fails for a retryable reason. Handles both typed failures and defects,
 * because effect's `withTransaction` turns COMMIT/ROLLBACK errors into
 * defects (`Effect.orDie`) and opencode callers `orDie` their statements.
 *
 * Nested calls (already inside a retried transaction) run as-is: they share
 * the outer connection, so only the outermost transaction can be replayed.
 */
export const retryTransaction = <A, E, R>(
  transaction: Effect.Effect<A, E, R>,
  options?: { readonly maxAttempts?: number; readonly delayMs?: (attempt: number) => number },
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    if (yield* InTransaction) return yield* transaction
    const maxAttempts = Math.max(1, options?.maxAttempts ?? MAX_ATTEMPTS)
    const wait = options?.delayMs ?? delay
    let attempt = 1
    while (true) {
      const exit = yield* Effect.exit(Effect.provideService(transaction, InTransaction, true))
      if (Exit.isSuccess(exit)) return exit.value
      if (attempt >= maxAttempts || Cause.hasInterrupts(exit.cause) || !isRetryable(exit.cause)) {
        return yield* Effect.failCause(exit.cause)
      }
      const ms = wait(attempt)
      yield* Effect.logWarning("pg transaction failed transiently; retrying on a fresh connection").pipe(
        Effect.annotateLogs({ attempt, maxAttempts, delayMs: ms, error: Cause.pretty(exit.cause).split("\n")[0] }),
      )
      yield* Effect.sleep(`${ms} millis`)
      attempt++
    }
  })

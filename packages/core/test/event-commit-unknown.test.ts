import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { PgRetry } from "@opencode-ai/core/database/pg-retry"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventTable } from "@opencode-ai/core/event/sql"
import { testEffect } from "./lib/effect"

/**
 * The connection can drop while COMMIT is in flight; then nobody knows whether
 * the transaction landed. PgRetry deliberately does not replay that blindly,
 * so `commitDurableEvent` reconciles by event id. These tests simulate the
 * ambiguous outcome on top of the regular database.
 */
const SyncMessage = EventV2.define({
  type: "test.commit-unknown",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

type Mode = "committed" | "lost" | "always-lost"
let armed: Mode | undefined
let transactionCalls = 0

const ambiguousCommit = () =>
  Effect.die(
    PgRetry.toSqlError(
      Object.assign(new Error("Connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" }),
      "COMMIT",
      "Failed to execute statement: Connection closed\nquery: COMMIT",
    ),
  )

const flakyDatabase = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver)
        return (...args: any[]) => {
          const real = (target.transaction as any)(...args) as Effect.Effect<unknown, unknown>
          return Effect.suspend(() => {
            transactionCalls++
            const mode = armed
            if (mode !== "always-lost") armed = undefined
            if (mode === "committed") return real.pipe(Effect.andThen(ambiguousCommit()))
            if (mode === "lost" || mode === "always-lost") return ambiguousCommit()
            return real
          })
        }
      },
    })
    return { db: proxy }
  }),
).pipe(Layer.provide(LayerNode.compile(Database.node)))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [[Database.node, flakyDatabase]]),
)

const storedRows = (id: EventV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.select().from(EventTable).where(eq(EventTable.id, id)).all()
  })

describe("EventV2 ambiguous COMMIT reconciliation", () => {
  it.effect("treats an event found committed as success", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      let projected = 0
      yield* events.project(SyncMessage, () => Effect.sync(() => projected++))
      armed = "committed"
      transactionCalls = 0
      const event = yield* events.publish(SyncMessage, { id: aggregateID, text: "hello" })
      expect(event.durable?.seq).toBe(0)
      expect(transactionCalls).toBe(1)
      expect(projected).toBe(1)
      expect((yield* storedRows(event.id)).length).toBe(1)
    }),
  )

  it.effect("replays once when the event did not land", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      armed = "lost"
      transactionCalls = 0
      const event = yield* events.publish(SyncMessage, { id: aggregateID, text: "hello" })
      expect(event.durable?.seq).toBe(0)
      expect(transactionCalls).toBe(2)
      expect((yield* storedRows(event.id)).length).toBe(1)
    }),
  )

  it.effect("still fails if the replay is ambiguous too", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      armed = "always-lost"
      transactionCalls = 0
      const exit = yield* events.publish(SyncMessage, { id: EventV2.ID.create(), text: "hello" }).pipe(Effect.exit)
      armed = undefined
      expect(Exit.isFailure(exit)).toBe(true)
      expect(transactionCalls).toBe(2)
    }),
  )
})

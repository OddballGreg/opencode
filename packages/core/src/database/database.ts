export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { layer as pgClientLayer } from "./pg.bun"
import { PgEffectDb } from "./pg-effect-db"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { DatabasePgMigration } from "./migration.pg"
import { InstallationChannel } from "../installation/version"
import { LayerNode } from "../effect/layer-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

function isPostgres(url: string | undefined): url is string {
  return !!url && (url.startsWith("postgres://") || url.startsWith("postgresql://"))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

// Postgres backend. Activated when OPENCODE_DATABASE_URL is a postgres URL.
// The pg database is structurally compatible with the SQLite database for the
// query surface the app uses (select/insert/update/delete/run/all/get/
// transaction); we cast it to the SQLite-typed Interface so downstream code is
// unchanged. The dialect-aware schema (schema-dialect.ts) ensures the table
// definitions resolve to pg types at runtime.
export const pgLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Build the pg Effect-Drizzle database from opencode's own effect SqlClient
    // (provided by `pgClientLayer`), then wrap it with the SQLite-style raw
    // surface (`run`/`all`/`get`/`values`) so downstream code and the pg
    // migration runner work unchanged.
    const db = yield* PgEffectDb.makeDatabase
    const wrapped = PgEffectDb.wrap(db)
    yield* DatabasePgMigration.apply(wrapped)
    return { db: wrapped as unknown as DatabaseShape }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function layerFromUrl(url: string) {
  return pgLayer.pipe(Layer.provide(pgClientLayer({ url })))
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

function resolvedLayer() {
  if (isPostgres(Flag.OPENCODE_DATABASE_URL)) return layerFromUrl(Flag.OPENCODE_DATABASE_URL)
  return layerFromPath(path())
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return resolvedLayer()
  }),
).pipe(Layer.provide(Global.defaultLayer))

export const node = LayerNode.make(resolvedLayer(), [])

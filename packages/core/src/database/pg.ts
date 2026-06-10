export * as Pg from "./pg"

import { Context } from "effect"
import type { drizzle } from "drizzle-orm/bun-sql"

export type DrizzleClient = ReturnType<typeof drizzle>
export class Native extends Context.Service<Native, unknown>()("@opencode-ai/core/database/PgNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@opencode-ai/core/database/PgDrizzle") {}

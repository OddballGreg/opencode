import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { SessionTable } from "../src/session/sql"
import { fromRow } from "../src/session/info"
import { Global } from "../src/global"

const url = process.env.OPENCODE_DATABASE_URL
if (!url) { console.error("OPENCODE_DATABASE_URL not set"); process.exit(1) }

const program = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const raw = yield* db.select().from(SessionTable).where(eq(SessionTable.id, "ses_14de15f6fffelQ5Ezvh2yudNLW" as any)).get().pipe(Effect.orDie)
  if (!raw) { console.error("No session rows"); return }
  console.log("=== Raw decoded row ===")
  console.log("id:", raw.id)
  console.log("time_created:", raw.time_created, "| typeof:", typeof raw.time_created)
  console.log("tokens_input:", raw.tokens_input, "| typeof:", typeof raw.tokens_input)
  console.log("model:", raw.model, "| typeof:", typeof raw.model)
  console.log("metadata:", raw.metadata, "| typeof:", typeof raw.metadata)
  const assert = (c: boolean, m: string) => { if (!c) throw new Error("ASSERT FAIL: " + m); console.log("PASS:", m) }
  console.log("\n=== Assertions ===")
  assert(typeof raw.time_created === "number", "time_created is number")
  assert(typeof raw.tokens_input === "number", "tokens_input is number")
  assert(raw.model === null || (typeof raw.model === "object" && typeof (raw.model as any).id === "string"), "model is object with .id (or null)")
  console.log("\n=== fromRow() ===")
  const info = fromRow(raw)
  console.log(JSON.stringify(info, null, 2))
  console.log("\nfromRow() succeeded")
})

const layer = Database.layerFromUrl(url).pipe(Layer.provide(Global.defaultLayer))
Effect.runPromise(program.pipe(Effect.provide(layer))).then(
  () => { console.log("\nALL CHECKS PASSED"); process.exit(0) },
  (err) => { console.error("\nFAILED:", err); process.exit(1) },
)

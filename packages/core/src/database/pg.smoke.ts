import * as Effect from "effect/Effect"
import * as Client from "effect/unstable/sql/SqlClient"
import { layer as pgLayer } from "./pg.bun"

const URL = "postgres://opencode:opencode_dev_pw@127.0.0.1:55432/opencode"

const program = Effect.gen(function* () {
  const sql = yield* Client.SqlClient

  yield* sql`CREATE TABLE IF NOT EXISTS _smoke (id bigint primary key, v jsonb)`
  yield* sql`DELETE FROM _smoke`
  yield* sql`INSERT INTO _smoke ${sql.insert({ id: 1, v: JSON.stringify({ hello: "world" }) })}`

  const rows = yield* sql`SELECT id, v FROM _smoke WHERE id = ${1}`
  console.log(
    "round-tripped row:",
    JSON.stringify(rows, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2),
  )

  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO _smoke ${sql.insert({ id: 2, v: JSON.stringify({ tx: true }) })}`
        const inTx = yield* sql`SELECT count(*)::int AS n FROM _smoke`
        console.log("rows visible inside tx:", JSON.stringify(inTx))
      }),
    )
    .pipe(Effect.scoped)

  const after = yield* sql`SELECT count(*)::int AS n FROM _smoke`
  console.log("rows after committed tx:", JSON.stringify(after))

  yield* sql`DROP TABLE _smoke`
})

Effect.runPromise(program.pipe(Effect.provide(pgLayer({ url: URL })), Effect.scoped)).then(
  () => {
    console.log("smoke test PASSED")
    process.exit(0)
  },
  (err) => {
    console.error("smoke test FAILED:", err)
    process.exit(1)
  },
)

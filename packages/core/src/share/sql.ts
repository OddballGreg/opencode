import { table, text, primaryKey } from "../database/schema-dialect"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"

export const SessionShareTable = table("session_share", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  id: text().notNull(),
  secret: text().notNull(),
  url: text().notNull(),
  ...Timestamps,
})

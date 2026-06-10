import { table, text, integer, primaryKey } from "./database/schema-dialect"

export const DataMigrationTable = table("data_migration", {
  name: text().primaryKey(),
  time_completed: integer().notNull(),
})

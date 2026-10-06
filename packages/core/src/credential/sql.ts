import { bool, json, table, text } from "../database/schema-dialect"
import { Timestamps } from "../database/schema.sql"
import type { Credential } from "../credential"

export const CredentialTable = table("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Credential.Info["integrationID"]>(),
  label: text().notNull(),
  value: json<Credential.Value>().$type<Credential.Value>().notNull(),
  connector_id: text(),
  method_id: text(),
  active: bool(),
  ...Timestamps,
})

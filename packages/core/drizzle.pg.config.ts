import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
  out: "./src/database/migration-pg-gen",
})

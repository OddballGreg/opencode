CREATE TABLE IF NOT EXISTS "credential" (
	"id" text PRIMARY KEY,
	"integration_id" text,
	"label" text NOT NULL,
	"value" jsonb NOT NULL,
	"connector_id" text,
	"method_id" text,
	"active" boolean,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);

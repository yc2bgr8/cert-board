ALTER TABLE "run_event" ADD COLUMN "sandbox_input_hashes" varchar(64)[];--> statement-breakpoint
ALTER TABLE "run_event" ADD COLUMN "sandbox_output_hashes" varchar(64)[];--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_sandbox_hashes" CHECK (("run_event"."sandbox_input_hashes" IS NULL AND "run_event"."sandbox_output_hashes" IS NULL) OR (
        "run_event"."type" = 'tool_completed' AND "run_event"."invocation_id" IS NOT NULL AND
        "run_event"."content_hash" IS NOT NULL AND "run_event"."duration_ms" IS NOT NULL AND
        "run_event"."sandbox_input_hashes" IS NOT NULL AND "run_event"."sandbox_output_hashes" IS NOT NULL AND
        array_to_string("run_event"."sandbox_input_hashes", ',', '?') ~ '^([0-9a-f]{64}(,[0-9a-f]{64}){0,15})?$' AND
        array_to_string("run_event"."sandbox_output_hashes", ',', '?') ~ '^([0-9a-f]{64}(,[0-9a-f]{64}){0,31})?$'
      ));
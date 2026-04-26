ALTER TABLE "generated_questions" ADD COLUMN "question_id" text;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "description_id" text;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "resolution_criteria_id" text;--> statement-breakpoint
ALTER TABLE "polls" ADD COLUMN "title_id" text;--> statement-breakpoint
ALTER TABLE "polls" ADD COLUMN "description_id" text;--> statement-breakpoint
ALTER TABLE "polls" ADD COLUMN "options_id" text[];
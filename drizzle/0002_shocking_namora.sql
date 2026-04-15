CREATE TYPE "public"."market_type" AS ENUM('binary', 'categorical', 'scalar');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('draft', 'pending', 'active', 'resolved', 'closed');--> statement-breakpoint
ALTER TABLE "generated_questions" ALTER COLUMN "category" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "generated_questions" ALTER COLUMN "status" SET DEFAULT 'draft'::"public"."question_status";--> statement-breakpoint
ALTER TABLE "generated_questions" ALTER COLUMN "status" SET DATA TYPE "public"."question_status" USING "status"::"public"."question_status";--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "slug" varchar(300);--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "market_type" "market_type" DEFAULT 'binary' NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "outcomes" text[];--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "initial_liquidity" numeric;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "min_trade_size" numeric;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "volume" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "start_date" timestamp;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "resolution_source" text;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "resolution_criteria" text;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "resolved_outcome" text;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "created_by" integer;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD CONSTRAINT "generated_questions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_questions" ADD CONSTRAINT "generated_questions_slug_unique" UNIQUE("slug");
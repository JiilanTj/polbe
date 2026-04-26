ALTER TYPE "public"."lives_transaction_type" ADD VALUE 'contributor_purchase';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contributor_until" timestamp;
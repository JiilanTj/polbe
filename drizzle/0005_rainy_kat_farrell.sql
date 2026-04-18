ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "usdt_balance" numeric(10, 2) DEFAULT '0' NOT NULL;
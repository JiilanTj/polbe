ALTER TYPE "public"."lives_transaction_type" ADD VALUE 'withdrawal_debit';--> statement-breakpoint
ALTER TYPE "public"."lives_transaction_type" ADD VALUE 'withdrawal_refund';--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "lives_to_usdt_rate" numeric(10, 4) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "usdt_debited" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "lives_debited" numeric(18, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "lives_to_usdt_rate" numeric(10, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "withdrawal_source" varchar(20) DEFAULT 'usdt' NOT NULL;
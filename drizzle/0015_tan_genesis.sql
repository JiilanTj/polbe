ALTER TABLE "platform_settings" ADD COLUMN "topup_payment_methods" jsonb;--> statement-breakpoint
ALTER TABLE "topup_requests" ADD COLUMN "payment_network" varchar(50);--> statement-breakpoint
ALTER TABLE "topup_requests" ADD COLUMN "payment_address" text;
ALTER TABLE "lives_transactions" ALTER COLUMN "amount" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "lives_transactions" ALTER COLUMN "balance_after" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "poll_votes" ALTER COLUMN "lives_wagered" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "poll_votes" ALTER COLUMN "lives_wagered" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "lives_balance" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "lives_balance" SET DEFAULT '0';
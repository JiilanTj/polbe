ALTER TABLE "polls" ALTER COLUMN "prize_pool" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "polls" ALTER COLUMN "prize_pool" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "polls" ALTER COLUMN "total_volume" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "polls" ALTER COLUMN "total_volume" SET DEFAULT '0';
CREATE TABLE "master_referral_earnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"master_id" integer NOT NULL,
	"poll_id" integer NOT NULL,
	"eligible_referee_ids" integer[] NOT NULL,
	"losing_lives_pool" numeric(18, 6) NOT NULL,
	"commission_lives" numeric(18, 6) NOT NULL,
	"lives_to_usdt_rate" numeric(10, 4) NOT NULL,
	"usdt_earned" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_master" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "master_referral_earnings" ADD CONSTRAINT "master_referral_earnings_master_id_users_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_referral_earnings" ADD CONSTRAINT "master_referral_earnings_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "master_referral_master_poll" ON "master_referral_earnings" USING btree ("master_id","poll_id");
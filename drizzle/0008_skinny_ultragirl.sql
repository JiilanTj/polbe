CREATE TYPE "public"."notification_type" AS ENUM('order_filled', 'order_cancelled', 'poll_resolved', 'payout_credited', 'trade_executed', 'watchlist_update');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"ref_id" integer,
	"ref_type" varchar(50),
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_id" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_unread" ON "notifications" USING btree ("user_id","is_read");--> statement-breakpoint
CREATE INDEX "lives_tx_user_created_at" ON "lives_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_poll_option_status" ON "orders" USING btree ("poll_id","option_index","status");--> statement-breakpoint
CREATE INDEX "orders_user_id" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "price_snapshots_poll_option_time" ON "price_snapshots" USING btree ("poll_id","option_index","snapshot_at");--> statement-breakpoint
CREATE INDEX "trades_poll_created_at" ON "trades" USING btree ("poll_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_maker_user_id" ON "trades" USING btree ("maker_user_id");--> statement-breakpoint
CREATE INDEX "trades_taker_user_id" ON "trades" USING btree ("taker_user_id");
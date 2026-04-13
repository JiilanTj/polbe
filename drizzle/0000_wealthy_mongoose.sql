CREATE TABLE "articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"content" text,
	"url" text NOT NULL,
	"source" varchar(100) NOT NULL,
	"category" varchar(50),
	"published_at" timestamp,
	"scraped_at" timestamp DEFAULT now() NOT NULL,
	"sentiment" varchar(20),
	"sentiment_score" numeric,
	CONSTRAINT "articles_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "generated_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"description" text,
	"category" varchar(50),
	"source_article_ids" integer[],
	"resolution_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"ai_model" varchar(50),
	"confidence_score" numeric,
	"status" varchar(20) DEFAULT 'draft' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trends" (
	"id" serial PRIMARY KEY NOT NULL,
	"topic" varchar(200) NOT NULL,
	"mention_count" integer DEFAULT 1 NOT NULL,
	"category" varchar(50),
	"first_seen" timestamp DEFAULT now() NOT NULL,
	"last_seen" timestamp DEFAULT now() NOT NULL,
	"trend_score" numeric DEFAULT '0'
);

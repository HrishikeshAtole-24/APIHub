CREATE TABLE "api_auth_schemes" (
	"id" text PRIMARY KEY NOT NULL,
	"api_id" text NOT NULL,
	"type" text DEFAULT 'unknown' NOT NULL,
	"location" text DEFAULT 'none' NOT NULL,
	"parameter_name" text,
	"notes" text,
	"signup_url" text
);
--> statement-breakpoint
CREATE TABLE "api_category_map" (
	"api_id" text NOT NULL,
	"category_id" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "api_category_map_api_id_category_id_pk" PRIMARY KEY("api_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "api_embeddings" (
	"api_id" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_embeddings_api_id_model_pk" PRIMARY KEY("api_id","model")
);
--> statement-breakpoint
CREATE TABLE "api_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"api_id" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"path" text NOT NULL,
	"summary" text,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sample_response" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_probe_target" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"license" text,
	"transform_version" text DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apis" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"description" text DEFAULT '' NOT NULL,
	"long_description" text,
	"docs_url" text,
	"base_url" text,
	"auth_type" text DEFAULT 'unknown' NOT NULL,
	"https_supported" boolean DEFAULT false NOT NULL,
	"cors_status" text DEFAULT 'unknown' NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"has_free_tier" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"popularity_score" real DEFAULT 0 NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_limit" jsonb,
	"source_id" text,
	"source_record_id" text,
	"source_revision" text,
	"fingerprint" text NOT NULL,
	"imported_at" timestamp with time zone,
	"search_vector" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"api_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_health_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"api_id" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"error_code" text,
	"response_bytes" integer,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_health_daily" (
	"api_id" text NOT NULL,
	"day" date NOT NULL,
	"total_checks" integer DEFAULT 0 NOT NULL,
	"successful_checks" integer DEFAULT 0 NOT NULL,
	"uptime" real DEFAULT 0 NOT NULL,
	"avg_latency_ms" real,
	"p95_latency_ms" real,
	"incidents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_health_daily_api_id_day_pk" PRIMARY KEY("api_id","day")
);
--> statement-breakpoint
CREATE TABLE "api_health_latest" (
	"api_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"error_code" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"uptime_30d" real,
	"success_rate_7d" real,
	"reliability_score" real,
	"last_checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"check_priority" integer DEFAULT 100 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"api_id" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"checks_affected" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"collection_id" text NOT NULL,
	"api_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_items_collection_id_api_id_pk" PRIMARY KEY("collection_id","api_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" text NOT NULL,
	"api_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_api_id_pk" PRIMARY KEY("user_id","api_id")
);
--> statement-breakpoint
CREATE TABLE "review_votes" (
	"review_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_votes_review_id_user_id_pk" PRIMARY KEY("review_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"api_id" text NOT NULL,
	"rating_overall" smallint NOT NULL,
	"rating_reliability" smallint,
	"rating_documentation" smallint,
	"rating_developer_experience" smallint,
	"rating_free_tier" smallint,
	"title" text,
	"body" text,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"moderation_status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"role" text DEFAULT 'user' NOT NULL,
	"avatar_color" text DEFAULT 'hsl(220 65% 55%)' NOT NULL,
	"deactivated_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_views" (
	"day" date NOT NULL,
	"api_id" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"playground_runs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_views_day_api_id_pk" PRIMARY KEY("day","api_id")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_revision" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"records_fetched" integer DEFAULT 0 NOT NULL,
	"records_created" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"records_skipped" integer DEFAULT 0 NOT NULL,
	"records_failed" integer DEFAULT 0 NOT NULL,
	"duplicate_clusters" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "playground_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"api_id" text,
	"method" text NOT NULL,
	"target_host" text NOT NULL,
	"response_status" integer,
	"latency_ms" integer,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"day" date NOT NULL,
	"term" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"zero_result_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "search_queries_day_term_pk" PRIMARY KEY("day","term")
);
--> statement-breakpoint
ALTER TABLE "api_auth_schemes" ADD CONSTRAINT "api_auth_schemes_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_category_map" ADD CONSTRAINT "api_category_map_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_category_map" ADD CONSTRAINT "api_category_map_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_embeddings" ADD CONSTRAINT "api_embeddings_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_endpoints" ADD CONSTRAINT "api_endpoints_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apis" ADD CONSTRAINT "apis_source_id_api_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."api_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_health_checks" ADD CONSTRAINT "api_health_checks_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_health_daily" ADD CONSTRAINT "api_health_daily_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_health_latest" ADD CONSTRAINT "api_health_latest_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_views" ADD CONSTRAINT "api_views_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_source_id_api_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."api_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_runs" ADD CONSTRAINT "playground_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_runs" ADD CONSTRAINT "playground_runs_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_auth_schemes_api_idx" ON "api_auth_schemes" USING btree ("api_id");--> statement-breakpoint
CREATE INDEX "api_category_category_idx" ON "api_category_map" USING btree ("category_id","api_id");--> statement-breakpoint
CREATE INDEX "api_endpoints_api_idx" ON "api_endpoints" USING btree ("api_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "apis_slug_idx" ON "apis" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "apis_fingerprint_idx" ON "apis" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "apis_status_updated_idx" ON "apis" USING btree ("status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "apis_status_popularity_idx" ON "apis" USING btree ("status","popularity_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "apis_active_popularity_idx" ON "apis" USING btree ("popularity_score" DESC NULLS LAST) WHERE "apis"."status" = 'active';--> statement-breakpoint
CREATE INDEX "apis_auth_type_idx" ON "apis" USING btree ("auth_type");--> statement-breakpoint
CREATE INDEX "apis_free_idx" ON "apis" USING btree ("is_free");--> statement-breakpoint
CREATE INDEX "apis_search_vector_idx" ON "apis" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "apis_tags_idx" ON "apis" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "apis_source_idx" ON "apis" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_idx" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_name_idx" ON "categories" USING btree ("name");--> statement-breakpoint
CREATE INDEX "api_health_checks_api_time_idx" ON "api_health_checks" USING btree ("api_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_health_checks_time_idx" ON "api_health_checks" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "api_health_daily_day_idx" ON "api_health_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "api_health_latest_status_idx" ON "api_health_latest" USING btree ("status");--> statement-breakpoint
CREATE INDEX "api_health_latest_reliability_idx" ON "api_health_latest" USING btree ("reliability_score");--> statement-breakpoint
CREATE INDEX "api_health_latest_due_idx" ON "api_health_latest" USING btree ("next_check_at","check_priority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_api_time_idx" ON "incidents" USING btree ("api_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_unresolved_idx" ON "incidents" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "collection_items_order_idx" ON "collection_items" USING btree ("collection_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_user_slug_idx" ON "collections" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "collections_public_idx" ON "collections" USING btree ("is_public","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "favorites_user_time_idx" ON "favorites" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "favorites_api_idx" ON "favorites" USING btree ("api_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_user_api_idx" ON "reviews" USING btree ("user_id","api_id");--> statement-breakpoint
CREATE INDEX "reviews_api_time_idx" ON "reviews" USING btree ("api_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "api_views_day_idx" ON "api_views" USING btree ("day","views" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_views_api_idx" ON "api_views" USING btree ("api_id");--> statement-breakpoint
CREATE INDEX "audit_logs_time_idx" ON "audit_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "ingestion_runs_time_idx" ON "ingestion_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ingestion_runs_source_idx" ON "ingestion_runs" USING btree ("source_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playground_runs_time_idx" ON "playground_runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playground_runs_user_idx" ON "playground_runs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "search_queries_day_count_idx" ON "search_queries" USING btree ("day","count" DESC NULLS LAST);
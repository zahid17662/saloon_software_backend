ALTER TABLE "sales" ADD COLUMN "entered_by_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "price_snapshot_positive" CHECK ("sale_items"."price_snapshot" > 0);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "total_positive" CHECK ("sales"."total" > 0);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "shares_nonneg" CHECK ("sales"."barber_share" >= 0 and "sales"."owner_share" >= 0);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "pct_snapshot_range" CHECK ("sales"."commission_pct_snapshot" between 0 and 100);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "void_consistent" CHECK (("sales"."voided_at" is null) = ("sales"."voided_by" is null) and ("sales"."voided_at" is not null or "sales"."void_reason" is null));
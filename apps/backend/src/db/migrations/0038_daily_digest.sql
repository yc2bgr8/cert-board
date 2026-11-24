CREATE TABLE "daily_digest" (
	"user_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"content" jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "daily_digest_user_id_business_date_pk" PRIMARY KEY("user_id","business_date"),
	CONSTRAINT "daily_digest_workday" CHECK (EXTRACT(ISODOW FROM "daily_digest"."business_date") BETWEEN 1 AND 5),
	CONSTRAINT "daily_digest_publish_time" CHECK (("daily_digest"."generated_at" AT TIME ZONE 'Asia/Shanghai')::date="daily_digest"."business_date"
      AND ("daily_digest"."generated_at" AT TIME ZONE 'Asia/Shanghai')::time >= TIME '17:00'),
	CONSTRAINT "daily_digest_content_bounded" CHECK (jsonb_typeof("daily_digest"."content")='object' AND octet_length("daily_digest"."content"::text)<=65536)
);
--> statement-breakpoint
ALTER TABLE "daily_digest" ADD CONSTRAINT "daily_digest_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION public.reject_daily_digest_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '已发布的站内日摘要保留原记录。' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER daily_digest_immutable BEFORE UPDATE OR DELETE ON public.daily_digest
FOR EACH ROW EXECUTE FUNCTION public.reject_daily_digest_change();

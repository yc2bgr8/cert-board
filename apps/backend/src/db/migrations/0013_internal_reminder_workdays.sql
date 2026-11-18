-- 北京时间工作日只含周一至周五。法定节假日日历由后续版本接入。
CREATE FUNCTION public.internal_reminder_now() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path=pg_catalog
AS $$ SELECT clock_timestamp() $$;
--> statement-breakpoint
CREATE FUNCTION public.guard_internal_reminder_workday() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE local_day date;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.attempts=OLD.attempts AND NOT (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('done','reconcile')) THEN
      RETURN NEW;
    END IF;
  END IF;
  local_day := (public.internal_reminder_now() AT TIME ZONE 'Asia/Shanghai')::date;
  IF extract(isodow FROM local_day) NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION '北京时间周末不催办。' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.business_date := local_day;
  ELSIF NEW.business_date <> local_day THEN
    RAISE EXCEPTION '未处理催办跨工作日后不可补发。' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- 名称按字母排序在原入队守卫之后，由本守卫统一确认工作日桶。
CREATE TRIGGER internal_message_workday_guard BEFORE INSERT OR UPDATE ON public.internal_outbound_message
FOR EACH ROW EXECUTE FUNCTION public.guard_internal_reminder_workday();
--> statement-breakpoint
ALTER TABLE public.internal_outbound_message ENABLE ALWAYS TRIGGER internal_message_workday_guard;

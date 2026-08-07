DO $$
DECLARE
  month_start date := date_trunc('month', now())::date - interval '1 month';
  i integer;
  from_date date;
  to_date date;
BEGIN
  FOR i IN 0..13 LOOP
    from_date := (month_start + (i || ' month')::interval)::date;
    to_date := (month_start + ((i + 1) || ' month')::interval)::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS x_posts_%s PARTITION OF x_posts FOR VALUES FROM (%L) TO (%L)',
      to_char(from_date, 'YYYY_MM'), from_date, to_date
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS token_snapshots_%s PARTITION OF token_snapshots FOR VALUES FROM (%L) TO (%L)',
      to_char(from_date, 'YYYY_MM'), from_date, to_date
    );
  END LOOP;
END $$;

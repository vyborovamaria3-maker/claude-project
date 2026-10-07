-- Additive indexes for tenant lookups, campaign queues, budgets and alerts.
-- Use an explicit maintenance window on an existing large deployment.
CREATE INDEX IF NOT EXISTS reply_accounts_user ON reply_accounts(user_id,id);
CREATE INDEX IF NOT EXISTS reply_campaigns_user ON reply_campaigns(user_id,id);
CREATE INDEX IF NOT EXISTS reply_lore_user ON reply_lore(user_id,id);
CREATE INDEX IF NOT EXISTS reply_examples_lore ON reply_examples(lore_id,id);
CREATE INDEX IF NOT EXISTS reply_drafts_campaign_queue ON reply_drafts(campaign_id,status,created_at,id);
CREATE INDEX IF NOT EXISTS reply_rates_epoch ON reply_rate_limits(hour_epoch) INCLUDE(account_id,count);
CREATE INDEX IF NOT EXISTS reply_alerts_dedup ON reply_alerts(user_id,account_id,type,created_at DESC);
CREATE INDEX IF NOT EXISTS reply_alerts_feed ON reply_alerts(user_id,created_at DESC,id DESC);

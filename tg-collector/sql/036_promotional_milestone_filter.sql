-- Preserve every Telegram message and its immutable (source_id,message_id)
-- but mark repetitive paid-VIP growth advertisements as analytics noise.
ALTER TABLE tg_messages
  ADD COLUMN IF NOT EXISTS spam_kind text
  CONSTRAINT tg_messages_spam_kind_check
  CHECK (spam_kind IS NULL OR spam_kind = 'promotional_milestone');

-- Historical repair for the well-identified "VIP: x / Growth: x / MC: ... /
-- DEX PAID / Get VIP access" template. Mirrors the narrow TypeScript classifier.
UPDATE tg_messages SET spam_kind='promotional_milestone'
WHERE spam_kind IS NULL
  AND text ~* '(^|[^[:alnum:]_])[#$][a-z][a-z0-9]{1,9}([^[:alnum:]_]|$)'
  AND text ~* 'vip[[:space:]]*:[[:space:]]*x[[:space:]]*[0-9]'
  AND text ~* 'growth[[:space:]]*:[[:space:]]*x[[:space:]]*[0-9]'
  AND (text ~* 'dex[[:space:]]+paid' OR text ~* 'get[[:space:]]+vip[[:space:]]+access')
  AND (text ~* 'mc[[:space:]]*:' OR position('→' in text)>0 OR position('->' in text)>0);

-- These are historical evidence, not active independent signals. No original
-- post, first-seen candidate or ticker evidence is physically deleted.
UPDATE tg_token_mentions tm SET orphaned=TRUE
FROM tg_messages m
WHERE m.source_id=tm.source_id AND m.message_id=tm.message_id
  AND m.spam_kind='promotional_milestone' AND tm.orphaned=FALSE;

UPDATE tg_message_links l SET orphaned=TRUE
FROM tg_messages m
WHERE m.source_id=l.source_id AND m.message_id=l.message_id
  AND m.spam_kind='promotional_milestone' AND l.orphaned=FALSE;

-- Do not show historic paid-VIP alerts as first-discovery signals.
UPDATE tg_signals sig SET status='dismissed'
FROM tg_messages m
WHERE sig.source_id=m.source_id AND sig.message_id=m.message_id
  AND m.spam_kind='promotional_milestone'
  AND sig.status <> 'dismissed';

CREATE INDEX IF NOT EXISTS tg_messages_spam_kind_idx
  ON tg_messages(spam_kind) WHERE spam_kind IS NOT NULL;

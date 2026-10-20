-- Register the extended Telegram evidence extractor without mutating historical migrations.
INSERT INTO tg_analysis_versions(extractor_name,analysis_version,description,is_active,metadata)
VALUES ('telegram-text',4,'Telegram text and MessageEntityTextUrl evidence',TRUE,'{"url_entities":true}'::jsonb)
ON CONFLICT (extractor_name,analysis_version) DO UPDATE
SET description=EXCLUDED.description,metadata=EXCLUDED.metadata;
UPDATE tg_analysis_versions SET is_active=(analysis_version=4)
WHERE extractor_name='telegram-text';

CREATE INDEX IF NOT EXISTS tg_messages_analysis_pending_v4_idx
ON tg_messages(source_id,message_id)
WHERE analysis_version < 4 AND deleted_at IS NULL;

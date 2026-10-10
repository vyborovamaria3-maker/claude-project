-- Tag taxonomy
-- Extends the seed taxonomy from 023 with identity, behavior, industry and
-- network categories plus the operational high-risk / exchange tags.

INSERT INTO ip_tag_categories(id, name, parent_id) VALUES
  ('IDENTITY', 'Identity', NULL),
  ('BEHAVIOR', 'Behavior', NULL),
  ('INDUSTRY', 'Industry', NULL),
  ('NETWORK', 'Network', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ip_tags(id, name, category_id, parent_id) VALUES
  ('high-risk', 'High risk', 'RISK', NULL),
  ('exchange', 'Exchange', 'NETWORK', NULL)
ON CONFLICT (id) DO NOTHING;

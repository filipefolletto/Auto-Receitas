-- ============================================================================
--  Caldo & Cozinha — D1 (Cloudflare, plano Free)
--
--  Aplicar com:
--    wrangler d1 execute caldo --remote --file=./worker/schema.sql
-- ============================================================================

-- Cache de receitas: hash do pedido -> JSON normalizado.
CREATE TABLE IF NOT EXISTS recipes (
  hash       TEXT    PRIMARY KEY,
  payload    TEXT    NOT NULL,
  provider   TEXT    NOT NULL DEFAULT '',
  model      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Limpeza do cache TTL (30 dias) usa este índice.
CREATE INDEX IF NOT EXISTS idx_recipes_created_at ON recipes (created_at);

-- Cota diária: uma linha por IP por dia (UTC).
CREATE TABLE IF NOT EXISTS quota (
  client TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  hits   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client, day)
);

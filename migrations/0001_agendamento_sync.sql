CREATE TABLE IF NOT EXISTS agendamento_sync (
  lead_id    TEXT    PRIMARY KEY,
  synced_ts  INTEGER NOT NULL,  -- Unix timestamp do último horário sincronizado
  updated_at INTEGER NOT NULL   -- Quando foi sincronizado pela última vez
);

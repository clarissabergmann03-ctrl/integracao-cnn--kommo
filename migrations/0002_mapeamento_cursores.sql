-- Fase A1 (delta-driven): índice de junção + cursores.
-- Mantém agendamento_sync (legado W1/C1) durante a transição.

CREATE TABLE IF NOT EXISTS cursores (
  nome          TEXT PRIMARY KEY,
  valor         TEXT,
  atualizado_em INTEGER NOT NULL
);

-- Identidade paciente↔lead (um paciente CNN = um lead Kommo; duplicata sinalizada)
CREATE TABLE IF NOT EXISTS mapeamento (
  paciente_id_cnn TEXT PRIMARY KEY,
  lead_id_kommo   TEXT,
  telefone_norm   TEXT,
  duplicata       INTEGER DEFAULT 0,
  criado_em       INTEGER NOT NULL,
  atualizado_em   INTEGER NOT NULL
);

-- Estado de sincronização por agenda (status/hora já refletidos)
CREATE TABLE IF NOT EXISTS agenda_sync (
  agenda_id_cnn       TEXT PRIMARY KEY,
  lead_id_kommo       TEXT,
  paciente_id_cnn     TEXT,
  last_agendamento_ts INTEGER,
  last_cnn_status     TEXT,
  atualizado_em       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_map_tel  ON mapeamento(telefone_norm);
CREATE INDEX IF NOT EXISTS idx_map_lead ON mapeamento(lead_id_kommo);
CREATE INDEX IF NOT EXISTS idx_ag_lead  ON agenda_sync(lead_id_kommo);
CREATE INDEX IF NOT EXISTS idx_ag_pac   ON agenda_sync(paciente_id_cnn);

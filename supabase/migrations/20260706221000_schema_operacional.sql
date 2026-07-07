-- Schema operacional do kommo-cnn (D1/SQLite → Postgres). 9 tabelas.
-- mig_*/backfill_hist (staging one-time já concluído) NÃO são recriadas.

-- Legado (W1): ts de sync por lead
create table if not exists agendamento_sync (
  lead_id text primary key, synced_ts bigint not null, updated_at bigint not null);

-- Watermarks / cursores / lease
create table if not exists cursores (
  nome text primary key, valor text, atualizado_em bigint not null);

-- Identidade paciente↔lead (PK COMPOSTA — a migração de chave já é passado)
create table if not exists mapeamento (
  paciente_id_cnn text not null, grupo text not null, lead_id_kommo text, telefone_norm text,
  duplicata smallint default 0, criado_em bigint not null, atualizado_em bigint not null,
  primary key (paciente_id_cnn, grupo));
create index if not exists idx_map_tel on mapeamento(telefone_norm);
create index if not exists idx_map_lead on mapeamento(lead_id_kommo);
create index if not exists idx_map_pac on mapeamento(paciente_id_cnn);

-- Baseline anti-eco por agenda (+origin p/ anti-loop dos webhooks)
create table if not exists agenda_sync (
  agenda_id_cnn text primary key, lead_id_kommo text, paciente_id_cnn text,
  last_agendamento_ts bigint, last_cnn_status text, atualizado_em bigint not null, origin text);
create index if not exists idx_ag_lead on agenda_sync(lead_id_kommo);
create index if not exists idx_ag_pac on agenda_sync(paciente_id_cnn);

-- Idempotência da véspera (1 lembrete/lead/dia)
create table if not exists lembrete_d1 (
  chave text primary key, lead_id_kommo text, agenda_id_cnn text, data_agendamento text,
  grupo text, pipeline_destino bigint, etapa_destino bigint, enviado_em bigint not null);

-- Ledger de auditoria (AUTOINCREMENT → IDENTITY)
create table if not exists auditoria (
  id bigint generated always as identity primary key, ts bigint not null, funcao text, ambiente text,
  entidade_id text, acao text, de text, para text, detalhe text);

-- Fila de trabalho (+locked_at); claim usará FOR UPDATE SKIP LOCKED (Fase 2)
create table if not exists fila_trabalho (
  id bigint generated always as identity primary key,
  chave text unique, tipo text, agenda_id_cnn text, paciente_id_cnn text, grupo text, payload text,
  status text default 'pendente', tentativas int default 0, ultimo_erro text, locked_at bigint,
  criado_em bigint not null, atualizado_em bigint not null);
create index if not exists idx_fila_status on fila_trabalho(status, id);

-- Idempotência do reflexo de orçamento
create table if not exists orcamento_sync (
  paciente_id_cnn text primary key, lead_id_kommo text, ultimo_status text, ultima_etapa bigint, updated_at bigint);

-- Log durável por tick (F1)
create table if not exists tick_log (
  id bigint generated always as identity primary key, ts bigint not null, ok smallint not null,
  ms bigint, subreq int, gatilhos text,
  processados int, movidos int, criados_b int, adiados int, erros int, transitorios int,
  fila_pendente int, fila_erro int, erro text, resumo text);
create index if not exists idx_tick_ts on tick_log(ts);

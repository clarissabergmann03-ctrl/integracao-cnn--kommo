-- Staging da base CNN p/ o widget/dashboard (kommo-widget) — criadas ao vivo em 22/07/2026
-- via Management API; esta migration espelha o schema vivo p/ replay reproduzível.
-- Escrita SÓ pelo motor (/base-refresh, service role); leitura pelo widget (service role).
-- RLS + revoke: mesmo padrão de segurança das demais tabelas (PII protegida de anon).

create table if not exists base_pacientes (
  paciente_id_cnn text primary key,
  nome text, telefone text, email text, nascimento date, ativo boolean,
  enriquecido boolean not null default false,
  atualizado_em timestamptz not null default now(),
  n_agendas int, n_finalizadas int, n_faltas int,
  primeira_visita date, ultima_atividade date, ultima_agenda_status text,
  teve_a boolean, teve_b boolean, tem_futura boolean, grupo_futuro text,
  cauda_faltas boolean,
  n_orcamentos int, tem_orc_aberto boolean,
  ultimo_aprovado date, status_ultimo_aprovado text, cancelou_apos boolean,
  cobertura_pct int, valor_aprovado_total numeric, tem_orcado_nao_feito boolean,
  procedimentos_feitos jsonb, procedimentos_orcados jsonb,
  raw_flags jsonb
);
create index if not exists idx_base_pac_enr on base_pacientes(enriquecido);
create index if not exists idx_base_pac_ult on base_pacientes(ultima_atividade);
create index if not exists idx_base_pac_tel on base_pacientes(telefone);

create table if not exists base_refresh_estado (
  id int primary key,
  fase text not null default 'parado', -- parado|enumerar|enriquecer|pronto|erro
  pagina int not null default 0,
  total_paginas int,
  total_pacientes int,
  enriquecidos int not null default 0,
  iniciado_em timestamptz,
  atualizado_em timestamptz not null default now(),
  detalhe text
);
insert into base_refresh_estado (id) values (1) on conflict do nothing;

alter table base_pacientes enable row level security;
alter table base_refresh_estado enable row level security;
revoke all on base_pacientes from anon, authenticated;
revoke all on base_refresh_estado from anon, authenticated;

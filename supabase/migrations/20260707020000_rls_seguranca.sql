-- SEGURANÇA (RLS): as tabelas guardam PII (paciente↔lead, status clínico, telefones).
-- A app acessa via conexão Postgres DIRETA (role `postgres`, DATABASE_URL/pooler) que BYPASSA RLS
-- (owner bypass — NÃO usar FORCE, senão a app pararia). anon/authenticated (PostgREST) NÃO devem ler nada:
-- habilita RLS (sem policies = zero linhas) + revoga grants (defesa em profundidade → permission denied).

alter table public.agendamento_sync enable row level security;
alter table public.cursores        enable row level security;
alter table public.mapeamento       enable row level security;
alter table public.agenda_sync      enable row level security;
alter table public.lembrete_d1      enable row level security;
alter table public.auditoria        enable row level security;
alter table public.fila_trabalho    enable row level security;
alter table public.orcamento_sync   enable row level security;
alter table public.tick_log         enable row level security;

revoke all on public.agendamento_sync from anon, authenticated;
revoke all on public.cursores        from anon, authenticated;
revoke all on public.mapeamento       from anon, authenticated;
revoke all on public.agenda_sync      from anon, authenticated;
revoke all on public.lembrete_d1      from anon, authenticated;
revoke all on public.auditoria        from anon, authenticated;
revoke all on public.fila_trabalho    from anon, authenticated;
revoke all on public.orcamento_sync   from anon, authenticated;
revoke all on public.tick_log         from anon, authenticated;

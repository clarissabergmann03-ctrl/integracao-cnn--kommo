-- Cron dentro do Postgres + HTTP de dentro do banco (gatilho do tick → Vercel, na Fase 3).
create extension if not exists pg_cron;
create extension if not exists pg_net;

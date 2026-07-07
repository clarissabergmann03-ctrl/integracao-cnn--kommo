# Go-Live Kommo–CNN (Cloudflare → Vercel/Supabase) — Checklist + Validação
**Fonte:** auditoria multi-agente `wln80bf0k` (07/07) — 4 subagentes read-only + síntese.
**Veredito:** NO-GO condicional — fechar as travas T1/T2 + pendências P1/P2 abaixo antes de declarar GO.

---

## Estado da validação (o que já está provado e2e)
- Kommo→CNN: confirmação ✅, pós-venda agendar ✅ (real read, idempotente).
- CNN→Kommo: régua D-1 ✅, **reflexo de status (produtorSync/A3) ✅** (lead 18149444 → Consulta Confirmada, real read, idempotente).
- Paridade B4 (código pós-consumidores src×core): **PASSA** — só edições intencionais.
- RLS ✅, anti-mock ✅, anti-loop ✅.

## Travas que bloqueiam o GO
- **T1 — Reflexo de ORÇAMENTO (produtorOrcamento/ORC) nunca validado e2e.** Código auditado/correto, mas sem prova de execução. Precisa fixture (abaixo) + Plano 2.
- **T2 — Supabase defasado do D1 (drift; CF vivo).** D1 avançou: mapeamento 1561→1563 (2 novos = risco de card duplicado), agenda_sync 636→638 (+2 novos, ≥4 status defasados), orcamento_sync +1, cursor_orcamento divergente. `lembrete_d1` íntegro (0 re-envio de D-1). **Correção:** pausar CF + re-rodar `scripts/resync-estado-d1.mjs` imediatamente antes do cutover; re-verificar D1==Supabase.

## Pendências do dono
- **P1 — Mecanismo de re-apontar webhooks.** Rodar (do lado Vercel/dono, `KOMMO_ACCESS_TOKEN` só na env Vercel): `GET https://<KOMMO_SUBDOMAIN>.kommo.com/api/v4/webhooks -H "Authorization: Bearer <KOMMO_ACCESS_TOKEN>"`. Se listar as URLs do Worker → webhooks de conta (re-aponta por API); se vazio → ações "Enviar webhook" do Digital Pipeline/Salesbot → re-aponta na **UI** (mais provável).
- **P2 — SALA e PROCEDIMENTO reais do WH2 (pós-venda).** Hoje defaults de sandbox descobertos (sala 19775, proc 381357). Setar `CNN_LOCAL_AGENDA_PRODUCTION` / `CNN_TIPO_PROCEDIMENTO_PRODUCTION` na Vercel antes de ligar WH2. (Convênio 27603 já confirmado.)

---

## PLANO 2 — Validar reflexo de ORÇAMENTO (escopado, reversível)
**Fixture (bloqueio):** POST /orcamento é barrado pelo allowlist §7.8 → o dono cria **1 orçamento de teste na tela do CNN** p/ paciente 28524071 (ABERTO p/ cenário "gerado"; aprovar hoje, dataAprovacao≤60d, p/ "aprovado"). O código só LÊ (GET /orcamento/lista).

**Abrir 2 portões (senão dá sempre sem_mudanca/adiado):**
- (i) `UPDATE agenda_sync SET last_cnn_status='FINALIZADO' WHERE paciente_id_cnn='28524071'` → `temAgendaFutura=false`. Guardar originais (130276667=CONFIRMADO_PACIENTE, 130276669=AGENDADO).
- (ii) assentar o card-alvo numa etapa de `ETAPAS_ORC_PODE_AGIR` {106848627 Avaliação Realizada, 106848631 Tratamento Proposto, 107633739 Em Análise, 107658907 Tratamento Iniciado, 143 Perdido}.

**Cenário A — ABERTO → Pós-Consulta/Em Análise (card A 18149444):**
1. Pausar cron CF. 2. Portão (i). 3. `/debug-move?lead=18149444&pipeline=13847079&status=106848627`.
4. `/debug-orcamento?paciente=28524071&decidir=1&env=production` → esperar `decisao={pipeline:13947295,status:107633739}`.
5. `…&aplicar=1&dry=1` (r=movido "Pós-Consulta: Em Análise") → depois `&dry=0`.
6. **LER Kommo:** lead 18149444 em 13947295/107633739. Reverter: /debug-move volta p/ Captação; restaurar agenda_sync; limpar orcamento_sync do teste; restaurar cron CF.

**Cenário B — APROVADO recente → Pós-Venda/Tratamento Iniciado (card B 19416346):**
1-2. Pausar CF + portão (i). 3. `/debug-move?lead=19416346&pipeline=13950431&status=143`.
4. `/debug-orcamento?paciente=28524071&decidir=1` → `decisao={13950431,107658907}`.
5. `…&aplicar=1&dry=1` → `&dry=0`. 6. **LER Kommo:** 19416346 em 13950431/107658907. Reverter análogo.

---

## CHECKLIST DO CUTOVER

**INVARIANTE: NUNCA CF-cron e pg_cron ativos juntos** (D1×Supabase → régua D-1 duplicada → tarefa duplicada no Kommo). Single-writer sempre.

### A) Re-apontar webhooks (ver P1). Rotas (POST, `?secret=<WEBHOOK_SECRET>`): `/webhook/confirmacao` (WH1_ENABLED), `/webhook/pos-venda-agendar` (WH2_ENABLED), `/webhook/lead-agendado` (legado). Hoje → `kommo-cnn.clarissabergmann03.workers.dev/webhook/...`. Re-apontar p/ `https://<URL_PROD>/webhook/...?secret=<WEBHOOK_SECRET>`.

### B) pg_cron → /api/tick (rodar 1× no SQL Editor do Supabase; `net.http_post`, NÃO `pg_net.http_post`):
```sql
select vault.create_secret('<WEBHOOK_SECRET>',                    'kommo_cnn_webhook_secret');
select vault.create_secret('https://<URL_PROD_ESTAVEL>/api/tick', 'kommo_cnn_tick_url');
select cron.schedule('kommo-cnn-tick', '* * * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name='kommo_cnn_tick_url'),
    headers := jsonb_build_object('Content-Type','application/json',
                 'Authorization',(select decrypted_secret from vault.decrypted_secrets where name='kommo_cnn_webhook_secret')),
    body    := '{}'::jsonb, timeout_milliseconds := 55000);
$$);
-- verificar: select jobid,schedule,active from cron.job;  select status_code,created from net._http_response order by created desc limit 5;
-- rollback:  select cron.unschedule('kommo-cnn-tick');
```
(`/api/tick` aceita header `Authorization`=WEBHOOK_SECRET cru OU `Bearer <secret>`.)

### C) Ordem segura
**Pré:** 1. `vercel --prod` (URL estável) + conferir env (WEBHOOK_SECRET, DATABASE_URL/DIRECT_URL, KOMMO_*, CNN_WRITE_TARGET=production, WH1/WH2_ENABLED, CNN_*_PRODUCTION). Smoke /health, /debug-tick?dry=1. 2. **Validar T1** (Plano 2) — não avançar sem os moves confirmados no Kommo.
**Janela:** 3. **Pausar cron CF** (`PUT .../schedules []`). 4. **Re-rodar `resync-estado-d1.mjs`** (congela D1; corrige o drift) + re-verificar. 5. **Ligar pg_cron** (SQL B). 6. **Re-apontar webhooks** (A). 7. Observar ~10min (tick_log 60/60, /debug-fila-erros vazio, 1 confirmação real fluindo).
**Rollback:** R1 `select cron.unschedule('kommo-cnn-tick')`. R2 restaurar cron CF (`[{"cron":"* * * * *"}]`). R3 re-apontar webhooks p/ o Worker. (D1 intacto; moves forward-only/idempotentes.)

---

## Dívida de dados (paralela, NÃO bloqueia go-live)
**Duplicação sistêmica em Pós-Consulta (13947295):** ~250–350 pacientes com 2 cards (mapeado 1916/1917xxx "em análise" + órfão 1960xxxx não-mapeado), herdada da **migração one-time** (criou card em Pós-Consulta sem gravar `mapeamento` → driblou a guarda). Funil congelado (762 cards). Limpeza: enumerar leads do 13947295, agrupar por ID Paciente CNN, manter o mapeado, mover o órfão p/ perdido/143 ou mesclar (Kommo não deleta lead → 405). A guarda `mapeamento(pid,grupo)` é **estruturalmente cega a Pós-Consulta** (PK só chaveia A/B) — se a migração for re-executada sem idempotência que consulte Pós-Consulta, re-duplica.

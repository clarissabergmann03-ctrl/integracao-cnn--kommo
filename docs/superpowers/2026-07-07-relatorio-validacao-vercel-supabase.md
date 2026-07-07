# Relatório de Validação — Migração Kommo–CNN para Vercel + Supabase
**Data:** 2026-07-07 · **Paciente de teste:** 11946800329 (CNN prod: paciente 28524071) · **Deploy avaliado:** kommo-nh85oh59j…vercel.app

> **VEREDITO: meta (100% dos itens ✅ · taxa agregada ≥99,5%) NÃO ATINGIDA.** A direção **Kommo→CNN está provada ponta-a-ponta (5/5)**; a direção **CNN→Kommo** e o **estresse ≥99,5%** dependem de 3 bloqueios externos (cutover, fixture de orçamento, Supabase pago). Sem arredondar ⚠️ pra ✅.

---

## 1. Checklist (auto-gerado) com evidência de leitura no destino real

| # | Item | Direção | Status | Evidência |
|---|---|---|---|---|
| 1 | Fix constantes sandbox→prod (convênio/sala/proc) | — | ✅ | agenda criada em prod c/ 27603/19775/66668; selftests 64/64 |
| 2 | Fixture: paciente 28524071 + agenda 130276667 | — | ✅ | lido no CNN (AGENDADO) + Kommo (id_agenda_cnn/id_paciente_cnn) |
| 3 | F.Captura — confirmação (CNN_CONFIRMAR) | Kommo→CNN | ✅ e2e | agenda 130276667: AGENDADO→CONFIRMADO_PACIENTE (lido do CNN) |
| 4 | F.Pós-venda — agendar (CNN_AGENDAR, Grupo B) | Kommo→CNN | ✅ e2e | agenda 130276669 criada: Encaixe/66668, sala 19775 (lido do CNN) |
| 5 | Idempotência / anti-loop | — | ✅ | 2ª confirmação `ja_confirmado`; 2º agendar `ja_agendado_mesmo_ts`; contagem=1 |
| 6 | Anti-mock (input variado) | — | ✅ | RETORNO rejeitado pela regra REAL do CNN (reconsulta) → não é mock |
| 7 | RLS zero-leak | — | ✅ | anon→42501; app (role postgres) 200 |
| 8 | Selftests / lógica pura | — | ✅ | 64/64 (inclui 7 de config target-condicional + 5 de guardrail) |
| 9 | Latência (execução única) | — | ✅ | tick de confirmação ~2,4s; agendar similar |
| 10 | Régua D-1 (véspera) | CNN→Kommo | ⚠️ só lógica (dry) | produtorVespera leu 49 agendas reais → F2 lead 17488447 "movido"; **e2e-escrita pendente cutover** |
| 11 | Reflexo de orçamento (Pós-Consulta) | CNN→Kommo | ❌ não validado | paciente 0 orçamentos; POST /orcamento bloqueado → precisa fixture manual |
| 12 | Pooling / reflexo de status | CNN→Kommo | ❌ pendente cutover | varredura de janela duplica com CF vivo |
| 13 | Estresse — camada de função | — | ✅ | /health 50 concorrentes → 100%, p50 0,47s |
| 14 | Estresse — Supabase pesado | — | ⚠️ 80–97,5% | /debug-audit 40 concorrentes: 504 (60s) sob burst; < 99,5% |

**Taxa da direção Kommo→CNN (testável agora): 5/5 execuções corretas e confirmadas = 100%.**
**Taxa agregada da meta: reprovada** — itens 10/11/12 sem e2e, item 14 < 99,5%.

---

## 2. Mapa de paridade CF Worker → Vercel+Supabase (workflow wgpclhek1)
- **B1** (config, roteamento por tipo, retry, wrappers CNN, guardrail): ✅ byte-a-byte idêntico ao `src/index.ts`, salvo 3 edições **intencionais** (guardrail absoluto em `assertCnnWritable`, `cnnDelete` tripwire, +5 selftests). Sem SQLite-ism neste bloco.
- **B2** (wrappers Kommo, utilitários telefone/timezone, escrita em lead): ✅ idêntico (`diff` = "IDENTICAL"). Sem acesso a banco.
- **Dialeto D1→Postgres** (fora de B1/B2): `ensureSchema`→no-op (schema por migration), `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`, `?`→`$n` (shim `db.ts`), claim `FOR UPDATE SKIP LOCKED`, imports `.js`.
- **B4** (bloco final): o agente falhou por erro de servidor no meio — **não reconferido** (pendência menor; os fluxos executados provaram a paridade funcional na prática).

---

## 3. Integridade dos dados (migração D1→Supabase)
6 tabelas de idempotência migradas com **contagem idêntica** ao D1: mapeamento 1556, agenda_sync 628, orcamento_sync 1237, lembrete_d1 146, cursores 3, agendamento_sync 5. Não migradas (histórico/efêmero): auditoria, tick_log, fila_trabalho. Durante os testes o `agenda_sync` recebeu as linhas do paciente de teste sem colisão; contagem de agendas do paciente no slot testado = 1 (sem duplicata).

## 4. RLS (segurança)
Migration `20260707020000_rls_seguranca.sql`: RLS habilitado nas 9 tabelas + `revoke all` de anon/authenticated. Verificado: anon (PostgREST) → **42501 permission denied** em mapeamento/agenda_sync (PII: paciente↔lead, status clínico, telefones); app via conexão direta (role postgres) bypassa e responde 200. **Zero vazamento.** (Sem FORCE, senão a app pararia.)

## 5. Real-vs-Mock (prova de que não é simulação)
- Toda confirmação de sucesso foi **lida de volta no destino real** (GET /agenda/lista do CNN produção; GET /leads do Kommo) — não da resposta do endpoint de escrita.
- **Input variado**: RETORNO → CNN rejeitou por regra de negócio real ("fora do prazo de reconsulta"); Encaixe → aceito. Um mock não teria essa regra clínica. Prova viva de tráfego real.
- Erros reais do CNN capturados e classificados (400 permanente vs transitório) — não engolidos.

## 6. Mapa de loops + prova de convergência
Único guarda anti-loop = `decidirSupressao` (puro, selftestado) sobre `agenda_sync` (baseline `last_cnn_status` + `last_agendamento_ts` ±60s):
- **CONFIRMAR converge**: uma vez `last_cnn_status=CONFIRMADO_PACIENTE`, toda re-execução suprime. **Provado**: 2ª chamada → `ja_confirmado`, 0 PUT duplicado.
- **AGENDAR converge**: uma vez criada a agenda no `ts` (±60s), re-execução no mesmo `ts` suprime; `ts` novo = nova agenda legítima (não é loop). **Provado**: 2ª chamada → `ja_agendado_mesmo_ts`, contagem de agendas=1.
- **Echo pooling (CNN→Kommo refletindo o que Kommo→CNN acabou de escrever)**: suprimido pela tolerância ±60s de `ts` + baseline. **Validado só em lógica/selftest** (e2e depende do cutover).
- `purgarGemeoFeito` libera re-disparos legítimos (confirmar→desconfirmar→reconfirmar; cancelar+reagendar mesmo horário) sem reabrir loop.

## 7. Estresse — gargalos
- Camada de função (V8/Node, sem DB): escala a 50 concorrentes, 100%, p50 0,47s. ✅
- Caminho Supabase pesado (4 queries/req): sob 40 concorrentes, 1–8 req penduram até 60s (maxDuration) → 80–97,5%. **Causa raiz = espera por conexão do pooler Supavisor free-tier (~15 conexões de servidor)**; tuning de `db.ts` (idle/max_lifetime/connect/statement_timeout, max=8) **não eliminou** — é teto de infra. Carga real (cron 1/min + webhooks esparsos) fica muito abaixo disso.

## 8. Funções faltantes / parciais
- **CORRIGIDO**: `cnnLocalAgenda`/`cnnTipoProcedimento`/`cnnConvenioParticular` eram constantes sandbox (falhavam em prod) → agora target-condicionais (env-overridable). **Aplicar o mesmo no Worker CF `src/index.ts` no cutover.** ⚠️ dono deve confirmar SALA e PROCEDIMENTO reais de produção (defaults 19775/381357 são os descobertos no teste).
- **NÃO EXERCITADO e2e (pendente cutover/fixture)**: produtorSync/produtorBackfill (pooling status), produtorVespera consumidor F2 (move real do card), produtorOrcamento + consumidor (reflexo de orçamento), reflexo de aprovação de orçamento (Em Análise / Tratamento Iniciado).

## 9. Fiação dos webhooks (Kommo → Vercel), pós-cutover
Base = URL de produção estável (após `vercel --prod`). Todos com `?secret=<WEBHOOK_SECRET>`:
- Etapa **"Consulta Confirmada"** (Salesbot, paciente confirmou no WhatsApp) → `POST /webhook/confirmacao`
- Card pós-venda em **"Cliente Ativo"** com AGENDAMENTO + Tipo Procedimento CNN → `POST /webhook/pos-venda-agendar`
- (Legado, hoje sandbox) Etapa **"Consulta Agendada"** → `POST /webhook/lead-agendado` (só se quiser que a Vercel crie a agenda Grupo A)
- Cron 1/min → `POST /api/tick` com `Authorization: <WEBHOOK_SECRET>` (via pg_cron+pg_net do Supabase; Vercel Hobby não faz cron sub-diário)

---

## 10. Caminho para 100% (os 3 bloqueios — dependem de decisão/recurso do dono)
1. **CUTOVER** (decisão do dono; mexe no CF vivo): pg_cron→/api/tick + re-apontar webhooks Kommo p/ Vercel + `vercel --prod` + **desligar cron do CF**. Só então a direção CNN→Kommo (régua D-1, reflexo de orçamento, pooling) é validável e2e sem duplicar.
2. **Fixture de orçamento** no CNN (manual — `POST /orcamento` é bloqueado pelo allowlist) p/ validar Pós-Consulta.
3. **Supabase pago** (pool maior) p/ passar de ~96% → ≥99,5% no burst pesado; ou aceitar que a carga real fica muito abaixo do burst testado.

**Artefatos de teste deixados em produção (não deletáveis por guardrail/allowlist):** paciente 28524071 + agendas 130276667/130276669; pacientes órfãos 28524126/28524693. Remoção manual na tela do CNN se desejado.

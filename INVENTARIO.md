# INVENTÁRIO COMPLETO — kommo-cnn

> Snapshot do que **existe hoje** no projeto, antes de adicionar a camada de roteamento por tipo (Captação × Pós-Venda) e o log de idempotência do D-1.
> Gerado em 2026-06-23. Fonte: `src/index.ts` (1390 linhas), `wrangler.toml`, `/discover` ao vivo, `setup-secrets.ps1`, `TESTES.md`.

---

## 0. ⛔ REGRA DE SEGURANÇA — CHAVE DE PRODUÇÃO DO CNN (INVIOLÁVEL)

> O CNN **não tem chave só-leitura**: a mesma credencial lê e escreve. Portanto vira regra comportamental do agente, sem exceção:
>
> **Com a chave de PRODUÇÃO do CNN, SÓ são permitidas chamadas de LEITURA (`GET`). NUNCA `POST`, `PUT` ou `DELETE` em produção até liberação explícita do dono do projeto.**
>
> - Endpoints de escrita CNN proibidos em prod até liberação: `POST /agenda/novo`, `POST /agenda/{id}/remarcar`, `PUT /agenda/alteracao-status`, `POST /paciente/novo`, `PUT /paciente/{id}`, `POST /convenio-paciente/associar`.
> - **Antes de cada uso da chave de produção, o agente confirma com o dono que a operação é só `GET`.**
> - Sandbox (CID de teste atual) segue podendo escrever, restrito à allowlist (§12.1 do escopo mãe).

---

## 0.1. ⚙️ Quirks de API confirmados ao vivo (2026-06-24)

- **CNN `/agenda/lista` capa em 100 registros/página** — `registrosPorPagina=200` é ignorado (volta 100). `totalPaginas` É confiável; o loop pagina com `while (pag < totalPaginas)` e lê tudo. Filtro `dataInicial/dataFinal` **funciona** (domingo/datas distantes → 0). Não há `totalRegistros` na resposta.
- **Kommo `GET /leads` sem filtro EXCLUI leads "Incoming"/unsorted** e não enumera por pipeline de forma confiável. Contagem/varredura real exige `filter[statuses][0][pipeline_id]+[status_id]` **por etapa** + guarda no código. `filter[...pipeline_id]` sozinho é ignorado.
- **Telefone**: CNN tem formatos mistos (com/sem DDI 55, com/sem 9º dígito). Matching usa `phoneKey()` = DDD + últimos 8 (§7.1) pra casar sem duplicar.
- **CNN `/agenda/lista` NÃO retorna nome do paciente** — só `idPaciente`. Nome exige `GET /paciente/{id}`. **O CNN rate-limita esses lookups em sequência** nos dias cheios → nomes caem pra "CNN <id>". Mitigado com `cnnPacienteNome()` (3 tentativas + backoff); resíduo é cosmético (card criado vira "Paciente CNN <id>").
- **Tarefas internas** (bloqueio de agenda, pausa, "Acompanhar Dr X") são cadastradas como agendas com **telefone falso** (ex.: `(51) 11111-1111`). `idRotulo` é sempre null (não serve), tipo/local/executor são reais. Filtro `isTarefaInterna()` = telefone vazio, < 10 dígitos, ou ≤ 2 dígitos distintos. Aplicado em A3, A4, Função 2 e no preview.
- **Roteamento de cancelados** (status `CANCELADO`/`CANCELADO_PACIENTE`): Grupo A → "Cancelada–Perdido" (143); Grupo B → "Cliente Ativo" (107658911, cliente segue ativo mesmo com procedimento cancelado).

---

## 1. Arquivos do projeto

| Arquivo | Deployado? | Função |
|---|---|---|
| `src/index.ts` | ✅ SIM (único arquivo do Worker) | Toda a lógica de produção |
| `src/stub.ts` | ❌ NÃO | Script de diagnóstico (aponta p/ `/investigar-cnn`) |
| `wrangler.toml` | — | Config do Worker (binding D1, vars, crons) |
| `setup-secrets.ps1` | — | Helper interativo p/ `wrangler secret put` |
| `TESTES.md` | — | Backlog de testes T0–T7 (geração C1/C2 legada) |
| `INVENTARIO.md` | — | Este arquivo |

**Worker URL:** `https://kommo-cnn.clarissabergmann03.workers.dev`
**Account Cloudflare:** clarissabergmann03

---

## 2. Crons (wrangler.toml + handler `scheduled`)

| Cron (UTC) | Horário BRT | Dispara | Função |
|---|---|---|---|
| `0 18 * * *` | 15h | `cronLembreteD1` | **C1** — Lembrete D-1 |
| `*/10 * * * *` | a cada 10 min | `cronSyncStatus` | **C2** — Sync CNN↔Kommo |

Despacho em `scheduled` (index.ts:1373): `event.cron === "0 18 * * *"` → C1; qualquer outro → C2.

> ⚠️ As funções novas **A2/A3/A4 NÃO estão no cron** — só existem como funções + endpoints `/debug-*`. O cron hoje roda a geração **legada** C1/C2.

---

## 3. Endpoints HTTP (handler `fetch`, index.ts:1308)

| Rota | Método | Auth | Função |
|---|---|---|---|
| `/health` | GET | nenhuma | healthcheck `{ok, ts}` |
| `/test-workflow` | GET/POST | `Authorization: <WEBHOOK_SECRET>` | Auditoria + simulação de fluxo |
| `/debug-c1` | GET | idem | Dry-run do C1 + compara filtros Kommo |
| `/debug-scale` | GET | idem | Valida filtros/paginação Kommo + volume CNN |
| `/debug-a2` | GET | idem | Dry-run A2 (`?dry=0` p/ efetivar) |
| `/debug-a3` | GET | idem | Dry-run A3 (`?dry=0` p/ efetivar) |
| `/debug-a4` | GET | idem | Dry-run A4 (`?dry=0`, `?soteste=0`) — **forma manual do A4** |
| `/discover` | GET | idem | Dump configs CNN (`/info`) + Kommo (pipelines, custom fields) |
| `/webhook/lead-agendado` | POST | `?secret=<WEBHOOK_SECRET>` | **W1** |
| `/webhook/confirmacao` | POST | `?secret=<WEBHOOK_SECRET>` | **W2** |
| (qualquer outra) | — | exige `?secret` | 404 |

Dois esquemas de auth:
- `discoverAuthOk` (index.ts:1302) → header `Authorization` == `WEBHOOK_SECRET`. Usado por `/test-workflow`, `/debug-*`, `/discover`.
- `webhookAuthOk` (index.ts:1299) → query `?secret=` == `WEBHOOK_SECRET`. Usado pelos webhooks.

### Ações do `/test-workflow` (POST `?acao=`, phone default `11946800329`)

| `acao` | O que faz | Allowlist? |
|---|---|---|
| `audit` (GET default) | Lê estado Kommo+CNN, mostra se C1 moveria | — |
| `test-delete` | Apaga leads+contato+estado D1 do telefone | ✅ |
| `set-cnn-status` | Muda status da agenda no CNN (`?status=`) | ✅ |
| `set-agendamento` | Seta campo AGENDAMENTO (`?data=&hora=`) | ✅ |
| `test-w1` | E2E do W1 com data/hora explícitas | ✅ |
| `mover-agendada` | Vincula 1ª agenda CNN ativa a lead sem ID Agenda | — |
| `run-c1` | Move p/ Confirmação de Consulta (bypassa data) | — |
| `run-confirmacao` | CNN CONFIRMADO_PACIENTE + move p/ Consulta Confirmada | — |
| `primer` | Move p/ Primeiro Contato, seta AGENDAMENTO amanhã, limpa IDs+D1 | — |
| `run-w1` | Move p/ Consulta Agendada + executa W1 | — |
| `reset` | Volta p/ Consulta Agendada c/ IDs CNN e data amanhã | — |

---

## 4. Funções (src/index.ts) — todas

### Fluxos de negócio
| Função | Linha | Papel |
|---|---|---|
| `handleLeadAgendado` | 287 | **W1** — lead→Consulta Agendada: cria paciente+agenda CNN, salva IDs |
| `handleConfirmacao` | 363 | **W2** — paciente confirmou: CNN CONFIRMADO_PACIENTE + move p/ Consulta Confirmada |
| `selectLeadsLembreteD1` | 390 | Seleciona leads do D-1 (valida data do AGENDAMENTO local) |
| `cronLembreteD1` | 430 | **C1** — move selecionados p/ Confirmação de Consulta |
| `syncKommoParaCnn` | 442 | **A2** — Kommo→CNN delta por cursor `updated_at` |
| `syncCnnParaKommo` | 514 | **A3** — CNN→Kommo por janela de agendas |
| `backfillCadastros` | 612 | **A4** — backfill cadastros CNN→Kommo (vincula/cria card) |
| `cronSyncStatus` | 700 | **C2** — sync legado (Parte A hora/status, B trat. proposto, C backfill telefone) |

### Diagnóstico / teste
| Função | Linha | Papel |
|---|---|---|
| `handleTestWorkflow` | 853 | Auditoria + ações de simulação |
| `handleDebugC1` | 1207 | Dry-run C1 |
| `handleDebugScale` | 1237 | Validação de filtros/escala |

### CNN helpers
`cnnHeaders` (43), `cnnGet` (50), `cnnPost` (55), `cnnPut` (63), `getOrCreateConvenioParticular` (270).

### Kommo helpers
`kommoBase` (73), `kommoThrottle` (79, ~6,6 req/s), `kommoGet` (87), `kommoPatch` (98), `kommoPost` (109), `kommoDelete` (120), `resolveFields` (24, cache 1h nome→id de custom fields).

### Utilitários
`isTestePhone` (131), `getFieldValue` (137), `setLeadFields` (141), `moveLeadToStage` (149), `setAgendamento` (154), `addMinutes` (157), `unixToDateBRT` (162), `brtToUnix` (166), `dayRangeBRT` (169), `tomorrowBRT` (173), `todayBRT` (178), `normalizePhone` (181).

### D1 helpers
`ensureSchema` (187), `getCursor` (207), `setCursor` (211), `upsertMapeamento` (219), `getMapeamentoByPaciente` (232), `upsertAgendaSync` (237), `getAgendaSync` (251), `getSyncedTs` (254), `setSyncedTs` (260).

### Auth
`webhookAuthOk` (1299), `discoverAuthOk` (1302).

### Export default
`fetch` (1308), `scheduled` (1373).

---

## 5. Tabelas D1 (banco `kommo-cnn-db`, id `158f672c-1589-439d-b550-8917f424c3ab`)

Criadas em `ensureSchema` (index.ts:187):

| Tabela | PK | Colunas | Uso |
|---|---|---|---|
| `agendamento_sync` | `lead_id` | `synced_ts`, `updated_at` | Legado W1/C1/C2 — ts da última sync por lead |
| `cursores` | `nome` | `valor`, `atualizado_em` | Cursor delta. Chave usada: **`kommo_updated_at`** (A2) |
| `mapeamento` | `paciente_id_cnn` | `lead_id_kommo`, `telefone_norm`, `duplicata`, `criado_em`, `atualizado_em` | Identidade paciente↔lead (anti-ressurreição A4) |
| `agenda_sync` | `agenda_id_cnn` | `lead_id_kommo`, `paciente_id_cnn`, `last_agendamento_ts`, `last_cnn_status`, `atualizado_em` | Estado por agenda (baseline anti-eco A2/A3) |

Índices: `idx_map_tel`(telefone_norm), `idx_map_lead`(lead_id_kommo), `idx_ag_lead`(lead_id_kommo), `idx_ag_pac`(paciente_id_cnn).

---

## 6. Constantes de negócio (index.ts)

### CNN (fixos, validados via /discover)
```
CNN_CONVENIO_PARTICULAR = 56545
CNN_TIPO_CONSULTA       = 110452   ← hardcoded só na CRIAÇÃO (W1); nunca lido p/ rotear
CNN_LOCAL_AGENDA        = 41170
CNN_TIPO_PROCEDIMENTO   = 1011844  ← idem, só criação
CNN_BASE = "https://api.clinicanasnuvens.com.br"
```

### Outros
```
ALLOWLIST_TESTE = ["92982717586", "92994567328", "11946800329"]
ANO_PISO = 2026                    (trava do A4)
FIELDS_CACHE_TTL = 3600000 ms
kommoThrottle minGap = 150 ms (~6,6 req/s)
```

---

## 7. Pipelines e etapas no Kommo (TODOS — capturado via /discover 2026-06-23)

> O código **só usa o Funil de Captação**. Os outros dois existem na conta mas **nenhuma constante/lógica os referencia hoje**.

### Funil de Captação — `13847079` (ÚNICO usado no código)
| ID | Nome | No código? |
|---|---|---|
| 106848271 | Leads de entrada | — |
| 106848615 | primeiro contato | `STAGE_PRIMEIRO_CONTATO` |
| 106848619 | consulta agendada | `STAGE_CONSULTA_AGENDADA` |
| 107785399 | Confirmação de consulta | `STAGE_CONFIRMACAO_CONSULTA` |
| 106848623 | consulta confirmada | `STAGE_CONSULTA_CONFIRMADA` |
| 106848627 | avaliação realizada | `STAGE_AVALIACAO_REALIZADA` |
| 106848631 | tratamento proposto | `STAGE_TRATAMENTO_PROPOSTO` |
| 107789355 | Follow-up | — |
| 142 | tratamento fechado | — |
| 143 | Consulta cancelada – perdido | `STAGE_CANCELADA_PERDIDO` |

### Funil de Pós - Consulta — `13947295` (NÃO usado)
| ID | Nome |
|---|---|
| 107633735 | Etapa de leads de entrada |
| 107633739 | em análise |
| 107633747 | em Negociação |
| 107773799 | aguardando pagamento |
| 142 | Venda ganha |
| 143 | Venda perdida |

### Funil de Pós - Venda — `13950431` (NÃO usado; alvo da nova camada)
| ID | Nome |
|---|---|
| 107658903 | Etapa de leads de entrada |
| 107658907 | tratamento iniciado |
| 107658911 | cliente ativo |
| **107974651** | **confirmação de agendamento** ← destino retorno/encaixe/procedimento |
| 107658915 | cliente com saldo pendente |
| 107860123 | procedimento delicado |
| 107774015 | abandono de tratamento |
| 107774019 | cancelamento/ reembolso/ ocorrências |
| 107774023 | recorrência / manutenção |
| 142 | tratamento concluído |
| 143 | Venda perdida |

> Obs.: status `142`/`143` se repetem por pipeline (won/lost padrão do Kommo).

---

## 8. Campos customizados Kommo (resolvidos dinâmico via `resolveFields`)

| Nome | Tipo | Uso |
|---|---|---|
| `AGENDAMENTO` | date_time (ts Unix, exige NÚMERO) | data/hora da consulta (cópia local) |
| `ID Agenda CNN` | texto | ID numérico da agenda no CNN |
| `ID Paciente CNN` | texto | ID numérico do paciente no CNN |
| `PHONE` (field_code) | telefone | match por últimos 11 dígitos |

---

## 9. Webhooks (lado Kommo → Worker)

| Webhook | Rota | Gatilho esperado no Kommo |
|---|---|---|
| W1 | `POST /webhook/lead-agendado?secret=` | Lead movido p/ "consulta agendada" |
| W2 | `POST /webhook/confirmacao?secret=` | Salesbot: paciente confirmou no WhatsApp |

Payload lido: `leads[status][0][id]` (form-urlencoded).

---

## 10. Secrets e vars

### Secrets (`wrangler secret`)
| Secret | No `Env` (código)? | No setup-secrets.ps1? | Observação |
|---|---|---|---|
| `CNN_CID` | ✅ | ✅ | Token da clínica |
| `CNN_BASIC_USER` | ✅ | ✅ | Client ID API CNN |
| `CNN_BASIC_PASS` | ✅ | ✅ | Client Secret API CNN |
| `KOMMO_ACCESS_TOKEN` | ✅ | ✅ | Token long-lived Kommo |
| `WEBHOOK_SECRET` | ✅ | ✅ | Valida webhooks + `/test-workflow`/`/debug-*` |
| `KOMMO_CLIENT_SECRET` | ❌ (ainda) | ❌ | **NÃO é órfão — uso planejado.** Client Secret da integração OAuth2 do Kommo. Destino: módulo de **refresh automático de token** — em `401`, `POST /oauth2/access_token` com `{client_id, client_secret, grant_type:"refresh_token", refresh_token, redirect_uri}`, persistir novos tokens no D1 e refazer a chamada. Substitui a dependência do `KOMMO_ACCESS_TOKEN` long-lived (que expira/pode ser revogado). **Falta junto:** `KOMMO_CLIENT_ID`, `redirect_uri` e um `refresh_token` inicial guardado no D1. |

### Vars (`wrangler.toml [vars]`)
| Var | Valor |
|---|---|
| `KOMMO_SUBDOMAIN` | `atendimentoclinicabergmanncombr` |

### Binding
| Binding | Recurso |
|---|---|
| `DB` | D1 `kommo-cnn-db` |

---

## 11. APIs externas consumidas

### CNN (`https://api.clinicanasnuvens.com.br`)
Auth: `Authorization: Basic btoa(user:pass)` + header `clinicaNasNuvens-cid`.
Endpoints usados pelo código: `GET /info`, `GET /agenda/{id}`, `GET /agenda/lista`, `POST /agenda/novo`, `POST /agenda/{id}/remarcar`, `PUT /agenda/alteracao-status`, `GET /paciente/lista`, `GET /paciente/{id}`, `POST /paciente/novo`, `POST /convenio-paciente/associar`, `GET /convenio-paciente/lista`, `GET /plano-tratamento/lista`.

> Não usados ainda (relevantes p/ a nova camada): `GET /tipo-consulta/lista`, `GET /tipo-procedimento/lista`.

### Kommo (`https://{KOMMO_SUBDOMAIN}.kommo.com/api/v4`)
Auth: `Authorization: Bearer {KOMMO_ACCESS_TOKEN}`.
Endpoints: `GET /leads/{id}`, `GET /leads`, `PATCH /leads/{id}`, `POST /leads/complex`, `DELETE /leads/{id}`, `GET /contacts/{id}`, `GET /contacts`, `DELETE /contacts/{id}`, `GET /leads/custom_fields`, `GET /contacts/custom_fields`, `GET /leads/pipelines`.

---

## 12. Ambiente atual

| Item | Estado |
|---|---|
| Kommo | **PRODUÇÃO** real — **2.451 leads** (medido por etapa, 2026-06-24): Captação **2.450** (1.153 primeiro contato · 1.117 cancelada–perdido · 177 Incoming · 2 consulta agendada · 1 consulta confirmada), **Pós-Venda 1** (lead `18265606` em "Incoming leads" 107658903), Pós-Consulta 0. ⚠️ **Quirk:** `GET /leads` sem filtro EXCLUI leads "Incoming"/unsorted e não enumera por pipeline de forma confiável (deu 2.273, faltando 177+1). Contagem/varredura real exige `filter[statuses][0][pipeline_id]+[status_id]` **por etapa** + guarda no código. |
| CNN | **SANDBOX de teste** (~6 pacientes; base real ~30k NÃO conectada) |
| Cron ativo | geração legada **C1 + C2** |
| Funções A2/A3/A4 | no código + `/debug-*`, validadas em dry-run, **fora do cron** |
| Custo | Cloudflare plano free |

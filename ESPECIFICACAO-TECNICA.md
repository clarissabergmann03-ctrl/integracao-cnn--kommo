# Especificação Técnica Completa — Integração Kommo ↔ Clínica nas Nuvens

> **Arquivo:** `ESPECIFICACAO-TECNICA.md` · raiz do projeto `kommo-cnn`
> **Atualizado:** 2026-06-27
> **Fonte da verdade do código:** `src/index.ts` (2.595 linhas, arquivo único deployado)
> **Worker em produção:** `https://kommo-cnn.clarissabergmann03.workers.dev`
> **Conta Cloudflare:** Clarissabergmann03 (`4be8e1b3bbf4d7074f665e77fd6dca2d`)

Este documento descreve **o porquê de cada decisão**, a **história** (arquitetura anterior → atual),
e uma **especificação técnica exaustiva** de credenciais, código, tabelas, endpoints, regras de
negócio e quirks de API. Começa por uma página de resumo.

---

# PARTE 0 — PÁGINA DE RESUMO (TL;DR)

**O que é:** um Cloudflare Worker (+ banco D1) que mantém o CRM **Kommo** sincronizado com o sistema
de agendas da clínica **Clínica nas Nuvens (CNN)**. Custo zero (plano free), uso comercial.

**O que faz, em uma frase:** lê as agendas do CNN, garante que cada paciente ativo tenha um card no
Kommo no funil certo, move os cards conforme o status da consulta muda no CNN, e na véspera move o
lead para a etapa de confirmação (que dispara o WhatsApp).

**As 4+2 funções:**
- **A1 / W1** — secretária agenda no Kommo → Worker cria paciente+agenda no CNN (webhook). *(escreve no CNN — bloqueado em produção)*
- **W2** — paciente confirma no WhatsApp → Worker marca `CONFIRMADO_PACIENTE` no CNN e move o lead. *(escreve no CNN — bloqueado em produção)*
- **A2** — mudança de hora no Kommo → propaga pro CNN (`/remarcar`). *(escreve no CNN — bloqueado em produção)*
- **A3** — mudança de status/hora no CNN → reflete no Kommo (move etapa). *(CNN→Kommo, ativo)*
- **A4** — backfill: paciente do CNN sem card → cria/vincula card no Kommo. *(CNN→Kommo, ativo)*
- **F2** — véspera (15h BRT): move leads com consulta amanhã para a etapa de confirmação. *(CNN→Kommo, ativo)*

**Roteamento por tipo de atendimento (CNN):**
- **Grupo A** = `Atendimento Social` ou `Consulta/Avaliação` → Funil de **Captação**.
- **Grupo B** = `Retorno`, `Encaixe`, `Procedimento`, `Cirurgia`, `Pequenas Cirurgias`, `Cortesia`, `Encaminhamento - INTERNO` → Funil de **Pós-Venda**.
- Tipo desconhecido → **não faz nada**.

**Arquitetura atual (a nova):** **fila de trabalho em D1** + **cron de 1 minuto**. Um *produtor*
enfileira unidades de trabalho (1 por agenda/paciente); *consumidores* puxam lotes pequenos (~10)
e processam. Resolve o gargalo do plano free (**50 sub-requests/invocação**) diluindo a carga em
muitas micro-invocações.

**Estado em 2026-06-27:**
- Backfill **concluído**: 350 pacientes mapeados, 52 cards criados (20 Captação + 32 Pós-Venda), 0 erros.
- A3 e F2 implementados e validados em dry-run.
- **O cron ainda roda o código LEGADO (C1/C2)** — o "flip" para a fila ainda não foi feito (aguarda OK).

**Restrição inegociável:** custo zero. Por isso Cloudflare Workers Free (uso comercial permitido),
**não** Vercel (Hobby proíbe uso comercial).

**Regra de segurança nº1 (§7.8):** a chave de **produção** do CNN é **somente leitura**. Nenhum
`POST/PUT/DELETE` no CNN de produção até liberação explícita. Imposto por código (`assertCnnWritable`).

---

# PARTE 0.5 — ENTENDA DO ZERO (leia isto se você nunca viu o projeto)

> Esta seção não presume nenhum conhecimento prévio. Cada termo é explicado quando aparece pela
> primeira vez. Se algo parece óbvio, está escrito mesmo assim **de propósito**.

## 0.5.1 O que são os dois sistemas que estamos ligando

- **Clínica nas Nuvens (CNN):** é o software que a clínica usa para marcar consultas — a "agenda" da
  clínica. Cada consulta marcada é o que chamamos de **agenda** (ou "agendamento"). Cada paciente tem
  um cadastro lá (nome, telefone, etc.). O CNN tem uma **API** (explicada abaixo) que permite a um
  programa **ler** e **escrever** dados nele.

- **Kommo:** é um **CRM**. CRM = "Customer Relationship Management" = um programa onde a empresa
  organiza seus contatos/clientes em **funis de venda**. Pense num quadro estilo Trello: colunas
  (etapas) e cartões (clientes) que andam de uma coluna para a outra conforme avançam no processo.
  No Kommo, cada cartão é um **lead** (ou "card"). O Kommo também tem **API**.

**O problema:** os dois sistemas não conversam. Um paciente marcado no CNN não vira automaticamente um
cartão no Kommo, e quando a consulta muda (confirma, cancela, termina) o cartão no Kommo não acompanha.
Nosso programa é a "ponte" que mantém os dois em sincronia.

## 0.5.2 Vocabulário de CRM/Kommo (o quadro de cartões)

- **Funil (pipeline):** um quadro com etapas em sequência. A clínica tem 2 funis que usamos:
  **Captação** (paciente novo/consulta) e **Pós-Venda** (cliente que já faz procedimentos).
- **Etapa (status/stage):** uma coluna dentro do funil. Ex.: "Consulta Agendada", "Confirmação de
  consulta", "Cliente Ativo".
- **Lead / card:** o cartão de uma pessoa, que vive **dentro de uma etapa de um funil**.
- **Mover de etapa:** arrastar o cartão de uma coluna para outra. No nosso código isso é uma chamada
  de API (`PATCH`) que muda o `status_id` (etapa) e o `pipeline_id` (funil) do lead.
- **Campo customizado:** um campo extra no cartão. Usamos três: `AGENDAMENTO` (data/hora da consulta),
  `ID Agenda CNN` (o número da agenda lá no CNN) e `ID Paciente CNN` (o número do paciente lá no CNN).
  Eles "amarram" o cartão do Kommo à consulta/paciente do CNN.

## 0.5.3 Vocabulário de programação/web (o mínimo para entender o resto)

- **API:** é a "porta de entrada programável" de um sistema. Em vez de um humano clicar na tela, um
  programa manda mensagens pela internet pedindo dados ou pedindo para mudar algo.
- **Endpoint:** um endereço específico dessa porta. Ex.: `/agenda/lista` (no CNN) é o endpoint que
  devolve a lista de consultas. Cada endpoint faz uma coisa.
- **Métodos HTTP:** o "verbo" do pedido. **GET** = ler (não muda nada). **POST** = criar.
  **PUT/PATCH** = alterar. **DELETE** = apagar. **Ler é seguro; criar/alterar/apagar muda dados.**
- **Request / Response:** o pedido que mandamos e a resposta que recebemos (normalmente em **JSON**,
  um formato de texto estruturado).
- **`fetch`:** o comando, dentro do nosso programa, que dispara um request pela internet. **Cada
  `fetch` conta como uma "sub-requisição"** (importante mais à frente).
- **Webhook:** o contrário do nosso programa pedir dados — é o **outro sistema** que **avisa o nosso**
  quando algo acontece. O Kommo manda webhooks (ex.: "um lead mudou de etapa"). O CNN **não** manda
  webhooks — por isso, para saber o que mudou no CNN, nosso programa tem que **perguntar de tempos em
  tempos** (isso se chama *polling*).

## 0.5.4 Onde o nosso programa roda: Cloudflare Worker

- **Cloudflare Worker:** um lugar na internet (da empresa Cloudflare) onde a gente publica um pequeno
  programa que fica disponível 24h. Não precisamos de servidor próprio. Ele acorda de dois jeitos:
  (1) quando alguém chama um endereço dele (HTTP), e (2) sozinho, em horários marcados (**cron**).
- **Cron:** um agendador. "Rodar a cada 1 minuto" é um cron. Cada vez que o cron dispara e o programa
  roda, chamamos de **tick** (uma "batida").
- **Invocação:** uma execução do programa (seja por HTTP, seja por um tick do cron).
- **D1:** um **banco de dados** (tipo uma planilha com tabelas) que a Cloudflare oferece junto do
  Worker. É a "memória" do nosso programa — onde ele anota o que já fez.
- **Plano free (grátis):** estamos no plano gratuito da Cloudflare. Ele tem um limite importante:
  **no máximo 50 `fetch` (sub-requisições) por invocação.** Ou seja, em **uma única execução**, o
  programa só pode falar com o CNN/Kommo 50 vezes. Se passar disso, a execução é cortada com erro.
  Esse limite é o centro de quase todas as decisões de arquitetura. (Falar com o D1 **não** conta
  nesse limite — testamos.)

## 0.5.5 Conceitos da nossa solução (explicados sem jargão)

- **Sincronizar:** manter os dois sistemas com a mesma informação. Se a consulta foi cancelada no CNN,
  o cartão no Kommo precisa refletir isso.
- **Backfill:** "preencher para trás" — pegar os pacientes que **já existem** no CNN e garantir que
  cada um tenha seu cartão no Kommo. É uma carga inicial, feita uma vez.
- **Idempotente / idempotência:** uma ação que, se repetida, **não causa efeito duplicado**. Ex.:
  se o programa rodar duas vezes, ele **não** cria dois cartões para o mesmo paciente nem manda dois
  lembretes. Conseguimos isso anotando no D1 o que já foi feito e checando antes de agir.
- **Baseline ("linha de base"):** a **primeira vez** que o programa vê uma consulta, ele só **anota o
  estado atual** dela (sem mover nada). Assim, nas próximas vezes, ele compara com essa anotação e só
  age se **mudou**. Isso evita uma "movimentação em massa" no primeiro dia.
- **Eco / loop:** quando o próprio programa muda algo e isso o faz "achar" que houve uma mudança
  externa, agindo de novo em cima da própria ação — um laço sem fim. O baseline evita isso.
- **dry-run ("ensaio"):** rodar o programa em modo de teste, onde ele **calcula tudo mas não escreve
  nada**. Serve para ver o que *aconteceria* sem risco.
- **Sandbox vs Produção:** **sandbox** é o ambiente de testes do CNN (poucos pacientes, pode escrever
  à vontade). **Produção** é a clínica de verdade (dados reais). Regra de ouro: na produção do CNN o
  programa **só lê, nunca escreve** (ver Parte 3.3) — para não bagunçar dados reais por engano.
- **Fila de trabalho (work queue):** uma lista de tarefas guardada no D1. Em vez de tentar fazer tudo
  numa execução só (e estourar o limite de 50), o programa **anota as tarefas** numa fila e vai
  processando **poucas por vez**, a cada minuto. Quem anota é o **produtor**; quem executa é o
  **consumidor**.

## 0.5.6 O que o sistema faz, em uma narrativa simples

1. A cada minuto o programa acorda (cron/tick).
2. De vez em quando ele **olha a agenda do CNN** (lê as consultas dos próximos dias) e **anota tarefas**
   numa fila no D1: "fulano precisa de cartão", "a consulta X mudou de status", "amanhã o paciente Y
   tem consulta".
3. Todo minuto ele **pega algumas tarefas da fila** e executa no Kommo: cria/atualiza cartões, move de
   etapa, etc. — sempre poucas por vez, para nunca passar de 50 chamadas numa execução.
4. Ele anota no D1 tudo que fez, então **nunca repete** (não cria cartão duplicado, não manda lembrete
   duas vezes).
5. Regras de negócio decidem **para qual funil** cada paciente vai (Captação ou Pós-Venda), conforme o
   **tipo** da consulta no CNN, e **quando** mover para a etapa de confirmação (na véspera, às 15h).

## 0.5.7 Por que tudo isso é tão "cheio de cuidado"

Porque o sistema mexe em **dados reais de uma clínica** (pacientes de verdade). Um erro pode mover
centenas de cartões errados ou criar duplicatas. Por isso há tantas travas: rodar em modo ensaio
antes, processar pouco por vez, anotar tudo, nunca escrever na produção do CNN sem autorização, e
conferir com o dono antes de cada passo que muda dados.

---

# PARTE 1 — GLOSSÁRIO E NOMENCLATURA

A nomenclatura evoluiu ao longo do projeto. Mapa definitivo:

| Sigla | Nome no código | Direção | O que faz | Status produção |
|---|---|---|---|---|
| **A1 / W1 / Função 1** | `handleLeadAgendado` | Kommo→CNN | Webhook: lead movido p/ "Consulta Agendada" → cria paciente + agenda no CNN, grava IDs de volta | ⛔ escreve CNN (bloqueado) |
| **W2** | `handleConfirmacao` | Kommo→CNN | Webhook (Salesbot): paciente confirmou → `CONFIRMADO_PACIENTE` no CNN + move lead p/ Consulta Confirmada | ⛔ escreve CNN (bloqueado) |
| **A2** | `syncKommoParaCnn` | Kommo→CNN | Delta por cursor `updated_at`: hora mudou no Kommo → `/remarcar` no CNN | ⛔ escreve CNN (bloqueado) |
| **A3** | `syncCnnParaKommo` (legado) / `produtorSync`+`consumirItemA3` (fila) | CNN→Kommo | Status/hora mudou no CNN → reflete no Kommo (move etapa por grupo) | ✅ ativo |
| **A4 / Função 5** | `backfillCadastros` (legado) / `produtorBackfill`+`consumirItemA4` (fila) | CNN→Kommo | Paciente do CNN sem card → cria/vincula no Kommo | ✅ ativo |
| **F2 / Função 2** | `cronVespera` (legado) / `produtorVespera`+`consumirItemF2` (fila) | CNN→Kommo | Véspera 15h BRT: move leads com consulta amanhã p/ etapa de confirmação | ✅ ativo |
| **C1** | `cronLembreteD1` | — | **Legado**. Versão antiga da véspera (tinha o bug do filtro). Ainda no cron até o flip. | ⚠️ legado |
| **C2** | `cronSyncStatus` | CNN↔Kommo | **Legado**. Sync antigo (sem roteamento por tipo). Ainda no cron até o flip. | ⚠️ legado |

**Outros termos:**
- **CNN** = Clínica nas Nuvens (sistema de agendas; **não emite webhooks** → lado CNN→Kommo é polling).
- **Kommo** = CRM (funis/etapas; **emite webhooks**; API v4).
- **Worker** = Cloudflare Worker (HTTP + cron) que hospeda toda a lógica.
- **Lead/card** = registro no Kommo, vive num funil (pipeline) e numa etapa (status).
- **Agenda** = consulta no CNN.
- **Ledger** = banco D1 do Worker (mapeamento, baseline, idempotência, auditoria, fila).
- **Baseline** = 1ª vez que o Worker vê uma agenda: registra o estado, NÃO move etapa (evita movimento em massa).
- **Sub-request** = chamada externa via `fetch` (CNN/Kommo). Limite free: **50 por invocação**.
- **Produtor/Consumidor** = padrão da fila: o produtor enfileira unidades de trabalho em D1; o
  consumidor puxa e processa. Desacopla "descobrir o que fazer" de "fazer".
- **Tick** = uma execução do `scheduled()` (uma vez por minuto pós-flip).
- **Grupo A / Grupo B** = classificação da agenda pelo tipo de atendimento (A→Captação, B→Pós-Venda).
- **Desempate B-ganha** = paciente com agenda A e B no mesmo dia vai para B (Pós-Venda).

## 1.1 Walkthrough passo-a-passo de cada fluxo

### A1 / W1 — `handleLeadAgendado` (Kommo→CNN, webhook) ⛔ escreve CNN
**Gatilho:** `POST /webhook/lead-agendado?secret=…` quando a secretária move um lead para "Consulta
Agendada" no Kommo (webhook configurado no Kommo).
**Passos:**
1. Valida `?secret` (`webhookAuthOk`). Parseia `x-www-form-urlencoded` → `leads[status][0][id]`.
2. `resolveFields` → ids de `AGENDAMENTO`, `ID Agenda CNN`, `ID Paciente CNN`.
3. `GET /leads/{id}?with=contacts`. **Se `ID Agenda CNN` já preenchido → retorna `already_synced`** (idempotência §7.3).
4. Lê `AGENDAMENTO` (ts), converte p/ data+hora BRT; lê contato (nome, telefone, nascimento).
5. Acha/cria paciente no CNN (`/paciente/lista?nomeContem` → senão `/paciente/novo`).
6. `getOrCreateConvenioParticular` (convênio obrigatório no `/agenda/novo`).
7. `POST /agenda/novo` (30 min de duração) → recebe `agenda.id`.
8. `setLeadFields` grava `ID Agenda CNN` + `ID Paciente CNN` no lead; `setSyncedTs`.
**Saída:** `{ok, idAgenda, idPaciente}`. **Bloqueado em produção** (passos 5-7 escrevem no CNN).

### W2 — `handleConfirmacao` (Kommo→CNN, webhook) ⛔ escreve CNN
**Gatilho:** `POST /webhook/confirmacao?secret=…` — o Salesbot do Kommo dispara quando o paciente
confirma pelo WhatsApp.
**Passos:** lê `ID Agenda CNN` do lead → `PUT /agenda/alteracao-status {status: CONFIRMADO_PACIENTE}`
→ `moveLeadToStage(STAGE_CONSULTA_CONFIRMADA)`. **Bloqueado em produção** (PUT no CNN).

### A2 — `syncKommoParaCnn` (Kommo→CNN, delta) ⛔ escreve CNN
**Gatilho:** cron (no futuro, quando escrita CNN liberada). **Hoje inerte em produção.**
**Passos:**
1. Lê cursor `kommo_updated_at` (default: agora−1h). `GET /leads?filter[updated_at][from]={cursor}` paginado.
2. Para cada lead com `ID Agenda CNN` + `AGENDAMENTO`: compara o ts do Kommo com `agenda_sync.last_agendamento_ts`.
3. 1ª vez vendo a agenda → **baseline** (grava estado, não remarca → suprime eco da própria escrita).
4. Se a data divergiu (>60s) → `POST /agenda/{id}/remarcar` (CNN prevalece via last-writer-wins).
5. Avança o cursor com margem de 120s (não perde edições na borda).

### A3 — sync CNN→Kommo (`produtorSync` + `consumirItemA3`) ✅ ativo
**Gatilho:** cron (produtorSync a cada 10 min; consumidores todo tick).
**Produtor:** coleta agendas da janela (−2/+14d), carrega `agenda_sync` e `mapeamento` em massa (1 query
cada). Para cada agenda de paciente **mapeado** cujo `status`/`ts` divergiu do baseline → enfileira item
`A3:ag:<id>:<status>:<tsBucket>` (a chave muda quando o status muda → re-enfileira). Sem fetch além da paginação.
**Consumidor (1 item):**
- Acha o lead (payload traz `leadId`).
- **Baseline (1ª vez):** seta `AGENDAMENTO` com a hora do CNN, grava `agenda_sync`, **NÃO move etapa**.
- **Hora mudou** (>60s vs baseline): se o lead estava na etapa de **confirmação** do grupo → volta p/
  a etapa-base (reabre o fluxo); atualiza `AGENDAMENTO`.
- **Status mudou** (transição): `moveLeadToStage(destinoStatus(grupo, status))` — ex.: FINALIZADO→Avaliação
  Realizada (A) / Cliente Ativo (B); CANCELADO→Cancelada-Perdido (A) / Cliente Ativo (B).
- Atualiza `agenda_sync` com o novo estado.

### A4 — backfill CNN→Kommo (`produtorBackfill` + `consumirItemA4`) ✅ ativo
**Gatilho:** cron (produtorBackfill a cada 30 min; consumidores todo tick) + execução manual via `/debug-tick`.
**Produtor:** coleta a janela; **agrupa por paciente** escolhendo o **grupo vencedor (B-first)**; carrega
o set de mapeados (1 query); enfileira `A4:pac:<id>` só dos **não-mapeados**, em lote (DB.batch).
**Consumidor (1 item):**
- Re-checa anti-ressurreição (`getMapeamentoByPaciente`); se já mapeado → `ja_mapeado`.
- Lookup do lead por telefone (match §7.1). **Se existe lead → vincula** (`upsertMapeamento`), não cria card.
- **Se não existe → cria card** (`POST /leads/complex`) no pipeline do grupo (A→Consulta Agendada / B→Cliente
  Ativo), com `AGENDAMENTO`/`ID Agenda CNN`/`ID Paciente CNN` + contato; grava `mapeamento` + `agenda_sync`;
  audita `card-criado`.

### F2 — véspera (`produtorVespera` + `consumirItemF2`) ✅ ativo
**Gatilho:** cron às 15h BRT (18h UTC).
**Produtor:** coleta agendas de **amanhã**; filtra interna/tipo/status-terminal; acha o lead (mapas em
massa); **dedup B-first por lead**; pula quem já tem `lembrete_d1` hoje; enfileira `F2:lead:<leadId>:<data>`.
**Consumidor (1 item):** re-checa `leadJaLembradoNaData`; `moveLeadToStage(VESPERA_DESTINO[grupo])`
(A→Confirmação de consulta / B→confirmação de agendamento); `registrarLembrete`.

### C1 / C2 — legado (ainda no cron)
`cronLembreteD1` (véspera antiga, com o bug do filtro) e `cronSyncStatus` (sync antigo sem roteamento).
Saem do `scheduled()` no flip.

---

# PARTE 2 — CONTEXTO, HISTÓRIA E O PORQUÊ DE CADA DECISÃO

## 2.1 O problema de negócio

A clínica (estética/dermatologia, ~50 atendimentos/dia úteis, vários profissionais, 9h-19h) usa o
**CNN** para agendas e o **Kommo** como CRM/funil comercial. Sem integração, os dois sistemas vivem
desconectados: pacientes do CNN não têm card no Kommo, mudanças de consulta não refletem no funil,
e a confirmação de véspera (WhatsApp via Salesbot do Kommo) não dispara de forma confiável.

## 2.2 A arquitetura ANTERIOR (legado C1/C2) e por que falhou

A 1ª geração era baseada em dois crons:
- **C1 (`cronLembreteD1`)** — diário às 15h BRT, movia leads com consulta amanhã para "Confirmação".
- **C2 (`cronSyncStatus`)** — a cada 10 min, sync de hora/status + backfill por telefone.

**Problemas que motivaram a reescrita:**

1. **Bug do filtro Kommo (incidente dos 20 leads).** O C1 usava `filter[status_id]=X`, que o Kommo
   **ignora silenciosamente** e retorna leads aleatórios da conta inteira. Com >2.000 leads e o
   filtro ignorado, processava os 200 primeiros (nenhum de amanhã). Pior: um lead com `ID Agenda CNN`
   de uma agenda **CANCELADA** foi movido para "Confirmação" mesmo cancelado — porque o C1 validava a
   **cópia local** do campo `AGENDAMENTO` no Kommo, nunca reconsultava o CNN.
   → **Lição:** validar contra a fonte (CNN), nunca confiar só no cache local. (§7.5 do escopo mãe.)

2. **Sem roteamento por tipo.** O legado só conhecia **um** pipeline (Captação). A regra real exige
   rotear por tipo de atendimento: Social/Consulta → Captação; Retorno/Encaixe/Procedimento → Pós-Venda.
   Isso não existia.

3. **Sem idempotência robusta.** A "não-repetição" do C1 dependia só da etapa atual do lead; um reset
   de remarcação re-armava o lembrete e movia de novo. Faltava um log de idempotência.

4. **Sem tratamento do volume.** O C2 lia janelas grandes sem paginação correta e estourava o tempo.

## 2.3 Decisões de plataforma

**Por que Cloudflare Workers (e não Vercel):**
- Restrição inegociável: **custo zero** + uso **comercial** (clínica real).
- Vercel Hobby (free) **proíbe uso comercial** nos termos → risco de takedown no meio da operação.
- Cloudflare Workers free **permite uso comercial** → ficamos no Cloudflare, sem custo, dentro dos termos.

**O gargalo real (descoberto empiricamente):** não é requisições/dia (usamos ~1,4% de 100k). É o
**teto de 50 sub-requests (`fetch`) por invocação**. Capturado com o erro literal
`"Too many subrequests by single Worker invocation"` na 50ª chamada. **D1 NÃO conta** nesse teto
(testado: 200 queries D1 OK no mesmo invocação; `fetch` estoura em 50).

## 2.4 A arquitetura ATUAL (a nova): fila-em-D1 + cron de 1 min

**Por que mudamos do "cursor + lote" para "fila-em-D1":**
- A 1ª tentativa de escalar foi um **cursor de offset** (`a3_offset`/`a4_offset`) processando um lote
  por tick. Funcionava, mas: (a) espremia tudo no recurso **escasso** (50 fetch/invocação) enquanto o
  recurso **abundante** (1.440 invocações/dia) ficava ocioso; (b) o offset numa lista que **muda entre
  ticks** (agendas criadas/canceladas durante o dia) era frágil — podia pular itens.
- **Solução:** diluir a carga em **muitas micro-invocações** usando D1 como **fila de trabalho**.
  O cron de 1 min é o orquestrador; cada tick faz pouquíssimos fetches → nunca chega perto de 50.

**As 3 peças que fazem funcionar juntas:**
1. **Cron de 1 minuto** — 1.440 oportunidades/dia de processar (1,4% do teto diário).
2. **Fila em D1** (`fila_trabalho`) — 1 linha = 1 unidade de trabalho; produtor enfileira, consumidor
   puxa lote pequeno e marca feito/erro. Substitui o cursor frágil por estado durável e idempotente.
3. **Orçamento por invocação** — contador global de `fetch` (`subreqUsados`); para em ~40-45 (margem
   sob 50) e deixa o resto pra próxima invocação.

**Cancelados também houve uma decisão (Cloudflare Queues está fora):** Cloudflare Queues resolveria
isso nativamente, mas é **plano pago** → fora da restrição de custo zero. Por isso a fila é feita à
mão em D1 (que é free).

## 2.4.1 A jornada empírica até a fila (o que foi medido, não suposto)

A arquitetura de fila não foi escolhida no papel — foi resultado de medições ao vivo:

1. **Descoberta do teto.** Um endpoint de diagnóstico (`/debug-nomes?force=1`) fez chamadas `fetch`
   em loop e **estourou exatamente na 50ª** com `Too many subrequests by single Worker invocation`.
   → confirmou empiricamente o limite de 50 `fetch`/invocação no plano free.
2. **D1 não conta.** `/debug-d1cost` rodou **200 queries D1 em sequência sem erro** + um loop de fetch
   que estourou em 50. → D1 é "grátis" no orçamento; só `fetch` conta. Isso definiu o tamanho do lote.
3. **Custo por item medido.** Um tick dry mediu ~1,4 `fetch`/item (vincular = 1 lookup; criar = lookup
   + nome + create ≈ 3). → lote de ~10-12 itens fica em ~30 fetch, folgado sob 50.
4. **Gargalo de latência D1 (não de fetch).** O 1º produtor levou **102 s** porque fazia 314 leituras
   D1 **sequenciais** (`getMapeamentoByPaciente` por paciente) + 314 inserts sequenciais. Otimização:
   carregar mapeados em **1 query** (`getMapeamentoIdSet`) + inserir em **lote** (`DB.batch`) →
   caiu para **~13 s**. Lição: D1 não conta no teto de fetch, mas **round-trips sequenciais** matam o tempo.
5. **Fragilidade do cursor.** A 1ª tentativa de escala usou offset (`a3_offset`); observou-se que a
   lista de agendas do CNN **muda entre ticks** (encaixes/cancelamentos durante o dia) → o offset
   apontava para agenda diferente e podia **pular itens**. A fila (chave por agenda/paciente +
   idempotência) eliminou essa classe de bug.

## 2.4.2 Diagnóstico dos 5 problemas relatados (e a causa-raiz real)
Durante a investigação do preview de backfill, 5 sintomas foram reportados; a investigação mostrou que
**três eram o mesmo bug**:
- **"CNN XXXX" / pacientes "sumindo" (#2/#3/#4):** NÃO era rate-limit do CNN nem outra unidade. Era o
  **teto de 50 sub-requests**: o preview fazia nome+lead por agenda (~2 fetch × 50 agendas = ~100) →
  tudo após a 50ª chamada falhava → nome caía para "CNN <id>" **e** o lead não era achado (mostrava
  "criar" quando era "vincular"). Prova: dia leve (28 agendas) = 0 falhas; dia cheio (48) = falhas que
  **variavam** entre rodadas. Correção: **2-pass** (nomes só-CNN, separado dos leads), cada um < 50.
  Na arquitetura final, a fila resolve por construção (poucos fetch/tick).
- **Tarefas internas (#1):** "Acompanhar TNI", "Acompanhar Doutor Julio" etc. são agendas com
  **telefone falso** `(51) 11111-1111`. O dump cru confirmou: `idRotulo` é **sempre null** (não serve),
  tipo/local/executor são reais. Único sinal confiável = telefone → `isTarefaInterna`.
- **Cancelados (#5):** Grupo B cancelado → Cliente Ativo (cliente segue ativo); Grupo A cancelado →
  Cancelada-Perdido.

## 2.5 Regras de negócio que foram refinadas no caminho (com o dono)

- **Roteamento (corrigido 2×):** primeiro era "Social→Captação / resto→Pós-Venda"; refinado para
  Grupo A = {Atendimento Social, Consulta/Avaliação}, Grupo B = todo o resto conhecido, desconhecido = nada.
- **Atendimento Social só existe em produção** (não no sandbox) → roteamento é **por nome** resolvido
  em runtime, nunca por ID fixo (IDs diferem entre ambientes).
- **Desempate B-ganha:** paciente com agenda Grupo A **e** B no mesmo dia → vai para **B** (Pós-Venda).
  Resolvido **no produtor** (escolhe o grupo vencedor por paciente antes de enfileirar).
- **Cancelados:** Grupo A cancelado → "Cancelada–Perdido"; Grupo B cancelado → "Cliente Ativo"
  (cliente segue ativo mesmo com procedimento cancelado).
- **Tarefas internas** (bloqueio de agenda, "Acompanhar Dr X", pausa) entram no CNN como agendas com
  **telefone falso** (`(51) 11111-1111`). Filtradas por `isTarefaInterna` (telefone ≤2 dígitos
  distintos / <10 dígitos / vazio). `idRotulo` é sempre null (não serve de sinal — confirmado no dump cru).
- **"Uma vez só" no D-1:** idempotência por **lead + DATA** (`lembrete_d1`) — remarcar para outra data
  re-dispara; mesma data, não repete.

---

# PARTE 3 — CREDENCIAIS, SECRETS E AMBIENTES

## 3.1 Ambientes

| Sistema | Ambiente | Observação |
|---|---|---|
| **Kommo** | **PRODUÇÃO** (única conta) | subdomínio `atendimentoclinicabergmanncombr`; ~2.451 leads |
| **CNN** | **sandbox** (CID de teste) + **produção** (CID real) | sandbox ~6 pacientes / tipos genéricos; produção é a clínica real |

O Worker fala com **um Kommo** (produção) e com **dois CNN** (sandbox e produção), selecionados pelo
parâmetro `target: "sandbox" | "production"`.

## 3.2 Secrets (Cloudflare `wrangler secret`)

| Secret | Uso | Pode escrever? |
|---|---|---|
| `CNN_CID` | Token da clínica — CNN **sandbox** | sim (allowlist) |
| `CNN_BASIC_USER` | Client ID API CNN sandbox | — |
| `CNN_BASIC_PASS` | Client Secret API CNN sandbox | — |
| `CNN_CID_PRODUCTION` | Token da clínica — CNN **produção** | **NÃO (§7.8 só leitura)** |
| `CNN_BASIC_USER_PRODUCTION` | Client ID API CNN produção | **NÃO** |
| `CNN_BASIC_PASS_PRODUCTION` | Client Secret API CNN produção | **NÃO** |
| `KOMMO_ACCESS_TOKEN` | Bearer token long-lived do Kommo | sim |
| `WEBHOOK_SECRET` | Valida webhooks (`?secret=`) e endpoints de debug (`Authorization:`) | — |
| `KOMMO_CLIENT_SECRET` | **Uso planejado** (ainda não no código): refresh OAuth2 do token Kommo | — |

**Token Cloudflare (deploy):** `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID=4be8e1b3bbf4d7074f665e77fd6dca2d`.
O token é restrito por IP (rotaciona no ambiente de dev → às vezes recusa; resolver afrouxando a
restrição ou deployando da máquina do dono).

**Comando de deploy:**
```bash
export CLOUDFLARE_API_TOKEN="<token>"
export CLOUDFLARE_ACCOUNT_ID="4be8e1b3bbf4d7074f665e77fd6dca2d"
cd kommo-cnn && npx wrangler deploy src/index.ts
```

## 3.3 A regra §7.8 (segurança inviolável)

> O CNN **não tem chave só-leitura**: a mesma credencial lê e escreve. Logo, com a chave
> `_PRODUCTION`, **SÓ leitura (`GET`)**. Nunca `POST/PUT/DELETE` até liberação explícita.

**Imposição por código:** `assertCnnWritable(target, method, path)` lança erro se `target==="production"`
em `cnnPost`/`cnnPut`. Não depende do comportamento do agente — é impossível por construção. Por isso
A1/W1, W2 e A2 (que escrevem no CNN) ficam **inertes em produção** até liberação.

---

# PARTE 4 — ARQUIVOS DO PROJETO

```
D:\clarissa-bergmann\
  novo arquivo mae escopo.md          ← especificação de objetivo (o que DEVE ser); v1.1
  api-clinica-nas-nuvens.md           ← doc da API CNN (Swagger anexo)
  kommo-cnn\
    src\
      index.ts        ← Worker de produção — ÚNICO arquivo deployado (2.595 linhas)
      stub.ts         ← script de diagnóstico, NÃO deployado
    wrangler.toml     ← config (binding D1, vars, crons)
    package.json, tsconfig.json
    setup-secrets.ps1 ← helper interativo p/ cadastrar secrets
    INVENTARIO.md     ← snapshot do estado (regra §7.8, quirks, contagens)
    TESTES.md         ← backlog de testes T0–T7 (geração legada)
    ESPECIFICACAO-TECNICA.md  ← este arquivo
    backfill-preview-*.csv, IMPORTACAO-segunda-*.csv ← prévias geradas p/ conferência
```

### `wrangler.toml` (atual)
```toml
name = "kommo-cnn"
main = "src/index.ts"
compatibility_date = "2025-06-08"
[[d1_databases]]
binding = "DB"
database_name = "kommo-cnn-db"
database_id = "158f672c-1589-439d-b550-8917f424c3ab"
[vars]
KOMMO_SUBDOMAIN = "atendimentoclinicabergmanncombr"
[triggers]
crons = ["0 18 * * *", "*/10 * * * *"]   # LEGADO — vira ["* * * * *"] no flip
```

### `interface Env` (binding/secrets que o código espera)
```ts
DB: D1Database
CNN_CID, CNN_BASIC_USER, CNN_BASIC_PASS                          // sandbox
CNN_CID_PRODUCTION, CNN_BASIC_USER_PRODUCTION, CNN_BASIC_PASS_PRODUCTION  // produção (só leitura)
KOMMO_ACCESS_TOKEN, KOMMO_SUBDOMAIN, WEBHOOK_SECRET
```

---

# PARTE 5 — ESPECIFICAÇÃO DO CÓDIGO (`src/index.ts`, por blocos)

> Convenção: nº de linha aproximado (o arquivo muda). Agrupado por responsabilidade.
>
> **Como ler esta parte:** o código é um arquivo só (`src/index.ts`). Ele é dividido em "blocos" de
> funções com propósitos diferentes. Abaixo, cada bloco é descrito. Alguns termos:
> - **função:** um pedacinho de código com nome, que faz uma tarefa específica e pode ser "chamado".
> - **wrapper ("embrulho"):** uma função que envolve outra para adicionar comportamento. Ex.: nossos
>   "wrappers de fetch" envolvem o comando `fetch` para, antes de cada chamada, contar quantas já foram.
> - **helper ("ajudante"):** função utilitária pequena reusada em vários lugares.
> - **cache:** uma cópia guardada temporariamente para não buscar a mesma coisa toda hora.
> - **TTL ("time to live"):** por quanto tempo o cache vale antes de ser buscado de novo (ex.: 1 hora).
> - **módulo-global:** uma variável que existe "fora" das funções e é compartilhada por todas elas.

## 5.1 Orçamento de sub-requests (teto free = 50 fetch/invocação)
**Em linguagem simples:** como só podemos fazer 50 chamadas de internet por execução, mantemos um
**contador** de quantas já fizemos e paramos antes de chegar em 50.
- `subreqUsados` — o contador (variável módulo-global). `resetSubreq()` zera. `bumpSubreq()` soma +1.
  `orcamentoOk(max=45)` responde "ainda posso fazer mais chamadas?" (verdadeiro se o contador < 45).
- `bumpSubreq()` é chamado dentro de **todos os 7 wrappers de fetch** (as 7 funções que falam com
  CNN/Kommo), então **toda** chamada de internet é contada automaticamente.
- **Reset obrigatório** no início de cada execução (`scheduled()` e `/debug-tick`): como o contador é
  compartilhado e "sobrevive" entre execuções na mesma máquina, sem zerar ele somaria pra sempre.

## 5.2 Roteamento por tipo (resolução por NOME, runtime)
**Em linguagem simples:** "rotear" = decidir para qual funil mandar o paciente. Decidimos pelo **tipo
da consulta** no CNN. Como o tipo é identificado por um número (`idTipoConsulta`) que **é diferente
entre o ambiente de teste e o de produção**, não dá para "chumbar" o número no código — em vez disso,
o programa **pergunta ao CNN o nome de cada tipo** ("Atendimento Social", "Retorno"…) e decide pelo
**nome** (isso é "resolução por nome em tempo de execução / runtime").
- `normNome(s)` — minúsculas, sem acento, espaços colapsados.
- `GRUPO_A_TIPOS = {"atendimento social", "consulta/avaliacao"}`.
- `GRUPO_B_TIPOS = {"cirurgia","cortesia","encaixe","encaminhamento - interno","pequenas cirurgias","procedimento","retorno"}`.
- `resolveTiposConsulta(env, target)` — cache (TTL 1h, **por ambiente**) de `idTipoConsulta → nome normalizado`,
  via `GET /tipo-consulta/lista`.
- `grupoDaAgenda(agenda, tiposMap)` → `"A" | "B" | null`. Lê `agenda.idTipoConsulta`, resolve nome,
  classifica. **Desconhecido → null (não faz nada).**
- `destinoStatus(grupo, statusEnum)` → etapa Kommo (consulta o `MAPA_STATUS`).
- `pipelineDoGrupo`, `ETAPA_BASE`, `ETAPA_CONFIRMACAO`, `VESPERA_DESTINO` — tabelas auxiliares por grupo.

## 5.3 Credenciais CNN + trava de escrita
- `cnnCreds(env, target)` — escolhe trio sandbox vs `_PRODUCTION`.
- `cnnHeaders(env, target)` — `Authorization: Basic btoa(user:pass)` + header `clinicaNasNuvens-cid`.
- `assertCnnWritable(target, method, path)` — **lança** se `target==="production"` (§7.8).
- `cnnGet/cnnPost/cnnPut(path, [body], env, target="sandbox")` — Post/Put chamam `assertCnnWritable`.

## 5.4 Kommo helpers
- `kommoBase(env)` = `https://{subdomain}.kommo.com/api/v4`.
- `kommoThrottle()` — serializa chamadas com gap de 150ms (~6,6 req/s, sob o limite de 7 req/s da conta).
- `kommoGet` trata 204/corpo vazio (Kommo devolve vazio quando a lista filtrada é vazia → `res.json()`
  quebraria). `kommoPatch/Post/Delete`.

## 5.5 Utilitários
- `isTestePhone(phone)` — allowlist `["92982717586","92994567328","11946800329"]` (compara por `phoneKey`).
- `getFieldValue`, `setLeadFields`, `moveLeadToStage(leadId, statusId, env, pipelineId=Captação)`,
  `setAgendamento` (campo date_time exige **número** Unix).
- Tempo (BRT = UTC−3): `unixToDateBRT`, `brtToUnix`, `dayRangeBRT`, `tomorrowBRT`, `todayBRT`, `addMinutes`.
- Telefone: `normalizePhone` (só dígitos), `phoneKey` (**§7.1**: tira DDI 55 + 9º dígito → DDD + últimos 8;
  casa formatos mistos sem duplicar).
- `isTarefaInterna(agenda)` — telefone vazio / <10 dígitos / ≤2 dígitos distintos → tarefa interna.
- `cnnPacienteNome(id, env, target)` — `GET /paciente/{id}` com 3 tentativas + backoff (nome não vem na lista).

## 5.6 D1 — schema e helpers
**Em linguagem simples:** "schema" = a estrutura das tabelas do banco (quais tabelas existem e quais
colunas cada uma tem). Estes são os comandos que criam as tabelas e as funções que leem/escrevem nelas.
- `ensureSchema(env)` — cria (IF NOT EXISTS = "crie só se ainda não existir") todas as tabelas (ver Parte 6).
- **Fila:** `filaEnfileirarLote` (DB.batch, INSERT OR IGNORE), `filaPuxarPendentes` (ORDER B-first, id),
  `filaMarcarFeito`, `filaMarcarErro` (tentativas++, >`FILA_MAX_TENTATIVAS=4` → `erro`), `filaStats`.
- **Idempotência véspera:** `leadJaLembradoNaData(lead, data)`, `registrarLembrete(...)`.
- **Auditoria:** `audit(env, {funcao, ambiente, entidade_id, acao, de, para, detalhe})` — nunca quebra o fluxo.
- **Cursores:** `getCursor`, `setCursor`.
- **Mapeamento:** `upsertMapeamento`, `getMapeamentoByPaciente`, `getMapeamentoIdSet` (1 query → Set),
  `getMapeamentoLeadMap` (1 query → Map paciente→lead).
- **Agenda_sync (baseline):** `upsertAgendaSync`, `getAgendaSync`, `getAgendaSyncMap` (1 query → Map).
- **Legado:** `getSyncedTs`, `setSyncedTs` (tabela `agendamento_sync`).
- `getOrCreateConvenioParticular(idPaciente, env)` — clínica é full particular, mas `/agenda/novo`
  exige `idPacienteConvenio`; associa o Particular ou reaproveita associação existente.

## 5.7 Fluxos de negócio (legado, ainda no cron)
- `handleLeadAgendado` (**A1/W1**) — webhook; cria paciente+agenda no CNN; grava `ID Agenda CNN`/`ID Paciente CNN`.
- `handleConfirmacao` (**W2**) — webhook; `CONFIRMADO_PACIENTE` no CNN + move p/ Consulta Confirmada.
- `selectLeadsLembreteD1` + `cronLembreteD1` (**C1**) — véspera legada.
- `syncKommoParaCnn` (**A2**) — delta `updated_at` Kommo→CNN (`/remarcar`).
- `syncCnnParaKommo` (**A3 legado**) — varredura com offset/orçamento (mantido p/ `/debug-a3`).
- `backfillCadastros` (**A4 legado**) — backfill com offset/orçamento (mantido p/ `/debug-a4`).
- `cronSyncStatus` (**C2**) — sync legado completo (Partes A/B/C).
- `cronVespera` (**F2 legado**) — véspera CNN-driven (mantido p/ `/debug-f2`).

## 5.8 Fila de trabalho (a NOVA arquitetura)
**Em linguagem simples:** em vez de fazer tudo de uma vez, o programa anota tarefas numa lista (fila)
no banco e processa poucas por minuto. **Produtor** = a função que olha o CNN e **anota** as tarefas.
**Consumidor** = a função que **pega** tarefas da lista e executa. "Idempotente via `chave` UNIQUE"
significa: cada tarefa tem um identificador único; se o produtor tentar anotar a mesma tarefa de novo,
o banco **ignora a duplicata** (não enfileira duas vezes).
**Produtores (enfileiram, idempotente via `chave` UNIQUE):**
- `produtorBackfill(env, target, windowDays, soTeste)` — 1 item/paciente não-mapeado; desempate B-first
  resolvido aqui; chave `A4:pac:<id>`.
- `produtorSync(env, target, windowDays)` — 1 item/agenda de paciente mapeado cujo status/hora divergiu
  do baseline; chave `A3:ag:<id>:<status>:<tsBucket>` (re-enfileira quando muda).
- `produtorVespera(env, target, dataAlvo?)` — 1 item/lead com consulta amanhã (dedup B-first, pula
  `lembrete_d1`); chave `F2:lead:<leadId>:<data>`.

**Consumidores (processam 1 item):**
- `consumirItemA4` → vincular (lead existe) ou criar card no pipeline do grupo. Retorna `{r, leadId, nome}`.
- `consumirItemA3` → baseline (1ª vez, não move) ou reflete status/hora (move etapa por grupo).
- `consumirItemF2` → move lead p/ etapa de confirmação do grupo + `registrarLembrete`.
- `consumirFila(env, target, dryRun, cap, budget)` — puxa lote (cap), processa por `tipo`, marca
  feito/erro, **para no orçamento** (`orcamentoOk(budget)`), grava auditoria.

## 5.9 Endpoints de diagnóstico (handlers)
`handleTestWorkflow`, `handleDebugC1`, `handleDebugScale`, `handleDebugCnnShape`, `handleDebugCount`,
`handleDebugCriarAgenda`, `handleDebugBackfillPreview`, `handleDebugRaw`, `handleDebugAgendas`.
Auth: `webhookAuthOk` (`?secret=`) e `discoverAuthOk` (header `Authorization`).

## 5.10 Export default
- `fetch(req, env)` — roteia os 23 paths (ver Parte 8).
- `scheduled(event, env, ctx)` — **hoje legado**: `event.cron==="0 18..."`→C1, senão C2.
  **Pós-flip:** resetSubreq → 1 produtor por tick (véspera/sync/backfill por horário) → consumidores.

---

# PARTE 6 — TABELAS D1 (banco `kommo-cnn-db`)

> **Em linguagem simples:** D1 é o banco de dados (a "memória" do programa). Pense em cada **tabela**
> como uma planilha; cada **coluna** é um campo; cada **linha** é um registro. Termos da tabela abaixo:
> - **PK (Primary Key / chave primária):** a coluna que identifica unicamente cada linha (não repete).
> - **UNIQUE:** uma coluna que também não pode repetir valor (usada para evitar duplicatas).
> - **índice:** um "atalho de busca" que faz consultas por aquela coluna serem rápidas.
> - **autoinc:** número que o banco gera sozinho, somando +1 a cada nova linha.

Todas criadas em `ensureSchema` (idempotente = pode rodar várias vezes sem problema; `IF NOT EXISTS`
= só cria se a tabela ainda não existir).

| Tabela | PK / UNIQUE | Colunas | Papel |
|---|---|---|---|
| `agendamento_sync` | `lead_id` | `synced_ts`, `updated_at` | **Legado** (W1/C1/C2): ts da última sync por lead |
| `cursores` | `nome` | `valor`, `atualizado_em` | Watermarks. Chaves: `kommo_updated_at` (A2), `a3_offset_*`/`a4_offset_*` (offset legado) |
| `mapeamento` | `paciente_id_cnn` | `lead_id_kommo`, `telefone_norm`, `duplicata`, `criado_em`, `atualizado_em` | **Identidade** paciente↔lead. Anti-ressurreição. |
| `agenda_sync` | `agenda_id_cnn` | `lead_id_kommo`, `paciente_id_cnn`, `last_agendamento_ts`, `last_cnn_status`, `atualizado_em` | **Baseline** anti-eco; detecção de mudança (A3) |
| `lembrete_d1` | `chave` | `lead_id_kommo`, `agenda_id_cnn`, `data_agendamento`, `grupo`, `pipeline_destino`, `etapa_destino`, `enviado_em` | **Idempotência da véspera** (1 lembrete/lead/dia) |
| `auditoria` | `id` (autoinc) | `ts`, `funcao`, `ambiente`, `entidade_id`, `acao`, `de`, `para`, `detalhe` | **Log de auditoria** (toda ação relevante) |
| `fila_trabalho` | `id` autoinc / `chave` UNIQUE | `tipo`, `agenda_id_cnn`, `paciente_id_cnn`, `grupo`, `payload`, `status`, `tentativas`, `ultimo_erro`, `criado_em`, `atualizado_em` | **Fila de trabalho** (a nova arquitetura) |

Índices: `idx_map_tel`, `idx_map_lead`, `idx_ag_lead`, `idx_ag_pac`, `idx_fila_status (status,id)`.

**Por que cada tabela existe:**
- `mapeamento` é a **chave de identidade** (telefone normalizado liga paciente↔lead) e a base da
  anti-ressurreição (paciente já mapeado nunca recria card).
- `agenda_sync` é o **baseline** que mata o eco/loop (o Worker não rebate a própria escrita) e detecta
  o que mudou no CNN sem reler o Kommo.
- `lembrete_d1` garante o "uma vez só" da véspera, com chave composta (lead+agenda+data).
- `fila_trabalho` é efêmera (trabalho), separada do estado durável de propósito (ciclo de vida limpo).

## 6.1 DDL exato (como está em `ensureSchema`)
```sql
CREATE TABLE IF NOT EXISTS agendamento_sync (
  lead_id TEXT PRIMARY KEY, synced_ts INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cursores (
  nome TEXT PRIMARY KEY, valor TEXT, atualizado_em INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mapeamento (
  paciente_id_cnn TEXT PRIMARY KEY, lead_id_kommo TEXT, telefone_norm TEXT,
  duplicata INTEGER DEFAULT 0, criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_sync (
  agenda_id_cnn TEXT PRIMARY KEY, lead_id_kommo TEXT, paciente_id_cnn TEXT,
  last_agendamento_ts INTEGER, last_cnn_status TEXT, atualizado_em INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lembrete_d1 (
  chave TEXT PRIMARY KEY, lead_id_kommo TEXT, agenda_id_cnn TEXT, data_agendamento TEXT,
  grupo TEXT, pipeline_destino INTEGER, etapa_destino INTEGER, enviado_em INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, funcao TEXT, ambiente TEXT,
  entidade_id TEXT, acao TEXT, de TEXT, para TEXT, detalhe TEXT);
CREATE TABLE IF NOT EXISTS fila_trabalho (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chave TEXT UNIQUE, tipo TEXT,
  agenda_id_cnn TEXT, paciente_id_cnn TEXT, grupo TEXT, payload TEXT,
  status TEXT DEFAULT 'pendente', tentativas INTEGER DEFAULT 0, ultimo_erro TEXT,
  criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_map_tel ON mapeamento(telefone_norm);
CREATE INDEX IF NOT EXISTS idx_map_lead ON mapeamento(lead_id_kommo);
CREATE INDEX IF NOT EXISTS idx_ag_lead ON agenda_sync(lead_id_kommo);
CREATE INDEX IF NOT EXISTS idx_ag_pac ON agenda_sync(paciente_id_cnn);
CREATE INDEX IF NOT EXISTS idx_fila_status ON fila_trabalho(status, id);
```

## 6.2 Linhas de exemplo
```
mapeamento:   paciente_id_cnn=5623900  lead_id_kommo=18835182  telefone_norm=51999778050  duplicata=0
agenda_sync:  agenda_id_cnn=129079590  lead_id_kommo=17488447  paciente_id_cnn=28146949
              last_agendamento_ts=1781960400  last_cnn_status=AGENDADO
lembrete_d1:  chave="17488447|129338650|2026-06-25"  grupo=B  etapa_destino=107974651
fila_trabalho: chave="A4:pac:5623900"  tipo=A4  grupo=B  status=feito
              payload={"telefone":"51999778050","cnnTs":1781960400,"status":"AGENDADO"}
auditoria:    funcao=A4 acao=card-criado para=B entidade_id=18835182 detalhe="pac 5623900 REGINA..."
cursores:     nome=kommo_updated_at  valor=1782240648
```

## 6.3 Padrões de query (e o porquê)
- **Carga em massa, não N round-trips:** `getMapeamentoIdSet`/`getMapeamentoLeadMap`/`getAgendaSyncMap`
  fazem **1 SELECT** e montam Set/Map em memória. Crucial: D1 não conta no teto de fetch, mas N
  leituras sequenciais custam ~300ms cada (foi o gargalo de 102s → 13s).
- **Insert em lote:** `filaEnfileirarLote` usa `DB.batch([...])` em chunks de 50 (1 round-trip por chunk).
- **Idempotência por UNIQUE:** `fila_trabalho.chave UNIQUE` + `INSERT OR IGNORE` → produtor pode rodar
  repetidamente sem duplicar. `lembrete_d1.chave PRIMARY KEY` idem.
- **Claim do consumidor:** `SELECT … WHERE status='pendente' AND tentativas<4 ORDER BY (grupo=='B'?0:1), id LIMIT cap`.
- **Retry:** erro → `tentativas+1`; volta a `pendente` até 4×, depois marca `erro` (sai do loop de repesca).

---

# PARTE 7 — ENDPOINTS HTTP (23 paths)

> **Em linguagem simples:** "endpoint" = um endereço do nosso programa que pode ser chamado pela
> internet (ex.: `…workers.dev/health`). Cada um faz uma coisa. Os `/webhook/*` são chamados **pelo
> Kommo**; os `/debug-*` são ferramentas que **nós** usamos para testar/diagnosticar; `/health` diz
> só se está no ar. "Auth" = como o endereço se protege: `?secret=` é uma senha na URL; `Authorization`
> é uma senha no cabeçalho do pedido. Sem a senha certa, devolve "Unauthorized".

| Rota | Método | Auth | Função |
|---|---|---|---|
| `/health` | GET | nenhuma | healthcheck |
| `/webhook/lead-agendado` | POST | `?secret=` | **A1/W1** |
| `/webhook/confirmacao` | POST | `?secret=` | **W2** |
| `/discover` | GET | `Authorization` | Dump configs CNN (`?env=`) + Kommo (pipelines, fields) + contagem leads |
| `/test-workflow` | GET/POST | `Authorization` | Auditoria/simulação por telefone (ações: audit, primer, run-w1, run-c1, reset, etc.) |
| `/debug-tick` | GET | `Authorization` | **Dispatcher de validação**: produtor + consumidores; mede subreq/tempo. Params: `env,dry,prod,job,cap,budget,window,soteste,clear,data` |
| `/debug-audit` | GET | `Authorization` | Conta auditoria por ação + total mapeamento + fila + 15 recentes |
| `/debug-backfill-preview` | GET | `Authorization` | Prévia do backfill por dia (CSV-ready); `skipnames=1` p/ 2-pass |
| `/debug-agendas` | GET | `Authorization` | Lista agendas de um dia (tipo/grupo/status/lead) |
| `/debug-raw` | GET | `Authorization` | Inspeção crua da paginação CNN (totalPaginas, por dia) |
| `/debug-raw-agendas` | GET | `Authorization` | Dump cru dos objetos de agenda (todos os campos) |
| `/debug-nomes` | GET | `Authorization` | Diagnóstico de resolução de nome; `map=1` retorna id→nome; mede status HTTP |
| `/debug-d1cost` | GET | `Authorization` | **Teste**: D1 conta como sub-request? (resultado: NÃO) |
| `/debug-count` | GET | `Authorization` | Contagem de leads por pipeline×etapa (com guarda) |
| `/debug-cnn-shape` | GET | `Authorization` | Tipos + enums de status reais + preview de roteamento |
| `/debug-move` | GET | `Authorization` | Move 1 lead (lead, pipeline, status) — utilitário |
| `/debug-criar-agenda` | GET | `Authorization` | Cria agenda de teste no **sandbox** (tipo escolhido, allowlist) |
| `/debug-c1` | GET | `Authorization` | Dry-run C1 legado |
| `/debug-scale` | GET | `Authorization` | Valida filtros/escala Kommo+CNN |
| `/debug-a2` | GET | `Authorization` | Dry-run A2 (`?dry=`) |
| `/debug-a3` | GET | `Authorization` | Dry-run A3 legado (`?dry=,env=,max=`) |
| `/debug-a4` | GET | `Authorization` | Dry-run A4 legado (`?dry=,soteste=,env=,max=`) |
| `/debug-f2` | GET | `Authorization` | Dry-run F2 legado (`?dry=,env=,data=,reset=`) |

> **Limpeza futura:** muitos `/debug-*` são andaimes de desenvolvimento/diagnóstico. Após o flip e
> estabilização, dá pra remover os de teste, mantendo `/health`, webhooks, `/discover`, `/debug-tick`,
> `/debug-audit` (operação) e talvez `/debug-a4`.

---

# PARTE 8 — CONSTANTES DE NEGÓCIO

> **Em linguagem simples:** "constantes" são valores fixos que o código usa. No Kommo, cada funil e
> cada etapa têm um **número de identificação (ID)**. Quando o programa quer mover um cartão para a
> etapa "Confirmação de consulta", ele precisa usar o número dela (107785399), não o nome. Esta parte
> lista esses números. Eles foram descobertos perguntando ao Kommo (endpoint `/discover`) e são
> **estáveis** (não mudam) porque o Kommo é uma conta só. Já os tipos de consulta do **CNN** mudam de
> número entre teste e produção — por isso, para tipos, usamos o **nome**, não o número (ver Parte 5.2).

## 8.1 Pipelines e etapas (Kommo — capturado via /discover, estável entre ambientes)

**Funil de Captação `13847079`:**
| ID | Etapa | Constante |
|---|---|---|
| 106848271 | Leads de entrada (Incoming) | — |
| 106848615 | primeiro contato | `STAGE_PRIMEIRO_CONTATO` |
| 106848619 | consulta agendada | `STAGE_CONSULTA_AGENDADA` (=`ETAPA_BASE.A`) |
| 107785399 | Confirmação de consulta | `STAGE_CONFIRMACAO_CONSULTA` (=`ETAPA_CONFIRMACAO.A`) |
| 106848623 | consulta confirmada | `STAGE_CONSULTA_CONFIRMADA` |
| 106848627 | avaliação realizada | `STAGE_AVALIACAO_REALIZADA` |
| 106848631 | tratamento proposto | `STAGE_TRATAMENTO_PROPOSTO` |
| 143 | Consulta cancelada – perdido | `STAGE_CANCELADA_PERDIDO` |

**Funil de Pós - Venda `13950431`:**
| ID | Etapa | Constante |
|---|---|---|
| 107658911 | cliente ativo | `STAGE_POS_CLIENTE_ATIVO` (=`ETAPA_BASE.B`) |
| 107974651 | confirmação de agendamento | `STAGE_POS_CONFIRMACAO_AGEND` (=`ETAPA_CONFIRMACAO.B`) |

(Existe também o "Funil de Pós - Consulta" `13947295`, não usado.)

## 8.2 IDs CNN (fixos, sandbox; em produção os tipos diferem → resolução por nome)
```
CNN_CONVENIO_PARTICULAR = 56545   CNN_TIPO_CONSULTA = 110452
CNN_LOCAL_AGENDA = 41170          CNN_TIPO_PROCEDIMENTO = 1011844
CNN_BASE = "https://api.clinicanasnuvens.com.br"
```
**Tipos de consulta em PRODUÇÃO (via /discover prod):** 66666 Consulta/Avaliação(A), 66671 Atendimento
Social(A), 66667 Pequenas Cirurgias(B), 66668 Encaixe(B), 66669 Encaminhamento-INTERNO(B), 66670
Procedimento(B), 66672 RETORNO(B), 67118 Cortesia(B), 93892 Cirurgia(B).

## 8.3 Campos customizados Kommo (resolvidos dinâmico via `resolveFields`)
`AGENDAMENTO` (date_time, ts Unix), `ID Agenda CNN` (texto), `ID Paciente CNN` (texto), `PHONE` (field_code do contato).

## 8.4 MAPA_STATUS (status CNN → etapa Kommo, por grupo)
**Em linguagem simples:** esta é a tabela de tradução "quando a consulta está no estado X no CNN, o
cartão deve ir para a etapa Y no Kommo" — e o destino depende do grupo (A=Captação, B=Pós-Venda). Ex.:
consulta `FINALIZADO` de um paciente do Grupo A → mover o cartão para "avaliação realizada". Status que
não estão na tabela (operacionais, do dia a dia) **não movem** o cartão.
| Status CNN (enum API) | Grupo A → | Grupo B → |
|---|---|---|
| `AGENDADO` | consulta agendada (106848619) | cliente ativo (107658911) |
| `CONFIRMADO_PACIENTE` | consulta confirmada (106848623) | cliente ativo |
| `CONFIRMADO` (inferido) | consulta confirmada | cliente ativo |
| `FINALIZADO` | avaliação realizada (106848627) | cliente ativo |
| `FALTOU` | primeiro contato (106848615) | cliente ativo |
| `CANCELADO` | cancelada–perdido (143) | cliente ativo |
| `CANCELADO_PACIENTE` | cancelada–perdido (143) | cliente ativo |
| Operacionais (`EM_ESPERA`, `PAGAMENTO`, `PRE_ATENDIMENTO`, `EM_ANDAMENTO`) | — não move | — não move |

**Véspera (F2):** Grupo A → Confirmação de consulta (107785399); Grupo B → confirmação de agendamento (107974651).

## 8.5 Outras constantes
`ALLOWLIST_TESTE = ["92982717586","92994567328","11946800329"]`, `ANO_PISO = 2026` (A4 ignora agendas
anteriores), `FILA_MAX_TENTATIVAS = 4`, throttle Kommo 150ms, cache de campos/tipos TTL 1h.

---

# PARTE 9 — REGRAS TRANSVERSAIS (do escopo mãe §7)

> **Em linguagem simples:** "transversais" = regras que valem para o sistema inteiro, não só para uma
> função. "§7.x" são os números das seções no documento de objetivo (`novo arquivo mae escopo.md`) —
> citamos para rastreabilidade. Cada regra abaixo diz o nome → o que garante → onde está no código.

- **§7.1 Normalização de telefone** → `phoneKey` (DDD + últimos 8; ignora DDI 55 e 9º dígito).
- **§7.2 Idempotência de movimentação** → `lembrete_d1`, `agenda_sync` baseline, `mapeamento`.
- **§7.3 Idempotência de criação** → W1 pula se `ID Agenda CNN` já preenchido; A4 pula se paciente mapeado.
- **§7.4 Supressão de eco** → baseline em `agenda_sync` (o Worker não rebate a própria escrita).
- **§7.5 Confirmação reforçada** → F2 lista a agenda **de amanhã no CNN** (fonte), não a cópia no Kommo.
- **§7.6 Fuso** → tudo em BRT (UTC−3), conversão explícita.
- **§7.7 Direção de criação** → CNN é fonte da verdade do cadastro; criação no CNN só via W1; cards só
  CNN→Kommo.
- **§7.8 Chave produção CNN = só leitura** → `assertCnnWritable`.

---

# PARTE 10 — QUIRKS DE API DESCOBERTOS (validados ao vivo)

> **Em linguagem simples:** "quirk" = uma peculiaridade/comportamento estranho de um sistema que a
> documentação não conta, mas que descobrimos testando ao vivo. Estão aqui porque cada um já causou (ou
> causaria) um bug, e o código tem um tratamento específico para cada. "Validado ao vivo" = comprovamos
> na prática, não supusemos.

**Kommo:**
- `filter[status_id]=X` é **silenciosamente ignorado** → retorna leads aleatórios. Correto:
  `filter[statuses][0][pipeline_id]=P&filter[statuses][0][status_id]=S` + guarda no código.
- `filter[...][pipeline_id]` **sozinho** também é ignorado.
- `GET /leads` sem filtro **exclui leads "Incoming"/unsorted** (contagem deu 2.273; real 2.451).
- Resposta 204/vazia quando lista filtrada é vazia → `res.json()` quebra (tratado em `kommoGet`).
- `limit` máx 250/página. `values:[]` p/ limpar campo dá erro 1101 → usar `values:[{value:""}]`.
- Limite **7 req/s** por IP → throttle 150ms.

**CNN:**
- `/agenda/lista` **capa em 100 registros/página** (ignora `registrosPorPagina=200`); `totalPaginas` é confiável.
- `/agenda/lista` **NÃO retorna nome do paciente** (só `idPaciente`); nome exige `GET /paciente/{id}`.
- Filtro `dataInicial/dataFinal` **funciona** (domingo/datas distantes → 0).
- `/agenda/novo` **exige** `idPacienteConvenio` mesmo a clínica sendo full particular.
- `/agenda/{id}/remarcar` usa campos `novaData`, `novoHorarioInicial`, `novoHorarioFinal`.
- `telefoneCelularContem` em `/paciente/lista` não é documentado mas funciona.

**Cloudflare Workers (free):**
- **50 sub-requests (`fetch`) por invocação** (erro `Too many subrequests` na 50ª). D1 **não conta**.
- CPU 10ms/invocação (espera de rede não conta) — nossos ticks (~10-15s wallclock) cabem.
- 100.000 requisições/dia (usamos ~1,4%). Cron mínimo: 1 minuto.

---

# PARTE 11 — ESTADO ATUAL E O QUE FALTA

## 11.1 Backfill (concluído 2026-06-27)
- **350 pacientes mapeados** (vinculados a lead).
- **52 cards criados** (20 Grupo A → Captação/Consulta Agendada; 32 Grupo B → Pós-Venda/Cliente Ativo).
- ~298 vinculados (lead já existia — só registra identidade, não cria card visível).
- **0 erros.** Cada criação registrada em `auditoria` (`acao=card-criado`).
- Descoberta: ~88% dos pacientes "não-mapeados" já tinham lead → backfill é mais vínculo que criação.

## 11.2 Validado em dry-run
- A3 sync: produtor enfileira mudanças, **0 não-mapeados**, baseline não move etapa. ≤8 subreq.
- F2 véspera: dedup B-first, idempotente, move p/ Confirmação. ≤2 subreq.
- Consumidor: ~10 itens/tick, **subreq total 10-18** (folgado sob 50). CPU ok.

## 11.3 O que FALTA (o "flip", aguardando OK)
1. Trocar `scheduled()` pelo dispatcher (resetSubreq → 1 produtor por horário → consumidores).
2. `wrangler.toml` crons → `["* * * * *"]`.
3. Aposentar C1/C2 do `scheduled()` (funções permanecem no arquivo).
4. **A2 fica de fora** (escreve no CNN → bloqueado §7.8) até liberação de escrita CNN.

**Comportamento da 1ª hora pós-flip:** o 1º `produtorSync` enfileira ~420 agendas como **baseline**;
o consumidor processa 10/min (~42 min) **sem mover etapa**; só depois mudanças reais de status movem.
→ Sem movimentação em massa no flip.

## 11.4 Roadmap pós-flip
- Liberar escrita CNN em produção → ativar A1/W1, W2, A2.
- Implementar refresh OAuth do Kommo (`KOMMO_CLIENT_SECRET`).
- Função 3 do escopo (movimentação por orçamento — `/orcamento/lista`) — ainda não construída.
- Etapa "Importado CNN" para paciente sem agenda ativa (escopo §8.5) — não construída.
- Limpeza dos endpoints `/debug-*` de teste.

---

# PARTE 12 — OPERAÇÃO (deploy, monitoramento, rollback)

**Deploy:** `npx wrangler deploy src/index.ts` (com `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).
Validar antes: `npx tsc --noEmit` (devem restar só ~2 erros pré-existentes de `implicit any` em código legado).

**Monitorar:** `GET /debug-audit` (conta ações, fila, recentes), `GET /debug-tick?dry=1&cap=0` (só fila stats).

**Rollback do flip:** redeploy com o `scheduled()` legado (`event.cron`) + crons antigos no `wrangler.toml`.
Volta ao estado C1/C2 em ~30s. Como tudo é idempotente e o baseline não move, risco baixo.

**Salvaguardas em produção:**
- Orçamento `budget=40` + 1 produtor/tick → nunca chega a 50 subreq.
- `try/catch` em produtor e consumidor → falha de um não derruba o tick; registra em auditoria.
- §7.8 por código → escrita CNN-produção impossível.
- Idempotência tripla (lembrete_d1, agenda_sync, mapeamento) → nada é processado/movido 2×.

---

# PARTE 13 — PLATAFORMA: CLOUDFLARE WORKERS (e por que NÃO usamos API/serviço pago)

## 13.1 O que é um Cloudflare Worker (onde tudo roda)
Toda a integração é **um único Cloudflare Worker** — código JavaScript/TypeScript que roda na borda
da Cloudflare (V8 isolates, não containers), acionado por **HTTP** (os endpoints) e por **cron**
(`scheduled`). Não há servidor, VM, nem backend separado. O arquivo `src/index.ts` é compilado pelo
`wrangler` (esbuild) e publicado como um único bundle (~64 KiB / ~13 KiB gzip).

**Componentes da plataforma que usamos:**
- **Worker (fetch + scheduled)** — o runtime. `fetch(req,env)` atende HTTP; `scheduled(event,env,ctx)`
  roda nos horários do cron. `ctx.waitUntil(...)` mantém o trabalho async vivo após retornar.
- **D1** (`env.DB`) — banco SQLite gerenciado, na mesma infra do Worker. É o nosso "ledger" (Parte 6).
  Acesso por binding (`env.DB.prepare(...).bind(...).run()/first()/all()`, e `env.DB.batch([...])`).
- **Cron Triggers** — agendador embutido (`[triggers] crons` no `wrangler.toml`). Mínimo: 1 minuto.
- **Secrets/Vars** — `wrangler secret put` (criptografado) e `[vars]` (texto) → chegam em `env`.

## 13.2 Limites do plano FREE (e onde cada um nos afeta)
| Recurso | Free | Onde nos afeta |
|---|---|---|
| Requisições/dia | 100.000 | cron 1 min = 1.440/dia (1,4%) → **folga enorme** |
| **Sub-requests (`fetch`) por invocação** | **50** | **O GARGALO.** Cada chamada CNN/Kommo conta. D1 NÃO conta. |
| CPU por invocação | 10 ms | espera de rede não conta → nossos ticks cabem |
| D1 storage | 5 GB | irrelevante (nossas tabelas são pequenas) |
| D1 leituras/dia | 5 milhões | irrelevante no nosso volume |
| D1 escritas/dia | 100.000 | backfill ~600 escritas; diário ~centenas → folga |

## 13.3 Por que NÃO usamos plano/API pago (decisão registrada)
- **Restrição inegociável do cliente: custo zero.** A operação é comercial (clínica real movendo
  pacientes), então a plataforma precisa permitir **uso comercial no plano gratuito**.
- **Vercel** foi avaliada (não tem o limite de 50 sub-requests que nos travava), **mas o plano Hobby
  (free) proíbe uso comercial** nos termos → violar isso numa clínica real = risco de **takedown no
  meio da operação**. Descartada.
- **Cloudflare Workers Free permite uso comercial** → ficamos no Cloudflare, sem custo, dentro dos termos.
- **Cloudflare Queues** resolveria a fila nativamente, **mas é recurso pago** → fora da restrição.
  Por isso a fila é feita **à mão em D1** (que é free) — ver Parte 5.8 e 6.
- **Workers Paid (US$ 5/mês)** elevaria o teto p/ 1.000 sub-requests/invocação e resolveria tudo numa
  só execução. Foi **recusado** pela premissa de custo zero. A arquitetura de fila + cron 1 min é
  justamente o que torna o custo zero **viável** sem o plano pago.

**Resumo da lógica:** custo zero + uso comercial ⇒ Cloudflare Workers Free ⇒ teto de 50 sub-requests
⇒ fila-em-D1 + cron de 1 min para diluir a carga.

---

# PARTE 14 — REFERÊNCIA EXAUSTIVA, FUNÇÃO A FUNÇÃO (`src/index.ts`)

> **Como ler esta parte (para não-programadores):** cada item lista o **nome da função**, entre
> parênteses os **dados que ela recebe** (parâmetros), depois de `:` o **tipo do que ela devolve**.
> Exemplo: `phoneKey(p): string` = a função chamada `phoneKey` recebe um telefone `p` e devolve um
> texto (`string`). `Promise<...>` significa "devolve depois de uma operação que leva um tempinho"
> (chamada de internet/banco). `env` é o acesso a secrets+banco; `target` é "sandbox" ou "production".
> Você **não precisa** ler função por função — esta parte é referência para quem for mexer no código.

> Toda função do arquivo, com assinatura e o que faz. Agrupada por seção.

## 14.1 Orçamento de sub-requests
- `resetSubreq(): void` — zera `subreqUsados`. Chamar no início de cada entrada (scheduled/tick).
- `bumpSubreq(): void` — incrementa o contador. Chamado dentro de cada wrapper de fetch.
- `orcamentoOk(max=45): boolean` — `subreqUsados < max`. Consumidores param quando false.

## 14.2 Roteamento por tipo
- `normNome(s): string` — normaliza nome (minúsculo, sem acento, espaços colapsados).
- `resolveTiposConsulta(env, target): Promise<Record<id,nome>>` — cache 1h por ambiente; `/tipo-consulta/lista`.
- `grupoDaAgenda(agenda, tiposMap): "A"|"B"|null` — classifica a agenda pelo nome do tipo.
- `destinoStatus(grupo, statusEnum): number|null` — etapa Kommo via `MAPA_STATUS`.
- `pipelineDoGrupo(grupo): number` — Captação (A) ou Pós-Venda (B).

## 14.3 CNN (helpers + trava §7.8)
- `cnnCreds(env, target)` — trio user/pass/cid (sandbox vs `_PRODUCTION`).
- `cnnHeaders(env, target=sandbox): HeadersInit` — Basic auth + header cid.
- `assertCnnWritable(target, method, path): void` — **lança** se produção (bloqueia escrita).
- `cnnGet(path, env, target=sandbox): Promise<any>` — GET; `bumpSubreq`; throw em !ok.
- `cnnPost(path, body, env, target=sandbox)` — `assertCnnWritable`; `bumpSubreq`; POST.
- `cnnPut(path, body, env, target=sandbox)` — idem PUT.

## 14.4 Kommo (helpers)
- `kommoBase(env): string` — URL base v4.
- `kommoThrottle(): Promise<void>` — serializa com gap 150ms (~6,6 req/s).
- `kommoGet(path, env)` — GET; trata 204/vazio; `bumpSubreq`.
- `kommoPatch(path, body, env)` / `kommoPost(...)` / `kommoDelete(path, env)` — escritas; `bumpSubreq`.

## 14.5 Utilitários gerais
- `isTestePhone(phone): boolean` — telefone na allowlist (via `phoneKey`).
- `getFieldValue(entity, fieldId): string|null` — lê custom field.
- `setLeadFields(leadId, updates[], env)` — PATCH de custom fields (value ou enum_id).
- `moveLeadToStage(leadId, statusId, env, pipelineId=Captação)` — PATCH status+pipeline.
- `setAgendamento(leadId, ts, fieldId, env)` — seta o campo date_time (número Unix).
- `addMinutes(hhmm, minutes): string` — soma minutos a "HH:MM".
- `unixToDateBRT(ts): {data,hora}` / `brtToUnix(dateISO, hhmm): number` — conversões BRT↔Unix.
- `dayRangeBRT(dateISO): {from,to}` — range Unix do dia. `tomorrowBRT()` / `todayBRT(): string`.
- `normalizePhone(p): string` — só dígitos. `phoneKey(p): string` — chave canônica §7.1 (DDD+últimos 8).
- `isTarefaInterna(agenda): boolean` — detecta tarefa interna por telefone falso.
- `cnnPacienteNome(id, env, target): Promise<string|null>` — nome do paciente, 3 tentativas + backoff.

## 14.6 D1 — schema e acesso
- `ensureSchema(env)` — cria todas as tabelas + índices (idempotente).
- `filaEnfileirarLote(itens[], env)` — INSERT OR IGNORE em DB.batch (chunks de 50).
- `filaPuxarPendentes(limite, env): Promise<any[]>` — pendentes, B-first, tentativas<4.
- `filaMarcarFeito(id, env)` / `filaMarcarErro(id, tentativas, msg, env)` — status (erro→pendente até 4×, depois `erro`).
- `filaStats(env): Promise<Record<status,n>>` — contagem por status.
- `leadJaLembradoNaData(leadId, data, env): boolean` — idempotência véspera.
- `registrarLembrete({...}, env)` — grava `lembrete_d1`.
- `audit(env, {funcao,ambiente,entidade_id,acao,de,para,detalhe})` — log; nunca quebra o fluxo.
- `getCursor(nome, env)` / `setCursor(nome, valor, env)` — watermarks.
- `upsertMapeamento({...}, env)` / `getMapeamentoByPaciente(id, env)` — identidade paciente↔lead.
- `getMapeamentoIdSet(env): Set` / `getMapeamentoLeadMap(env): Map` — carga em massa (1 query, evita N round-trips).
- `upsertAgendaSync({...}, env)` / `getAgendaSync(id, env)` / `getAgendaSyncMap(env): Map` — baseline.
- `getSyncedTs(leadId, env)` / `setSyncedTs(leadId, ts, env)` — legado.
- `getOrCreateConvenioParticular(idPaciente, env): number|undefined` — convênio particular obrigatório.

## 14.7 Fluxos de negócio (legado — ainda no cron até o flip)
- `handleLeadAgendado(req, env): Response` — **A1/W1** webhook Kommo→CNN (cria paciente+agenda).
- `handleConfirmacao(req, env): Response` — **W2** webhook (CONFIRMADO_PACIENTE + move).
- `selectLeadsLembreteD1(env)` — seleciona leads da véspera (legado).
- `cronLembreteD1(env)` — **C1** executa a véspera legada.
- `syncKommoParaCnn(env, dryRun)` — **A2** delta Kommo→CNN.
- `syncCnnParaKommo(env, dryRun, target, budget, windowDays)` — **A3 legado** (offset+orçamento; usado por `/debug-a3`).
- `backfillCadastros(env, dryRun, soTeste, target, budget, windowDays)` — **A4 legado** (usado por `/debug-a4`).
- `cronSyncStatus(env)` — **C2** sync legado completo.
- `cronVespera(env, dryRun, target, dataAlvo)` — **F2 legado** (usado por `/debug-f2`).

## 14.8 Fila de trabalho (a nova arquitetura — alvo do flip)
- `produtorBackfill(env, target, windowDays, soTeste)` — enfileira A4 (1/paciente não-mapeado, B-first).
- `consumirItemA4(item, env, target, dryRun): {r,leadId,nome}` — vincula ou cria card.
- `produtorSync(env, target, windowDays)` — enfileira A3 (agendas mapeadas com mudança).
- `consumirItemA3(item, env, target, dryRun): {r,leadId,nome}` — baseline ou move por status/hora.
- `produtorVespera(env, target, dataAlvo?)` — enfileira F2 (leads de amanhã, B-first, não-lembrados).
- `consumirItemF2(item, env, target, dryRun): {r,leadId,nome}` — move p/ confirmação + registra lembrete.
- `consumirFila(env, target, dryRun, cap, budget)` — puxa lote, despacha por `tipo`, marca, para no orçamento.

## 14.9 Endpoints de diagnóstico (handlers)
- `handleTestWorkflow(req, env)` — auditoria/simulação por telefone (ações audit/primer/run-w1/run-c1/reset/...).
- `handleDebugC1(env)` / `handleDebugScale(env)` — dry-run C1 / validação de escala.
- `handleDebugCnnShape(req, env)` — tipos + enums de status + preview de roteamento.
- `handleDebugCount(env)` — contagem leads por pipeline×etapa (com guarda).
- `handleDebugCriarAgenda(req, env)` — cria agenda de teste no sandbox (allowlist).
- `handleDebugBackfillPreview(req, env)` — prévia do backfill por dia (CSV-ready; `skipnames` p/ 2-pass).
- `handleDebugRaw(req, env)` — inspeção crua da paginação CNN.
- `handleDebugAgendas(req, env)` — lista agendas de um dia.

## 14.10 Auth + export
- `webhookAuthOk(req, env): boolean` — `?secret=` == WEBHOOK_SECRET (webhooks).
- `discoverAuthOk(req, env): boolean` — header `Authorization` == WEBHOOK_SECRET (debug/discover).
- `export default { fetch, scheduled }` — roteamento HTTP + dispatcher do cron.

---

# PARTE 15 — PENDÊNCIAS E PRÓXIMOS PASSOS (consolidado e priorizado)

## 15.1 Pendência IMEDIATA (o único passo que falta para "ligar")
- [ ] **Flip do cron** (aguardando OK do dono): trocar `scheduled()` pelo dispatcher de fila e
      `wrangler.toml` crons → `["* * * * *"]`; aposentar C1/C2. Detalhado na Parte 11.3 e 12.
      Antes: limpar a fila; depois: monitorar a 1ª hora (baseline sobe e desce, 0 erros).

## 15.2 Decisões do dono que destravam comportamento real (antes/junto do flip)
- [ ] OK para o **baseline do A3 sobrescrever `AGENDAMENTO`** dos leads vinculados com a hora do CNN.
- [ ] OK para **A3 mover etapa** (FINALIZADO→Avaliação, CANCELADO→…) e **F2 mover p/ Confirmação**.
- [ ] Confirmar **janela de sync = 14 dias** (−2/+14).

## 15.3 Pendências de MÉDIO prazo
- [ ] **Liberar escrita CNN em produção** → ativar A1/W1, W2 e A2 (hoje inertes por §7.8). Hoje, em
      produção, o fluxo é só CNN→Kommo; ações que escrevem no CNN ficam desligadas.
- [ ] **Configurar os webhooks no Kommo** apontando para `/webhook/lead-agendado` e `/webhook/confirmacao`
      (com `?secret=`), para A1/W1 e W2 dispararem de verdade.
- [ ] **Refresh OAuth do Kommo** usando `KOMMO_CLIENT_SECRET` (+ client_id, redirect_uri, refresh_token):
      renovar o `KOMMO_ACCESS_TOKEN` automaticamente em 401 (hoje é token long-lived que pode expirar).

## 15.4 Itens do escopo mãe ainda NÃO construídos
- [ ] **Função 3 — movimentação por orçamento** (`/orcamento/lista`): APROVADO→Pós-Venda "Tratamento
      Iniciado"; ABERTO→Pós-consulta "Análise"; precedência (aprovado vence). Nunca chamado hoje.
- [ ] **Etapa "Importado CNN"** (escopo §8.5) para paciente tocado por evento mas **sem agenda ativa**.
- [ ] **Função 4 — reconciliação de campos cadastrais** nos 3 estados (vazio/tem/tem-tem) CNN↔Kommo.
- [ ] **Sufixo `(duplicata)`** no nome do lead quando o mesmo telefone tem 2 pacientes (hoje só flag no D1).
- [ ] **Lock por lead** (§10.3) — evitar corrida webhook×cron no mesmo lead (a fila já serializa muito disso).

## 15.5 Limpeza / dívida técnica
- [ ] Remover endpoints `/debug-*` de teste após estabilização (manter health, webhooks, discover,
      `/debug-tick`, `/debug-audit`).
- [ ] Remover funções legadas C1/C2 e os caminhos de offset (`a3_offset`/`a4_offset`) quando a fila
      estiver consolidada.
- [ ] Corrigir os 2 avisos `tsc` pré-existentes (`implicit any` em `p`) e `dayRangeBRT`/`cursor` não usados.
- [ ] Podar periodicamente linhas `feito` da `fila_trabalho` e `auditoria` antigas (housekeeping).

## 15.6 Verificações de operação recomendadas
- [ ] Após o flip, conferir no Kommo que o baseline **não moveu** etapas indevidamente.
- [ ] Validar a 1ª véspera real (15h BRT) movendo os leads corretos por grupo.
- [ ] Acompanhar `auditoria` por `*-erro` nos primeiros dias.

---

# PARTE 16 — ANEXO TÉCNICO PROFUNDO

> **Em linguagem simples:** "dispatcher" = o "maestro" que, a cada minuto, decide o que rodar (qual
> produtor + os consumidores). "pós-flip" = depois que ligarmos a arquitetura nova no cron (o "flip"
> é a troca do código antigo pelo novo no agendador). "cold start" = a primeira vez que liga, com o
> banco ainda sem anotações. As "simulações" abaixo mostram, passo a passo, quantas chamadas de
> internet cada execução faria — para provar que nunca passa de 50.

## 16.1 O dispatcher pós-flip (código exato proposto)
```ts
async scheduled(event, env, ctx) {
  ctx.waitUntil((async () => {
    resetSubreq();                                    // zera contador de fetch do tick
    const target = "production";
    const now = new Date(event.scheduledTime ?? Date.now());
    const minU = now.getUTCMinutes(), hourU = now.getUTCHours();   // BRT = hourU - 3
    try {
      if (hourU === 18 && minU % 10 === 0)      await produtorVespera(env, target);      // 15h BRT
      else if (minU % 10 === 0)                 await produtorSync(env, target, 14);
      else if (minU % 30 === 15)                await produtorBackfill(env, target, 14, false);
    } catch (e) { await audit(env, {funcao:"DISPATCH", ambiente:target, acao:"produtor-erro", detalhe:String(e)}); }
    try { await consumirFila(env, target, false, 10, 40); }
    catch (e) { await audit(env, {funcao:"DISPATCH", ambiente:target, acao:"consumidor-erro", detalhe:String(e)}); }
  })());
}
```

## 16.2 Simulação minuto-a-minuto (estado estável, dia útil)
| Minuto UTC | Produtor | Fetch produtor | Consumidor (10) | Fetch tick | Total |
|---|---|---|---|---|---|
| :00 | produtorSync(14d) | ~3 (paginação) | 10 itens (delta pequeno) | ~10 | ~13 |
| :05 | nenhum | 0 | 10 | ~10 | ~10 |
| :15 | produtorBackfill(14d) | ~3 | 10 | ~10 | ~13 |
| 18:00 | produtorVespera | ~1 | 10 (F2 moves) | ~10 | ~11 |
Nenhum cenário passa de ~40 — sempre **< 50**. Pior caso teórico (produtor pesado + 10 criações):
~3 + 10×3 = ~33. Margem garantida pelo `budget=40` (consumidor para antes).

## 16.3 Simulação da 1ª hora pós-flip (cold start)
- **t=0** (1º `produtorSync`): enfileira ~420 itens A3 como **baseline** (nenhum tem `agenda_sync` ainda).
- **t=0..~42min**: consumidores processam 10/min → todos viram **baseline** (gravam `agenda_sync`,
  setam `AGENDAMENTO`), **0 moves de etapa**.
- **t≈10,20,30,40,50min**: `produtorSync` re-roda; como já há baseline e nada mudou no CNN, enfileira
  ~0 (`sem_mudanca`).
- **Resultado:** a 1ª hora é uma varredura silenciosa; **nenhuma movimentação em massa**. A partir daí,
  só transições reais de status movem etapa.
- **Se o flip cair às 18h UTC:** a véspera de amanhã dispara junto (comportamento desejado).

## 16.4 Matemática do backfill (já executado)
- Janela 90d ≈ 639 agendas → após filtrar interna/tipo/ano e dedup por paciente ≈ ~350 candidatos.
- ~88% já tinham lead → **vínculo** (1 fetch); ~12% **criação** (3 fetch).
- A 10-12 itens/tick no cron de 1 min → ~35-50 min de escoamento. **Resultado real:** 350 mapeados,
  52 criados (20 A + 32 B), 0 erros.

## 16.5 Invariantes de correção (o que NUNCA pode acontecer, e o que garante)
| Invariante | Garantia |
|---|---|
| Nenhum tick estoura 50 fetch | `budget=40` + 1 produtor/tick + `bumpSubreq` em todo wrapper |
| Card de paciente nunca duplica | `mapeamento` (PK paciente) + re-check no consumidor |
| Lembrete de véspera nunca repete no mesmo dia | `lembrete_d1` (lead+data) checado no produtor E no consumidor |
| Worker nunca rebate a própria escrita (eco) | baseline em `agenda_sync` |
| Escrita no CNN de produção é impossível | `assertCnnWritable` lança erro |
| Item que falha não some | `filaMarcarErro` → volta a pendente até 4×, depois `erro` (auditável) |
| Tarefa interna nunca vira card | `isTarefaInterna` no produtor |
| Tipo desconhecido nunca é roteado errado | `grupoDaAgenda` retorna null → ignora |

## 16.6 Casos de borda tratados
- **Paciente com A e B no mesmo dia:** desempate B-ganha no produtor (1 card/item, em Pós-Venda).
- **Mesmo paciente em várias agendas:** dedup por paciente (A4) / por agenda (A3) / por lead-dia (F2).
- **Telefone com/sem DDI/9º dígito:** `phoneKey` casa os formatos (sem duplicar).
- **Agenda cancelada na véspera:** `STATUS_TERMINAL` exclui do F2; A3 move para o destino de cancelado.
- **Remarcação durante confirmação:** A3 detecta mudança de hora → volta o lead p/ etapa-base.
- **Nome não resolve (rate-limit):** `cnnPacienteNome` 3× + backoff; pior caso card vira "Paciente CNN <id>".
- **CNN/Kommo fora do ar no tick:** `try/catch` no produtor e consumidor; auditoria registra; próximo tick retoma.
- **Lista de agendas muda entre ticks:** fila por chave estável (não offset) → sem pular/duplicar.

## 16.7 Como reproduzir/validar localmente (sem agendador)
- `GET /debug-tick?env=production&dry=1&prod=1&job=sync&window=14` — simula 1 tick de sync, mede subreq/CPU.
- `GET /debug-tick?env=production&dry=1&prod=1&job=vespera&data=YYYY-MM-DD` — simula a véspera de um dia.
- `GET /debug-tick?env=production&dry=0&cap=10` — processa 1 lote real da fila.
- `GET /debug-audit` — confere ações gravadas, fila e mapeamento total.
- `GET /debug-tick?...&clear=1` — limpa a fila (reset de teste).

## 16.8 Premissas e riscos residuais
- **Token Kommo long-lived** pode expirar → integração para silenciosamente até renovar (mitigação
  planejada: refresh OAuth com `KOMMO_CLIENT_SECRET`).
- **Sweep eventualmente consistente:** uma mudança no CNN reflete no Kommo em até ~10-15 min (não é
  tempo real) — aceitável para o negócio.
- **`AGENDAMENTO` sobrescrito pelo baseline:** o campo no Kommo passa a refletir a hora do CNN (CNN
  prevalece) — desejado, mas é escrita em leads existentes.
- **Escrita CNN desligada em prod:** enquanto §7.8 vigorar, ações Kommo→CNN (criar/remarcar/confirmar)
  não acontecem em produção; o fluxo é de mão única CNN→Kommo.

---

# PARTE 17 — CONTRATOS DE API (payloads reais)

> **Em linguagem simples:** "contrato de API" = o formato exato das mensagens trocadas com CNN/Kommo —
> o que mandar e o que volta. "payload" = o corpo (conteúdo) da mensagem, normalmente em JSON. "autenticação"
> = como o programa prova que tem permissão (usuário/senha ou token). Esta parte serve para quem for
> debugar ou reconstruir: mostra os pedidos reais que o programa faz.

## 17.1 CNN — autenticação
Todo request CNN leva: `Authorization: Basic base64(USER:PASS)` + header `clinicaNasNuvens-cid: <CID>`
+ `Content-Type: application/json`. Sandbox usa o trio sem sufixo; produção usa o `_PRODUCTION`.

## 17.2 CNN — endpoints usados
| Necessidade | Método/Path | Observações |
|---|---|---|
| Listar agendas | `GET /agenda/lista?dataInicial=&dataFinal=&registrosPorPagina=&pagina=` | capa 100/pág; paginação 0-indexed; `totalPaginas` confiável; **não traz nome** |
| Ler 1 agenda | `GET /agenda/{id}` | campos completos (sem nome) |
| Criar agenda | `POST /agenda/novo` | exige `idPacienteConvenio` |
| Remarcar | `POST /agenda/{id}/remarcar` | campos `novaData`,`novoHorarioInicial`,`novoHorarioFinal` |
| Alterar status | `PUT /agenda/alteracao-status` | `{idAgenda, status}` |
| Tipos de consulta | `GET /tipo-consulta/lista?registrosPorPagina=&pagina=` | `{lista:[{id,nome,reconsulta,ativo}]}` |
| Tipos de procedimento | `GET /tipo-procedimento/lista?tipo=TODOS` | — |
| Paciente | `GET /paciente/{id}`, `GET /paciente/lista?nomeContem=`/`?telefoneCelularContem=`, `POST /paciente/novo` | nome via `/{id}` |
| Convênio | `POST /convenio-paciente/associar`, `GET /convenio-paciente/lista?idPaciente=&somenteAtivos=true` | — |
| Info | `GET /info` | dados da clínica |

**Objeto de agenda (campos reais retornados):** `id, idPessoaExecutor, idPaciente, idOrigemPaciente,
idTipoConvenio, idTipoConsulta, idLocalAgenda, status, data, horaInicio, horaFim, observacoes,
telefoneCelularPaciente, emailPaciente, encaminhamento, urlSalaEspera, idRotulo, procedimentos[]`.
**Não há `nomePaciente`.** `idRotulo` é sempre null nesta clínica.

**Status (enums reais da API):** `AGENDADO, CONFIRMADO_PACIENTE, CONFIRMADO, FINALIZADO, FALTOU,
CANCELADO, CANCELADO_PACIENTE, EM_ESPERA` (+ operacionais não mapeados).

**Body real de `POST /agenda/novo`:**
```json
{ "data": "2026-06-29", "horaInicio": "10:00:00", "horaFim": "10:30:00",
  "idPaciente": 28146949, "idPacienteConvenio": 24808788,
  "idTipoConsulta": 110454, "idLocalAgenda": 41170, "status": "AGENDADO",
  "procedimentos": [{ "idTipoProcedimento": 1011844, "quantidade": 1 }] }
```

## 17.3 Kommo — autenticação e endpoints
`Authorization: Bearer <KOMMO_ACCESS_TOKEN>`. Base `https://atendimentoclinicabergmanncombr.kommo.com/api/v4`.

| Necessidade | Método/Path |
|---|---|
| Funis+etapas | `GET /leads/pipelines?with=statuses` |
| Listar leads (correto) | `GET /leads?filter[statuses][0][pipeline_id]=P&filter[statuses][0][status_id]=S&limit=250&page=N` |
| Delta | `GET /leads?filter[updated_at][from]=<unix>` |
| Ler lead | `GET /leads/{id}?with=contacts` |
| Mover/editar lead | `PATCH /leads/{id}` `{status_id, pipeline_id, custom_fields_values}` |
| Criar lead+contato | `POST /leads/complex` |
| Buscar contato | `GET /contacts?query=<telefone>&with=leads` |
| Campos customizados | `GET /leads/custom_fields?limit=250`, `GET /contacts/custom_fields?limit=250` |

**Body real de `POST /leads/complex` (criação de card no backfill):**
```json
[{ "name": "REGINA DA SILVA LEMOS RIBEIRO",
   "pipeline_id": 13950431, "status_id": 107658911,
   "custom_fields_values": [
     { "field_id": <AGENDAMENTO>, "values": [{ "value": 1781960400 }] },
     { "field_id": <ID Agenda CNN>, "values": [{ "value": "129079590" }] },
     { "field_id": <ID Paciente CNN>, "values": [{ "value": "8797270" }] }],
   "_embedded": { "contacts": [{ "name": "REGINA…",
     "custom_fields_values": [{ "field_code": "PHONE", "values": [{ "value": "51999778050", "enum_code": "WORK" }] }] }] } }]
```

**Webhook recebido do Kommo (urlencoded, NÃO json):** campos como `leads[status][0][id]`, `status_id`,
`old_status_id`, `pipeline_id`, `account[subdomain]`. O Worker faz `new URLSearchParams(await req.text())`
e lê `leads[status][0][id]`.

---

# PARTE 18 — TRECHOS DE CÓDIGO CENTRAIS (verbatim)

> **Em linguagem simples:** "verbatim" = copiado exatamente do código-fonte (não é resumo). Esta parte
> é para quem programa: mostra, na íntegra, as 6 funções mais importantes. Se você não lê código, pode
> pular — o que elas fazem já está explicado em palavras nas Partes 0.5, 1 e 5.

## 18.1 Trava de escrita CNN-produção (§7.8)
```ts
function assertCnnWritable(target, method, path) {
  if (target === "production")
    throw new Error(`BLOQUEADO §7.8: ${method} ${path} — escrita no CNN de produção proibida (chave _PRODUCTION é só leitura)`);
}
// chamada no início de cnnPost e cnnPut, antes do fetch
```

## 18.2 Normalização de telefone (§7.1)
```ts
function phoneKey(p) {
  let d = (p ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);   // tira DDI
  if (d.length >= 10) return d.slice(0, 2) + d.slice(2).slice(-8); // DDD + últimos 8 (ignora 9º dígito)
  return d.slice(-8);
}
// 555198108-2873, 5181082873 e 51981082873 → todos "5181082873"
```

## 18.3 Detecção de tarefa interna
```ts
function isTarefaInterna(agenda) {
  const t = normalizePhone(agenda?.telefoneCelularPaciente ?? "");
  if (t.length < 10) return true;            // vazio/curto
  if (new Set(t.split("")).size <= 2) return true; // ≤2 dígitos distintos (ex.: 51111111111)
  return false;
}
```

## 18.4 Roteamento por grupo
```ts
const GRUPO_A_TIPOS = new Set(["atendimento social", "consulta/avaliacao"]);
const GRUPO_B_TIPOS = new Set(["cirurgia","cortesia","encaixe","encaminhamento - interno",
                               "pequenas cirurgias","procedimento","retorno"]);
function grupoDaAgenda(agenda, tiposMap) {
  const nome = tiposMap[String(agenda?.idTipoConsulta ?? "")];
  if (!nome) return null;
  if (GRUPO_A_TIPOS.has(nome)) return "A";
  if (GRUPO_B_TIPOS.has(nome)) return "B";
  return null; // desconhecido → não faz nada
}
```

## 18.5 Lookup de nome com retry (contorna rate-limit do CNN)
```ts
async function cnnPacienteNome(idPaciente, env, target) {
  for (let i = 0; i < 3; i++) {
    try { const p = await cnnGet(`/paciente/${idPaciente}`, env, target); if (p?.nome) return p.nome; return null; }
    catch { await new Promise(r => setTimeout(r, 250 * (i + 1))); } // backoff 250/500/750ms
  }
  return null;
}
```

## 18.6 Consumidor da fila (laço com orçamento)
```ts
const lote = await filaPuxarPendentes(cap, env);
for (const item of lote) {
  if (!orcamentoOk(budget)) { out.parou_orcamento = true; break; } // para sob 50 fetch
  try {
    let res = { r: "tipo_desconhecido" };
    if (item.tipo === "A4") res = await consumirItemA4(item, env, target, dryRun);
    else if (item.tipo === "A3") res = await consumirItemA3(item, env, target, dryRun);
    else if (item.tipo === "F2") res = await consumirItemF2(item, env, target, dryRun);
    if (!dryRun) { await filaMarcarFeito(item.id, env); /* + audit se criado/movido */ }
  } catch (e) { if (!dryRun) await filaMarcarErro(item.id, item.tentativas ?? 0, String(e), env); }
}
```

---

# PARTE 19 — DIAGRAMA DE FLUXO (ponta a ponta)

```
                         ┌──────────────────────── CLOUDFLARE WORKER (free) ────────────────────────┐
                         │                                                                           │
  CNN (clínica) ──GET──► │  cron 1min → scheduled():                                                 │
  /agenda/lista          │     resetSubreq()                                                         │
  /tipo-consulta/lista   │     ├─ PRODUTOR (1/tick): produtorSync | produtorVespera | produtorBackfill│
  /paciente/{id}         │     │     coleta janela CNN → enfileira em D1 (idempotente, B-first)       │
  (PROD = só leitura)    │     └─ CONSUMIDORES (todo tick): puxa lote ≤10 da fila                     │
                         │           ├─ A4: vincula/cria card ──PATCH/POST──► KOMMO                   │
  CNN (escrita) ◄──✗──── │           ├─ A3: baseline / move etapa ──PATCH──► KOMMO                    │
  (bloqueado §7.8:       │           └─ F2: move p/ confirmação ──PATCH──► KOMMO                      │
   A1/W1, W2, A2)        │                                                                           │
                         │     orçamento: para em ~40 fetch (teto free = 50)                          │
                         │                                                                           │
                         │   D1 (env.DB): fila_trabalho · mapeamento · agenda_sync ·                  │
                         │                lembrete_d1 · cursores · auditoria                          │
                         │                                                                           │
  KOMMO ──webhook──────► │  fetch(): /webhook/lead-agendado (A1/W1) · /webhook/confirmacao (W2)       │
  (urlencoded)           │           /debug-* (diagnóstico) · /discover · /health                     │
                         └───────────────────────────────────────────────────────────────────────────┘

  Direção em PRODUÇÃO hoje: CNN ──(leitura)──► Worker ──(escrita)──► Kommo   (mão única)
  Quando escrita CNN for liberada: Worker ──► CNN (A1/W1 cria, A2 remarca, W2 confirma)
```

**Legenda do ciclo de vida de um paciente:**
1. Paciente tem agenda no CNN → **produtorBackfill/Sync** enfileira.
2. **consumirItemA4** cria/vincula o card no funil do grupo (A=Captação, B=Pós-Venda).
3. Status muda no CNN → **produtorSync** enfileira → **consumirItemA3** move a etapa.
4. Véspera (15h BRT) → **produtorVespera** enfileira → **consumirItemF2** move p/ confirmação → Salesbot dispara WhatsApp.
5. Tudo registrado em `auditoria`; idempotência impede repetição.

---

*Fim da especificação. Para o objetivo/escopo "do que deve ser", ver `novo arquivo mae escopo.md`;
para o snapshot operacional, ver `INVENTARIO.md`.*

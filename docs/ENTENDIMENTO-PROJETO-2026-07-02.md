# Entendimento Unificado — Integração Kommo ↔ Clínica nas Nuvens (CNN)

> Síntese de 9 documentos (19/06 a 02/07) cruzada contra o `CLAUDE.md` durável e o `BACKLOG.md` de auditoria. Onde os docs divergem do estado atual, a **verdade é o CLAUDE.md + o contexto do controlador**: flip no ar (29/06), Reflexo de Orçamento no ar (01/07), correções de concorrência/resiliência aplicadas (02/07).

---

## 1. O que é o projeto

Um **Cloudflare Worker (plano Free, arquivo único `src/index.ts`) + banco D1** que **espelha, no CRM Kommo, o estado real dos pacientes que vive na Clínica nas Nuvens (CNN)** — agendas, status de consulta e orçamentos —, movendo cada lead para a etapa certa dos funis do Kommo. A CNN é a **fonte da verdade** e **não emite webhooks**, então todo o sentido **CNN→Kommo é por polling/reavaliação**; o Kommo emite webhooks. A arquitetura atual é **produtor/consumidor com fila em D1** (`fila_trabalho`): produtores leem a CNN e enfileiram unidades de trabalho idempotentes; um consumidor drena em micro-ticks a cada minuto, respeitando o teto de **50 sub-requests/invocação** (D1 não conta). Direção é **unilateral CNN→Kommo**: a chave de produção da CNN é **só-leitura** (§7.8, imposto por `assertCnnWritable`); nada é escrito na CNN em produção.

---

## 2. Glossário de domínio

### Funis (pipelines Kommo)
| Funil | Pipeline ID | Papel | Grupo |
|---|---|---|---|
| **Captação** | `13847079` | Aquisição / primeira consulta | **A** |
| **Pós-Venda** | `13950431` | Cliente já em tratamento | **B** |
| **Pós-Consulta** | `13947295` | Intermediário; **antes sem uso**, passou a ser usado pelo **Reflexo de Orçamento** (Em Análise / Venda Perdida) | — |

### Etapas-chave (status_id)
**Captação (13847079):** `106848271` leads de entrada · `106848615` primeiro contato (também estado de reset em reagendamento) · `106848619` consulta agendada · `107785399` confirmação de consulta (gatilho Salesbot) · `106848623` consulta confirmada · `106848627` avaliação realizada · `106848631` tratamento proposto · `107789355` follow-up · `142` fechado · `143` **cancelada–perdido**.
**Pós-Venda (13950431):** `107658903` leads · `107658907` **tratamento iniciado** · `107658911` **cliente ativo** (etapa-base) · `107974651` **confirmação de agendamento** · `107658915` saldo pendente · `107860123` procedimento delicado · demais · `143` venda perdida.
**Pós-Consulta (13947295):** `107633739` **em análise** (orçamento ABERTO) · `143` **venda perdida** (orçamento CANCELADO/PERDIDO).
> `143` (perdido) e `142` (ganho) são **genéricos em todo funil** → sempre escopar por `pipeline_id`.

### Grupos A vs B (definidos pelo **tipo da agenda**, resolvido por NOME em runtime — os IDs de tipo diferem entre sandbox e produção)
- **Grupo A → Captação:** `atendimento social`, `consulta/avaliação`.
- **Grupo B → Pós-Venda:** `retorno`, `encaixe`, `procedimento`, `cirurgia`, `pequenas cirurgias`, `cortesia`, `encaminhamento-INTERNO`.
- **Tipo desconhecido →** `grupoDaAgenda=null` → **não faz nada** (futura etapa "Importado CNN" seria o fallback, não construída).

### Funções
- **W1** (`handleLeadAgendado`, webhook) — Kommo→CNN: cria paciente+agenda na CNN e grava IDs de volta. **Escreve CNN → inerte em produção.**
- **W2** (`handleConfirmacao`, webhook Salesbot) — Kommo→CNN: marca `CONFIRMADO_PACIENTE`, move p/ consulta confirmada. **Inerte em produção.**
- **A2** (`syncKommoParaCnn`) — Kommo→CNN delta (remarcação). **Inerte em produção.**
- **A3** (`produtorSync`+`consumirItemA3`) — **ATIVO**, CNN→Kommo: reflete status/hora da agenda na etapa do card por grupo (`MAPA_STATUS`); 1ª vez = baseline (não move).
- **A4 / backfill** (`produtorBackfill`+`consumirItemA4`) — **ATIVO**: vincula paciente CNN a lead existente (por telefone) ou cria card; agora com camada de **retry** (`fetchComRetry`).
- **F2 / véspera** (`produtorVespera`+`consumirItemF2`) — **ATIVO**: na véspera move o lead para a etapa de confirmação do grupo (dispara WhatsApp).
- **ORC / Reflexo de Orçamento** (`produtorOrcamento`+`consumirItemOrcamento`+`decidirEtapaOrcamento`) — **ATIVO (01/07)**: reflete status do orçamento CNN no funil.
- **C1/C2** — crons legados (lembrete D-1 / sync 10min) — **APOSENTADOS no flip**.

### Entidades D1
`mapeamento` (identidade paciente↔lead) · `agenda_sync` (baseline anti-eco por agenda) · `orcamento_sync` (estado do reflexo de orçamento por paciente) · `lembrete_d1` (idempotência da véspera, 1×/lead/dia) · `fila_trabalho` (fila; **agora com `locked_at` e status `processing`**) · `auditoria` · `cursores` (watermarks; reusa linha `tick_lease` para o lease de tick) · `agendamento_sync` (legado).

---

## 3. Ciclo de vida de um lead

1. **Entrada / Captação (A):** lead novo em "primeiro contato". Quando marcado "consulta agendada", **W1** (quando a escrita CNN estiver liberada) cria paciente+agenda na CNN.
2. **Reflexo do agendamento (A3/A4):** a CNN é a fonte — o backfill/sync **vincula por telefone** ou cria o card no funil do **grupo do tipo da agenda** (A→Captação/consulta agendada; B→Pós-Venda/cliente ativo). 1ª vez = baseline (não move).
3. **Véspera (F2, 15h BRT):** leads com consulta amanhã sobem para a etapa de confirmação do grupo (A→`107785399`; B→`107974651`), disparando o **Salesbot/WhatsApp**. Idempotente por `lembrete_d1`.
4. **Confirmação (W2):** paciente confirma → CNN `CONFIRMADO_PACIENTE` → card em "consulta confirmada".
5. **Pós-consulta (A3):** agenda `FINALIZADO` → "avaliação realizada"; se há plano de tratamento → "tratamento proposto".
6. **Reflexo de orçamento (ORC):** para lead **sem agenda futura** e em etapa "assentada": ABERTO→Pós-Consulta/Em Análise; APROVADO→**Pós-Venda/Tratamento Iniciado** (vira cliente); CANCELADO/PERDIDO→Pós-Consulta/Venda Perdida. **Reativa** lead "Perdido" que recebeu aprovado.
7. **Ciclo Pós-Venda (B):** estado-base **Cliente Ativo**; na véspera de agenda B → **Confirmação de Agendamento** → volta a **Cliente Ativo**. Cancelamento B **não perde** o lead (segue Cliente Ativo). Cancelamento A → **Cancelada–Perdido (143)**.

**Precedência agenda × orçamento:** enquanto há **agenda futura** (`AGENDADO`/`CONFIRMADO_PACIENTE`, data ≥ hoje), o **A3/F2 mandam** e o **ORC não age** (portão `temAgendaFutura`). Quando as agendas acabam, o ORC assume. Precedência natural, não codificada no A3.

---

## 4. Mapa das funcionalidades (estado)

| Funcionalidade | O que faz | Estado |
|---|---|---|
| **A3 — sync status/hora** | Reflete status/hora da agenda na etapa por grupo | **No ar** |
| **A4 — backfill/vínculo** | Vincula ou cria card CNN→Kommo (B-first) | **No ar** |
| **F2 — véspera/confirmação** | Move p/ confirmação e dispara WhatsApp | **No ar** |
| **ORC — reflexo de orçamento** | APROVADO→Tratamento Iniciado; ABERTO→Análise; cancel→Perdido; recência 60d; reativa "Perdido" | **No ar (01/07)** |
| **Fila em D1 + dispatcher (flip)** | Cron `* * * * *`; produtores + consumidor | **No ar (29/06)** |
| **Claim atômico / retry / dead-letter / lease** | `filaClaimLote`, `fetchComRetry`, `/debug-fila-erros`, `adquirirLease` | **Corrigido 02/07** (testado-local; alguns itens deploy-gated no lote [C1,A4,A5,B2]) |
| **Trava de escrita CNN** | `assertCnnWritable` bloqueia POST/PUT em produção | **No ar (defensivo)** |
| **W1 / W2 / A2** | Escrita Kommo→CNN | **Inertes em produção** (§7.8; webhooks Kommo ainda não configurados) |
| **Modelo de DUPLICATA (A+B, 2 cards)** | Redesign que substitui "B-vence" | **Planejado — não deployado** (design aprovado, aguardando review) |
| **Item 2 — sync bidirecional (escreve CNN)** | W1/W2 + reconciliação por polling | **Planejado / sandbox-first** |
| **Etapa "Importado CNN", Função 4 (reconciliação), refresh OAuth Kommo, sufixo "(duplicata)" no nome** | — | **Roadmap** |
| **Fan-out/sharding** | Paralelismo de drenos | **PAUSADO** (bugs de concorrência achados na auditoria) |

---

## 5. O que está DEFASADO nos docs (doc-vs-CLAUDE.md)

- **Flip não feito / crons legados.** ESPECIFICACAO (06-27), INVENTARIO (06-23), TESTES (06-19) e Plano Fase 1 (28/06) descrevem `scheduled()` rodando **C1/C2** com crons `0 18 * * *` e `*/10 * * * *`. **Atual:** cron `* * * * *`, dispatcher (`produtorVespera/Sync/Orcamento`+`consumirFila`), C1/C2 aposentados (`scheduled()` ~4157).
- **Função 3 / orçamento "não construída".** ESPECIFICACAO e o Design fundacional (§9 "fora de escopo") marcam o reflexo de orçamento como não-feito. **Atual:** implementado 01/07 (`decidirEtapaOrcamento` ~802, `orcamentosRecentes` recência 60d ~820, `orcamento_sync`, reativar "Perdido"). O funil **Pós-Consulta 13947295**, dado como "sem uso" em vários docs, **passou a ser usado** pelo ORC (Em Análise `107633739` / Venda Perdida `143`).
- **Fila descrita como `filaPuxarPendentes` (SELECT puro).** ESPECIFICACAO trata isso como o caminho real. **Atual:** caminho real é **`filaClaimLote`** (claim atômico `UPDATE…RETURNING`, `status='processing'`, `locked_at`); `filaPuxarPendentes` virou **peek de dry-run**. Também novos: **retry/backoff** (`fetchComRetry`, A4), **dead-letter observável** (`/debug-fila-erros`, `/debug-fila-requeue`), **lease de tick** (`tick_lease`, B2) — nenhum consta nos docs.
- **Modelo de duplicata inexistente na spec-mãe.** Escopo-mãe (22/06) e ESPECIFICACAO (06-27) **negam** duplicata entre funis: invariante "1 card por paciente", desempate **B-vence**; "duplicata" ali = **flag de colisão de telefone**. O **redesign 2026-06-29** introduz duplicata A+B intencional (chave composta `(paciente, grupo)`), mas **ainda não deployado** — produção segue **card único movido entre funis** (CLAUDE.md invariantes "0 duplicata / 1 paciente = 1 lead"; doc do ORC: "o MESMO card é movido via `moveLeadToStage`").
- **Recência de 60d.** A spec do ORC (§4/§9) decide o "mais recente" por data de criação/maior id, **sem** os 60d; CLAUDE.md/decisões 01-07 **refinam** com `orcamentosRecentes` (descarta APROVADO com `dataAprovacao > 60d`).
- **Números de linha e tamanho do arquivo.** ESPECIFICACAO cita ~2.595 linhas; CLAUDE.md já referencia ~4157. Todos os "~linha" nos docs estão defasados.
- **Concorrência assumida como resolvida.** Docs assumem `subreqUsados`/`orcamentoOk` confiáveis; auditoria 02-07 marca `subreqUsados` como **global de módulo não-confiável sob concorrência** (mitigado por lease B2 + claim C1). **Fan-out/sharding PAUSADO.**
- **Ambiguidade empírica de duplicata.** A **AUDITORIA 06-30** observou **124 pacientes com card em Captação E Pós-Venda** simultâneos em produção — apesar de o modelo de duplicata não estar deployado e de o invariante ser "0 duplicata". Provável leitura: o invariante vale **dentro do mesmo funil**, e os pares A+B surgiram como efeito do backfill. **Ponto em aberto**, sinalizado pela própria auditoria.

---

## 6. INSIGHT para a decisão pendente — cliente (orçamento APROVADO) que ganha NOVO AGENDAMENTO

**Pergunta:** paciente já é cliente Pós-Venda (orçamento aprovado → Tratamento Iniciado). Surge um novo agendamento. Rotear como **A (Captação)** ou **B (Pós-Venda)**?

### Princípio que atravessa TODOS os docs: roteia-se pelo **TIPO da agenda**, nunca pelo status de cliente
`grupoDaAgenda()` classifica cada agenda por nome do tipo. Isso é afirmado igualmente no escopo-mãe (22/06), na ESPECIFICACAO (§ roteamento por tipo, refinado 2×), no DIARIO/INVENTARIO ("Grupo B = quem já é paciente/cliente e volta"), na AUDITORIA 06-30 (100% roteado por tipo) e nos Planos Fase 1/Fase 2. **Consequência direta:** a resposta depende do **tipo do novo agendamento**, não de "ele já é cliente".

### Caso 1 — novo agendamento é de tipo **Grupo B** (retorno, procedimento, encaixe, cirurgia…): rotear como **B**. Sem conflito.
É o caso **natural e majoritário** de um cliente em tratamento: os próprios tipos B **significam** "paciente que já é cliente e volta" (DIARIO). O card fica/vai para **Cliente Ativo (`107658911`)**, na véspera sobe para **Confirmação de Agendamento (`107974651`)** e volta a Cliente Ativo (ciclo do Pós-Venda descrito na ESPECIFICACAO, no Design fundacional e na AUDITORIA). **Este é o comportamento correto e já implementado.** Nuance a vigiar: o card pode estar em **Tratamento Iniciado** (`107658907`, posto pelo ORC); a regra B do sync "garante Cliente Ativo" **não deve rebaixar** Tratamento Iniciado — a idempotência ("move só quando o alvo muda") e a stickiness do card B protegem, mas o ORC deixa de reasfaltar Tratamento Iniciado assim que há agenda futura (portão `temAgendaFutura`), então na prática o card passa a ser conduzido pelo ciclo de agenda. Aceitável, mas **é um ponto que precisa de guarda explícita** (risco citado na §10 do spec de duplicata).

### Caso 2 — novo agendamento é de tipo **Grupo A** (consulta/avaliação/atendimento social): é o caso difícil.
Um cliente que marca uma **nova avaliação** (tipo A). Aqui os dois modelos divergem:

- **Produção atual (card único, "0 duplicata"):** o A3 moveria o **mesmo card** do cliente de volta para **Captação/Consulta Agendada**, **rebaixando um cliente a lead de captação**. Isso é indesejável e é exatamente a dor que motivou o redesign. (Doc do ORC deixa explícito que hoje "o MESMO card é MOVIDO entre funis"; logo, no modelo vigente, A e B **competem pelo mesmo card**.)

- **Modelo de DUPLICATA (spec `duplicata-antispam-sync`, 2026-06-29) — resolve o conflito:** com a chave `(paciente, grupo)`, o paciente passa a ter **2 cards**: o **card B (Pós-Venda) é pegajoso** e **permanece em Cliente Ativo/Tratamento Iniciado**, e o sync **cria um card A em Captação para a nova agenda A, com sufixo " (duplicata)"** no nome. Quando a agenda A é finalizada/cancelada, o card A vai para **Avaliação Realizada** (se FINALIZADO) ou **Cancelada–Perdido `143`** (se cancelado), e o **card-cliente B segue intacto**. Ou seja, o modelo de duplicata é **desenhado exatamente para este cenário**: não rebaixar o cliente, e ainda assim espelhar o novo agendamento de captação.

### Como a DUPLICATA se encaixa vs conflita
- **Encaixa:** é a única proposta que representa fielmente "cliente ativo **E** nova consulta de captação ao mesmo tempo", com **anti-spam** (se A e B caem no mesmo dia-alvo, confirma **só o card de Captação** — 1 WhatsApp — e o card B fica em Cliente Ativo) e **sync pelo mais próximo**.
- **Conflita (com o que está no ar):** o redesign **contradiz o invariante atual "0 duplicata / 1 paciente = 1 lead"** e **não foi reconciliado com o ORC deployado**. O ORC (01/07) foi escrito para o mundo **card-único** ("NÃO existe duplicata; migra entre funis") e o lookup de lead do ORC precisa virar **group-aware** (a própria spec de duplicata alerta: "lookup por telefone tem de filtrar pelo pipeline do grupo — nunca `leads[0]` cego"). Além disso, o redesign exige **migração destrutiva** do `mapeamento` (PK → `(paciente_id_cnn, grupo)`, com backup `mapeamento_bak`), que ainda não foi executada.

### O que os docs sugerem ser o comportamento correto (recomendação concreta)
1. **Rotear sempre pelo TIPO do novo agendamento** (`grupoDaAgenda`), **nunca** sobrescrever por "já é cliente". (Consenso de todos os docs.)
2. **Novo agendamento B → Pós-Venda** (Cliente Ativo ⇄ Confirmação de Agendamento). Já correto hoje; adicionar **guarda para não rebaixar Tratamento Iniciado → Cliente Ativo**.
3. **Novo agendamento A → deve virar um SEGUNDO card em Captação (modelo de duplicata), preservando o card-cliente em Pós-Venda** — e **não** mover o card único do cliente de volta à Captação. Este é o comportamento que a **spec 2026-06-29** prescreve e que corrige a falha do modelo card-único vigente.
4. **Precedência orçamento × agenda já está certa:** orçamento aprovado **não** pina o cliente em Tratamento Iniciado quando surge agenda futura — o portão `temAgendaFutura` entrega o comando ao sync de agenda (ESPECIFICACAO do ORC §4; invariante CLAUDE.md "reflexo de orçamento só p/ lead sem agenda futura").

**Ponto de ação para o controlador:** a decisão é, no fundo, **deployar (ou não) o modelo de duplicata** — pois é ele quem responde limpo ao Caso 2. Antes de deployar, é obrigatório: (a) migração `(paciente, grupo)` com backup; (b) tornar o **ORC group-aware** (lookup por pipeline, e ORC agindo sobre o card **B** correto, não sobre o card A duplicado); (c) guarda anti-rebaixamento de Tratamento Iniciado; (d) resolver a ambiguidade empírica dos **124 pares A+B** já observados em 06-30 (são duplicatas legítimas ou ruído de backfill?). Enquanto a duplicata não for deployada, o sistema resolve o Caso 2 **incorretamente** (rebaixa o cliente) ou depende do desempate **B-vence** da Fase 1 (que joga tudo para B e **perde** o reflexo da nova consulta A).

**Docs de origem citados:** roteamento por tipo e grupos A/B — `ESPECIFICACAO-TECNICA.md`, `novo arquivo mae escopo.md`, `DIARIO/INVENTARIO`; ciclo Pós-Venda e cancelamento por grupo — `Design fundacional/Plano Fase 1 (28/06)`, `AUDITORIA-2026-06-30`; **modelo de duplicata A+B + anti-spam + sync pelo mais próximo** — `spec duplicata-antispam-sync (2026-06-29)` + `Plano Fase 2`; **orçamento→cliente e precedência agenda×orçamento** — `Reflexo de Orçamento (2026-07-01)` + `CLAUDE.md`.

---

**Arquivos de referência (absolutos):**
`D:/clarissa-bergmann/kommo-cnn/CLAUDE.md` (durável) · `D:/clarissa-bergmann/kommo-cnn/docs/fixes/BACKLOG.md` (auditoria 02/07, WIP; lote de deploy pendente [C1,A4,A5,B2]).

---
_Gerado por workflow (9 leitores paralelos + síntese) em 2026-07-02, cruzando os docs do projeto com CLAUDE.md/BACKLOG.md. Docs-fonte podem estar defasados; ver seção 5._

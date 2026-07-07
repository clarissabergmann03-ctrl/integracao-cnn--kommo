# Design — Reflexo do status de Orçamento (CNN) no funil Kommo

**Data:** 2026-07-01
**Autor:** Claude + dono
**Status:** aprovado (brainstorming) → próximo passo: plano (writing-plans)
**Relacionado:** [[project-kommo-cnn-estado-atual]] · sync A3 (`consumirItemA3`/`produtorSync`) · confirmação F2

---

## 1. Objetivo

Refletir automaticamente, no Kommo, o **status do orçamento** que vive na Clínica nas Nuvens (CNN). O orçamento não é entidade no Kommo — a função lê o status na CNN (polling) e move o lead para a etapa/funil correspondente. É **mais uma função** dentro do sistema de integração CNN↔Kommo já existente, seguindo seus padrões (auth, correspondência de lead, `moveLeadToStage`, auditoria, `orcamentoOk`/subrequest budget, produtor+consumidor de fila no cron).

Foco: **leads novos / pacientes sem agenda ativa futura** (não clientes em atendimento). Movimentos **1x por mudança** — o atendente não pode ficar brigando com o sistema.

## 2. O que já existe (reuso) vs. novo

**Reuso (não refazer):**
- Auth CNN (`cnnGet`/`cnnHeaders`, target `production` = **read-only** por `assertCnnWritable`) e Kommo (`kommoGet`/`kommoPatch`).
- Correspondência lead↔paciente: campo `ID Paciente CNN` no lead + telefone (`phoneKey`) + tabela `mapeamento`.
- `moveLeadToStage(leadId, statusId, env, pipelineId)` — troca **pipeline_id + status_id num único PATCH** (responde à dúvida do prompt: é 1 chamada só). Já cruza funil.
- Padrão produtor→fila→consumidor no `scheduled()` (igual `produtorSync`+`consumirFila`), budget de 50 subrequests/invocação (`orcamentoOk`), auditoria (`audit`).
- "Consulta realizada" = etapa **Avaliação Realizada** (`106848627`), já movida pelo sync em `FINALIZADO` (Grupo A). **Não faz parte desta função.**

**Novo:**
- Leitura de orçamento CNN: `GET /orcamento/lista`, `GET /orcamento/{id}` (read-only).
- Tabela D1 `orcamento_sync` (idempotência/1x).
- Produtor `produtorOrcamento` + consumidor `consumirItemOrcamento`.
- Constantes do Funil de Pós-Consulta e da etapa Tratamento Iniciado (o código **não** conhecia o Pós-Consulta).

**Não é possível (sinalizado):**
- CNN **não tem** status "aguardando pagamento" no orçamento (só `ABERTO`/`APROVADO`/`PERDIDO`/`CANCELADO`), **nem** endpoint financeiro/contas-a-receber, **nem webhooks**. → Etapa "aguardando pagamento" **fora de escopo**; trigger é **polling** (única via).

## 3. IDs confirmados via API (`/discover`, 2026-07-01) — não assumir

| Kommo | pipeline_id | status_id |
|---|---|---|
| Funil de Captação | 13847079 | Avaliação Realizada 106848627 *(já existe)* |
| **Funil de Pós-Consulta** | **13947295** | **Em Análise 107633739**; Venda Perdida **143** |
| **Funil de Pós-Venda** | **13950431** | **Tratamento Iniciado 107658907**; Cliente Ativo 107658911; Confirmação de Agendamento 107974651 |

> `143` = status genérico "perdido" que existe em todo funil (escopado pelo `pipeline_id`). `142` = "ganho".

**CNN orçamento** — status possíveis: `ABERTO`, `APROVADO`, `PERDIDO`, `CANCELADO`.
Endpoints: `GET /orcamento/lista` (`dataInicial`, `dataFinal`, `tipoData`∈{CRIACAO,APROVACAO,PREVISAO_EXECUCAO} obrigatório; `status`, `idPaciente`, `pagina`, `registrosPorPagina`) · `GET /orcamento/{id}` (traz `paciente.id`, `procedimentos[]`, `produtos[]`, `valorLiquido`, `dataAprovacao`, `numeroContrato`, `status`).

## 4. Regra central (máquina de estados)

Para cada paciente com ≥1 orçamento:

1. **Localiza o lead** por `ID Paciente CNN`/telefone (padrão existente). Sem lead correspondente → registra e ignora (não quebra).
2. **Portão de precedência — o paciente tem agenda ATIVA FUTURA?**
   Agenda com status `AGENDADO` ou `CONFIRMADO_PACIENTE` e data ≥ hoje (janela do sync).
   - **Sim → NÃO faz nada.** O agendamento manda: "cliente ativo" e a **confirmação de véspera (F2)** seguem intactos. *(cobre "cliente ativo manda" + "não interromper a confirmação")*
   - **Não → reflete o orçamento (passo 3).**
3. **Etapa-alvo pelo status do orçamento:**
   - Existe **algum** orçamento `APROVADO` → **Pós-Venda / Tratamento Iniciado** (`13950431` / `107658907`). *(aprovação tem prioridade sobre recência)*
   - Senão, pelo orçamento **mais recente** (por data de criação / maior `id`):
     - `CANCELADO` **ou** `PERDIDO` → **Pós-Consulta / Venda Perdida** (`13947295` / `143`).
     - `ABERTO` (ou qualquer outro não-terminal) → **Pós-Consulta / Em Análise** (`13947295` / `107633739`).
4. **Move só quando a etapa-alvo MUDA (1x):** compara com a última etapa refletida (`orcamento_sync`). Se igual, **não mexe** — mesmo que o atendente tenha movido o lead à mão (respeita o humano; "não briga com o sistema"). Isso também absorve a regra "vários orçamentos → mantém onde está" (uma vez em Tratamento Iniciado por aprovação, não é mais reprocessado).

**Por que NÃO precisa mexer no sync de agenda:** com agenda futura, quem age é o sync (→ cliente ativo/confirmação); quando as agendas acabam, o sync para de gerar eventos e o fluxo de orçamento assume. A precedência é natural — sem guarda nova no `consumirItemA3`.

## 5. Trigger, dados e idempotência

- **Produtor `produtorOrcamento(env, "production", budget)`** no `scheduled()`, **a cada 1 min**: varre `GET /orcamento/lista` com **cursor budget-aware** (por `tipoData=CRIACAO` para novos + `APROVACAO` para aprovações recentes). Cada tick processa um pedaço até `orcamentoOk` (teto 50 subreq/invocação, compartilhado com o sync) e **avança o cursor**; ao longo dos minutos varre toda a base e recomeça (escalonamento). Como o move só ocorre em **mudança** de status, a maioria dos ticks é só leitura. Folga: ~100k req/dia. Enfileira só pacientes cujo status/etapa-alvo mudou.
- **Consumidor `consumirItemOrcamento`**: aplica a regra da §4 para 1 paciente; escreve Kommo; grava estado.
- **D1 `orcamento_sync`**: `paciente_id_cnn` (PK), `lead_id_kommo`, `ultimo_status`, `ultima_etapa`, `updated_at`. Espelha `agenda_sync`. *(nomes reais das colunas — implementados 01/07)*
- **Idempotência:** move só se `etapa-alvo != ultima_etapa_refletida`. Baseline na 1ª vez (registra sem mover, anti-eco) — ou move se já houver divergência clara; decidir no plano.

## 6. Tratamento de erros + logging

- Cada etapa em `try/catch` isolado (um paciente com erro não derruba o lote), como no sync.
- Falha de rede CNN/Kommo → conta erro, mantém item para reprocessar (fila `tentativas++`), não avança o cursor além do ponto seguro.
- Lead não encontrado / orçamento sem correspondência → registra e segue.
- **Auditoria:** `audit(env, { funcao: "ORC", acao: "etapa-movida", para: <nome etapa>, entidade_id: leadId, detalhe: "orc <id> status <X>" })`. (Corrige de saída o gap visto na REGRA 1: **este fluxo audita seus moves**.)

## 7. Testes (convenção do projeto — já em produção)

Sistema já está em produção (flip no ar). Esta função é **CNN-leitura + Kommo-escrita** (ambos já permitidos), então **não precisa de escrita no CNN** e valida assim:

1. **Endpoint `/debug-orcamento` (read-only):** lista orçamentos por status/janela e detalha por `?id=` (já desenhado). Confirma extração real.
2. **Dry-run do produtor/consumidor contra produção** (`?dry=1`): mostra, sem escrever, quais leads moveria e para onde.
3. **Move controlado real** num lead de teste, depois reverter (padrão "limpar após teste").
4. Casos cobertos (via dry-run sobre dados reais + 1 sandbox se preciso):
   - `APROVADO` → lead vai para Tratamento Iniciado (Pós-Venda).
   - `ABERTO` sem aprovado → Em Análise (Pós-Consulta).
   - `CANCELADO`/`PERDIDO` sem aprovado → Venda Perdida (Pós-Consulta).
   - Paciente **com agenda futura** → **não move** (portão).
   - Status inalterado / já na etapa → **não move** (1x).
   - Orçamento sem lead correspondente → tratado sem quebrar.
   - Erro de API (CNN ou Kommo) → tratado sem quebrar o lote.

> Sem framework de unit test novo (o projeto valida por endpoints `/debug` dry-run + sandbox — não reinventar convenção).

## 8. Entregáveis

- Endpoints usados: **CNN novos** (`/orcamento/lista`, `/orcamento/{id}`, read-only); **Kommo já existentes** (`GET /leads/{id}`, `GET /contacts?query=`, `PATCH /leads/{id}` via `moveLeadToStage` — pipeline+status num PATCH).
- `produtorOrcamento` + `consumirItemOrcamento` + tabela `orcamento_sync` + constantes do Pós-Consulta/Tratamento Iniciado, no padrão do código.
- `/debug-orcamento` (diagnóstico read-only).
- Relatório curto de validação (dry-run) por caso da §7.

## 9. Decisões travadas (para não reabrir)

- "Aguardando pagamento" **fora de escopo** (não existe no CNN).
- `PERDIDO` tratado como `CANCELADO` → Venda Perdida.
- Múltiplos orçamentos: **qualquer `APROVADO` → Tratamento Iniciado**; senão o **mais recente** manda.
- **Não** modificar o sync de agenda; precedência resolvida pelo portão "tem agenda futura?".
- Trigger = **polling** (CNN não tem webhook).
- **Cadência = a cada 1 min**, cursor budget-aware (decisão do dono 2026-07-01: 50 subreq/invocação é real, mas ~100k req/dia é folgado → escalonar o quanto der).

## 10. Riscos / a resolver no plano

- Forma exata do cursor (`CRIACAO` vs `APROVACAO`) para capturar aprovações de orçamentos **antigos** (cujo status muda hoje) — um orçamento aprovado agora, criado há meses, não aparece numa janela de `CRIACAO`. Resolver no plano (ex.: varrer `APROVACAO` recente + reconferir tracked).
- Definição operacional de "agenda futura" — reusar `agenda_sync` (D1, sem custo de subrequest): existe agenda do paciente com `ts ≥ hoje` e status não-terminal.
- Baseline inicial: 1ª passada registra sem mover (anti-enxurrada), como o `agenda_sync`.
- Medir volume com `/debug-orcamento` antes de ligar (dimensiona o pedaço por tick).

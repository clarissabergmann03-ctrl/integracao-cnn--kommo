# Design — Roadmap restante (kommo-cnn)

**Data:** 2026-06-29
**Status:** Design de alto nível dos itens de roadmap. Cada um precisa de um plano próprio (e os marcados ⚠️ precisam de uma decisão sua antes do plano).
**Base:** escopo mãe (`novo arquivo mae escopo.md` §8.3/§8.4/§8.5) reconciliado com a arquitetura atual (2 funis: Captação 13847079 / Pós-Venda 13950431; modelo de duplicata).

---

## A. Função 3 — Movimentação por orçamento (CNN→Kommo, lê CNN / escreve Kommo)
**Gatilho:** polling de `GET /orcamento/lista` (CNN, leitura) detectando mudança de status do orçamento. Status: `ABERTO`, `APROVADO`, `CANCELADO`, `PERDIDO`.
**Precedência (escopo §8.3 — parar no 1º que casar):**
1. Lead já está / já esteve no **Pós-Venda** → não faz nada.
2. Qualquer orçamento **APROVADO** → Pós-Venda **"Tratamento Iniciado"** (vence ABERTO e FINALIZADO).
3. Orçamento **ABERTO** (e nenhum aprovado) → etapa **"Análise"**.
4. **Atendimento Social FINALIZADO** (sem aprovado) → **"Avaliação Realizada"** (Captação).
5. Orçamento **CANCELADO** → nada (só logado).
**⚠️ Decisões abertas:** mapear as etapas-alvo reais — "Tratamento Iniciado" e "Análise" não existem nos 2 funis atuais (o funil "Pós-Consulta" 13947295 está sem uso). Definir: usar etapas do Pós-Venda? criar etapas? Tudo é só-leitura no CNN (escreve só Kommo) → não toca §7.8.

## B. Etapa "Importado CNN" (Kommo)
**Propósito:** destino-fallback pra paciente importado do CNN cujo tipo não roteia (pendência P2) ou sem agendamento ativo mapeável — em vez do atual "tipo desconhecido → não faz nada".
**⚠️ Decisões abertas:** criar a etapa no Kommo (em qual funil?); definir quando usá-la vs manter "não faz nada". Hoje `grupoDaAgenda` retorna `null` p/ tipo fora dos grupos → esses cairiam em "Importado CNN".

## C. Função 4 — Reconciliação de campos cadastrais (por telefone)
**Regra (escopo §8.4):** casa por `phoneKey`; **CNN vazio + Kommo tem** → preenche CNN; **CNN tem + Kommo vazio** → preenche Kommo; **ambos** → nada.
**ESCREVE no CNN** (preencher paciente) → **§7.8 / sandbox-first** (depende do item 2 estar liberado).
**⚠️ Decisões abertas:** lista de campos a reconciliar (nome, nascimento, e-mail, etc.); frequência. É essencialmente uma extensão do item 2 (escrita CNN).

## D. Refresh automático do token Kommo (OAuth2)
**Hoje:** `KOMMO_ACCESS_TOKEN` long-lived. **Proposta:** detectar `401` nos wrappers (`kommoGet/Patch/Post/Delete`) → `POST /oauth2/access_token` com `{client_id, client_secret=KOMMO_CLIENT_SECRET, grant_type=refresh_token, refresh_token, redirect_uri}` → persistir novo access+refresh no D1 → refazer a chamada.
**Falta (setup):** secrets `KOMMO_CLIENT_ID`, `redirect_uri` e um `refresh_token` inicial gravado no D1. Não toca CNN (só Kommo). Baixo risco, bem isolado.

## E. Mecânica de liberar a §7.8 (escrita CNN em produção) + trava de prontuário
**Hoje:** `assertCnnWritable` bloqueia QUALQUER `cnnPost/cnnPut` em `production`.
**Proposta:** liberação **granular e controlada** — flag/var (ex.: `CNN_WRITE_ENABLED`) + **allowlist de caminhos** liberados por endpoint (`/agenda/novo`, `/agenda/alteracao-status`, `/paciente/novo`, `/convenio-paciente/associar`), ligados **um a um** após validação no sandbox, com OK do dono.
**Trava de prontuário (proposta pendente):** denylist de caminhos clínicos (`prontu|evolu|anamnese|prescri|receit|laudo|anexo`) que bloqueia em **qualquer ambiente**, sempre — independente da liberação acima. (Hoje a API CNN nem tem esses endpoints; é seguro extra/futuro.)
**⚠️ Decisão aberta:** confirmar a abordagem do interruptor + aplicar a trava de prontuário.

## F. Helper de limpeza de agendas de teste (sandbox)
**Propósito:** cumprir a regra "limpar após teste" — hoje não há como remover/cancelar uma agenda de teste por ID (`set-cnn-status` só pega a 1ª do paciente).
**Proposta:** endpoint debug (sandbox + allowlist) que recebe `idAgenda` e marca **CANCELADO** (a API CNN não tem DELETE de agenda — só `PUT /agenda/alteracao-status`). Opcional: aceitar lista de IDs / limpar por data+telefone de teste. Baixo risco (sandbox).

---

## Resumo de prioridade
- **D (OAuth refresh)** e **F (limpeza de teste):** isolados, baixo risco, podem ser feitos a qualquer momento.
- **A (Função 3)** e **B (Importado CNN):** CNN→Kommo (não tocam §7.8), mas precisam das decisões de etapa-alvo (⚠️) antes do plano.
- **C (Função 4)** e **E (liberar §7.8 + prontuário):** dependem da liberação de escrita CNN (pós item 2). E só fazem sentido depois do item 2.
- Cada item vira um plano próprio quando priorizado.

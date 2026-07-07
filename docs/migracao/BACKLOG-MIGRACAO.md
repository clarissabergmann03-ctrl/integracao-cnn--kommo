# BACKLOG — Migração Sync Única (one-time CNN→Kommo)

> **Natureza:** migração de estado ÚNICA, unilateral (CNN→Kommo), sobre todo o histórico (6 anos). **IRREVERSÍVEL** — cada move de etapa é definitivo, não há rollback automático. Após a rodada, o sistema volta a operar só na janela corrente.
> **Conhecimento durável** resumido em `../../CLAUDE.md` (seção "Migração Sync Única"). Este arquivo é o **plano vivo + critérios de aceite**. Status por fase: `pendente → em-andamento → validado → FEITO`. WIP=1.
> **Fonte:** prompt do dono "SINCRONIZAÇÃO ÚNICA CNN → KOMMO (v2)" + correções no chat (03/07).

---

## 0. PRINCÍPIOS INEGOCIÁVEIS (do dono)
1. **Direção única CNN→Kommo.** Nunca escreve no CNN (chave de prod = só-leitura, §7.8).
2. **Determinismo total.** Classificação = CÓDIGO puro, nunca julgamento de LLM por-paciente.
3. **Idempotência.** Rodar 2x = mesmo resultado. Lê o lead (ID Paciente CNN + etapa) ANTES de mover; move só quando o alvo muda.
4. **Preservação.** Na dúvida, NÃO move → fila de revisão manual.
5. **Log total.** Cada lead gera 1 linha: `id_cnn, nome, regra, funil, etapa, campos, ts`.
6. **Separado + paralelo + sem sobrepor** o Worker de produção (regra explícita do dono).
7. **Verificação por lote.** Relê os cards escritos e confere etapa/campos ANTES de liberar o próximo lote. Nada sai pela metade / na etapa errada.

---

## AGORA
- **🏁 STAGING COMPLETO (03/07):** base inteira no D1. **8.261 pacientes · 59.674 agendas (569 futuras) · 6.348 orçamentos · 0 erro_leitura** (2º passe `/mig-reimport` recuperou os 187 → 0%). Deploy final `93232d68`.
  - VALIDACAO: ok=8.033 (97%) · revisar=228 (2,8%). REGRA: captura/perd=3.671 (44%) · abandono=1.940 (24%) · concluído=1.579 (19%) · pós-cons/perd=533 · futuro(A+B)=336 · trat.inic=105 · cancel=40. INATIVO: 720D=4.897 (base dormente).
  - Fixes-chave: `retrySweep` (retry sem travar no contador global), 2º passe individual, flags "duros" só (revisar 41%→2,8%).
- **⏭️ PRÓXIMO:** (1) auditoria subagentes nos 228 `revisar` (leem do D1, sem CNN → sem 429); (2) `/mig-criar-campos` (campo Inativo); (3) `/mig-sync?dry=1` → revisar → `dry=0` (cria/move idempotente + bateria rigorosa).
- ~~histórico abaixo~~
- **✅ DEPLOYADO (03/07, Version `fb58499c`):** D1 staging no ar. Endpoints por HTTPS público + D1 durável → **acabou a fragilidade do wrangler dev**. Bindings: env.DB=kommo-cnn-db.
- **✅ Import CNN→D1 PROVADO:** `/mig-import?pagina=0&rpp=3&env=production` → 3 pac, 35 agendas, 3 orçamentos no D1, **0 erro_leitura**. Ex.: João da Silva → inativo 720D, abandono, validacao=ok. 3 tabelas: `mig_pacientes` (rico+raw), `mig_agendas` (incl. futuras), `mig_orcamentos`.
- **🔄 Import completo RODANDO** (driver `mig_import_driver.ps1`, rpp=4, ~2066 páginas, resumível por cursor). total_paginas confirma ~8.262.
- **⏭️ Após import:** (1) validação por SQL (dono confere TUDO); (2) criar campo Inativo (`/mig-criar-campos`); (3) `/mig-sync?dry=1`; (4) auditoria subagentes nos `revisar`; (5) sync real `dry=0`.
- ⚠️ **Cosmético:** label da regra ainda diz "silencio>180d" (lógica é 90d) — corrigir string. ⚠️ **D1 free:** ~80k writes no import (limite 100k/dia) — 1 import cabe; re-import cuidado.

## ~~AGORA~~ (histórico anterior)
- **✅ Auth destravada (03/07):** dono liberou o IP no token CF → `wrangler whoami` OK (conta `4be8e1b3...`). Caminho 2 (`wrangler dev --remote`) e deploy liberados. (⚠️ IP oscila → pode reincidir; se `9109` voltar, liberar o IP de novo.)
- **Fase:** DESENHO concluído; Fase 0 read-only concluída (sinais confirmados na produção). **Em-andamento:** endpoint read-only de sondagem por-paciente + rodar via `wrangler dev --remote` (Fase 0 c/d → Fase 1).
- **Feito até aqui:** viabilidade cruzada com a API do CNN; funil vivo do Kommo verificado (todas as etapas-alvo existem); janelas e limiares confirmados; escala medida (~3624 leads Kommo).
- **Próximo passo exato:** dono decide arquitetura de execução + 3 micro-regras → escrevo o SPEC formal → writing-plans → workflow de execução (Fase 0..6).

---

## DECISÕES ABERTAS (bloqueiam o SPEC final)
| # | Decisão | Opções | Recomendação |
|---|---|---|---|
| D1 ✅ | **Arquitetura de execução** | **RESOLVIDO 03/07: `wrangler dev --remote`** (caminho 2 do dono). Endpoint de migração no código, rodado numa **preview isolada** → isolate/globais separados do cron (sem colisão; cron não dispara em preview), reusa os secrets já na CF (write-only, não copia). **Vale o teto de 50 subreq/request** → **micro-lotes (~1 paciente/request) + cursor no D1 + driver local em loop** (log + verificação por lote). Risco: token CF oscila (wrangler cai) → mitigado por resume/cursor. |
| D2 ✅ | **APROVADO >2m, fez PARTE dos procedimentos** (não concluiu, não cancelou, não abandonou) | **RESOLVIDO 03/07:** → **revisão manual** (default). "Saldo pendente" (`107658915`) = deve DINHEIRO, não "meio do tratamento", e provavelmente NÃO é detectável pela API (sem endpoint financeiro) → não usar aqui. Medir volume no dry-run; se muito alto, reconsiderar 'cliente ativo'. |
| D3 ✅ | **Bloco Futuro / mis-placements** | **RESOLVIDO 03/07:** a migração **CORRIGE** mis-placements inclusive no Bloco Futuro (dono: há leads em "tratamento iniciado" com agenda → deveriam ser "cliente ativo"; em "primeiro contato" com agenda futura → "consulta agendada"). Move **forward-only** (nunca rebaixa; usa a ordem das etapas do funil); alvo = mesmo do cron → idempotente, sem corrida. |
| D4 | **Enriquecimento §6** | (a) v1 só campos existentes (Aniversário, Faciais, Corporais, contato, ID Paciente CNN); (b) criar campos novos no Kommo (Origem, valor de orçamento) antes | **(a)** — criar campos é iniciativa à parte; não bloquear a migração. |
| D5 | **RESET de vida §5.0** (novo orçamento ≥9m após aprovado) | orçamento não tem data de criação no objeto | derivar por ordem de `id` + janela CRIACAO; se indeterminável → **revisão manual**. Baixa incidência. |

> **ESCOPO (esclarecido 03/07):** a migração é um **PASSE DE CORREÇÃO COMPLETO** — reclassifica TODA a base (histórico frio + janela ativa) para a etapa certa, corrigindo mis-placements em QUALQUER funil, não só o histórico. No Bloco Futuro ela só move **para frente** (nunca rebaixa — respeita a ordem das etapas), então nunca puxa de volta um lead que o cron já avançou (ex.: já em "confirmação"/"consulta confirmada" → deixa).

> **Ordem das etapas (para o guard forward-only):**
> - Captação: leads de entrada `106848271` → primeiro contato `106848615` → consulta agendada `106848619` → confirmação `107785399` → consulta confirmada `106848623` → avaliação realizada `106848627` → tratamento proposto `106848631` → follow-up `107789355` → fechado `142` / perdido `143`.
> - Pós-Venda: leads de entrada `107658903` → tratamento iniciado `107658907` → cliente ativo `107658911` → confirmação de agendamento `107974651` → saldo pendente `107658915` → procedimento delicado `107860123` → abandono `107774015` → cancelamento `107774019` → recorrência/manutenção `107774023` → concluído `142` / perdido `143`.

> **📌 v3 (03/07) — o dono consolidou o SPEC (prompt "v3", canônico). Deltas absorvidos (superam D2/D5):**
> - **SEM fila de revisão manual** neste passe. Todo lead recebe etapa definitiva.
> - **Caso parcial** (§5.1d, "há item pendente") → **Cliente Ativo** (não mais revisão manual — supera D2).
> - **Reset indeterminado** (§5.0) → **PÓS-VENDA / Lead perdido** (§5.1e), não revisão manual (supera D5).
> - **§5.1(a)** inclui `perdido`: cancelamento/reembolso/ocorrências se `status_cnn ∈ {interrompido, cancelado, perdido}` (derivado do orçamento: `dataAprovacao`≠null e status CANCELADO/PERDIDO; "interrompido" talvez não detectável — checar Fase 0).
> - **Enrichment §6 (campos reais descobertos 03/07):** origem/fonte = custom field **"Fonte" id `2439032`** (`select` → mapear origem CNN p/ opção do enum na Fase 0); **valor de venda = campo NATIVO `lead.price`** (não custom) = `orcamento.valorLiquido`. Demais: Aniversário `2439250`, Faciais `2439134`, Corporais `2439130`, ID Paciente CNN `2436393`.
> - **§10 Painel de progresso** derivado do log JSONL (métricas de topo + barras por fase + distribuição por etapa) — novo entregável (candidato a Artifact HTML).
> - ✅ **DATA CONFIRMADA (03/07):** corte = **01/07/2026** (a correção do dono vence o texto do v3). `JANELA_PASSADA` = [2020-07-03, 2026-06-30]; agenda `data` **≥ 2026-07-01** → Bloco Futuro (até 2028-01-01).

---

## CONSTANTES CONFIRMADAS (ao vivo /discover 03/07)

### Janelas
- `HOJE` = 2026-07-03
- `JANELA_ATIVA` (Bloco Futuro) = agenda `data` ∈ **[2026-07-01, 2028-01-01]**
- `JANELA_HISTORICO` (Bloco Passado) = agenda `data` ∈ **[2020-07-03, 2026-07-01)**
- `LIM_APROVACAO_RECENTE` = **2 meses** | `LIM_RESET` = **9 meses** | `LIM_SILENCIO` = **180 dias**

### Etapas-alvo Kommo (todas existem)
| Funil | id funil | Etapa | id etapa |
|---|---|---|---|
| Captação | 13847079 | consulta agendada | 106848619 |
| Captação | 13847079 | Consulta cancelada – perdido | 143 |
| Pós-Venda | 13950431 | tratamento iniciado | 107658907 |
| Pós-Venda | 13950431 | cliente ativo | 107658911 |
| Pós-Venda | 13950431 | abandono de tratamento | 107774015 |
| Pós-Venda | 13950431 | cancelamento/ reembolso/ ocorrências | 107774019 |
| Pós-Venda | 13950431 | tratamento concluído | 142 |
| Pós-Venda | 13950431 | Venda perdida (fallback) | 143 |
| Pós-Consulta | 13947295 | em análise | 107633739 |
| Pós-Consulta | 13947295 | Venda perdida | 143 |

> ⚠️ `142`/`143` são "ganho/perdido" genéricos, repetidos em TODO funil → sempre escopar por `pipeline_id`.

---

## ÁRVORE DE CLASSIFICAÇÃO (determinística)

```
Paciente CNN
 └─ [TRAVA] lead já em "cliente ativo" (107658911)? → SKIP (não remexe)
 └─ [ROTEADOR] tem agenda em [2026-07-01, 2028-01-01]?
      ├─ SIM → BLOCO FUTURO (domínio do cron; D3 = não escrever)
      │        grupo do agendamento futuro (ambos → B vence):
      │         A → Captação / consulta agendada (106848619)
      │         B → Pós-Venda / cliente ativo (107658911)
      └─ NÃO → BLOCO PASSADO (histórico frio):
            funil pelo histórico:
             teve orçamento APROVADO (dataAprovacao≠null) OU grupo B no passado → PÓS-VENDA
             teve orçamento gerado (só grupo A, nunca aprovou)                  → PÓS-CONSULTA
             só grupo A, sem orçamento                                          → CAPTAÇÃO

           ── PÓS-VENDA (tem APROVADO) ────────────────────────────
             ultimo_aprovado ≥ HOJE−2m  → tratamento iniciado (107658907)
             ultimo_aprovado <  HOJE−2m → cascata (1ª verdadeira vence):
               1. orçamento aprovado depois CANCELADO/PERDIDO  → cancelamento/reembolso/ocorrências (107774019)
               2. fez TODOS os procedimentos do aprovado       → tratamento concluído (142)
               3. cauda final = faltas/silêncio, sumiu >180d    → abandono de tratamento (107774015)
               4. fez parte / indefinido                        → [D2] revisão manual (ou cliente ativo)
           ── PÓS-CONSULTA (orçamento, nunca aprovou) ─────────────
             fez social, recebeu orçamento, sumiu → Venda perdida (143)
           ── CAPTAÇÃO (só grupo A, sem orçamento) ────────────────
             consulta passada, não compareceu / não gerou orçamento → perdido (143)

 + [RESET §5.0] novo orçamento ≥9m após o aprovado → trata como ciclo novo (Pós-Consulta). [D5]
 + em TODA folha: enriquecer campos disponíveis (§6 / D4).
```

### Derivações-chave (o que a API permite)
- **grupo da agenda:** por `idTipoConsulta` → nome (reusar `grupoDaAgenda`). ⚠️ recalibrar strings A/B contra a lista de PRODUÇÃO (Phase 0).
- **"fez todos os procedimentos":** `orcamento.procedimentos[].idTipoProcedimento`+`quantidade` (do aprovado) ⊆ união de `procedimentos[]` das agendas grupo-B com status `FINALIZADO` e `data` > `dataAprovacao`. Match ambíguo/incompleto → revisão manual.
- **"cancelou após aprovar":** existe orçamento com `dataAprovacao`≠null E `status` ∈ {CANCELADO, PERDIDO}.
- **"abandono":** últimas N agendas = `FALTOU`/`CANCELADO_PACIENTE`, sem `FINALIZADO` depois, `dias_desde_ultima_atividade` > 180, sem agenda futura.
- **enumeração:** `GET /paciente/lista` paginado (todos filtros opcionais).

---

## PLANO FASEADO (workflow de execução)

### Fase 0 — Verificar & calibrar (read-only)  [em-andamento]
- **Objetivo:** eliminar incertezas antes de qualquer escrita.
- ✅ **(a) GRUPO A/B calibrado na PRODUÇÃO** (`/discover?env=production` 03/07): **A** = Consulta/Avaliação(66666), Atendimento Social(66671); **B** = Pequenas Cirurgias(66667), Encaixe(66668), Encaminhamento-INTERNO(66669), Procedimento(66670), RETORNO(66672), Cortesia(67118), Cirurgia(93892). Bate com `GRUPO_A/B_TIPOS` do código. (Os tipos sandbox — Exame/Pré-Natal/Reconsulta — NÃO existem na produção; ignorar.)
- ✅ **(c-agregado) Sinais confirmados na PRODUÇÃO (read-only via endpoints deployados, 03/07):**
  - Agendas (amostra 500, 2025-01..06): `procedimentos[]` preenchido em **500/500**; status reais = FINALIZADO 368, CANCELADO_PACIENTE 96, FALTOU 31, CANCELADO 3, AGENDADO/CONFIRMADO 1; grupo A/B = 280/220, **0 fora do mapa**. → derivação "fez procedimentos"/"faltou" é viável.
  - Orçamentos APROVADOS ≈ **2250** (2021→2026), cada um com `procedimentos[]` + `dataAprovacao` + `valorLiquido` + `paciente.id`. ✅
  - ⚠️ `valorLiquido = 0.01` em registros antigos (placeholder de migração) → "valor de venda" nesses casos sai 0,01.
  - ⚠️ Campo **"Fonte" (2439032) só tem 3 opções**: Instagram / Google / Millions → origem CNN raramente mapeia; setar só em match claro, senão vazio.
- Tarefas restantes: **(b)** tamanho exato da base de pacientes (`/paciente/lista` prod, totalPaginas); **(c-por-paciente + d)** endpoint read-only de sondagem por paciente (`?pid=`: agendas por `codigoPaciente` + orçamentos + lead/etapa Kommo + classificação derivada) rodado via `wrangler dev --remote` em ~8 pacientes de cada categoria, conferindo à mão + medindo subreq/paciente. **(pré-req: validar que o token CF/wrangler autentica — oscila).**
- **Aceite:** ≥1 paciente de cada categoria (concluído/abandono/cancelamento/ativo/perdido/futuro) com classificação conferida à mão; 1 paciente rodado dry em `wrangler dev --remote` sob 50 subreq (mede o custo real por paciente → define o tamanho do micro-lote).

### Fase 1 — Motor determinístico (código, TDD)  [pendente]
- Módulos isolados: (1) reader CNN (enumera + puxa agendas/orçamentos por paciente, read-only); (2) classificador (árvore acima → `{funil, etapa, regra}`); (3) deriv. de execução (procedimentos aprovados × finalizados); (4) enriquecedor de campos; (5) writer idempotente (reusa `mapeamento`+`moveLeadToStage`; lê antes de mover); (6) logger (JSONL por lead) + cursor resumível.
- **Aceite:** testes unitários por módulo com fixtures dos pacientes reais da Fase 0; `dry-run` de 1 paciente reproduz a decisão esperada. Determinismo provado (mesma entrada → mesma saída).

### Fase 2 — DRY-RUN total (sem escrever)  [pendente]
- Roda o motor sobre TODA a base, 0 escrita. Saída: log por lead + **contagem por etapa** + lista de anomalias + fila de revisão manual.
- Fan-out: shards por faixa de id / janela CRIACAO, em paralelo (respeitando rate limit CNN).
- **Aceite:** 100% dos pacientes recebem exatamente 1 classificação OU vão à revisão manual (nenhum sem rótulo); contagens revisadas pelo dono (volume fora do esperado em perdido/ativo/concluído → recalibrar limiares e repetir).

### Fase 3 — Validação rigorosa  [pendente]
- Amostra ~20 por etapa-alvo, conferida contra o CNN (verificadores adversariais).
- Invariantes: 0 duplicata dentro do mesmo funil; idempotência (re-run = mesmo); TRAVA respeitada; nenhum campo inventado.
- **Aceite:** amostras batem; invariantes 100%; limiares (2m/9m/180d) calibrados.

### Fase 4 — PILOTO (escrita real, ~100 leads)  [pendente]
- Move real numa amostra **pequena e diversa** (1 de cada regra). **Relê CADA card** no Kommo pós-escrita: etapa certa, campos certos, sem duplicata.
- **Aceite:** 100% dos cards do piloto corretos. QUALQUER card defeituoso/na etapa errada = ABORTA e corrige o motor antes de escalar.

### Fase 5 — RUN CHEIO  [pendente]
- Em lotes, com throttle (~7 req/s agregado Kommo — teto externo), idempotente, **resumível** (cursor), log por lead, **verificação por lote** (relê o lote antes do próximo), kill-switch.
- Leitura/classificação em shards paralelos; escrita serializada pelo throttle compartilhado.
- **Aceite:** por lote — escritos = planejados, 0 defeito na releitura, antes de seguir. Ao fim: processados = base − skips.

### Fase 6 — Verificação final  [pendente]
- Re-auditoria amostral + relatório final (contagens finais por etapa, nº revisão manual, nº skips).
- **Aceite:** relatório aprovado pelo dono; fila de revisão manual entregue.

---

## RISCOS & SALVAGUARDAS
- **Irreversível:** Kommo não permite DELETE de lead (405) → card errado só se conserta movendo à mão. Por isso dry-run + piloto + verificação por lote são obrigatórios.
- **Overlap com o cron:** mitigado pela partição por tempo (histórico frio vs janela corrente) + escrita idempotente via `mapeamento`/`moveLeadToStage` + D3 (não escrever no Bloco Futuro).
- **Derivação de execução é heurística:** match ambíguo procedimentos aprovados × finalizados → revisão manual (nunca chuta "concluído").
- **Colisão de telefone** (2 pacientes CNN → 1 lead): já conhecida no projeto ([Familia]); a migração deve detectar e mandar à revisão manual, não colapsar.
- **CNN só-leitura:** imposto por `assertCnnWritable`; a migração jamais chama POST/PUT/DELETE no CNN.

---

## LOG DE PROGRESSO
- **2026-07-03 (1)** — Desenho iniciado. Viabilidade cruzada com API CNN (execução não vem da API → derivar de agendas). Funil vivo verificado (todas as etapas-alvo existem). Janelas/limiares confirmados com o dono. Escala medida (3624 leads Kommo).
- **2026-07-03 (2)** — Decisões fechadas: **D1** = `wrangler dev --remote` (caminho 2); **D3** = passe de correção completo, corrige mis-placements incl. Bloco Futuro, forward-only. **Fase 0 (a)** feita: GRUPO A/B calibrado na produção.
- **2026-07-03 (3)** — Dono entregou o **SPEC v3 (canônico)**. Deltas absorvidos (ver nota 📌 acima): SEM revisão manual; parcial→Cliente Ativo (supera D2); reset indeterminado→Pós-Venda/perdido (supera D5); §5.1(a) inclui 'perdido'; §10 painel de progresso. **Fase 0 campos de enrichment descobertos:** Fonte=`2439032` (select, mapear enum), valor de venda = nativo `lead.price`. Corte de data = **01/07/2026** (confirmado). Auth destravada (IP liberado).
- **2026-07-03 (4)** — **PROBE OPERACIONAL.** Endpoint read-only `/debug-migra-probe?pid=&env=production` (funções `classificarMigracao` puro + `migAgendas/OrcamentosPaciente` + `derivarSinaisMig` + `handleMigProbe` em src/index.ts, ~antes de `discoverAuthOk`). Rodado via `wrangler dev --remote` (caminho 2 validado E2E, /health 200). ~3–6 subreq/paciente → micro-lotes podem ter ~8. Testado em 5 pacientes reais.

## 🔬 ACHADOS DO PROBE (Fase 0/1 — corrigir antes do dry-run amplo)
1. ✅ **[FIX aplicado] Procedimentos executados em agendas GRUPO A** (não só B). `feitos` agora casa tipos do orçamento contra FINALIZADO de QUALQUER grupo. Resultado: "concluído" passou a disparar (5335104 e 5335537 → concluído).
2. ✅ **[FIX aplicado] `cancelouAposAprovar` agora usa o ESTADO LÍQUIDO** do orçamento com aprovação mais recente (reaprovar após cancelar vence o cancelamento antigo). requeridos = procs do último-aprovado se AINDA aprovado. Resultado: 5335104 saiu de "cancelamento" → "concluído"; 5335540 (último aprovado realmente cancelado) segue "cancelamento".
3. ✅ **[RESOLVIDO — dono 03/07] Silêncio longo + parcial → ABANDONO.** Cascata §5.1 refinada: (a) cancelamento (último aprovado cancelado) → 107774019; (b) fez todos → concluído 142; (c) parcial + silêncio>180d OU cauda de faltas → abandono 107774015; (d) parcial recente (≤180d, comprou, sem agenda futura) → tratamento iniciado 107658907; (e) fallback → perdido 143. Com agenda futura → cliente ativo (Bloco Futuro). Validado real: 5335402 → abandono; 5335104/5335537 → concluído; 5335540 → cancelamento.

## SWEEP (Fase 2 dry-run) — infra
- Endpoint `/debug-migra-sweep?pagina=&rpp=&env=production` (CNN-only, read-only) classifica 1 página de pacientes do `/paciente/lista`. Readers do sweep têm **teto rígido de página** (agendas 3p + janela futura à parte + orçamentos 2p) → seguros sob concorrência (não dependem do `subreqUsados` global) e ≤48 fetch/request a rpp=8. **Base = ~8.260 pacientes** (1033 páginas @ rpp=8; max_subreq observado 26).
- Orquestração: `scratchpad/sweep_shard.ps1` (varre faixa de páginas, retry 5×, log JSONL por paciente + log de páginas com erro) + Workflow `migra-dry-run-sweep` (N agentes paralelos → agrega por_etapa/por_regra). **Validado** (3 agentes, 80 pacientes, agregação ok). **Run completo disparado** (6 agentes, 1033 páginas) 03/07.

## NOVA ARQUITETURA: D1 STAGING (dono 03/07) — CNN → D1 → Kommo
- **Decisão do dono:** em vez de migrar direto, usar **Cloudflare D1 como staging**. Importa a base p/ D1, valida, e um Worker dreno sincroniza aos poucos p/ o Kommo respeitando rate limit, idempotente (`sync_status` + `kommo_lead_id`). Desacopla a leitura frágil do CNN da escrita; durável (resume após queda do wrangler).
- **Doc completo:** `docs/migracao/D1-STAGING.md` (schema + código).
- ✅ **INTEGRADO no index.ts + type-clean:** `ensureMigSchema` (tabelas `mig_pacientes`+`mig_sync_log`), `migClaimLote` (claim atômico), `migSyncItem` (idempotente: acha por ID Paciente CNN → cria/move), **`migValidarLeadExistente`** (bateria rigorosa: identidade exata, [Família], trava Cliente Ativo, forward-only por `ordemEtapa`, troca de funil→revisar), `migMoveForwardOnly`, `migEnriquecer`, `migSyncBatch` (respeita 50 subreq/tick), `migCriarCampoInativo`. Endpoints: `/mig-sync?limite=&dry=`, `/mig-criar-campos`.
- **Régua confirmada:** concluído ≥85%; abandono parcial + silêncio ≥90D; QUALQUER aprovado → Pós-Venda (vendeu=pós-venda); campo select **Inativo** (90/180/360/540/720D). Sync só `validacao='ok'`; `revisar` (casos-limite flagados) passa pela auditoria de subagentes antes.
- **FALTA:** (1) **import CNN→D1** (adaptar o sweep p/ gravar em `mig_pacientes`); (2) deploy (gated); (3) criar campo Inativo + tabela D1; (4) testar `/mig-sync?dry=1`; (5) auditoria de subagentes nos `revisar`.

## FIX de leitura limpa (dono pediu < 0,5% erro) — 03/07
- **Root cause:** `cnnGet` usa `retryPadrao()` que bloqueia retry quando `orcamentoOk()` (contador global inflado) é falso → 429 vira falha.
- **Fix:** `cnnGet` ganhou 4º param `retry`; novo `retrySweep()` (max 6, backoff até 6s, gate em 48) usado nos readers do sweep. Resultado: **erro_leitura 6% → 1,9%** (amostra 160). Régua nova aplicada: `MIG_CONCLUIDO_PCT=0.85`, `MIG_SILENCIO_DIAS=90`. Campo `inativo` (faixaInativo: 90/180/360/540/720D) no registro.
- **Estratégia < 0,5% = 2 passes:** (1) sweep resiliente rpp=8 single-thread (~1,9% erro, ~34 min); (2) **2º passe** re-lê individualmente só os `erro_leitura` (orçamento de retry cheio por paciente → quase todos passam) → residual < 0,5%. Depois: CSV + auditoria de subagentes nos flagados.

## DECISÕES DE RÉGUA (dono 03/07) — aplicar no classificador
- **Concluído a partir de 85%** (era 80%). MARILEI (83%) deixa de ser concluído → vira parcial.
- **Abandono: parcial + silêncio ≥ 90D** (3 meses). Abaixo de 90D → tratamento iniciado (recente).
- **Matching de procedimento: NÃO refinar** — verificado em 3 casos (MARILEI/MARCELO/CECÍLIA) que o match por id é ACURADO (os "extras" são Fotos/Medidas ou sem-nome, não variantes). 70-83% são parciais REAIS. Refinar por nome inflaria falso.
- **Campo Kommo novo "Inativo"** (1 select): opções **90D / 180D / 360D / 540D / 720D** (marca a faixa de silêncio; <90D não marca). Criar via `POST /leads/custom_fields`. Enriquecer cada lead com a faixa.
- **Re-classificação sem re-ler:** os sinais do sweep (cob, sil, cancApos, fut, gFut, no, aprov) + a branch do roteador (implícita na regra antiga) bastam para re-aplicar os novos limiares localmente. Falta só teveGrupoB explícito → inferir da regra antiga (§5.1 ⟹ teve).

## VALIDAÇÃO + PLANILHA (03/07, pedido do dono)
- **Amostra controlada (800 pac, 2 workers) provou o fix:** distribuição REAL (excl. erros) = **concluído ~40% · abandono ~36% · captura/perdido ~13%** (era "57%" contaminado) · pós-consulta 4% · cancelamento 3% · resto <2%. Confirma: o "captura/perdido" era quase todo erro de leitura. MAS a 2 workers ainda 17% `erro_leitura` (o global `subreqUsados` bloqueia retries sob concorrência) → **run limpo = single-thread** (0 erro nos testes manuais).
- **Sweep enriquecido:** cada linha agora traz `nome, tel, regra, stage, na, no, cob, sil, aprov, cancApos, fezTodos, fut, gFut, flags` (flags determinísticos: abandono_quase_concluido, abandono_recente, concluido_no_limite, captura_com_agendas, cancelamento_multi_orcamento, truncado, sem_nome). ⚠️ `tel` vem vazio (paciente/lista não traz telefone — lookup extra se quiser).
- **Checklist robusto:** `docs/migracao/CHECKLIST-VALIDACAO.md` (0 leitura → 1 roteador → 2 consistência regra → 3 casos-limite → 4 identidade → 5 invariantes; veredito OK/REVISAR/ERRO_CLASSIFICACAO/ERRO_LEITURA).
- **EM ANDAMENTO:** run limpo single-thread da base (shard_30, ~34 min) → gera a **planilha rica**. **Próximo:** CSV (nome+classificação+sinais+flags) + **subagentes auditam os leads FLAGADOS** (casos-limite) contra o checklist. Subagentes em concorrência CONTROLADA (poucos, senão recriam o 429).

## 🐞 BUG CRÍTICO achado + corrigido (03/07) — falha de leitura vira "sem histórico"
- **Sintoma:** o dono pediu p/ ver os 1.065 "captura/perdido". Amostra "na=0 sem histórico" tinha o pid 5335402 — que REALMENTE tem 15 agendas/4 orç (abandono). Sondei 4/4 "sem histórico": TODOS têm histórico (abandono/concluído/pós-consulta), **nenhum é captura/perdido**.
- **Causa:** sob concorrência (6 agentes), o CNN deu 429 → os readers do sweep (`migAgendasSweep`/`migOrcamentosSweep`) faziam `catch { break }` e devolviam VAZIO **silenciosamente** → paciente parecia "sem histórico" → §5.2 captura/perdido por engano. O flag `incompleto` só pegava truncamento de página, não falha de leitura.
- **Fix aplicado:** readers agora retornam `ok=false` quando a 1ª leitura (futura ou passada pág 0) FALHA; `handleMigSweep` marca esses como **`erro_leitura`** (conta em `erros_leitura`, NÃO classifica). Assim falha de leitura nunca mais vira classificação falsa.
- **IMPACTO:** a distribuição provisória (57% captura/perdido etc.) e as barras de quantidade por paciente estão **CONTAMINADAS** (vieram do sweep concorrente com falhas) → **INVÁLIDAS**. Continuam válidos: status de agenda (via `/debug-cnn-shape`) e a amostra de cobertura (sondada direto). **Ação:** re-rodar o sweep **single-thread / baixa-concorrência** (testes manuais 1-thread deram 0 erro) para a distribuição REAL, agora com `erro_leitura` visível.
- **Nota operacional:** `wrangler dev --remote` está MUITO flaky (cai sozinho, IP oscila) → caminho 2 é frágil para operação longa; reconsiderar caminho 1 (script local) se a instabilidade persistir.

## APRENDIZADO — orquestração do sweep (03/07)
- **Agentes LLM = ferramenta ERRADA para o sweep mecânico.** O Workflow com 6 agentes: 40 min, 281k tokens, 3 agentes não retornaram o JSON estruturado, vários com PowerShell interrompido antes de terminar (shards com 32-112 pacientes de ~1376 esperados). Quando o PowerShell rodou até o fim (1 shard = 1360), funcionou. Paralelismo é limitado pelo **rate-limit do CNN** de qualquer jeito. → **Solução: driver de fundo com jobs paralelos (`sweep_driver.ps1`, N=4)** — a CLASSIFICAÇÃO continua sendo o código determinístico no Worker; só o *driver* deixou de ser agente. Confiável e barato. Regra geral: use agentes para trabalho que precisa de julgamento; use script para varredura mecânica I/O-bound.

## REFINAMENTO abandono→concluído (03/07, dono pediu amostras de abandono)
- **Achado:** o `fezTodos` exigia 100% EXATO de cada tipo → jogava quase-concluídos no abandono. Ex.: MARILEI (pid 5613474) fez 10/12 unidades (83%), ativa até out/2025, → caía em abandono indevido.
- **Fix aplicado:** `fezTodos` agora = **cobertura por unidades (capadas por tipo) ≥ `MIG_CONCLUIDO_PCT` (default 80%)**. `cobertura_pct` exposto no probe. Validado real: MARILEI 83%→concluído; DANIELA 67%/THOMAS 69%/DENISE 64%→abandono (corretos); 5335104 100%→concluído e 5335540 (cancelou)→cancelamento sem regressão.
- **Knobs em aberto (confirmar c/ dono):** limiar de conclusão (80% default; 85/90% possíveis) e silêncio p/ abandono (180d do v3; 365d discutido — mas com o fix de cobertura, os abandonos restantes já são todos >1 ano). **Impacto na distribuição da base ainda não medido** (exige re-rodar o sweep).

## CLASSIFICADOR — estado
- `classificarMigracao` (puro) + `derivarSinaisMig` + `migAgendas/OrcamentosPaciente` + `handleMigProbe` em src/index.ts. Rota `/debug-migra-probe?pid=&env=production` (read-only, via `wrangler dev --remote`). **Fixes aplicados:** procedimentos casam em QUALQUER grupo; estado líquido do último aprovado; abandono por silêncio. **Pendente:** §5.0 reset (ainda não avaliado); §6 enrichment (Fonte enum + lead.price); writer (CREATE p/ históricos sem lead + forward-only). Próximo: Fase 2 dry-run sweep (contagens p/ o portão do dono).
> **kommo_atual vazio nos históricos de 2021** → muitos pacientes NÃO têm lead no Kommo → o writer terá de **CRIAR card** (não só mover). Escopo maior; considerar no motor.

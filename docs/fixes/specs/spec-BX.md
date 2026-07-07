SPEC pronto para BX[1,2]. Li o código real (`D:/clarissa-bergmann/kommo-cnn/src/index.ts`). Abaixo, diffs exatos, plano de teste, riscos e as decisões.

---

# BX1 — `audit()` também registrar FALHAS relevantes

## Diagnóstico
Hoje `audit()` (linha 689) é chamado em **6 pontos, todos de SUCESSO**: `card-criado`, `card-b-criado`, `etapa-movida`, `adiado-expirado` (consumirFila, 2140–2143) e `vespera-move` (cronVespera, 2241). O `catch` de `consumirFila` (2155–2166) e os "skips silenciosos" do ORC **não deixam rastro na `auditoria`** — só bumpam contadores efêmeros em `out` e, no caso de erro, marcam a fila. Ou seja: um item que **esgota tentativas e vira dead-letter** some do `/debug-audit`; só aparece na tabela `fila_trabalho` (via `/debug-fila-erros`), sem timeline nem correlação com os moves.

Escolhi **2 pontos de maior valor** (baratos, baixo ruído, sem mudar comportamento):

### Ponto 1 (PRIMÁRIO) — dead-letter no `catch` de `consumirFila`
É o sink genérico: pega falha TERMINAL de **qualquer** consumidor (A3/F2/ORC/A4 — inclusive `throw` do create de card B em `consumirItemOrcamento:2084`). Logar **só o dead-letter** (esgotou `FILA_MAX_TENTATIVAS`) → **1 linha por item, permanente**; transitórios e retries intermediários **não** poluem o log (mesma condição que `filaMarcarErro` usa para virar status `'erro'`).

Observação de corretude: `item.tentativas` no `catch` já é o valor **pós-claim** (o `filaClaimLote` faz `tentativas=tentativas+1` e `RETURNING` devolve o novo valor); por isso `filaMarcarErro(item.id, item.tentativas ?? 0, …)` já usa esse valor. Reuso o mesmo.

**Antes (2155–2166):**
```ts
    } catch (e) {
      const transitorio = ehTransitorio(e);
      out.erros++;
      if (transitorio) out.transitorios = (out.transitorios ?? 0) + 1;
      if (!dryRun) {
        // Transitório (429/503/rede após retries): NÃO queima tentativa — devolve à fila
        // (desfaz o +1 do claim). Permanente (4xx etc.): conta a tentativa (pode dead-letter).
        if (transitorio) await filaAdiar(item.id, env);
        else await filaMarcarErro(item.id, item.tentativas ?? 0, String(e), env);
      }
      out.itens.push({ id: item.id, pac: item.paciente_id_cnn, erro: String(e), transitorio });
    }
```

**Depois:**
```ts
    } catch (e) {
      const transitorio = ehTransitorio(e);
      const tentativas = Number(item.tentativas) || 0; // já pós-claim (filaClaimLote incrementou)
      const deadLetter = !transitorio && tentativas >= FILA_MAX_TENTATIVAS; // mesma condição de filaMarcarErro
      out.erros++;
      if (transitorio) out.transitorios = (out.transitorios ?? 0) + 1;
      if (deadLetter) out.dead_letters = (out.dead_letters ?? 0) + 1;
      if (!dryRun) {
        // Transitório (429/503/rede após retries): NÃO queima tentativa — devolve à fila
        // (desfaz o +1 do claim). Permanente (4xx etc.): conta a tentativa (pode dead-letter).
        if (transitorio) await filaAdiar(item.id, env);
        else await filaMarcarErro(item.id, tentativas, String(e), env);
        // BX1: falha TERMINAL (esgotou tentativas → status 'erro') deixa rastro na auditoria.
        // Só o dead-letter (1x por item) — transitórios/retries intermediários não poluem o log.
        if (deadLetter) await audit(env, {
          funcao: item.tipo ?? "FILA", ambiente: target,
          entidade_id: item.paciente_id_cnn ?? String(item.id), acao: "dead-letter",
          detalhe: `item ${item.id} pac ${item.paciente_id_cnn} tent ${tentativas}: ${String(e).slice(0, 160)}`,
        });
      }
      out.itens.push({ id: item.id, pac: item.paciente_id_cnn, erro: String(e), transitorio, dead_letter: deadLetter });
    }
```

### Ponto 2 (SECUNDÁRIO) — ORC `sem_dados` (venda aprovada sem identidade)
`consumirItemOrcamento:2080` retorna `{r:"sem_dados"}` quando há **orçamento APROVADO mas sem telefone/nome no CNN** → não dá pra criar o card B. É uma **venda real que não vira card** e hoje é 100% invisível (só `out.sem_dados++` em 2150). O `catch` do Ponto 1 **não cobre** isso (é retorno normal, não `throw`), então é complementar. Barato: 1 linha na cadeia `else if` já existente.

**Antes (2143–2144):**
```ts
          else if (res.r === "adiado_expirado") await audit(env, { funcao: "ORC", ambiente: target, entidade_id: res.leadId, acao: "adiado-expirado", detalhe: `ORC pac ${item.paciente_id_cnn}` });
        }
```

**Depois:**
```ts
          else if (res.r === "adiado_expirado") await audit(env, { funcao: "ORC", ambiente: target, entidade_id: res.leadId, acao: "adiado-expirado", detalhe: `ORC pac ${item.paciente_id_cnn}` });
          else if (res.r === "sem_dados") await audit(env, { funcao: "ORC", ambiente: target, entidade_id: item.paciente_id_cnn, acao: "orc-sem-dados", detalhe: `APROVADO sem telefone/nome no CNN → card B não criado (pac ${item.paciente_id_cnn})` });
        }
```
Volume: a chave ORC é `ORC:${pid}:${hoje}` (1x/dia por paciente), então isso loga no máximo 1x/dia por paciente nesse estado — condição rara, sinal de qualidade de dado, sem risco de flood.

**Opcionais (NÃO recomendo agora, menor valor / mais ruído):** `sem_lead` no ORC (ABERTO/CANC sem card A é "pula por design"), e o `catch` por-lead de `cronVespera:2244` (falha de move de véspera só vai pra `out.acoes` efêmero). Deixo listados caso o dono queira; fora do escopo "1–2".

---

# BX2 — consistência `orcamento_sync.ultimo_status` × `ultima_etapa`

## Diagnóstico (nomes/uso)
- `ultima_etapa` (INTEGER) guarda `decisao.status` — que é um **status_id/ETAPA do Kommo** (ex.: `STAGE_POS_TRATAMENTO_INICIADO`; ver `decidirEtapaOrcamento:923` retornando `{pipeline, status}`). É a **única** chave de idempotência (comparada em `consumirItemOrcamento:2071` e `:2101`).
- `ultimo_status` (TEXT) guarda `resumo` — o **status do ORÇAMENTO no CNN** ("APROVADO"/último). É **write-only**: gravado em todo upsert (2066/2085/2102/2108) e **nunca lido** por lógica de decisão, nem exposto em nenhum endpoint `/debug`. Dado morto.
- A palavra "status" está **sobrecarregada**: `ultimo_status`=status CNN vs `decisao.status`=etapa Kommo (guardado em `ultima_etapa`). É a raiz da confusão apontada no item.

## Polimentos (baratos, seguros, SEM mudança de comportamento)
Renomear coluna é migração de schema → **fora** (ver [DECISAO] abaixo). Duas mudanças aditivas:

### P1 — Documentar semântica/uso (comentários)
**No schema (acima da linha 560), depois do comentário existente:**
```ts
    // Reflexo de orçamento CNN → etapa Kommo (fundação read-only, spec 2026-07-01).
    // Espelha agenda_sync: 1 linha por paciente, idempotência do "move só 1x por mudança".
    // COLUNAS (nomes/uso — BX2): `ultima_etapa` = status_id (ETAPA) do Kommo já refletido =
    //   ÚNICA chave de idempotência (== decisao.status em consumirItemOrcamento).
    //   `ultimo_status` = resumo do status do ORÇAMENTO no CNN ("APROVADO"/último) = só
    //   OBSERVABILIDADE, nunca entra em decisão. "status" é sobrecarregado de propósito:
    //   ultimo_status = status do CNN; ultima_etapa = etapa do Kommo (decisao.status).
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS orcamento_sync (
      paciente_id_cnn TEXT PRIMARY KEY, lead_id_kommo TEXT, ultimo_status TEXT, ultima_etapa INTEGER, updated_at INTEGER)`),
```

**No helper `getOrcamentoSync` (acima da linha 949), 1 linha:**
```ts
// ⚠️ Idempotência olha SÓ `ultima_etapa` (etapa Kommo); `ultimo_status` (status CNN) é observabilidade.
async function getOrcamentoSync(pid: string, env: Env): Promise<{ ultimo_status: string | null; ultima_etapa: number | null } | null> {
```

### P2 — Tornar `ultimo_status` legível (fecha a inconsistência de "uso": passa a ser lido)
Expor `orcamento_sync` no `/debug-orcamento?paciente=…&decidir=1` (read-only, aditivo). Assim o estado refletido aparece ao lado da decisão fresca — ótimo pra explicar "por que deu `sem_mudanca`" — e a coluna deixa de ser dado morto.

**Antes (2812–2818):**
```ts
    return Response.json({
      pid: paciente,
      temAgendaFutura: temFutura,
      cutoffAprovacao: cutoffAprov,
      orcamentos: orcs.map((o: any) => ({ id: o.id, status: o.status, dataAprovacao: o.dataAprovacao })),
      decisao: decidirEtapaOrcamento(orcamentosRecentes(orcs, cutoffAprov), temFutura),
    });
```
**Depois:**
```ts
    return Response.json({
      pid: paciente,
      temAgendaFutura: temFutura,
      cutoffAprovacao: cutoffAprov,
      orcamentos: orcs.map((o: any) => ({ id: o.id, status: o.status, dataAprovacao: o.dataAprovacao })),
      decisao: decidirEtapaOrcamento(orcamentosRecentes(orcs, cutoffAprov), temFutura),
      orcamento_sync: await getOrcamentoSync(paciente, env), // BX2: ultima_etapa=idempotência; ultimo_status=obs
    });
```

Nada a mudar na simulação do selftest (3126–3152): já usa os mesmos nomes; manter idêntico para não alterar comportamento.

---

# Plano de teste local

1. **Build/type-check:** `cd kommo-cnn && npx tsc --noEmit` (ou `npx wrangler deploy --dry-run`). Confere que `FILA_MAX_TENTATIVAS`, `target`, `item.tipo`, `getOrcamentoSync` estão em escopo nos pontos editados (todos estão).
2. **Regressão da fila (sem tocar rede):** `npx wrangler dev` + `curl "localhost:8787/debug-selftest?mode=logic"`, `…?mode=fuzz`, `…?mode=stress` — devem seguir verdes (a lógica de claim/adiar/erro não muda; só somamos `audit()` + contadores).
3. **Repro do dead-letter (BX1-Ponto1), local D1:** com `wrangler dev`, inserir 1 item-veneno cujo consumidor lance erro **permanente** e cujas `tentativas = FILA_MAX_TENTATIVAS - 1` (o claim leva a MAX). Exemplo de fixture: item `tipo:"ORC"` de um `paciente_id_cnn` com APROVADO mas `criarCardLead`→null (força o `throw` em 2084) — ou, mais determinístico, mockar `kommoPatch` para 400. Rodar `/debug-tick` (não-dry) 1x e verificar:
   - `/debug-audit` → aparece `funcao:"ORC", acao:"dead-letter"` em `recentes`;
   - `/debug-fila-erros` → item em `status:'erro'`;
   - transitório (mock 503) **não** gera linha de auditoria (só `filaAdiar`).
4. **BX1-Ponto2 (`sem_dados`):** enfileirar ORC de paciente com APROVADO sem telefone/nome; `/debug-tick` → `/debug-audit` mostra `acao:"orc-sem-dados"`.
5. **BX2:** `curl "…/debug-orcamento?paciente=28146949&decidir=1"` → resposta agora traz `orcamento_sync`. Rodar 1 reflexo (`&aplicar=1&dry=0` em sandbox, registro TESTE Bruno) e re-consultar → `ultimo_status:"APROVADO"`, `ultima_etapa:<stage>` visíveis. Reverter o move de teste depois (limpeza).

---

# Riscos
- **Baixíssimo.** `audit()` já é try/catch interno ("auditoria nunca quebra o fluxo") → não afeta a fila. Todas as chamadas novas estão sob `if (!dryRun)`, coerente com o resto.
- **Custo D1:** +1 INSERT em auditoria só no dead-letter (raro) e no `sem_dados` (≤1x/dia/paciente). Sem impacto no teto de 50 sub-requests (D1 não conta).
- **P2** adiciona 1 leitura D1 ao endpoint de debug `decidir=1` (não ao caminho de produção). Sem efeito em runtime do cron.
- Nenhuma alteração de schema, de idempotência, de fluxo de fila ou de decisão do ORC.

---

# [DECISAO] (única, opcional — NÃO incluída nos diffs)
Renomear as colunas para nomes autoexplicativos (ex.: `ultima_etapa`→`ultima_etapa_kommo`, `ultimo_status`→`ultimo_status_cnn`) exigiria **migração de schema** em D1 remoto (não é barato/seguro, e o token CF oscila). Recomendo **não** renomear; a inconsistência de nomes fica resolvida por P1 (docs) + P2 (uso). Se o dono quiser o rename real depois, é item separado com migração planejada.
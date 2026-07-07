I have everything I need. Here is the ready-to-implement spec.

---

# SPEC A1a — Guard: não reconciliar órfãos A quando a coleta de `/agenda/lista` foi PARCIAL

Arquivo: `D:/clarissa-bergmann/kommo-cnn/src/index.ts`
Função: `produtorSync` (linhas ~1610–1719)

## 1. Diagnóstico (causa-raiz e trace exato da falha)

O loop de paginação (linhas 1617–1626) faz `catch { break; }` quando uma página de `/agenda/lista` falha:

```ts
const todas: any[] = [];
let pag = 0, totalPag = 1;
while (pag < totalPag) {
  let r: any;
  try { r = await cnnGet(`/agenda/lista?...&pagina=${pag}`, env, target); }
  catch { break; }                                  // ← coleta pode ficar PARCIAL
  totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
  for (const a of (r?.lista ?? [])) todas.push(a);
}
out.agendas = todas.length;
```

O `break` também dispara sob esgotamento de budget: o loop NÃO tem `&& orcamentoOk()` (diferente do loop de orçamentos na linha 271), então ao estourar o teto de subrequests o `fetch` lança → `fetchComRetry` esgota (`podeRetentar=orcamentoOk()` vira false) → `cnnGet` propaga → `catch { break }`. Ambos os modos (erro de rede/CNN e budget) resultam em coleta parcial.

A reconciliação de órfãos A (linhas 1694–1711) INFERE ausência de agenda vigente a partir do que foi coletado e rebaixa o card para rota terminal:

```ts
for (const [chave, leadId] of mapLead) {
  const [pid, g] = chave.split("|");
  if (g !== "A" || comVigenteA.has(pid)) continue;
  const aAgs = porPaciente.get(pid)?.A ?? [];
  if (!aAgs.length) continue;                        // protege só o caso TOTALMENTE ausente
  const recente = aAgs.reduce((m, a) => ((a.ts||0) > (m.ts||0) ? a : m));
  const destino = destinoStatus("A", recente.status) ?? STAGE_CANCELADA_PERDIDO;
  out.orfaos_a++;
  aEnfileirar.push({ chave:`A3:orphan:${pid}:A:${destino}`, ... payload:{ kind:"orphan", leadId, destino } });
}
```

**Trace do rebaixamento indevido** — paciente P com duas agendas A:
- A1 = `CONFIRMADO_PACIENTE`, futura → em uma página que FALHOU (não carregou).
- A2 = `CANCELADO` (ou `FINALIZADO`/`FALTOU`), passada → em uma página que carregou.

Resultado com coleta parcial:
1. `porPaciente[P].A = [A2]` (A1 ausente).
2. `nearestVigente([A2])`: `elig` filtra não-terminais → `[]` → retorna `null` → P **não** entra em `comVigenteA`.
3. Órfãos: P não está em `comVigenteA`; `aAgs=[A2]`, `length=1` → **não** cai no `if (!aAgs.length) continue`. `recente=A2` → `destino = Perdido/Avaliação` → enfileira `orphan` → consumidor move o card A para rota terminal.

P tinha consulta CONFIRMADA futura e foi rebaixado para "Venda Perdida" só porque a página dele não carregou. O guard atual (`if (!aAgs.length) continue`) só cobre o caso em que o paciente está **inteiramente** ausente; NÃO cobre o caso misto (terminal carregada + vigente na página faltante), que é exatamente o modo de falha do A1a.

**Nota:** os itens de `sync` (seção 2) são seguros sob coleta parcial — só avançam o card com base em agendas realmente vistas, são idempotentes (chave inclui `status:tsBucket`, dedupe via `sem_mudanca`) e o que faltou é reprocessado no próximo tick. Apenas a reconciliação de **órfãos** (que age por INFERÊNCIA DE AUSÊNCIA) é insegura. Logo o guard deve envolver só o loop de órfãos.

## 2. Correção

### Diff 1 — computar `coletaCompleta` no fim da paginação

Localização: linhas 1617–1626.

Trecho ATUAL:
```ts
  const todas: any[] = [];
  let pag = 0, totalPag = 1;
  while (pag < totalPag) {
    let r: any;
    try { r = await cnnGet(`/agenda/lista?dataInicial=${ini}&dataFinal=${fim}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch { break; }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
    for (const a of (r?.lista ?? [])) todas.push(a);
  }
  out.agendas = todas.length;
```

Trecho NOVO:
```ts
  const todas: any[] = [];
  let pag = 0, totalPag = 1;
  let coletaCompleta = true;                          // A1a: vira false se uma página falhar (break)
  while (pag < totalPag) {
    let r: any;
    try { r = await cnnGet(`/agenda/lista?dataInicial=${ini}&dataFinal=${fim}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch { coletaCompleta = false; break; }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
    for (const a of (r?.lista ?? [])) todas.push(a);
  }
  // A1a: coleta só é confiável se drenou TODAS as páginas. `pag >= totalPag` é a
  // defesa robusta (cobre também eventual break por budget/guard futuro no while).
  coletaCompleta = coletaCompleta && pag >= totalPag;
  out.agendas = todas.length;
  out.coleta_completa = coletaCompleta;               // observabilidade
```

`pag >= totalPag` é verdadeiro **se e somente se** o loop saiu por exaustão da condição (todas as páginas consumidas): no `catch`-break, `pag` não é incrementado para a página que falhou e `totalPag` mantém o valor anterior, então `pag < totalPag`. Manter as DUAS condições (`coletaCompleta && pag >= totalPag`) é cinto-e-suspensório: sobrevive a alguém adicionar futuramente um `&& orcamentoOk()` no `while` (que sairia com `pag < totalPag` sem passar pelo `catch`).

### Diff 2 — envolver a reconciliação de órfãos no guard

Localização: linhas 1691–1711.

Trecho ATUAL:
```ts
  // 3. Reconciliação de órfãos A: (pac,"A") mapeado sem agenda A vigente.
  //    Rota = status da A mais RECENTE da janela via MAPA_STATUS (FINALIZADO→Avaliação,
  //    CANCELADO→Perdido, FALTOU→Primeiro Contato); A ausente da janela → Perdido (143).
  for (const [chave, leadId] of mapLead) {
    const [pid, g] = chave.split("|");
    if (g !== "A" || comVigenteA.has(pid)) continue;
    const aAgs = porPaciente.get(pid)?.A ?? [];
    // Sem NENHUMA agenda A na janela −2/+14: NÃO marca Perdido — pode ser consulta futura ALÉM
    // de +14d (o backfill mapeou até 90d); marcar Perdido perderia paciente com consulta marcada
    // longe. Só reconcilia órfão quando há agenda A TERMINAL na janela (sinal claro: cancelada/
    // faltou/finalizada). Caso fora-da-janela é tratado quando a agenda entrar em −2/+14.
    if (!aAgs.length) continue;
    const recente = aAgs.reduce((m, a) => ((a.ts || 0) > (m.ts || 0) ? a : m));
    const destino = destinoStatus("A", recente.status) ?? STAGE_CANCELADA_PERDIDO;
    out.orfaos_a++;
    aEnfileirar.push({
      chave: `A3:orphan:${pid}:A:${destino}`, tipo: "A3",
      agenda_id_cnn: "", paciente_id_cnn: pid, grupo: "A",
      payload: { kind: "orphan", leadId, destino },
    });
  }
```

Trecho NOVO:
```ts
  // 3. Reconciliação de órfãos A: (pac,"A") mapeado sem agenda A vigente.
  //    Rota = status da A mais RECENTE da janela via MAPA_STATUS (FINALIZADO→Avaliação,
  //    CANCELADO→Perdido, FALTOU→Primeiro Contato); A ausente da janela → Perdido (143).
  // GUARD A1a: só reconcilia se a coleta foi 100%. Com coleta PARCIAL (uma página
  // falhou/budget estourou), um paciente pode ter a agenda vigente na página que não
  // carregou e uma A terminal na que carregou → rebaixá-lo pra Perdido/terminal seria
  // INDEVIDO. Nesse caso pulamos toda a reconciliação; os `sync` de quem carregou
  // seguem normalmente e os órfãos reais são reconciliados no próximo tick completo.
  if (!coletaCompleta) {
    out.orfaos_parcial_skip = true;
  } else {
    for (const [chave, leadId] of mapLead) {
      const [pid, g] = chave.split("|");
      if (g !== "A" || comVigenteA.has(pid)) continue;
      const aAgs = porPaciente.get(pid)?.A ?? [];
      // Sem NENHUMA agenda A na janela −2/+14: NÃO marca Perdido — pode ser consulta futura ALÉM
      // de +14d (o backfill mapeou até 90d); marcar Perdido perderia paciente com consulta marcada
      // longe. Só reconcilia órfão quando há agenda A TERMINAL na janela (sinal claro: cancelada/
      // faltou/finalizada). Caso fora-da-janela é tratado quando a agenda entrar em −2/+14.
      if (!aAgs.length) continue;
      const recente = aAgs.reduce((m, a) => ((a.ts || 0) > (m.ts || 0) ? a : m));
      const destino = destinoStatus("A", recente.status) ?? STAGE_CANCELADA_PERDIDO;
      out.orfaos_a++;
      aEnfileirar.push({
        chave: `A3:orphan:${pid}:A:${destino}`, tipo: "A3",
        agenda_id_cnn: "", paciente_id_cnn: pid, grupo: "A",
        payload: { kind: "orphan", leadId, destino },
      });
    }
  }
```

### Diff 3 (opcional, observabilidade) — declarar os campos no `out` inicial

Localização: linha 1615. Puramente cosmético (mantém as chaves visíveis mesmo no caminho feliz). Ajustar a linha do `out` para incluir `coleta_completa: true, orfaos_parcial_skip: false` junto aos demais contadores. Não é obrigatório — `out.coleta_completa` já é setado no Diff 1.

## 3. Plano de teste local

Pré: `cd D:/clarissa-bergmann/kommo-cnn`.

1. **Compila / typecheck** (garante que o novo `let coletaCompleta` e o bloco `if/else` não quebram o TS):
   `npx tsc --noEmit` (ou `npx wrangler deploy --dry-run --outdir=/tmp/build`).

2. **Regressão — caminho feliz (coleta completa) contra CNN prod (read-only)**, via edge sem deploy:
   `npx wrangler dev --remote`, depois
   `GET /debug-tick?job=sync&prod=1&dry=1&env=production&cap=8`
   Verificar em `out.produtor`:
   - `coleta_completa === true`
   - `orfaos_parcial_skip` ausente/false
   - `orfaos_a` com o mesmo valor de antes da mudança (o guard não altera comportamento quando a coleta é completa — é a prova de não-regressão).
   Como `produtorSync` enfileira de fato (não tem modo dry próprio; `dry` só afeta o consumidor), **limpar depois**: `GET /debug-tick?clear=1` (purga `fila_trabalho`) — coerente com a regra "limpar após teste". O consumidor rodou com `dry=1`, então nenhum lead foi movido.

3. **Caminho do guard (coleta parcial)** — não reproduzível em prod (CNN prod devolve páginas íntegras). Validar por UM dos dois caminhos:
   - (a) **Inspeção dirigida / reasoning** do trace da seção 1 sobre o código final: com `coletaCompleta=false`, o `for` de órfãos não executa e `out.orfaos_parcial_skip=true`; nenhum item `kind:"orphan"` é enfileirado; itens `sync` seguem intactos.
   - (b) **Micro-refactor OPCIONAL para teste unitário** (fora do escopo estrito do item): extrair a paginação para um helper com `cnnGet` injetável e adicionar um caso ao `/debug-selftest?mode=logic` que simula 3 páginas onde a página 2 lança — assertando `coleta_completa=false` e zero itens orphan enfileirados vs. o mesmo cenário com as 3 páginas OK (orphan esperado). Só vale a pena se o dono quiser cobertura automatizada; ver [DECISAO 2].

4. **Sanidade da fila**: após o passo 2, `GET /debug-fila-erros` deve continuar vazio (o guard não introduz itens de erro).

## 4. Riscos e efeitos colaterais

- **Baixo — atraso de reconciliação:** numa coleta parcial, os órfãos REAIS (de fato sem agenda vigente) deixam de ser rebaixados naquele tick. São reconciliados no próximo tick com coleta completa. Trade-off correto: adiar um rebaixamento legítimo é reversível/idempotente; um rebaixamento INDEVIDO para "Perdido" dispara efeitos (Salesbot/etapa) e é o dano que o item pede para evitar.
- **Muito baixo — coleta cronicamente parcial:** se a janela −2/+14 passar a exceder o budget de subrequests de forma persistente, os órfãos nunca reconciliariam. Improvável com 200/página numa janela de 16 dias. Observável por `out.coleta_completa`/`out.orfaos_parcial_skip` em `wrangler tail`/`/debug-tick`. Mitigação futura fora do escopo (paginação com cursor persistente entre ticks).
- **Nulo em concorrência:** mudança é local à invocação (`coletaCompleta` é variável de função). Não toca `subreqUsados`, lease (B2) nem claim (C1).
- **Superfície mínima:** só adiciona 1 variável local, 1 branch e 2 campos em `out`. Não altera assinatura de `produtorSync`, schema D1, nem chaves de fila.

## 5. Decisões do dono

- **[DECISAO 1]** Comportamento sob coleta parcial: o spec adota **pular TODA a reconciliação de órfãos** (mais simples e seguro). Alternativa mais granular seria reconciliar apenas pacientes cuja página foi confirmadamente lida — porém a API não expõe "qual página tem qual paciente", então não é implementável de forma confiável. Confirmar que o skip-total é aceitável (é a recomendação).
- **[DECISAO 2]** Adicionar ou não o micro-refactor para teste unitário automatizado no `/debug-selftest?mode=logic` (passo 3b). Recomendação: adiar — a mudança é pequena/auditável e o teste manual (passo 2, prova de não-regressão) cobre o risco prático. Fazer só se o dono quiser guardrail permanente.
- **[DECISAO 3]** (fora do escopo, apenas sinalizar) O loop de paginação de `produtorSync` não tem `&& orcamentoOk()` no `while` (ao contrário do loop de orçamentos, linha 271). Hoje isso é inofensivo para o A1a (budget estourado → break → `coletaCompleta=false` → guard protege). Se quiser parada limpa por budget no futuro, o `pag >= totalPag` no Diff 1 já mantém o guard correto. Não requer ação agora.
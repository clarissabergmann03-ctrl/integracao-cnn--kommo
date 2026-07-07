# SPEC A7 — Criação de card resiliente a duplicata (adoção por `ID Paciente CNN`)

## 1. Objetivo e enquadramento

Fechar o residual **"POST sucedeu mas a resposta se perdeu"**: hoje `retryPost()` (A4) só evita **re-POST** em 5xx/rede (não re-tenta), mas **não recupera** um card que já nasceu no Kommo quando a resposta se perdeu — na próxima passada o `getMapeamento` está vazio, o `acharLeadPorTelefone` pode não casar (telefone diverge/colide), e aí `criarCardLead` **cria um 2º card no mesmo funil** → viola o invariante "0 duplicata dentro do mesmo funil".

Solução: **antes de POSTar**, dentro de `criarCardLead`, procurar um lead que **já tenha aquele `ID Paciente CNN` (custom field) no pipeline do grupo**. Se existir → **ADOTAR** (gravar mapeamento + baseline) e devolver esse `leadId`, sem criar. Como fica **dentro de `criarCardLead`**, vale automaticamente para **todos** os call-sites: A4 (`consumirItemA4` ~1598), A3 (`consumirItemA3` ~1793), ORC create-B (`consumirItemOrcamento` ~2083) e `splitColisaoTelefone` (~3794).

Chave de identidade: `ID Paciente CNN` é **identidade exata** por paciente CNN, ao contrário do telefone (`phoneKey` COLIDE entre familiares — gotcha conhecido). Por isso é o critério certo para deduplicar.

---

## 2. [DECISAO / VERIFICAR ANTES DE MERGE] — o lookup por custom field

Kommo v4 tem duas formas de achar lead por valor de campo, e o projeto **já tem cicatriz** disso: *"`filter[status_id]` é SILENCIOSAMENTE IGNORADO → retorna a conta inteira"* (CLAUDE.md). Preciso escolher a que **não** dá esse tiro no pé.

- **Opção escolhida (primária): `query`** — full-text/substring search, o **mesmo mecanismo** que o código já usa e confia em `/contacts?query=<telefone>` (linhas 1509, 1260, 1394…). `query` **estreita** (retorna matches ou vazio); não tem o modo de falha "ignora o filtro e devolve tudo". Custo: **1 subrequest**, 1 página (o pid é específico → poucos matches). O endpoint `/leads` **retorna `custom_fields_values` e `pipeline_id` inline**, então dá pra **confirmar em código**.

  ```
  GET /leads?query=<pid>&limit=250
  ```

- **Risco a validar empiricamente:** não está 100% garantido que o `query` de **leads** indexa o valor de um campo **texto** "ID Paciente CNN" (para contatos, o telefone é indexado; para leads, campos texto *devem* ser, mas confirme). Se **não** indexar, o lookup volta sempre vazio → A7 vira no-op inócuo (não quebra nada, só não protege). **Gate:** rodar a probe read-only da §6.1 contra o card B de teste (pid `28146949`, criado no teste real do ORC create-B) **antes** de confiar no A7. Se `query` não achar:
  - **Fallback:** filtro documentado por custom field
    ```
    GET /leads?filter[custom_fields_values][<fieldId>][]=<pid>&limit=250
    ```
    tratando-o como **potencialmente ignorado**: ler **só a página 1**, **confirmar em código** (igual §3) e nunca paginar cegamente (limita o custo a 1 subreq mesmo que devolva a conta inteira). Se o campo for do tipo **numérico** em vez de texto, esse filtro é o caminho correto.
  - Verificar o **tipo** do campo em `/debug-mapa-campos` (a estrutura de `resolveFields` só guarda name→id, não o tipo). Se for numérico, prefira o filtro; se texto, `query`.

Em **todos** os casos a decisão final de adotar é **confirmada em código** (§3), então o pior caso de um `query` "largo" é um falso-positivo descartado, nunca uma adoção errada.

---

## 3. Código novo — helper de lookup + seleção pura

Inserir **imediatamente antes de `criarCardLead`** (hoje linha 1539, logo após o comentário do `acharLeadDoPaciente` removido, linhas 1531-1533):

```ts
// ── A7: seleção pura do card a ADOTAR (testável sem tocar Kommo) ───────────────
// De uma lista de leads (resposta do lookup), escolhe qual adotar: só os que estão
// no pipeline do grupo E cujo custom field "ID Paciente CNN" == pid (match EXATO —
// o `query` é substring/full-text, pode trazer falso-positivo). Prefere card ATIVO
// (não "perdido"=143); desempata pelo MENOR id (mais antigo/canônico).
function escolherCardAdotado(
  leads: any[], pid: string, pipelineId: number, fIdPaciente: number
): string | undefined {
  const cand = (leads ?? []).filter((l: any) =>
    Number(l.pipeline_id) === pipelineId &&
    String(getFieldValue(l, fIdPaciente) ?? "") === pid);
  if (!cand.length) return undefined;
  cand.sort((a: any, b: any) =>
    (Number(a.status_id) === STAGE_CANCELADA_PERDIDO ? 1 : 0) -
    (Number(b.status_id) === STAGE_CANCELADA_PERDIDO ? 1 : 0) ||
    Number(a.id) - Number(b.id));
  return String(cand[0].id);
}

// ── A7: lookup no Kommo por ID Paciente CNN (identidade forte), escopado ao grupo ─
// Fecha o residual "POST sucedeu, resposta perdida" que o retryPost (A4) só mitiga.
// Diferente de acharLeadPorTelefone: o telefone COLIDE entre pacientes; o ID Paciente
// CNN é identidade exata. Custo: 1 subrequest (1 página; pid específico → sem paginação).
// Falha de lookup NÃO bloqueia a criação (retorna undefined → cai no create atual).
async function acharLeadPorPacienteCnn(
  pid: string, grupo: "A" | "B", fields: Record<string, number>, env: Env
): Promise<string | undefined> {
  const fIdPaciente = fields["ID Paciente CNN"];
  if (!fIdPaciente || !pid) return undefined;
  let leads: any[] = [];
  try {
    const r = await kommoGet(`/leads?query=${encodeURIComponent(pid)}&limit=250`, env);
    leads = r._embedded?.leads ?? [];
  } catch { return undefined; }
  return escolherCardAdotado(leads, pid, pipelineDoGrupo(grupo), fIdPaciente);
}
```

Notas de dependências (tudo já existe no módulo): `getFieldValue` (346), `STAGE_CANCELADA_PERDIDO` (17), `pipelineDoGrupo` (97), `kommoGet` (300). `kommoGet` já passa por `fetchComRetry`/`retryPadrao` com guarda `orcamentoOk()`.

---

## 4. Encaixe em `criarCardLead` (diff exato)

Local: `criarCardLead` (1539-1567). Inserir o bloco de adoção **logo após a linha 1543** (o destructure de `fields`) e **antes** de `const leadName = ...` (1544).

**ANTES (1543-1544):**
```ts
  const fAgendamento = fields["AGENDAMENTO"], fIdAgenda = fields["ID Agenda CNN"], fIdPaciente = fields["ID Paciente CNN"];
  const leadName = p.nome + (p.sufixo ?? "");
```

**DEPOIS:**
```ts
  const fAgendamento = fields["AGENDAMENTO"], fIdAgenda = fields["ID Agenda CNN"], fIdPaciente = fields["ID Paciente CNN"];

  // ── A7: ADOÇÃO anti-duplicata. Antes de POSTar, procura um card já existente com este
  // ID Paciente CNN NO FUNIL DO GRUPO. Se existir, adota (grava mapeamento + baseline) em
  // vez de criar um 2º card. Fecha o residual "POST-sucedeu-mas-resposta-perdida" (A4 só
  // evita o re-POST; não recupera o card órfão). Escopo por pipeline do grupo garante que
  // um card A (Captação) e um card B (Pós-Venda) do MESMO paciente NÃO se adotem entre si
  // (modelo de duplicata intencional 1-por-grupo).
  const adotado = await acharLeadPorPacienteCnn(p.pid, p.grupo, fields, env);
  if (adotado) {
    await upsertMapeamento({
      paciente_id_cnn: p.pid, grupo: p.grupo, lead_id_kommo: adotado,
      telefone_norm: phoneKey(p.telefone), duplicata: !!p.sufixo,
    }, env);
    if (p.agendaId) {
      // Card adotado pode não ter os IDs desta agenda ainda → grava (idempotente) + baseline.
      await escreverVinculoCnn(adotado, String(p.agendaId), p.pid, p.cnnTs, fields, env);
      await upsertAgendaSync({
        agenda_id_cnn: String(p.agendaId), lead_id_kommo: adotado, paciente_id_cnn: p.pid,
        last_agendamento_ts: p.cnnTs, last_cnn_status: p.status ?? "",
      }, env);
    }
    await audit(env, {
      funcao: "A7", ambiente: "kommo", entidade_id: adotado, acao: "adotado_por_pid",
      de: mapeamentoKey(p.pid, p.grupo), para: adotado,
      detalhe: `create suprimido; card existente com ID Paciente CNN=${p.pid} no funil ${p.grupo}`,
    });
    return adotado;
  }

  const leadName = p.nome + (p.sufixo ?? "");
```

Restante de `criarCardLead` (1547-1567) **inalterado**.

Contrato preservado: continua `Promise<string | undefined>`, devolvendo um `leadId` válido tanto no create quanto na adoção. **Nenhum call-site precisa mudar** — todos já tratam o retorno como "o card do paciente". `getFieldValue`, `phoneKey`, `escreverVinculoCnn` (381), `upsertMapeamento` (718), `upsertAgendaSync` (881), `audit` (689), `mapeamentoKey` (715) já estão no escopo.

### 4.1 Comportamento por call-site (verificado nos fluxos reais)
- **A4** (1598) e **A3** (1793): só chamam `criarCardLead` **depois** de `getMapeamento` vazio **e** `acharLeadPorTelefone` sem match. A7 é a **3ª rede** (D1 grátis → telefone → **pid**), pega o lost-POST e o telefone-que-não-casou. Mantém `acharLeadPorTelefone` no caller (ele pega cards **manuais sem o pid gravado**, que o A7 não acha) — as redes são **complementares**, não redundantes.
- **ORC create-B** (2083): `grupo:"B"` → busca em Pós-Venda. `agendaId:""` → não dispara `escreverVinculoCnn`/`upsertAgendaSync` (guarda `if (p.agendaId)`), só `upsertMapeamento(pid,"B")`. Recupera exatamente o caso "card B criado mas mapeamento perdido".
- **`splitColisaoTelefone`** (3794): cria card para o paciente **escondido** (cujo pid **não** está em card nenhum) → A7 não acha → cria normalmente. **Bônus:** re-rodar o split vira **idempotente** (o card já criado agora tem o pid → é adotado, não duplicado).

---

## 5. Custo de subrequest

- `criarCardLead` **antes**: 1 (POST).
- **depois**, caminho create: 1 (lookup `query`) + 1 (POST) = **2**.
- **depois**, caminho adoção: 1 (lookup) + (0 ou 1 `escreverVinculoCnn` se houver agenda) = **1–2**, **sem POST**.

Pior caso passa de 1→2 subreq por criação. Criações são **raras** (a esmagadora maioria dos itens é sync/no-op) e o teto é 50 (`orcamentoOk` default 45). O `kommoGet` já respeita a guarda `orcamentoOk` via `retryPadrao`, e o loop de `consumirFila` (2122) para de chamar consumidores quando o budget acaba. **Sem gating extra necessário.** (Não gatear o lookup com um "pula se budget baixo": pular o lookup reabriria o risco de duplicata — e como já vamos gastar 1 subreq no POST de qualquer forma, o +1 do lookup é barato.)

---

## 6. Plano de teste local

### 6.1 Probe read-only (novo endpoint de debug) — valida a §2 antes de tudo
Adicionar handler (espelha `/debug-orcamento`, auth `discoverAuthOk`, `resetSubreq`). Rota junto aos demais (~4343):

```ts
    if (pathname === "/debug-lookup-paciente") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      const u = new URL(req.url);
      const pid = u.searchParams.get("pid") ?? "";
      const grupo = (u.searchParams.get("grupo") === "B" ? "B" : "A") as "A" | "B";
      const fields = await resolveFields(env);
      const fIdPaciente = fields["ID Paciente CNN"];
      const raw: any = await kommoGet(`/leads?query=${encodeURIComponent(pid)}&limit=250`, env);
      const leads = raw._embedded?.leads ?? [];
      return Response.json({
        pid, grupo, pipeline: pipelineDoGrupo(grupo),
        total_query: leads.length,
        adotaria: escolherCardAdotado(leads, pid, pipelineDoGrupo(grupo), fIdPaciente),
        amostra: leads.slice(0, 10).map((l: any) => ({
          id: l.id, pipeline: l.pipeline_id, status: l.status_id,
          pid_no_card: getFieldValue(l, fIdPaciente),
        })),
      });
    }
```

Rodar com `npx wrangler dev --remote` (secrets reais, **read-only**):
- `GET /debug-lookup-paciente?pid=28146949&grupo=B` → **esperado** `adotaria = <id do card B de teste>`, `total_query >= 1`, e a amostra mostrando `pid_no_card:"28146949"` no pipeline Pós-Venda. **Se `total_query=0`, o `query` NÃO indexa o campo → aplicar o fallback filtro da §2.**
- `GET ...?pid=28146949&grupo=A` → **esperado** `adotaria = undefined` (não há card A com esse pid) — confirma o **escopo por pipeline** (não cruza grupos).
- `GET ...?pid=00000000&grupo=A` → `total_query=0`, `adotaria=undefined` (sem falso-positivo).

### 6.2 Selftest puro (sem rede) da seleção
Adicionar casos a `handleDebugSelftest` (mode `logic`) exercitando `escolherCardAdotado` — segue o padrão de `decidirEtapaOrcamento`:
- match exato + pipeline certo → devolve o id.
- pid como **substring** de outro campo (ex.: lead com telefone contendo "28146949") mas `pid_no_card` diferente → **descarta** (não adota).
- 2 candidatos no grupo, um em 143 (perdido) e um ativo → devolve o **ativo**.
- 2 ativos → devolve o de **menor id**.
- match só no **outro** pipeline → `undefined`.

### 6.3 Regressão real de idempotência (usa artefatos do teste ORC já existentes)
Paciente teste `28146949` já tem card B (Tratamento Iniciado) e mapeamento `(28146949,B)` no D1.
1. Apagar **só** a linha de mapeamento para forçar o caminho de criação:
   `wrangler d1 execute kommo-cnn-db --remote --command "DELETE FROM mapeamento WHERE paciente_id_cnn='28146949' AND grupo='B'"`
2. `GET /debug-orcamento?paciente=28146949&aplicar=1&dry=0&env=production` (dispara `consumirItemOrcamento` real).
3. **Esperado:** resultado `criado_b` **mas** `leadId == <id do card B pré-existente>` (adotou), e **nenhum** card B novo em Pós-Venda. Sem o A7, isso criaria um 2º card B → duplicata.
4. Conferir na `auditoria` a linha `funcao='A7', acao='adotado_por_pid'`.
5. **Cleanup (regra do dono):** o mapeamento é reescrito pelo próprio passo 2 (volta ao estado original), então nada a limpar **se** adotou. Se por bug tiver criado card novo, mover à mão pra "perdido" (não há hard-delete de lead — 405, gotcha 03/07) e apagar a linha extra do mapeamento.

---

## 7. Riscos e limitações

1. **[VERIFICAR] `query` pode não indexar o campo texto** (§2). Mitigação: probe 6.1 antes do merge; fallback documentado. Se não indexar, A7 é no-op (não regride nada).
2. **Race de criação concorrente NÃO totalmente fechado.** Se dois ticks chegarem a `criarCardLead` para o mesmo pid **ao mesmo tempo**, ambos os lookups erram (card ainda não existe) e ambos POSTam → duplicata. A7 fecha o caso **sequencial** (retry/resposta-perdida), não o **simultâneo**. **Mitigado hoje** pelo lease de tick B2 (`adquirirLease`, `TICK_LEASE_TTL_SEG=300`) que serializa cron + `/debug-tick`. Registrar como resíduo (fecharia de vez só com dedupe pós-create ou índice único no Kommo, que a API não oferece).
3. **Adoção não re-carimba a etapa `p.etapa`.** O card adotado permanece na etapa em que está; A4/A3 retornam `"criado"` sem mover neste tick. **Converge** no próximo tick (o mapeamento agora existe → o caminho de sync move). Aceitável e idempotente. (Se quiser convergência no mesmo tick, seria mudança no **caller**, fora do escopo mínimo — dá pra evoluir depois retornando `{leadId, adotado}` e o caller decidir mover; não recomendo agora para não mexer em 4 call-sites.)
4. **`query` só lê página 1 (250).** pid é numérico de ~8 dígitos → `query` por substring pode, em tese, casar telefones que contenham essa sequência e empurrar o card real além da 1ª página. Improvável (o card real casa por relevância) e o match exato descarta os intrusos; se acontecer, o pior caso é "não achou" → cria (comportamento atual). Não paginar de propósito (custo/segurança).
5. **`escreverVinculoCnn` na adoção sobrescreve `ID Agenda CNN`** com `p.agendaId`. No cenário-alvo (mesma agenda do POST perdido) é o mesmo id → inócuo; e é exatamente o que o A4-vincular já faz (1587). Consistente.
6. **Campo numérico vs texto:** se `ID Paciente CNN` for numérico, `getFieldValue` devolve o número como string e a comparação `String(...) === pid` continua correta (contanto que `pid` chegue sem zeros à esquerda perdidos — os pids CNN não têm leading zero).

---

## 8. Resumo do que muda no arquivo (`src/index.ts`)

| Local | Mudança |
|---|---|
| antes de `criarCardLead` (~1539) | **+** `escolherCardAdotado` (puro) e `acharLeadPorPacienteCnn` (1 GET) |
| dentro de `criarCardLead`, após 1543 | **+** bloco de adoção (lookup → `upsertMapeamento` [+ `escreverVinculoCnn`/`upsertAgendaSync` se `p.agendaId`] → `audit` → `return`) |
| router (~4343) | **+** rota `/debug-lookup-paciente` (probe read-only) |
| `handleDebugSelftest` (mode `logic`) | **+** casos de `escolherCardAdotado` |

Sem mudança de schema D1. Sem mudança nos 4 call-sites de `criarCardLead`. Reversível (remover o bloco restaura o comportamento atual). Deploy junto ao lote pendente (A3/A1a/A7/BX/C1-TTL/F1).

Arquivo-alvo (absoluto): `D:\clarissa-bergmann\kommo-cnn\src\index.ts`.
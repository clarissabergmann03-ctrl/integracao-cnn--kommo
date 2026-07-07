// Stubs dos tipos do Cloudflare Workers (só p/ o type-check da Vercel; apagados em runtime).
type ScheduledEvent = any; type ExecutionContext = any; type D1Database = any;
const CNN_BASE = "https://api.clinicanasnuvens.com.br";

// IDs fixos da clínica — validados via /discover
const CNN_CONVENIO_PARTICULAR = 56545;
const CNN_TIPO_CONSULTA       = 110452;
const CNN_LOCAL_AGENDA        = 41170;
const CNN_TIPO_PROCEDIMENTO   = 1011844;

// Stages do Funil de Captação — validados via /explore
const STAGE_LEADS_ENTRADA        = 106848271;
const STAGE_PRIMEIRO_CONTATO     = 106848615;
const STAGE_CONSULTA_AGENDADA    = 106848619;
const STAGE_CONFIRMACAO_CONSULTA = 107785399;
const STAGE_CONSULTA_CONFIRMADA  = 106848623;
const STAGE_AVALIACAO_REALIZADA  = 106848627;
const STAGE_TRATAMENTO_PROPOSTO  = 106848631;
const STAGE_CANCELADA_PERDIDO    = 143;
const PIPELINE_CAPTACAO          = 13847079;

// ── Funil de Pós - Venda (13950431) — validado via /discover 2026-06-23 ───────
const PIPELINE_POS_VENDA          = 13950431;
const STAGE_POS_CLIENTE_ATIVO     = 107658911;
const STAGE_POS_CONFIRMACAO_AGEND = 107974651;

// ── Funil de Pós-Consulta (13947295) + Tratamento Iniciado (Pós-Venda) — validado
// via /discover 2026-07-01. Fundação read-only do reflexo de status de orçamento
// CNN → etapa Kommo (spec docs/superpowers/specs/2026-07-01-kommo-cnn-reflexo-orcamento-design.md).
const PIPELINE_POS_CONSULTA         = 13947295;
const STAGE_POSCONS_EM_ANALISE      = 107633739;
// 143 = "perdido" genérico (mesmo valor de STAGE_CANCELADA_PERDIDO), escopado por
// PIPELINE_POS_CONSULTA. Const separada só p/ nomear a intenção; NÃO duplicar em STAGE_NOME.
const STAGE_POSCONS_VENDA_PERDIDA   = 143;
const STAGE_POS_TRATAMENTO_INICIADO = 107658907;
// Kill-switch do Reflexo de Orçamento no cron (Task 5): true = produtor roda a cada minuto.
const ORC_ENABLED = true; // LIGADO 01/07 (após N0-N6 + medição: 22 moves recentes). Pausar = voltar p/ false + redeploy
// GATE C1: etapas onde o ORC PODE agir = consulta já assentou (A3 refletiu: Avaliação
// Realizada / Tratamento Proposto) ou etapa já do próprio ORC. Fora daqui (agendada /
// confirmação / cliente ativo / entrada / primeiro contato) o ORC ADIA e deixa o A3
// terminar — senão o A3 (FINALIZADO→Avaliação) puxaria o lead de volta e a venda se perderia.
const ETAPAS_ORC_PODE_AGIR = new Set<number>([
  STAGE_AVALIACAO_REALIZADA, STAGE_TRATAMENTO_PROPOSTO,
  STAGE_POSCONS_EM_ANALISE, STAGE_POS_TRATAMENTO_INICIADO, STAGE_POSCONS_VENDA_PERDIDA,
]);

// ── Ambiente CNN ──────────────────────────────────────────────────────────────
// "sandbox" = CID de teste (escrita liberada p/ allowlist). "production" = clínica
// real (REGRA §7.8: SÓ leitura — escrita bloqueada por código em cnnPost/cnnPut).
type CnnTarget = "sandbox" | "production";

// ── Orçamento de sub-requests (teto do Worker free = 50 fetch/invocação) ──────
// D1 NÃO conta (testado: 200 queries OK). Só fetch ao CNN/Kommo conta. Contador
// é módulo-global → DEVE ser resetado no início de cada entrada (scheduled/tick).
let subreqUsados = 0;
function resetSubreq(): void { subreqUsados = 0; }
function bumpSubreq(): void { subreqUsados++; }
function orcamentoOk(max = 45): boolean { return subreqUsados < max; }

// ── Roteamento por TIPO de atendimento (CNN) ─────────────────────────────────
// Resolução por NOME em runtime: IDs de tipo diferem entre sandbox e produção, e
// alguns tipos (ex.: "Atendimento Social") só existem em produção.
// Grupo A → Funil de Captação; Grupo B → Funil de Pós-Venda; desconhecido → nada.
function normNome(s: string): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
const GRUPO_A_TIPOS = new Set<string>(["atendimento social", "consulta/avaliacao"]);
// ⚠️ PROVISÓRIO — strings exatas a confirmar na Fase 2 (via /debug-cnn-shape):
const GRUPO_B_TIPOS = new Set<string>([
  "cirurgia", "cortesia", "encaixe", "encaminhamento - interno",
  "pequenas cirurgias", "procedimento", "retorno",
]);

// ── Mapa de status CNN → etapa Kommo, por grupo (tabela validada; enums Fase 2) ──
// Enums confirmados ao vivo em produção: AGENDADO, CONFIRMADO_PACIENTE, FINALIZADO,
// CANCELADO, CANCELADO_PACIENTE, FALTOU, EM_ESPERA. CONFIRMADO (confirmado pela
// clínica) é INFERIDO pelo padrão — ainda não visto ao vivo. Operacionais
// (EM_ESPERA, PAGAMENTO, PRE_ATENDIMENTO, EM_ANDAMENTO) ficam FORA do mapa = "não
// move". Grupo B: todo status-marco → cliente ativo.
const MAPA_STATUS: Record<string, { A: number; B: number }> = {
  AGENDADO:            { A: STAGE_CONSULTA_AGENDADA,   B: STAGE_POS_CLIENTE_ATIVO },
  CONFIRMADO_PACIENTE: { A: STAGE_CONSULTA_CONFIRMADA, B: STAGE_POS_CLIENTE_ATIVO },
  CONFIRMADO:          { A: STAGE_CONSULTA_CONFIRMADA, B: STAGE_POS_CLIENTE_ATIVO }, // inferido
  FINALIZADO:          { A: STAGE_AVALIACAO_REALIZADA, B: STAGE_POS_CLIENTE_ATIVO },
  FALTOU:              { A: STAGE_PRIMEIRO_CONTATO,    B: STAGE_POS_CLIENTE_ATIVO },
  CANCELADO:           { A: STAGE_CANCELADA_PERDIDO,   B: STAGE_POS_CLIENTE_ATIVO },
  CANCELADO_PACIENTE:  { A: STAGE_CANCELADA_PERDIDO,   B: STAGE_POS_CLIENTE_ATIVO },
};
function destinoStatus(grupo: "A" | "B", statusEnum: string): number | null {
  const row = MAPA_STATUS[statusEnum];
  return row ? row[grupo] : null;
}
// Destino do move da véspera (Função 2, 15h BRT)
const VESPERA_DESTINO: Record<"A" | "B", { pipeline: number; etapa: number }> = {
  A: { pipeline: PIPELINE_CAPTACAO,  etapa: STAGE_CONFIRMACAO_CONSULTA },
  B: { pipeline: PIPELINE_POS_VENDA, etapa: STAGE_POS_CONFIRMACAO_AGEND },
};
// Pipeline e etapas-âncora por grupo. base = onde o lead repousa; confirmacao = véspera.
function pipelineDoGrupo(grupo: "A" | "B"): number {
  return grupo === "A" ? PIPELINE_CAPTACAO : PIPELINE_POS_VENDA;
}
const ETAPA_BASE: Record<"A" | "B", number> = { A: STAGE_CONSULTA_AGENDADA, B: STAGE_POS_CLIENTE_ATIVO };
const ETAPA_CONFIRMACAO: Record<"A" | "B", number> = { A: STAGE_CONFIRMACAO_CONSULTA, B: STAGE_POS_CONFIRMACAO_AGEND };

// ── Field name + enum cache ───────────────────────────────────────────────────
let fieldsCache: Record<string, number> | null = null;
let fieldsCacheAt = 0;
const FIELDS_CACHE_TTL = 60 * 60 * 1000;

async function resolveFields(env: Env, force = false): Promise<Record<string, number>> {
  if (!force && fieldsCache && Date.now() - fieldsCacheAt < FIELDS_CACHE_TTL) return fieldsCache;
  const [leadsResp, contactsResp] = await Promise.all([
    kommoGet("/leads/custom_fields?limit=250", env),
    kommoGet("/contacts/custom_fields?limit=250", env),
  ]);
  const map: Record<string, number> = {};
  for (const src of [leadsResp._embedded.custom_fields, contactsResp._embedded.custom_fields]) {
    for (const f of src) {
      map[f.name] = f.id;
      for (const e of (f.enums ?? [])) map[`${f.name}::${e.value}`] = e.id;
    }
  }
  fieldsCache = map;
  fieldsCacheAt = Date.now();
  return map;
}

// ── Cache de tipos de consulta CNN (por ambiente) ─────────────────────────────
// Mapa idTipoConsulta → nome normalizado. Sandbox e produção têm IDs distintos,
// por isso o cache é por target.
const tiposCache: Record<CnnTarget, { map: Record<string, string>; at: number } | null> = { sandbox: null, production: null };
const TIPOS_CACHE_TTL = 60 * 60 * 1000;
async function resolveTiposConsulta(env: Env, target: CnnTarget = "sandbox"): Promise<Record<string, string>> {
  const cached = tiposCache[target];
  if (cached && Date.now() - cached.at < TIPOS_CACHE_TTL) return cached.map;
  const map: Record<string, string> = {};
  try {
    const resp: any = await cnnGet("/tipo-consulta/lista?registrosPorPagina=200&pagina=0", env, target);
    for (const t of (resp?.lista ?? [])) map[String(t.id)] = normNome(t.nome ?? "");
  } catch { /* vazio → grupo null → não faz nada */ }
  tiposCache[target] = { map, at: Date.now() };
  return map;
}
// Classifica uma agenda do CNN em grupo de roteamento pelo NOME do tipo.
function grupoDaAgenda(agenda: any, tiposMap: Record<string, string>): "A" | "B" | null {
  const nome = tiposMap[String(agenda?.idTipoConsulta ?? "")];
  if (!nome) return null;
  if (GRUPO_A_TIPOS.has(nome)) return "A";
  if (GRUPO_B_TIPOS.has(nome)) return "B";
  return null; // tipo conhecido fora dos grupos ou desconhecido → não faz nada (Decisão 2)
}

// ── Retry/backoff dos wrappers HTTP (A4) ─────────────────────────────────────
// Rate-limit/instabilidade transitória (429/502/503/504 ou fetch que lança por rede)
// não deve virar falha DEFINITIVA do item da fila. Este helper repete o fetch com
// backoff, respeitando Retry-After, e distingue transitório (marca [TRANSITORIO],
// consumirFila devolve à fila SEM queimar tentativa) de permanente (4xx → o chamador
// lança e a tentativa conta). `doFetch` é injetável → testável sem tocar CNN/Kommo.
const MARCA_TRANSITORIO = "[TRANSITORIO]";
const STATUS_TRANSITORIOS = new Set([429, 502, 503, 504]);
interface RetryOpts {
  max?: number;                       // teto de tentativas (default 4)
  baseMs?: number;                    // base do backoff exponencial (default 500)
  maxEsperaMs?: number;               // teto de cada espera (default 4000) — limita wall-clock
  sleep?: (ms: number) => Promise<void>; // injetável (teste usa espera instantânea)
  podeRetentar?: () => boolean;       // guarda de budget: se false, para de repetir (fica p/ próximo tick)
  onTentativa?: () => void;           // métrica (selftest)
  idempotente?: boolean;              // default true. false (POST) → só re-tenta em 429 (rejeitado, não executou);
                                      // NUNCA em 5xx/rede (podem ter executado → risco de duplicar o recurso criado).
}
// Retry-After: segundos (número) ou HTTP-date. Retorna ms, ou null se ausente/inválido.
function parseRetryAfterMs(v: string | null): number | null {
  if (!v) return null;
  const seg = Number(v);
  if (Number.isFinite(seg)) return Math.max(0, seg * 1000);
  const d = Date.parse(v);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return null;
}
function ehTransitorio(e: unknown): boolean {
  return String((e as any)?.message ?? e).includes(MARCA_TRANSITORIO);
}
async function fetchComRetry(doFetch: () => Promise<Response>, opts: RetryOpts = {}): Promise<Response> {
  const max = opts.max ?? 4;
  const base = opts.baseMs ?? 500;
  const maxEspera = opts.maxEsperaMs ?? 4000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const podeRetentar = opts.podeRetentar ?? (() => true);
  const idempotente = opts.idempotente ?? true;
  let ultimo: unknown;
  for (let tent = 1; tent <= max; tent++) {
    opts.onTentativa?.();
    let resp: Response | undefined;
    try {
      resp = await doFetch();
    } catch (e) {
      // throw de rede/fetch. Idempotente → transitório (re-tenta). Não-idempotente (POST) →
      // pode ter executado no servidor → NÃO re-tenta: relança o erro cru (permanente).
      if (!idempotente) throw e;
      ultimo = e;
    }
    if (resp) {
      if (!STATUS_TRANSITORIOS.has(resp.status)) return resp; // 2xx/3xx/4xx permanente → chamador decide
      // Não-idempotente: 5xx pode ter executado → NÃO re-tenta (devolve, o wrapper lança como erro).
      // Só 429 (rejeitado, garantidamente não executou) é seguro re-tentar num POST.
      if (!idempotente && resp.status !== 429) return resp;
      ultimo = new Error(`${MARCA_TRANSITORIO} HTTP ${resp.status}`);
    }
    if (tent >= max || !podeRetentar()) break;
    let espera = resp ? parseRetryAfterMs(resp.headers.get("Retry-After")) : null;
    if (espera == null) espera = base * 2 ** (tent - 1); // backoff exponencial
    await sleep(Math.min(espera, maxEspera));
  }
  throw new Error(`${MARCA_TRANSITORIO} esgotou apos retries: ${ultimo instanceof Error ? ultimo.message : String(ultimo)}`);
}
// Opções padrão dos wrappers reais: guarda de budget (não estoura o teto de 50 subreq).
function retryPadrao(): RetryOpts { return { podeRetentar: () => orcamentoOk() }; }
// POST não é idempotente (criar recurso) → só re-tenta em 429; nunca em 5xx/rede (evita duplicar card).
function retryPost(): RetryOpts { return { podeRetentar: () => orcamentoOk(), idempotente: false }; }
// Leitura do SWEEP: retry AGRESSIVO (meta < 0,5% erro de leitura). Mais tentativas + backoff maior; gate em 48
// (single-thread: subreq é resetado por request → reflete só ESTE request → seguro sob o teto de 50).
function retrySweep(): RetryOpts { return { max: 6, baseMs: 700, maxEsperaMs: 6000, podeRetentar: () => orcamentoOk(48) }; }

// ── CNN helpers ───────────────────────────────────────────────────────────────
// REGRA DE SEGURANÇA INVIOLÁVEL (§7.8): com target "production" SÓ leitura (GET).
// cnnPost/cnnPut LANÇAM erro se target === "production" — defesa em profundidade,
// não depende só do comportamento do agente.
function cnnCreds(env: Env, target: CnnTarget): { user: string; pass: string; cid: string } {
  return target === "production"
    ? { user: env.CNN_BASIC_USER_PRODUCTION, pass: env.CNN_BASIC_PASS_PRODUCTION, cid: env.CNN_CID_PRODUCTION }
    : { user: env.CNN_BASIC_USER, pass: env.CNN_BASIC_PASS, cid: env.CNN_CID };
}
function cnnHeaders(env: Env, target: CnnTarget = "sandbox"): HeadersInit {
  const c = cnnCreds(env, target);
  return {
    Authorization: `Basic ${btoa(`${c.user}:${c.pass}`)}`,
    "clinicaNasNuvens-cid": c.cid,
    "Content-Type": "application/json",
  };
}
// Allowlist de escrita em PRODUÇÃO (spec 2026-07-05). §7.8 deixa de ser "bloqueia toda escrita"
// e passa a "bloqueia tudo MENOS estas 4 operações de AGENDA". DELETE, /paciente/*, prontuário,
// orçamento, financeiro etc. continuam LANÇANDO. Guardrail do dono: jamais apagar paciente nem
// mexer no que não é o objetivo. Fail-safe: qualquer rota fora da lista → erro (job vai a dead-letter,
// CNN nunca é tocado). É PURO (method,path) → testável no /debug-selftest.
const CNN_STATUS_ALTERACAO_PERMITIDOS = new Set(["AGENDADO", "CONFIRMADO_PACIENTE"]);
function cnnProducaoPermitido(method: string, path: string, status?: string): boolean {
  const m = method.toUpperCase();
  if (m === "DELETE") return false;                                    // nunca apaga nada
  const p = path.split("?")[0];
  if (m === "POST" && p === "/agenda/novo") return true;               // criar agenda (webhook 2)
  if (m === "PUT"  && p === "/agenda/alteracao-status")                // confirmar/agendar (webhooks 1/2)
    return status !== undefined && CNN_STATUS_ALTERACAO_PERMITIDOS.has(status); // NUNCA cancelar/faltar etc.
  if (m === "POST" && /^\/agenda\/\d+\/remarcar$/.test(p)) return true; // remarcar horário (webhook 3)
  if (m === "POST" && p === "/convenio-paciente/associar") return true; // pré-requisito do /agenda/novo
  if (m === "POST" && p === "/paciente/novo") return true;              // W1/F.Captura: criar paciente do 1º contato (só o webhook lead-agendado chama)
  return false;
}
function assertCnnWritable(target: CnnTarget, method: string, path: string, status?: string): void {
  const m = method.toUpperCase();
  const p = path.split("?")[0];
  // ── GUARDRAIL ABSOLUTO (dono, INVIOLÁVEL — vale em TODOS os ambientes: sandbox E produção).
  //    JAMAIS apagar nada no CNN e NUNCA deletar/alterar paciente. Independe do allowlist de produção.
  if (m === "DELETE")
    throw new Error(`BLOQUEADO (guardrail): DELETE ${path} — proibido apagar QUALQUER coisa no CNN, em qualquer ambiente`);
  if (/^\/paciente\b/.test(p) && m !== "GET" && m !== "POST")
    throw new Error(`BLOQUEADO (guardrail): ${m} ${path} — jamais deletar/alterar paciente no CNN`);
  // ── Allowlist de escrita em PRODUÇÃO (§7.8) ──
  if (target === "production" && !cnnProducaoPermitido(method, path, status))
    throw new Error(`BLOQUEADO §7.8: ${method} ${path} (status=${status ?? "-"}) — fora do allowlist de escrita CNN produção`);
}
// GUARDRAIL: o CNN NÃO tem operação de delete no nosso código. Qualquer chamada LANÇA (defesa
// em profundidade — nunca apagar paciente/agenda/nada, em nenhum ambiente). Existe só para travar
// qualquer uso futuro de delete no CNN por engano.
async function cnnDelete(path: string, _env: Env, _target: CnnTarget = "sandbox"): Promise<never> {
  throw new Error(`BLOQUEADO (guardrail): DELETE ${path} — proibido apagar dados/paciente no CNN, em qualquer ambiente`);
}
async function cnnGet(path: string, env: Env, target: CnnTarget = "sandbox", retry: RetryOpts = retryPadrao()): Promise<any> {
  const res = await fetchComRetry(() => { bumpSubreq(); return fetch(`${CNN_BASE}${path}`, { headers: cnnHeaders(env, target) }); }, retry);
  if (!res.ok) throw new Error(`CNN GET ${path} → ${res.status}`);
  return res.json();
}
async function cnnPost(path: string, body: unknown, env: Env, target: CnnTarget = "sandbox") {
  assertCnnWritable(target, "POST", path);
  const res = await fetchComRetry(() => { bumpSubreq(); return fetch(`${CNN_BASE}${path}`, {
    method: "POST", headers: cnnHeaders(env, target), body: JSON.stringify(body),
  }); }, retryPost());
  const text = await res.text();
  if (!res.ok) throw new Error(`CNN POST ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function cnnPut(path: string, body: unknown, env: Env, target: CnnTarget = "sandbox") {
  assertCnnWritable(target, "PUT", path, (body as any)?.status);
  const res = await fetchComRetry(() => { bumpSubreq(); return fetch(`${CNN_BASE}${path}`, {
    method: "PUT", headers: cnnHeaders(env, target), body: JSON.stringify(body),
  }); }, retryPadrao());
  const text = await res.text();
  if (!res.ok) throw new Error(`CNN PUT ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
// Todos os orçamentos de 1 paciente (read-only, paginado). Janela ampla (2 anos
// atrás → 1 ano à frente) por CRIACAO pra cobrir orçamentos antigos e futuros.
// Respeita orcamentoOk() — não estoura o teto de subrequests da invocação.
async function cnnOrcamentosDoPaciente(pid: string, env: Env, target: CnnTarget): Promise<any[]> {
  const di = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const df = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const out: any[] = [];
  let pagina = 0, totalPaginas = 1;
  while (pagina < totalPaginas && orcamentoOk()) {
    const r: any = await cnnGet(
      `/orcamento/lista?idPaciente=${pid}&dataInicial=${di}&dataFinal=${df}&tipoData=CRIACAO&registrosPorPagina=50&pagina=${pagina}`,
      env, target
    );
    const lista = r?.lista ?? [];
    if (lista.length === 0) break;
    out.push(...lista);
    totalPaginas = Math.max(r?.totalPaginas ?? 1, 1);
    pagina++;
  }
  return out;
}

// ── Kommo helpers ─────────────────────────────────────────────────────────────
function kommoBase(env: Env) {
  return `https://${env.KOMMO_SUBDOMAIN}.kommo.com/api/v4`;
}
// Throttle Kommo: ≤7 req/s (limite da conta). Reserva slots espaçados ~150ms,
// serializando picos (inclui chamadas concorrentes via Promise.all).
let kommoNextSlot = 0;
async function kommoThrottle(): Promise<void> {
  const minGap = 150; // ms ≈ 6.6 req/s, margem sob o limite de 7
  const now = Date.now();
  const slot = Math.max(now, kommoNextSlot);
  kommoNextSlot = slot + minGap;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
async function kommoGet(path: string, env: Env) {
  const res = await fetchComRetry(async () => { await kommoThrottle(); bumpSubreq(); return fetch(`${kommoBase(env)}${path}`, {
    headers: { Authorization: `Bearer ${env.KOMMO_ACCESS_TOKEN}` },
  }); }, retryPadrao());
  if (!res.ok) throw new Error(`Kommo GET ${path} → ${res.status}`);
  // Kommo responde 204 / corpo vazio quando a lista filtrada não tem itens —
  // res.json() quebraria com "Unexpected end of JSON input".
  const text = await res.text();
  return text ? JSON.parse(text) : { _embedded: {} };
}
async function kommoPatch(path: string, body: unknown, env: Env) {
  const res = await fetchComRetry(async () => { await kommoThrottle(); bumpSubreq(); return fetch(`${kommoBase(env)}${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${env.KOMMO_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }); }, retryPadrao());
  const text = await res.text();
  if (!res.ok) throw new Error(`Kommo PATCH ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function kommoPost(path: string, body: unknown, env: Env) {
  const res = await fetchComRetry(async () => { await kommoThrottle(); bumpSubreq(); return fetch(`${kommoBase(env)}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.KOMMO_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }); }, retryPost());
  const text = await res.text();
  if (!res.ok) throw new Error(`Kommo POST ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function kommoDelete(path: string, env: Env) {
  const res = await fetchComRetry(async () => { await kommoThrottle(); bumpSubreq(); return fetch(`${kommoBase(env)}${path}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${env.KOMMO_ACCESS_TOKEN}` },
  }); }, retryPadrao());
  if (!res.ok && res.status !== 204) throw new Error(`Kommo DELETE ${path} → ${res.status}`);
  return true;
}

// ── Allowlist de teste (§12.1): só estes telefones podem gerar escrita em teste
const ALLOWLIST_TESTE = ["92982717586", "92994567328", "11946800329"];
function isTestePhone(phone: string): boolean {
  const k = phoneKey(phone);
  return ALLOWLIST_TESTE.some((p) => phoneKey(p) === k);
}

// ── Utilitários ───────────────────────────────────────────────────────────────
function getFieldValue(entity: any, fieldId: number): string | null {
  return (entity.custom_fields_values ?? [])
    .find((f: any) => f.field_id === fieldId)?.values?.[0]?.value ?? null;
}
// Todos os valores de um campo MULTISELECT (Corporais/Faciais podem ter várias opções por card).
function getFieldValuesMulti(entity: any, fieldId: number): string[] {
  const f = (entity.custom_fields_values ?? []).find((x: any) => x.field_id === fieldId);
  return (f?.values ?? []).map((v: any) => String(v.value)).filter(Boolean);
}
async function setLeadFields(leadId: string, updates: Array<{ id: number; value?: string; enumId?: number }>, env: Env) {
  await kommoPatch(`/leads/${leadId}`, {
    custom_fields_values: updates.map(u => ({
      field_id: u.id,
      values: [u.enumId != null ? { enum_id: u.enumId } : { value: u.value }],
    })),
  }, env);
}
async function moveLeadToStage(leadId: string, statusId: number, env: Env, pipelineId: number = PIPELINE_CAPTACAO) {
  // GUARDA (dono): card com AGENDAMENTO futuro preenchido NUNCA pode ir p/ Primeiro Contato.
  // Invariante central — vale p/ qualquer chamador (sync, órfão, legado). Custa 1 fetch só
  // quando o destino É Primeiro Contato (raro). `resolveFields` é cacheado (1h) → sem fetch.
  if (statusId === STAGE_PRIMEIRO_CONTATO) {
    try {
      const fAg = (await resolveFields(env))["AGENDAMENTO"];
      const lead = await kommoGet(`/leads/${leadId}`, env);
      const ag = Number(getFieldValue(lead, fAg) ?? 0);
      if (ag && ag > Math.floor(Date.now() / 1000)) return; // tem consulta futura → bloqueia o rebaixamento
    } catch { /* na dúvida, deixa seguir (não trava o fluxo) */ }
  }
  await kommoPatch(`/leads/${leadId}`, { status_id: statusId, pipeline_id: pipelineId }, env);
}
// Campo AGENDAMENTO é date_time: o Kommo exige o timestamp Unix como NÚMERO
// (string dispara InvalidDateFormat).
async function setAgendamento(leadId: string, ts: number, fieldId: number, env: Env) {
  await kommoPatch(`/leads/${leadId}`, { custom_fields_values: [{ field_id: fieldId, values: [{ value: ts }] }] }, env);
}
// Grava ID Agenda CNN + ID Paciente CNN (+ AGENDAMENTO) no card num único PATCH idempotente.
// SEMPRE chamado ANTES de mover etapa: se o move falhar (teto de 50 sub-requests), o card já
// fica com os IDs corretos e o reprocessamento só completa o move — nunca o estado "movido sem
// IDs". Corrige a regressão da fila (o backfill legado gravava os IDs ao vincular; a fila não).
async function escreverVinculoCnn(
  leadId: string, agendaId: string, pid: string, cnnTs: number,
  fields: Record<string, number>, env: Env,
): Promise<void> {
  const cf: any[] = [];
  if (fields["ID Agenda CNN"] && agendaId) cf.push({ field_id: fields["ID Agenda CNN"], values: [{ value: String(agendaId) }] });
  if (fields["ID Paciente CNN"] && pid)    cf.push({ field_id: fields["ID Paciente CNN"], values: [{ value: String(pid) }] });
  if (fields["AGENDAMENTO"] && cnnTs)      cf.push({ field_id: fields["AGENDAMENTO"], values: [{ value: cnnTs }] });
  if (cf.length) await kommoPatch(`/leads/${leadId}`, { custom_fields_values: cf }, env);
}
// Garante que um card de Captação (grupo A) com agenda ATIVA esteja pelo menos na etapa do
// status (AGENDADO→Consulta Agendada, etc.): puxa pra cima quem está em Leads de Entrada /
// Primeiro Contato, SEM rebaixar quem já avançou. Regra do dono: agenda preenchida + IDs →
// Consulta Agendada. Retorna a etapa de destino se moveu, senão null. Custa 1 fetch.
async function alinharCardA(leadId: string, status: string, env: Env): Promise<number | null> {
  let atual = 0;
  try { atual = Number((await kommoGet(`/leads/${leadId}`, env)).status_id) || 0; } catch { return null; }
  // Puxa quem está ATRÁS de Consulta Agendada: Leads de Entrada, Primeiro Contato OU Perdido.
  // (Lead "perdido" do legado, vinculado a paciente com consulta NOVA ativa, tem que voltar.)
  if (atual !== STAGE_LEADS_ENTRADA && atual !== STAGE_PRIMEIRO_CONTATO && atual !== STAGE_CANCELADA_PERDIDO) return null;
  const destino = destinoStatus("A", status) ?? STAGE_CONSULTA_AGENDADA;
  if (destino === atual || destino === STAGE_PRIMEIRO_CONTATO || destino === STAGE_CANCELADA_PERDIDO) return null; // só sobe
  await moveLeadToStage(leadId, destino, env, PIPELINE_CAPTACAO);
  return destino;
}
// ── Varredura única de correção (task do dono): pra cada lead mapeado, garante os IDs no
// card (ID Agenda/Paciente CNN + AGENDAMENTO) e alinha a etapa (A atrás → Consulta Agendada).
// dry=true só LISTA os casos a corrigir (a "lista" pedida); dry=false corrige de fato.
// Em lote por cursor (lead_id_kommo), sob o teto de 50 sub-requests. Idempotente.
async function corrigirCards(env: Env, dryRun: boolean, cursor: string, max: number): Promise<any> {
  await ensureSchema(env);
  const fields = await resolveFields(env);
  const fIdAgenda = fields["ID Agenda CNN"];
  const out: any = { dryRun, cursor, processados: 0, ids_gravados: 0, alinhados: 0, ja_ok: 0, erros: 0, proximo_cursor: cursor, sweep_completo: false, casos: [] as any[] };
  const rows = ((await env.DB.prepare(
    `SELECT agenda_id_cnn, lead_id_kommo, paciente_id_cnn, last_cnn_status, last_agendamento_ts
     FROM agenda_sync WHERE lead_id_kommo IS NOT NULL AND lead_id_kommo > ? ORDER BY lead_id_kommo LIMIT ?`,
  ).bind(cursor, max).all()).results ?? []) as any[];
  if (!rows.length) { out.sweep_completo = true; return out; }
  for (const r of rows) {
    if (!orcamentoOk(45)) { out.parou_orcamento = true; break; }
    const leadId = String(r.lead_id_kommo);
    out.proximo_cursor = leadId;
    try {
      const lead: any = await kommoGet(`/leads/${leadId}`, env);
      if (!lead || !lead.id) { out.erros++; continue; }
      out.processados++;
      const stage = Number(lead.status_id) || 0;
      const pipeline = Number(lead.pipeline_id) || 0;
      const ativa = !STATUS_TERMINAL.has(String(r.last_cnn_status ?? ""));
      const precisaId = !getFieldValue(lead, fIdAgenda);
      const precisaAlinhar = pipeline === PIPELINE_CAPTACAO && ativa && (stage === STAGE_LEADS_ENTRADA || stage === STAGE_PRIMEIRO_CONTATO || stage === STAGE_CANCELADA_PERDIDO);
      if (!precisaId && !precisaAlinhar) { out.ja_ok++; continue; }
      out.casos.push({ lead: leadId, paciente: String(r.paciente_id_cnn), agenda: String(r.agenda_id_cnn),
        agendamento: r.last_agendamento_ts ? unixToDateBRT(Number(r.last_agendamento_ts)) : null,
        status: r.last_cnn_status, etapa: stage, precisaId, precisaAlinhar });
      if (!dryRun) {
        if (precisaId) { await escreverVinculoCnn(leadId, String(r.agenda_id_cnn), String(r.paciente_id_cnn), Number(r.last_agendamento_ts) || 0, fields, env); out.ids_gravados++; }
        if (precisaAlinhar) { const d = await alinharCardA(leadId, String(r.last_cnn_status ?? ""), env); if (d) out.alinhados++; }
      }
    } catch (e) { out.erros++; out.casos.push({ lead: leadId, erro: String(e) }); }
  }
  return out;
}
function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function unixToDateBRT(ts: number): { data: string; hora: string } {
  const d = new Date((ts - 3 * 3600) * 1000);
  return { data: d.toISOString().slice(0, 10), hora: d.toISOString().slice(11, 16) };
}
function brtToUnix(dateISO: string, hhmm: string): number {
  return Math.floor(new Date(`${dateISO}T${hhmm}:00-03:00`).getTime() / 1000);
}
function dayRangeBRT(dateISO: string): { from: number; to: number } {
  const from = Math.floor(new Date(`${dateISO}T03:00:00Z`).getTime() / 1000);
  return { from, to: from + 24 * 3600 - 1 };
}
function tomorrowBRT(): string {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
function todayBRT(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
// Próxima segunda-feira em BRT (confirmação de sábado → segunda).
function nextMondayBRT(): string {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // "agora" em BRT
  const day = d.getUTCDay();                          // 0=Dom .. 6=Sáb (já deslocado p/ BRT)
  const ate = ((1 - day) + 7) % 7 || 7;              // dias até a próxima segunda (nunca 0)
  d.setUTCDate(d.getUTCDate() + ate);
  return d.toISOString().slice(0, 10);
}
function normalizePhone(p: string): string {
  return p.replace(/\D/g, "");
}
// Chave canônica de telefone p/ casar formatos (§7.1): ignora DDI 55 e o 9º dígito
// de celular. = DDD + últimos 8 dígitos. Ex.: 555198108-2873, 5181082873 e
// 51981082873 viram todos "5181082873". Fallback: últimos 8 sem DDD confiável.
function phoneKey(p: string): string {
  let d = (p ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length >= 10) return d.slice(0, 2) + d.slice(2).slice(-8);
  return d.slice(-8);
}
// Tarefa interna (não é paciente): bloqueio de agenda, pausa, "Acompanhar Dr X" etc.
// Sinal robusto = telefone falso. Ex. confirmado em produção: "Acompanhar TNI" usa
// 51111111111. Critério: vazio, curto (<10) ou ≤2 dígitos distintos (repetidos).
// TODO: refinar com campos crus (idRotulo / observacoes) após o dump.
function isTarefaInterna(agenda: any): boolean {
  const t = normalizePhone(agenda?.telefoneCelularPaciente ?? "");
  if (t.length < 10) return true;
  if (new Set(t.split("")).size <= 2) return true;
  return false;
}
// Lookup de nome do paciente com retry — o CNN rate-limita chamadas /paciente/{id}
// em sequência nos dias cheios, derrubando nomes pra "CNN <id>". 3 tentativas, backoff.
async function cnnPacienteNome(idPaciente: string, env: Env, target: CnnTarget): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    try { const p: any = await cnnGet(`/paciente/${idPaciente}`, env, target); if (p?.nome) return p.nome; return null; }
    catch { await new Promise((r) => setTimeout(r, 250 * (i + 1))); }
  }
  return null;
}

// ── D1: garante tabelas existem ───────────────────────────────────────────────
// Legado: agendamento_sync (W1/C1). Novo (delta-driven): cursores, mapeamento, agenda_sync.
async function ensureSchema(env: Env) {
  return; // schema gerido por migrations do Supabase (supabase/migrations/) — no-op no Postgres
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS agendamento_sync (
      lead_id TEXT PRIMARY KEY, synced_ts INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cursores (
      nome TEXT PRIMARY KEY, valor TEXT, atualizado_em INTEGER NOT NULL)`),
    // Chave composta (paciente, grupo): (pac,"A")→lead de Captação; (pac,"B")→lead de
    // Pós-Venda. CREATE IF NOT EXISTS é NÃO-destrutivo: numa base com o schema antigo
    // (PK só paciente) isto é no-op — a troca real do schema é via /debug-migrar-mapeamento.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mapeamento (
      paciente_id_cnn TEXT NOT NULL, grupo TEXT NOT NULL, lead_id_kommo TEXT, telefone_norm TEXT,
      duplicata INTEGER DEFAULT 0, criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL,
      PRIMARY KEY (paciente_id_cnn, grupo))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS agenda_sync (
      agenda_id_cnn TEXT PRIMARY KEY, lead_id_kommo TEXT, paciente_id_cnn TEXT,
      last_agendamento_ts INTEGER, last_cnn_status TEXT, atualizado_em INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_tel ON mapeamento(telefone_norm)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_lead ON mapeamento(lead_id_kommo)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_pac ON mapeamento(paciente_id_cnn)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ag_lead ON agenda_sync(lead_id_kommo)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ag_pac ON agenda_sync(paciente_id_cnn)`),
    // Função 2: idempotência do lembrete D-1, chave composta lead+agenda+DATA
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS lembrete_d1 (
      chave TEXT PRIMARY KEY, lead_id_kommo TEXT, agenda_id_cnn TEXT, data_agendamento TEXT,
      grupo TEXT, pipeline_destino INTEGER, etapa_destino INTEGER, enviado_em INTEGER NOT NULL)`),
    // Auditoria: toda ação E não-ação relevante (§10.2 do escopo mãe)
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, funcao TEXT, ambiente TEXT,
      entidade_id TEXT, acao TEXT, de TEXT, para TEXT, detalhe TEXT)`),
    // Fila de trabalho (work queue em D1): 1 linha = 1 unidade de trabalho. Produtor
    // enfileira (idempotente via `chave` UNIQUE); consumidor puxa lote pequeno e marca.
    // Dilui a carga em muitas micro-invocações (não espreme tudo no teto de 50 fetch).
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS fila_trabalho (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT UNIQUE,
      tipo TEXT,
      agenda_id_cnn TEXT,
      paciente_id_cnn TEXT,
      grupo TEXT,
      payload TEXT,
      status TEXT DEFAULT 'pendente',
      tentativas INTEGER DEFAULT 0,
      ultimo_erro TEXT,
      locked_at INTEGER,
      criado_em INTEGER NOT NULL,
      atualizado_em INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_fila_status ON fila_trabalho(status, id)`),
    // Reflexo de orçamento CNN → etapa Kommo (fundação read-only, spec 2026-07-01).
    // Espelha agenda_sync: 1 linha por paciente, idempotência do "move só 1x por mudança".
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS orcamento_sync (
      paciente_id_cnn TEXT PRIMARY KEY, lead_id_kommo TEXT, ultimo_status TEXT, ultima_etapa INTEGER, updated_at INTEGER)`),
    // F1: log durável de cada tick do cron (1 linha/tick). D1 NÃO conta no teto de 50 subreq.
    // Colunas escalares = health por SQL sem parse; `resumo` (JSON) = inspeção profunda.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tick_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ok INTEGER NOT NULL,
      ms INTEGER, subreq INTEGER, gatilhos TEXT,
      processados INTEGER, movidos INTEGER, criados_b INTEGER, adiados INTEGER, erros INTEGER, transitorios INTEGER,
      fila_pendente INTEGER, fila_erro INTEGER, erro TEXT, resumo TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tick_ts ON tick_log(ts)`),
  ]);
  // Migração não-destrutiva: bases criadas antes do claim atômico (C1) não têm `locked_at`.
  // ALTER falha se a coluna já existe → try/catch idempotente (mesmo padrão do backfill_hist).
  try { await env.DB.prepare(`ALTER TABLE fila_trabalho ADD COLUMN locked_at INTEGER`).run(); } catch { /* já existe */ }
  // Anti-loop dos webhooks Kommo→CNN (spec 2026-07-05): quem escreveu por último a agenda.
  try { await env.DB.prepare(`ALTER TABLE agenda_sync ADD COLUMN origin TEXT`).run(); } catch { /* já existe */ }
}

// ── B2: lease cooperativo p/ serializar ticks (cron + /debug-tick) ────────────
// Reusa a tabela `cursores` (linha nome='tick_lease'): valor=owner, atualizado_em=EXPIRA (ts).
// Acquire ATÔMICO: insere se não existe, ou toma se o lease atual já expirou — tudo em 1
// instrução (D1 é single-writer → só 1 concorrente vence; o perdedor recebe RETURNING vazio).
// Release deleta só se VOCÊ é o dono. TTL evita deadlock se o release falhar (worker morto).
const TICK_LEASE_TTL_SEG = 300;
async function adquirirLease(env: Env, owner: string, ttlSeg = TICK_LEASE_TTL_SEG): Promise<{ ok: boolean; dono?: string; expira?: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expira = now + ttlSeg;
  const r = await env.DB.prepare(
    `INSERT INTO cursores (nome, valor, atualizado_em) VALUES ('tick_lease', ?, ?)
       ON CONFLICT(nome) DO UPDATE SET valor=excluded.valor, atualizado_em=excluded.atualizado_em
         WHERE cursores.atualizado_em <= ?
     RETURNING valor`
  ).bind(owner, expira, now).all();
  if ((r.results ?? []).length > 0) return { ok: true, expira };
  const cur = await env.DB.prepare(`SELECT valor, atualizado_em FROM cursores WHERE nome='tick_lease'`).first<any>();
  return { ok: false, dono: cur?.valor, expira: cur?.atualizado_em };
}
async function liberarLease(env: Env, owner: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM cursores WHERE nome='tick_lease' AND valor=?`).bind(owner).run();
}
function novoOwnerLease(prefixo: string): string { return `${prefixo}-${crypto.randomUUID()}`; }

// ── D1 helpers: fila de trabalho (work queue) ─────────────────────────────────
const FILA_MAX_TENTATIVAS = 4;
// Enfileira VÁRIOS itens em poucos round-trips (DB.batch). Idempotente (INSERT OR IGNORE).
async function filaEnfileirarLote(
  itens: Array<{ chave: string; tipo: string; agenda_id_cnn?: string; paciente_id_cnn?: string; grupo?: string; payload?: any }>,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const CHUNK = 50;
  for (let i = 0; i < itens.length; i += CHUNK) {
    const grupo = itens.slice(i, i + CHUNK).map((it) =>
      env.DB.prepare(
        `INSERT INTO fila_trabalho (chave, tipo, agenda_id_cnn, paciente_id_cnn, grupo, payload, status, tentativas, criado_em, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, 'pendente', 0, ?, ?) ON CONFLICT (chave) DO NOTHING`
      ).bind(it.chave, it.tipo, it.agenda_id_cnn ?? null, it.paciente_id_cnn ?? null, it.grupo ?? null,
             it.payload ? JSON.stringify(it.payload) : null, now, now)
    );
    if (grupo.length) await env.DB.batch(grupo);
  }
}
// Ordenação da puxada: grupo B primeiro, ORC por último (rebaixado), depois FIFO por id.
const FILA_ORDER_BY = `ORDER BY (CASE WHEN grupo = 'B' THEN 0 WHEN tipo = 'ORC' THEN 2 ELSE 1 END), id`;
// TTL do lock: item preso em 'processing' além disto (dreno anterior morreu no meio) é repescado.
// C1-TTL (03/07): 90s (era 300) — reduz a latência de recuperação de hard-crash (item preso volta
// ~1,5min em vez de 5min); ainda muito acima da duração normal de um dreno (segundos).
const FILA_LOCK_TTL_SEG = 90;
function filaRank(x: any): number { return x.grupo === "B" ? 0 : (x.tipo === "ORC" ? 2 : 1); }

// PEEK só-leitura (p/ dry-run): lista pendentes SEM reivindicar. NÃO use no caminho real —
// dois drenos veriam o mesmo item. O caminho real usa filaClaimLote.
async function filaPuxarPendentes(limite: number, env: Env): Promise<any[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM fila_trabalho WHERE status = 'pendente' AND tentativas < ?
     ${FILA_ORDER_BY} LIMIT ?`
  ).bind(FILA_MAX_TENTATIVAS, limite).all();
  return r.results ?? [];
}
// CLAIM atômico (C1): reivindica um lote em UMA instrução (D1 serializa escritas), marcando
// status='processing' + locked_at e incrementando tentativas. Drenos concorrentes puxam
// conjuntos DISJUNTOS (o 2º já não vê como 'pendente'/repescável o que o 1º pegou). Também
// repesca itens presos em 'processing' além do TTL. RETURNING devolve o lote reivindicado.
async function filaClaimLote(limite: number, env: Env): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const staleAntes = now - FILA_LOCK_TTL_SEG;
  const r = await env.DB.prepare(
    `UPDATE fila_trabalho
        SET status='processing', locked_at=?, tentativas=tentativas+1, atualizado_em=?
      WHERE id IN (
        SELECT id FROM fila_trabalho
         WHERE tentativas < ?
           AND (status='pendente' OR (status='processing' AND locked_at < ?))
         ${FILA_ORDER_BY} LIMIT ?)
      RETURNING *`
  ).bind(now, now, FILA_MAX_TENTATIVAS, staleAntes, limite).all();
  // RETURNING não garante ordem → reordena p/ preservar a prioridade B>A>ORC no processamento.
  const rows = (r.results ?? []) as any[];
  rows.sort((a, b) => filaRank(a) - filaRank(b) || (a.id as number) - (b.id as number));
  return rows;
}
async function filaMarcarFeito(id: number, env: Env): Promise<void> {
  await env.DB.prepare(`UPDATE fila_trabalho SET status='feito', atualizado_em=? WHERE id=?`)
    .bind(Math.floor(Date.now() / 1000), id).run();
}
// Erro: o claim JÁ incrementou tentativas → aqui só decidimos o destino pelo valor ATUAL
// (o do item reivindicado, já pós-incremento). >= MAX → 'erro' (dead-letter); senão 'pendente'.
async function filaMarcarErro(id: number, tentativasApos: number, msg: string, env: Env): Promise<void> {
  const novoStatus = tentativasApos >= FILA_MAX_TENTATIVAS ? "erro" : "pendente";
  await env.DB.prepare(`UPDATE fila_trabalho SET status=?, locked_at=NULL, ultimo_erro=?, atualizado_em=? WHERE id=?`)
    .bind(novoStatus, msg.slice(0, 300), Math.floor(Date.now() / 1000), id).run();
}
// Adiado (NÃO é falha: ex. ORC esperando etapa assentada): volta a 'pendente' e DESFAZ o
// incremento do claim, p/ não queimar tentativas nem virar dead-letter à toa.
async function filaAdiar(id: number, env: Env): Promise<void> {
  await env.DB.prepare(`UPDATE fila_trabalho SET status='pendente', tentativas=GREATEST(tentativas-1,0), locked_at=NULL, atualizado_em=? WHERE id=?`)
    .bind(Math.floor(Date.now() / 1000), id).run();
}
async function filaStats(env: Env): Promise<Record<string, number>> {
  const r = await env.DB.prepare(`SELECT status, COUNT(*) as n FROM fila_trabalho GROUP BY status`).all();
  const out: Record<string, number> = {};
  for (const row of (r.results ?? []) as any[]) out[row.status] = row.n;
  return out;
}
// ── F1: log durável de tick (tabela tick_log) ─────────────────────────────────
// 1 linha por tick do cron. D1 NÃO conta no teto de 50 sub-requests → INSERT + poda são
// "grátis". Best-effort: NUNCA lança (igual audit()). Roda DENTRO do lease B2 (serializado).
const TICK_LOG_RETENCAO_DIAS = 3;
async function registrarTick(
  env: Env,
  t: { ts: number; ok: boolean; ms: number; subreq: number; gatilhos: string[]; cons: any; erro?: string; resumo: any }
): Promise<void> {
  try {
    const c = t.cons ?? {};
    const fila = await filaStats(env);
    await env.DB.prepare(
      `INSERT INTO tick_log (ts, ok, ms, subreq, gatilhos, processados, movidos, criados_b, adiados, erros, transitorios, fila_pendente, fila_erro, erro, resumo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      t.ts, t.ok ? 1 : 0, t.ms, t.subreq, t.gatilhos.join(","),
      c.processados ?? 0, c.movidos ?? 0, c.criados_b ?? 0, c.adiados ?? 0, c.erros ?? 0, c.transitorios ?? 0,
      fila.pendente ?? 0, fila.erro ?? 0,
      t.erro ? t.erro.slice(0, 500) : null,
      JSON.stringify(t.resumo ?? {}).slice(0, 4000)
    ).run();
    await env.DB.prepare(`DELETE FROM tick_log WHERE ts < ?`).bind(t.ts - TICK_LOG_RETENCAO_DIAS * 86400).run();
  } catch { /* log durável nunca quebra o tick */ }
}

// ── F1-alerta: tarefa no Kommo p/ o técnico SÓ em erro GRAVE (com cooldown) ────
// Grave = (A) últimos 3 ticks do cron TODOS falharam (robô travado) OU (B) muitos itens em
// dead-letter (erro sistêmico: token/API caída). Cooldown evita spam (1 tarefa por incidente).
const KOMMO_ALERTA_USER_ID = 11348335; // Marcos Venâncio (venanciofac@gmail.com). 0 = desligado.
const KOMMO_ALERTA_TASK_TYPE_ID = 1;   // Follow-up.
const ALERTA_COOLDOWN_SEG = 6 * 3600;  // 6h entre alertas
const ALERTA_DEADLETTER_LIMIAR = 25;   // nº de itens 'erro' que dispara alerta
async function criarTarefaAlertaKommo(env: Env, texto: string): Promise<void> {
  if (!KOMMO_ALERTA_USER_ID) return; // não configurado → não alerta
  const now = Math.floor(Date.now() / 1000);
  await kommoPost("/tasks", [{
    task_type_id: KOMMO_ALERTA_TASK_TYPE_ID,
    text: `⚠️ Integração CNN↔Kommo — ERRO GRAVE: ${texto}. Verificar /debug-tick-log.`,
    complete_till: now + 2 * 3600,
    responsible_user_id: KOMMO_ALERTA_USER_ID,
  }], env);
}
async function verificarAlertaGrave(env: Env): Promise<void> {
  try {
    const r = await env.DB.prepare(`SELECT ok FROM tick_log ORDER BY id DESC LIMIT 3`).all();
    const ticks = (r.results ?? []) as any[];
    const tresFalhas = ticks.length >= 3 && ticks.every((t) => Number(t.ok) === 0);
    const fila = await filaStats(env);
    const muitosErros = (fila.erro ?? 0) >= ALERTA_DEADLETTER_LIMIAR;
    if (!tresFalhas && !muitosErros) return;
    const now = Math.floor(Date.now() / 1000);
    const ultimo = await getCursor("ultimo_alerta_grave", env);
    if (ultimo && now - Number(ultimo) < ALERTA_COOLDOWN_SEG) return; // cooldown
    const motivo = tresFalhas ? "3 ticks seguidos do cron falharam (robô travado)" : `${fila.erro} itens em dead-letter na fila (erro sistêmico)`;
    await criarTarefaAlertaKommo(env, motivo);
    await setCursor("ultimo_alerta_grave", String(now), env);
  } catch { /* alerta nunca quebra o tick */ }
}

// ── D1 helpers: Função 2 (lembrete D-1) + auditoria ───────────────────────────
// Idempotência por (lead, DATA): 1 lembrete por lead por dia. Sustenta o desempate
// B-ganha (mesma data, 2 agendas do mesmo lead → só o 1º processado, que é o B).
async function leadJaLembradoNaData(leadId: string, data: string, env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM lembrete_d1 WHERE lead_id_kommo = ? AND data_agendamento = ? LIMIT 1").bind(leadId, data).first();
  return !!row;
}
async function registrarLembrete(
  r: { chave: string; lead_id_kommo: string; agenda_id_cnn: string; data_agendamento: string; grupo: string; pipeline_destino: number; etapa_destino: number },
  env: Env
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lembrete_d1 (chave, lead_id_kommo, agenda_id_cnn, data_agendamento, grupo, pipeline_destino, etapa_destino, enviado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chave) DO NOTHING`
  ).bind(r.chave, r.lead_id_kommo, r.agenda_id_cnn, r.data_agendamento, r.grupo, r.pipeline_destino, r.etapa_destino, Math.floor(Date.now() / 1000)).run();
}
async function audit(
  env: Env,
  e: { funcao: string; ambiente: string; entidade_id?: string; acao: string; de?: string; para?: string; detalhe?: string }
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO auditoria (ts, funcao, ambiente, entidade_id, acao, de, para, detalhe) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(Math.floor(Date.now() / 1000), e.funcao, e.ambiente, e.entidade_id ?? null, e.acao, e.de ?? null, e.para ?? null, e.detalhe ?? null).run();
  } catch { /* auditoria nunca quebra o fluxo */ }
}

// ── D1 helpers: cursores ──────────────────────────────────────────────────────
async function getCursor(nome: string, env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT valor FROM cursores WHERE nome = ?").bind(nome).first<{ valor: string }>();
  return row?.valor ?? null;
}
async function setCursor(nome: string, valor: string, env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cursores (nome, valor, atualizado_em) VALUES (?, ?, ?)
     ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`
  ).bind(nome, valor, Math.floor(Date.now() / 1000)).run();
}

// ── D1 helpers: mapeamento (identidade paciente↔lead, por (paciente, grupo)) ───
// Chave composta: cada paciente tem 0, 1 ou 2 entradas — (pac,"A")→lead de Captação,
// (pac,"B")→lead de Pós-Venda. As coleções em massa são chaveadas por "pac|grupo".
function mapeamentoKey(paciente: string, grupo: string): string {
  return `${paciente}|${grupo}`;
}
async function upsertMapeamento(
  m: { paciente_id_cnn: string; grupo: "A" | "B"; lead_id_kommo: string; telefone_norm: string; duplicata?: boolean },
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO mapeamento (paciente_id_cnn, grupo, lead_id_kommo, telefone_norm, duplicata, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(paciente_id_cnn, grupo) DO UPDATE SET
       lead_id_kommo = excluded.lead_id_kommo, telefone_norm = excluded.telefone_norm,
       duplicata = excluded.duplicata, atualizado_em = excluded.atualizado_em`
  ).bind(m.paciente_id_cnn, m.grupo, m.lead_id_kommo, m.telefone_norm, m.duplicata ? 1 : 0, now, now).run();
}
async function getMapeamento(paciente: string, grupo: "A" | "B", env: Env): Promise<any> {
  return env.DB.prepare("SELECT * FROM mapeamento WHERE paciente_id_cnn = ? AND grupo = ?").bind(paciente, grupo).first();
}
// Carrega TODAS as chaves "pac|grupo" mapeadas de uma vez (1 query) — evita N round-trips D1.
async function getMapeamentoIdSet(env: Env): Promise<Set<string>> {
  const r = await env.DB.prepare("SELECT paciente_id_cnn, grupo FROM mapeamento WHERE lead_id_kommo IS NOT NULL").all();
  return new Set((r.results ?? []).map((row: any) => mapeamentoKey(String(row.paciente_id_cnn), String(row.grupo))));
}
// Mapa "pac|grupo" → lead_id (1 query). Pra produtores acharem o lead sem fetch.
async function getMapeamentoLeadMap(env: Env): Promise<Map<string, string>> {
  const r = await env.DB.prepare("SELECT paciente_id_cnn, grupo, lead_id_kommo FROM mapeamento WHERE lead_id_kommo IS NOT NULL").all();
  const m = new Map<string, string>();
  for (const row of (r.results ?? []) as any[]) m.set(mapeamentoKey(String(row.paciente_id_cnn), String(row.grupo)), String(row.lead_id_kommo));
  return m;
}
// Existência de tabela (sqlite_master) — usado pela migração do mapeamento.
async function tabelaExiste(env: Env, nome: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(nome).first();
  return !!r;
}

// ── Migração do `mapeamento` p/ chave composta (paciente, grupo) ───────────────
// Endpoint `/debug-migrar-mapeamento`. Idempotente, em lote e RETOMÁVEL (cursor em
// `cursores`), respeitando o teto de sub-requests. SÓ LÊ a Kommo (kommoGet) — nenhuma
// escrita no CNN (§7.8). O `grupo` de cada linha é inferido pelo PIPELINE ATUAL do
// lead (Captação→"A"; Pós-Venda→"B"). Fallback (lead nulo, deletado/404, ou pipeline
// fora de Captação/Pós-Venda → grupo indeterminável): assume "A" (Captação = funil de
// entrada) e conta em `fallback_sem_lead`; a reconciliação das Tasks 2-4 corrige.
// A troca destrutiva (mapeamento_new → mapeamento) só acontece com ?commit=1 E após a
// cópia terminar (done=true). Backups: `mapeamento_bak` (cópia das linhas originais) e
// `mapeamento_old` (a tabela antiga renomeada no commit).
async function migrarMapeamento(env: Env, opts: { commit: boolean; chunk: number; budget: number }): Promise<any> {
  await ensureSchema(env);
  const CURSOR = "migra_map_cursor";
  const out: any = { commit: opts.commit, chunk: opts.chunk, budget: opts.budget };

  // Guarda de idempotência: se `mapeamento` já tem coluna `grupo` e não há shadow pendente,
  // a migração já foi concluída — não faz nada.
  const cols = await env.DB.prepare("PRAGMA table_info(mapeamento)").all();
  const temGrupo = (cols.results ?? []).some((c: any) => c.name === "grupo");
  const newExiste = await tabelaExiste(env, "mapeamento_new");
  if (temGrupo && !newExiste) {
    out.already_migrated = true;
    out.mapeamento_total = (await env.DB.prepare("SELECT COUNT(*) n FROM mapeamento").first<{ n: number }>())?.n ?? 0;
    return out;
  }

  // 1. Backup das linhas originais (no-op se já existe). Snapshot do schema VIGENTE.
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS mapeamento_bak AS SELECT * FROM mapeamento").run();
  // 2. Tabela shadow com PK composta + índices (nomes _new pra não colidir com os atuais).
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mapeamento_new (
      paciente_id_cnn TEXT NOT NULL, grupo TEXT NOT NULL, lead_id_kommo TEXT, telefone_norm TEXT,
      duplicata INTEGER DEFAULT 0, criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL,
      PRIMARY KEY (paciente_id_cnn, grupo))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_new_tel ON mapeamento_new(telefone_norm)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_new_lead ON mapeamento_new(lead_id_kommo)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_new_pac ON mapeamento_new(paciente_id_cnn)`),
  ]);

  out.bak_total = (await env.DB.prepare("SELECT COUNT(*) n FROM mapeamento_bak").first<{ n: number }>())?.n ?? 0;

  // 3. Copia em chunks, a partir do cursor (último paciente_id processado, ordem lexicográfica).
  let cursor = (await getCursor(CURSOR, env)) ?? "";
  out.cursor_ini = cursor;
  out.fallback_sem_lead = 0;
  let copiadosNesta = 0;
  let done = false;
  const now = Math.floor(Date.now() / 1000);

  while (orcamentoOk(opts.budget)) {
    const rows = ((await env.DB.prepare(
      `SELECT paciente_id_cnn, lead_id_kommo, telefone_norm, duplicata, criado_em, atualizado_em
       FROM mapeamento_bak WHERE paciente_id_cnn > ? ORDER BY paciente_id_cnn LIMIT ?`
    ).bind(cursor, opts.chunk).all()).results ?? []) as any[];
    if (rows.length === 0) { done = true; break; }

    // Lookup do pipeline atual dos leads do chunk, em 1 fetch batelado (filter[id][]).
    const ids = [...new Set(rows.map((r) => r.lead_id_kommo).filter((x: any) => x != null && String(x).length))].map(String);
    const pipelineDe = new Map<string, number>();
    if (ids.length) {
      const q = ids.map((id) => `filter[id][]=${encodeURIComponent(id)}`).join("&");
      try {
        const kr = await kommoGet(`/leads?${q}&limit=250`, env);
        for (const l of (kr._embedded?.leads ?? [])) pipelineDe.set(String(l.id), Number(l.pipeline_id));
      } catch { /* sem resposta → todos caem no fallback "A" */ }
    }

    const inserts = rows.map((r) => {
      const lead = r.lead_id_kommo != null ? String(r.lead_id_kommo) : "";
      const pl = lead ? pipelineDe.get(lead) : undefined;
      let grupo: "A" | "B";
      if (pl === PIPELINE_POS_VENDA) grupo = "B";
      else if (pl === PIPELINE_CAPTACAO) grupo = "A";
      else { grupo = "A"; out.fallback_sem_lead++; } // nulo/404/pipeline desconhecido → "A"
      return env.DB.prepare(
        `INSERT INTO mapeamento_new (paciente_id_cnn, grupo, lead_id_kommo, telefone_norm, duplicata, criado_em, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(paciente_id_cnn, grupo) DO NOTHING`
      ).bind(String(r.paciente_id_cnn), grupo, r.lead_id_kommo ?? null, r.telefone_norm ?? null,
             r.duplicata ?? 0, r.criado_em ?? now, r.atualizado_em ?? now);
    });
    if (inserts.length) await env.DB.batch(inserts);

    copiadosNesta += rows.length;
    cursor = String(rows[rows.length - 1].paciente_id_cnn);
    await setCursor(CURSOR, cursor, env);
    if (rows.length < opts.chunk) { done = true; break; }
  }

  out.cursor_fim = cursor;
  out.copiados_nesta_chamada = copiadosNesta;
  out.done = done;
  out.mapeamento_new_total = (await env.DB.prepare("SELECT COUNT(*) n FROM mapeamento_new").first<{ n: number }>())?.n ?? 0;
  const grp = await env.DB.prepare("SELECT grupo, COUNT(*) n FROM mapeamento_new GROUP BY grupo").all();
  out.grupos = {} as Record<string, number>;
  for (const g of (grp.results ?? []) as any[]) out.grupos[String(g.grupo)] = g.n;

  // 4. Troca destrutiva — só com ?commit=1 E cópia completa. Atômica (1 batch).
  if (opts.commit) {
    if (!done) { out.swap = "ADIADO: cópia incompleta (done=false). Rode de novo até done=true antes de ?commit=1."; return out; }
    await env.DB.batch([
      env.DB.prepare(`DROP TABLE IF EXISTS mapeamento_old`),
      env.DB.prepare(`DROP INDEX IF EXISTS idx_map_tel`),
      env.DB.prepare(`DROP INDEX IF EXISTS idx_map_lead`),
      env.DB.prepare(`DROP INDEX IF EXISTS idx_map_pac`),
      env.DB.prepare(`ALTER TABLE mapeamento RENAME TO mapeamento_old`),
      env.DB.prepare(`ALTER TABLE mapeamento_new RENAME TO mapeamento`),
      env.DB.prepare(`DROP INDEX IF EXISTS idx_map_new_tel`),
      env.DB.prepare(`DROP INDEX IF EXISTS idx_map_new_lead`),
      env.DB.prepare(`DROP INDEX IF EXISTS idx_map_new_pac`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_tel ON mapeamento(telefone_norm)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_lead ON mapeamento(lead_id_kommo)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_pac ON mapeamento(paciente_id_cnn)`),
      env.DB.prepare(`DELETE FROM cursores WHERE nome = ?`).bind(CURSOR),
    ]);
    out.swapped = true;
    out.swap = "OK: mapeamento_new → mapeamento. Antigo arquivado em mapeamento_old; cópia de segurança em mapeamento_bak.";
  }
  return out;
}

// Mapa agenda_id → estado baseline (1 query). Pra A3 detectar mudança sem N round-trips.
async function getAgendaSyncMap(env: Env): Promise<Map<string, { lead: string; status: string; ts: number }>> {
  const r = await env.DB.prepare("SELECT agenda_id_cnn, lead_id_kommo, last_cnn_status, last_agendamento_ts FROM agenda_sync").all();
  const m = new Map<string, { lead: string; status: string; ts: number }>();
  for (const row of (r.results ?? []) as any[]) m.set(String(row.agenda_id_cnn), { lead: String(row.lead_id_kommo), status: row.last_cnn_status ?? "", ts: row.last_agendamento_ts ?? 0 });
  return m;
}

// ── D1 helpers: agenda_sync (estado por agenda) ───────────────────────────────
async function upsertAgendaSync(
  a: { agenda_id_cnn: string; lead_id_kommo: string; paciente_id_cnn: string; last_agendamento_ts: number; last_cnn_status: string; origin?: string },
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // origin: quem escreveu (spec 2026-07-05). Chamadores antigos omitem → COALESCE preserva o valor
  // existente (não sobrescreve com null); os webhooks passam 'system' ao empurrar Kommo→CNN.
  await env.DB.prepare(
    `INSERT INTO agenda_sync (agenda_id_cnn, lead_id_kommo, paciente_id_cnn, last_agendamento_ts, last_cnn_status, atualizado_em, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agenda_id_cnn) DO UPDATE SET
       lead_id_kommo = excluded.lead_id_kommo, paciente_id_cnn = excluded.paciente_id_cnn,
       last_agendamento_ts = excluded.last_agendamento_ts, last_cnn_status = excluded.last_cnn_status,
       atualizado_em = excluded.atualizado_em, origin = COALESCE(excluded.origin, agenda_sync.origin)`
  ).bind(a.agenda_id_cnn, a.lead_id_kommo, a.paciente_id_cnn, a.last_agendamento_ts, a.last_cnn_status, now, a.origin ?? null).run();
}
async function getAgendaSync(agendaId: string, env: Env): Promise<any> {
  return env.DB.prepare("SELECT * FROM agenda_sync WHERE agenda_id_cnn = ?").bind(agendaId).first();
}

// ══ 3 WEBHOOKS Kommo→CNN (spec 2026-07-05) — escrita guardada + anti-loop ═══════
// Opções VÁLIDAS do campo "Tipo Procedimento CNN" (Kommo). Só serve p/ VALIDAR que o valor é um
// tipo conhecido; o idTipoConsulta REAL é resolvido pelo NOME no ambiente de escrita (resolveTipoConsultaId),
// porque sandbox×prod têm IDs distintos e o CNN pode renumerar. (IDs de referência = produção 2026-07-05.)
const TIPO_PROCEDIMENTO_CNN: Record<string, number> = {
  "procedimento": 66670, "cirurgia": 93892, "pequenas cirurgias": 66667,
  "encaixe": 66668, "retorno": 66672, "cortesia": 67118, "encaminhamento - interno": 66669,
};
function tipoProcedimentoParaId(valorOpcao: string | null): number {
  if (!valorOpcao) return 0;
  return TIPO_PROCEDIMENTO_CNN[valorOpcao.toLowerCase().trim()] ?? 0;
}
// Correlação (confirmada pelo dono 07/07): opção dos campos Kommo "Corporais"/"Faciais" → idTipoProcedimento
// do CNN (avaliação "Av X"). Opções SEM correspondente NÃO entram aqui → o WH2 NÃO cria agenda (equipe agenda
// no CNN manual). Sem correspondente hoje: Lipedema, Cisto Sebáceo, Lipoma, Biópsia, Papada, Bioestimuladores,
// Preen. Labial, Rino modelação, Siringoma, Xantelasma, Lifting de Sobran., Lobuloplastia.
const PROCEDIMENTO_CNN_POR_OPCAO: Record<string, number> = {
  // Corporais
  "celulite": 381386, "depilação a laser": 381362, "escleroterapia": 381389, "emagrecimento": 381360,
  "gordura localizada": 381392, "remoção de tatuagem": 381405, "flacidez corporal": 381391,
  "unha encravada": 381384, "onicomicose": 381398, "sinais de pele": 381406, "câncer de pele": 381383,
  "cicatriz": 381402,
  // Faciais
  "botox": 381357, "h. fac. / preen. / rejuv.": 381403, "peeling": 381400, "olheiras / bléfaro": 381397,
  "acne": 381381, "melasma / mela. solar": 381395, "despig. de sobran.": 381396,
};
function procedimentosCnnDoCard(opcoes: string[]): number[] {
  const ids: number[] = [];
  for (const o of opcoes) { const id = PROCEDIMENTO_CNN_POR_OPCAO[(o ?? "").toLowerCase().trim()]; if (id && !ids.includes(id)) ids.push(id); }
  return ids;
}
// Resolve o NOME do tipo → idTipoConsulta REAL do ambiente-alvo (via /tipo-consulta/lista, cacheado).
// Robusto entre sandbox/prod e a renumeração do CNN. null se o tipo não existir no alvo.
async function resolveTipoConsultaId(nome: string, env: Env, target: CnnTarget): Promise<number | null> {
  const alvo = normNome(nome);
  const tiposMap = await resolveTiposConsulta(env, target); // id → normNome
  const hit = Object.entries(tiposMap).find(([, n]) => n === alvo);
  return hit ? Number(hit[0]) : null;
}
// Alvo das escritas dos webhooks. Default sandbox (seguro); o dono vira p/ 'production'.
function cnnWriteTarget(env: Env): CnnTarget {
  return env.CNN_WRITE_TARGET === "production" ? "production" : "sandbox";
}
// IDs de criação de agenda POR AMBIENTE. sandbox×produção têm ids DISTINTOS (bug descoberto 07/07:
// convênio 56545 / sala 41170 / procedimento 1011844 são SANDBOX e não existem em produção → o
// POST /agenda/novo do pós-venda dava 400). Produção é overridável por env (o dono ajusta a sala e o
// procedimento REAIS que a clínica quer nos agendamentos automáticos); default = ids lidos do CNN prod.
function cnnConvenioParticular(env: Env, target: CnnTarget): number {
  return target === "production" ? Number(env.CNN_CONVENIO_PARTICULAR_PRODUCTION ?? 27603) : CNN_CONVENIO_PARTICULAR;
}
function cnnLocalAgenda(env: Env, target: CnnTarget): number {
  return target === "production" ? Number(env.CNN_LOCAL_AGENDA_PRODUCTION ?? 19775) : CNN_LOCAL_AGENDA;
}
function cnnTipoProcedimento(env: Env, target: CnnTarget): number {
  return target === "production" ? Number(env.CNN_TIPO_PROCEDIMENTO_PRODUCTION ?? 381357) : CNN_TIPO_PROCEDIMENTO;
}
// F.Captura (Grupo A / lead-agendado): tipo de atendimento = Consulta/Avaliação (66666) e procedimento
// PREDEFINIDO = "Av Capilar" (361025) — o CNN exige 1 procedimento na agenda mesmo p/ consulta; não há
// procedimento "só consulta" genérico, então usa-se esse placeholder (equipe ajusta na tela se preciso).
function cnnTipoConsultaCaptura(env: Env, target: CnnTarget): number {
  return target === "production" ? Number(env.CNN_TIPO_CONSULTA_PRODUCTION ?? 66666) : CNN_TIPO_CONSULTA;
}
function cnnProcedimentoCaptura(env: Env, target: CnnTarget): number {
  return target === "production" ? Number(env.CNN_PROCEDIMENTO_CAPTURA_PRODUCTION ?? 361025) : CNN_TIPO_PROCEDIMENTO;
}
// ── Anti-loop PURO (testável no /debug-selftest): dada a intenção e o estado atual da agenda
//    (agenda_sync, ou null), decide executar ou suprimir. NÃO toca I/O. ──
// ⚠️ O ÚNICO guarda anti-loop é a convergência de (last_agendamento_ts ±60s, last_cnn_status).
//    A coluna `origin` é SÓ observabilidade/proveniência — NÃO é consultada aqui nem no polling
//    (produtorSync/consumirItemA3). NÃO afrouxar a tolerância de 60s achando que `origin` é backstop.
type IntencaoCnn = { tipo: "CNN_CONFIRMAR" | "CNN_AGENDAR"; ts?: number; temAgendaNoCard?: boolean };
function decidirSupressao(
  intent: IntencaoCnn,
  estado: { last_agendamento_ts?: number | null; last_cnn_status?: string | null } | null
): { executa: boolean; motivo: string } {
  const tsIgual = (a?: number, b?: number | null) =>
    a != null && b != null && Math.abs(Number(a) - Number(b)) <= 60;
  if (intent.tipo === "CNN_CONFIRMAR") {
    if (estado?.last_cnn_status === "CONFIRMADO_PACIENTE") return { executa: false, motivo: "ja_confirmado" };
    return { executa: true, motivo: "confirmar" };
  }
  // CNN_AGENDAR: retorno da confirmação → card já tem agenda E o horário não mudou → é o loop → suprime.
  if (intent.temAgendaNoCard && tsIgual(intent.ts, estado?.last_agendamento_ts))
    return { executa: false, motivo: "ja_agendado_mesmo_ts" };
  return { executa: true, motivo: "agendar" };
}
// [Familia]/colisão de telefone: 2+ pacientes distintos no MESMO lead → recusa escrita no CNN
// (risco de acertar o paciente errado no sistema clínico). FAIL-CLOSED: erro de leitura → true
// (recusa sob incerteza; falso-alarme raro e recuperável via tarefa manual). Nunca liberar sob dúvida.
async function leadEhFamilia(leadId: string, env: Env): Promise<boolean> {
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(DISTINCT paciente_id_cnn) n FROM mapeamento WHERE lead_id_kommo = ?`
    ).bind(leadId).first<any>();
    return Number(r?.n ?? 0) >= 2;
  } catch (e) {
    // FAIL-CLOSED sem decisão terminal errada (achado re-cert): erro de D1 LANÇA como transitório →
    // o item é ADIADO e retentado. Não escreve no CNN sob incerteza NEM recusa família pra sempre.
    throw new Error(`[TRANSITORIO] leadEhFamilia D1: ${String(e)}`);
  }
}
// Tarefa Kommo atribuída ao responsável DO LEAD (nativo), anexada ao lead. Nunca quebra o fluxo.
// complete_till é clampado p/ nunca nascer no passado (tarefa não deve nascer vencida).
async function criarTarefaLead(leadId: string, texto: string, completeTill: number, env: Env): Promise<void> {
  try {
    let resp = KOMMO_ALERTA_USER_ID;
    try { resp = Number((await kommoGet(`/leads/${leadId}`, env))?.responsible_user_id) || KOMMO_ALERTA_USER_ID; } catch { /* usa fallback */ }
    if (!resp) return;
    const ct = Math.max(completeTill, Math.floor(Date.now() / 1000) + 300); // nunca no passado
    await kommoPost("/tasks", [{
      task_type_id: KOMMO_ALERTA_TASK_TYPE_ID, text: texto,
      complete_till: ct, entity_id: Number(leadId), entity_type: "leads",
      responsible_user_id: resp,
    }], env);
  } catch { /* tarefa nunca quebra o fluxo */ }
}
// Purga o gêmeo TERMINAL ('feito' ou 'erro'/dead-letter) de uma chave de fila ANTES de reenfileirar.
// Espelha a mitigação A3-REVERSÃO (~L2122): sem isto, INSERT OR IGNORE sobre a chave UNIQUE descarta
// pra sempre um re-disparo legítimo (confirma→desconfirma→reconfirma; remarca t0→t1→t0→t1). Também
// limpa o gêmeo 'erro' (achado re-cert #4): um NOVO gatilho legítimo merece tentativa nova, não ficar
// preso num dead-letter antigo (o histórico da falha permanece em `auditoria`). Só toca estados
// TERMINAIS — NÃO mexe em pendente/processing (preserva "mesma mudança = 1 item" p/ item em voo).
// Seguro: o chamador só purga após decidirSupressao provar MUDANÇA REAL de estado.
async function purgarGemeoFeito(chave: string, env: Env): Promise<void> {
  try { await env.DB.prepare(`DELETE FROM fila_trabalho WHERE chave = ? AND status IN ('feito','erro')`).bind(chave).run(); }
  catch { /* purga best-effort; não quebra o enqueue */ }
}

// Procura no CNN uma agenda do paciente no mesmo dia/hora (AGENDADO/CONFIRMADO) — idempotência do
// create (fecha o resíduo "POST criou mas a resposta se perdeu"). GET é permitido pelo allowlist.
async function acharAgendaCnnPorHorario(pid: string, data: string, hora: string, env: Env, target: CnnTarget): Promise<string | null> {
  // FAIL-CLOSED (achado re-cert): NÃO engole erro do GET. Se o cnnGet lançar (429/5xx/rede), o erro
  // PROPAGA → o consumidor adia/retenta e NÃO cria agenda às cegas. Retorna null SÓ quando o GET
  // sucedeu e não há agenda no horário (certeza positiva de "não existe").
  const r: any = await cnnGet(`/agenda/lista?codigoPaciente=${pid}&dataInicial=${data}&dataFinal=${data}&registrosPorPagina=200&pagina=0`, env, target);
  const ag = (r?.lista ?? []).find((a: any) =>
    String(a.horaInicio ?? "").startsWith(hora) && (a.status === "AGENDADO" || a.status === "CONFIRMADO_PACIENTE"));
  return ag ? String(ag.id) : null;
}

// ── Consumidor: CNN_CONFIRMAR (webhook 1) — PUT alteracao-status → CONFIRMADO_PACIENTE ──
async function consumirItemCnnConfirmar(item: any, env: Env, dryRun: boolean): Promise<{ r: string; leadId?: string; nome?: string }> {
  const p = item.payload ? JSON.parse(item.payload) : {};
  const leadId = String(p.leadId ?? "");
  const agendaId = String(p.agendaId ?? item.agenda_id_cnn ?? "");
  if (!leadId || !agendaId) return { r: "pulado", leadId, nome: "sem_dados" };
  if (await leadEhFamilia(leadId, env)) {
    if (!dryRun) { await criarTarefaLead(leadId, "Card [Familia]/colisão — confirmação no CNN RECUSADA (risco de paciente errado). Verificar manualmente.", Math.floor(Date.now() / 1000) + 2 * 3600, env); await audit(env, { funcao: "CNN_CONFIRMAR", ambiente: "kommo", entidade_id: leadId, acao: "recusado_familia" }); }
    return { r: "recusado_familia", leadId };
  }
  const est: any = await getAgendaSync(agendaId, env);
  const dec = decidirSupressao({ tipo: "CNN_CONFIRMAR" }, est);
  if (!dec.executa) { if (!dryRun) await audit(env, { funcao: "CNN_CONFIRMAR", ambiente: "kommo", entidade_id: leadId, acao: "suprimido_ja_no_alvo", detalhe: dec.motivo }); return { r: "suprimido", leadId, nome: dec.motivo }; }
  if (dryRun) return { r: "executaria", leadId, nome: "confirmar" };
  const wt = cnnWriteTarget(env);
  await cnnPut("/agenda/alteracao-status", { idAgenda: Number(agendaId), status: "CONFIRMADO_PACIENTE" }, env, wt);
  await upsertAgendaSync({ agenda_id_cnn: agendaId, lead_id_kommo: leadId, paciente_id_cnn: String(est?.paciente_id_cnn ?? p.pid ?? ""), last_agendamento_ts: Number(est?.last_agendamento_ts ?? 0), last_cnn_status: "CONFIRMADO_PACIENTE", origin: "system" }, env);
  await audit(env, { funcao: "CNN_CONFIRMAR", ambiente: wt, entidade_id: leadId, acao: "executou", detalhe: `agenda ${agendaId} → CONFIRMADO_PACIENTE` });
  return { r: "escreveu_cnn", leadId, nome: "confirmar" };
}

// ── Consumidor: CNN_AGENDAR (webhook 2) — POST /agenda/novo status AGENDADO (tipo do campo) ──
async function consumirItemCnnAgendar(item: any, env: Env, dryRun: boolean): Promise<{ r: string; leadId?: string; nome?: string }> {
  const p = item.payload ? JSON.parse(item.payload) : {};
  const leadId = String(p.leadId ?? "");
  const pid = String(p.pid ?? item.paciente_id_cnn ?? "");
  const ts = Number(p.ts ?? 0);
  const tipoNome = String(p.tipoNome ?? "");
  if (!leadId || !pid) return { r: "pulado", leadId, nome: "sem_paciente" };           // nunca cria paciente
  if (!ts || !tipoNome) return { r: "pulado", leadId, nome: "sem_ts_ou_tipo" };
  if (await leadEhFamilia(leadId, env)) {
    if (!dryRun) { await criarTarefaLead(leadId, "Card [Familia]/colisão — agendamento no CNN RECUSADO (risco de paciente errado). Verificar manualmente.", Math.floor(Date.now() / 1000) + 2 * 3600, env); await audit(env, { funcao: "CNN_AGENDAR", ambiente: "kommo", entidade_id: leadId, acao: "recusado_familia" }); }
    return { r: "recusado_familia", leadId };
  }
  // Double-check sob o claim: relê o card fresco — já tem agenda + ts inalterado → suprime (loop).
  const fields = await resolveFields(env);
  const lead = await kommoGet(`/leads/${leadId}`, env);
  const idAgendaCard = getFieldValue(lead, fields["ID Agenda CNN"]);
  const est: any = idAgendaCard ? await getAgendaSync(String(idAgendaCard), env) : null;
  const dec = decidirSupressao({ tipo: "CNN_AGENDAR", ts, temAgendaNoCard: !!idAgendaCard }, est);
  if (!dec.executa) { if (!dryRun) await audit(env, { funcao: "CNN_AGENDAR", ambiente: "kommo", entidade_id: leadId, acao: "suprimido_loop", detalhe: dec.motivo }); return { r: "suprimido", leadId, nome: dec.motivo }; }
  if (dryRun) return { r: "executaria", leadId, nome: "agendar" };
  const wt = cnnWriteTarget(env);
  // Resolve o tipo pelo NOME no ambiente de ESCRITA — sandbox×prod têm IDs distintos, e sobrevive a
  // renumeração do CNN. Se o tipo não existir no alvo, PULA (não cria com id errado).
  const idTipoConsulta = await resolveTipoConsultaId(tipoNome, env, wt);
  if (!idTipoConsulta) return { r: "pulado", leadId, nome: `tipo_inexistente_no_alvo:${tipoNome}` };
  const { data, hora } = unixToDateBRT(ts);
  const horaFim = addMinutes(hora, 30);
  // IDEMPOTÊNCIA anti-duplicata (achado B): /agenda/novo é NÃO-idempotente e o retry da fila pode
  // reexecutar se um passo pós-create falhar. Duas barreiras ANTES de criar:
  // (1) agenda_sync (D1, durável, não sofre 429 do Kommo): já criei essa agenda p/ este lead+ts?
  const jaCriada: any = await env.DB.prepare(
    `SELECT agenda_id_cnn FROM agenda_sync WHERE lead_id_kommo=? AND last_cnn_status='AGENDADO' AND origin='system' AND ABS(last_agendamento_ts-?)<=60 LIMIT 1`
  ).bind(leadId, ts).first();
  if (jaCriada?.agenda_id_cnn) {
    await escreverVinculoCnn(leadId, String(jaCriada.agenda_id_cnn), pid, ts, fields, env); // completa o vínculo que faltou no run anterior
    await audit(env, { funcao: "CNN_AGENDAR", ambiente: wt, entidade_id: leadId, acao: "executou", detalhe: `agenda ${jaCriada.agenda_id_cnn} adotada (idempotência D1)` });
    return { r: "escreveu_cnn", leadId, nome: "agendar_adotada" };
  }
  // (2) Resposta perdida do POST anterior (rede/5xx pós-efeito): pergunta AO CNN (GET é permitido)
  //     se já existe agenda no mesmo dia/hora — adota em vez de criar outra (estilo A7 p/ o card).
  const existenteCnn = await acharAgendaCnnPorHorario(pid, data, hora, env, wt);
  if (existenteCnn) {
    await upsertAgendaSync({ agenda_id_cnn: existenteCnn, lead_id_kommo: leadId, paciente_id_cnn: pid, last_agendamento_ts: ts, last_cnn_status: "AGENDADO", origin: "system" }, env);
    await escreverVinculoCnn(leadId, existenteCnn, pid, ts, fields, env);
    await audit(env, { funcao: "CNN_AGENDAR", ambiente: wt, entidade_id: leadId, acao: "executou", detalhe: `agenda ${existenteCnn} adotada do CNN (resposta perdida)` });
    return { r: "escreveu_cnn", leadId, nome: "agendar_adotada" };
  }
  const idPacienteConvenio = await getOrCreateConvenioParticular(Number(pid), env, wt);
  const agenda: any = await cnnPost("/agenda/novo", {
    data, horaInicio: `${hora}:00`, horaFim: `${horaFim}:00`,
    idPaciente: Number(pid), idPacienteConvenio,
    idTipoConsulta, idLocalAgenda: cnnLocalAgenda(env, wt), status: "AGENDADO",
    procedimentos: (Array.isArray(p.procIds) && p.procIds.length ? p.procIds : [cnnTipoProcedimento(env, wt)]).map((id: number) => ({ idTipoProcedimento: id, quantidade: 1 })),
  }, env, wt);
  // Marcador durável ANTES de tocar o card (achados B/#9): se o PATCH do card falhar, o retry
  // encontra a agenda via agenda_sync (barreira 1) e NÃO cria outra.
  await upsertAgendaSync({ agenda_id_cnn: String(agenda.id), lead_id_kommo: leadId, paciente_id_cnn: pid, last_agendamento_ts: ts, last_cnn_status: "AGENDADO", origin: "system" }, env);
  await escreverVinculoCnn(leadId, String(agenda.id), pid, ts, fields, env);
  await audit(env, { funcao: "CNN_AGENDAR", ambiente: wt, entidade_id: leadId, acao: "executou", detalhe: `agenda criada ${agenda.id} tipo ${idTipoConsulta}` });
  return { r: "escreveu_cnn", leadId, nome: "agendar" };
}

async function setSyncedTs(leadId: string, ts: number, env: Env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO agendamento_sync (lead_id, synced_ts, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET synced_ts = excluded.synced_ts, updated_at = excluded.updated_at
  `).bind(leadId, ts, now).run();
}

// ── Reflexo de Orçamento (CNN → Kommo) — portão + decisor puro ───────────────
// Fundação read-only (spec 2026-07-01, §4). Portão de precedência: agenda futura
// ativa manda (cliente ativo / confirmação de véspera), reusa agenda_sync — SEM
// subrequest CNN (D1 não conta no orçamento de fetch/invocação).
async function temAgendaFutura(pid: string, env: Env): Promise<boolean> {
  // Dia-level: o dia inteiro de uma agenda ainda AGENDADO/CONFIRMADO mantém o portão
  // fechado (não abre no instante em que a hora passa) — reduz a corrida com o A3.
  const inicioHoje = brtToUnix(todayBRT(), "00:00");
  const row = await env.DB.prepare(
    `SELECT 1 FROM agenda_sync WHERE paciente_id_cnn = ? AND last_agendamento_ts >= ?
     AND last_cnn_status IN ('AGENDADO', 'CONFIRMADO_PACIENTE') LIMIT 1`
  ).bind(pid, inicioHoje).first();
  return !!row;
}
// Decisor puro (sem I/O): etapa-alvo pro conjunto de orçamentos de 1 paciente.
// null = "não mexe" (portão fechado por agenda futura, ou nada a refletir).
// Regra (§4): agenda futura > algum orçamento APROVADO > mais recente por id.
function decidirEtapaOrcamento(orcamentos: any[], temFutura: boolean): { pipeline: number; status: number } | null {
  if (temFutura) return null; // portão: agendamento futuro manda, não reflete orçamento
  if (!orcamentos.length) return null; // nada pra refletir
  if (orcamentos.some((o) => o.status === "APROVADO")) {
    return { pipeline: PIPELINE_POS_VENDA, status: STAGE_POS_TRATAMENTO_INICIADO };
  }
  const recente = orcamentos.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
  if (recente.status === "CANCELADO" || recente.status === "PERDIDO") {
    return { pipeline: PIPELINE_POS_CONSULTA, status: STAGE_POSCONS_VENDA_PERDIDA };
  }
  return { pipeline: PIPELINE_POS_CONSULTA, status: STAGE_POSCONS_EM_ANALISE };
}
// Só reflete APROVADO RECENTE (aprovação nos últimos ORC_APROVACAO_MAX_DIAS). O CNN não
// expõe status de execução do tratamento (dadosExecucao vem null; sem endpoint financeiro),
// então a recência da aprovação é o único proxy p/ "venda ainda ativa" — aprovação antiga
// isolada NÃO reativa (o tratamento pode já estar inativo/feito). Pré-filtro aplicado ANTES
// de decidirEtapaOrcamento, então o decisor e seus testes ficam intactos.
const ORC_APROVACAO_MAX_DIAS = 60;
function orcamentosRecentes(orcamentos: any[], aprovacaoMinISO: string): any[] {
  return orcamentos.filter((o) => o.status !== "APROVADO" || (o.dataAprovacao && o.dataAprovacao >= aprovacaoMinISO));
}

// ── D1 helpers: orcamento_sync (estado por paciente, espelha agenda_sync) ────
// Idempotência do reflexo: guarda a ÚLTIMA ETAPA já refletida (não só o status cru)
// pra o consumidor saber se já moveu o lead pra esse alvo antes (mesmo que alguém
// tenha movido o card manualmente depois — ver consumirItemOrcamento).
async function getOrcamentoSync(pid: string, env: Env): Promise<{ ultimo_status: string | null; ultima_etapa: number | null } | null> {
  const row = await env.DB.prepare(
    "SELECT ultimo_status, ultima_etapa FROM orcamento_sync WHERE paciente_id_cnn = ?"
  ).bind(pid).first<{ ultimo_status: string | null; ultima_etapa: number | null }>();
  return row ?? null;
}
async function upsertOrcamentoSync(
  o: { paciente_id_cnn: string; lead_id_kommo: string; ultimo_status: string | null; ultima_etapa: number | null },
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO orcamento_sync (paciente_id_cnn, lead_id_kommo, ultimo_status, ultima_etapa, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(paciente_id_cnn) DO UPDATE SET
       lead_id_kommo = excluded.lead_id_kommo, ultimo_status = excluded.ultimo_status,
       ultima_etapa = excluded.ultima_etapa, updated_at = excluded.updated_at`
  ).bind(o.paciente_id_cnn, o.lead_id_kommo, o.ultimo_status, o.ultima_etapa, now).run();
}

// Resolve o idPacienteConvenio (Particular). Associa se faltar; se já existe
// (CNN 400 "já está associado"), busca a associação ativa existente.
async function getOrCreateConvenioParticular(idPaciente: number, env: Env, target: CnnTarget = "sandbox"): Promise<number | undefined> {
  try {
    const convenio: any = await cnnPost("/convenio-paciente/associar", {
      idPaciente, idTipoConvenio: cnnConvenioParticular(env, target),
    }, env, target);
    if (convenio?.id) return convenio.id;
  } catch { /* provavelmente já associado — busca abaixo */ }
  try {
    const lista: any = await cnnGet(`/convenio-paciente/lista?idPaciente=${idPaciente}&somenteAtivos=true`, env, target);
    const itens = lista?.lista ?? [];
    const particular = itens.find((c: any) => c.idTipoConvenio === cnnConvenioParticular(env, target));
    return (particular ?? itens[0])?.id;
  } catch { return undefined; }
}

// ── W1: Lead movido para "Consulta Agendada" no Kommo ────────────────────────
// Cria paciente + agendamento na CNN e salva os IDs de volta no lead.
async function handleLeadAgendado(req: Request, env: Env): Promise<Response> {
  const params = new URLSearchParams(await req.text());
  const leadId = params.get("leads[status][0][id]");
  if (!leadId) return new Response("lead id ausente", { status: 400 });

  const fields = await resolveFields(env);
  const fIdAgenda    = fields["ID Agenda CNN"];
  const fIdPaciente  = fields["ID Paciente CNN"];
  const fAgendamento = fields["AGENDAMENTO"];
  if (!fIdAgenda || !fIdPaciente || !fAgendamento)
    return new Response("campos CNN não encontrados — verifique os nomes no Kommo", { status: 500 });
  const wt = cnnWriteTarget(env); // F.Captura escreve no CNN de escrita (produção no go-live), não mais sandbox

  const lead = await kommoGet(`/leads/${leadId}?with=contacts`, env);
  if (getFieldValue(lead, fIdAgenda))
    return Response.json({ ok: true, skipped: true, reason: "already_synced" });

  const agendamentoTs = getFieldValue(lead, fAgendamento);
  if (!agendamentoTs) return new Response("campo AGENDAMENTO não preenchido no lead", { status: 422 });

  const { data, hora } = unixToDateBRT(Number(agendamentoTs));
  const contactId = lead._embedded?.contacts?.[0]?.id;
  if (!contactId) return new Response("lead sem contato associado", { status: 422 });

  const contact = await kommoGet(`/contacts/${contactId}`, env);
  const nome = contact.name ?? "Paciente";
  const telefone: string | null = (contact.custom_fields_values ?? [])
    .find((f: any) => f.field_code === "PHONE")?.values?.[0]?.value ?? null;
  const dataNascimento = contact.birthday
    ? new Date(contact.birthday * 1000).toISOString().slice(0, 10)
    : "1900-01-01";

  let idPaciente = Number(getFieldValue(lead, fIdPaciente) ?? 0);
  if (!idPaciente) {
    let existente: any = null;
    try {
      const busca = await cnnGet(`/paciente/lista?nomeContem=${encodeURIComponent(nome)}&limite=5`, env, wt);
      existente = (busca?.lista ?? []).find(
        (p: any) => p.nome?.toLowerCase().trim() === nome.toLowerCase().trim()
      ) ?? null;
    } catch { /* cria novo */ }
    if (existente) {
      idPaciente = existente.id;
    } else {
      const novo = await cnnPost("/paciente/novo", {
        nome, dataNascimento,
        ...(telefone ? { contato: { telefoneCelular: normalizePhone(telefone) } } : {}),
      }, env, wt);
      idPaciente = novo.id;
    }
  }

  // Convênio: clínica é FULL PARTICULAR. /agenda/novo EXIGE idPacienteConvenio.
  // Associa o Particular; se o paciente já tem, reaproveita a associação existente.
  const idPacienteConvenio = await getOrCreateConvenioParticular(idPaciente, env, wt);

  const horaFim = addMinutes(hora, 30);
  const agenda = await cnnPost("/agenda/novo", {
    data, horaInicio: `${hora}:00`, horaFim: `${horaFim}:00`,
    idPaciente, idPacienteConvenio,
    idTipoConsulta: cnnTipoConsultaCaptura(env, wt), idLocalAgenda: cnnLocalAgenda(env, wt),
    status: "AGENDADO",
    procedimentos: [{ idTipoProcedimento: cnnProcedimentoCaptura(env, wt), quantidade: 1 }],
  }, env, wt);

  await setLeadFields(leadId, [
    { id: fIdAgenda,   value: String(agenda.id) },
    { id: fIdPaciente, value: String(idPaciente) },
  ], env);
  await setSyncedTs(leadId, brtToUnix(data, hora), env);

  return Response.json({ ok: true, idAgenda: agenda.id, idPaciente });
}

// ── W2: Paciente confirmou pelo WhatsApp ──────────────────────────────────────
// Salesbot dispara webhook. Worker atualiza CNN para CONFIRMADO_PACIENTE
// e move lead para Consulta Confirmada.
async function handleConfirmacao(req: Request, env: Env): Promise<Response> {
  const params = new URLSearchParams(await req.text());
  const leadId = params.get("leads[status][0][id]");
  if (!leadId) return new Response("lead id ausente", { status: 400 });

  const fields = await resolveFields(env);
  const fIdAgenda = fields["ID Agenda CNN"];
  if (!fIdAgenda) return new Response("campo ID Agenda CNN não encontrado", { status: 500 });

  const lead = await kommoGet(`/leads/${leadId}`, env);
  const idAgenda = getFieldValue(lead, fIdAgenda);
  if (!idAgenda) return new Response("ID Agenda CNN não preenchido no lead", { status: 422 });

  const dry = new URL(req.url).searchParams.get("dry") === "1";
  // Modelo LEGADO (síncrono, sandbox por default) — preservado até o dono ligar WH1_ENABLED.
  if (env.WH1_ENABLED !== "1") {
    if (dry) return Response.json({ ok: true, dry: true, modo: "legado", executaria: true });
    await cnnPut("/agenda/alteracao-status", { idAgenda: Number(idAgenda), status: "CONFIRMADO_PACIENTE" }, env);
    await moveLeadToStage(leadId, STAGE_CONSULTA_CONFIRMADA, env);
    return Response.json({ ok: true, modo: "legado" });
  }
  // Modelo NOVO (spec 2026-07-05): anti-loop + fila (escreve no CNN via allowlist/CNN_WRITE_TARGET).
  if (await leadEhFamilia(leadId, env)) {
    if (!dry) await audit(env, { funcao: "CNN_CONFIRMAR", ambiente: "kommo", entidade_id: leadId, acao: "recusado_familia" });
    return Response.json({ ok: true, dry, recusado: "familia" });
  }
  const est: any = await getAgendaSync(String(idAgenda), env);
  const dec = decidirSupressao({ tipo: "CNN_CONFIRMAR" }, est);
  if (!dec.executa) {
    if (!dry) await audit(env, { funcao: "CNN_CONFIRMAR", ambiente: "kommo", entidade_id: leadId, acao: "suprimido_ja_no_alvo", detalhe: dec.motivo });
    return Response.json({ ok: true, dry, suprimido: dec.motivo });
  }
  const kommoTs = Number(getFieldValue(lead, fields["AGENDAMENTO"]) ?? 0);
  const chave = `CNN_CONFIRMAR:${idAgenda}:${kommoTs}`;
  if (dry) return Response.json({ ok: true, dry: true, enfileiraria: "CNN_CONFIRMAR" });
  await purgarGemeoFeito(chave, env); // achado A: libera re-disparo legítimo (confirma→desconfirma→reconfirma)
  await filaEnfileirarLote([{
    chave, tipo: "CNN_CONFIRMAR", agenda_id_cnn: String(idAgenda), grupo: "A",
    payload: { leadId, agendaId: String(idAgenda), pid: getFieldValue(lead, fields["ID Paciente CNN"]) },
  }], env);
  return Response.json({ ok: true, enfileirado: "CNN_CONFIRMAR" });
}

// ── Webhook 2: card pós-venda → "Cliente Ativo" com AGENDAMENTO + Tipo → cria agenda no CNN ──
async function handlePosVendaAgendar(req: Request, env: Env): Promise<Response> {
  if (env.WH2_ENABLED !== "1") return Response.json({ ok: true, skipped: "WH2 desligado" });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const params = new URLSearchParams(await req.text());
  const leadId = params.get("leads[status][0][id]");
  if (!leadId) return new Response("lead id ausente", { status: 400 });
  let fields = await resolveFields(env);
  if (fields["Tipo Procedimento CNN"] === undefined) fields = await resolveFields(env, true); // achado #10: campo recém-criado num isolate quente
  const lead = await kommoGet(`/leads/${leadId}`, env);
  const pid = getFieldValue(lead, fields["ID Paciente CNN"]);
  const ts = Number(getFieldValue(lead, fields["AGENDAMENTO"]) ?? 0);
  const tipoNome = getFieldValue(lead, fields["Tipo Procedimento CNN"]) ?? "";
  // Procedimento(s) do card (Corporais + Faciais, multiselect) → ids CNN correlacionados (dono 07/07).
  const opcoesProc = [...getFieldValuesMulti(lead, fields["Corporais"]), ...getFieldValuesMulti(lead, fields["Faciais"])];
  const procIds = procedimentosCnnDoCard(opcoesProc);
  if (!pid) return Response.json({ ok: true, skipped: "sem ID Paciente CNN (não cria paciente)" });
  if (!ts || tipoProcedimentoParaId(tipoNome) === 0) return Response.json({ ok: true, skipped: "sem AGENDAMENTO ou Tipo Procedimento CNN" });
  if (!procIds.length) return Response.json({ ok: true, skipped: "sem procedimento correspondente no CNN — equipe agenda manual", opcoes: opcoesProc });
  if (await leadEhFamilia(leadId, env)) {
    if (!dry) await audit(env, { funcao: "CNN_AGENDAR", ambiente: "kommo", entidade_id: leadId, acao: "recusado_familia" });
    return Response.json({ ok: true, dry, recusado: "familia" });
  }
  const idAgendaCard = getFieldValue(lead, fields["ID Agenda CNN"]);
  const est: any = idAgendaCard ? await getAgendaSync(String(idAgendaCard), env) : null;
  const dec = decidirSupressao({ tipo: "CNN_AGENDAR", ts, temAgendaNoCard: !!idAgendaCard }, est);
  if (!dec.executa) {
    if (!dry) await audit(env, { funcao: "CNN_AGENDAR", ambiente: "kommo", entidade_id: leadId, acao: "suprimido_loop", detalhe: dec.motivo });
    return Response.json({ ok: true, dry, suprimido: dec.motivo });
  }
  const chave = `CNN_AGENDAR:${leadId}:${ts}`;
  if (dry) return Response.json({ ok: true, dry: true, enfileiraria: "CNN_AGENDAR" });
  await purgarGemeoFeito(chave, env); // achado A: libera re-disparo legítimo (cancelar+reagendar mesmo horário)
  await filaEnfileirarLote([{
    chave, tipo: "CNN_AGENDAR", paciente_id_cnn: String(pid), grupo: "B",
    payload: { leadId, pid: String(pid), ts, tipoNome, procIds },
  }], env);
  return Response.json({ ok: true, enfileirado: "CNN_AGENDAR" });
}

// ── C1: Lembrete D-1 — roda às 15h BRT (18h UTC) ────────────────────────────
// Move leads com consulta amanhã de "Consulta Agendada" para "Confirmação de Consulta".
//
// NOTA: o filtro server-side filter[cf][AGENDAMENTO][from/to] é IGNORADO pelo
// Kommo (retorna todos os leads do status, capado pelo limit). Por isso aqui
// PAGINAMOS todos os leads da etapa e filtramos a data NO CÓDIGO.
async function selectLeadsLembreteD1(
  env: Env
): Promise<{ amanha: string; toMove: Array<{ id: number; nome: string; agendamento_ts: number }>; totalScaneado: number }> {
  const fields = await resolveFields(env);
  const fAgendamento = fields["AGENDAMENTO"];
  const fIdAgenda    = fields["ID Agenda CNN"];
  const fIdPaciente  = fields["ID Paciente CNN"];
  const amanha = tomorrowBRT();
  const toMove: Array<{ id: number; nome: string; agendamento_ts: number }> = [];
  let totalScaneado = 0;
  if (!fAgendamento || !fIdAgenda || !fIdPaciente) return { amanha, toMove, totalScaneado };

  // Sintaxe CORRETA de filtro do Kommo v4: filter[statuses][0][pipeline_id]+[status_id].
  // (O antigo filter[status_id]=X é silenciosamente IGNORADO e retorna a conta inteira.)
  const filtro = `filter[statuses][0][pipeline_id]=${PIPELINE_CAPTACAO}&filter[statuses][0][status_id]=${STAGE_CONSULTA_AGENDADA}`;
  let page = 1;
  while (true) {
    let resp: any;
    try {
      resp = await kommoGet(`/leads?${filtro}&limit=250&page=${page}`, env);
    } catch { break; }
    const leads = resp._embedded?.leads ?? [];
    if (leads.length === 0) break;
    totalScaneado += leads.length;
    for (const lead of leads) {
      // Guarda de etapa em código — não confia só no filtro server-side.
      if (lead.status_id !== STAGE_CONSULTA_AGENDADA) continue;
      const agendamentoTs = Number(getFieldValue(lead, fAgendamento) ?? 0);
      if (!agendamentoTs) continue;
      if (unixToDateBRT(agendamentoTs).data !== amanha) continue;
      if (!getFieldValue(lead, fIdAgenda)) continue;
      if (!getFieldValue(lead, fIdPaciente)) continue;
      toMove.push({ id: lead.id, nome: lead.name, agendamento_ts: agendamentoTs });
    }
    if (leads.length < 250) break;
    page++;
  }
  return { amanha, toMove, totalScaneado };
}

// ── A2: Loop Kommo→CNN (delta por cursor updated_at) ──────────────────────────
// Só leads editados desde o último cursor. Se a data do AGENDAMENTO divergir do
// estado salvo (agenda_sync) → empurra pro CNN via /remarcar. Baseline na 1ª vez
// que vê uma agenda (não remarca), o que suprime eco de mudanças feitas pelo Worker.
async function syncKommoParaCnn(env: Env, dryRun = false): Promise<any> {
  await ensureSchema(env);
  const fields = await resolveFields(env);
  const fAgendamento = fields["AGENDAMENTO"];
  const fIdAgenda    = fields["ID Agenda CNN"];
  const fIdPaciente  = fields["ID Paciente CNN"];
  if (!fAgendamento || !fIdAgenda) return { erro: "campos não resolvidos" };

  const cursorStr = await getCursor("kommo_updated_at", env);
  const cursor = cursorStr ? Number(cursorStr) : Math.floor(Date.now() / 1000) - 3600;
  let maxUpdated = cursor;
  const out: any = { dryRun, cursor, processados: 0, baselines: 0, remarcar: [] as any[], remarcados: 0 };

  let page = 1;
  while (true) {
    let resp: any;
    try { resp = await kommoGet(`/leads?filter[updated_at][from]=${cursor}&limit=250&page=${page}`, env); }
    catch { break; }
    const leads = resp._embedded?.leads ?? [];
    if (leads.length === 0) break;
    for (const lead of leads) {
      out.processados++;
      if ((lead.updated_at ?? 0) > maxUpdated) maxUpdated = lead.updated_at;
      const idAgenda = getFieldValue(lead, fIdAgenda);
      const kommoTs = Number(getFieldValue(lead, fAgendamento) ?? 0);
      if (!idAgenda || !kommoTs) continue;

      const estado: any = await getAgendaSync(String(idAgenda), env);
      const lastTs = estado?.last_agendamento_ts ?? null;
      const pacienteId = String(getFieldValue(lead, fIdPaciente) ?? estado?.paciente_id_cnn ?? "");

      if (lastTs === null) {
        // 1ª vez que vemos esta agenda → baseline, sem remarcar
        out.baselines++;
        if (!dryRun) await upsertAgendaSync({
          agenda_id_cnn: String(idAgenda), lead_id_kommo: String(lead.id),
          paciente_id_cnn: pacienteId, last_agendamento_ts: kommoTs, last_cnn_status: estado?.last_cnn_status ?? "",
        }, env);
        continue;
      }
      if (Math.abs(kommoTs - lastTs) <= 60) continue; // nada mudou

      // Data mudou na Kommo → empurra pro CNN
      const { data: novaData, hora: novaHora } = unixToDateBRT(kommoTs);
      const horaFim = addMinutes(novaHora, 30);
      out.remarcar.push({ lead_id: lead.id, agenda_id: idAgenda, de_ts: lastTs, para: `${novaData} ${novaHora}` });
      if (!dryRun) {
        try {
          await cnnPost(`/agenda/${idAgenda}/remarcar`, {
            novaData, novoHorarioInicial: `${novaHora}:00`, novoHorarioFinal: `${horaFim}:00`,
          }, env);
          await upsertAgendaSync({
            agenda_id_cnn: String(idAgenda), lead_id_kommo: String(lead.id),
            paciente_id_cnn: pacienteId, last_agendamento_ts: kommoTs, last_cnn_status: estado?.last_cnn_status ?? "",
          }, env);
          out.remarcados++;
        } catch (e) { out.remarcar[out.remarcar.length - 1].erro = String(e); }
      }
    }
    if (leads.length < 250) break;
    page++;
  }
  // Avança cursor com margem de 120s pra não perder edições na borda
  if (!dryRun) await setCursor("kommo_updated_at", String(Math.max(cursor, maxUpdated - 120)), env);
  out.novo_cursor = Math.max(cursor, maxUpdated - 120);
  return out;
}

// ── A3: Loop CNN→Kommo (dirigido pela janela de agendas do CNN) ───────────────
// Lista agendas do CNN na janela; para cada uma acha o lead (agenda_sync → telefone)
// e reflete mudanças de status/hora na Kommo. Baseline na 1ª vez (registra estado,
// reconcilia só a HORA; NÃO move etapa) → age só em transições de status (§7.2).
async function syncCnnParaKommo(env: Env, dryRun = false, target: CnnTarget = "sandbox", budget = 45, windowDays = 90): Promise<any> {
  await ensureSchema(env);
  const fields = await resolveFields(env);
  const fAgendamento = fields["AGENDAMENTO"];
  const fIdAgenda    = fields["ID Agenda CNN"];
  if (!fAgendamento || !fIdAgenda) return { erro: "campos não resolvidos" };
  const tiposMap = await resolveTiposConsulta(env, target);

  const ini = new Date(Date.now() - 3 * 3600 * 1000 - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const fim = new Date(Date.now() - 3 * 3600 * 1000 + windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const cursorKey = `a3_offset_${windowDays}`;
  const out: any = { dryRun, target, budget, windowDays, janela: `${ini}..${fim}`, agendas: 0, baselines: 0, pulados_tipo: 0, pulados_interno: 0, adiados: 0, offset_ini: 0, offset_fim: 0, acoes: [] as any[] };

  // 1. Coleta a janela inteira (CNN reads, baratos)
  const todas: any[] = [];
  let pag = 0, totalPag = 1;
  while (pag < totalPag) {
    let resp: any;
    try { resp = await cnnGet(`/agenda/lista?dataInicial=${ini}&dataFinal=${fim}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch { break; }
    totalPag = Math.max(resp?.totalPaginas ?? 1, 1);
    pag++;
    for (const a of (resp?.lista ?? [])) todas.push(a);
  }
  out.agendas = todas.length;

  // 2. Processa em ETAPAS a partir do cursor de offset, dentro do orçamento de fetch
  const offsetIni = Math.min(Number((await getCursor(cursorKey, env)) ?? "0"), todas.length);
  out.offset_ini = offsetIni;
  let idx = offsetIni;
  for (; idx < todas.length; idx++) {
    const agenda = todas[idx];
    try {
      const agendaId = String(agenda.id);
      const status: string = agenda.status ?? "";
      const cnnTs = (agenda.data && agenda.horaInicio) ? brtToUnix(agenda.data, (agenda.horaInicio).slice(0, 5)) : 0;
      const telefone = normalizePhone(agenda.telefoneCelularPaciente ?? "");
      const pacienteId = String(agenda.idPaciente ?? "");

      // Filtros baratos (sem fetch) primeiro → avançam o offset naturalmente
      if (isTarefaInterna(agenda)) { out.pulados_interno++; continue; }
      const grupo = grupoDaAgenda(agenda, tiposMap);
      if (!grupo) { out.pulados_tipo++; continue; }

      // Daqui pra frente pode haver fetch → respeita o orçamento (para e retoma neste offset)
      if (!orcamentoOk(budget)) { out.adiados++; break; }

      // 1. Achar o lead: agenda_sync → telefone
      const est: any = await getAgendaSync(agendaId, env);
      let leadId: string | null = est?.lead_id_kommo ?? null;
      if (!leadId && telefone.length >= 8) {
        try {
          const telKey = phoneKey(telefone);
          const kr = await kommoGet(`/contacts?query=${encodeURIComponent(telefone.slice(-8))}&with=leads`, env);
          const contact = (kr._embedded?.contacts ?? []).find((c: any) =>
            (c.custom_fields_values ?? []).filter((f: any) => f.field_code === "PHONE")
              .flatMap((f: any) => f.values.map((v: any) => normalizePhone(v.value)))
              .some((p: string) => phoneKey(p) === telKey));
          const lid = contact?._embedded?.leads?.[0]?.id;
          if (lid) leadId = String(lid);
        } catch { /* sem match */ }
      }
      if (!leadId) { continue; } // sem lead → Função 5 (A4) cuida da criação

      // 2. Baseline na 1ª vez: reconcilia hora, registra estado, NÃO move etapa
      if (est === null) {
        out.baselines++;
        if (!dryRun) {
          if (cnnTs) await setAgendamento(leadId, cnnTs, fAgendamento, env);
          await upsertAgendaSync({ agenda_id_cnn: agendaId, lead_id_kommo: leadId, paciente_id_cnn: pacienteId, last_agendamento_ts: cnnTs, last_cnn_status: status }, env);
          if (telefone) await upsertMapeamento({ paciente_id_cnn: pacienteId, grupo, lead_id_kommo: leadId, telefone_norm: telefone.slice(-11) }, env);
        }
        continue;
      }

      const lastTs = est.last_agendamento_ts ?? null;
      const lastStatus = est.last_cnn_status ?? null;
      const acao: any = { agenda: agendaId, lead: leadId };
      let mudou = false;

      // 3. Hora mudou no CNN (CNN prevalece) → atualiza Kommo (+ reset se em confirmação)
      if (cnnTs && lastTs !== null && Math.abs(cnnTs - lastTs) > 60) {
        acao.hora = `${lastTs} → ${cnnTs}`; mudou = true;
        if (!dryRun) {
          let etapa = 0;
          try { etapa = (await kommoGet(`/leads/${leadId}`, env)).status_id; } catch { /* ignore */ }
          // Remarcação durante a véspera → volta o lead pra etapa-base do grupo
          if (etapa === ETAPA_CONFIRMACAO[grupo]) await moveLeadToStage(leadId, ETAPA_BASE[grupo], env, pipelineDoGrupo(grupo));
          await setAgendamento(leadId, cnnTs, fAgendamento, env);
        }
      }

      // 4. Status mudou no CNN → move etapa pelo grupo (só em transição)
      const etapaDestino = destinoStatus(grupo, status);
      if (status && status !== lastStatus && etapaDestino != null) {
        acao.status = `${lastStatus} → ${status}`; acao.grupo = grupo;
        acao.move = STAGE_NOME[etapaDestino] ?? String(etapaDestino); mudou = true;
        if (!dryRun) await moveLeadToStage(leadId, etapaDestino, env, pipelineDoGrupo(grupo));
      }

      // Sempre atualiza o estado (mesmo em status não-mapeado), pra não deixar baseline velho
      if (!dryRun) await upsertAgendaSync({ agenda_id_cnn: agendaId, lead_id_kommo: leadId, paciente_id_cnn: pacienteId || est.paciente_id_cnn, last_agendamento_ts: cnnTs || lastTs, last_cnn_status: status }, env);
      if (mudou) out.acoes.push(acao);
      } catch (e) { out.acoes.push({ agenda: String(agenda.id), erro: String(e) }); }
  }
  const novoOffset = idx >= todas.length ? 0 : idx;
  out.offset_fim = novoOffset;
  out.sweep_completo = idx >= todas.length;
  if (!dryRun) await setCursor(cursorKey, String(novoOffset), env);
  return out;
}

// ── A4: Função 5 — backfill de cadastros CNN→Kommo (orientado a atividade) ────
// Dirigido pela janela de agendas. Para cada paciente: vincula se já há lead na
// Kommo; cria o card se não houver. Trava de ano (≥2026), anti-ressurreição
// (paciente já no mapeamento nunca é recriado), soTeste restringe escrita à allowlist.
const ANO_PISO = 2026;
async function backfillCadastros(env: Env, dryRun = true, soTeste = true, target: CnnTarget = "sandbox", budget = 45, windowDays = 90): Promise<any> {
  await ensureSchema(env);
  const fields = await resolveFields(env);
  const fAgendamento = fields["AGENDAMENTO"];
  const fIdAgenda    = fields["ID Agenda CNN"];
  const fIdPaciente  = fields["ID Paciente CNN"];
  if (!fAgendamento || !fIdAgenda || !fIdPaciente) return { erro: "campos não resolvidos" };
  const tiposMap = await resolveTiposConsulta(env, target);

  const ini = new Date(Date.now() - 3 * 3600 * 1000 - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const fim = new Date(Date.now() - 3 * 3600 * 1000 + windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const cursorKey = `a4_offset_${windowDays}`;
  const out: any = { dryRun, soTeste, target, budget, windowDays, janela: `${ini}..${fim}`, agendas: 0, criar: [] as any[], criados: 0, vinculados: 0, pulados_ano: 0, pulados_tipo: 0, adiados: 0, offset_ini: 0, offset_fim: 0 };

  // 1. Coleta todas as agendas da janela (CNN reads, baratos)
  const todas: any[] = [];
  let pag = 0, totalPag = 1;
  while (pag < totalPag) {
    let resp: any;
    try { resp = await cnnGet(`/agenda/lista?dataInicial=${ini}&dataFinal=${fim}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch { break; }
    totalPag = Math.max(resp?.totalPaginas ?? 1, 1);
    pag++;
    for (const a of (resp?.lista ?? [])) todas.push(a);
  }

  // 2. Resolve grupo e ORDENA Grupo B antes de A (desempate por paciente: B ganha)
  out.pulados_interno = 0;
  const comGrupo: Array<{ a: any; g: "A" | "B" }> = [];
  for (const a of todas) {
    if (isTarefaInterna(a)) { out.pulados_interno++; continue; } // bloqueio/pausa/acompanhar
    const g = grupoDaAgenda(a, tiposMap);
    if (!g) { out.pulados_tipo++; continue; }
    comGrupo.push({ a, g });
  }
  comGrupo.sort((x, y) => (x.g === "B" ? 0 : 1) - (y.g === "B" ? 0 : 1));
  out.agendas = todas.length;

  // 3. Processa em ETAPAS: começa do cursor (offset na lista B-first), gasta o
  // orçamento de fetch e salva onde parou. Próximo tick continua daí; ao fim, zera.
  // Desempate B-ganha sobrevive entre ticks: B's têm offset menor (processados antes)
  // e o mapeamento persistente impede o A do mesmo paciente de recriar.
  const offsetIni = Math.min(Number((await getCursor(cursorKey, env)) ?? "0"), comGrupo.length);
  out.offset_ini = offsetIni;
  const vistos = new Set<string>();
  let idx = offsetIni;
  for (; idx < comGrupo.length; idx++) {
    const { a: agenda, g: grupo } = comGrupo[idx];
    try {
      const pacienteId = String(agenda.idPaciente ?? "");
      if (!pacienteId || vistos.has(pacienteId)) continue;
      const ano = Number((agenda.data ?? "").slice(0, 4));
      if (ano && ano < ANO_PISO) { out.pulados_ano++; continue; }

      // Anti-ressurreição: paciente já mapeado NESTE grupo → nunca recria
      const mapeado: any = await getMapeamento(pacienteId, grupo, env);
      if (mapeado?.lead_id_kommo) { vistos.add(pacienteId); continue; }

      const telefone = normalizePhone(agenda.telefoneCelularPaciente ?? "");
      if (telefone.length < 8) continue;
      if (soTeste && !isTestePhone(telefone)) continue;

      // Orçamento de fetch esgotado → para aqui e retoma neste offset no próximo tick
      if (!orcamentoOk(budget)) { out.adiados++; break; }
      vistos.add(pacienteId); // commit: 1 card por paciente nesta run (B venceu na ordenação)
      const cnnTs = (agenda.data && agenda.horaInicio) ? brtToUnix(agenda.data, (agenda.horaInicio).slice(0, 5)) : 0;

      const telKey = phoneKey(telefone);
      let contatos: any[] = [];
      try {
        const kr = await kommoGet(`/contacts?query=${encodeURIComponent(telefone.slice(-8))}&with=leads`, env);
        contatos = (kr._embedded?.contacts ?? []).filter((c: any) =>
          (c.custom_fields_values ?? []).filter((f: any) => f.field_code === "PHONE")
            .flatMap((f: any) => f.values.map((v: any) => normalizePhone(v.value)))
            .some((p: string) => phoneKey(p) === telKey));
      } catch { /* sem match */ }

      const leadExistente = contatos[0]?._embedded?.leads?.[0]?.id;
      if (leadExistente) {
        out.vinculados++;
        if (!dryRun) await upsertMapeamento({ paciente_id_cnn: pacienteId, grupo, lead_id_kommo: String(leadExistente), telefone_norm: phoneKey(telefone), duplicata: contatos.length > 1 }, env);
        continue;
      }

      // Sem lead → CRIA card no pipeline do grupo (A: Consulta Agendada / B: Cliente Ativo)
      const nomeResolvido = await cnnPacienteNome(pacienteId, env, target);
      const nome = nomeResolvido ?? `Paciente CNN ${pacienteId}`;
      out.criar.push({ paciente: pacienteId, nome, telefone: telefone.slice(-11), grupo });
      if (!dryRun) {
        const criado: any = await kommoPost("/leads/complex", [{
          name: nome, pipeline_id: pipelineDoGrupo(grupo), status_id: ETAPA_BASE[grupo],
          custom_fields_values: [
            { field_id: fAgendamento, values: [{ value: cnnTs }] },
            { field_id: fIdAgenda, values: [{ value: String(agenda.id) }] },
            { field_id: fIdPaciente, values: [{ value: pacienteId }] },
          ],
          _embedded: { contacts: [{ name: nome, custom_fields_values: [{ field_code: "PHONE", values: [{ value: telefone, enum_code: "WORK" }] }] }] },
        }], env);
        const leadId = criado?.[0]?.id;
        if (leadId) {
          await upsertMapeamento({ paciente_id_cnn: pacienteId, grupo, lead_id_kommo: String(leadId), telefone_norm: phoneKey(telefone) }, env);
          await upsertAgendaSync({ agenda_id_cnn: String(agenda.id), lead_id_kommo: String(leadId), paciente_id_cnn: pacienteId, last_agendamento_ts: cnnTs, last_cnn_status: agenda.status ?? "" }, env);
          out.criados++;
        }
      }
    } catch (e) { out.criar.push({ agenda: String(agenda.id), erro: String(e) }); }
  }
  // Cursor: se varreu até o fim, zera (recomeça o sweep); senão salva onde parou.
  const novoOffset = idx >= comGrupo.length ? 0 : idx;
  out.offset_fim = novoOffset;
  out.sweep_completo = idx >= comGrupo.length;
  if (!dryRun) await setCursor(cursorKey, String(novoOffset), env);
  return out;
}

// ══ FILA: Produtor A4 (backfill) ══════════════════════════════════════════════
// Enfileira 1 item por paciente NÃO-mapeado da janela. Desempate B-ganha resolvido
// AQUI (escolhe o grupo vencedor por paciente antes de enfileirar). Idempotente:
// `chave` UNIQUE (A4:pac:<id>) → reprodutor não duplica. Gasta só fetch de paginação.
async function produtorBackfill(env: Env, target: CnnTarget, windowDays: number, soTeste: boolean): Promise<any> {
  await ensureSchema(env);
  const tiposMap = await resolveTiposConsulta(env, target);
  const ini = new Date(Date.now() - 3 * 3600 * 1000 - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const fim = new Date(Date.now() - 3 * 3600 * 1000 + windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const out: any = { fase: "produtor", target, windowDays, agendas: 0, candidatos: 0, enfileirados: 0, ja_na_fila: 0, pulados_interno: 0, pulados_tipo: 0, pulados_ano: 0, pulados_mapeado: 0 };

  // 1. Coleta a janela (fetch só de paginação)
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

  // 2. Por paciente: escolhe grupo vencedor (B-first) + 1 agenda representativa
  const porPaciente = new Map<string, { grupo: "A" | "B"; agenda: any; telefone: string }>();
  for (const a of todas) {
    if (isTarefaInterna(a)) { out.pulados_interno++; continue; }
    const g = grupoDaAgenda(a, tiposMap);
    if (!g) { out.pulados_tipo++; continue; }
    const ano = Number((a.data ?? "").slice(0, 4));
    if (ano && ano < ANO_PISO) { out.pulados_ano++; continue; }
    const pid = String(a.idPaciente ?? "");
    const tel = normalizePhone(a.telefoneCelularPaciente ?? "");
    if (!pid || tel.length < 8) continue;
    if (soTeste && !isTestePhone(tel)) continue;
    const existe = porPaciente.get(pid);
    // B vence A; entre iguais, mantém o primeiro
    if (!existe || (existe.grupo === "A" && g === "B")) porPaciente.set(pid, { grupo: g, agenda: a, telefone: tel });
  }

  // 3. Enfileira os não-mapeados (anti-ressurreição: pula quem já tem lead).
  //    Set de mapeados em 1 query + inserts em lote (DB.batch) → evita N round-trips D1.
  const mapeados = await getMapeamentoIdSet(env);
  const aEnfileirar: any[] = [];
  for (const [pid, info] of porPaciente) {
    out.candidatos++;
    // stopgap key-correto: Set é "pac|grupo" agora — Tasks 2-4 reescrevem este loop (duplicata-aware)
    if (mapeados.has(mapeamentoKey(pid, info.grupo))) { out.pulados_mapeado++; continue; }
    const cnnTs = (info.agenda.data && info.agenda.horaInicio) ? brtToUnix(info.agenda.data, info.agenda.horaInicio.slice(0, 5)) : 0;
    aEnfileirar.push({
      chave: `A4:pac:${pid}`, tipo: "A4", agenda_id_cnn: String(info.agenda.id), paciente_id_cnn: pid, grupo: info.grupo,
      payload: { telefone: info.telefone, cnnTs, status: info.agenda.status ?? "" },
    });
  }
  const filaAntes = (await filaStats(env)).pendente ?? 0;
  if (aEnfileirar.length) await filaEnfileirarLote(aEnfileirar, env);
  const filaDepois = (await filaStats(env)).pendente ?? 0;
  out.enfileirados = filaDepois - filaAntes;     // novos de fato (UNIQUE ignora dups)
  out.ja_na_fila = aEnfileirar.length - out.enfileirados;
  return out;
}

// ── Helper compartilhado: acha o lead de um telefone FILTRADO pela pipeline do grupo ──
// Risco §10 / nota cross-task: o mesmo telefone pode ter 2 leads (Captação + Pós-Venda).
// NÃO pega `leads[0]` cego — escolhe o lead cuja pipeline_id casa com a do grupo.
// Retorna `contatos` (nº de contatos que casaram o telefone) p/ o flag de duplicata.
async function acharLeadPorTelefone(telefone: string, pipelineId: number, env: Env): Promise<{ leadId?: string; nome?: string; contatos: number }> {
  const telKey = phoneKey(telefone);
  let contatos: any[] = [];
  try {
    const kr = await kommoGet(`/contacts?query=${encodeURIComponent(telefone.slice(-8))}&with=leads`, env);
    contatos = (kr._embedded?.contacts ?? []).filter((c: any) =>
      (c.custom_fields_values ?? []).filter((f: any) => f.field_code === "PHONE")
        .flatMap((f: any) => f.values.map((v: any) => normalizePhone(v.value)))
        .some((p: string) => phoneKey(p) === telKey));
  } catch { /* sem match */ }
  // O embed `with=leads` traz só o id do lead — pipeline_id/name NÃO vêm. Busca os
  // leads por id em 1 fetch batelado (filter[id][]) p/ filtrar pela pipeline do grupo
  // (não pega leads[0] cego) e obter o name (renomeação da duplicata) sem GET por linha.
  const leadIds = [...new Set(contatos.flatMap((c: any) => (c._embedded?.leads ?? []).map((l: any) => String(l.id))))];
  let leadsFull: any[] = [];
  if (leadIds.length) {
    const q = leadIds.map((id) => `filter[id][]=${encodeURIComponent(id)}`).join("&");
    try {
      const lr = await kommoGet(`/leads?${q}&limit=250`, env);
      leadsFull = lr._embedded?.leads ?? [];
    } catch { /* sem resposta → sem match por pipeline */ }
  }
  const doGrupo = leadsFull.find((l: any) => Number(l.pipeline_id) === pipelineId);
  return { leadId: doGrupo?.id ? String(doGrupo.id) : undefined, nome: doGrupo?.name, contatos: contatos.length };
}

// ── A2: colisão de telefone (família) ─────────────────────────────────────────
// Quando um lead achado por telefone JÁ pertence a OUTRO paciente CNN (2+ pessoas no mesmo
// número → 1 card), NÃO dividimos o card (muito problema, pouco resultado — regra do dono
// 03/07): só marcamos o nome com " [Familia]" (1x, idempotente). Detecção via mapeamento
// (sem fetch extra). Best-effort: nunca quebra o vínculo.
async function marcarFamiliaSeColisao(leadId: string, pidNovo: string, nomeAtual: string | undefined, env: Env): Promise<void> {
  try {
    const jaDeOutro = await env.DB.prepare(
      `SELECT 1 FROM mapeamento WHERE lead_id_kommo=? AND paciente_id_cnn<>? LIMIT 1`
    ).bind(leadId, pidNovo).first();
    if (!jaDeOutro) return;
    const nome = String(nomeAtual ?? "");
    if (nome.includes("[Familia]")) return; // já marcado
    await kommoPatch(`/leads/${leadId}`, { name: `${nome} [Familia]`.trim() }, env);
    await audit(env, { funcao: "A2", ambiente: "kommo", entidade_id: leadId, acao: "colisao-familia", detalhe: `pac ${pidNovo} colide com outro no lead ${leadId} → [Familia]` });
  } catch { /* não quebra o vínculo */ }
}

// (Removido em 02/07: `acharLeadDoPaciente` — devolvia o card A primeiro, arrastando o card
//  errado no modelo de duplicata. O Reflexo de Orçamento agora usa `leadAlvoOrcamento`, que
//  escolhe o card pelo FUNIL da decisão. Ver consumirItemOrcamento.)

// ── A7: seleção PURA do card a ADOTAR (testável sem tocar Kommo) ──────────────
// De uma lista de leads (resposta do lookup), escolhe qual adotar: só os no pipeline do
// grupo E com custom field "ID Paciente CNN" == pid (match EXATO — `query` é substring,
// pode trazer falso-positivo). Prefere ATIVO (não 143/perdido); desempata pelo MENOR id.
function escolherCardAdotado(leads: any[], pid: string, pipelineId: number, fIdPaciente: number): string | undefined {
  const cand = (leads ?? []).filter((l: any) =>
    Number(l.pipeline_id) === pipelineId && String(getFieldValue(l, fIdPaciente) ?? "") === pid);
  if (!cand.length) return undefined;
  cand.sort((a: any, b: any) =>
    (Number(a.status_id) === STAGE_CANCELADA_PERDIDO ? 1 : 0) - (Number(b.status_id) === STAGE_CANCELADA_PERDIDO ? 1 : 0) ||
    Number(a.id) - Number(b.id));
  return String(cand[0].id);
}
// ── A7: lookup no Kommo por ID Paciente CNN (identidade forte), escopado ao grupo ─
// Fecha o residual "POST sucedeu, resposta perdida" (retryPost só evita o re-POST, não
// recupera o card órfão). ID Paciente CNN é identidade EXATA (telefone colide entre
// familiares). 1 subrequest (1 página; pid específico). Falha → undefined (cai no create).
async function acharLeadPorPacienteCnn(pid: string, grupo: "A" | "B", fields: Record<string, number>, env: Env): Promise<string | undefined> {
  const fIdPaciente = fields["ID Paciente CNN"];
  if (!fIdPaciente || !pid) return undefined;
  let leads: any[] = [];
  try {
    const r = await kommoGet(`/leads?query=${encodeURIComponent(pid)}&limit=250`, env);
    leads = r._embedded?.leads ?? [];
  } catch { return undefined; }
  return escolherCardAdotado(leads, pid, pipelineDoGrupo(grupo), fIdPaciente);
}

// ── Helper compartilhado: cria o card (POST /leads/complex) + persiste mapeamento+baseline ──
// Mesmo corpo usado pelo backfill (A4) e pelo sync (A3). `sufixo` (" (duplicata)") entra
// SÓ no nome do lead (o contato fica com o nome real do paciente). `etapa` permite criar
// já na etapa do status (sync); default = etapa-base do grupo (backfill).
// A7: antes de POSTar, ADOTA um card existente com o mesmo ID Paciente CNN no funil do grupo.
async function criarCardLead(
  p: { grupo: "A" | "B"; nome: string; telefone: string; cnnTs: number; agendaId: string; pid: string; sufixo?: string; etapa?: number; status?: string },
  env: Env, fields: Record<string, number>
): Promise<string | undefined> {
  const fAgendamento = fields["AGENDAMENTO"], fIdAgenda = fields["ID Agenda CNN"], fIdPaciente = fields["ID Paciente CNN"];

  // ── A7: ADOÇÃO anti-duplicata. Antes de POSTar, procura um card já existente com este
  // ID Paciente CNN NO FUNIL DO GRUPO. Se existir, adota (grava mapeamento + baseline) em vez
  // de criar 2º card. Fecha o residual "POST-sucedeu-mas-resposta-perdida" (A4 só evita o
  // re-POST; não recupera o card órfão). Escopo por pipeline: card A e card B do MESMO paciente
  // NÃO se adotam entre si (duplicata intencional 1-por-grupo).
  const adotado = await acharLeadPorPacienteCnn(p.pid, p.grupo, fields, env);
  if (adotado) {
    await upsertMapeamento({ paciente_id_cnn: p.pid, grupo: p.grupo, lead_id_kommo: adotado, telefone_norm: phoneKey(p.telefone), duplicata: !!p.sufixo }, env);
    if (p.agendaId) {
      await escreverVinculoCnn(adotado, String(p.agendaId), p.pid, p.cnnTs, fields, env);
      await upsertAgendaSync({ agenda_id_cnn: String(p.agendaId), lead_id_kommo: adotado, paciente_id_cnn: p.pid, last_agendamento_ts: p.cnnTs, last_cnn_status: p.status ?? "" }, env);
    }
    await audit(env, { funcao: "A7", ambiente: "kommo", entidade_id: adotado, acao: "adotado_por_pid", de: mapeamentoKey(p.pid, p.grupo), para: adotado, detalhe: `create suprimido; card com ID Paciente CNN=${p.pid} no funil ${p.grupo}` });
    return adotado;
  }

  const leadName = p.nome + (p.sufixo ?? "");
  // Card SEM agenda (ex.: card B criado pelo ORC no APROVADO — comprou mas não marcou procedimento):
  // não grava AGENDAMENTO (date=0 seria data inválida) nem ID Agenda CNN; só ID Paciente CNN.
  const cf: any[] = [{ field_id: fIdPaciente, values: [{ value: p.pid }] }];
  if (p.agendaId) {
    cf.unshift(
      { field_id: fAgendamento, values: [{ value: p.cnnTs }] },
      { field_id: fIdAgenda, values: [{ value: String(p.agendaId) }] },
    );
  }
  const criado: any = await kommoPost("/leads/complex", [{
    name: leadName, pipeline_id: pipelineDoGrupo(p.grupo), status_id: p.etapa ?? ETAPA_BASE[p.grupo],
    custom_fields_values: cf,
    _embedded: { contacts: [{ name: p.nome, custom_fields_values: [{ field_code: "PHONE", values: [{ value: p.telefone, enum_code: "WORK" }] }] }] },
  }], env);
  const leadId = criado?.[0]?.id ? String(criado[0].id) : undefined;
  if (leadId) {
    await upsertMapeamento({ paciente_id_cnn: p.pid, grupo: p.grupo, lead_id_kommo: leadId, telefone_norm: phoneKey(p.telefone), duplicata: !!p.sufixo }, env);
    // Só registra baseline de agenda se HÁ agenda (senão criaria linha agenda_sync com id vazio,
    // colidindo entre pacientes na PK agenda_id_cnn='').
    if (p.agendaId) await upsertAgendaSync({ agenda_id_cnn: String(p.agendaId), lead_id_kommo: leadId, paciente_id_cnn: p.pid, last_agendamento_ts: p.cnnTs, last_cnn_status: p.status ?? "" }, env);
  }
  return leadId;
}

// ══ FILA: Consumidor A4 — processa 1 item (vincular ou criar card) ═════════════
async function consumirItemA4(item: any, env: Env, target: CnnTarget, dryRun: boolean): Promise<{ r: string; leadId?: string; nome?: string }> {
  const fields = await resolveFields(env);
  const pid = String(item.paciente_id_cnn);
  const grupo = (item.grupo === "B" ? "B" : "A") as "A" | "B";
  const payload = item.payload ? JSON.parse(item.payload) : {};
  const telefone: string = payload.telefone ?? "";
  const cnnTs: number = payload.cnnTs ?? 0;

  // Anti-ressurreição (re-check no momento do consumo), por (paciente, grupo)
  const mapeado: any = await getMapeamento(pid, grupo, env);
  if (mapeado?.lead_id_kommo) return { r: "ja_mapeado", leadId: String(mapeado.lead_id_kommo) };

  // Lookup lead por telefone, FILTRADO pela pipeline do grupo (§7.1; não pega leads[0] cego)
  const achado = await acharLeadPorTelefone(telefone, pipelineDoGrupo(grupo), env);
  if (achado.leadId) {
    if (!dryRun) {
      await marcarFamiliaSeColisao(achado.leadId, pid, achado.nome, env); // A2: lead de outro paciente? → " [Familia]"
      // grava ID Agenda/Paciente CNN + AGENDAMENTO no card (antes ficava só no D1 → card sem IDs)
      await escreverVinculoCnn(achado.leadId, String(item.agenda_id_cnn), pid, cnnTs, fields, env);
      if (grupo === "A") await alinharCardA(achado.leadId, payload.status ?? "", env); // puxa A pra Consulta Agendada
      await upsertMapeamento({ paciente_id_cnn: pid, grupo, lead_id_kommo: achado.leadId, telefone_norm: phoneKey(telefone), duplicata: achado.contatos > 1 }, env);
    }
    return { r: "vinculado", leadId: achado.leadId };
  }

  // Sem lead → cria card no pipeline do grupo (etapa-base)
  const nome = (await cnnPacienteNome(pid, env, target)) ?? `Paciente CNN ${pid}`;
  let novoLeadId: string | undefined;
  if (!dryRun) {
    novoLeadId = await criarCardLead({ grupo, nome, telefone, cnnTs, agendaId: String(item.agenda_id_cnn), pid, status: payload.status ?? "" }, env, fields);
  }
  return { r: "criado", leadId: novoLeadId, nome };
}

// ══ FILA: Produtor A3 (sync CNN→Kommo) ════════════════════════════════════════
// Agrupa as agendas da janela por (paciente, grupo). Por grupo escolhe a agenda
// MAIS PRÓXIMA não-terminal ("vigente", §7) e enfileira 1 item de sync por (pac,grupo).
// Reconcilia órfãos A: (pac,"A") mapeado SEM agenda A vigente → enfileira a rota
// terminal (Perdido/Avaliação/etc.) — exceção FINALIZADO segue MAPA_STATUS (§4).
// Chave inclui status+ts da vigente → re-enfileira quando muda. Sem fetch além da
// paginação (usa mapas D1 carregados em massa).
async function produtorSync(env: Env, target: CnnTarget, windowDays: number, soPid?: string): Promise<any> {
  await ensureSchema(env);
  const tiposMap = await resolveTiposConsulta(env, target);
  const ini = new Date(Date.now() - 3 * 3600 * 1000 - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const fim = new Date(Date.now() - 3 * 3600 * 1000 + windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const out: any = { fase: "produtor-sync", target, windowDays, agendas: 0, enfileirados: 0, ja_na_fila: 0, sem_mudanca: 0, pulados_interno: 0, pulados_tipo: 0, sync_a: 0, sync_b: 0, orfaos_a: 0 };

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
  // A1a: coleta só é confiável se drenou TODAS as páginas (cinto-e-suspensório com o flag).
  coletaCompleta = coletaCompleta && pag >= totalPag;
  out.agendas = todas.length;
  out.coleta_completa = coletaCompleta;

  // 1. Agrupa por paciente → { A: agendas[], B: agendas[] } (normalizadas)
  type Ag = { id: string; status: string; ts: number; tel: string };
  const porPaciente = new Map<string, { A: Ag[]; B: Ag[] }>();
  for (const a of todas) {
    if (soPid && String(a.idPaciente ?? "") !== soPid) continue; // validação escopada ao paciente de teste (blast radius=1)
    if (isTarefaInterna(a)) { out.pulados_interno++; continue; }
    const grupo = grupoDaAgenda(a, tiposMap);
    if (!grupo) { out.pulados_tipo++; continue; }
    const pid = String(a.idPaciente ?? "");
    if (!pid) continue;
    const ag: Ag = {
      id: String(a.id), status: a.status ?? "",
      ts: (a.data && a.horaInicio) ? brtToUnix(a.data, a.horaInicio.slice(0, 5)) : 0,
      tel: normalizePhone(a.telefoneCelularPaciente ?? ""),
    };
    let p = porPaciente.get(pid);
    if (!p) { p = { A: [], B: [] }; porPaciente.set(pid, p); }
    p[grupo].push(ag);
  }

  // Mais-próximo (§7): entre as não-terminais do grupo, a mais IMINENTE relativa a agora.
  // A janela é −2/+14 (inclui passado), então NÃO basta o menor ts: uma A de ontem ainda
  // CONFIRMADA não pode vencer uma A real de +1d. Regra: a próxima FUTURA (menor ts ≥ agora);
  // se nenhuma futura, a passada mais RECENTE (maior ts). ts=0 (sem hora) nunca é "futura".
  const agora = Math.floor(Date.now() / 1000);
  const nearestVigente = (ags: Ag[]): Ag | null => {
    const elig = ags.filter((a) => !STATUS_TERMINAL.has(a.status));
    if (!elig.length) return null;
    const futuras = elig.filter((a) => a.ts >= agora).sort((x, y) => x.ts - y.ts);
    if (futuras.length) return futuras[0];
    const passadas = elig.filter((a) => a.ts > 0).sort((x, y) => y.ts - x.ts);
    return passadas[0] ?? elig[0]; // fallback: só agendas sem hora (ts=0)
  };

  const agSync = await getAgendaSyncMap(env);
  const mapLead = await getMapeamentoLeadMap(env);
  const aEnfileirar: any[] = [];
  const chavesSyncMudou: string[] = [];   // A3-REVERSÃO: chaves de sync que passaram no gate `mudou`
  const comVigenteA = new Set<string>();

  // 2. Por (paciente, grupo): enfileira sync da agenda vigente (cria card se faltar).
  const enfileirarSync = (pid: string, grupo: "A" | "B", vig: Ag, temOutro: boolean) => {
    const leadId = mapLead.get(mapeamentoKey(pid, grupo));
    const est = agSync.get(vig.id);
    const precisaCriar = !leadId;
    const mudou = !est || est.status !== vig.status || Math.abs((est.ts ?? 0) - vig.ts) > 60;
    if (!precisaCriar && !mudou) { out.sem_mudanca++; return; }
    if (grupo === "A") out.sync_a++; else out.sync_b++;
    const tsBucket = Math.floor(vig.ts / 60);
    const chave = `A3:sync:${pid}:${grupo}:${vig.id}:${vig.status}:${tsBucket}`;
    chavesSyncMudou.push(chave);   // gate `mudou` já garantiu MUDANÇA REAL → habilita purga do gêmeo 'feito' (reversão)
    aEnfileirar.push({
      chave, tipo: "A3",
      agenda_id_cnn: vig.id, paciente_id_cnn: pid, grupo,
      payload: { kind: "sync", leadId: leadId ?? null, status: vig.status, cnnTs: vig.ts, telefone: vig.tel, baseline: !est, temOutro },
    });
  };

  for (const [pid, p] of porPaciente) {
    const vigA = nearestVigente(p.A);
    const vigB = nearestVigente(p.B);
    const temB = mapLead.has(mapeamentoKey(pid, "B"));
    const hasB = temB || !!vigB;          // é/está virando cliente → o card A é duplicata
    if (vigB) enfileirarSync(pid, "B", vigB, false);
    if (vigA) { comVigenteA.add(pid); enfileirarSync(pid, "A", vigA, hasB); }
  }

  // 3. Reconciliação de órfãos A: (pac,"A") mapeado sem agenda A vigente.
  //    Rota = status da A mais RECENTE da janela via MAPA_STATUS (FINALIZADO→Avaliação,
  //    CANCELADO→Perdido, FALTOU→Primeiro Contato); A ausente da janela → Perdido (143).
  // GUARD A1a: coleta PARCIAL (página falhou/budget) → NÃO reconcilia órfãos (um paciente pode
  // ter a agenda vigente na página que não carregou + uma A terminal na que carregou → rebaixá-lo
  // seria INDEVIDO). Os órfãos reais são reconciliados no próximo tick completo. Os `sync` acima
  // (só avançam com base em agendas vistas, idempotentes) seguem normalmente.
  if (!coletaCompleta) out.orfaos_parcial_skip = true;
  for (const [chave, leadId] of mapLead) {
    if (!coletaCompleta) break; // A1a: pula reconciliação de órfãos sob coleta parcial
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

  // A3-REVERSÃO (fix): a chave A3:sync inclui o status, mas os VALORES de status recorrem
  // (agenda oscila entre poucos estados: AGENDADO⇄CONFIRMADO_PACIENTE). Quando o status volta
  // a um valor JÁ SINCRONIZADO, a chave nova é idêntica à de uma linha 'feito' antiga → INSERT
  // OR IGNORE descarta → o move-de-volta é perdido pra sempre. Esses itens já passaram no gate
  // `mudou` (MUDANÇA REAL vs agenda_sync) → purgamos o gêmeo RESOLVIDO ('feito') da MESMA chave
  // antes de reenfileirar. NÃO toca pendente/processing ("mesma mudança=1 item" intacto), NÃO
  // toca 'erro'/dead-letter (fica p/ requeue), NÃO toca órfãos. Lease B2 serializa produtor×dreno.
  if (chavesSyncMudou.length) {
    const CH = 50;
    for (let i = 0; i < chavesSyncMudou.length; i += CH) {
      const grp = chavesSyncMudou.slice(i, i + CH).map((ch) =>
        env.DB.prepare(`DELETE FROM fila_trabalho WHERE chave = ? AND status = 'feito'`).bind(ch));
      if (grp.length) await env.DB.batch(grp);
    }
  }
  const antes = (await filaStats(env)).pendente ?? 0;
  if (aEnfileirar.length) await filaEnfileirarLote(aEnfileirar, env);
  const depois = (await filaStats(env)).pendente ?? 0;
  out.enfileirados = depois - antes;
  out.ja_na_fila = aEnfileirar.length - out.enfileirados;
  return out;
}

// ══ FILA: Consumidor A3 — ciclo de vida do card por (paciente, grupo) ══════════
// Dois tipos de item:
//  • kind:"orphan" → A sem agenda vigente: move o card A pra rota terminal (Perdido/
//    Avaliação/...). Guarda anti-rebaixamento: não joga em Perdido quem já passou da
//    consulta (A finalizada fora da janela / virou só-B).
//  • kind:"sync"   → B/A vigente: garante o card (vincula por telefone FILTRADO pela
//    pipeline, ou cria — duplicata no Captação se o paciente também tem B) e reflete
//    hora/status da agenda mais próxima. B é pegajoso (MAPA_STATUS[*].B = Cliente Ativo).
async function consumirItemA3(item: any, env: Env, target: CnnTarget, dryRun: boolean): Promise<{ r: string; leadId?: string; nome?: string }> {
  const fields = await resolveFields(env);
  const fAgendamento = fields["AGENDAMENTO"];
  const agendaId = String(item.agenda_id_cnn ?? "");
  const pid = String(item.paciente_id_cnn);
  const grupo = (item.grupo === "B" ? "B" : "A") as "A" | "B";
  const payload = item.payload ? JSON.parse(item.payload) : {};

  // ── Órfão A: rota terminal pro card A sem agenda vigente ──
  if (payload.kind === "orphan") {
    const leadId: string = payload.leadId;
    const destino = Number(payload.destino);
    if (!leadId || !destino) return { r: "sem_lead" };
    let etapaAtual = 0;
    try { etapaAtual = Number((await kommoGet(`/leads/${leadId}`, env)).status_id) || 0; } catch { /* ignore */ }
    if (etapaAtual === destino) return { r: "sem_mudanca", leadId };
    // Catraca de mão-única DELIBERADA: nunca rebaixa pra Perdido um paciente já avaliado
    // (Avaliação Realizada/Tratamento Proposto). Evita demote de A finalizada fora da
    // janela quando virou só-B; e absorve de propósito o cancelamento de uma A NOVA num
    // card já avançado (não volta pra Perdido um cliente que já progrediu).
    if (destino === STAGE_CANCELADA_PERDIDO &&
        (etapaAtual === STAGE_AVALIACAO_REALIZADA || etapaAtual === STAGE_TRATAMENTO_PROPOSTO)) {
      return { r: "sem_mudanca", leadId };
    }
    if (!dryRun) await moveLeadToStage(leadId, destino, env, PIPELINE_CAPTACAO);
    return { r: "movido", leadId, nome: STAGE_NOME[destino] ?? String(destino) };
  }

  // ── Sync (B vigente / A vigente) ──
  const status: string = payload.status ?? "";
  const cnnTs: number = payload.cnnTs ?? 0;
  const telefone: string = payload.telefone ?? "";
  const temOutro: boolean = !!payload.temOutro;
  let leadId: string | null = payload.leadId ?? null;

  // Re-check do mapeamento (pode ter sido criado entre produtor e consumo)
  if (!leadId) {
    const m: any = await getMapeamento(pid, grupo, env);
    if (m?.lead_id_kommo) leadId = String(m.lead_id_kommo);
  }

  // Garante o card: vincula (telefone filtrado pela pipeline do grupo) ou cria.
  if (!leadId) {
    const sufixo = grupo === "A" && temOutro ? " (duplicata)" : undefined;
    if (telefone.length >= 8) {
      const achado = await acharLeadPorTelefone(telefone, pipelineDoGrupo(grupo), env);
      if (achado.leadId) {
        leadId = achado.leadId;
        if (!dryRun) {
          await marcarFamiliaSeColisao(leadId, pid, achado.nome, env); // A2: lead de outro paciente? → " [Familia]"
          await escreverVinculoCnn(leadId, agendaId, pid, cnnTs, fields, env); // grava IDs no card ao vincular
          await upsertMapeamento({ paciente_id_cnn: pid, grupo, lead_id_kommo: leadId, telefone_norm: phoneKey(telefone), duplicata: !!sufixo }, env);
          // Invariante §5: card A de cliente (A+B) leva " (duplicata)" no nome. Append-if-absent
          // (idempotente; nunca clobbera nome editado à mão nem duplica o sufixo).
          if (sufixo && achado.nome != null && !achado.nome.endsWith(sufixo)) {
            await kommoPatch(`/leads/${leadId}`, { name: achado.nome + sufixo }, env);
          }
        }
      }
    }
    if (!leadId) {
      // Sem card → cria no funil do grupo, já na etapa do status (duplicata no Captação se A+B)
      const nome = (await cnnPacienteNome(pid, env, target)) ?? `Paciente CNN ${pid}`;
      const etapa = destinoStatus(grupo, status) ?? ETAPA_BASE[grupo];
      if (!dryRun) {
        const novo = await criarCardLead({ grupo, nome, telefone, cnnTs, agendaId, pid, sufixo, etapa, status }, env, fields);
        // 2xx sem id: NÃO marca a chave como feita (o UNIQUE/INSERT-OR-IGNORE travaria pra
        // sempre). Lança → consumirFila trata como retryável (tentativas++), igual a um erro.
        if (!novo) throw new Error(`criarCardLead sem id (pac ${pid} grupo ${grupo})`);
        leadId = novo;
      }
      return { r: "criado", leadId: leadId ?? undefined, nome: nome + (sufixo ?? "") };
    }
  }

  // ── leadId garantido: baseline ou sync de hora/status pela agenda vigente ──
  const est: any = agendaId ? await getAgendaSync(agendaId, env) : null;

  // Baseline na 1ª vez: reconcilia hora, registra estado, NÃO move etapa (anti-eco)
  if (est === null || payload.baseline) {
    if (!dryRun) {
      await escreverVinculoCnn(leadId, agendaId, pid, cnnTs, fields, env); // IDs + AGENDAMENTO (antes só AGENDAMENTO)
      if (grupo === "A") await alinharCardA(leadId, status, env); // puxa pra Consulta Agendada se estava atrás
      await upsertAgendaSync({ agenda_id_cnn: agendaId, lead_id_kommo: leadId, paciente_id_cnn: pid, last_agendamento_ts: cnnTs, last_cnn_status: status }, env);
    }
    return { r: "baseline", leadId };
  }

  const lastTs = est.last_agendamento_ts ?? null;
  const lastStatus = est.last_cnn_status ?? null;
  let movido = false; let etapaNome: string | undefined;

  // Hora mudou (CNN prevalece) → atualiza Kommo (+ reset se estava em confirmação)
  if (cnnTs && lastTs !== null && Math.abs(cnnTs - lastTs) > 60 && !dryRun) {
    let etapa = 0;
    try { etapa = (await kommoGet(`/leads/${leadId}`, env)).status_id; } catch { /* ignore */ }
    if (etapa === ETAPA_CONFIRMACAO[grupo]) await moveLeadToStage(leadId, ETAPA_BASE[grupo], env, pipelineDoGrupo(grupo));
    await setAgendamento(leadId, cnnTs, fAgendamento, env);
  }

  // Status mudou → move etapa pelo grupo (só em transição). B: MAPA_STATUS sempre
  // Cliente Ativo (pegajoso por design); A: etapa do status.
  const etapaDestino = destinoStatus(grupo, status);
  if (status && status !== lastStatus && etapaDestino != null) {
    etapaNome = STAGE_NOME[etapaDestino] ?? String(etapaDestino);
    if (!dryRun) await moveLeadToStage(leadId, etapaDestino, env, pipelineDoGrupo(grupo));
    movido = true;
  }

  if (!dryRun) await upsertAgendaSync({ agenda_id_cnn: agendaId, lead_id_kommo: leadId, paciente_id_cnn: pid, last_agendamento_ts: cnnTs || lastTs, last_cnn_status: status }, env);
  return movido ? { r: "movido", leadId, nome: etapaNome } : { r: "sem_mudanca", leadId };
}

// ══ FILA: Produtor F2 (véspera) ═══════════════════════════════════════════════
// Enfileira leads (mapeados) com consulta AMANHÃ, status não-terminal, dedup B-first
// por lead, que ainda não receberam lembrete hoje (lembrete_d1). Idempotente.
async function produtorVespera(env: Env, target: CnnTarget, dataAlvo?: string, soPid?: string): Promise<any> {
  await ensureSchema(env);
  const tiposMap = await resolveTiposConsulta(env, target);
  const amanha = dataAlvo ?? tomorrowBRT();
  const out: any = { fase: "produtor-vespera", target, dataAlvo: amanha, agendas: 0, enfileirados: 0, ja_na_fila: 0, pulados_interno: 0, pulados_tipo: 0, pulados_status: 0, nao_mapeado: 0, ja_lembrado: 0 };

  const todas: any[] = [];
  let pag = 0, totalPag = 1;
  while (pag < totalPag) {
    let r: any;
    try { r = await cnnGet(`/agenda/lista?dataInicial=${amanha}&dataFinal=${amanha}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch { break; }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
    for (const a of (r?.lista ?? [])) todas.push(a);
  }
  out.agendas = todas.length;

  const agSync = await getAgendaSyncMap(env);
  const mapLead = await getMapeamentoLeadMap(env);
  // Anti-spam (§6): agrupa por PACIENTE → quais grupos têm agenda no dia-alvo (a 1ª de cada
  // grupo = mais próxima, lista vem ordenada por hora). A+B no MESMO dia → confirma só o card
  // de Captação (A) → 1 WhatsApp (o de Pós-Venda fica Cliente Ativo). Dias diferentes cada
  // card cai numa execução de véspera diferente, então naturalmente confirma o seu.
  const porPac = new Map<string, { A?: string; B?: string }>(); // pid → agendaId por grupo
  for (const a of todas) {
    if (a.data !== amanha) continue;
    if (isTarefaInterna(a)) { out.pulados_interno++; continue; }
    if (STATUS_TERMINAL.has(a.status ?? "")) { out.pulados_status++; continue; }
    const grupo = grupoDaAgenda(a, tiposMap);
    if (!grupo) { out.pulados_tipo++; continue; }
    const pid = String(a.idPaciente ?? "");
    if (!pid) continue;
    const p = porPac.get(pid) ?? {};
    if (!p[grupo]) p[grupo] = String(a.id);
    porPac.set(pid, p);
  }

  const aEnfileirar: any[] = [];
  for (const [pid, grupos] of porPac) {
    if (soPid && pid !== soPid) continue; // validação escopada: só o paciente de teste (blast radius = 1)
    const alvos: Array<"A" | "B"> = grupos.A ? ["A"] : ["B"]; // A vence no mesmo dia (anti-spam); senão o grupo presente
    for (const g of alvos) {
      const agendaId = grupos[g]!;
      const leadId = agSync.get(agendaId)?.lead ?? mapLead.get(mapeamentoKey(pid, g));
      if (!leadId) { out.nao_mapeado++; continue; }
      if (await leadJaLembradoNaData(leadId, amanha, env)) { out.ja_lembrado++; continue; }
      aEnfileirar.push({
        chave: `F2:lead:${leadId}:${amanha}`, tipo: "F2", agenda_id_cnn: agendaId, paciente_id_cnn: pid, grupo: g,
        payload: { leadId, data: amanha },
      });
    }
  }
  const antes = (await filaStats(env)).pendente ?? 0;
  if (aEnfileirar.length) await filaEnfileirarLote(aEnfileirar, env);
  const depois = (await filaStats(env)).pendente ?? 0;
  out.enfileirados = depois - antes;
  out.ja_na_fila = aEnfileirar.length - out.enfileirados;
  return out;
}

// ══ FILA: Consumidor F2 — move 1 lead pra etapa de confirmação (idempotente) ═══
async function consumirItemF2(item: any, env: Env, target: CnnTarget, dryRun: boolean): Promise<{ r: string; leadId?: string; nome?: string }> {
  const payload = item.payload ? JSON.parse(item.payload) : {};
  const leadId: string = payload.leadId;
  const data: string = payload.data;
  const grupo = (item.grupo === "B" ? "B" : "A") as "A" | "B";
  if (!leadId) return { r: "sem_lead" };
  if (await leadJaLembradoNaData(leadId, data, env)) return { r: "sem_mudanca", leadId };
  // A2: card [Familia] (2+ pacientes CNN no MESMO lead = número compartilhado) NÃO vai pra
  // confirmação de véspera — evitaria disparar WhatsApp ambíguo pro número compartilhado. Fica
  // em Consulta Agendada; o atendente confirma à mão (reconhece o [Familia] — é 1 caso só).
  // Detecção pelo próprio card (D1, sem subrequest); mesma condição que gera o [Familia].
  const nPac = await env.DB.prepare(`SELECT COUNT(DISTINCT paciente_id_cnn) n FROM mapeamento WHERE lead_id_kommo=?`).bind(leadId).first<any>();
  if (Number(nPac?.n ?? 0) >= 2) return { r: "pulado_familia", leadId };
  const dest = VESPERA_DESTINO[grupo];
  if (!dryRun) {
    await moveLeadToStage(leadId, dest.etapa, env, dest.pipeline);
    await registrarLembrete({ chave: `${leadId}|${item.agenda_id_cnn}|${data}`, lead_id_kommo: leadId, agenda_id_cnn: String(item.agenda_id_cnn), data_agendamento: data, grupo, pipeline_destino: dest.pipeline, etapa_destino: dest.etapa }, env);
  }
  return { r: "movido", leadId, nome: STAGE_NOME[dest.etapa] ?? String(dest.etapa) };
}

// ══ FILA: Produtor ORC (reflexo de orçamento CNN → etapa Kommo) ═══════════════
// Descobre PACIENTES com atividade de orçamento — NÃO decide nada (a decisão é
// 100% do consumidor, que relê o histórico completo via cnnOrcamentosDoPaciente).
// Duas janelas complementares, ambas só leitura:
//  • APROVACAO recente (hoje−7d..hoje): pega aprovações/cancelamentos frescos rápido,
//    mesmo de orçamentos criados há muito tempo (filtra pela data do EVENTO, não da criação).
//  • CRIACAO por cursor deslizante (passo de ORC_CRIACAO_STEP_DIAS, mesmo horizonte de
//    trás de cnnOrcamentosDoPaciente = hoje−730d): sweep de fundo que eventualmente
//    reavalia TODO paciente com orçamento, mesmo sem evento na janela 1. Ao passar de
//    hoje, volta pro início (loop perpétuo) — cadência real depende de quem chama isto.
// Idempotência da fila: chave inclui o DIA de hoje → no máx. 1 item pendente por
// paciente por dia (reabre sozinho no dia seguinte, mesmo padrão de F2); reenfileirar
// no mesmo dia é inofensivo (consumidor idempotente).
const CURSOR_ORCAMENTO = "cursor_orcamento";
const ORC_CRIACAO_STEP_DIAS = 7;
const ORC_CRIACAO_LOOKBACK_DIAS = 730; // = janela de trás de cnnOrcamentosDoPaciente
const ORC_ENQUEUE_CAP = 300;           // teto defensivo de itens por passada
function addDiasISO(dataISO: string, dias: number): string {
  return new Date(new Date(`${dataISO}T00:00:00Z`).getTime() + dias * 24 * 3600 * 1000).toISOString().slice(0, 10);
}
async function produtorOrcamento(env: Env, target: CnnTarget, budget: number): Promise<any> {
  await ensureSchema(env);
  const hoje = todayBRT();
  const out: any = {
    fase: "produtor-orcamento", target, budget,
    orcamentos_aprovacao: 0, orcamentos_criacao: 0, pacientes: 0, sem_paciente: 0,
    enfileirados: 0, ja_na_fila: 0, limitados_cap: 0,
    cursor_ini: "", cursor_fim: "", janela_criacao: "",
  };
  const candidatos = new Map<string, string>(); // pid → telefone (dedup no lote inteiro)

  // 1. APROVACAO recente — pega aprovações/cancelamentos frescos
  const diAprov = new Date(Date.now() - 3 * 3600 * 1000 - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let pagA = 0, totalA = 1;
  while (pagA < totalA && orcamentoOk(budget)) {
    let r: any;
    try {
      r = await cnnGet(
        `/orcamento/lista?dataInicial=${diAprov}&dataFinal=${hoje}&tipoData=APROVACAO&registrosPorPagina=50&pagina=${pagA}`,
        env, target
      );
    } catch { break; }
    const lista = r?.lista ?? [];
    if (lista.length === 0) break;
    out.orcamentos_aprovacao += lista.length;
    for (const o of lista) {
      const pid = o?.paciente?.id != null ? String(o.paciente.id) : "";
      if (!pid) { out.sem_paciente++; continue; }
      if (!candidatos.has(pid)) candidatos.set(pid, normalizePhone(o?.paciente?.contato?.telefoneCelular ?? ""));
    }
    totalA = Math.max(r?.totalPaginas ?? 1, 1);
    pagA++;
  }

  // 2. CRIACAO por cursor deslizante — sweep de fundo
  const anchor = new Date(Date.now() - ORC_CRIACAO_LOOKBACK_DIAS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const diCria = (await getCursor(CURSOR_ORCAMENTO, env)) ?? anchor;
  out.cursor_ini = diCria;
  const dfCria = addDiasISO(diCria, ORC_CRIACAO_STEP_DIAS);
  out.janela_criacao = `${diCria}..${dfCria}`;
  let pagC = 0, totalC = 1;
  while (pagC < totalC && orcamentoOk(budget)) {
    let r: any;
    try {
      r = await cnnGet(
        `/orcamento/lista?dataInicial=${diCria}&dataFinal=${dfCria}&tipoData=CRIACAO&registrosPorPagina=50&pagina=${pagC}`,
        env, target
      );
    } catch { break; }
    const lista = r?.lista ?? [];
    if (lista.length === 0) break;
    out.orcamentos_criacao += lista.length;
    for (const o of lista) {
      const pid = o?.paciente?.id != null ? String(o.paciente.id) : "";
      if (!pid) { out.sem_paciente++; continue; }
      if (!candidatos.has(pid)) candidatos.set(pid, normalizePhone(o?.paciente?.contato?.telefoneCelular ?? ""));
    }
    totalC = Math.max(r?.totalPaginas ?? 1, 1);
    pagC++;
  }
  // Avança o cursor sempre (a janela foi varrida mesmo se vazia/parcial) — reseta pro
  // início ao passar de hoje, fechando o loop perpétuo do sweep.
  let proximoCursor = addDiasISO(diCria, ORC_CRIACAO_STEP_DIAS);
  if (proximoCursor > hoje) proximoCursor = anchor;
  await setCursor(CURSOR_ORCAMENTO, proximoCursor, env);
  out.cursor_fim = proximoCursor;
  out.pacientes = candidatos.size;

  // 3. Enfileira 1 item por paciente distinto (teto defensivo por passada)
  let pares = [...candidatos.entries()];
  if (pares.length > ORC_ENQUEUE_CAP) { out.limitados_cap = pares.length - ORC_ENQUEUE_CAP; pares = pares.slice(0, ORC_ENQUEUE_CAP); }
  const aEnfileirar = pares.map(([pid, telefone]) => ({
    chave: `ORC:${pid}:${hoje}`, tipo: "ORC", paciente_id_cnn: pid,
    payload: { telefone },
  }));
  const antes = (await filaStats(env)).pendente ?? 0;
  if (aEnfileirar.length) await filaEnfileirarLote(aEnfileirar, env);
  const depois = (await filaStats(env)).pendente ?? 0;
  out.enfileirados = depois - antes;
  out.ja_na_fila = aEnfileirar.length - out.enfileirados;
  return out;
}

// ══ FILA: Consumidor ORC — reflete o orçamento CNN na etapa do lead ═══════════
// 1 item por paciente (produtorOrcamento). Idempotência por ETAPA JÁ REFLETIDA
// (orcamento_sync.ultima_etapa), não por "1ª vez visto": de propósito NÃO há
// baseline-skip (a 1ª avaliação de um paciente com orçamento aprovado já move —
// a enxurrada inicial é controlada pelo teto do cron, não aqui). Respeita move
// manual: se o alvo não mudou desde o último reflexo, não mexe mesmo que o lead
// tenha sido movido pra outro lugar depois (evita brigar com o atendente/A3).
// Card-alvo do reflexo de orçamento, GROUP-AWARE (fix 02/07). O modelo é de DUPLICATA
// (1 paciente pode ter card A em Captação + card B em Pós-Venda). O ORC deve agir no card
// do FUNIL da decisão: APROVADO→Pós-Venda=card B; ABERTO/CANCELADO/PERDIDO→Pós-Consulta=card A.
// Opção 1 do dono: se esse card não existe, retorna null → o chamador PULA (não cria card,
// não toca o card do outro grupo). Substitui o antigo acharLeadDoPaciente (A-primeiro).
async function leadAlvoOrcamento(pid: string, decisao: { pipeline: number } | null, env: Env): Promise<string | null> {
  if (!decisao) return null;
  const grupo: "A" | "B" = decisao.pipeline === PIPELINE_POS_VENDA ? "B" : "A";
  const map: any = await getMapeamento(pid, grupo, env);
  return map?.lead_id_kommo ? String(map.lead_id_kommo) : null;
}
// Nome+telefone do paciente a partir dos objetos de orçamento (o /orcamento/lista traz
// o.paciente.nome e o.paciente.contato.telefoneCelular). Usado p/ criar o card B no APROVADO.
function dadosPacienteDoOrcamento(orcs: any[]): { nome: string; telefone: string } {
  for (const o of orcs) {
    const nome = o?.paciente?.nome ?? "";
    const tel = o?.paciente?.contato?.telefoneCelular ?? "";
    if (nome || tel) return { nome: String(nome), telefone: String(tel) };
  }
  return { nome: "", telefone: "" };
}
async function consumirItemOrcamento(item: any, env: Env, target: CnnTarget, dryRun: boolean): Promise<{ r: string; leadId?: string; nome?: string }> {
  const pid = String(item.paciente_id_cnn);

  const orcs = await cnnOrcamentosDoPaciente(pid, env, target);
  const temFutura = await temAgendaFutura(pid, env);
  const cutoffAprov = addDiasISO(todayBRT(), -ORC_APROVACAO_MAX_DIAS); // só aprovação recente reativa
  const decisao = decidirEtapaOrcamento(orcamentosRecentes(orcs, cutoffAprov), temFutura); // {pipeline,status} | null
  const resumo: string | null = orcs.some((o) => o.status === "APROVADO")
    ? "APROVADO"
    : (orcs.length ? orcs.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a)).status : null);
  const est = await getOrcamentoSync(pid, env); // {ultimo_status, ultima_etapa} | null
  // GROUP-AWARE: escolhe o card pelo funil da decisão (não mais acharLeadDoPaciente A-primeiro,
  // que num paciente com duplicata arrastava o card de Captação pro lugar errado).
  const leadId = await leadAlvoOrcamento(pid, decisao, env);

  if (decisao === null) { // portão fechado (agenda futura) ou nada a refletir
    if (!dryRun) await upsertOrcamentoSync({ paciente_id_cnn: pid, lead_id_kommo: leadId ?? "", ultimo_status: resumo, ultima_etapa: null }, env);
    return { r: "sem_mudanca", leadId: leadId ?? undefined };
  }
  // IDEMPOTÊNCIA/1x + respeita move/DELETE manual: se JÁ refletimos este alvo antes, não re-move
  // NEM re-cria (mesmo que o atendente tenha movido/apagado o card depois). Vem ANTES do create.
  if (est && est.ultima_etapa === decisao.status) return { r: "sem_mudanca", leadId: leadId ?? undefined };

  // Card-alvo do funil da decisão não existe:
  if (!leadId) {
    // ABERTO/CANCELADO/PERDIDO (Pós-Consulta) sem card A → pula (o card A deveria existir da consulta).
    if (decisao.pipeline !== PIPELINE_POS_VENDA) return { r: "sem_lead" };
    // Opção 2 (dono 02/07): APROVADO sem card B → CRIA o card cliente em Pós-Venda/Tratamento Iniciado.
    // Nasce SEM agenda (comprou, procedimento não marcado ainda); dados do paciente vêm do orçamento.
    const d = dadosPacienteDoOrcamento(orcs);
    if (!d.telefone && !d.nome) return { r: "sem_dados" }; // sem identidade → não cria
    if (dryRun) return { r: "criaria_b" };
    const fields = await resolveFields(env);
    const novo = await criarCardLead({ grupo: "B", nome: d.nome || `Paciente ${pid}`, telefone: d.telefone, cnnTs: 0, agendaId: "", pid, etapa: decisao.status }, env, fields);
    if (!novo) throw new Error(`ORC: falha ao criar card B (pac ${pid})`);
    await upsertOrcamentoSync({ paciente_id_cnn: pid, lead_id_kommo: novo, ultimo_status: resumo, ultima_etapa: decisao.status }, env);
    return { r: "criado_b", leadId: novo, nome: STAGE_NOME[decisao.status] ?? String(decisao.status) };
  }

  // Alvo mudou (ou 1ª vez): só move se o lead ainda não está lá (evita PATCH redundante
  // nos 2 leads manuais).
  let etapaAtual = 0;
  try { etapaAtual = Number((await kommoGet(`/leads/${leadId}`, env)).status_id) || 0; } catch { /* ignore */ }
  // GATE C1: só age se a consulta já assentou (etapa em ETAPAS_ORC_PODE_AGIR). Senão ADIA:
  // fica pendente e retenta no próximo dreno; após ~20min desiste (retenta amanhã via chave-dia).
  if (!ETAPAS_ORC_PODE_AGIR.has(etapaAtual)) {
    const idadeSeg = item.criado_em ? Math.floor(Date.now() / 1000) - Number(item.criado_em) : 0;
    // Finding B: 20min sem a consulta assentar → desiste, mas AUDITA (antes caía em
    // "sem_mudanca" mudo — indistinguível de "nada a fazer"; ver consumirFila).
    return idadeSeg > 1200 ? { r: "adiado_expirado", leadId } : { r: "adiado", leadId };
  }
  if (etapaAtual === decisao.status) {
    if (!dryRun) await upsertOrcamentoSync({ paciente_id_cnn: pid, lead_id_kommo: leadId, ultimo_status: resumo, ultima_etapa: decisao.status }, env);
    return { r: "sem_mudanca", leadId };
  }

  if (!dryRun) {
    await moveLeadToStage(leadId, decisao.status, env, decisao.pipeline);
    await upsertOrcamentoSync({ paciente_id_cnn: pid, lead_id_kommo: leadId, ultimo_status: resumo, ultima_etapa: decisao.status }, env);
  }
  return { r: "movido", leadId, nome: STAGE_NOME[decisao.status] ?? String(decisao.status) };
}

// ══ FILA: Consumidor genérico — puxa lote e processa dentro do orçamento ═══════
async function consumirFila(env: Env, target: CnnTarget, dryRun: boolean, cap: number, budget: number): Promise<any> {
  await ensureSchema(env);
  const out: any = { fase: "consumidor", cap, budget, processados: 0, criados: 0, vinculados: 0, ja_mapeado: 0, erros: 0, parou_orcamento: false, itens: [] as any[] };
  // Dry-run só ESPIA (não muta a fila). Caminho real REIVINDICA (claim atômico) → drenos
  // concorrentes puxam conjuntos disjuntos (C1).
  const lote = dryRun ? await filaPuxarPendentes(cap, env) : await filaClaimLote(cap, env);
  for (let i = 0; i < lote.length; i++) {
    const item = lote[i];
    if (!orcamentoOk(budget)) {
      out.parou_orcamento = true;
      // Budget estourou no meio: libera a CAUDA já reivindicada (claim) mas não processada —
      // volta a 'pendente' sem queimar tentativa (senão ficaria presa em 'processing' até o TTL).
      if (!dryRun) for (let k = i; k < lote.length; k++) await filaAdiar(lote[k].id, env);
      break;
    }
    try {
      let res: { r: string; leadId?: string; nome?: string } = { r: "tipo_desconhecido" };
      if (item.tipo === "A4") res = await consumirItemA4(item, env, target, dryRun);
      else if (item.tipo === "A3") res = await consumirItemA3(item, env, target, dryRun);
      else if (item.tipo === "F2") res = await consumirItemF2(item, env, target, dryRun);
      else if (item.tipo === "ORC") res = await consumirItemOrcamento(item, env, target, dryRun);
      else if (item.tipo === "CNN_CONFIRMAR") res = await consumirItemCnnConfirmar(item, env, dryRun);
      else if (item.tipo === "CNN_AGENDAR")   res = await consumirItemCnnAgendar(item, env, dryRun);
      if (!dryRun) {
        if (res.r === "adiado") {
          await filaAdiar(item.id, env);   // "adiado" (ORC): volta a pendente e desfaz o incremento do claim (não é falha)
        } else {
          await filaMarcarFeito(item.id, env);
          if (res.r === "criado") await audit(env, { funcao: "A4", ambiente: target, entidade_id: res.leadId, acao: "card-criado", para: item.grupo, detalhe: `pac ${item.paciente_id_cnn} ${res.nome ?? ""}` });
          else if (res.r === "criado_b") await audit(env, { funcao: "ORC", ambiente: target, entidade_id: res.leadId, acao: "card-b-criado", para: res.nome, detalhe: `ORC APROVADO pac ${item.paciente_id_cnn}` });
          else if (res.r === "movido") await audit(env, { funcao: item.tipo, ambiente: target, entidade_id: res.leadId, acao: "etapa-movida", para: res.nome, detalhe: item.tipo === "ORC" ? `ORC pac ${item.paciente_id_cnn}` : `${item.tipo} agenda ${item.agenda_id_cnn}` });
          else if (res.r === "adiado_expirado") await audit(env, { funcao: "ORC", ambiente: target, entidade_id: res.leadId, acao: "adiado-expirado", detalhe: `ORC pac ${item.paciente_id_cnn}` });
          else if (res.r === "sem_dados") await audit(env, { funcao: "ORC", ambiente: target, entidade_id: item.paciente_id_cnn, acao: "orc-sem-dados", detalhe: `APROVADO sem telefone/nome no CNN → card B não criado (pac ${item.paciente_id_cnn})` });
        }
      }
      out.processados++;
      if (res.r === "criado") out.criados++; else if (res.r === "vinculado") out.vinculados++;
      else if (res.r === "ja_mapeado") out.ja_mapeado++; else if (res.r === "movido") out.movidos = (out.movidos ?? 0) + 1;
      else if (res.r === "criado_b" || res.r === "criaria_b") out.criados_b = (out.criados_b ?? 0) + 1;
      else if (res.r === "sem_dados") out.sem_dados = (out.sem_dados ?? 0) + 1;
      else if (res.r === "adiado") out.adiados = (out.adiados ?? 0) + 1;
      else if (res.r === "adiado_expirado") out.adiados_expirados = (out.adiados_expirados ?? 0) + 1;
      else if (res.r === "pulado_familia") out.pulado_familia = (out.pulado_familia ?? 0) + 1;
      else if (res.r === "sem_mudanca" || res.r === "baseline") out.sem_acao = (out.sem_acao ?? 0) + 1;
      out.itens.push({ id: item.id, tipo: item.tipo, pac: item.paciente_id_cnn, grupo: item.grupo, r: res.r, lead: res.leadId ?? null, nome: res.nome ?? null });
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
        // Só o dead-letter (1x por item); transitórios/retries intermediários não poluem o log.
        if (deadLetter) await audit(env, { funcao: item.tipo ?? "FILA", ambiente: target, entidade_id: item.paciente_id_cnn ?? String(item.id), acao: "dead-letter", detalhe: `item ${item.id} pac ${item.paciente_id_cnn} tent ${tentativas}: ${String(e).slice(0, 160)}` });
      }
      out.itens.push({ id: item.id, pac: item.paciente_id_cnn, erro: String(e), transitorio, dead_letter: deadLetter });
    }
  }
  return out;
}

// ── Função 2: Lembrete D-1 (véspera) — CNN-driven, roteado por tipo ──────────
// Lista as agendas de AMANHÃ no CNN (reconfirma na fonte, §7.5), roteia por grupo
// e move o lead pra etapa de confirmação do grupo. Idempotente por chave composta
// (lead + agenda + DATA): remarcar pra outra data re-dispara; mesma data, não.
const STATUS_TERMINAL = new Set(["CANCELADO", "CANCELADO_PACIENTE", "FINALIZADO", "FALTOU"]);
async function cronVespera(env: Env, dryRun = false, target: CnnTarget = "sandbox", dataAlvo?: string): Promise<any> {
  await ensureSchema(env);
  const tiposMap = await resolveTiposConsulta(env, target);
  const amanha = dataAlvo ?? tomorrowBRT();
  const out: any = { dryRun, target, dataAlvo: amanha, agendas: 0, movidos: 0, ja_enviados: 0, pulados_tipo: 0, pulados_status: 0, sem_lead: 0, acoes: [] as any[] };

  // 1. Coleta as agendas de amanhã
  const todas: any[] = [];
  let pag = 0, totalPag = 1;
  while (pag < totalPag) {
    let resp: any;
    try { resp = await cnnGet(`/agenda/lista?dataInicial=${amanha}&dataFinal=${amanha}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch { break; }
    totalPag = Math.max(resp?.totalPaginas ?? 1, 1);
    pag++;
    for (const a of (resp?.lista ?? [])) todas.push(a);
  }
  out.agendas = todas.length;

  // 2. Reconfirma (§7.5: data=amanhã, status não-terminal) + grupo + ORDENA B antes de A
  //    (desempate: paciente com agenda A e B no mesmo dia → vai pra B / Pós-Venda).
  out.pulados_interno = 0;
  const elegiveis: Array<{ a: any; g: "A" | "B" }> = [];
  for (const a of todas) {
    if (a.data !== amanha) continue;
    if (isTarefaInterna(a)) { out.pulados_interno++; continue; }
    if (STATUS_TERMINAL.has(a.status ?? "")) { out.pulados_status++; continue; }
    const g = grupoDaAgenda(a, tiposMap);
    if (!g) { out.pulados_tipo++; continue; }
    elegiveis.push({ a, g });
  }
  elegiveis.sort((x, y) => (x.g === "B" ? 0 : 1) - (y.g === "B" ? 0 : 1));

  // 3. Processa — 1 lembrete por lead por dia (dedup intra-run + persistente)
  const leadsVistos = new Set<string>();
  for (const { a: agenda, g: grupo } of elegiveis) {
    try {
      const agendaId = String(agenda.id);
      const status: string = agenda.status ?? "";
      const telefone = normalizePhone(agenda.telefoneCelularPaciente ?? "");
      const est: any = await getAgendaSync(agendaId, env);
      let leadId: string | null = est?.lead_id_kommo ?? null;
      if (!leadId && telefone.length >= 8) {
        try {
          const telKey = phoneKey(telefone);
          const kr = await kommoGet(`/contacts?query=${encodeURIComponent(telefone.slice(-8))}&with=leads`, env);
          const contact = (kr._embedded?.contacts ?? []).find((c: any) =>
            (c.custom_fields_values ?? []).filter((f: any) => f.field_code === "PHONE")
              .flatMap((f: any) => f.values.map((v: any) => normalizePhone(v.value)))
              .some((p: string) => phoneKey(p) === telKey));
          const lid = contact?._embedded?.leads?.[0]?.id;
          if (lid) leadId = String(lid);
        } catch { /* sem match */ }
      }
      if (!leadId) { out.sem_lead++; continue; }
      if (leadsVistos.has(leadId)) { out.ja_enviados++; continue; }   // desempate: B já tratou este lead
      if (await leadJaLembradoNaData(leadId, amanha, env)) { out.ja_enviados++; continue; }
      leadsVistos.add(leadId);

      const chave = `${leadId}|${agendaId}|${amanha}`;
      const dest = VESPERA_DESTINO[grupo];
      out.acoes.push({ agenda: agendaId, lead: leadId, grupo, status, destino: STAGE_NOME[dest.etapa] ?? dest.etapa });
      if (!dryRun) {
        await moveLeadToStage(leadId, dest.etapa, env, dest.pipeline);
        await registrarLembrete({ chave, lead_id_kommo: leadId, agenda_id_cnn: agendaId, data_agendamento: amanha, grupo, pipeline_destino: dest.pipeline, etapa_destino: dest.etapa }, env);
        await audit(env, { funcao: "F2", ambiente: target, entidade_id: leadId, acao: "vespera-move", para: String(dest.etapa), detalhe: `agenda ${agendaId} grupo ${grupo} ${amanha}` });
      }
      out.movidos++;
    } catch (e) { out.acoes.push({ agenda: String(agenda.id), erro: String(e) }); }
  }
  return out;
}


// ── Test workflow ─────────────────────────────────────────────────────────────
const STAGE_NOME: Record<number, string> = {
  [STAGE_PRIMEIRO_CONTATO]:     "Primeiro Contato",
  [STAGE_CONSULTA_AGENDADA]:    "Consulta Agendada",
  [STAGE_CONFIRMACAO_CONSULTA]: "Confirmação de Consulta",
  [STAGE_CONSULTA_CONFIRMADA]:  "Consulta Confirmada",
  [STAGE_AVALIACAO_REALIZADA]:  "Avaliação Realizada",
  [STAGE_TRATAMENTO_PROPOSTO]:  "Tratamento Proposto",
  [STAGE_CANCELADA_PERDIDO]:    "Cancelada–Perdido",
  [STAGE_POS_CLIENTE_ATIVO]:     "Pós-Venda: Cliente Ativo",
  [STAGE_POS_CONFIRMACAO_AGEND]: "Pós-Venda: Confirmação de Agendamento",
  [STAGE_POSCONS_EM_ANALISE]:        "Pós-Consulta: Em Análise",
  [STAGE_POS_TRATAMENTO_INICIADO]:   "Pós-Venda: Tratamento Iniciado",
  // STAGE_POSCONS_VENDA_PERDIDA (143) NÃO entra aqui — mesmo valor de
  // STAGE_CANCELADA_PERDIDO, já mapeado acima; duplicar a chave o sobrescreveria.
};

async function handleTestWorkflow(req: Request, env: Env): Promise<Response> {
  const url      = new URL(req.url);
  const telefone = normalizePhone(url.searchParams.get("phone") ?? "11946800329");
  const acao     = url.searchParams.get("acao") ?? "audit";
  const amanha   = tomorrowBRT();

  const fields      = await resolveFields(env);
  const fIdAgenda   = fields["ID Agenda CNN"];
  const fIdPaciente = fields["ID Paciente CNN"];
  const fAg         = fields["AGENDAMENTO"];

  const out: any = {
    telefone,
    acao,
    amanha,
    campos: { fIdAgenda, fIdPaciente, fAgendamento: fAg },
  };

  // ── Kommo: contato + leads ────────────────────────────────────────────────
  try {
    const kr       = await kommoGet(`/contacts?query=${encodeURIComponent(telefone.slice(-11))}&with=leads`, env);
    const contacts: any[] = kr._embedded?.contacts ?? [];
    const contato  = contacts.find((c: any) =>
      (c.custom_fields_values ?? [])
        .filter((f: any) => f.field_code === "PHONE")
        .flatMap((f: any) => f.values.map((v: any) => normalizePhone(v.value)))
        .some(p => p.slice(-11) === telefone.slice(-11))
    );

    if (!contato) {
      out.kommo_contato = null;
      out.kommo_leads   = [];
    } else {
      out.kommo_contato = { id: contato.id, nome: contato.name };
      const leads: any[] = [];
      for (const { id: lid } of (contato._embedded?.leads ?? [])) {
        try {
          const lead      = await kommoGet(`/leads/${lid}`, env);
          const idAgenda  = getFieldValue(lead, fIdAgenda);
          const idPac     = getFieldValue(lead, fIdPaciente);
          const agTs      = Number(getFieldValue(lead, fAg) ?? 0);
          const dataAg    = agTs ? unixToDateBRT(agTs).data : null;
          const c1        = {
            tem_agendamento: agTs > 0,
            data_e_amanha:   dataAg === amanha,
            tem_id_agenda:   !!idAgenda,
            tem_id_paciente: !!idPac,
          };
          leads.push({
            id:              lid,
            nome:            lead.name,
            etapa:           STAGE_NOME[lead.status_id] ?? `desconhecida (${lead.status_id})`,
            etapa_id:        lead.status_id,
            pipeline_id:     lead.pipeline_id,
            agendamento_ts:  agTs || null,
            agendamento_data: dataAg,
            id_agenda_cnn:   idAgenda,
            id_paciente_cnn: idPac,
            c1_condicoes:    c1,
            c1_moveria:      Object.values(c1).every(Boolean),
          });
        } catch (e) { leads.push({ id: lid, erro: String(e) }); }
      }
      out.kommo_leads = leads;
    }
  } catch (e) { out.kommo_erro = String(e); }

  // ── CNN: paciente + agendamentos ──────────────────────────────────────────
  try {
    // telefoneCelularContem: parâmetro não documentado na API oficial — funciona nos testes mas pode ser removido sem aviso
    const pr  = await cnnGet(`/paciente/lista?telefoneCelularContem=${encodeURIComponent(telefone.slice(-11))}&limite=5`, env);
    const pac = (pr?.lista ?? []).find((p: any) =>
      normalizePhone(p.contato?.telefoneCelular ?? p.contato?.telefone ?? "").slice(-11) === telefone.slice(-11)
    );
    if (!pac) {
      out.cnn_paciente     = null;
      out.cnn_agendamentos = [];
    } else {
      out.cnn_paciente = { id: pac.id, nome: pac.nome };
      const di = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const df = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const ar = await cnnGet(`/agenda/lista?codigoPaciente=${pac.id}&dataInicial=${di}&dataFinal=${df}&registrosPorPagina=20`, env);
      out.cnn_agendamentos = (ar?.lista ?? []).map((a: any) => ({
        id: a.id, data: a.data, hora: (a.horaInicio ?? "").slice(0, 5), status: a.status,
      }));
    }
  } catch (e) { out.cnn_erro = String(e); }

  // ── Ações POST ────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    if (acao === "test-delete") {
      // Apaga leads+contato do telefone e limpa o estado D1 (para testar criação do A4). Allowlist.
      if (!isTestePhone(telefone)) {
        out.acao_resultado = "ERRO: telefone fora da allowlist de teste (§12.1)";
      } else {
        const contatoId = out.kommo_contato?.id;
        const leadIds = (out.kommo_leads ?? []).map((l: any) => l.id);
        for (const lid of leadIds) { try { await kommoDelete(`/leads/${lid}`, env); } catch { /* ignore */ } }
        if (contatoId) { try { await kommoDelete(`/contacts/${contatoId}`, env); } catch { /* ignore */ } }
        await ensureSchema(env);
        const tn = telefone.slice(-11);
        await env.DB.prepare("DELETE FROM mapeamento WHERE telefone_norm = ?").bind(tn).run();
        for (const lid of leadIds) {
          await env.DB.prepare("DELETE FROM agendamento_sync WHERE lead_id = ?").bind(String(lid)).run();
          await env.DB.prepare("DELETE FROM agenda_sync WHERE lead_id_kommo = ?").bind(String(lid)).run();
        }
        out.acao_resultado = { ok: true, deleted_leads: leadIds, deleted_contato: contatoId };
      }

    } else if (acao === "set-cnn-status") {
      // Só altera o status da agenda no CNN (simula mudança no CNN). Allowlist.
      if (!isTestePhone(telefone)) {
        out.acao_resultado = "ERRO: telefone fora da allowlist de teste (§12.1)";
      } else {
        const novoStatus = url.searchParams.get("status") ?? "CONFIRMADO_PACIENTE";
        const ag = (out.cnn_agendamentos ?? [])[0];
        if (!ag) out.acao_resultado = "ERRO: sem agenda CNN para o telefone";
        else {
          await cnnPut("/agenda/alteracao-status", { idAgenda: Number(ag.id), status: novoStatus }, env);
          out.acao_resultado = { ok: true, idAgenda: ag.id, status: novoStatus };
        }
      }

    } else if (acao === "set-agendamento") {
      // Só altera o campo AGENDAMENTO (simula edição de horário na Kommo). Allowlist.
      if (!isTestePhone(telefone)) {
        out.acao_resultado = "ERRO: telefone fora da allowlist de teste (§12.1)";
      } else {
        const lead = (out.kommo_leads ?? []).find((l: any) => l.pipeline_id === PIPELINE_CAPTACAO);
        if (!lead) out.acao_resultado = "ERRO: sem lead em captação";
        else {
          const dataParam = url.searchParams.get("data") ?? amanha;
          const horaParam = url.searchParams.get("hora") ?? "10:00";
          const ts = brtToUnix(dataParam, horaParam);
          await kommoPatch(`/leads/${lead.id}`, { custom_fields_values: [{ field_id: fAg, values: [{ value: ts }] }] }, env);
          out.acao_resultado = { ok: true, lead_id: lead.id, agendamento: `${dataParam} ${horaParam} BRT`, ts };
        }
      }

    } else if (acao === "set-tipo-proc") {
      // TESTE webhook 2: seta "Tipo Procedimento CNN" (+ AGENDAMENTO se ?data=, + limpar ID Agenda se ?clear_agenda=1). Allowlist.
      if (!isTestePhone(telefone)) {
        out.acao_resultado = "ERRO: telefone fora da allowlist de teste (§12.1)";
      } else {
        const lead = (out.kommo_leads ?? [])[0];
        if (!lead) out.acao_resultado = "ERRO: sem lead";
        else {
          const flds = await resolveFields(env);
          const tipoNome = url.searchParams.get("tipo") ?? "Encaixe";
          const fTipo = flds["Tipo Procedimento CNN"];
          const enumId = flds[`Tipo Procedimento CNN::${tipoNome}`];
          const cf: any[] = [];
          if (fTipo && enumId) cf.push({ field_id: fTipo, values: [{ enum_id: enumId }] });
          const dataParam = url.searchParams.get("data");
          const horaParam = url.searchParams.get("hora") ?? "10:00";
          if (dataParam) cf.push({ field_id: fAg, values: [{ value: brtToUnix(dataParam, horaParam) }] });
          if (url.searchParams.get("clear_agenda") === "1" && fIdAgenda) cf.push({ field_id: fIdAgenda, values: [{ value: "" }] });
          if (cf.length) await kommoPatch(`/leads/${lead.id}`, { custom_fields_values: cf }, env);
          out.acao_resultado = { ok: true, lead_id: lead.id, tipo: tipoNome, enum_id: enumId ?? null, campos_setados: cf.length, data: dataParam ?? null };
        }
      }

    } else if (acao === "test-w1") {
      // Teste end-to-end do W1 com data/hora explícitas. Guarda de allowlist.
      if (!isTestePhone(telefone)) {
        out.acao_resultado = "ERRO: telefone fora da allowlist de teste (§12.1)";
      } else {
        const dataParam = url.searchParams.get("data") ?? amanha;     // YYYY-MM-DD
        const horaParam = url.searchParams.get("hora") ?? "10:00";    // HH:MM
        const ts = brtToUnix(dataParam, horaParam);
        const existente = (out.kommo_leads ?? []).find((l: any) => l.pipeline_id === PIPELINE_CAPTACAO);
        let leadId: number | null = existente?.id ?? null;
        let criadoNovo = false;

        try {
          if (!leadId && !out.kommo_contato) {
            // Cria lead + contato (simula secretária criando o lead na Kommo)
            const nome = `TESTE ${telefone}`;
            const criado = await kommoPost("/leads/complex", [{
              name: nome,
              pipeline_id: PIPELINE_CAPTACAO,
              status_id: STAGE_CONSULTA_AGENDADA,
              custom_fields_values: [{ field_id: fAg, values: [{ value: ts }] }],
              _embedded: { contacts: [{ name: nome, custom_fields_values: [
                { field_code: "PHONE", values: [{ value: telefone, enum_code: "WORK" }] },
              ] }] },
            }], env);
            leadId = criado?.[0]?.id ?? null;
            criadoNovo = true;
          } else if (leadId) {
            // Lead existente: seta data e move para Consulta Agendada
            await kommoPatch(`/leads/${leadId}`, {
              status_id: STAGE_CONSULTA_AGENDADA, pipeline_id: PIPELINE_CAPTACAO,
              custom_fields_values: [{ field_id: fAg, values: [{ value: ts }] }],
            }, env);
            // limpa IDs CNN (PATCH separado — Kommo pode rejeitar) e D1
            try {
              await kommoPatch(`/leads/${leadId}`, { custom_fields_values: [
                { field_id: fIdAgenda, values: [{ value: "" }] },
                { field_id: fIdPaciente, values: [{ value: "" }] },
              ] }, env);
            } catch (e2) { out.aviso_limpeza = String(e2); }
            await ensureSchema(env);
            await env.DB.prepare("DELETE FROM agendamento_sync WHERE lead_id = ?").bind(String(leadId)).run();
          }

          if (!leadId) {
            out.acao_resultado = "ERRO: contato existe mas sem lead no funil de captação";
          } else {
            const fakeReq = new Request("http://worker/webhook/lead-agendado", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: `leads[status][0][id]=${leadId}`,
            });
            const w1Resp = await handleLeadAgendado(fakeReq, env);
            const w1Text = await w1Resp.text();
            let w1Body: any; try { w1Body = JSON.parse(w1Text); } catch { w1Body = w1Text; }
            out.acao_resultado = {
              ok: w1Resp.ok, lead_id: leadId, criado_novo: criadoNovo,
              data_setada: `${dataParam} ${horaParam} BRT`, agendamento_ts: ts,
              w1_status: w1Resp.status, w1_resposta: w1Body,
            };
          }
        } catch (e) {
          out.acao_resultado = { ok: false, erro: String(e), lead_id: leadId };
        }
      }

    } else if (acao === "mover-agendada") {
      const lead = (out.kommo_leads ?? []).find((l: any) =>
        l.pipeline_id === PIPELINE_CAPTACAO && !l.id_agenda_cnn
      );
      const ag = (out.cnn_agendamentos ?? []).find((a: any) =>
        ["AGENDADO", "CONFIRMADO_PACIENTE"].includes(a.status)
      );
      if (!lead) out.acao_resultado = "ERRO: nenhum lead sem ID Agenda CNN no funil de captação";
      else if (!ag) out.acao_resultado = "ERRO: nenhum agendamento CNN ativo encontrado";
      else {
        const cnnTs = brtToUnix(ag.data, ag.hora || "10:00");
        await kommoPatch(`/leads/${lead.id}`, {
          status_id: STAGE_CONSULTA_AGENDADA,
          pipeline_id: PIPELINE_CAPTACAO,
          custom_fields_values: [
            { field_id: fIdAgenda,   values: [{ value: String(ag.id)             }] },
            { field_id: fIdPaciente, values: [{ value: String(out.cnn_paciente.id) }] },
            { field_id: fAg,         values: [{ value: cnnTs                     }] },
          ],
        }, env);
        await setSyncedTs(String(lead.id), cnnTs, env);
        out.acao_resultado = { ok: true, lead_id: lead.id, etapa: "Consulta Agendada", agenda_id: ag.id, data: ag.data, hora: ag.hora };
      }

    } else if (acao === "run-c1") {
      const lead = (out.kommo_leads ?? []).find((l: any) =>
        l.etapa_id === STAGE_CONSULTA_AGENDADA && l.id_agenda_cnn && l.id_paciente_cnn
      );
      if (!lead) out.acao_resultado = "ERRO: nenhum lead em 'Consulta Agendada' com IDs CNN preenchidos";
      else {
        await moveLeadToStage(String(lead.id), STAGE_CONFIRMACAO_CONSULTA, env);
        out.acao_resultado = { ok: true, lead_id: lead.id, etapa: "Confirmação de Consulta" };
      }

    } else if (acao === "run-confirmacao") {
      const lead = (out.kommo_leads ?? []).find((l: any) =>
        l.etapa_id === STAGE_CONFIRMACAO_CONSULTA && l.id_agenda_cnn
      );
      if (!lead) out.acao_resultado = "ERRO: nenhum lead em 'Confirmação de Consulta' com ID Agenda CNN";
      else {
        await cnnPut("/agenda/alteracao-status", { idAgenda: Number(lead.id_agenda_cnn), status: "CONFIRMADO_PACIENTE" }, env);
        await moveLeadToStage(String(lead.id), STAGE_CONSULTA_CONFIRMADA, env);
        out.acao_resultado = { ok: true, lead_id: lead.id, etapa: "Consulta Confirmada", cnn_status: "CONFIRMADO_PACIENTE" };
      }

    } else if (acao === "primer") {
      const lead = (out.kommo_leads ?? []).find((l: any) => l.pipeline_id === PIPELINE_CAPTACAO);
      if (!lead) {
        out.acao_resultado = "ERRO: nenhum lead no funil de captação";
      } else {
        try {
          const hora     = url.searchParams.get("hora") ?? "11:00";
          const amanhaTs = brtToUnix(amanha, hora);
          // Passo 1: muda etapa e define AGENDAMENTO
          await kommoPatch(`/leads/${lead.id}`, {
            status_id:   STAGE_PRIMEIRO_CONTATO,
            pipeline_id: PIPELINE_CAPTACAO,
            custom_fields_values: [
              { field_id: fAg, values: [{ value: amanhaTs }] },
            ],
          }, env);
          // Passo 2: tenta limpar IDs CNN (PATCH separado — Kommo pode rejeitar values:[])
          try {
            await kommoPatch(`/leads/${lead.id}`, {
              custom_fields_values: [
                { field_id: fIdAgenda,   values: [{ value: "" }] },
                { field_id: fIdPaciente, values: [{ value: "" }] },
              ],
            }, env);
          } catch (e2) {
            out.aviso_limpeza_campos = `Não foi possível limpar IDs CNN: ${String(e2)}`;
          }
          // Passo 3: limpa D1
          await ensureSchema(env);
          await env.DB.prepare("DELETE FROM agendamento_sync WHERE lead_id = ?").bind(String(lead.id)).run();
          out.acao_resultado = {
            ok: true, lead_id: lead.id,
            etapa: "Primeiro Contato",
            agendamento_setado: `${amanha} ${hora} BRT`,
            agendamento_ts: amanhaTs,
          };
        } catch (e) {
          out.acao_resultado = { ok: false, erro: String(e) };
        }
      }

    } else if (acao === "run-w1") {
      const lead = (out.kommo_leads ?? []).find((l: any) => l.pipeline_id === PIPELINE_CAPTACAO);
      if (!lead) {
        out.acao_resultado = "ERRO: nenhum lead no funil de captação";
      } else {
        await moveLeadToStage(String(lead.id), STAGE_CONSULTA_AGENDADA, env);
        const fakeReq = new Request("http://worker/webhook/lead-agendado", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `leads[status][0][id]=${lead.id}`,
        });
        const w1Resp = await handleLeadAgendado(fakeReq, env);
        const w1Text = await w1Resp.text();
        let w1Body: any;
        try { w1Body = JSON.parse(w1Text); } catch { w1Body = w1Text; }
        out.acao_resultado = {
          ok: w1Resp.ok, lead_id: lead.id,
          etapa: "Consulta Agendada",
          w1_status: w1Resp.status,
          w1_resposta: w1Body,
        };
      }

    } else if (acao === "reset") {
      const lead = (out.kommo_leads ?? []).find((l: any) => l.pipeline_id === PIPELINE_CAPTACAO);
      const pac  = out.cnn_paciente;
      const ag   = (out.cnn_agendamentos ?? []).find((a: any) =>
        ["AGENDADO", "CONFIRMADO_PACIENTE", "CANCELADO"].includes(a.status)
      ) ?? (out.cnn_agendamentos ?? [])[0];

      if (!lead) out.acao_resultado = "ERRO: nenhum lead no funil de captação";
      else if (!pac || !ag) out.acao_resultado = "ERRO: paciente ou agendamento CNN não encontrado";
      else {
        const amanhaTs = brtToUnix(amanha, ag.hora || "11:00");
        await kommoPatch(`/leads/${lead.id}`, {
          status_id: STAGE_CONSULTA_AGENDADA,
          pipeline_id: PIPELINE_CAPTACAO,
          custom_fields_values: [
            { field_id: fIdAgenda,   values: [{ value: String(ag.id)   }] },
            { field_id: fIdPaciente, values: [{ value: String(pac.id)  }] },
            { field_id: fAg,         values: [{ value: amanhaTs        }] },
          ],
        }, env);
        await ensureSchema(env);
        await env.DB.prepare("DELETE FROM agendamento_sync WHERE lead_id = ?").bind(String(lead.id)).run();
        out.acao_resultado = {
          ok: true, lead_id: lead.id,
          etapa: "Consulta Agendada",
          agendamento_setado: `${amanha} ${ag.hora || "11:00"} BRT`,
          id_agenda_cnn: ag.id,
          id_paciente_cnn: pac.id,
        };
      }
    }
  }

  return Response.json(out);
}

// ── Debug C1: reproduz a query exata do cron de lembrete D-1 ──────────────────
// Read-only. Compara a query com filtro de campo customizado (a que o cron usa)
// contra a busca só por status filtrada no código — para isolar se o filtro
// filter[cf][AGENDAMENTO][from/to] retorna vazio/erro.
async function handleDebugC1(env: Env): Promise<Response> {
  const out: any = { dryRun: true };

  // Diagnóstico: filtro ERRADO (antigo) vs CORRETO — página 1, e quantos dos
  // retornados realmente estão na etapa esperada (prova de que o filtro filtra).
  const conta = async (q: string, expectStage: number) => {
    try {
      const r = await kommoGet(`/leads?${q}&limit=250&page=1`, env);
      const leads = r._embedded?.leads ?? [];
      const naEtapa = leads.filter((l: any) => l.status_id === expectStage).length;
      return { retornados: leads.length, na_etapa_esperada: naEtapa };
    } catch (e) { return { erro: String(e) }; }
  };
  const correto = (stage: number) => `filter[statuses][0][pipeline_id]=${PIPELINE_CAPTACAO}&filter[statuses][0][status_id]=${stage}`;
  out.antigo_status_id           = await conta(`filter[status_id]=${STAGE_CONSULTA_AGENDADA}`, STAGE_CONSULTA_AGENDADA);
  out.correto_consulta_agendada  = await conta(correto(STAGE_CONSULTA_AGENDADA), STAGE_CONSULTA_AGENDADA);
  out.correto_confirmacao        = await conta(correto(STAGE_CONFIRMACAO_CONSULTA), STAGE_CONFIRMACAO_CONSULTA);
  out.correto_primeiro_contato   = await conta(correto(STAGE_PRIMEIRO_CONTATO), STAGE_PRIMEIRO_CONTATO);

  const { amanha, toMove, totalScaneado } = await selectLeadsLembreteD1(env);
  out.amanha = amanha;
  out.total_scaneado = totalScaneado;
  out.total_para_mover = toMove.length;
  out.leads = toMove;
  return Response.json(out);
}

// ── Debug Scale: valida filtros/paginação para arquitetura delta-driven ───────
// Read-only. Responde: (A) o filter[updated_at] da Kommo filtra mesmo?
// (B) que metadados de paginação a Kommo dá? (C) o CNN expõe total da base?
async function handleDebugScale(env: Env): Promise<Response> {
  const out: any = {};
  const nowSec = Math.floor(Date.now() / 1000);
  const cursor = nowSec - 3600; // 1h atrás

  // A. filter[updated_at][from] — filtra de verdade? Testa várias janelas e
  // checa se o lead de teste (17488447, mexido há pouco) aparece.
  const checkUpdated = async (horas: number) => {
    const c = nowSec - horas * 3600;
    try {
      const r = await kommoGet(`/leads?filter[updated_at][from]=${c}&limit=250`, env);
      const leads = r._embedded?.leads ?? [];
      return {
        horas, cursor: c, retornados: leads.length,
        todos_apos_cursor: leads.every((l: any) => (l.updated_at ?? 0) >= c),
        contem_lead_teste: leads.some((l: any) => l.id === 17488447),
        tem_next: !!r._links?.next,
      };
    } catch (e) { return { horas, erro: String(e) }; }
  };
  out.kommo_updated_at_filter = [await checkUpdated(1), await checkUpdated(24), await checkUpdated(168)];

  // B. metadados de paginação geral da Kommo
  try {
    const r = await kommoGet(`/leads?limit=250&page=1`, env);
    out.kommo_pagina_metadata = {
      keys_top: Object.keys(r ?? {}),
      _page: r?._page ?? null,
      total_items: r?._total_items ?? null,
      tem_next: !!r?._links?.next,
      retornados: (r?._embedded?.leads ?? []).length,
    };
  } catch (e) { out.kommo_pagina_metadata = { erro: String(e) }; }

  // C. CNN: total da base de pacientes?
  try {
    const r: any = await cnnGet(`/paciente/lista?registrosPorPagina=1&pagina=0`, env);
    out.cnn_paciente_meta = {
      keys: Object.keys(r ?? {}),
      totalPaginas: r?.totalPaginas ?? null,
      totalRegistros: r?.totalRegistros ?? r?.total ?? r?.totalElementos ?? null,
      retornados: (r?.lista ?? []).length,
    };
  } catch (e) { out.cnn_paciente_meta = { erro: String(e) }; }

  // C2. CNN: volume de agendas numa janela de 7 dias
  try {
    const hoje = todayBRT();
    const fim = new Date(Date.now() - 3 * 3600 * 1000 + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const r: any = await cnnGet(`/agenda/lista?dataInicial=${hoje}&dataFinal=${fim}&registrosPorPagina=1&pagina=0`, env);
    out.cnn_agenda_meta = {
      janela: `${hoje}..${fim}`,
      keys: Object.keys(r ?? {}),
      totalPaginas: r?.totalPaginas ?? null,
      totalRegistros: r?.totalRegistros ?? r?.total ?? r?.totalElementos ?? null,
    };
  } catch (e) { out.cnn_agenda_meta = { erro: String(e) }; }

  return Response.json(out);
}

// ── Fase 2: forma do CNN (tipos + enums de status reais) ──────────────────────
// READ-ONLY. Lê tipo-consulta/procedimento + uma amostra de agendas e agrega:
// status distintos (fecha os 6 enums faltantes), uso de idTipoConsulta e se o
// array procedimentos[] vem preenchido (decide se roteio por idTipoConsulta ou
// também por procedimento). Aceita ?env=production (GET only) e ?di=&df=.
async function handleDebugCnnShape(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const target: CnnTarget = url.searchParams.get("env") === "production" ? "production" : "sandbox";
  const di = url.searchParams.get("di") ?? todayBRT();
  const df = url.searchParams.get("df") ?? new Date(Date.now() - 3 * 3600 * 1000 + 120 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const out: any = { cnn_target: target, janela: `${di}..${df}` };

  try {
    const tc: any = await cnnGet("/tipo-consulta/lista?registrosPorPagina=200&pagina=0", env, target);
    out.tipo_consulta = (tc?.lista ?? []).map((t: any) => {
      const norm = normNome(t.nome ?? "");
      const grupo = GRUPO_A_TIPOS.has(norm) ? "A" : GRUPO_B_TIPOS.has(norm) ? "B" : "—(não faz nada)";
      return { id: t.id, nome: t.nome, norm, reconsulta: t.reconsulta, grupo };
    });
  } catch (e) { out.tipo_consulta = { erro: String(e) }; }

  try {
    const tp: any = await cnnGet("/tipo-procedimento/lista?registrosPorPagina=200&pagina=0&tipo=TODOS", env, target);
    out.tipo_procedimento = (tp?.lista ?? []).map((t: any) => ({ id: t.id, nome: t.nome }));
  } catch (e) { out.tipo_procedimento = { erro: String(e) }; }

  try {
    const tiposMap = await resolveTiposConsulta(env, target);
    const statusDistintos: Record<string, number> = {};
    const idTipoConsultaUso: Record<string, number> = {};
    const porGrupo: Record<string, number> = { A: 0, B: 0, "—": 0 };
    const amostraRoteamento: any[] = [];
    let comProcedimentos = 0, totalAmostra = 0, pag = 0, totalPag = 1;
    while (pag < totalPag && pag < 5) {
      const r: any = await cnnGet(`/agenda/lista?dataInicial=${di}&dataFinal=${df}&registrosPorPagina=200&pagina=${pag}`, env, target);
      totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
      for (const a of (r?.lista ?? [])) {
        totalAmostra++;
        statusDistintos[a.status ?? "(vazio)"] = (statusDistintos[a.status ?? "(vazio)"] ?? 0) + 1;
        idTipoConsultaUso[String(a.idTipoConsulta ?? "(null)")] = (idTipoConsultaUso[String(a.idTipoConsulta ?? "(null)")] ?? 0) + 1;
        if ((a.procedimentos ?? []).length > 0) comProcedimentos++;
        const grupo = grupoDaAgenda(a, tiposMap);
        porGrupo[grupo ?? "—"]++;
        if (amostraRoteamento.length < 15) {
          amostraRoteamento.push({
            agenda: a.id,
            tipo: tiposMap[String(a.idTipoConsulta ?? "")] ?? `id ${a.idTipoConsulta} (fora do mapa)`,
            status: a.status,
            grupo: grupo ?? "nada (não roteia)",
            status_move_etapa: grupo ? destinoStatus(grupo, a.status ?? "") : null,
            vespera_destino: grupo ? VESPERA_DESTINO[grupo] : null,
          });
        }
      }
    }
    out.agendas = {
      total_amostra: totalAmostra, status_distintos: statusDistintos,
      idTipoConsulta_uso: idTipoConsultaUso, com_procedimentos: comProcedimentos,
      por_grupo: porGrupo, amostra_roteamento: amostraRoteamento,
    };
  } catch (e) { out.agendas = { erro: String(e) }; }

  return Response.json(out);
}

// ── Debug: orçamento CNN (read-only) — lista por status/janela, detalha por id,
// lista por paciente, e simula a decisão do reflexo (§4, spec 2026-07-01). ──────
async function handleDebugOrcamento(req: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const url = new URL(req.url);
  const target: CnnTarget = url.searchParams.get("env") === "production" ? "production" : "sandbox";
  const id = url.searchParams.get("id");
  const paciente = url.searchParams.get("paciente");
  const decidir = url.searchParams.get("decidir");

  if (id) return Response.json(await cnnGet(`/orcamento/${id}`, env, target));

  // Só-D1 (sem CNN): qual card o ORC miraria por funil (seleção group-aware real). Serve de
  // observabilidade e de teste local. B = card de Pós-Venda (APROVADO); A = card de Pós-Consulta.
  // Disparo CONTROLADO do ORC para 1 paciente só (teste real). NÃO varre, NÃO enfileira.
  // dry por padrão (só ?dry=0 escreve no Kommo). Usa o consumidor REAL (mesma lógica do cron).
  if (paciente && url.searchParams.get("aplicar") === "1") {
    const dry = url.searchParams.get("dry") !== "0";
    const item = { paciente_id_cnn: paciente, tipo: "ORC", grupo: null, agenda_id_cnn: null, criado_em: Math.floor(Date.now() / 1000) };
    const resultado = await consumirItemOrcamento(item, env, target, dry);
    return Response.json({ pid: paciente, dry, target, resultado });
  }

  if (paciente && url.searchParams.get("cardalvo") === "1") {
    return Response.json({
      pid: paciente,
      card_posvenda_B: await leadAlvoOrcamento(paciente, { pipeline: PIPELINE_POS_VENDA }, env),
      card_posconsulta_A: await leadAlvoOrcamento(paciente, { pipeline: PIPELINE_POS_CONSULTA }, env),
    });
  }

  if (paciente && decidir === "1") {
    const temFutura = await temAgendaFutura(paciente, env);
    const orcs = await cnnOrcamentosDoPaciente(paciente, env, target);
    const cutoffAprov = addDiasISO(todayBRT(), -ORC_APROVACAO_MAX_DIAS);
    return Response.json({
      pid: paciente,
      temAgendaFutura: temFutura,
      cutoffAprovacao: cutoffAprov,
      orcamentos: orcs.map((o: any) => ({ id: o.id, status: o.status, dataAprovacao: o.dataAprovacao })),
      decisao: decidirEtapaOrcamento(orcamentosRecentes(orcs, cutoffAprov), temFutura),
      orcamento_sync: await getOrcamentoSync(paciente, env), // BX2: ultima_etapa=idempotência (etapa Kommo); ultimo_status=obs (status CNN)
    });
  }

  if (paciente) return Response.json(await cnnOrcamentosDoPaciente(paciente, env, target));

  const status = url.searchParams.get("status") ?? "APROVADO";
  const di = url.searchParams.get("di") ?? new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const df = url.searchParams.get("df") ?? todayBRT();
  const out: any = { target, janela: `${di}..${df}`, status, total: 0, amostra: [] as any[] };
  let pagina = 0, totalPaginas = 1;
  while (pagina < totalPaginas && orcamentoOk()) {
    const r: any = await cnnGet(
      `/orcamento/lista?dataInicial=${di}&dataFinal=${df}&tipoData=APROVACAO&status=${status}&registrosPorPagina=50&pagina=${pagina}`,
      env, target
    );
    const lista = r?.lista ?? [];
    if (lista.length === 0) break;
    out.total += lista.length;
    for (const o of lista) {
      if (out.amostra.length >= 15) continue;
      out.amostra.push({
        id: o.id,
        status: o.status,
        contrato: o.numeroContrato,
        dataAprovacao: o.dataAprovacao,
        paciente: { id: o.paciente?.id, nome: o.paciente?.nome, tel: o.paciente?.contato?.telefoneCelular },
        valorLiquido: o.valorLiquido,
        procedimentos: o.procedimentos?.map((p: any) => p.nomeProcedimento),
        produtos: o.produtos?.map((p: any) => p.nomeProduto),
      });
    }
    totalPaginas = Math.max(r?.totalPaginas ?? 1, 1);
    pagina++;
  }
  return Response.json(out);
}

// ══ /debug-nome — survey/backfill do NOME (contato = nome real do CNN; lead = nome + sufixo duplicata) ═
// Regra do dono (07/07): TODO lead precisa do nome importado. Contato SEMPRE recebe o nome
// original do paciente; o lead da DUPLICATA (card A quando existe o B do mesmo paciente) mantém
// " (duplicata)" no nome. Escopo TRAVADO: mexe SÓ no campo `name` do contato e do lead no Kommo.
// NUNCA lê/escreve outra coisa, NUNCA toca CNN (só GET /paciente/{id} p/ nome), NUNCA move/cria/deleta.
// modo=survey (read-only) mede o problema; modo=fix&dry=1 mostra o de-para; modo=fix&dry=0 aplica.
// Paginação por offset/limite; guarda de tempo (45s) p/ caber no limite da Vercel. Ritmado por `limite`.
function nomeFraco(nome: string | null | undefined, telefone = ""): boolean {
  const n = (nome ?? "").trim();
  if (!n) return true;
  if (/^paciente\b/i.test(n)) return true;              // "Paciente", "Paciente CNN 123", "Paciente 123 (duplicata)"
  if (/^lead\s*#/i.test(n)) return true;                // default do Kommo: "Lead #18151238"
  if (/^(sem\s*nome|contato\s*sem\s*nome)\b/i.test(n)) return true;
  const soDig = n.replace(/[^\d]/g, "");
  const semEspaco = n.replace(/\s/g, "");
  if (soDig && soDig === semEspaco) return true;         // nome é só dígitos
  const telDig = telefone.replace(/[^\d]/g, "");
  if (telDig && soDig && telDig.slice(-8) === soDig.slice(-8)) return true; // nome = telefone
  return false;
}
async function handleDebugNome(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const modo = url.searchParams.get("modo") ?? "survey";
  const target: CnnTarget = "production"; // nome vem do CNN de produção (só GET /paciente/{id})
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const limite = Math.min(150, Math.max(1, Number(url.searchParams.get("limite") ?? "30") || 30));
  const dry = url.searchParams.get("dry") !== "0";
  const t0 = Date.now();

  const rows = ((await env.DB.prepare(
    "SELECT paciente_id_cnn, grupo, lead_id_kommo, duplicata FROM mapeamento WHERE lead_id_kommo IS NOT NULL AND lead_id_kommo <> '' ORDER BY paciente_id_cnn, grupo LIMIT ? OFFSET ?"
  ).bind(limite, offset).all()).results ?? []) as any[];

  const out: any = {
    modo, target, dry, offset, limite,
    examinados: 0, fracos: 0, fracos_contato: 0, fracos_lead: 0, corrigidos: 0, sem_nome_cnn: 0, ja_ok: 0, erros: 0,
    amostra: [] as any[], proximo_offset: offset, fim: false,
  };

  for (const r of rows) {
    if (Date.now() - t0 > 45000) { out.parou_tempo = true; break; }
    out.examinados++;
    const leadId = String(r.lead_id_kommo);
    const pid = String(r.paciente_id_cnn);
    try {
      const lead: any = await kommoGet(`/leads/${leadId}?with=contacts`, env);
      const leadNome = String(lead?.name ?? "");
      const emb = lead?._embedded?.contacts?.[0];
      const contactId = emb?.id ? String(emb.id) : null;
      let contactNome: string | undefined = emb?.name;
      let telefone = "";
      if (contactId && contactNome === undefined) {
        const c: any = await kommoGet(`/contacts/${contactId}`, env);
        contactNome = c?.name;
        telefone = (c?.custom_fields_values ?? []).find((f: any) => f.field_code === "PHONE")?.values?.[0]?.value ?? "";
      }
      // Regra do dono (07/07): TODO campo de nome precisa estar preenchido — lead E contato,
      // duplicata ou não. Marca fraco se QUALQUER um dos dois estiver vazio/fallback.
      const contatoFraco = !!contactId && nomeFraco(contactNome, telefone);
      const leadFraco = nomeFraco(leadNome);
      if (!contatoFraco && !leadFraco) { out.ja_ok++; continue; }
      out.fracos++;
      if (contatoFraco) out.fracos_contato++;
      if (leadFraco) out.fracos_lead++;
      if (modo === "survey") {
        if (out.amostra.length < 25) out.amostra.push({ pid, grupo: r.grupo, leadId, contactId, nomeContato: contactNome ?? null, contatoFraco, nomeLead: leadNome || null, leadFraco });
        continue;
      }
      // modo=fix — fonte do nome real: CNN > contato bom > lead bom (sem sufixo). Preenche AMBOS os campos fracos.
      let real = (await cnnPacienteNome(pid, env, target))?.trim() ?? "";
      if (!real && !nomeFraco(contactNome, telefone)) real = String(contactNome ?? "").trim();
      if (!real) { const semSuf = leadNome.replace(/\s*\(duplicata\)\s*$/i, "").trim(); if (!nomeFraco(semSuf)) real = semSuf; }
      if (!real) { out.sem_nome_cnn++; if (out.amostra.length < 25) out.amostra.push({ pid, grupo: r.grupo, leadId, acao: "sem_nome", nomeContato: contactNome ?? null, nomeLead: leadNome || null }); continue; }
      // Duplicata = card A com um card B irmão do mesmo paciente (o B é o original em Pós-Venda).
      let duplicata = false;
      if (r.grupo === "A") { const b: any = await getMapeamento(pid, "B", env); duplicata = !!(b?.lead_id_kommo); }
      const leadNomeNovo = duplicata ? `${real} (duplicata)` : real;
      if (dry) {
        if (out.amostra.length < 25) out.amostra.push({ pid, grupo: r.grupo, leadId, contactId, contato_de: contactNome ?? null, contato_para: contatoFraco ? real : "(mantém)", lead_de: leadNome || null, lead_para: leadFraco ? leadNomeNovo : "(mantém)", duplicata });
        out.corrigidos++;
        continue;
      }
      if (contatoFraco && contactId) await kommoPatch(`/contacts/${contactId}`, { name: real }, env);
      if (leadFraco) await kommoPatch(`/leads/${leadId}`, { name: leadNomeNovo }, env);
      out.corrigidos++;
      if (out.amostra.length < 25) out.amostra.push({ pid, grupo: r.grupo, leadId, contato: contatoFraco ? real : "(ok)", lead: leadFraco ? leadNomeNovo : "(ok)" });
      await audit(env, { funcao: "backfill-nome", ambiente: "kommo", entidade_id: leadId, acao: "nome_corrigido", de: `${contactNome ?? ""} | ${leadNome}`, para: real, detalhe: `pid=${pid} grupo=${r.grupo} dup=${duplicata} contato=${contatoFraco} lead=${leadFraco}` });
    } catch (e) { out.erros++; if (out.amostra.length < 25) out.amostra.push({ pid, grupo: r.grupo, leadId, erro: String(e).slice(0, 140) }); }
  }
  out.proximo_offset = offset + out.examinados;
  out.fim = !out.parou_tempo && rows.length < limite;
  return Response.json(out);
}

// ══ /debug-orcamento-impacto — mede (READ-ONLY) o que o ORC faria nos APROVADOS ═
// Sem enfileirar, sem mover. Pagina os pacientes com orçamento APROVADO e classifica
// cada um pela MESMA lógica do consumidor (portão de agenda futura + portão de etapa).
// Budget-aware; use ?offset= p/ varrer em fatias (resposta traz proximo_offset/fim).
async function handleDebugOrcamentoImpacto(req: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const url = new URL(req.url);
  const target: CnnTarget = url.searchParams.get("env") === "production" ? "production" : "sandbox";
  const di = url.searchParams.get("di") ?? "2026-01-01";
  const df = url.searchParams.get("df") ?? todayBRT();
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const max = Number(url.searchParams.get("max") ?? "30");
  const cutoffAprov = addDiasISO(todayBRT(), -ORC_APROVACAO_MAX_DIAS);
  const pids = new Map<string, { tel: string; aprov: string }>(); // pid → {telefone, dataAprovacao mais recente}
  let pag = 0, totalPag = 1;
  while (pag < totalPag && orcamentoOk(48)) {
    let r: any;
    try { r = await cnnGet(`/orcamento/lista?dataInicial=${di}&dataFinal=${df}&status=APROVADO&tipoData=APROVACAO&registrosPorPagina=50&pagina=${pag}`, env, target); }
    catch { break; }
    const lista = r?.lista ?? []; if (!lista.length) break;
    for (const o of lista) {
      const pid = o?.paciente?.id != null ? String(o.paciente.id) : ""; if (!pid) continue;
      const ap = o?.dataAprovacao ?? "";
      const cur = pids.get(pid);
      if (!cur) pids.set(pid, { tel: normalizePhone(o?.paciente?.contato?.telefoneCelular ?? ""), aprov: ap });
      else if (ap > cur.aprov) cur.aprov = ap;
    }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
  }
  const todos = [...pids.entries()];
  const fatia = todos.slice(offset, offset + max);
  const out: any = { total_pacientes_aprovado: todos.length, cutoff_aprovacao: cutoffAprov, offset, processados: 0, moveria_tratamento_iniciado: 0, criaria_card_b: 0, ja_no_alvo: 0, adiado_agenda_futura: 0, nao_recente: 0, adiado_etapa: 0, por_etapa_adiada: {} as Record<string, number>, amostra: [] as any[] };
  for (const [pid, info] of fatia) {
    if (!orcamentoOk(48)) { out.parou_orcamento = true; break; }
    // Portões primeiro (D1, sem subreq): agenda futura manda; aprovação antiga não reativa.
    if (await temAgendaFutura(pid, env)) { out.adiado_agenda_futura++; out.processados++; continue; }
    if (!info.aprov || info.aprov < cutoffAprov) { out.nao_recente++; out.processados++; continue; } // aprovação antiga → não reativa
    const lead = await leadAlvoOrcamento(pid, { pipeline: PIPELINE_POS_VENDA }, env); // APROVADO→card B (group-aware)
    // Opção 2 (02/07): sem card B → o ORC CRIARIA o card cliente (não pula mais).
    if (!lead) { out.criaria_card_b++; if (out.amostra.length < 15) out.amostra.push({ pid, acao: "criaria_card_b", aprov: info.aprov }); out.processados++; continue; }
    let et = 0; try { et = Number((await kommoGet(`/leads/${lead}`, env)).status_id) || 0; } catch { /* */ }
    if (!ETAPAS_ORC_PODE_AGIR.has(et)) { out.adiado_etapa++; const n = STAGE_NOME[et] ?? String(et); out.por_etapa_adiada[n] = (out.por_etapa_adiada[n] ?? 0) + 1; out.processados++; continue; }
    if (et === STAGE_POS_TRATAMENTO_INICIADO) { out.ja_no_alvo++; out.processados++; continue; }
    out.moveria_tratamento_iniciado++;
    if (out.amostra.length < 15) out.amostra.push({ pid, lead, de: STAGE_NOME[et] ?? et, aprov: info.aprov });
    out.processados++;
  }
  out.proximo_offset = offset + fatia.length; out.fim = out.proximo_offset >= todos.length;
  return Response.json(out);
}

// ══ /debug-selftest — bateria de asserções in-code (modes: logic|fuzz|stress) ═
// PURA + em memória: NÃO chama cnnGet/kommoGet/env.DB (por isso nem recebe `env`
// — impossível tocar I/O por engano). Roda sob `wrangler dev --local`, sem
// secrets. Ver metodologia docs/superpowers/plans/2026-07-01-reflexo-orcamento-
// TESTES.md (N1/N2/N3). Testa o CÓDIGO REAL (decidirEtapaOrcamento,
// ETAPAS_ORC_PODE_AGIR, addDiasISO) — não duplica a lógica de decisão.
type SelftestFalha = { caso: string; esperado: unknown; obtido: unknown };
type SelftestResultado = { mode: string; passed: number; failed: number; total: number; falhas: SelftestFalha[] };

function selftestAssert(
  acc: { passed: number; failed: number; falhas: SelftestFalha[] },
  caso: string, esperado: unknown, obtido: unknown
): void {
  const ok = JSON.stringify(esperado) === JSON.stringify(obtido);
  if (ok) acc.passed++;
  else { acc.failed++; acc.falhas.push({ caso, esperado, obtido }); }
}

// ── N1: lógica pura — matriz decidirEtapaOrcamento + portão + expiração + cursor ──
function runSelftestLogic(): SelftestResultado {
  const acc = { passed: 0, failed: 0, falhas: [] as SelftestFalha[] };

  type CasoDecisao = { nome: string; orcamentos: any[]; temFutura: boolean; esperado: { pipeline: number; status: number } | null };
  const casos: CasoDecisao[] = [
    { nome: "[]→null (nada a refletir)", orcamentos: [], temFutura: false, esperado: null },
    { nome: "[ABERTO]→Em Análise", orcamentos: [{ id: 1, status: "ABERTO" }], temFutura: false,
      esperado: { pipeline: PIPELINE_POS_CONSULTA, status: STAGE_POSCONS_EM_ANALISE } },
    { nome: "[CANCELADO]→Venda Perdida", orcamentos: [{ id: 1, status: "CANCELADO" }], temFutura: false,
      esperado: { pipeline: PIPELINE_POS_CONSULTA, status: STAGE_POSCONS_VENDA_PERDIDA } },
    { nome: "[PERDIDO]→Venda Perdida", orcamentos: [{ id: 1, status: "PERDIDO" }], temFutura: false,
      esperado: { pipeline: PIPELINE_POS_CONSULTA, status: STAGE_POSCONS_VENDA_PERDIDA } },
    { nome: "[APROVADO]→Tratamento Iniciado", orcamentos: [{ id: 1, status: "APROVADO" }], temFutura: false,
      esperado: { pipeline: PIPELINE_POS_VENDA, status: STAGE_POS_TRATAMENTO_INICIADO } },
    { nome: "[ABERTO,APROVADO]→Tratamento Iniciado (aprovado vence recência)",
      orcamentos: [{ id: 1, status: "ABERTO" }, { id: 2, status: "APROVADO" }], temFutura: false,
      esperado: { pipeline: PIPELINE_POS_VENDA, status: STAGE_POS_TRATAMENTO_INICIADO } },
    { nome: "[ABERTO(id=9),CANCELADO(id=10)]→Venda Perdida (mais recente por id)",
      orcamentos: [{ id: 9, status: "ABERTO" }, { id: 10, status: "CANCELADO" }], temFutura: false,
      esperado: { pipeline: PIPELINE_POS_CONSULTA, status: STAGE_POSCONS_VENDA_PERDIDA } },
    { nome: "temFutura=true + []→null (portão)", orcamentos: [], temFutura: true, esperado: null },
    { nome: "temFutura=true + [ABERTO]→null (portão)", orcamentos: [{ id: 1, status: "ABERTO" }], temFutura: true, esperado: null },
    { nome: "temFutura=true + [APROVADO]→null (portão vence até aprovado)", orcamentos: [{ id: 1, status: "APROVADO" }], temFutura: true, esperado: null },
    { nome: "temFutura=true + [CANCELADO,APROVADO]→null (portão, qualquer combo)",
      orcamentos: [{ id: 1, status: "CANCELADO" }, { id: 2, status: "APROVADO" }], temFutura: true, esperado: null },
  ];
  for (const c of casos) selftestAssert(acc, `decidirEtapaOrcamento:${c.nome}`, c.esperado, decidirEtapaOrcamento(c.orcamentos, c.temFutura));

  // ── Portão ETAPAS_ORC_PODE_AGIR: age (consulta já assentou) vs adia ──
  const age: Array<[string, number]> = [
    ["Avaliação Realizada", STAGE_AVALIACAO_REALIZADA],
    ["Tratamento Proposto", STAGE_TRATAMENTO_PROPOSTO],
    ["Pós-Consulta: Em Análise", STAGE_POSCONS_EM_ANALISE],
    ["Pós-Venda: Tratamento Iniciado", STAGE_POS_TRATAMENTO_INICIADO],
    ["Pós-Consulta: Venda Perdida", STAGE_POSCONS_VENDA_PERDIDA],
  ];
  for (const [nome, stage] of age) selftestAssert(acc, `gate ETAPAS_ORC_PODE_AGIR:AGE:${nome}`, true, ETAPAS_ORC_PODE_AGIR.has(stage));
  const adia: Array<[string, number]> = [
    ["Leads/Entrada", STAGE_LEADS_ENTRADA],
    ["Primeiro Contato", STAGE_PRIMEIRO_CONTATO],
    ["Consulta Agendada", STAGE_CONSULTA_AGENDADA],
    ["Confirmação de Consulta", STAGE_CONFIRMACAO_CONSULTA],
    ["Consulta Confirmada", STAGE_CONSULTA_CONFIRMADA],
    ["Pós-Venda: Cliente Ativo", STAGE_POS_CLIENTE_ATIVO],
    ["Pós-Venda: Confirmação Agend", STAGE_POS_CONFIRMACAO_AGEND],
  ];
  for (const [nome, stage] of adia) selftestAssert(acc, `gate ETAPAS_ORC_PODE_AGIR:ADIA:${nome}`, false, ETAPAS_ORC_PODE_AGIR.has(stage));

  // ── Expiração idadeSeg > 1200 ──────────────────────────────────────────────
  // NOTA (limitação conhecida): o branch real vive em consumirItemOrcamento
  // (~L1936), função com I/O (cnnGet/kommoGet) — não é chamável em modo puro.
  // O limiar abaixo é um MIRROR do literal `1200` no código-fonte (não lido
  // dinamicamente); se o literal mudar sem atualizar este mirror, este teste
  // diverge silenciosamente. Cobertura ao vivo do branch real: N6.
  const GIVEUP_SEG_MIRROR = 1200;
  const giveup = (idadeSeg: number) => idadeSeg > GIVEUP_SEG_MIRROR;
  selftestAssert(acc, "expiração:1199s → ainda adiado (não expira)", false, giveup(1199));
  selftestAssert(acc, "expiração:1200s → ainda adiado (limite exato, > estrito)", false, giveup(1200));
  selftestAssert(acc, "expiração:1201s → adiado_expirado (desiste)", true, giveup(1201));

  // ── addDiasISO: soma real + reset de cursor ao passar de hoje ───────────────
  selftestAssert(acc, "addDiasISO:+7d simples", "2026-01-08", addDiasISO("2026-01-01", 7));
  selftestAssert(acc, "addDiasISO:+7d rollover de mês", "2026-02-01", addDiasISO("2026-01-25", 7));
  selftestAssert(acc, "addDiasISO:+7d rollover de ano", "2027-01-04", addDiasISO("2026-12-28", 7));
  {
    // Mirror das 2 linhas de reset em produtorOrcamento (usa addDiasISO REAL +
    // ORC_CRIACAO_STEP_DIAS REAL; só a comparação/reatribuição é reimplementada
    // — produtorOrcamento em si tem I/O, não é chamável em modo puro).
    const hoje = "2026-07-01", anchor = "2024-07-02", diCria = "2026-06-28";
    let proximoCursor = addDiasISO(diCria, ORC_CRIACAO_STEP_DIAS);
    if (proximoCursor > hoje) proximoCursor = anchor;
    selftestAssert(acc, "addDiasISO:reset do cursor ao passar de hoje (loop perpétuo)", anchor, proximoCursor);
  }
  selftestAssert(acc, "ORC_CRIACAO_LOOKBACK_DIAS === 730 (janela de trás)", 730, ORC_CRIACAO_LOOKBACK_DIAS);

  // ── Chave dedup: formato ORC:pid:YYYY-MM-DD ─────────────────────────────────
  const hoje = todayBRT();
  selftestAssert(acc, "dedupKey:todayBRT() produz YYYY-MM-DD", true, /^\d{4}-\d{2}-\d{2}$/.test(hoje));
  selftestAssert(acc, "dedupKey:formato ORC:pid:YYYY-MM-DD", true, /^ORC:[^:]+:\d{4}-\d{2}-\d{2}$/.test(`ORC:12345:${hoje}`));

  // ── 3 webhooks Kommo→CNN (spec 2026-07-05): anti-loop (decidirSupressao) ──
  const dsE = (i: IntencaoCnn, e: any) => decidirSupressao(i, e).executa;
  selftestAssert(acc, "decidirSupressao:CONFIRMAR sem estado → executa", true, dsE({ tipo: "CNN_CONFIRMAR" }, null));
  selftestAssert(acc, "decidirSupressao:CONFIRMAR já CONFIRMADO_PACIENTE → suprime", false, dsE({ tipo: "CNN_CONFIRMAR" }, { last_cnn_status: "CONFIRMADO_PACIENTE" }));
  selftestAssert(acc, "decidirSupressao:CONFIRMAR estado AGENDADO → executa", true, dsE({ tipo: "CNN_CONFIRMAR" }, { last_cnn_status: "AGENDADO" }));
  selftestAssert(acc, "decidirSupressao:AGENDAR card sem agenda → executa", true, dsE({ tipo: "CNN_AGENDAR", ts: 1000, temAgendaNoCard: false }, null));
  selftestAssert(acc, "decidirSupressao:AGENDAR com agenda + ts igual → suprime (loop confirmação)", false, dsE({ tipo: "CNN_AGENDAR", ts: 1000, temAgendaNoCard: true }, { last_agendamento_ts: 1000 }));
  selftestAssert(acc, "decidirSupressao:AGENDAR com agenda + ts novo → executa", true, dsE({ tipo: "CNN_AGENDAR", ts: 9999, temAgendaNoCard: true }, { last_agendamento_ts: 1000 }));

  // ── allowlist de escrita CNN produção (cnnProducaoPermitido) ──
  selftestAssert(acc, "allowlist:POST /agenda/novo → permite", true, cnnProducaoPermitido("POST", "/agenda/novo"));
  selftestAssert(acc, "allowlist:PUT alteracao-status CONFIRMADO_PACIENTE → permite", true, cnnProducaoPermitido("PUT", "/agenda/alteracao-status", "CONFIRMADO_PACIENTE"));
  selftestAssert(acc, "allowlist:PUT alteracao-status AGENDADO → permite", true, cnnProducaoPermitido("PUT", "/agenda/alteracao-status", "AGENDADO"));
  selftestAssert(acc, "allowlist:PUT alteracao-status CANCELADO → BLOQUEIA (fora do objetivo)", false, cnnProducaoPermitido("PUT", "/agenda/alteracao-status", "CANCELADO"));
  selftestAssert(acc, "allowlist:PUT alteracao-status sem status → BLOQUEIA", false, cnnProducaoPermitido("PUT", "/agenda/alteracao-status"));
  selftestAssert(acc, "allowlist:POST /agenda/123/remarcar → permite", true, cnnProducaoPermitido("POST", "/agenda/123/remarcar"));
  selftestAssert(acc, "allowlist:POST /convenio-paciente/associar → permite", true, cnnProducaoPermitido("POST", "/convenio-paciente/associar"));
  selftestAssert(acc, "allowlist:query string ignorada (/agenda/novo?x=1)", true, cnnProducaoPermitido("POST", "/agenda/novo?x=1"));
  selftestAssert(acc, "allowlist:DELETE /paciente/1 → BLOQUEIA", false, cnnProducaoPermitido("DELETE", "/paciente/1"));
  selftestAssert(acc, "allowlist:POST /paciente/novo → permite (W1/F.Captura, 1º contato)", true, cnnProducaoPermitido("POST", "/paciente/novo"));
  selftestAssert(acc, "allowlist:POST /orcamento/novo → BLOQUEIA", false, cnnProducaoPermitido("POST", "/orcamento/novo"));
  selftestAssert(acc, "allowlist:PUT /paciente/1 → BLOQUEIA", false, cnnProducaoPermitido("PUT", "/paciente/1"));
  selftestAssert(acc, "allowlist:DELETE /agenda/1 → BLOQUEIA (nunca apaga)", false, cnnProducaoPermitido("DELETE", "/agenda/1"));

  // ── GUARDRAIL ABSOLUTO: jamais deletar/alterar paciente no CNN, em NENHUM ambiente (sandbox E produção) ──
  const cnnLanca = (fn: () => void) => { try { fn(); return false; } catch { return true; } };
  selftestAssert(acc, "guardrail:DELETE /paciente/1 sandbox → LANÇA", true, cnnLanca(() => assertCnnWritable("sandbox", "DELETE", "/paciente/1")));
  selftestAssert(acc, "guardrail:DELETE /paciente/1 production → LANÇA", true, cnnLanca(() => assertCnnWritable("production", "DELETE", "/paciente/1")));
  selftestAssert(acc, "guardrail:DELETE /agenda/1 sandbox → LANÇA (nunca apaga nada)", true, cnnLanca(() => assertCnnWritable("sandbox", "DELETE", "/agenda/1")));
  selftestAssert(acc, "guardrail:PUT /paciente/1 sandbox → LANÇA (não altera paciente)", true, cnnLanca(() => assertCnnWritable("sandbox", "PUT", "/paciente/1")));
  selftestAssert(acc, "guardrail:GET /paciente/1 → NÃO lança (leitura permitida)", false, cnnLanca(() => assertCnnWritable("sandbox", "GET", "/paciente/1")));

  // ── config de criação de agenda por ambiente (bug sandbox×produção, 07/07) ──
  selftestAssert(acc, "cfg:convênio produção = 27603", 27603, cnnConvenioParticular({} as any, "production"));
  selftestAssert(acc, "cfg:convênio sandbox = 56545", 56545, cnnConvenioParticular({} as any, "sandbox"));
  selftestAssert(acc, "cfg:localAgenda produção = 19775", 19775, cnnLocalAgenda({} as any, "production"));
  selftestAssert(acc, "cfg:localAgenda sandbox = 41170", 41170, cnnLocalAgenda({} as any, "sandbox"));
  selftestAssert(acc, "cfg:tipoProc produção = 381357", 381357, cnnTipoProcedimento({} as any, "production"));
  selftestAssert(acc, "cfg:tipoProc sandbox = 1011844", 1011844, cnnTipoProcedimento({} as any, "sandbox"));
  selftestAssert(acc, "cfg:localAgenda produção overridável por env", 19779, cnnLocalAgenda({ CNN_LOCAL_AGENDA_PRODUCTION: "19779" } as any, "production"));
  selftestAssert(acc, "cfg:tipoConsultaCaptura produção = 66666 (Consulta/Avaliação)", 66666, cnnTipoConsultaCaptura({} as any, "production"));
  selftestAssert(acc, "cfg:procedimentoCaptura produção = 361025 (Av Capilar)", 361025, cnnProcedimentoCaptura({} as any, "production"));
  // ── correlação WH2: opção do card → procedimento CNN ──
  selftestAssert(acc, "corr:Celulite → Av Celulite 381386", 381386, procedimentosCnnDoCard(["Celulite"])[0] ?? 0);
  selftestAssert(acc, "corr:Botox → Av Botox 381357", 381357, procedimentosCnnDoCard(["Botox"])[0] ?? 0);
  selftestAssert(acc, "corr:Olheiras / Bléfaro → Av Olheiras 381397", 381397, procedimentosCnnDoCard(["Olheiras / Bléfaro"])[0] ?? 0);
  selftestAssert(acc, "corr:sem match (Lipedema) → vazio", 0, procedimentosCnnDoCard(["Lipedema"]).length);
  selftestAssert(acc, "corr:multi (Celulite+Botox) → 2 ids", 2, procedimentosCnnDoCard(["Celulite", "Botox"]).length);

  return { mode: "logic", passed: acc.passed, failed: acc.failed, total: acc.passed + acc.failed, falhas: acc.falhas };
}

// ── N2: fuzz/adversarial — decidirEtapaOrcamento não deve lançar exceção ──────
function runSelftestFuzz(): SelftestResultado {
  const acc = { passed: 0, failed: 0, falhas: [] as SelftestFalha[] };
  const isDecisaoValida = (v: any): boolean =>
    v === null || (typeof v === "object" && typeof v.pipeline === "number" && typeof v.status === "number");

  const tentar = (nome: string, orcamentos: any[], temFutura: boolean): any => {
    let resultado: any;
    let excecao = "nenhuma";
    try { resultado = decidirEtapaOrcamento(orcamentos, temFutura); }
    catch (e) { excecao = `lançou: ${String(e)}`; }
    selftestAssert(acc, `fuzz:${nome}:sem exceção`, "nenhuma", excecao);
    if (excecao === "nenhuma") selftestAssert(acc, `fuzz:${nome}:shape válido (null | {pipeline,status})`, true, isDecisaoValida(resultado));
    return resultado;
  };

  tentar("lista vazia", [], false);
  tentar("orçamento sem id (2 itens, exercita o reduce)", [{ status: "ABERTO" }, { status: "CANCELADO" }], false);
  tentar("id não-numérico 'abc' (2 itens, exercita o reduce)", [{ id: "abc", status: "ABERTO" }, { id: "xyz", status: "CANCELADO" }], false);
  tentar("status desconhecido", [{ id: 1, status: "QUALQUER_COISA" }], false);
  tentar("status null", [{ id: 1, status: null }], false);
  tentar("status faltando", [{ id: 1 }], false);
  tentar("paciente undefined", [{ id: 1, status: "ABERTO", paciente: undefined }], false);
  tentar("contato undefined", [{ id: 1, status: "ABERTO", paciente: { id: 5, contato: undefined } }], false);
  tentar("procedimentos/produtos undefined", [{ id: 1, status: "APROVADO", procedimentos: undefined, produtos: undefined }], false);

  const decisaoMinuscula = tentar("status minúsculo 'aprovado'", [{ id: 1, status: "aprovado" }], false);
  const contouComoAprovado = !!decisaoMinuscula && decisaoMinuscula.status === STAGE_POS_TRATAMENTO_INICIADO;
  selftestAssert(acc, "case-sensitive:'aprovado' minúsculo NÃO conta como APROVADO (comportamento atual — flag se mudar)", false, contouComoAprovado);

  const grande: any[] = [];
  for (let i = 0; i < 5000; i++) {
    const status = i % 5 === 0 ? "CANCELADO" : i % 3 === 0 ? "PERDIDO" : "ABERTO"; // sem APROVADO: força some()+reduce() a varrer os 5000
    grande.push({ id: i, status });
  }
  tentar("lista com 5000 itens", grande, false);

  return { mode: "fuzz", passed: acc.passed, failed: acc.failed, total: acc.passed + acc.failed, falhas: acc.falhas };
}

// ── N3: stress da fila + budget — produtor→fila→consumidor, tudo mock/em memória ──
// Reusa a função REAL decidirEtapaOrcamento + o portão REAL ETAPAS_ORC_PODE_AGIR.
// Fila, orcamento_sync, subreq e relógio são 100% simulados (sem D1/CNN/Kommo).
const ETAPAS_NAO_ASSENTADAS_SIM = [
  STAGE_LEADS_ENTRADA, STAGE_PRIMEIRO_CONTATO, STAGE_CONSULTA_AGENDADA,
  STAGE_CONFIRMACAO_CONSULTA, STAGE_CONSULTA_CONFIRMADA,
  STAGE_POS_CLIENTE_ATIVO, STAGE_POS_CONFIRMACAO_AGEND,
];
const ETAPAS_ASSENTADAS_SIM = [STAGE_AVALIACAO_REALIZADA, STAGE_TRATAMENTO_PROPOSTO];
const ORC_PALETTE_SIM: Array<Array<{ id: number; status: string }>> = [
  [], [{ id: 1, status: "ABERTO" }], [{ id: 1, status: "APROVADO" }], [{ id: 1, status: "CANCELADO" }],
  [{ id: 1, status: "ABERTO" }, { id: 2, status: "APROVADO" }],
  [{ id: 9, status: "ABERTO" }, { id: 10, status: "CANCELADO" }],
];

type SimPatient = {
  pid: string; orcamentos: Array<{ id: number; status: string }>; currentStage: number;
  agendaFutura: boolean; temA3Par: boolean;
  settleTick: number | null; resolveTick: number | null; resolveResult: string | null;
};
type SimQueueItem = {
  id: number; tipo: "A3" | "ORC"; grupo?: "A" | "B"; pid: string;
  status: "pendente" | "feito"; criadoEm: number; ultimoResultado?: string;
};

// Gera n pacientes sintéticos com mistura determinística de cenários:
//  i=1,3   → não-assentado + par A3 (assenta e abre o portão — probe INV4)
//  i=2,4   → não-assentado SEM par (nunca assenta — expira ~20min — probe INV3)
//  i=5     → orçamento vazio em etapa não-assentada (nada a refletir de qualquer forma)
//  i%25=0  → agenda futura (portão fechado por agendamento, não por etapa)
//  i%3=0   → mais volume não-assentado (escala com n)
//  demais  → já assentado (resolve de cara: movido/sem_mudança)
function gerarPacientesSim(n: number): SimPatient[] {
  const pacientes: SimPatient[] = [];
  for (let i = 0; i < n; i++) {
    let orcamentos = ORC_PALETTE_SIM[i % ORC_PALETTE_SIM.length];
    let stage = ETAPAS_ASSENTADAS_SIM[i % ETAPAS_ASSENTADAS_SIM.length];
    let agendaFutura = false;
    let temA3Par = false;

    if (i === 1 || i === 3) {
      orcamentos = [{ id: 1, status: "ABERTO" }];
      stage = ETAPAS_NAO_ASSENTADAS_SIM[i % ETAPAS_NAO_ASSENTADAS_SIM.length];
      temA3Par = true;
    } else if (i === 2 || i === 4) {
      orcamentos = [{ id: 1, status: "APROVADO" }];
      stage = ETAPAS_NAO_ASSENTADAS_SIM[i % ETAPAS_NAO_ASSENTADAS_SIM.length];
    } else if (i === 5) {
      orcamentos = [];
      stage = ETAPAS_NAO_ASSENTADAS_SIM[0];
    } else if (i % 25 === 0) {
      agendaFutura = true;
    } else if (i % 3 === 0) {
      stage = ETAPAS_NAO_ASSENTADAS_SIM[i % ETAPAS_NAO_ASSENTADAS_SIM.length];
    }

    pacientes.push({
      pid: `sim-${i}`, orcamentos, currentStage: stage, agendaFutura, temA3Par,
      settleTick: null, resolveTick: null, resolveResult: null,
    });
  }
  return pacientes;
}

// Ordem de bucket (mirror da SQL real de filaPuxarPendentes: `ORDER BY (CASE
// WHEN grupo='B' THEN 0 WHEN tipo='ORC' THEN 2 ELSE 1 END), id`) — grupo B
// primeiro, depois A3/F2 (grupo A ou sem grupo), ORC sempre por último.
function bucketPrioridadeSim(item: SimQueueItem): number {
  if (item.grupo === "B") return 0;
  if (item.tipo === "ORC") return 2;
  return 1;
}

// Mock do consumidor ORC — mesma árvore de decisão de consumirItemOrcamento,
// mas com I/O trocado por mocks (chamador injeta estado/relógio). Usa a função
// REAL decidirEtapaOrcamento e o portão REAL ETAPAS_ORC_PODE_AGIR.
function simConsumirOrc(
  p: SimPatient, criadoEm: number, agora: number,
  syncMap: Map<string, { ultimo_status: string | null; ultima_etapa: number | null }>
): { r: string; custo: number } {
  let custo = 1; // ~ cnnOrcamentosDoPaciente (1 fetch mockado)
  const decisao = decidirEtapaOrcamento(p.orcamentos, p.agendaFutura); // função REAL
  const resumo: string | null = p.orcamentos.some((o) => o.status === "APROVADO")
    ? "APROVADO"
    : (p.orcamentos.length ? p.orcamentos.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a)).status : null);
  const est = syncMap.get(p.pid) ?? null;

  if (decisao === null) {
    syncMap.set(p.pid, { ultimo_status: resumo, ultima_etapa: null });
    return { r: "sem_mudanca", custo };
  }
  if (est && est.ultima_etapa === decisao.status) return { r: "sem_mudanca", custo };

  custo += 1; // ~ kommoGet(lead) p/ etapaAtual
  if (!ETAPAS_ORC_PODE_AGIR.has(p.currentStage)) { // portão REAL (GATE C1)
    const idadeSeg = criadoEm ? agora - criadoEm : 0;
    return idadeSeg > 1200 ? { r: "adiado_expirado", custo } : { r: "adiado", custo };
  }
  if (p.currentStage === decisao.status) {
    syncMap.set(p.pid, { ultimo_status: resumo, ultima_etapa: decisao.status });
    return { r: "sem_mudanca", custo };
  }
  custo += 1; // ~ moveLeadToStage
  p.currentStage = decisao.status;
  syncMap.set(p.pid, { ultimo_status: resumo, ultima_etapa: decisao.status });
  return { r: "movido", custo };
}

function runSelftestStress(n: number): SelftestResultado & { detalhes: any } {
  const acc = { passed: 0, failed: 0, falhas: [] as SelftestFalha[] };
  const CAP = n + 10;          // generoso de propósito: isola o teste do orçamento
                                // real (D1 não conta subreq — cap só limita a leitura).
  const BUDGET = 40;           // mesmo default de produção (scheduled(): consumirFila(...,10,40)).
  const TICK_STEP_SEG = 60;    // 1 tick ~ 1 min de cron real.
  const TICKS = Math.max(150, Math.ceil(n / 8) + 50); // teto seguro p/ drenar + expirar (~20 ticks) mesmo em n=1000.

  const pacientes = gerarPacientesSim(n);
  const byPid = new Map<string, SimPatient>(pacientes.map((p) => [p.pid, p]));
  const syncMap = new Map<string, { ultimo_status: string | null; ultima_etapa: number | null }>();

  let clock = 1_800_000_000; // epoch simulado arbitrário
  let nextId = 1;
  const fila: SimQueueItem[] = [];
  for (const p of pacientes) {
    fila.push({ id: nextId++, tipo: "ORC", pid: p.pid, status: "pendente", criadoEm: clock });
    if (p.temA3Par) fila.push({ id: nextId++, tipo: "A3", grupo: "A", pid: p.pid, status: "pendente", criadoEm: clock });
  }
  const totalInicial = fila.length;

  let maxSubreqPorTick = 0;
  let violacaoOrdemBucket = false;
  let ticksExecutados = 0;

  for (let tick = 0; tick < TICKS; tick++) {
    ticksExecutados++;
    const pendentes = fila.filter((it) => it.status === "pendente");
    if (pendentes.length === 0) break;

    const ordenados = [...pendentes].sort((a, b) => bucketPrioridadeSim(a) - bucketPrioridadeSim(b) || a.id - b.id);
    const idxPrimeiroOrc = ordenados.findIndex((it) => it.tipo === "ORC");
    const idxUltimoA3 = ordenados.reduce((m, it, idx) => (it.tipo === "A3" ? idx : m), -1);
    if (idxPrimeiroOrc !== -1 && idxUltimoA3 > idxPrimeiroOrc) violacaoOrdemBucket = true;

    let subreqTick = 0;
    for (const item of ordenados.slice(0, CAP)) {
      if (subreqTick >= BUDGET) break; // ~ orcamentoOk(budget) real: para o resto do lote (fica pendente)
      const p = byPid.get(item.pid);
      if (!p) continue;
      if (item.tipo === "A3") {
        subreqTick += 1;
        p.currentStage = STAGE_AVALIACAO_REALIZADA; // simula o A3 assentando a consulta (Finalizado→Avaliação)
        item.status = "feito";
        p.settleTick = tick;
      } else {
        const { r, custo } = simConsumirOrc(p, item.criadoEm, clock, syncMap);
        subreqTick += custo;
        item.ultimoResultado = r;
        if (r !== "adiado") item.status = "feito"; // mesma guarda de consumirFila
        if (r === "movido" || r === "sem_mudanca" || r === "adiado_expirado") {
          p.resolveTick = tick;
          p.resolveResult = r;
        }
      }
    }
    maxSubreqPorTick = Math.max(maxSubreqPorTick, subreqTick);
    clock += TICK_STEP_SEG;
  }

  const pendentesFinal = fila.filter((it) => it.status === "pendente").length;

  // INV1 — orçamento de subreq nunca passa de 50/invocação (tick)
  selftestAssert(acc, "INV1:subreq máximo por tick <= 50", true, maxSubreqPorTick <= 50);
  // INV2 — A3/F2 sempre drenados antes de qualquer ORC (ordem de bucket)
  selftestAssert(acc, "INV2:nenhum ORC ordenado antes de A3/grupoB pendente", true, !violacaoOrdemBucket);
  // INV3 — adiado é limitado: fila 100% drenada após passar da expiração (~20min sim.), sem crescer sem limite
  selftestAssert(acc, "INV3:fila 100% drenada após ticks suficientes (nada fica adiado p/ sempre)", 0, pendentesFinal);
  selftestAssert(acc, "INV3b:fila nunca ultrapassa o total inicial (sem itens fantasma/duplicados)", true, fila.length === totalInicial);
  // INV4 — anti-deadlock: A3 abre o portão, ORC pareado resolve (não trava até o giveup)
  const pareados = pacientes.filter((p) => p.temA3Par);
  const travados = pareados.filter((p) => !(
    p.settleTick !== null && p.resolveTick !== null && p.resolveTick >= p.settleTick &&
    (p.resolveResult === "movido" || p.resolveResult === "sem_mudanca")
  ));
  selftestAssert(acc, "INV4:setup contém cenário pareado A3+ORC (não é vácuo)", true, pareados.length > 0);
  selftestAssert(acc, "INV4:todo par A3+ORC resolve após o assentamento (sem travar)", 0, travados.length);

  // INV5 — idempotência: pacientes FRESCOS (desacoplados da simulação principal
  // acima), 2 chamadas seguidas ao consumidor no mesmo estado → 0 move duplicado.
  const pacientesFrescos = gerarPacientesSim(n);
  let movesDuplicados = 0;
  for (const p of pacientesFrescos) {
    const syncIdem = new Map<string, { ultimo_status: string | null; ultima_etapa: number | null }>();
    const r1 = simConsumirOrc(p, clock, clock, syncIdem).r;
    const r2 = simConsumirOrc(p, clock, clock, syncIdem).r;
    if (r1 === "movido" && r2 === "movido") movesDuplicados++;
  }
  selftestAssert(acc, "INV5:2 chamadas seguidas (mesmo estado, pacientes frescos) → 0 move duplicado", 0, movesDuplicados);

  return {
    mode: "stress", passed: acc.passed, failed: acc.failed, total: acc.passed + acc.failed, falhas: acc.falhas,
    detalhes: {
      n, cap: CAP, budget: BUDGET, ticksExecutados, ticksDisponiveis: TICKS,
      totalInicialFila: totalInicial, pendentesFinal, maxSubreqPorTick,
      pareadosA3: pareados.length, travados: travados.length,
    },
  };
}

// ══ /debug-retry-selftest — prova o helper de retry (A4) 100% em memória ══════
// fetch INJETADO (nenhuma chamada real a CNN/Kommo); sleep instantâneo que só
// contabiliza waited_ms. Cada cenário roda fetchComRetry e mede {attempts, waited_ms,
// final_status, threw} + valida a expectativa do critério de aceite.
type PassoMock = { status?: number; ra?: number | string; throw?: boolean };
function mockDoFetch(seq: PassoMock[]): () => Promise<Response> {
  let i = 0;
  return () => {
    const p = seq[Math.min(i, seq.length - 1)]; i++;
    if (p.throw) return Promise.reject(new Error("rede simulada"));
    const h = new Headers();
    if (p.ra != null) h.set("Retry-After", String(p.ra));
    return Promise.resolve(new Response(null, { status: p.status ?? 200, headers: h }));
  };
}
async function corrRetry(seq: PassoMock[], idempotente = true): Promise<any> {
  let attempts = 0, waited = 0, threw = false;
  let final_status: number | string = 0;
  try {
    const r = await fetchComRetry(mockDoFetch(seq), {
      sleep: async (ms: number) => { waited += ms; }, // instantâneo; só mede
      onTentativa: () => { attempts++; },
      podeRetentar: () => true,
      idempotente,
    });
    final_status = r.status;
  } catch { threw = true; final_status = "threw"; }
  return { attempts, waited_ms: waited, final_status, threw };
}
async function runRetrySelftest(): Promise<any> {
  const cenarios: any[] = [];
  const add = async (nome: string, seq: PassoMock[], expect: (r: any) => boolean) => {
    const r = await corrRetry(seq); r.nome = nome; r.pass = expect(r); cenarios.push(r);
  };
  const addPost = async (nome: string, seq: PassoMock[], expect: (r: any) => boolean) => {
    const r = await corrRetry(seq, false); r.nome = nome; r.pass = expect(r); cenarios.push(r); // idempotente=false (POST)
  };
  // Critério 2: Retry-After respeitado; backoff default sem header.
  await add("429_ra1_then_200", [{ status: 429, ra: 1 }, { status: 200 }], (r) => r.attempts === 2 && !r.threw && r.waited_ms >= 1000 && r.waited_ms < 2000);
  await add("503_noRA_then_200", [{ status: 503 }, { status: 200 }], (r) => r.attempts === 2 && !r.threw && r.final_status === 200 && r.waited_ms === 500);
  // Critério 3: transitórios retriam até o teto; permanentes NÃO retriam (attempts==1).
  await add("502_then_200", [{ status: 502 }, { status: 200 }], (r) => r.attempts === 2 && !r.threw);
  await add("504_then_200", [{ status: 504 }, { status: 200 }], (r) => r.attempts === 2 && !r.threw);
  await add("404_permanente", [{ status: 404 }], (r) => r.attempts === 1 && r.final_status === 404 && !r.threw);
  await add("400_permanente", [{ status: 400 }], (r) => r.attempts === 1 && r.final_status === 400);
  await add("401_permanente", [{ status: 401 }], (r) => r.attempts === 1 && r.final_status === 401);
  await add("403_permanente", [{ status: 403 }], (r) => r.attempts === 1 && r.final_status === 403);
  await add("429_sempre_esgota", [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }], (r) => r.attempts === 4 && r.threw);
  await add("rede_throw_then_200", [{ throw: true }, { status: 200 }], (r) => r.attempts === 2 && !r.threw);
  await add("rede_sempre_esgota", [{ throw: true }], (r) => r.attempts === 4 && r.threw);
  // A4 POST não-idempotente (kommoPost/cnnPost): SÓ re-tenta 429; NUNCA 5xx/rede (evita duplicar card).
  await addPost("POST_429_then_200", [{ status: 429, ra: 1 }, { status: 200 }], (r) => r.attempts === 2 && !r.threw && r.final_status === 200); // 429 = rejeitado → seguro re-tentar
  await addPost("POST_502_nao_retenta", [{ status: 502 }, { status: 200 }], (r) => r.attempts === 1 && r.final_status === 502); // 5xx pode ter executado → devolve, NÃO re-tenta
  await addPost("POST_503_nao_retenta", [{ status: 503 }, { status: 200 }], (r) => r.attempts === 1 && r.final_status === 503);
  await addPost("POST_504_nao_retenta", [{ status: 504 }, { status: 200 }], (r) => r.attempts === 1 && r.final_status === 504);
  await addPost("POST_rede_nao_retenta", [{ throw: true }, { status: 200 }], (r) => r.attempts === 1 && r.threw); // rede pode ter executado → relança, NÃO re-tenta
  await addPost("POST_200_ok", [{ status: 200 }], (r) => r.attempts === 1 && r.final_status === 200);
  // Classificação usada pela fila (critério 4): marca do erro esgotado é transitória;
  // erro de wrapper permanente (ex. 404) NÃO é transitório.
  const classif = {
    transitorio_esgotado: ehTransitorio(`${MARCA_TRANSITORIO} HTTP 429`) === true,
    permanente_404: ehTransitorio("CNN GET /paciente/9 → 404") === false,
  };
  const pass = cenarios.every((c) => c.pass) && classif.transitorio_esgotado && classif.permanente_404;
  return { pass, total: cenarios.length, classif, cenarios };
}

// ── Setup do webhook 2: cria o campo select "Tipo Procedimento CNN" no Kommo (idempotente) ──
// Cada opção mapeia p/ um idTipoConsulta do CNN (ver TIPO_PROCEDIMENTO_CNN). Rodar 1× antes de ligar WH2.
async function handleWhCriarCampo(env: Env): Promise<Response> {
  const nome = "Tipo Procedimento CNN";
  const atual = await resolveFields(env);
  if (atual[nome]) return Response.json({ ok: true, ja_existe: true, field_id: atual[nome], mapa: TIPO_PROCEDIMENTO_CNN });
  const opcoes = ["Procedimento", "Cirurgia", "Pequenas Cirurgias", "Encaixe", "Retorno", "Cortesia", "Encaminhamento - INTERNO"];
  const enums = opcoes.map((value, i) => ({ value, sort: i + 1 }));
  let criado: any;
  try { criado = await kommoPost("/leads/custom_fields", [{ name: nome, type: "select", enums }], env); }
  catch (e) { return Response.json({ ok: false, erro: String(e) }, { status: 500 }); }
  fieldsCache = null; // invalida o cache p/ o próximo resolveFields enxergar o campo novo
  const fieldId = criado?._embedded?.custom_fields?.[0]?.id ?? null;
  return Response.json({ ok: true, criado: true, field_id: fieldId, mapa: TIPO_PROCEDIMENTO_CNN });
}

function handleDebugSelftest(req: Request): Response {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "logic";
  if (mode === "fuzz") return Response.json(runSelftestFuzz());
  if (mode === "stress") {
    let n = Number(url.searchParams.get("n") ?? "100");
    if (!Number.isFinite(n) || n < 1) n = 100;
    n = Math.min(Math.max(Math.floor(n), 1), 5000);
    return Response.json(runSelftestStress(n));
  }
  return Response.json(runSelftestLogic());
}

// ── Debug: contagem de leads por pipeline (sem filtro vs com filtro) ──────────
// READ-ONLY Kommo. Compara a enumeração sem filtro (bucket por pipeline_id) com
// a query filtrada por pipeline, e mostra amostra com pipeline_id real — pra
// provar se o /leads sem filtro devolve TODOS os funis ou só o principal.
// ── F1/F2: leitura do log durável de ticks + backlog vivo da fila ─────────────
// Read-only. `?n=` (default 60, teto 500) ticks recentes; `?full=1` inclui `resumo`.
async function handleTickLog(req: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const u = new URL(req.url);
  const n = Math.min(Math.max(Number(u.searchParams.get("n") ?? "60"), 1), 500);
  const full = u.searchParams.get("full") === "1";
  const now = Math.floor(Date.now() / 1000);
  const cols = full
    ? "id, ts, ok, ms, subreq, gatilhos, processados, movidos, criados_b, adiados, erros, transitorios, fila_pendente, fila_erro, erro, resumo"
    : "id, ts, ok, ms, subreq, gatilhos, processados, movidos, criados_b, erros, transitorios, fila_pendente, fila_erro, erro";
  const rows = ((await env.DB.prepare(`SELECT ${cols} FROM tick_log ORDER BY id DESC LIMIT ?`).bind(n).all()).results ?? []) as any[];
  const saude: any = {
    ticks: rows.length, ok: rows.filter((r) => r.ok === 1).length, falhas: rows.filter((r) => r.ok === 0).length,
    ultima_falha: null as any, ultimo_tick_ha_seg: rows.length ? now - Number(rows[0].ts) : null,
    soma_processados: 0, soma_movidos: 0, soma_criados_b: 0, soma_erros: 0, soma_transitorios: 0, max_subreq: 0, max_ms: 0,
  };
  for (const r of rows) {
    saude.soma_processados += Number(r.processados ?? 0); saude.soma_movidos += Number(r.movidos ?? 0);
    saude.soma_criados_b += Number(r.criados_b ?? 0); saude.soma_erros += Number(r.erros ?? 0);
    saude.soma_transitorios += Number(r.transitorios ?? 0);
    saude.max_subreq = Math.max(saude.max_subreq, Number(r.subreq ?? 0)); saude.max_ms = Math.max(saude.max_ms, Number(r.ms ?? 0));
    if (r.ok === 0 && !saude.ultima_falha) saude.ultima_falha = { ts: r.ts, erro: r.erro };
  }
  const st = ((await env.DB.prepare(`SELECT status, tipo, COUNT(*) n, MIN(criado_em) mais_antigo FROM fila_trabalho GROUP BY status, tipo`).all()).results ?? []) as any[];
  const backlog: any = { por_status: {}, pendente_por_tipo: {}, pendente_idade: {} };
  for (const r of st) {
    backlog.por_status[r.status] = (backlog.por_status[r.status] ?? 0) + Number(r.n);
    if (r.status === "pendente") backlog.pendente_por_tipo[r.tipo ?? "?"] = { n: Number(r.n), idade_max_seg: r.mais_antigo ? now - Number(r.mais_antigo) : 0 };
  }
  const b = await env.DB.prepare(
    `SELECT SUM(CASE WHEN criado_em > ? THEN 1 ELSE 0 END) ate_5min,
            SUM(CASE WHEN criado_em <= ? AND criado_em > ? THEN 1 ELSE 0 END) de_5_30min,
            SUM(CASE WHEN criado_em <= ? AND criado_em > ? THEN 1 ELSE 0 END) de_30_120min,
            SUM(CASE WHEN criado_em <= ? THEN 1 ELSE 0 END) mais_120min
       FROM fila_trabalho WHERE status='pendente'`
  ).bind(now - 300, now - 300, now - 1800, now - 1800, now - 7200, now - 7200).first<any>();
  backlog.pendente_idade = b ?? {};
  return Response.json({ agora: now, saude, backlog, recentes: rows });
}

// ══ A5: dead-letter observável + requeue controlado ══════════════════════════
// Itens 'erro' (falharam FILA_MAX_TENTATIVAS vezes) somem do dreno. Estes dois
// endpoints os tornam visíveis e permitem reprocessá-los sem apagar nada (o
// clear=1 apaga tudo). Só leem/escrevem colunas existentes — sem migração.
async function handleFilaErros(env: Env): Promise<Response> {
  await ensureSchema(env);
  const LIM = 200;
  const r = await env.DB.prepare(
    `SELECT id,tipo,chave,paciente_id_cnn,agenda_id_cnn,grupo,tentativas,ultimo_erro,atualizado_em
       FROM fila_trabalho WHERE status='erro' ORDER BY atualizado_em DESC LIMIT ?`
  ).bind(LIM).all();
  const itens = (r.results ?? []) as any[];
  const cnt = await env.DB.prepare(`SELECT COUNT(*) n FROM fila_trabalho WHERE status='erro'`).first<any>();
  const total = (cnt?.n as number) ?? itens.length;
  return Response.json({ total, mostrados: itens.length, truncado: total > itens.length, itens });
}
// Requeue: dry por padrão (só ?dry=0 escreve). Alvo = 1 id ('?id=N') ou todos ('?all=1'),
// SEMPRE restrito a status='erro' (não toca 'feito'/'pendente'). Zera tentativas e ultimo_erro.
async function handleFilaRequeue(req: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const u = new URL(req.url);
  const dry = u.searchParams.get("dry") !== "0";
  const all = u.searchParams.get("all") === "1";
  let where: string, binds: any[];
  if (all) { where = `status='erro'`; binds = []; }
  else {
    const id = Number(u.searchParams.get("id"));
    if (!Number.isFinite(id)) return Response.json({ erro: "faltou ?id=N (ou use ?all=1)" }, { status: 400 });
    where = `status='erro' AND id=?`; binds = [id];
  }
  const alvos = await env.DB.prepare(`SELECT id FROM fila_trabalho WHERE ${where}`).bind(...binds).all();
  const ids = (alvos.results ?? []).map((x: any) => x.id);
  if (dry) return Response.json({ dry: true, would_requeue: ids.length, ids });
  if (ids.length)
    await env.DB.prepare(
      `UPDATE fila_trabalho SET status='pendente', tentativas=0, ultimo_erro=NULL, locked_at=NULL, atualizado_em=? WHERE ${where}`
    ).bind(Math.floor(Date.now() / 1000), ...binds).run();
  return Response.json({ dry: false, requeued: ids.length, ids });
}

async function handleDebugCount(env: Env): Promise<Response> {
  const out: any = { por_pipeline: {} };

  // Pega funis + etapas ao vivo
  let pls: any;
  try { pls = await kommoGet("/leads/pipelines?with=statuses", env); }
  catch (e) { return Response.json({ erro: `pipelines: ${String(e)}` }); }

  for (const p of (pls._embedded?.pipelines ?? [])) {
    const pid = p.id;
    const etapas: Record<string, number> = {};
    const amostra: any[] = [];
    let totalPipe = 0;
    for (const s of (p._embedded?.statuses ?? [])) {
      let c = 0, page = 1;
      while (page <= 30) {
        let r: any;
        try { r = await kommoGet(`/leads?filter[statuses][0][pipeline_id]=${pid}&filter[statuses][0][status_id]=${s.id}&limit=250&page=${page}`, env); }
        catch { break; }
        const raw = r._embedded?.leads ?? [];
        // Guarda em código: o filtro pode vazar leads de outras etapas
        const ls = raw.filter((l: any) => l.pipeline_id === pid && l.status_id === s.id);
        c += ls.length;
        for (const l of ls) if (amostra.length < 3) amostra.push({ id: l.id, pipeline_id: l.pipeline_id, status_id: l.status_id });
        if (raw.length < 250) break;
        page++;
      }
      if (c > 0) etapas[`${s.id} ${s.name}`] = c;
      totalPipe += c;
    }
    out.por_pipeline[`${pid} ${p.name}`] = { total: totalPipe, etapas, amostra };
  }
  return Response.json(out);
}

// ── Debug: cria uma agenda de teste no SANDBOX com tipo escolhido ─────────────
// Só sandbox + allowlist. Usado pra testar o roteamento da Função 2 E2E, já que
// os tipos do sandbox ("Encaixe"/"Cirurgia") são os únicos que casam com grupo.
// ── FIXTURE DE TESTE (produção) — cria/vincula o paciente de teste dedicado ────
// Escopo TRAVADO ao telefone/lead de teste (11946800329 / lead 17488447). Autorizado
// explicitamente pelo dono (06/07) só para montar o fixture de validação em produção.
// ?modo=probe (read-only) confirma existência; ?modo=criar cria (se faltar) + agenda + vincula.
// Guardrail PRESERVADO: jamais DELETE, jamais alterar/deletar paciente. Criar paciente é a
// ÚNICA exceção autorizada ao allowlist §7.8, feita por fetch direto e SÓ para o telefone de teste.
const FX_PHONE = "11946800329";
const FX_LEAD  = "17488447";
const FX_NOME  = "TESTE INTEGRACAO KOMMO";
const FX_IDS_CONHECIDOS = ["28155333", "28146949"]; // resíduo dos custom fields do lead
// Telefone canônico p/ CASAR por número (dedup): só dígitos, ignora DDI 55 e o 9º dígito.
function fxTelKey(p: string): string {
  let d = (p ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length >= 10) return d.slice(0, 2) + d.slice(2).slice(-8);
  return d.slice(-8);
}
// nomeContem FUNCIONA no CNN (telefoneCelularContem é ignorado) → busca candidatos por nome.
async function fxBuscaNome(env: Env, nome: string): Promise<any[]> {
  try { const r: any = await cnnGet(`/paciente/lista?nomeContem=${encodeURIComponent(nome)}&limite=50`, env, "production");
    return (r?.lista ?? []); } catch { return []; }
}
// Detalhe do paciente (GET /paciente/{id}) — expõe o telefone REALMENTE armazenado.
async function fxDetalhe(env: Env, id: string | number): Promise<any> {
  try { const p: any = await cnnGet(`/paciente/${id}`, env, "production");
    return { id, existe: !!p?.nome, nome: p?.nome ?? null,
      telefone: p?.telefoneCelular ?? p?.contato?.telefoneCelular ?? p?.telefone ?? null,
      cpf: p?.cpf ?? p?.cpfCnpj ?? null, keys: Object.keys(p ?? {}) }; }
  catch (e) { return { id, existe: false, erro: String(e) }; }
}
async function handleDebugFixtureTeste(req: Request, env: Env): Promise<Response> {
  resetSubreq();
  const url = new URL(req.url);
  const modo = url.searchParams.get("modo") ?? "probe";
  const target: CnnTarget = "production";

  const nome = url.searchParams.get("nome") ?? FX_NOME;
  const foneRaw = url.searchParams.get("fone") ?? FX_PHONE;
  const foneAlvo = fxTelKey(foneRaw);

  if (modo === "probe") {
    const cands = await fxBuscaNome(env, nome);
    const detalhados: any[] = [];
    for (const c of cands.slice(0, 12)) detalhados.push(await fxDetalhe(env, c.id));
    const matchFone = detalhados.filter((d) => fxTelKey(String(d.telefone ?? "")) === foneAlvo);
    const porId: any[] = [];
    for (const id of FX_IDS_CONHECIDOS) porId.push(await fxDetalhe(env, id));
    return Response.json({ modo, target, phone: FX_PHONE, foneAlvo, lead: FX_LEAD, nome,
      porNome_total: cands.length, detalhados, matchFone_ids: matchFone.map((d) => d.id), porId });
  }

  if (modo === "convenios") { // read-only: convênios de um paciente → descobrir idTipoConvenio "Particular" de PRODUÇÃO
    const pid = url.searchParams.get("pid") ?? "";
    if (!pid) return Response.json({ erro: "faltou ?pid=" }, { status: 400 });
    try { const r: any = await cnnGet(`/convenio-paciente/lista?idPaciente=${pid}&somenteAtivos=false`, env, target);
      return Response.json({ modo, pid, lista: r?.lista ?? r }); }
    catch (e: any) { return Response.json({ modo, pid, erro: String(e?.message ?? e) }, { status: 502 }); }
  }

  if (modo === "tipos") { // read-only: descobre os ids de PRODUÇÃO (tipoConsulta/tipoProcedimento/localAgenda)
    const out: any = { modo, target };
    try { const r: any = await cnnGet("/tipo-consulta/lista?registrosPorPagina=200&pagina=0", env, target);
      out.tipo_consulta = (r?.lista ?? []).map((t: any) => ({ id: t.id ?? t.idTipoConsulta, nome: t.nome ?? t.descricao ?? t.nomeTipoConsulta, ativo: t.ativo })); }
    catch (e: any) { out.tipo_consulta_erro = String(e?.message ?? e); }
    try { const r: any = await cnnGet("/tipo-procedimento/lista?registrosPorPagina=200&pagina=0&tipo=TODOS", env, target);
      out.tipo_procedimento = (r?.lista ?? []).map((t: any) => ({ id: t.id ?? t.idTipoProcedimento, nome: t.nome ?? t.descricao, ativo: t.ativo })); }
    catch (e: any) { out.tipo_procedimento_erro = String(e?.message ?? e); }
    const di = url.searchParams.get("di") ?? tomorrowBRT();
    const df = url.searchParams.get("df") ?? di;
    const localFiltro = url.searchParams.get("local") ?? "";
    try { const r: any = await cnnGet(`/agenda/lista?dataInicial=${di}&dataFinal=${df}&registrosPorPagina=200&pagina=0`, env, target);
      let ags = (r?.lista ?? []).map((a: any) => ({ hi: a.horaInicio, hf: a.horaFim, local: a.idLocalAgenda, tipo: a.idTipoConsulta, status: a.status, proc: (a.procedimentos ?? []).length }));
      if (localFiltro) ags = ags.filter((a: any) => String(a.local) === localFiltro);
      ags.sort((a: any, b: any) => String(a.hi).localeCompare(String(b.hi)));
      out.di = di; out.df = df; out.local_filtro = localFiltro || null; out.agenda_total = ags.length; out.ocupados = ags; }
    catch (e: any) { out.agenda_erro = String(e?.message ?? e); }
    return Response.json(out);
  }

  if (modo === "verificar") { // read-only: confirma no DESTINO REAL (agenda no CNN + lead no Kommo)
    const out: any = { modo };
    const ag = url.searchParams.get("agenda") ?? "";
    const dataAg = url.searchParams.get("data") ?? "";
    if (ag && dataAg) {
      try { const r: any = await cnnGet(`/agenda/lista?dataInicial=${dataAg}&dataFinal=${dataAg}&registrosPorPagina=200&pagina=0`, env, target);
        const a = (r?.lista ?? []).find((x: any) => String(x.id) === ag);
        out.agenda_cnn = a ? { id: a.id, status: a.status, data: a.data, hi: a.horaInicio, hf: a.horaFim, idTipoConsulta: a.idTipoConsulta, idLocalAgenda: a.idLocalAgenda, idPaciente: a.idPaciente, procedimentos: (a.procedimentos ?? []).map((x: any) => x.idTipoProcedimento) } : { achou: false, dica: "não está na lista desse dia" }; }
      catch (e: any) { out.agenda_erro = String(e?.message ?? e); }
    }
    try {
      const fields = await resolveFields(env);
      const leadAlvo = url.searchParams.get("lead") ?? FX_LEAD;
      const lead: any = await kommoGet(`/leads/${leadAlvo}`, env);
      out.lead = { id: lead.id, pipeline: lead.pipeline_id, status: lead.status_id,
        id_agenda_cnn: getFieldValue(lead, fields["ID Agenda CNN"]),
        id_paciente_cnn: getFieldValue(lead, fields["ID Paciente CNN"]),
        agendamento: getFieldValue(lead, fields["AGENDAMENTO"]) };
    } catch (e: any) { out.lead_erro = String(e?.message ?? e); }
    return Response.json(out);
  }

  if (modo === "w1") { // valida o lead-agendado (Grupo A / F.Captura) em PRODUÇÃO, escopado ao lead de teste
   try {
    const data = url.searchParams.get("data") ?? tomorrowBRT();
    const hora = url.searchParams.get("hora") ?? "08:15";
    const ts = brtToUnix(data, hora);
    const fields = await resolveFields(env);
    // Setup do lead de teste: reusa paciente 28524071 (id_paciente_cnn preenchido → W1 NÃO cria paciente),
    // limpa id_agenda_cnn (senão o W1 pula por already_synced), seta AGENDAMENTO.
    await setLeadFields(FX_LEAD, [
      { id: fields["ID Paciente CNN"], value: url.searchParams.get("pid") ?? "28524071" },
      { id: fields["ID Agenda CNN"], value: "" },
    ], env);
    await setAgendamento(FX_LEAD, ts, fields["AGENDAMENTO"], env); // date_time exige NÚMERO (unix), não string
    // Dispara o W1 exatamente como o webhook real (form-urlencoded).
    const fakeReq = new Request("https://x/webhook/lead-agendado", { method: "POST",
      body: `leads[status][0][id]=${FX_LEAD}`, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const resp = await handleLeadAgendado(fakeReq, env);
    const w1 = await resp.json().catch(() => ({ status: resp.status }));
    return Response.json({ modo, data, hora, ts, lead: FX_LEAD, w1 });
   } catch (e: any) { return Response.json({ modo, ok: false, erro: String(e?.message ?? e), stack: String(e?.stack ?? "").split("\n").slice(0, 4) }, { status: 500 }); }
  }

  if (modo === "posvenda") { // exercita o fluxo REAL de pós-venda agendar (Grupo B): enfileira CNN_AGENDAR
    // igual ao /webhook/pos-venda-agendar (mesma chave/payload/fila). O consumidor cria a agenda no CNN.
    const pid = url.searchParams.get("pid") ?? "";
    if (!pid) return Response.json({ erro: "faltou ?pid= (id do paciente de teste no CNN)" }, { status: 400 });
    const data = url.searchParams.get("data") ?? tomorrowBRT();
    const hora = url.searchParams.get("hora") ?? "12:00";
    const tipoNome = url.searchParams.get("tipoNome") ?? "Retorno"; // → idTipoConsulta resolvido por nome no alvo
    const ts = brtToUnix(data, hora);
    const chave = `CNN_AGENDAR:${FX_LEAD}:${ts}`;
    await purgarGemeoFeito(chave, env);
    await filaEnfileirarLote([{
      chave, tipo: "CNN_AGENDAR", paciente_id_cnn: String(pid), grupo: "B",
      payload: { leadId: FX_LEAD, pid: String(pid), ts, tipoNome, ...(((url.searchParams.get("procids") ?? "").split(",").filter(Boolean).map(Number)).length ? { procIds: (url.searchParams.get("procids") ?? "").split(",").filter(Boolean).map(Number) } : {}) },
    }], env);
    return Response.json({ modo, enfileirado: "CNN_AGENDAR", chave, ts, data, hora, tipoNome, pid, lead: FX_LEAD });
  }

  if (modo === "criar") {
   try {
    // ── DEDUP POR NÚMERO (telefone). id do paciente é secundário. ──
    // Busca candidatos por nome (nomeContem funciona) e CONFIRMA pelo telefone canônico.
    const cands = await fxBuscaNome(env, nome);
    let idPaciente: number | undefined;
    const casados: any[] = [];
    for (const c of cands) {
      const det = await fxDetalhe(env, c.id);
      if (fxTelKey(String(det.telefone ?? "")) === foneAlvo) casados.push(c.id);
    }
    if (casados.length) idPaciente = Number(casados[0]);

    let criou = false;
    if (!idPaciente) {
      if (url.searchParams.get("forcar") !== "1")
        return Response.json({ modo, ok: false, motivo: "nenhum paciente com esse TELEFONE — p/ criar um novo passe &forcar=1", nome, foneAlvo, candidatos_por_nome: cands.map((c: any) => c.id) }, { status: 409 });
      // ÚNICA exceção autorizada ao §7.8: POST /paciente/novo p/ o paciente de teste (fetch direto; guardrail global intacto).
      const tel = normalizePhone(foneRaw);
      const body: any = { nome, dataNascimento: "1900-01-01", telefoneCelular: tel, contato: { telefoneCelular: tel } };
      const res = await fetchComRetry(() => { bumpSubreq(); return fetch(`${CNN_BASE}/paciente/novo`, {
        method: "POST", headers: cnnHeaders(env, target), body: JSON.stringify(body),
      }); }, retryPost());
      const text = await res.text();
      if (!res.ok) return Response.json({ modo, erro: `POST /paciente/novo → ${res.status}: ${text}` }, { status: 502 });
      idPaciente = Number((text ? JSON.parse(text) : {})?.id);
      criou = true;
    }
    if (!idPaciente) return Response.json({ modo, erro: "sem idPaciente" }, { status: 500 });

    // Convênio: idTipoConvenio de PRODUÇÃO via ?convenio= (senão a constante, que pode ser sandbox).
    const idTipoConv = Number(url.searchParams.get("convenio") ?? cnnConvenioParticular(env, "production"));
    let idPacienteConvenio: number | undefined; const convDetalhe: any = {};
    try { const a: any = await cnnPost("/convenio-paciente/associar", { idPaciente, idTipoConvenio: idTipoConv }, env, target); idPacienteConvenio = a?.id; convDetalhe.assoc = a; }
    catch (e: any) { convDetalhe.assoc_erro = String(e?.message ?? e); }
    if (!idPacienteConvenio) {
      try { const l: any = await cnnGet(`/convenio-paciente/lista?idPaciente=${idPaciente}&somenteAtivos=false`, env, target);
        const it = l?.lista ?? []; convDetalhe.lista = it;
        idPacienteConvenio = (it.find((c: any) => c.idTipoConvenio === idTipoConv) ?? it[0])?.id; }
      catch (e: any) { convDetalhe.lista_erro = String(e?.message ?? e); }
    }
    if (!idPacienteConvenio)
      return Response.json({ modo, ok: false, idPaciente, criou, motivo: "sem idPacienteConvenio — rode ?modo=convenios&pid=<paciente_real> p/ achar o idTipoConvenio de produção e passe &convenio=", convDetalhe }, { status: 422 });

    const data = url.searchParams.get("data") ?? tomorrowBRT();
    const hora = url.searchParams.get("hora") ?? "10:00";
    const horaFim = addMinutes(hora, 30);
    const idTipoConsulta = Number(url.searchParams.get("tipoConsulta") ?? 66666); // 66666 = Consulta/Avaliação (Grupo A) em produção
    const idLocalAgenda  = Number(url.searchParams.get("localAgenda")  ?? cnnLocalAgenda(env, "production"));
    const idTipoProc     = Number(url.searchParams.get("tipoProc")     ?? cnnTipoProcedimento(env, "production"));
    const agenda: any = await cnnPost("/agenda/novo", {
      data, horaInicio: `${hora}:00`, horaFim: `${horaFim}:00`,
      idPaciente, idPacienteConvenio,
      idTipoConsulta, idLocalAgenda,
      status: "AGENDADO",
      procedimentos: idTipoProc > 0 ? [{ idTipoProcedimento: idTipoProc, quantidade: 1 }] : [],
    }, env, target);

    const fields = await resolveFields(env);
    await setLeadFields(FX_LEAD, [
      { id: fields["ID Agenda CNN"],   value: String(agenda.id) },
      { id: fields["ID Paciente CNN"], value: String(idPaciente) },
    ], env);

    return Response.json({ modo, ok: true, criou_paciente: criou, idPaciente, idTipoConvenio: idTipoConv, idPacienteConvenio, idTipoConsulta, idLocalAgenda, idTipoProc, idAgenda: agenda?.id, data, hora, lead: FX_LEAD, vinculado: true });
   } catch (e: any) {
    return Response.json({ modo, ok: false, erro: String(e?.message ?? e), stack: String(e?.stack ?? "").split("\n").slice(0, 4) }, { status: 500 });
   }
  }

  return Response.json({ erro: "modo inválido (use probe|convenios|criar)" }, { status: 400 });
}

async function handleDebugCriarAgenda(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const telefone = normalizePhone(url.searchParams.get("phone") ?? "11946800329");
  const tipoNome = url.searchParams.get("tipo") ?? "Encaixe";
  const dataParam = url.searchParams.get("data") ?? tomorrowBRT();
  const horaParam = url.searchParams.get("hora") ?? "10:00";
  if (!isTestePhone(telefone)) return Response.json({ erro: "telefone fora da allowlist (§12.1)" });
  const out: any = { telefone, tipo: tipoNome, data: dataParam, hora: horaParam };
  try {
    const pr = await cnnGet(`/paciente/lista?telefoneCelularContem=${encodeURIComponent(telefone.slice(-11))}&limite=5`, env, "sandbox");
    const pac = (pr?.lista ?? []).find((p: any) =>
      normalizePhone(p.contato?.telefoneCelular ?? p.contato?.telefone ?? "").slice(-11) === telefone.slice(-11));
    if (!pac) { out.erro = "paciente CNN não encontrado no sandbox"; return Response.json(out); }
    const tiposMap = await resolveTiposConsulta(env, "sandbox");
    const alvo = normNome(tipoNome);
    const idTipo = Object.entries(tiposMap).find(([, n]) => n === alvo)?.[0];
    if (!idTipo) { out.erro = `tipo '${tipoNome}' não existe no sandbox`; out.tipos_disponiveis = tiposMap; return Response.json(out); }
    const idPacienteConvenio = await getOrCreateConvenioParticular(Number(pac.id), env);
    const horaFim = addMinutes(horaParam, 30);
    const agenda: any = await cnnPost("/agenda/novo", {
      data: dataParam, horaInicio: `${horaParam}:00`, horaFim: `${horaFim}:00`,
      idPaciente: Number(pac.id), idPacienteConvenio,
      idTipoConsulta: Number(idTipo), idLocalAgenda: CNN_LOCAL_AGENDA,
      status: "AGENDADO",
      procedimentos: [{ idTipoProcedimento: CNN_TIPO_PROCEDIMENTO, quantidade: 1 }],
    }, env, "sandbox");
    out.ok = true; out.idAgenda = agenda?.id; out.idPaciente = pac.id; out.idTipoConsulta = idTipo;
  } catch (e) { out.erro = String(e); }
  return Response.json(out);
}

// ── Debug: preview do backfill por dia (read-only, reflete desempate B-ganha) ─
// Pra cada agenda do dia: nome, telefone, tipo, grupo, status, se tem lead no
// Kommo (match §7.1), e o que o A4 faria (criar/vincular/pular) + funil destino.
async function handleDebugBackfillPreview(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const target: CnnTarget = url.searchParams.get("env") === "production" ? "production" : "sandbox";
  const data = url.searchParams.get("data") ?? tomorrowBRT();
  const tiposMap = await resolveTiposConsulta(env, target);

  const todas: any[] = [];
  let pag = 0, totalPag = 1;
  while (pag < totalPag) {
    let r: any;
    try { r = await cnnGet(`/agenda/lista?dataInicial=${data}&dataFinal=${data}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch { break; }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
    for (const a of (r?.lista ?? [])) todas.push(a);
  }

  // Ordena Grupo B antes de A (desempate: paciente com A e B → vence B)
  const comInfo = todas.map((a) => ({ a, g: grupoDaAgenda(a, tiposMap) }));
  comInfo.sort((x, y) => (x.g === "B" ? 0 : 1) - (y.g === "B" ? 0 : 1));

  const vistos = new Set<string>();
  const grupoVencedor = new Map<string, string>();
  const leadCache = new Map<string, string | null>();
  const nomeCache = new Map<string, string>();
  const rows: any[] = [];

  const skipNames = url.searchParams.get("skipnames") === "1"; // nomes vêm de /debug-nomes?map=1 (evita teto de 50 subrequests)
  for (const { a, g } of comInfo) {
    const pacienteId = String(a.idPaciente ?? "");
    const tel = normalizePhone(a.telefoneCelularPaciente ?? "");
    const interna = isTarefaInterna(a);

    let nome = nomeCache.get(pacienteId) ?? "";
    if (!nome && pacienteId) {
      nome = skipNames ? `CNN ${pacienteId}` : ((await cnnPacienteNome(pacienteId, env, target)) ?? `CNN ${pacienteId}`);
      nomeCache.set(pacienteId, nome);
    }

    let leadId: string | null = null;
    if (!interna && tel.length >= 8) {
      const pk = phoneKey(tel);
      if (leadCache.has(pk)) leadId = leadCache.get(pk) ?? null;
      else {
        try {
          const kr = await kommoGet(`/contacts?query=${encodeURIComponent(tel.slice(-8))}&with=leads`, env);
          const contact = (kr._embedded?.contacts ?? []).find((c: any) =>
            (c.custom_fields_values ?? []).filter((f: any) => f.field_code === "PHONE")
              .flatMap((f: any) => f.values.map((v: any) => normalizePhone(v.value)))
              .some((p: string) => phoneKey(p) === pk));
          leadId = contact?._embedded?.leads?.[0]?.id ? String(contact._embedded.leads[0].id) : null;
        } catch { leadId = null; }
        leadCache.set(pk, leadId);
      }
    }

    let acao: string, funil: string;
    if (interna) { acao = "pular (tarefa interna — tel falso)"; funil = "—"; }
    else if (!g) { acao = "pular (tipo fora dos grupos A/B)"; funil = "—"; }
    else if (vistos.has(pacienteId)) { acao = `pular (paciente já tratado → vai pro Grupo ${grupoVencedor.get(pacienteId)})`; funil = "—"; }
    else {
      vistos.add(pacienteId); grupoVencedor.set(pacienteId, g);
      funil = g === "A" ? "Captação / Consulta Agendada" : "Pós-Venda / Cliente Ativo";
      acao = leadId ? "vincular (lead já existe)" : "criar card novo";
    }

    rows.push({
      agenda_id: a.id, nome, telefone: tel, hora: (a.horaInicio ?? "").slice(0, 5),
      tipo: tiposMap[String(a.idTipoConsulta ?? "")] ?? `id ${a.idTipoConsulta}`,
      grupo: interna ? "interna" : (g ?? "—"), status: a.status, tem_lead: leadId ? "sim" : "não",
      lead_id: leadId ?? "", acao, funil,
    });
  }
  rows.sort((x, y) => (x.hora || "").localeCompare(y.hora || ""));
  return Response.json({ target, data, total: rows.length, rows });
}

// ── Debug: inspeção CRUA da paginação do CNN (read-only) ─────────────────────
// Confirma se registrosPorPagina é honrado e se totalPaginas é confiável.
async function handleDebugRaw(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const target: CnnTarget = url.searchParams.get("env") === "production" ? "production" : "sandbox";
  const di = url.searchParams.get("di") ?? tomorrowBRT();
  const df = url.searchParams.get("df") ?? di;
  const rpp = url.searchParams.get("rpp") ?? "200";
  const out: any = { target, di, df, registrosPorPagina: rpp, paginas: [] as any[] };
  let somaLista = 0;
  for (let pagina = 0; pagina <= 30; pagina++) {
    try {
      const r: any = await cnnGet(`/agenda/lista?dataInicial=${di}&dataFinal=${df}&registrosPorPagina=${rpp}&pagina=${pagina}`, env, target);
      const len = (r?.lista ?? []).length;
      somaLista += len;
      out.paginas.push({
        pagina, lista_len: len, totalPaginas: r?.totalPaginas ?? null, campo_pagina: r?.pagina ?? null,
        keys: Object.keys(r ?? {}), totalRegistros: r?.totalRegistros ?? r?.total ?? r?.totalElementos ?? null,
      });
      if (len === 0) break;
    } catch (e) { out.paginas.push({ pagina, erro: String(e) }); break; }
  }
  out.soma_lista_paginas_lidas = somaLista;
  return Response.json(out);
}

// ── Debug: lista DETALHADA das agendas de um dia (read-only) ──────────────────
// Mostra cada agenda com tipo+grupo+status+hora+paciente. Com ?lead=1 também
// busca o lead correspondente no Kommo (mais lento). ?env=production é GET-only.
async function handleDebugAgendas(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const target: CnnTarget = url.searchParams.get("env") === "production" ? "production" : "sandbox";
  const data = url.searchParams.get("data") ?? tomorrowBRT();
  const comLead = url.searchParams.get("lead") === "1";
  const tiposMap = await resolveTiposConsulta(env, target);
  const out: any = { target, data, total: 0, por_grupo: { A: 0, B: 0, "—": 0 }, por_status: {} as Record<string, number>, por_tipo: {} as Record<string, number>, agendas: [] as any[] };
  let pag = 0, totalPag = 1;
  while (pag < totalPag) {
    let r: any;
    try { r = await cnnGet(`/agenda/lista?dataInicial=${data}&dataFinal=${data}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch { break; }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
    for (const a of (r?.lista ?? [])) {
      const tipo = tiposMap[String(a.idTipoConsulta ?? "")] ?? `id ${a.idTipoConsulta}`;
      const grupo = grupoDaAgenda(a, tiposMap);
      const tel = normalizePhone(a.telefoneCelularPaciente ?? "");
      out.total++;
      out.por_grupo[grupo ?? "—"]++;
      out.por_status[a.status ?? "(vazio)"] = (out.por_status[a.status ?? "(vazio)"] ?? 0) + 1;
      out.por_tipo[tipo] = (out.por_tipo[tipo] ?? 0) + 1;
      const item: any = {
        id: a.id, hora: (a.horaInicio ?? "").slice(0, 5), status: a.status,
        tipo, grupo: grupo ?? "—(não roteia)",
        paciente: a.nomePaciente ?? a.idPaciente, tel: tel ? "***" + tel.slice(-4) : null,
      };
      if (comLead && tel.length >= 8) {
        try {
          const telKey = phoneKey(tel);
          const kr = await kommoGet(`/contacts?query=${encodeURIComponent(tel.slice(-8))}&with=leads`, env);
          const contact = (kr._embedded?.contacts ?? []).find((c: any) =>
            (c.custom_fields_values ?? []).filter((f: any) => f.field_code === "PHONE")
              .flatMap((f: any) => f.values.map((v: any) => normalizePhone(v.value)))
              .some((p: string) => phoneKey(p) === telKey));
          item.kommo_lead = contact?._embedded?.leads?.[0]?.id ?? null;
        } catch { item.kommo_lead = "erro"; }
      }
      out.agendas.push(item);
    }
  }
  return Response.json(out);
}

// ── Verificação de integridade: cruza Kommo (Pós-Venda real, via GET) × CNN (janela
// −2/+14 COMPLETA) × D1. Cap-safe (~15-25 fetches). Confere se os dados vêm inteiros
// (paginação completa + campos presentes) e se os 164 do Pós-Venda batem com os
// pacientes B ativos distintos da janela. Só leitura.
async function verificarDados(env: Env, target: CnnTarget): Promise<any> {
  await ensureSchema(env);
  resetSubreq();
  const out: any = { target };
  const tiposMap = await resolveTiposConsulta(env, target);

  // 1. KOMMO: conta o Pós-Venda por etapa (GET paginado, com guarda do vazamento de filtro).
  out.kommo_pos_venda = { por_etapa: {} as Record<string, number>, total: 0 };
  try {
    const pls: any = await kommoGet("/leads/pipelines?with=statuses", env);
    const pv = (pls._embedded?.pipelines ?? []).find((p: any) => p.id === PIPELINE_POS_VENDA);
    for (const s of (pv?._embedded?.statuses ?? [])) {
      let c = 0, page = 1;
      while (page <= 6) {
        const r: any = await kommoGet(`/leads?filter[statuses][0][pipeline_id]=${PIPELINE_POS_VENDA}&filter[statuses][0][status_id]=${s.id}&limit=250&page=${page}`, env);
        const raw = r._embedded?.leads ?? [];
        const ls = raw.filter((l: any) => l.pipeline_id === PIPELINE_POS_VENDA && l.status_id === s.id);
        c += ls.length;
        if (raw.length < 250) break;
        page++;
      }
      if (c > 0) out.kommo_pos_venda.por_etapa[`${s.id} ${s.name}`] = c;
      out.kommo_pos_venda.total += c;
    }
  } catch (e) { out.kommo_pos_venda.erro = String(e); }

  // 2. CNN: lê a janela −2/+14 COMPLETA + integridade dos campos + dedupe por paciente.
  const ini = new Date(Date.now() - 3 * 3600 * 1000 - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const fim = new Date(Date.now() - 3 * 3600 * 1000 + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const todas: any[] = []; let pag = 0, totalPag = 1; const porPagina: number[] = [];
  while (pag < totalPag) {
    let r: any;
    try { r = await cnnGet(`/agenda/lista?dataInicial=${ini}&dataFinal=${fim}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch (e) { out.cnn_erro = String(e); break; }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1);
    const lista = r?.lista ?? [];
    porPagina.push(lista.length);
    for (const a of lista) todas.push(a);
    pag++;
  }
  const bSet = new Set<string>(), aSet = new Set<string>();
  const por_tipo: Record<string, number> = {}, por_status: Record<string, number> = {};
  let sem_idPaciente = 0, sem_status = 0, sem_tipo = 0, internos = 0;
  for (const a of todas) {
    if (!a.idPaciente) sem_idPaciente++;
    if (!a.status) sem_status++;
    if (!a.idTipoConsulta && !(a.procedimentos?.length)) sem_tipo++;
    if (isTarefaInterna(a)) { internos++; continue; }
    const tipo = tiposMap[String(a.idTipoConsulta ?? "")] ?? `id ${a.idTipoConsulta}`;
    por_tipo[tipo] = (por_tipo[tipo] ?? 0) + 1;
    por_status[a.status ?? "(vazio)"] = (por_status[a.status ?? "(vazio)"] ?? 0) + 1;
    if (STATUS_TERMINAL.has(a.status ?? "")) continue;
    const grupo = grupoDaAgenda(a, tiposMap);
    const pid = String(a.idPaciente ?? "");
    if (!pid) continue;
    if (grupo === "B") bSet.add(pid); else if (grupo === "A") aSet.add(pid);
  }
  out.cnn_janela = {
    ini, fim, totalPaginas: totalPag, paginas_lidas: pag, completo: pag >= totalPag,
    por_pagina: porPagina, total_agendas: todas.length, internos,
    integridade_campos: { sem_idPaciente, sem_status, sem_tipo },
    por_status, por_tipo,
    pacientes_B_ativo_distintos: bSet.size, // ESPERADO de "Cliente Ativo"
    pacientes_A_ativo_distintos: aSet.size,
  };

  // 3. D1: o que o sync registrou.
  out.d1_mapeamento_B = (await env.DB.prepare("SELECT COUNT(*) n FROM mapeamento WHERE grupo='B'").first<{ n: number }>())?.n ?? 0;
  out.subreq_total = subreqUsados;
  return out;
}

// ── Auditoria de confiabilidade: realidade dos pacientes + classificação 1-a-1 +
// consistência Kommo↔CNN dos cards + tipos desconhecidos. Só leitura, cap-safe.
async function auditarSync(env: Env, target: CnnTarget): Promise<any> {
  await ensureSchema(env);
  resetSubreq();
  const out: any = { target };
  const tiposMap = await resolveTiposConsulta(env, target);
  out.tipos_cnn_reais = tiposMap; // nomes reais dos tipos (id → nome normalizado)

  // 1. Lê a janela −2/+14 COMPLETA
  const ini = new Date(Date.now() - 3 * 3600 * 1000 - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const fim = new Date(Date.now() - 3 * 3600 * 1000 + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const todas: any[] = []; let pag = 0, totalPag = 1;
  while (pag < totalPag) {
    let r: any;
    try { r = await cnnGet(`/agenda/lista?dataInicial=${ini}&dataFinal=${fim}&registrosPorPagina=200&pagina=${pag}`, env, target); } catch { break; }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1);
    for (const a of (r?.lista ?? [])) todas.push(a);
    pag++;
  }

  // 2. Realidade + classificação por agenda
  const pacA = new Set<string>(), pacB = new Set<string>(), pacNenhum = new Set<string>();
  const social: any = { total: 0, distintos: new Set<string>(), internos: 0, sem_tel: 0, amostra: [], nomes_amostra: [] };
  const tiposDesconhecidos: Record<string, number> = {};
  let internosTotal = 0, semTelTotal = 0;
  for (const a of todas) {
    const interno = isTarefaInterna(a);
    const tel = normalizePhone(a.telefoneCelularPaciente ?? "");
    const tipoNome = tiposMap[String(a.idTipoConsulta ?? "")] ?? null;
    const grupo = grupoDaAgenda(a, tiposMap);
    const pid = String(a.idPaciente ?? "");
    if (interno) internosTotal++;
    if (tel.length < 8) semTelTotal++;
    if (!grupo && !interno) { const k = tipoNome ?? `id ${a.idTipoConsulta}`; tiposDesconhecidos[k] = (tiposDesconhecidos[k] ?? 0) + 1; }
    if (pid && !interno) (grupo === "A" ? pacA : grupo === "B" ? pacB : pacNenhum).add(pid);
    if (tipoNome === "atendimento social") {
      social.total++;
      if (pid) social.distintos.add(pid);
      if (interno) social.internos++;
      if (tel.length < 8) social.sem_tel++;
      if (social.amostra.length < 30) social.amostra.push({ id: a.id, data: a.data, hora: (a.horaInicio ?? "").slice(0, 5), status: a.status, idPaciente: pid, tel: tel ? "***" + tel.slice(-4) : "(vazio)", interno });
    }
  }

  // 3. Resolve NOMES de uma amostra de pacientes "atendimento social" (são reais?)
  for (const pid of [...social.distintos].slice(0, 15)) {
    if (!orcamentoOk(45)) break;
    try { const p: any = await cnnGet(`/paciente/${pid}`, env, target); social.nomes_amostra.push({ pid, nome: p?.nome ?? p?.nomeCompleto ?? p?.nomePaciente ?? "(sem nome)", nasc: p?.dataNascimento ?? null }); }
    catch (e) { social.nomes_amostra.push({ pid, erro: String(e) }); }
  }

  out.totais = { agendas: todas.length, internos: internosTotal, sem_telefone: semTelTotal, pacientes_A: pacA.size, pacientes_B: pacB.size, pacientes_sem_grupo: pacNenhum.size };
  social.distintos = social.distintos.size;
  out.atendimento_social = social;
  out.tipos_desconhecidos = tiposDesconhecidos;

  // 4. Kommo: amostra de cards (B e A) — checa pipeline certo + ID Agenda/Paciente preenchidos
  const fields = await resolveFields(env);
  const fIdAg = fields["ID Agenda CNN"], fIdPac = fields["ID Paciente CNN"];
  const checaCards = async (grupo: "A" | "B", lim: number) => {
    const rows = ((await env.DB.prepare("SELECT lead_id_kommo FROM mapeamento WHERE grupo=? AND lead_id_kommo IS NOT NULL ORDER BY atualizado_em DESC LIMIT ?").bind(grupo, lim).all()).results ?? []) as any[];
    const res: any[] = [];
    const pipeEsperado = grupo === "B" ? PIPELINE_POS_VENDA : PIPELINE_CAPTACAO;
    for (const r of rows) {
      if (!orcamentoOk(45)) break;
      try {
        const l: any = await kommoGet(`/leads/${r.lead_id_kommo}`, env);
        res.push({ lead: String(r.lead_id_kommo), pipeline_ok: l.pipeline_id === pipeEsperado, etapa: l.status_id, tem_id_agenda: !!getFieldValue(l, fIdAg), tem_id_paciente: !!getFieldValue(l, fIdPac) });
      } catch (e) { res.push({ lead: String(r.lead_id_kommo), erro: String(e) }); }
    }
    return res;
  };
  out.kommo_cards_B = await checaCards("B", 10);
  out.kommo_cards_A = await checaCards("A", 8);

  out.subreq_total = subreqUsados;
  return out;
}

// ── Split de colisão de telefone: lead mapeado p/ >1 paciente CNN (familiares c/ mesmo nº).
// O "dono" (ID Paciente CNN gravado no card) fica com o card; cada paciente ESCONDIDO ganha um
// card NOVO (mesmo telefone, nome próprio, agenda própria) e é remapeado pra ele (criarCardLead
// já faz upsertMapeamento → anti-ressurreição mantém estável, sem re-colidir). dry=lista, dry=0 cria.
async function splitColisaoTelefone(env: Env, dryRun: boolean): Promise<any> {
  await ensureSchema(env);
  resetSubreq();
  const out: any = { dryRun, criados: 0, colisoes: [] as any[] };
  const fields = await resolveFields(env);
  const fIdPac = fields["ID Paciente CNN"];
  const nomeCache = new Map<string, string>();
  const nomeDe = async (pid: string): Promise<string> => {
    if (nomeCache.has(pid)) return nomeCache.get(pid)!;
    let n = `Paciente CNN ${pid}`;
    try { const p: any = await cnnGet(`/paciente/${pid}`, env, "production"); n = p?.nome ?? p?.nomeCompleto ?? p?.nomePaciente ?? n; } catch { /* ignore */ }
    nomeCache.set(pid, n); return n;
  };
  const shared = ((await env.DB.prepare(
    `SELECT lead_id_kommo FROM mapeamento WHERE lead_id_kommo IS NOT NULL GROUP BY lead_id_kommo HAVING COUNT(*) > 1`,
  ).all()).results ?? []) as any[];
  for (const s of shared) {
    if (!orcamentoOk(40)) { out.parou_orcamento = true; break; }
    const leadId = String(s.lead_id_kommo);
    const rows = ((await env.DB.prepare(`SELECT paciente_id_cnn, grupo, telefone_norm FROM mapeamento WHERE lead_id_kommo=?`).bind(leadId).all()).results ?? []) as any[];
    let dono = "";
    try { const l: any = await kommoGet(`/leads/${leadId}`, env); dono = String(getFieldValue(l, fIdPac) ?? ""); } catch { /* ignore */ }
    const donoEff = dono || String(rows[0]?.paciente_id_cnn ?? ""); // se o card não tem ID Paciente, o 1º fica
    const colisao: any = { lead: leadId, grupo: rows[0]?.grupo, dono: { pid: donoEff, nome: await nomeDe(donoEff) }, novos: [] as any[] };
    for (const r of rows) {
      const pid = String(r.paciente_id_cnn);
      if (pid === donoEff) continue;
      const grupo = (r.grupo === "B" ? "B" : "A") as "A" | "B";
      const nome = await nomeDe(pid);
      const ag = await env.DB.prepare(`SELECT agenda_id_cnn, last_agendamento_ts, last_cnn_status FROM agenda_sync WHERE paciente_id_cnn=? ORDER BY last_agendamento_ts DESC LIMIT 1`).bind(pid).first<any>();
      const tel = String(r.telefone_norm ?? "");
      const item: any = { pid, grupo, nome, agenda: ag?.agenda_id_cnn ?? null, status: ag?.last_cnn_status ?? null };
      if (!dryRun) {
        const etapa = destinoStatus(grupo, String(ag?.last_cnn_status ?? "")) ?? ETAPA_BASE[grupo];
        const novo = await criarCardLead({ grupo, nome, telefone: tel, cnnTs: Number(ag?.last_agendamento_ts ?? 0), agendaId: String(ag?.agenda_id_cnn ?? ""), pid, etapa, status: String(ag?.last_cnn_status ?? "") }, env, fields);
        item.novo_lead = novo ?? null;
        if (novo) out.criados++;
      }
      colisao.novos.push(item);
    }
    if (colisao.novos.length) out.colisoes.push(colisao);
  }
  out.subreq_total = subreqUsados;
  return out;
}

// ── Consolida colisão de família: lead compartilhado por >1 paciente CNN (mesmo telefone) →
// mantém 1 card só e renomeia com os PRIMEIROS nomes juntos ("Bruno x Letícia x ..."). dry=preview.
async function consolidarColisao(env: Env, target: CnnTarget, dryRun: boolean): Promise<any> {
  resetSubreq();
  const out: any = { dryRun, renomeados: 0, colisoes: [] as any[] };
  const nomeCache = new Map<string, string>();
  const primeiro = async (pid: string): Promise<string> => {
    if (nomeCache.has(pid)) return nomeCache.get(pid)!;
    let n = pid;
    try { const p: any = await cnnGet(`/paciente/${pid}`, env, target); const full = String(p?.nome ?? p?.nomeCompleto ?? p?.nomePaciente ?? "").trim(); if (full) n = full.split(/\s+/)[0]; } catch { /* */ }
    nomeCache.set(pid, n); return n;
  };
  const shared = ((await env.DB.prepare("SELECT lead_id_kommo FROM mapeamento WHERE lead_id_kommo IS NOT NULL GROUP BY lead_id_kommo HAVING COUNT(*) > 1").all()).results ?? []) as any[];
  for (const s of shared) {
    if (!orcamentoOk(44)) { out.parou_orcamento = true; break; }
    const leadId = String(s.lead_id_kommo);
    const pacs = ((await env.DB.prepare("SELECT DISTINCT paciente_id_cnn FROM mapeamento WHERE lead_id_kommo=?").bind(leadId).all()).results ?? []) as any[];
    const nomes: string[] = [];
    for (const p of pacs) nomes.push(await primeiro(String(p.paciente_id_cnn)));
    const novoNome = [...new Set(nomes)].join(" x ");
    if (!dryRun) { await kommoPatch(`/leads/${leadId}`, { name: novoNome }, env); out.renomeados++; }
    out.colisoes.push({ lead: leadId, novo_nome: novoNome, pacientes: pacs.map((p: any) => String(p.paciente_id_cnn)) });
  }
  out.subreq_total = subreqUsados;
  return out;
}

// ── Mapa de campos p/ Task 4: campos personalizados da Kommo (com enums dos campos de
// procedimento/especialidade) × lista de procedimentos do CNN. Só leitura.
async function mapaCampos(env: Env, target: CnnTarget): Promise<any> {
  resetSubreq();
  const out: any = { target };
  try {
    const cf: any = await kommoGet("/leads/custom_fields?limit=250", env);
    out.kommo_campos = (cf._embedded?.custom_fields ?? []).map((f: any) => {
      const rel = f.type === "select" || f.type === "multiselect" || /proced|especial|especific|corpora|facia/i.test(String(f.name ?? ""));
      return { id: f.id, name: f.name, type: f.type, ...(rel ? { enums: (f.enums ?? []).map((e: any) => ({ id: e.id, value: e.value })) } : {}) };
    });
  } catch (e) { out.kommo_erro = String(e); }
  const procs: any[] = []; let pag = 0, totalPag = 1;
  while (pag < totalPag) {
    let r: any;
    try { r = await cnnGet(`/tipo-procedimento/lista?somenteAtivos=true&registrosPorPagina=200&pagina=${pag}`, env, target); } catch (e) { out.cnn_erro = String(e); break; }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1);
    for (const p of (r?.lista ?? [])) procs.push({ id: p.id, nome: p.nome, especialidades: (p.especialidades ?? []).map((e: any) => e.nome) });
    pag++;
  }
  out.cnn_procedimentos = procs;
  out.cnn_procedimentos_total = procs.length;
  out.subreq_total = subreqUsados;
  return out;
}

// ── Task 4 (carga histórica): PRODUTOR — varre agendas de 2026, classifica cada paciente
// numa tabela de trabalho `backfill_hist`. Resumável por página. Só lê CNN + escreve a tabela
// de trabalho (não toca Kommo). tem_a/tem_b = teve agenda A/B no passado (01/01→hoje);
// tem_futuro = tem agenda ativa de hoje→+6m. Telefone p/ o consumidor depois.
async function produzirBackfillHist(env: Env, target: CnnTarget, cursorPag: number, budgetPag: number, reset: boolean): Promise<any> {
  await ensureSchema(env);
  resetSubreq();
  if (reset) { await env.DB.prepare("DROP TABLE IF EXISTS backfill_hist").run(); await setCursor("backfill_hist_pag", "0", env); }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS backfill_hist (paciente_id_cnn TEXT PRIMARY KEY, tem_a INTEGER DEFAULT 0, tem_b INTEGER DEFAULT 0, tem_futuro INTEGER DEFAULT 0, agenda_futura TEXT, telefone TEXT, atualizado_em INTEGER)`).run();
  const tiposMap = await resolveTiposConsulta(env, target);
  const hoje = todayBRT(); const hojeTs = Math.floor(Date.now() / 1000);
  const di = "2026-01-01", df = "2026-12-31";
  const out: any = { di, df, cursor_ini: cursorPag };
  const acc = new Map<string, { a: number; b: number; fut: number; agFut: string | null; tel: string }>();
  let pag = cursorPag, totalPag = cursorPag + 1, lidas = 0, agendas = 0;
  while (pag < totalPag && lidas < budgetPag && orcamentoOk(48)) {
    let r: any;
    try { r = await cnnGet(`/agenda/lista?dataInicial=${di}&dataFinal=${df}&registrosPorPagina=100&pagina=${pag}`, env, target); } catch (e) { out.cnn_erro = String(e); break; }
    totalPag = Math.max(r?.totalPaginas ?? 1, 1);
    for (const a of (r?.lista ?? [])) {
      agendas++;
      if (isTarefaInterna(a)) continue;
      const pid = String(a.idPaciente ?? ""); if (!pid) continue;
      const grupo = grupoDaAgenda(a, tiposMap);
      const data = String(a.data ?? "");
      const ts = (a.data && a.horaInicio) ? brtToUnix(a.data, a.horaInicio.slice(0, 5)) : 0;
      const passado = data >= "2026-01-01" && data <= hoje;
      const futuroAtivo = ts >= hojeTs && !STATUS_TERMINAL.has(String(a.status ?? ""));
      const cur = acc.get(pid) ?? { a: 0, b: 0, fut: 0, agFut: null, tel: "" };
      if (passado && grupo === "A") cur.a = 1;
      if (passado && grupo === "B") cur.b = 1;
      if (futuroAtivo) { cur.fut = 1; if (!cur.agFut) cur.agFut = String(a.id); }
      const tel = normalizePhone(a.telefoneCelularPaciente ?? ""); if (tel && !cur.tel) cur.tel = tel;
      acc.set(pid, cur);
    }
    pag++; lidas++;
  }
  const stmts = [...acc.entries()].map(([pid, v]) => env.DB.prepare(
    `INSERT INTO backfill_hist (paciente_id_cnn,tem_a,tem_b,tem_futuro,agenda_futura,telefone,atualizado_em) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(paciente_id_cnn) DO UPDATE SET tem_a=GREATEST(tem_a,excluded.tem_a), tem_b=GREATEST(tem_b,excluded.tem_b), tem_futuro=GREATEST(tem_futuro,excluded.tem_futuro), agenda_futura=COALESCE(agenda_futura,excluded.agenda_futura), telefone=COALESCE(NULLIF(telefone,''),excluded.telefone)`,
  ).bind(pid, v.a, v.b, v.fut, v.agFut, v.tel, hojeTs));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await setCursor("backfill_hist_pag", String(pag), env);
  out.paginas_lidas = lidas; out.agendas_lidas = agendas; out.pacientes_no_lote = acc.size;
  out.proximo_cursor = pag; out.total_paginas = totalPag; out.done = pag >= totalPag;
  out.subreq_total = subreqUsados;
  return out;
}
// Agregador da medição: conta as categorias da Task 4 + quantos já têm card.
async function medirBackfillHist(env: Env): Promise<any> {
  await ensureSchema(env);
  const n = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
  const out: any = {};
  out.total_pacientes = await n("SELECT COUNT(*) n FROM backfill_hist");
  out.cliente_ativo_futuro = await n("SELECT COUNT(*) n FROM backfill_hist WHERE tem_futuro=1");
  out.perdido_posvenda = await n("SELECT COUNT(*) n FROM backfill_hist WHERE tem_futuro=0 AND tem_b=1");
  out.perdido_captacao = await n("SELECT COUNT(*) n FROM backfill_hist WHERE tem_futuro=0 AND tem_b=0 AND tem_a=1");
  out.ja_tem_card = await n("SELECT COUNT(*) n FROM backfill_hist h WHERE EXISTS (SELECT 1 FROM mapeamento m WHERE m.paciente_id_cnn=h.paciente_id_cnn)");
  out.sem_card_novos = out.total_pacientes - out.ja_tem_card;
  out.cursor_pagina = (await getCursor("backfill_hist_pag", env)) ?? "?";
  return out;
}

// ── Task 4 CONSUMIDOR: cria/atualiza cards a partir de `backfill_hist`, com as 3 decisões.
// Mapeia procedimento (Corporais/Faciais) só p/ Cliente Ativo; Especialidade e não-casados →
// em branco. Idempotente (chave ID Paciente CNN via `mapeamento`), resumável (flag processado).
let camposProcCache: { corp: number; fac: number; corpEnums: Map<string, number>; facEnums: Map<string, number>; ts: number } | null = null;
function normProc(s: string): string {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\bav\b/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
async function resolveCamposProc(env: Env) {
  if (camposProcCache && Date.now() - camposProcCache.ts < 3600000) return camposProcCache;
  const cf: any = await kommoGet("/leads/custom_fields?limit=250", env);
  const list = cf._embedded?.custom_fields ?? [];
  const pega = (nome: string) => {
    const f = list.find((x: any) => x.name === nome);
    const m = new Map<string, number>();
    for (const e of (f?.enums ?? [])) m.set(normProc(e.value), e.id);
    return { id: f?.id ?? 0, enums: m };
  };
  const c = pega("Corporais"), f = pega("Faciais");
  camposProcCache = { corp: c.id, fac: f.id, corpEnums: c.enums, facEnums: f.enums, ts: Date.now() };
  return camposProcCache;
}
function casarProc(nomeCnn: string, cp: NonNullable<typeof camposProcCache>): { campo: number; enumId: number; opcao: string } | null {
  const n = normProc(nomeCnn);
  if (!n) return null;
  const tenta = (enums: Map<string, number>, campo: number) => {
    for (const [opt, id] of enums) {
      const ws = opt.split(" ").filter((w) => w.length >= 4); // exige TODAS as palavras significativas
      if (ws.length && ws.every((w) => n.includes(w))) return { campo, enumId: id, opcao: opt };
    }
    return null;
  };
  return tenta(cp.corpEnums, cp.corp) ?? tenta(cp.facEnums, cp.fac);
}
async function consumirBackfillHist(env: Env, target: CnnTarget, dryRun: boolean, max: number): Promise<any> {
  await ensureSchema(env);
  resetSubreq();
  try { await env.DB.prepare("ALTER TABLE backfill_hist ADD COLUMN processado INTEGER DEFAULT 0").run(); } catch { /* coluna já existe */ }
  const fields = await resolveFields(env);
  const fAg = fields["AGENDAMENTO"], fIdAg = fields["ID Agenda CNN"], fIdPac = fields["ID Paciente CNN"], fAniv = fields["Aniversário"];
  const cp = await resolveCamposProc(env);
  const out: any = { dryRun, processados: 0, criados: 0, atualizados: 0, reroteados: 0, erros: 0, por_categoria: { ativo: 0, perdido_pv: 0, perdido_capt: 0 }, amostra: [] as any[] };
  const rows = ((await env.DB.prepare("SELECT paciente_id_cnn, tem_a, tem_b, tem_futuro, agenda_futura, telefone FROM backfill_hist WHERE processado=0 AND (tem_a=1 OR tem_b=1) LIMIT ?").bind(max).all()).results ?? []) as any[];
  for (const r of rows) {
    if (!orcamentoOk(44)) { out.parou_orcamento = true; break; }
    const pid = String(r.paciente_id_cnn);
    const ativo = r.tem_futuro === 1;
    const categoria = ativo ? "ativo" : (r.tem_b === 1 ? "perdido_pv" : "perdido_capt");
    const grupo: "A" | "B" = categoria === "perdido_capt" ? "A" : "B";
    const pipeline = grupo === "B" ? PIPELINE_POS_VENDA : PIPELINE_CAPTACAO;
    const stage = ativo ? STAGE_POS_CLIENTE_ATIVO : STAGE_CANCELADA_PERDIDO;
    const tel = String(r.telefone ?? "");
    try {
      const pac: any = await cnnGet(`/paciente/${pid}`, env, target);
      const nome = pac?.nome ?? pac?.nomeCompleto ?? pac?.nomePaciente ?? `Paciente CNN ${pid}`;
      const nasc = pac?.dataNascimento ? String(pac.dataNascimento).slice(0, 10) : "";
      const tsNasc = nasc ? Math.floor(new Date(nasc + "T12:00:00Z").getTime() / 1000) : 0;
      let cnnTs = 0, agendaId = ""; const procCampos: any[] = []; const procNomes: string[] = [];
      if (ativo && r.agenda_futura) {
        agendaId = String(r.agenda_futura);
        try {
          const ag: any = await cnnGet(`/agenda/${agendaId}`, env, target);
          cnnTs = (ag?.data && ag?.horaInicio) ? brtToUnix(ag.data, ag.horaInicio.slice(0, 5)) : 0;
          const setEnums = new Map<number, Set<number>>();
          for (const p of (ag?.procedimentos ?? [])) {
            const nm = p?.nome ?? p?.nomeProcedimento ?? "";
            const m = casarProc(nm, cp);
            if (m) { if (!setEnums.has(m.campo)) setEnums.set(m.campo, new Set()); setEnums.get(m.campo)!.add(m.enumId); procNomes.push(`${nm}→${m.opcao}`); }
            else if (nm) procNomes.push(`${nm}→(branco)`);
          }
          for (const [campo, ids] of setEnums) procCampos.push({ field_id: campo, values: [...ids].map((id) => ({ enum_id: id })) });
        } catch { /* sem agenda → segue sem procedimento */ }
      }
      const cfBase: any[] = [
        ...(fAg && cnnTs ? [{ field_id: fAg, values: [{ value: cnnTs }] }] : []),
        ...(fIdAg && agendaId ? [{ field_id: fIdAg, values: [{ value: agendaId }] }] : []),
        { field_id: fIdPac, values: [{ value: pid }] },
        ...(fAniv && tsNasc ? [{ field_id: fAniv, values: [{ value: tsNasc }] }] : []),
        ...procCampos,
      ];
      const existente: any = await getMapeamento(pid, grupo, env);
      const item: any = { pid, nome, categoria, grupo, procedimentos: procNomes };
      if (existente?.lead_id_kommo) {
        const leadId = String(existente.lead_id_kommo);
        let et = 0; try { et = Number((await kommoGet(`/leads/${leadId}`, env)).status_id) || 0; } catch { /* */ }
        const vaiRerotear = !ativo && (et === STAGE_PRIMEIRO_CONTATO || et === STAGE_LEADS_ENTRADA);
        item.acao = vaiRerotear ? "re-rotear→perdido" : "atualizar"; item.lead = leadId; item.etapa_atual = et;
        if (!dryRun) {
          await kommoPatch(`/leads/${leadId}`, { custom_fields_values: cfBase }, env);
          if (vaiRerotear) { await moveLeadToStage(leadId, STAGE_CANCELADA_PERDIDO, env, pipeline); out.reroteados++; }
        }
        out.atualizados++;
      } else {
        item.acao = "criar";
        if (!dryRun) {
          const novo: any = await kommoPost("/leads/complex", [{
            name: nome, pipeline_id: pipeline, status_id: stage, custom_fields_values: cfBase,
            _embedded: { contacts: [{ name: nome, custom_fields_values: [{ field_code: "PHONE", values: [{ value: tel, enum_code: "WORK" }] }] }] },
          }], env);
          const leadId = novo?.[0]?.id ? String(novo[0].id) : undefined;
          item.lead = leadId ?? null;
          if (leadId) {
            await upsertMapeamento({ paciente_id_cnn: pid, grupo, lead_id_kommo: leadId, telefone_norm: phoneKey(tel), duplicata: false }, env);
            if (agendaId) await upsertAgendaSync({ agenda_id_cnn: agendaId, lead_id_kommo: leadId, paciente_id_cnn: pid, last_agendamento_ts: cnnTs, last_cnn_status: "AGENDADO" }, env);
          } else throw new Error("POST /leads/complex sem id");
        }
        out.criados++;
      }
      if (!dryRun) await env.DB.prepare("UPDATE backfill_hist SET processado=1 WHERE paciente_id_cnn=?").bind(pid).run();
      out.processados++; out.por_categoria[categoria]++;
      if (out.amostra.length < 20) out.amostra.push(item);
    } catch (e) { out.erros++; if (out.amostra.length < 20) out.amostra.push({ pid, erro: String(e) }); }
  }
  out.restantes = (await env.DB.prepare("SELECT COUNT(*) n FROM backfill_hist WHERE processado=0 AND (tem_a=1 OR tem_b=1)").first<{ n: number }>())?.n ?? 0;
  out.subreq_total = subreqUsados;
  return out;
}

// ── Varredura de aniversário: pra cada lead mapeado, lê dataNascimento no CNN e preenche o
// campo "Aniversário" na Kommo. Resumável (cursor por lead_id_kommo), idempotente. dry=lista.
async function varrerAniversario(env: Env, target: CnnTarget, dryRun: boolean, cursor: string, max: number): Promise<any> {
  await ensureSchema(env);
  resetSubreq();
  const fields = await resolveFields(env);
  const fAniv = fields["Aniversário"];
  const out: any = { dryRun, processados: 0, preenchidos: 0, sem_nascimento: 0, erros: 0, proximo_cursor: cursor, sweep_completo: false, amostra: [] as any[] };
  if (!fAniv) { out.erro = "campo Aniversário não encontrado em resolveFields"; return out; }
  const rows = ((await env.DB.prepare("SELECT paciente_id_cnn, lead_id_kommo FROM mapeamento WHERE lead_id_kommo IS NOT NULL AND lead_id_kommo > ? ORDER BY lead_id_kommo LIMIT ?").bind(cursor, max).all()).results ?? []) as any[];
  if (!rows.length) { out.sweep_completo = true; out.subreq_total = subreqUsados; return out; }
  const cache = new Map<string, string>();
  for (const r of rows) {
    if (!orcamentoOk(44)) { out.parou_orcamento = true; break; }
    const pid = String(r.paciente_id_cnn), leadId = String(r.lead_id_kommo);
    out.proximo_cursor = leadId;
    try {
      let nasc = cache.get(pid);
      if (nasc === undefined) { const p: any = await cnnGet(`/paciente/${pid}`, env, target); nasc = p?.dataNascimento ? String(p.dataNascimento).slice(0, 10) : ""; cache.set(pid, nasc); }
      out.processados++;
      if (!nasc) { out.sem_nascimento++; continue; }
      const ts = Math.floor(new Date(nasc + "T12:00:00Z").getTime() / 1000);
      if (!dryRun) await kommoPatch(`/leads/${leadId}`, { custom_fields_values: [{ field_id: fAniv, values: [{ value: ts }] }] }, env);
      out.preenchidos++;
      if (out.amostra.length < 12) out.amostra.push({ lead: leadId, pid, nasc });
    } catch (e) { out.erros++; }
  }
  out.subreq_total = subreqUsados;
  return out;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function webhookAuthOk(req: Request, env: Env): boolean {
  return new URL(req.url).searchParams.get("secret") === env.WEBHOOK_SECRET;
}
// ══════════════════════════════════════════════════════════════════════════════
// ══ MIGRAÇÃO SYNC ÚNICA (one-time CNN→Kommo) — Fase 0/1: PROBE read-only ════════
// Passe de correção único e IRREVERSÍVEL. Spec v3: docs/migracao/BACKLOG-MIGRACAO.md.
// Este bloco NÃO ESCREVE NADA (só leitura + classificação). Roda via `wrangler dev
// --remote` (preview isolada do cron). Corte de data confirmado 01/07/2026.
// Etapas-alvo verificadas ao vivo (/discover). Classificação = CÓDIGO determinístico.
// ══════════════════════════════════════════════════════════════════════════════
const MIG_FUTURO_INI = "2026-07-01";  // agenda.data >= isto → Bloco Futuro (vence tudo)
const MIG_FUTURO_FIM = "2028-01-01";
const MIG_PASSADO_INI = "2020-07-03"; // HOJE-6a (âncora fixa nesta v0; usar todayBRT()-6a no run real)
const MIG_SILENCIO_DIAS = 90;         // parcial + silêncio > isto (90D = 3 meses) → abandono (dono 03/07). <90D → tratamento iniciado.
const MIG_CONCLUIDO_PCT = 0.85;       // ≥ 85% das unidades do último aprovado feitas → concluído (dono 03/07).
// Faixa do campo Kommo "Inativo" (select). Rótulos EXATOS do Kommo (com espaço + faixa 1080 D+). <90d = vazio ("ainda não inativo").
function faixaInativo(sil: number): string {
  if (sil >= 1080) return "1080 D+";
  if (sil >= 720) return "720 D";
  if (sil >= 540) return "540 D";
  if (sil >= 360) return "360 D";
  if (sil >= 180) return "180 D";
  if (sil >= 90) return "90 D";
  return "";
}
// Etapas-alvo do Pós-Venda que NÃO têm constante própria no código (142/143 são genéricos → escopar por pipeline).
const MIG_STAGE_ABANDONO = 107774015;
const MIG_STAGE_CANCELAMENTO = 107774019;
const MIG_STAGE_CONCLUIDO = 142;

interface SinaisMig {
  temAgendaFutura: boolean;
  grupoFuturo: "A" | "B" | null;   // grupo do agendamento futuro (B vence)
  teveGrupoBPassado: boolean;
  teveOrcamentoGerado: boolean;
  orcAprovado: boolean;            // teve algum orçamento aprovado (dataAprovacao≠null)
  ultimoAprovadoISO: string | null;
  cancelouAposAprovar: boolean;    // aprovado depois CANCELADO/PERDIDO
  fezTodosProcedimentos: boolean;  // requeridos(aprovados) ⊆ feitos(agendas B FINALIZADO pós-aprovação)
  caudaFinalSoFalta: boolean;
  diasSilencio: number;
}

// Classificador PURO (determinístico, testável). Árvore v3 §3–§5. NÃO faz I/O.
// NOTA v0: §5.0 reset NÃO avaliado (orçamento não traz data de criação; ver spec).
function classificarMigracao(s: SinaisMig): { pipeline: number; stage: number; regra: string } {
  // §4 — BLOCO FUTURO (Lei da Agenda: vence tudo, inclusive cancelado)
  if (s.temAgendaFutura) {
    if (s.grupoFuturo === "B") return { pipeline: PIPELINE_POS_VENDA, stage: STAGE_POS_CLIENTE_ATIVO, regra: "4B_futuro_grupoB→cliente_ativo" };
    return { pipeline: PIPELINE_CAPTACAO, stage: STAGE_CONSULTA_AGENDADA, regra: "4A_futuro_grupoA→consulta_agendada" };
  }
  // §5 — BLOCO PASSADO (sem agenda futura)
  if (s.teveGrupoBPassado || s.orcAprovado) {
    // §5.1 — PÓS-VENDA (cascata, 1ª verdadeira vence). Refinada com o dono 03/07.
    if (s.cancelouAposAprovar)                                     return { pipeline: PIPELINE_POS_VENDA, stage: MIG_STAGE_CANCELAMENTO, regra: "5.1a_cancelou_apos_aprovar" };
    if (s.orcAprovado && s.fezTodosProcedimentos)                 return { pipeline: PIPELINE_POS_VENDA, stage: MIG_STAGE_CONCLUIDO, regra: "5.1b_concluido" };
    if (s.diasSilencio > MIG_SILENCIO_DIAS || s.caudaFinalSoFalta) return { pipeline: PIPELINE_POS_VENDA, stage: MIG_STAGE_ABANDONO, regra: "5.1c_abandono_silencio>180d" };
    if (s.orcAprovado)                                            return { pipeline: PIPELINE_POS_VENDA, stage: STAGE_POS_TRATAMENTO_INICIADO, regra: "5.1d_recente→tratamento_iniciado" };
    return { pipeline: PIPELINE_POS_VENDA, stage: STAGE_CANCELADA_PERDIDO, regra: "5.1e_fallback_perdido" };
  }
  // §5.3 — PÓS-CONSULTA (teve orçamento, nunca comprou, sem grupo B)
  if (s.teveOrcamentoGerado) return { pipeline: PIPELINE_POS_CONSULTA, stage: STAGE_POSCONS_VENDA_PERDIDA, regra: "5.3_posconsulta_perdido" };
  // §5.2 — CAPTURA (só grupo A, sem orçamento)
  return { pipeline: PIPELINE_CAPTACAO, stage: STAGE_CANCELADA_PERDIDO, regra: "5.2_captura_perdido" };
}

// Lê TODAS as agendas de 1 paciente na janela de 6 anos + futuro (paginado, read-only).
async function migAgendasPaciente(pid: string, env: Env, target: CnnTarget): Promise<any[]> {
  const out: any[] = []; let pag = 0, totalPag = 1;
  while (pag < totalPag && orcamentoOk(48)) {
    let r: any;
    try { r = await cnnGet(`/agenda/lista?codigoPaciente=${pid}&dataInicial=${MIG_PASSADO_INI}&dataFinal=${MIG_FUTURO_FIM}&registrosPorPagina=200&pagina=${pag}`, env, target); }
    catch { break; }
    const lista = r?.lista ?? []; if (!lista.length) break;
    out.push(...lista); totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
  }
  return out;
}
// Orçamentos de 1 paciente na janela ampla de 6 anos (por CRIACAO), paginado (read-only).
async function migOrcamentosPaciente(pid: string, env: Env, target: CnnTarget): Promise<any[]> {
  const out: any[] = []; let pag = 0, totalPag = 1;
  while (pag < totalPag && orcamentoOk(48)) {
    let r: any;
    try { r = await cnnGet(`/orcamento/lista?idPaciente=${pid}&dataInicial=${MIG_PASSADO_INI}&dataFinal=${todayBRT()}&tipoData=CRIACAO&registrosPorPagina=50&pagina=${pag}`, env, target); }
    catch { break; }
    const lista = r?.lista ?? []; if (!lista.length) break;
    out.push(...lista); totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
  }
  return out;
}

// Deriva os sinais determinísticos a partir das agendas + orçamentos (puro).
function derivarSinaisMig(agendas: any[], orcamentos: any[], tiposMap: Record<string, string>): { sinais: SinaisMig; detalhe: any } {
  const ags = agendas.map((a: any) => ({
    id: a.id, data: String(a.data ?? "").slice(0, 10), status: a.status,
    grupo: grupoDaAgenda(a, tiposMap),
    procs: (a.procedimentos ?? []).map((p: any) => p.idTipoProcedimento),
  }));
  const agsFut = ags.filter((a) => a.data >= MIG_FUTURO_INI && a.data <= MIG_FUTURO_FIM);
  const temFutura = agsFut.length > 0;
  const grupoFuturo: "A" | "B" | null = agsFut.some((a) => a.grupo === "B") ? "B" : (agsFut.some((a) => a.grupo === "A") ? "A" : null);
  const agsPass = ags.filter((a) => a.data < MIG_FUTURO_INI);
  const teveGrupoB = agsPass.some((a) => a.grupo === "B");

  const orcs = orcamentos.map((o: any) => ({
    id: Number(o.id), status: o.status,
    aprov: o.dataAprovacao ? String(o.dataAprovacao).slice(0, 10) : null,
    valor: o.valorLiquido,
    procs: (o.procedimentos ?? []).map((p: any) => ({ tipo: p.idTipoProcedimento, qtd: Number(p.quantidade ?? 1) })),
  }));
  const aprovados = orcs.filter((o) => o.aprov);                    // já teve aprovação (dataAprovacao≠null)
  const orcAprovado = aprovados.length > 0;
  // FIX#2 — estado LÍQUIDO: o orçamento com a aprovação MAIS RECENTE manda. Reaprovar depois de
  // cancelar vence o cancelamento antigo (senão pid 5335104 vira "cancelamento" indevido).
  const maisRecenteAprov = orcAprovado ? aprovados.slice().sort((a, b) => (a.aprov! < b.aprov! ? -1 : a.aprov! > b.aprov! ? 1 : 0)).slice(-1)[0] : null;
  const ultimoAprovadoISO = maisRecenteAprov?.aprov ?? null;
  const cancelouAposAprovar = !!maisRecenteAprov && (maisRecenteAprov.status === "CANCELADO" || maisRecenteAprov.status === "PERDIDO");

  // "fez todos os procedimentos": requeridos = procs do último-aprovado (se AINDA APROVADO);
  // FIX#1 — feitos = agendas FINALIZADO de QUALQUER grupo (procedimentos executados também em Consulta/Avaliação), pós-aprovação.
  const requeridos = new Map<string, number>();
  if (maisRecenteAprov && maisRecenteAprov.status === "APROVADO") {
    for (const p of maisRecenteAprov.procs) if (p.tipo != null) requeridos.set(String(p.tipo), (requeridos.get(String(p.tipo)) ?? 0) + (p.qtd || 1));
  }
  const feitos = new Map<string, number>();
  for (const a of ags) if (a.status === "FINALIZADO" && (!ultimoAprovadoISO || a.data >= ultimoAprovadoISO)) {
    for (const t of a.procs) if (t != null) feitos.set(String(t), (feitos.get(String(t)) ?? 0) + 1);
  }
  // "fez todos" = cobertura por UNIDADES (capadas por tipo) ≥ limiar. Substitui o 100%-exato,
  // que jogava quase-concluídos (ex.: 10/12) no abandono. Extra de um tipo NÃO compensa falta de outro.
  let totalReq = 0, coberto = 0;
  for (const [t, q] of requeridos) { totalReq += q; coberto += Math.min(feitos.get(t) ?? 0, q); }
  const coberturaPct = totalReq > 0 ? coberto / totalReq : 0;
  const fezTodos = totalReq > 0 && coberturaPct >= MIG_CONCLUIDO_PCT;

  // cauda final só falta: últimas 3 agendas passadas = FALTOU/CANCELADO_PACIENTE/CANCELADO, sem agenda futura
  const passOrd = agsPass.slice().sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  const ult3 = passOrd.slice(-3);
  const caudaSoFalta = !temFutura && ult3.length > 0 && ult3.every((a) => a.status === "FALTOU" || a.status === "CANCELADO_PACIENTE" || a.status === "CANCELADO");

  const todasDatas = [...ags.map((a) => a.data), ...aprovados.map((o) => o.aprov as string)].filter(Boolean).sort();
  const ultAtividade = todasDatas.length ? todasDatas[todasDatas.length - 1] : null;
  const diasSilencio = ultAtividade ? Math.floor((Date.parse(todayBRT()) - Date.parse(ultAtividade)) / 86400000) : 99999;

  const sinais: SinaisMig = {
    temAgendaFutura: temFutura, grupoFuturo, teveGrupoBPassado: teveGrupoB,
    teveOrcamentoGerado: orcs.length > 0, orcAprovado, ultimoAprovadoISO,
    cancelouAposAprovar, fezTodosProcedimentos: fezTodos, caudaFinalSoFalta: caudaSoFalta, diasSilencio,
  };
  // DIAGNÓSTICO: quais idTipoProcedimento aparecem em QUALQUER agenda FINALIZADA (qualquer grupo)
  const finalizadosTipos = new Set<string>();
  for (const a of ags) if (a.status === "FINALIZADO") for (const t of a.procs) if (t != null) finalizadosTipos.add(String(t));
  const detalhe = {
    n_agendas: ags.length, n_orcamentos: orcs.length,
    requeridos: [...requeridos], feitos: [...feitos], cobertura_pct: Math.round(coberturaPct * 100), finalizados_tipos: [...finalizadosTipos],
    agendas_ultimas8: ags.slice(-8).map((a) => ({ data: a.data, status: a.status, grupo: a.grupo, procs: a.procs })),
    orcamentos_resumo: orcs.map((o) => ({ id: o.id, status: o.status, aprov: o.aprov, valor: o.valor, procs: o.procs.map((p: any) => p.tipo) })),
  };
  return { sinais, detalhe };
}

// Handler read-only: sonda 1 paciente → sinais + classificação + etapa atual no Kommo + custo em subreq.
async function handleMigProbe(req: Request, env: Env): Promise<Response> {
  resetSubreq();
  const url = new URL(req.url);
  const target: CnnTarget = url.searchParams.get("env") === "production" ? "production" : "sandbox";
  const pid = url.searchParams.get("pid") ?? "";
  if (!pid) return Response.json({ erro: "faltou ?pid=" });
  const tiposMap = await resolveTiposConsulta(env, target);
  const agendas = await migAgendasPaciente(pid, env, target);
  const orcamentos = await migOrcamentosPaciente(pid, env, target);
  const { sinais, detalhe } = derivarSinaisMig(agendas, orcamentos, tiposMap);
  const alvo = classificarMigracao(sinais);
  // Etapa atual no Kommo por ID Paciente CNN (identidade forte). Read-only.
  const fields = await resolveFields(env);
  const fIdPac = fields["ID Paciente CNN"];
  let kommoAtual: any = null;
  try {
    const raw: any = await kommoGet(`/leads?query=${encodeURIComponent(pid)}&limit=250`, env);
    const leads = (raw._embedded?.leads ?? []).filter((l: any) => getFieldValue(l, fIdPac) === pid);
    kommoAtual = leads.map((l: any) => ({ lead: l.id, pipeline: l.pipeline_id, status: l.status_id }));
  } catch (e) { kommoAtual = { erro: String(e) }; }
  return Response.json({ pid, target, sinais, alvo, kommo_atual: kommoAtual, detalhe, subreq_usados: subreqUsados });
}

// ══ /debug-audit — AUDITORIA READ-ONLY da base: re-roda o classificador da migração no estado
// ATUAL do CNN e compara com o Kommo por dimensão (etapa, Inativo, valor, duplicatas). NÃO ESCREVE
// NADA. Reusa a MESMA regra acordada (derivarSinaisMig + classificarMigracao). 1 auditoria por
// PACIENTE (não por card). Paginado (offset/limite) + time-bound 45s (cabe no limite Vercel).
// Uso: /debug-audit?env=production&offset=0&limite=10   → varrer em passagens seguindo proximo_offset.
async function handleDebugAudit(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const target: CnnTarget = url.searchParams.get("env") === "production" ? "production" : "sandbox";
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const limite = Math.min(40, Math.max(1, Number(url.searchParams.get("limite") ?? "10") || 10));
  const t0 = Date.now();
  const fields = await resolveFields(env);
  const fIdPac = fields["ID Paciente CNN"];
  const fInativo = fields["Inativo"];
  const tiposMap = await resolveTiposConsulta(env, target);

  const rows = ((await env.DB.prepare(
    "SELECT DISTINCT paciente_id_cnn FROM mapeamento WHERE lead_id_kommo IS NOT NULL AND lead_id_kommo <> '' ORDER BY paciente_id_cnn LIMIT ? OFFSET ?"
  ).bind(limite, offset).all()).results ?? []) as any[];

  const out: any = {
    target, offset, limite, examinados: 0,
    div_etapa: 0, div_inativo: 0, div_valor: 0, div_duplicata: 0, sem_card_alvo: 0, erro_leitura: 0, erros: 0, ok: 0,
    amostra: [] as any[], proximo_offset: offset, fim: false,
  };

  for (const r of rows) {
    if (Date.now() - t0 > 45000) { out.parou_tempo = true; break; }
    const pid = String(r.paciente_id_cnn);
    out.examinados++;
    resetSubreq(); // orçamento de leitura por-paciente (mig funcs usam orcamentoOk); na Vercel não há teto real
    try {
      const sweep = await migAgendasSweep(pid, env, target);
      if (!sweep.ok) { out.erro_leitura++; continue; }
      const orcs = await migOrcamentosPaciente(pid, env, target);
      const { sinais, detalhe } = derivarSinaisMig(sweep.agendas, orcs, tiposMap);
      const alvo = classificarMigracao(sinais);
      const inativoAlvo = faixaInativo(sinais.diasSilencio);
      const aprovados = (detalhe.orcamentos_resumo ?? []).filter((o: any) => o.status === "APROVADO");
      const valorAlvo = aprovados.length ? Math.round(Number(aprovados[aprovados.length - 1].valor ?? 0)) : 0;

      const raw: any = await kommoGet(`/leads?query=${encodeURIComponent(pid)}&limit=250`, env);
      const cards = (raw._embedded?.leads ?? []).filter((l: any) => getFieldValue(l, fIdPac) === pid);

      const divs: string[] = [];
      // Duplicata: máx 1 card por GRUPO (A = Captação/Pós-Consulta; B = Pós-Venda). Conta por grupo,
      // não por pipeline — assim pega "2 cards no lado A" (captação + pós-consulta juntos).
      const porGrupo: Record<string, number> = { A: 0, B: 0 };
      for (const c of cards) porGrupo[Number(c.pipeline_id) === PIPELINE_POS_VENDA ? "B" : "A"]++;
      if (porGrupo.A > 1 || porGrupo.B > 1 || cards.length > 2) { out.div_duplicata++; divs.push("duplicata"); }

      const cardAlvo = cards.find((c: any) => Number(c.pipeline_id) === alvo.pipeline);
      if (!cardAlvo) { out.sem_card_alvo++; divs.push("sem_card_alvo"); }
      else {
        if (Number(cardAlvo.status_id) !== alvo.stage) { out.div_etapa++; divs.push("etapa"); }
        const inativoAtual = fInativo ? String(getFieldValue(cardAlvo, fInativo) ?? "") : "";
        if ((inativoAtual || "").trim() !== (inativoAlvo || "").trim()) { out.div_inativo++; divs.push("inativo"); }
        const priceAtual = Math.round(Number(cardAlvo.price ?? 0));
        if (valorAlvo > 0 && priceAtual !== valorAlvo) { out.div_valor++; divs.push("valor"); }
      }
      if (!divs.length) { out.ok++; continue; }
      if (out.amostra.length < 25) out.amostra.push({
        pid, divs, regra: alvo.regra,
        alvo: { pipeline: alvo.pipeline, stage: alvo.stage, inativo: inativoAlvo, valor: valorAlvo, silencio: sinais.diasSilencio, temFutura: sinais.temAgendaFutura },
        cards: cards.map((c: any) => ({ lead: c.id, pipeline: c.pipeline_id, stage: c.status_id, price: c.price ?? 0, inativo: fInativo ? getFieldValue(c, fInativo) : null, nome: c.name })),
      });
    } catch (e) { out.erros++; if (out.amostra.length < 25) out.amostra.push({ pid, erro: String(e).slice(0, 160) }); }
  }
  out.proximo_offset = offset + out.examinados;
  out.fim = !out.parou_tempo && rows.length < limite;
  return Response.json(out);
}

// Readers do SWEEP: teto RÍGIDO de páginas (independente do contador global subreqUsados) →
// seguros sob concorrência (requests paralelos não se corrompem via o global). Janela futura é
// consultada à parte (detecção confiável do Bloco Futuro, sem depender de ordenação da paginação).
async function migAgendasSweep(pid: string, env: Env, target: CnnTarget): Promise<{ agendas: any[]; capHit: boolean; ok: boolean }> {
  const out: any[] = []; let capHit = false, ok = true;
  // ok=false se a leitura FALHAR (429/rede) → o chamador marca "erro_leitura", NÃO "sem histórico".
  try { const rf: any = await cnnGet(`/agenda/lista?codigoPaciente=${pid}&dataInicial=${MIG_FUTURO_INI}&dataFinal=${MIG_FUTURO_FIM}&registrosPorPagina=200&pagina=0`, env, target, retrySweep()); out.push(...(rf?.lista ?? [])); } catch { ok = false; }
  let pag = 0, totalPag = 1;
  while (pag < totalPag && pag < 3) {
    let r: any; try { r = await cnnGet(`/agenda/lista?codigoPaciente=${pid}&dataInicial=${MIG_PASSADO_INI}&dataFinal=2026-06-30&registrosPorPagina=200&pagina=${pag}`, env, target, retrySweep()); } catch { if (pag === 0) ok = false; break; }
    out.push(...(r?.lista ?? [])); totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
  }
  if (totalPag > 3) capHit = true;
  return { agendas: out, capHit, ok };
}
async function migOrcamentosSweep(pid: string, env: Env, target: CnnTarget): Promise<{ orcamentos: any[]; capHit: boolean; ok: boolean }> {
  const out: any[] = []; let pag = 0, totalPag = 1, ok = true;
  while (pag < totalPag && pag < 2) {
    let r: any; try { r = await cnnGet(`/orcamento/lista?idPaciente=${pid}&dataInicial=${MIG_PASSADO_INI}&dataFinal=${todayBRT()}&tipoData=CRIACAO&registrosPorPagina=50&pagina=${pag}`, env, target, retrySweep()); } catch { if (pag === 0) ok = false; break; }
    out.push(...(r?.lista ?? [])); totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
  }
  return { orcamentos: out, capHit: totalPag > 2, ok };
}

// Sweep read-only: classifica uma PÁGINA de pacientes do /paciente/lista (CNN-only, sem Kommo).
// Driver externo/agentes iteram `pagina` de 0..total_paginas. Cada request fica sob o teto de 50 subreq.
async function handleMigSweep(req: Request, env: Env): Promise<Response> {
  resetSubreq();
  const url = new URL(req.url);
  const target: CnnTarget = url.searchParams.get("env") === "production" ? "production" : "sandbox";
  const pagina = Number(url.searchParams.get("pagina") ?? "0");
  const rpp = Math.max(1, Math.min(Number(url.searchParams.get("rpp") ?? "5"), 10));
  const tiposMap = await resolveTiposConsulta(env, target);
  let lista: any[] = []; let totalPaginas = 0;
  try {
    const r: any = await cnnGet(`/paciente/lista?registrosPorPagina=${rpp}&pagina=${pagina}`, env, target);
    lista = r?.lista ?? []; totalPaginas = Number(r?.totalPaginas ?? 0);
  } catch (e) { return Response.json({ erro: String(e), pagina }); }
  const porRegra: Record<string, number> = {};
  const porEtapa: Record<string, number> = {};
  const linhas: any[] = [];
  let processados = 0, incompletos = 0, errosLeitura = 0;
  for (const pac of lista) {
    const pid = String(pac.id ?? pac.idPaciente ?? "");
    if (!pid) continue;
    const ra = await migAgendasSweep(pid, env, target);
    const ro = await migOrcamentosSweep(pid, env, target);
    if (!ra.ok || !ro.ok) { // leitura FALHOU (429/rede) → NÃO classificar como "sem histórico"; marcar erro
      errosLeitura++;
      linhas.push({ pid, nome: pac.nome ?? "", tel: pac.telefoneCelular ?? pac.telefone ?? "", regra: "erro_leitura", stage: 0,
        na: ra.agendas.length, no: ro.orcamentos.length, cob: 0, sil: null, inativo: "", aprov: null, cancApos: null, fezTodos: null, fut: null, gFut: null, flags: ["erro_leitura"] });
      continue;
    }
    const agendas = ra.agendas, orcamentos = ro.orcamentos;
    const incompleto = ra.capHit || ro.capHit; // paciente muito volumoso → páginas truncadas
    if (incompleto) incompletos++;
    const { sinais, detalhe } = derivarSinaisMig(agendas, orcamentos, tiposMap);
    const alvo = classificarMigracao(sinais);
    porRegra[alvo.regra] = (porRegra[alvo.regra] ?? 0) + 1;
    porEtapa[String(alvo.stage)] = (porEtapa[String(alvo.stage)] ?? 0) + 1;
    processados++;
    // flags determinísticos de validação — marcam os casos que pedem olho de agente/humano
    const cob = detalhe.cobertura_pct;
    const flags: string[] = [];
    if (alvo.regra.includes("abandono") && cob >= 70) flags.push("abandono_quase_concluido");
    if (alvo.regra.includes("abandono") && sinais.diasSilencio <= 365) flags.push("abandono_recente_menos1ano");
    if (alvo.regra.includes("concluido") && cob < 85) flags.push("concluido_no_limite");
    if (alvo.regra.includes("captura_perdido") && agendas.length > 0) flags.push("captura_com_agendas");
    if (alvo.regra.includes("cancelou") && orcamentos.length >= 3) flags.push("cancelamento_multi_orcamento");
    if (incompleto) flags.push("truncado_volumoso");
    if (!pac.nome) flags.push("sem_nome");
    linhas.push({ pid, nome: pac.nome ?? "", tel: pac.telefoneCelular ?? pac.telefone ?? "", regra: alvo.regra, stage: alvo.stage,
      na: agendas.length, no: orcamentos.length, cob, sil: sinais.diasSilencio, inativo: faixaInativo(sinais.diasSilencio), aprov: sinais.ultimoAprovadoISO,
      cancApos: sinais.cancelouAposAprovar, fezTodos: sinais.fezTodosProcedimentos, fut: sinais.temAgendaFutura, gFut: sinais.grupoFuturo, flags });
  }
  return Response.json({ pagina, total_paginas: totalPaginas, rpp, na_pagina: lista.length, processados, incompletos, erros_leitura: errosLeitura, por_regra: porRegra, por_etapa: porEtapa, linhas, subreq_usados: subreqUsados });
}

// ══════════════════════════════════════════════════════════════════════════════
// ══ MIGRAÇÃO via D1 STAGING (CNN → D1 → Kommo) ══════════════════════════════════
// Doc: docs/migracao/D1-STAGING.md. Idempotente (sync_status + kommo_lead_id). O dreno
// só toca `validacao IN ('ok','revisar')`; move é forward-only + bateria de checagens.
// ══════════════════════════════════════════════════════════════════════════════
async function ensureMigSchema(env: Env): Promise<void> {
  await env.DB.batch([
    // Paciente: campos brutos + derivados + classificação + controle de sync. `raw` = json completo (nada se perde).
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mig_pacientes (paciente_id_cnn TEXT PRIMARY KEY, nome TEXT, telefone TEXT, email TEXT, cpf TEXT,
      data_nascimento TEXT, ativo INTEGER, origem TEXT,
      n_agendas INTEGER DEFAULT 0, n_orcamentos INTEGER DEFAULT 0, cobertura_pct INTEGER, dias_silencio INTEGER, ultimo_aprovado TEXT,
      cancelou_apos INTEGER DEFAULT 0, fez_todos INTEGER DEFAULT 0, tem_futura INTEGER DEFAULT 0, grupo_futuro TEXT, teve_grupo_b INTEGER DEFAULT 0,
      regra TEXT, pipeline_id INTEGER, stage_id INTEGER, inativo_faixa TEXT,
      valor_venda REAL, faciais TEXT, corporais TEXT, fonte TEXT, flags TEXT, raw TEXT,
      validacao TEXT NOT NULL DEFAULT 'pendente', sync_status TEXT NOT NULL DEFAULT 'pendente', kommo_lead_id TEXT,
      tentativas INTEGER NOT NULL DEFAULT 0, ultimo_erro TEXT, importado_em INTEGER, sincronizado_em INTEGER, atualizado_em INTEGER)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_mig_sync ON mig_pacientes(sync_status, validacao)`),
    // Todas as agendas (inclui futuras). raw = json completo da agenda (com procedimentos).
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mig_agendas (id_agenda TEXT PRIMARY KEY, paciente_id_cnn TEXT, data TEXT, hora_inicio TEXT,
      status TEXT, id_tipo_consulta TEXT, tipo_nome TEXT, grupo TEXT, futura INTEGER DEFAULT 0, procedimentos TEXT, raw TEXT, importado_em INTEGER)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_mig_ag_pac ON mig_agendas(paciente_id_cnn)`),
    // Todos os orçamentos. raw = json completo (procedimentos + produtos + datas).
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mig_orcamentos (id_orcamento TEXT PRIMARY KEY, paciente_id_cnn TEXT, status TEXT, data_aprovacao TEXT,
      valor_liquido REAL, valor_bruto REAL, procedimentos TEXT, raw TEXT, importado_em INTEGER)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_mig_orc_pac ON mig_orcamentos(paciente_id_cnn)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mig_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, paciente_id_cnn TEXT, kommo_lead_id TEXT, acao TEXT, detalhe TEXT, ts INTEGER)`),
  ]);
}

// Ordem das etapas por funil (guard forward-only). Etapa desconhecida → 999 = "à frente" (não rebaixa por engano).
const MIG_ORDEM: Record<number, number[]> = {
  [PIPELINE_CAPTACAO]:     [106848271, 106848615, 106848619, 107785399, 106848623, 106848627, 106848631, 107789355, 142, 143],
  [PIPELINE_POS_VENDA]:    [107658903, 107658907, 107658911, 107974651, 107658915, 107860123, 107774015, 107774019, 107774023, 142, 143],
  [PIPELINE_POS_CONSULTA]: [107633735, 107633739, 107633747, 107773799, 142, 143],
};
function ordemEtapa(pipe: number, stage: number): number {
  const i = (MIG_ORDEM[pipe] ?? []).indexOf(stage);
  return i < 0 ? 999 : i;
}

function migCamposCustom(row: any, fields: Record<string, number>): any[] {
  const cf: any[] = [];
  if (fields["ID Paciente CNN"]) cf.push({ field_id: fields["ID Paciente CNN"], values: [{ value: String(row.paciente_id_cnn) }] });
  if (row.data_nascimento && fields["Aniversário"]) {
    const ts = Math.floor(Date.parse(row.data_nascimento) / 1000);
    if (Number.isFinite(ts)) cf.push({ field_id: fields["Aniversário"], values: [{ value: ts }] });
  }
  if (row.inativo_faixa && fields["Inativo"]) {
    const en = fields[`Inativo::${row.inativo_faixa}`];
    if (en) cf.push({ field_id: fields["Inativo"], values: [{ enum_id: en }] });
  }
  if (row.tipo && fields["Tipo"]) {
    const en = fields[`Tipo::${row.tipo}`];
    if (en) cf.push({ field_id: fields["Tipo"], values: [{ enum_id: en }] });
  }
  // Faciais/Corporais: multiselect. Valores no D1 = opções separadas por "; " (de-para dos procedimentos CNN). Fonte: não existe no CNN.
  for (const campo of ["Faciais", "Corporais"] as const) {
    const raw: string = campo === "Faciais" ? row.faciais : row.corporais;
    if (raw && fields[campo]) {
      const enums = String(raw).split(";").map((s) => s.trim()).filter(Boolean)
        .map((v) => fields[`${campo}::${v}`]).filter(Boolean).map((id) => ({ enum_id: id }));
      if (enums.length) cf.push({ field_id: fields[campo], values: enums });
    }
  }
  return cf;
}

// Campos do CONTATO no create: telefone + email (ambos padrão do Kommo, por field_code).
function migContatoCF(row: any): any[] {
  const cf: any[] = [];
  if (row.telefone) cf.push({ field_code: "PHONE", values: [{ value: String(row.telefone), enum_code: "WORK" }] });
  if (row.email) cf.push({ field_code: "EMAIL", values: [{ value: String(row.email), enum_code: "WORK" }] });
  return cf;
}

async function migCriarLead(row: any, grupo: "A" | "B", fields: Record<string, number>, env: Env): Promise<string | undefined> {
  // A7: re-checa por ID Paciente CNN imediatamente antes do POST (fecha TOCTOU / evita duplicata)
  const adotado = await acharLeadPorPacienteCnn(String(row.paciente_id_cnn), grupo, fields, env);
  if (adotado) { await migMoveForwardOnly(adotado, Number(row.stage_id), Number(row.pipeline_id), env); return adotado; }
  const contatoCF = migContatoCF(row);
  const contato: any = { name: row.nome || `Paciente ${row.paciente_id_cnn}` };
  if (contatoCF.length) contato.custom_fields_values = contatoCF; // Kommo rejeita array vazio (TooFew) → só inclui se houver tel/email
  const criado: any = await kommoPost("/leads/complex", [{
    name: row.nome || `Paciente ${row.paciente_id_cnn}`,
    pipeline_id: Number(row.pipeline_id), status_id: Number(row.stage_id),
    ...(row.valor_venda ? { price: Math.round(Number(row.valor_venda)) } : {}),
    custom_fields_values: migCamposCustom(row, fields),
    _embedded: { contacts: [contato] },
  }], env);
  return criado?.[0]?.id ? String(criado[0].id) : undefined;
}

async function migMoveForwardOnly(leadId: string, stageId: number, pipelineId: number, env: Env): Promise<void> {
  const lead: any = await kommoGet(`/leads/${leadId}`, env);
  if (Number(lead.pipeline_id) === pipelineId && ordemEtapa(pipelineId, Number(lead.status_id)) >= ordemEtapa(pipelineId, stageId)) return;
  await kommoPatch(`/leads/${leadId}`, { status_id: stageId, pipeline_id: pipelineId }, env);
}

async function migEnriquecer(leadId: string, row: any, fields: Record<string, number>, env: Env): Promise<void> {
  const body: any = { custom_fields_values: migCamposCustom(row, fields) };
  if (row.valor_venda) body.price = Math.round(Number(row.valor_venda));
  if (body.custom_fields_values.length || body.price) await kommoPatch(`/leads/${leadId}`, body, env);
  // Email no contato do card ADOTADO (o cron cria o contato só com telefone) — só quando há email
  if (row.email) {
    const lead: any = await kommoGet(`/leads/${leadId}?with=contacts`, env);
    const cId = lead?._embedded?.contacts?.[0]?.id;
    if (cId) await kommoPatch(`/contacts/${cId}`, { custom_fields_values: [{ field_code: "EMAIL", values: [{ value: String(row.email), enum_code: "WORK" }] }] }, env);
  }
}

// Bateria rigorosa ANTES de mexer num lead JÁ EXISTENTE
async function migValidarLeadExistente(leadId: string, row: any, fields: Record<string, number>, env: Env): Promise<{ acao: "mover" | "skip" | "revisar"; motivo?: string }> {
  const lead: any = await kommoGet(`/leads/${leadId}`, env);
  const pidNoCard = getFieldValue(lead, fields["ID Paciente CNN"]);
  if (pidNoCard && pidNoCard !== String(row.paciente_id_cnn)) return { acao: "revisar", motivo: `ID Paciente CNN diverge (${pidNoCard} vs ${row.paciente_id_cnn})` };
  if (!pidNoCard) return { acao: "revisar", motivo: "card sem ID Paciente CNN (match fraco/telefone)" };
  if (/\[fam[ií]lia\]/i.test(String(lead.name ?? ""))) return { acao: "skip", motivo: "card [Família]" };
  if (Number(lead.status_id) === STAGE_POS_CLIENTE_ATIVO) return { acao: "skip", motivo: "já Cliente Ativo (trava)" };
  if (Number(lead.pipeline_id) === Number(row.pipeline_id) && ordemEtapa(Number(row.pipeline_id), Number(lead.status_id)) >= ordemEtapa(Number(row.pipeline_id), Number(row.stage_id))) return { acao: "skip", motivo: "já igual/à frente (forward-only)" };
  if (Number(lead.pipeline_id) !== Number(row.pipeline_id) && Number(lead.pipeline_id) !== 0) return { acao: "revisar", motivo: `troca de funil ${lead.pipeline_id}→${row.pipeline_id}` };
  return { acao: "mover" };
}

async function migSyncItem(row: any, env: Env, fields: Record<string, number>, dryRun: boolean): Promise<any> {
  const grupo: "A" | "B" = Number(row.pipeline_id) === PIPELINE_POS_VENDA ? "B" : "A";
  const leadId: string | undefined = row.kommo_lead_id || await acharLeadPorPacienteCnn(String(row.paciente_id_cnn), grupo, fields, env);
  if (!leadId) {
    if (dryRun) return { acao: "criar", leadId: null };
    return { acao: "criado", leadId: await migCriarLead(row, grupo, fields, env) };
  }
  const val = await migValidarLeadExistente(leadId, row, fields, env);   // bateria rigorosa
  if (dryRun) return { acao: val.acao, leadId, motivo: val.motivo };
  if (val.acao === "revisar") return { acao: "revisar", leadId, motivo: val.motivo };
  if (val.acao === "mover") await migMoveForwardOnly(leadId, Number(row.stage_id), Number(row.pipeline_id), env);
  await migEnriquecer(leadId, row, fields, env);   // enriquece em mover E skip: garante Tipo/Inativo/Faciais/valor/aniversário no card adotado
  return { acao: val.acao === "mover" ? "movido" : "skip", leadId };
}

async function migClaimLote(env: Env, limite: number): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare(
    `UPDATE mig_pacientes SET sync_status='processing', tentativas=tentativas+1, atualizado_em=?1
       WHERE paciente_id_cnn IN (SELECT paciente_id_cnn FROM mig_pacientes WHERE sync_status='pendente' AND validacao IN ('ok','revisar') AND tentativas < 4 ORDER BY paciente_id_cnn LIMIT ?2) RETURNING *`
  ).bind(now, limite).all();
  return (r.results as any[]) ?? [];
}

async function migSyncBatch(env: Env, limite = 12, dryRun = true): Promise<any> {
  await ensureMigSchema(env);
  const fields = await resolveFields(env);
  const lote = dryRun
    ? ((await env.DB.prepare(`SELECT * FROM mig_pacientes WHERE sync_status='pendente' AND validacao IN ('ok','revisar') AND tentativas<4 ORDER BY paciente_id_cnn LIMIT ?`).bind(limite).all()).results as any[]) ?? []
    : await migClaimLote(env, limite);
  const out: any = { total: lote.length, dry: dryRun, criados: 0, movidos: 0, skip: 0, revisar: 0, erros: 0, itens: [] as any[] };
  const now = Math.floor(Date.now() / 1000);
  for (const row of lote) {
    if (!orcamentoOk(46)) { out.parou_budget = true; break; }
    try {
      const r = await migSyncItem(row, env, fields, dryRun);
      out.itens.push({ pid: row.paciente_id_cnn, ...r });
      if (!dryRun) {
        if (r.acao === "revisar") { await env.DB.prepare(`UPDATE mig_pacientes SET sync_status='pendente', validacao='revisar', ultimo_erro=?1, atualizado_em=?2 WHERE paciente_id_cnn=?3`).bind(r.motivo ?? "", now, row.paciente_id_cnn).run(); out.revisar++; }
        else { await env.DB.prepare(`UPDATE mig_pacientes SET sync_status='enviado', kommo_lead_id=?1, sincronizado_em=?2, ultimo_erro=NULL, atualizado_em=?2 WHERE paciente_id_cnn=?3`).bind(r.leadId ?? null, now, row.paciente_id_cnn).run();
          await env.DB.prepare(`INSERT INTO mig_sync_log (paciente_id_cnn,kommo_lead_id,acao,detalhe,ts) VALUES (?,?,?,?,?)`).bind(row.paciente_id_cnn, r.leadId ?? null, r.acao, row.regra, now).run();
          if (r.acao === "criado") out.criados++; else if (r.acao === "skip") out.skip++; else out.movidos++; }
      }
    } catch (e) {
      out.erros++;
      if (!dryRun) { const st = Number(row.tentativas) >= 4 ? "erro" : "pendente"; await env.DB.prepare(`UPDATE mig_pacientes SET sync_status=?1, ultimo_erro=?2, atualizado_em=?3 WHERE paciente_id_cnn=?4`).bind(st, String(e).slice(0, 300), now, row.paciente_id_cnn).run(); }
    }
  }
  return out;
}

// Import CNN→D1: enumera 1 página de pacientes, puxa agendas(+futuras)+orçamentos (resiliente),
// grava TUDO no D1 (raw json = nada se perde) + classificação + validação. Idempotente (INSERT OR REPLACE). Resumável.
async function migImportarPagina(env: Env, pagina: number, rpp = 5, target: CnnTarget = "production"): Promise<any> {
  await ensureMigSchema(env);
  const tiposMap = await resolveTiposConsulta(env, target);
  const now = Math.floor(Date.now() / 1000);
  let lista: any[] = [], totalPaginas = 0;
  try {
    const r: any = await cnnGet(`/paciente/lista?registrosPorPagina=${rpp}&pagina=${pagina}`, env, target, retrySweep());
    lista = r?.lista ?? []; totalPaginas = Number(r?.totalPaginas ?? 0);
  } catch (e) { return { erro: String(e), pagina }; }
  const out: any = { pagina, total_paginas: totalPaginas, na_pagina: lista.length, importados: 0, erros_leitura: 0, erros: 0 };
  for (const pac of lista) {
    const pid = String(pac.id ?? pac.idPaciente ?? "");
    if (!pid) continue;
    try {
      const ra = await migAgendasSweep(pid, env, target);
      const ro = await migOrcamentosSweep(pid, env, target);
      const stmts: any[] = [];
      for (const a of ra.agendas) {
        const data = String(a.data ?? "").slice(0, 10);
        stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO mig_agendas (id_agenda,paciente_id_cnn,data,hora_inicio,status,id_tipo_consulta,tipo_nome,grupo,futura,procedimentos,raw,importado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(String(a.id), pid, data, a.horaInicio ?? null, a.status ?? null, String(a.idTipoConsulta ?? ""), tiposMap[String(a.idTipoConsulta ?? "")] ?? null, grupoDaAgenda(a, tiposMap), data >= MIG_FUTURO_INI ? 1 : 0, JSON.stringify(a.procedimentos ?? []), JSON.stringify(a), now));
      }
      for (const o of ro.orcamentos) {
        stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO mig_orcamentos (id_orcamento,paciente_id_cnn,status,data_aprovacao,valor_liquido,valor_bruto,procedimentos,raw,importado_em) VALUES (?,?,?,?,?,?,?,?,?)`)
          .bind(String(o.id), pid, o.status ?? null, o.dataAprovacao ?? null, o.valorLiquido ?? null, o.valorBruto ?? null, JSON.stringify(o.procedimentos ?? []), JSON.stringify(o), now));
      }
      let regra = "erro_leitura", pipeline: number | null = null, stage: number | null = null, inativo = "", cob = 0;
      let sil: number | null = null, sinais: any = null, val = "erro_leitura", valorVenda: number | null = null;
      const flags: string[] = [];
      if (ra.ok && ro.ok) {
        const d = derivarSinaisMig(ra.agendas, ro.orcamentos, tiposMap);
        sinais = d.sinais; cob = d.detalhe.cobertura_pct; sil = d.sinais.diasSilencio;
        const alvo = classificarMigracao(d.sinais);
        regra = alvo.regra; pipeline = alvo.pipeline; stage = alvo.stage; inativo = faixaInativo(d.sinais.diasSilencio);
        const aprovados = ro.orcamentos.filter((o: any) => o.dataAprovacao).sort((a: any, b: any) => (a.dataAprovacao < b.dataAprovacao ? -1 : 1));
        if (aprovados.length) valorVenda = aprovados[aprovados.length - 1].valorLiquido ?? null;
        if (regra.includes("abandono") && cob >= 70) flags.push("abandono_quase_concluido");
        if (regra.includes("concluido") && cob < 90) flags.push("concluido_no_limite");
        if (regra.includes("captura_perdido") && ra.agendas.length > 0) flags.push("captura_com_agendas");
        if (ra.capHit || ro.capHit) flags.push("truncado_volumoso");
        if (!pac.nome) flags.push("sem_nome");
        // Só flags DUROS (fronteira de cobertura / dados truncados) disparam revisão; os demais são informativos.
        const HARD = ["abandono_quase_concluido", "concluido_no_limite", "truncado_volumoso"];
        val = flags.some((f) => HARD.includes(f)) ? "revisar" : "ok";
      } else { out.erros_leitura++; }
      stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO mig_pacientes (paciente_id_cnn,nome,telefone,email,cpf,data_nascimento,ativo,origem,n_agendas,n_orcamentos,cobertura_pct,dias_silencio,ultimo_aprovado,cancelou_apos,fez_todos,tem_futura,grupo_futuro,teve_grupo_b,regra,pipeline_id,stage_id,inativo_faixa,valor_venda,flags,raw,validacao,sync_status,tentativas,importado_em,atualizado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(pid, pac.nome ?? null, pac.telefoneCelular ?? pac.telefone ?? null, pac.email ?? null, pac.cpfCnpj ?? pac.cpf ?? null, pac.dataNascimento ?? null, pac.ativo ? 1 : 0, String(pac.idOrigemPaciente ?? ""),
          ra.agendas.length, ro.orcamentos.length, cob, sil, sinais?.ultimoAprovadoISO ?? null, sinais?.cancelouAposAprovar ? 1 : 0, sinais?.fezTodosProcedimentos ? 1 : 0, sinais?.temAgendaFutura ? 1 : 0, sinais?.grupoFuturo ?? null, sinais?.teveGrupoBPassado ? 1 : 0,
          regra, pipeline, stage, inativo, valorVenda, JSON.stringify(flags), JSON.stringify(pac), val, "pendente", 0, now, now));
      await env.DB.batch(stmts);
      out.importados++;
    } catch (e) { out.erros++; out.ultimo_erro = String(e).slice(0, 200); }
  }
  return out;
}

// 2º passe: re-lê individualmente os pacientes marcados erro_leitura (orçamento de retry cheio por paciente).
// Idempotente (INSERT OR REPLACE). Roda em lotes pequenos; drive externo em loop até ainda_erro=0.
async function migReimportarErros(env: Env, limite = 12, target: CnnTarget = "production"): Promise<any> {
  await ensureMigSchema(env);
  const tiposMap = await resolveTiposConsulta(env, target);
  const now = Math.floor(Date.now() / 1000);
  const rows = ((await env.DB.prepare(`SELECT paciente_id_cnn, raw FROM mig_pacientes WHERE validacao='erro_leitura' LIMIT ?`).bind(limite).all()).results as any[]) ?? [];
  const out: any = { total: rows.length, recuperados: 0, ainda_erro: 0, falhas: 0 };
  for (const row of rows) {
    if (!orcamentoOk(40)) { out.parou_budget = true; break; }
    const pid = String(row.paciente_id_cnn);
    let pac: any = {}; try { pac = JSON.parse(row.raw || "{}"); } catch {}
    try {
      const ra = await migAgendasSweep(pid, env, target);
      const ro = await migOrcamentosSweep(pid, env, target);
      if (!ra.ok || !ro.ok) { out.ainda_erro++; continue; }
      const stmts: any[] = [];
      for (const a of ra.agendas) {
        const data = String(a.data ?? "").slice(0, 10);
        stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO mig_agendas (id_agenda,paciente_id_cnn,data,hora_inicio,status,id_tipo_consulta,tipo_nome,grupo,futura,procedimentos,raw,importado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(String(a.id), pid, data, a.horaInicio ?? null, a.status ?? null, String(a.idTipoConsulta ?? ""), tiposMap[String(a.idTipoConsulta ?? "")] ?? null, grupoDaAgenda(a, tiposMap), data >= MIG_FUTURO_INI ? 1 : 0, JSON.stringify(a.procedimentos ?? []), JSON.stringify(a), now));
      }
      for (const o of ro.orcamentos) {
        stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO mig_orcamentos (id_orcamento,paciente_id_cnn,status,data_aprovacao,valor_liquido,valor_bruto,procedimentos,raw,importado_em) VALUES (?,?,?,?,?,?,?,?,?)`)
          .bind(String(o.id), pid, o.status ?? null, o.dataAprovacao ?? null, o.valorLiquido ?? null, o.valorBruto ?? null, JSON.stringify(o.procedimentos ?? []), JSON.stringify(o), now));
      }
      const d = derivarSinaisMig(ra.agendas, ro.orcamentos, tiposMap);
      const cob = d.detalhe.cobertura_pct, alvo = classificarMigracao(d.sinais);
      const flags: string[] = [];
      if (alvo.regra.includes("abandono") && cob >= 70) flags.push("abandono_quase_concluido");
      if (alvo.regra.includes("concluido") && cob < 90) flags.push("concluido_no_limite");
      if (alvo.regra.includes("captura_perdido") && ra.agendas.length > 0) flags.push("captura_com_agendas");
      if (ra.capHit || ro.capHit) flags.push("truncado_volumoso");
      if (!pac.nome) flags.push("sem_nome");
      const HARD = ["abandono_quase_concluido", "concluido_no_limite", "truncado_volumoso"];
      const val = flags.some((f) => HARD.includes(f)) ? "revisar" : "ok";
      const aprovados = ro.orcamentos.filter((o: any) => o.dataAprovacao).sort((a: any, b: any) => (a.dataAprovacao < b.dataAprovacao ? -1 : 1));
      const valorVenda = aprovados.length ? aprovados[aprovados.length - 1].valorLiquido ?? null : null;
      stmts.push(env.DB.prepare(`UPDATE mig_pacientes SET n_agendas=?,n_orcamentos=?,cobertura_pct=?,dias_silencio=?,ultimo_aprovado=?,cancelou_apos=?,fez_todos=?,tem_futura=?,grupo_futuro=?,teve_grupo_b=?,regra=?,pipeline_id=?,stage_id=?,inativo_faixa=?,valor_venda=?,flags=?,validacao=?,atualizado_em=? WHERE paciente_id_cnn=?`)
        .bind(ra.agendas.length, ro.orcamentos.length, cob, d.sinais.diasSilencio, d.sinais.ultimoAprovadoISO ?? null, d.sinais.cancelouAposAprovar ? 1 : 0, d.sinais.fezTodosProcedimentos ? 1 : 0, d.sinais.temAgendaFutura ? 1 : 0, d.sinais.grupoFuturo ?? null, d.sinais.teveGrupoBPassado ? 1 : 0,
          alvo.regra, alvo.pipeline, alvo.stage, faixaInativo(d.sinais.diasSilencio), valorVenda, JSON.stringify(flags), val, now, pid));
      await env.DB.batch(stmts);
      out.recuperados++;
    } catch (e) { out.falhas++; }
  }
  return out;
}

// Cria um custom field SELECT no Kommo (idempotente: pula se já existe pelo nome).
async function migCriarCampoSelect(env: Env, nome: string, opcoes: string[]): Promise<any> {
  const existentes: any = await kommoGet("/leads/custom_fields?limit=250", env);
  const ja = (existentes._embedded?.custom_fields ?? []).find((f: any) => f.name === nome);
  if (ja) return { criado: false, id: ja.id, nome, motivo: "já existe" };
  const body = [{ name: nome, type: "select", enums: opcoes.map((v, i) => ({ value: v, sort: i + 1 })) }];
  const r: any = await kommoPost("/leads/custom_fields", body, env);
  return { criado: true, nome, id: r?.[0]?.id ?? null };
}
// Cria os campos da migração: Inativo (faixas) + tipo (Procedimento/Agendamento/Tratamento/Outros). Idempotente.
async function migCriarCampos(env: Env): Promise<any> {
  return {
    // OBS: o dono criou estes campos MANUALMENTE no grupo certo (group_id leads_47471781733345). Rótulos EXATOS abaixo (só recria se sumirem).
    inativo: await migCriarCampoSelect(env, "Inativo", ["90 D", "180 D", "360 D", "540 D", "720 D", "1080 D+"]),
    tipo: await migCriarCampoSelect(env, "Tipo", ["Agendamento", "Tratamento", "Procedimento", "Outro"]),
  };
}

function discoverAuthOk(req: Request, env: Env): boolean {
  return req.headers.get("Authorization") === env.WEBHOOK_SECRET;
}

// ── Main export (portado p/ Vercel: fetch→handleFetch, scheduled→handleScheduled) ──
export async function handleFetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/health") return Response.json({ ok: true, ts: Date.now() });

    if (pathname === "/test-workflow") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleTestWorkflow(req, env);
    }

    if (pathname === "/debug-c1") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugC1(env);
    }

    if (pathname === "/debug-scale") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugScale(env);
    }

    if (pathname === "/debug-a2") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const dry = new URL(req.url).searchParams.get("dry") !== "0";
      return Response.json(await syncKommoParaCnn(env, dry));
    }

    if (pathname === "/debug-a3") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const dry = u.searchParams.get("dry") !== "0";
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const max = Number(u.searchParams.get("max") ?? "40");
      return Response.json(await syncCnnParaKommo(env, dry, target, max));
    }

    if (pathname === "/debug-a4") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const dry = u.searchParams.get("dry") !== "0";
      const soTeste = u.searchParams.get("soteste") !== "0";
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const max = Number(u.searchParams.get("max") ?? "40");
      return Response.json(await backfillCadastros(env, dry, soTeste, target, max));
    }

    if (pathname === "/debug-f2") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const dry = u.searchParams.get("dry") !== "0";
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const data = u.searchParams.get("data") ?? undefined;
      if (u.searchParams.get("reset") === "1") {
        await ensureSchema(env);
        await env.DB.prepare("DELETE FROM lembrete_d1 WHERE data_agendamento = ?").bind(data ?? tomorrowBRT()).run();
      }
      return Response.json(await cronVespera(env, dry, target, data));
    }

    if (pathname === "/debug-criar-agenda") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugCriarAgenda(req, env);
    }

    if (pathname === "/debug-webhooks") { // lista os webhooks configurados no Kommo (P1 do go-live) — read-only
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      try { const w: any = await kommoGet("/webhooks", env); return Response.json(w); }
      catch (e) { return Response.json({ erro: String(e) }, { status: 502 }); }
    }

    if (pathname === "/debug-campos") { // lista os custom_fields do lead (nome/tipo/opções) — read-only
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      try {
        const r: any = await kommoGet("/leads/custom_fields?limit=250", env);
        const cf = (r._embedded?.custom_fields ?? []).map((f: any) => ({
          id: f.id, name: f.name, type: f.type, code: f.code,
          enums: (f.enums ?? []).map((e: any) => ({ id: e.id, value: e.value })),
        }));
        return Response.json({ total: cf.length, campos: cf });
      } catch (e) { return Response.json({ erro: String(e) }, { status: 502 }); }
    }

    if (pathname === "/debug-fixture-teste") { // monta o paciente/agenda de teste em produção (escopo travado)
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugFixtureTeste(req, env);
    }

    if (pathname === "/debug-move") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const lead = u.searchParams.get("lead");
      const pipeline = Number(u.searchParams.get("pipeline") ?? String(PIPELINE_CAPTACAO));
      const status = Number(u.searchParams.get("status") ?? "0");
      if (!lead || !status) return Response.json({ erro: "params obrigatórios: lead, status (pipeline opcional)" });
      await moveLeadToStage(lead, status, env, pipeline);
      return Response.json({ ok: true, lead, pipeline, status });
    }

    if (pathname === "/debug-agendas") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugAgendas(req, env);
    }

    if (pathname === "/debug-raw") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugRaw(req, env);
    }

    if (pathname === "/debug-nome") { // survey/backfill do NOME (contato=real; lead-duplicata mantém sufixo) — read-only em modo=survey
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      return handleDebugNome(req, env);
    }

    if (pathname === "/debug-auditoria") { // AUDITORIA read-only: classificador da migração vs Kommo (etapa/inativo/valor/duplicata)
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      return handleDebugAudit(req, env);
    }

    if (pathname === "/debug-backfill-preview") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugBackfillPreview(req, env);
    }

    if (pathname === "/debug-audit") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      await ensureSchema(env);
      const porAcao = await env.DB.prepare("SELECT funcao, acao, para, COUNT(*) n FROM auditoria GROUP BY funcao, acao, para").all();
      const mapeamentoTotal = await env.DB.prepare("SELECT COUNT(*) n FROM mapeamento WHERE lead_id_kommo IS NOT NULL").first<{ n: number }>();
      const recentes = await env.DB.prepare("SELECT ts, funcao, acao, para, entidade_id, detalhe FROM auditoria ORDER BY id DESC LIMIT 15").all();
      const fila = await filaStats(env);
      return Response.json({ por_acao: porAcao.results, mapeamento_total: mapeamentoTotal?.n, fila, recentes: recentes.results });
    }

    if (pathname === "/debug-corrigir") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      const u = new URL(req.url);
      const dry = u.searchParams.get("dry") !== "0";          // dry por padrão: só LISTA
      const cursor = u.searchParams.get("cursor") ?? "";       // paginação por lead_id_kommo
      const max = Number(u.searchParams.get("max") ?? "60");
      const out = await corrigirCards(env, dry, cursor, max);
      return Response.json({ ...out, subreq_total: subreqUsados });
    }

    if (pathname === "/debug-tick-log") { // F1: health durável dos ticks + backlog vivo (read-only)
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleTickLog(req, env);
    }

    if (pathname === "/debug-tick") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      const u = new URL(req.url);
      const dry = u.searchParams.get("dry") !== "0";
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const cap = Number(u.searchParams.get("cap") ?? "8");
      const budget = Number(u.searchParams.get("budget") ?? "40");
      const windowDays = Number(u.searchParams.get("window") ?? "14");
      const soTeste = u.searchParams.get("soteste") !== "0";
      const runProd = u.searchParams.get("prod") === "1";
      const job = u.searchParams.get("job") ?? "backfill"; // backfill | sync | vespera | orcamento
      const t0 = Date.now();
      const out: any = { dry, target, cap, budget, windowDays, soTeste, job };
      // B2: lease cooperativo — se outro tick (cron ou /debug) está ativo, PULA (não sobrepõe
      // nem corrompe o subreqUsados global). Inclui o clear=1 (não apaga a fila sem o lease).
      await ensureSchema(env);
      const owner = novoOwnerLease("debug-tick");
      const lease = await adquirirLease(env, owner);
      if (!lease.ok) return Response.json({ skipped: true, motivo: `lease em uso por ${lease.dono} até ${lease.expira}`, consumidor: { processados: 0 } });
      try {
        if (u.searchParams.get("clear") === "1") { await env.DB.prepare("DELETE FROM fila_trabalho").run(); out.fila_limpa = true; }
        if (runProd) {
          if (job === "sync") out.produtor = await produtorSync(env, target, windowDays, u.searchParams.get("sopid") ?? undefined);
          else if (job === "vespera") out.produtor = await produtorVespera(env, target, u.searchParams.get("data") ?? undefined, u.searchParams.get("sopid") ?? undefined);
          else if (job === "orcamento") out.produtor = await produtorOrcamento(env, target, budget);
          else out.produtor = await produtorBackfill(env, target, windowDays, soTeste);
        }
        out.subreq_apos_produtor = subreqUsados;
        out.consumidor = await consumirFila(env, target, dry, cap, budget);
        out.subreq_total = subreqUsados;
        out.ms_total_wallclock = Date.now() - t0;
        out.fila = await filaStats(env);
        return Response.json(out);
      } finally {
        await liberarLease(env, owner);
      }
    }

    if (pathname === "/debug-migrar-mapeamento") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      const u = new URL(req.url);
      // Só lê a Kommo (pipeline atual do lead) — nenhuma escrita no CNN, então não há
      // target de CNN aqui. ?commit=1 faz a troca destrutiva (só após done=true).
      const commit = u.searchParams.get("commit") === "1";
      const chunk = Math.min(Math.max(Number(u.searchParams.get("chunk") ?? "40"), 1), 50);
      const budget = Number(u.searchParams.get("budget") ?? "40");
      return Response.json(await migrarMapeamento(env, { commit, chunk, budget }));
    }

    if (pathname === "/debug-d1cost") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      await ensureSchema(env);
      const out: any = {};
      // 1. Loop de queries D1 (SELECT trivial). Se D1 conta no teto de 50, estoura ~50.
      let d1ok = 0; let d1throw = "";
      try {
        for (let i = 0; i < 200; i++) {
          await env.DB.prepare("SELECT 1").first();
          d1ok++;
        }
      } catch (e) { d1throw = String(e); }
      out.d1 = { queries_ok: d1ok, parou_em: d1ok < 200 ? d1ok : "completou 200", erro: d1throw || null };
      // 2. Controle: loop de fetch (sabemos que conta) — confirma o teto vigente
      let fok = 0; let fthrow = "";
      try {
        for (let i = 0; i < 200; i++) {
          await fetch(`${CNN_BASE}/info`, { headers: cnnHeaders(env, "sandbox") });
          fok++;
        }
      } catch (e) { fthrow = String(e); }
      out.fetch = { ok: fok, parou_em: fok, erro: fthrow ? fthrow.slice(0, 120) : null };
      out.veredito = d1ok >= 200
        ? "D1 NÃO conta como sub-request (passou 200) → orçamento só conta fetch"
        : `D1 CONTA como sub-request (parou em ${d1ok}) → orçamento precisa contar D1 também`;
      return Response.json(out);
    }

    if (pathname === "/debug-nomes") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const data = u.searchParams.get("data") ?? tomorrowBRT();
      const delay = Number(u.searchParams.get("delay") ?? "0");      // ms entre lookups
      const tentativas = Number(u.searchParams.get("try") ?? "1");   // tentativas por id
      // coleta ids distintos do dia
      const ids = new Set<string>();
      let pag = 0, totalPag = 1;
      while (pag < totalPag) {
        let r: any;
        try { r = await cnnGet(`/agenda/lista?dataInicial=${data}&dataFinal=${data}&registrosPorPagina=200&pagina=${pag}`, env, target); }
        catch { break; }
        totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
        for (const a of (r?.lista ?? [])) if (a.idPaciente) ids.add(String(a.idPaciente));
      }
      const wantMap = u.searchParams.get("map") === "1";
      // &map=1 retorna id→nome (CNN-only, seguro até ~48 ids/dia) — pula o diagnóstico
      if (wantMap) {
        const mapa: Record<string, string> = {};
        let n = 0;
        for (const id of ids) {
          if (n++ >= 48) break; // respeita teto de subrequests
          try { const p: any = await cnnGet(`/paciente/${id}`, env, target); if (p?.nome) mapa[id] = p.nome; } catch { /* skip */ }
        }
        return Response.json({ target, data, total_ids: ids.size, resolvidos: Object.keys(mapa).length, mapa });
      }
      const force = u.searchParams.get("force") === "1"; // não para no 1º sucesso (queima sub-requests)
      const statusCount: Record<string, number> = {};
      let ok = 0, falha = 0, chamadas = 0; let throwAt = -1; const exemplosFalha: any[] = [];
      try {
        for (const id of ids) {
          let resolvido = false;
          for (let t = 0; t < tentativas && (!resolvido || force); t++) {
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            chamadas++;
            const res = await fetch(`${CNN_BASE}/paciente/${id}`, { headers: cnnHeaders(env, target) });
            statusCount[String(res.status)] = (statusCount[String(res.status)] ?? 0) + 1;
            if (res.ok) { const b: any = await res.json().catch(() => null); if (b?.nome) { if (!resolvido) ok++; resolvido = true; } }
            else if (exemplosFalha.length < 5) { const txt = await res.text().catch(() => ""); exemplosFalha.push({ id, status: res.status, body: txt.slice(0, 200) }); }
          }
          if (!resolvido) falha++;
        }
      } catch (e) { throwAt = chamadas; (exemplosFalha as any).push({ throw: String(e), na_chamada: chamadas }); }
      return Response.json({ target, data, total_ids: ids.size, delay, tentativas, force, chamadas, throwAt, resolvidos: ok, falhas: falha, status_http: statusCount, exemplos_falha: exemplosFalha });
    }

    if (pathname === "/debug-raw-agendas") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const data = u.searchParams.get("data") ?? tomorrowBRT();
      const todas: any[] = [];
      let pag = 0, totalPag = 1;
      while (pag < totalPag) {
        let r: any;
        try { r = await cnnGet(`/agenda/lista?dataInicial=${data}&dataFinal=${data}&registrosPorPagina=200&pagina=${pag}`, env, target); }
        catch (e) { return Response.json({ erro: String(e) }); }
        totalPag = Math.max(r?.totalPaginas ?? 1, 1); pag++;
        for (const a of (r?.lista ?? [])) todas.push(a);
      }
      return Response.json({ data, total: todas.length, agendas: todas });
    }

    if (pathname === "/debug-cnn-shape") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugCnnShape(req, env);
    }

    if (pathname === "/debug-orcamento") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      return handleDebugOrcamento(req, env);
    }

    if (pathname === "/debug-lookup-paciente") { // A7 probe (read-only): o query do Kommo indexa ID Paciente CNN?
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      const u = new URL(req.url);
      const pid = u.searchParams.get("pid") ?? "";
      const grupo: "A" | "B" = u.searchParams.get("grupo") === "B" ? "B" : "A";
      const fields = await resolveFields(env);
      const fIdPaciente = fields["ID Paciente CNN"];
      const raw: any = await kommoGet(`/leads?query=${encodeURIComponent(pid)}&limit=250`, env);
      const leads = raw._embedded?.leads ?? [];
      return Response.json({
        pid, grupo, pipeline: pipelineDoGrupo(grupo), total_query: leads.length,
        adotaria: escolherCardAdotado(leads, pid, pipelineDoGrupo(grupo), fIdPaciente),
        amostra: leads.slice(0, 10).map((l: any) => ({ id: l.id, pipeline: l.pipeline_id, status: l.status_id, pid_no_card: getFieldValue(l, fIdPaciente) })),
      });
    }

    if (pathname === "/debug-orcamento-impacto") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      return handleDebugOrcamentoImpacto(req, env);
    }

    if (pathname === "/debug-migra-probe") { // Migração Sync Única — sonda read-only de 1 paciente
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleMigProbe(req, env);
    }

    if (pathname === "/debug-migra-sweep") { // Migração — classifica 1 página de pacientes (CNN-only, read-only)
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleMigSweep(req, env);
    }

    if (pathname === "/mig-sync") { // Dreno D1→Kommo. ?limite=12&dry=1 (dry=0 escreve). Idempotente + bateria.
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      const u = new URL(req.url);
      return Response.json(await migSyncBatch(env, Number(u.searchParams.get("limite") ?? "12"), u.searchParams.get("dry") !== "0"));
    }

    if (pathname === "/mig-criar-campos") { // Cria os campos select "Inativo" + "tipo" no Kommo (idempotente)
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return Response.json(await migCriarCampos(env));
    }

    if (pathname === "/mig-campos-info") { // Rastreio: estado REAL dos campos no Kommo (id + enums), leitura fresca (sem cache)
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const filtro = (new URL(req.url)).searchParams.get("nome");
      const lr: any = await kommoGet("/leads/custom_fields?limit=250", env);
      const campos = (lr._embedded?.custom_fields ?? [])
        .filter((f: any) => !filtro || new RegExp(filtro, "i").test(String(f.name)))
        .map((f: any) => ({ id: f.id, name: f.name, type: f.type, group_id: f.group_id ?? null, enums: (f.enums ?? []).map((e: any) => ({ id: e.id, value: e.value })) }));
      return Response.json({ total: campos.length, campos });
    }

    if (pathname === "/mig-verify-lead") { // Confere o payload REAL de um card criado (para os agentes verificarem integralidade)
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const id = (new URL(req.url)).searchParams.get("id");
      if (!id) return Response.json({ erro: "falta id" });
      const fields = await resolveFields(env);
      const lead: any = await kommoGet(`/leads/${id}?with=contacts`, env);
      if (!lead || lead.id === undefined) return Response.json({ erro: "lead nao encontrado", id });
      const cfv: any[] = lead.custom_fields_values ?? [];
      const getF = (nome: string) => { const f = cfv.find((x: any) => x.field_id === fields[nome]); return f ? f.values.map((v: any) => v.value ?? v.enum_id).join("; ") : null; };
      let contato: any = null;
      const cId = lead._embedded?.contacts?.[0]?.id;
      if (cId) { const c: any = await kommoGet(`/contacts/${cId}`, env); const ccf: any[] = c.custom_fields_values ?? []; const val = (code: string) => (ccf.find((x: any) => x.field_code === code)?.values?.[0]?.value) ?? null; contato = { nome: c.name, telefone: val("PHONE"), email: val("EMAIL") }; }
      return Response.json({ id: lead.id, name: lead.name, pipeline_id: lead.pipeline_id, status_id: lead.status_id, price: lead.price ?? 0, id_cnn: getF("ID Paciente CNN"), aniversario: getF("Aniversário"), inativo: getF("Inativo"), tipo: getF("Tipo"), faciais: getF("Faciais"), corporais: getF("Corporais"), contato });
    }

    if (pathname === "/mig-import") { // Import CNN→D1: ?pagina=N&rpp=5&env=production. Grava TUDO no D1 + classifica.
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      const u = new URL(req.url);
      const tgt: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      return Response.json(await migImportarPagina(env, Number(u.searchParams.get("pagina") ?? "0"), Number(u.searchParams.get("rpp") ?? "5"), tgt));
    }

    if (pathname === "/mig-reimport") { // 2º passe: re-lê os erro_leitura individualmente. ?limite=12
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      resetSubreq();
      const u = new URL(req.url);
      const tgt: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      return Response.json(await migReimportarErros(env, Number(u.searchParams.get("limite") ?? "12"), tgt));
    }

    if (pathname === "/wh-criar-campo") { // Setup webhook 2: cria "Tipo Procedimento CNN" (idempotente)
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleWhCriarCampo(env);
    }

    if (pathname === "/debug-selftest") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugSelftest(req); // puro/em memória — sem env: impossível tocar D1/CNN/Kommo aqui
    }

    if (pathname === "/debug-retry-selftest") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return Response.json(await runRetrySelftest()); // fetch mockado — sem env: zero API externa
    }

    if (pathname === "/debug-fila-erros") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleFilaErros(env);
    }

    if (pathname === "/debug-fila-requeue") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleFilaRequeue(req, env);
    }

    if (pathname === "/debug-count") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleDebugCount(env);
    }

    if (pathname === "/debug-verificar") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const target: CnnTarget = new URL(req.url).searchParams.get("env") === "production" ? "production" : "sandbox";
      return Response.json(await verificarDados(env, target));
    }

    if (pathname === "/debug-auditoria") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const target: CnnTarget = new URL(req.url).searchParams.get("env") === "production" ? "production" : "sandbox";
      return Response.json(await auditarSync(env, target));
    }

    if (pathname === "/debug-split-colisao") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const dry = new URL(req.url).searchParams.get("dry") !== "0";
      return Response.json(await splitColisaoTelefone(env, dry));
    }

    if (pathname === "/debug-consolidar-colisao") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const dry = u.searchParams.get("dry") !== "0";
      return Response.json(await consolidarColisao(env, target, dry));
    }

    if (pathname === "/debug-mapa-campos") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const target: CnnTarget = new URL(req.url).searchParams.get("env") === "production" ? "production" : "sandbox";
      return Response.json(await mapaCampos(env, target));
    }

    if (pathname === "/debug-backfill-hist") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      if (u.searchParams.get("fase") === "medir") return Response.json(await medirBackfillHist(env));
      if (u.searchParams.get("fase") === "consumir") {
        const dry = u.searchParams.get("dry") !== "0";
        const max = Math.min(Math.max(Number(u.searchParams.get("max") ?? "15"), 1), 60);
        return Response.json(await consumirBackfillHist(env, target, dry, max));
      }
      const cursor = Number(u.searchParams.get("cursor") ?? "0");
      const budget = Math.min(Math.max(Number(u.searchParams.get("budget") ?? "20"), 1), 48);
      const reset = u.searchParams.get("reset") === "1";
      return Response.json(await produzirBackfillHist(env, target, cursor, budget, reset));
    }

    if (pathname === "/debug-aniversario") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const dry = u.searchParams.get("dry") !== "0";
      const cursor = u.searchParams.get("cursor") ?? "";
      const max = Math.min(Math.max(Number(u.searchParams.get("max") ?? "20"), 1), 60);
      return Response.json(await varrerAniversario(env, target, dry, cursor, max));
    }

    if (pathname === "/discover") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const target: CnnTarget = new URL(req.url).searchParams.get("env") === "production" ? "production" : "sandbox";
      const results: Record<string, unknown> = { cnn_target: target };
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["cnn_info",              () => cnnGet("/info", env, target)],
        ["cnn_tipo_consulta",     () => cnnGet("/tipo-consulta/lista?registrosPorPagina=200&pagina=0", env, target)],
        ["cnn_tipo_procedimento", () => cnnGet("/tipo-procedimento/lista?registrosPorPagina=200&pagina=0&tipo=TODOS", env, target)],
        ["kommo_pipelines",       () => kommoGet("/leads/pipelines?with=statuses", env)],
        ["kommo_leads_fields",    () => kommoGet("/leads/custom_fields", env)],
        ["kommo_contacts_fields", () => kommoGet("/contacts/custom_fields", env)],
      ];
      for (const [key, fn] of calls) {
        try { results[key] = await fn(); } catch (e) { results[key] = { error: String(e) }; }
      }
      // Contagem REAL de leads — Kommo não retorna total_items; paginamos tudo e
      // agregamos por pipeline e por etapa. read-only.
      try {
        const porPipeline: Record<string, number> = {};
        const porEtapa: Record<string, number> = {};
        let total = 0, page = 1, capped = false;
        const MAX_PAGES = 80; // 80 × 250 = 20k leads de teto
        while (true) {
          const r: any = await kommoGet(`/leads?limit=250&page=${page}`, env);
          const leads = r._embedded?.leads ?? [];
          if (leads.length === 0) break;
          total += leads.length;
          for (const l of leads) {
            porPipeline[l.pipeline_id] = (porPipeline[l.pipeline_id] ?? 0) + 1;
            porEtapa[`${l.pipeline_id}:${l.status_id}`] = (porEtapa[`${l.pipeline_id}:${l.status_id}`] ?? 0) + 1;
          }
          if (leads.length < 250) break;
          if (++page > MAX_PAGES) { capped = true; break; }
        }
        results.kommo_lead_counts = { total, capped, paginas: page, por_pipeline: porPipeline, por_etapa: porEtapa };
      } catch (e) { results.kommo_lead_counts = { error: String(e) }; }
      return Response.json(results);
    }

    if (!webhookAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });

    if (req.method === "POST") {
      if (pathname === "/webhook/lead-agendado")     return handleLeadAgendado(req, env);
      if (pathname === "/webhook/confirmacao")       return handleConfirmacao(req, env);
      if (pathname === "/webhook/pos-venda-agendar") return handlePosVendaAgendar(req, env);
    }

    return new Response("Not found", { status: 404 });
}

export async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      resetSubreq();                              // teto de 50 fetch/invocação é por invocação
      const target: CnnTarget = "production";     // Fase 1: lê CNN prod (só leitura) + escreve Kommo
      const t = new Date(event.scheduledTime);
      const day = t.getUTCDay();                  // 0=Dom..6=Sáb (válido p/ 18h/14h UTC = mesmo dia BRT)
      const hour = t.getUTCHours();
      const min = t.getUTCMinutes();
      // B2: lease cooperativo — se o tick anterior ainda roda (ou um /debug-tick está ativo),
      // PULA este minuto em vez de sobrepor (o subreqUsados global e a fila não toleram 2 juntos).
      await ensureSchema(env);
      const owner = novoOwnerLease("cron");
      const lease = await adquirirLease(env, owner);
      if (!lease.ok) { console.log(`tick ${hour}:${min} pulado: lease em uso por ${lease.dono}`); return; }
      // F1: instrumentação do tick (contadores + duração) → tick_log (durável).
      const tickTs = Math.floor(Date.now() / 1000);
      const tickInicio = Date.now();
      const prod: any = {};
      const gatilhos: string[] = [];
      let cons: any = null;
      let tickOk = true;
      let tickErro: string | undefined;
      try {
        // Item 1 — Confirmação por horário (enfileira; o dreno abaixo move o lead)
        if (day >= 1 && day <= 5 && hour === 18 && min === 0) {
          prod.vespera = await produtorVespera(env, target, tomorrowBRT());   // Seg–Sex 15h BRT → D+1
          gatilhos.push("vespera-d1");
        } else if (day === 6 && hour === 14 && min === 0) {
          prod.vespera = await produtorVespera(env, target, nextMondayBRT()); // Sáb 11h BRT → segunda
          gatilhos.push("vespera-seg");
        }
        // Item 3 — Sync de base CNN→Kommo (janela −2/+14, produtor a cada 10 min)
        if (min % 10 === 0) {
          prod.sync = await produtorSync(env, target, 14);                    // windowDays=14 ⇒ −2/+14
          gatilhos.push("sync");
        }
        // Reflexo de Orçamento CNN → etapa Kommo (todo minuto; budget baixo p/ NÃO starvar
        // o dreno abaixo; o cursor cobre a base ao longo dos minutos). Kill-switch: ORC_ENABLED.
        if (ORC_ENABLED) {
          prod.orc = await produtorOrcamento(env, target, 20);
          gatilhos.push("orc");
        }
        // Dreno da fila todo minuto (escreve Kommo; nunca CNN)
        cons = await consumirFila(env, target, false, 10, 40);
      } catch (e) {
        tickOk = false;
        tickErro = String(e);
        console.error("scheduled tick falhou:", e);  // visível nos logs do Cloudflare; próximo tick reprocessa
      } finally {
        // Log durável ANTES de liberar o lease (serializado; nunca lança).
        await registrarTick(env, { ts: tickTs, ok: tickOk, ms: Date.now() - tickInicio, subreq: subreqUsados, gatilhos, cons, erro: tickErro, resumo: { gatilhos, prod, cons } });
        await verificarAlertaGrave(env);             // F1-alerta: tarefa Kommo p/ o técnico só em erro grave (cooldown)
        await liberarLease(env, owner);              // libera SEMPRE (mesmo com exceção) — anti-deadlock
      }
    })());
}

interface Env {
  DB: D1Database;
  CNN_CID: string;
  CNN_BASIC_USER: string;
  CNN_BASIC_PASS: string;
  // Produção CNN — SOMENTE LEITURA (§7.8)
  CNN_CID_PRODUCTION: string;
  CNN_BASIC_USER_PRODUCTION: string;
  CNN_BASIC_PASS_PRODUCTION: string;
  KOMMO_ACCESS_TOKEN: string;
  KOMMO_SUBDOMAIN: string;
  WEBHOOK_SECRET: string;
  // 3 webhooks Kommo→CNN (spec 2026-07-05-kommo-cnn-3-webhooks-escrita-cnn). Escrita CNN
  // guardada por allowlist (cnnProducaoPermitido). Tudo default OFF/sandbox — o dono liga.
  CNN_WRITE_TARGET?: string; // 'sandbox' (default) | 'production' — alvo das escritas dos webhooks
  WH1_ENABLED?: string;      // '1' liga o webhook 1 (Consulta Confirmada → CNN)
  WH2_ENABLED?: string;      // '1' liga o webhook 2 (Pós-Venda Agendar → CNN)
  // IDs de criação de agenda em PRODUÇÃO (sandbox×prod diferem — descoberto 07/07: os ids sandbox
  // NÃO existem em produção → POST /agenda/novo 400). Overridáveis por env; default = ids lidos do CNN prod.
  // Ver cnnConvenioParticular / cnnLocalAgenda / cnnTipoProcedimento.
  CNN_CONVENIO_PARTICULAR_PRODUCTION?: string;
  CNN_LOCAL_AGENDA_PRODUCTION?: string;
  CNN_TIPO_PROCEDIMENTO_PRODUCTION?: string;
  CNN_TIPO_CONSULTA_PRODUCTION?: string;        // F.Captura (Grupo A): tipo consulta (default 66666 Consulta/Avaliação)
  CNN_PROCEDIMENTO_CAPTURA_PRODUCTION?: string; // F.Captura: procedimento predefinido (default 361025 Av Capilar)
}

// =====================================================================
//  ESTOQUE MKT — Apps Script v3
//  Ajuste em massa seguro (lote único, nunca grava 2x) + backups/restauração
//  + login simples e presença (quem está usando o site agora)
//  Substitui SOMENTE o bloco antigo do site (doGet, doPost, setPctSite,
//  getPctSite, pctJson_, baixaEstoqueSite). Funções de outras abas: não mexa.
//  Depois: Implantar → Gerenciar implantações → lápis → Nova versão → Implantar
// =====================================================================

// ===== CONFIG =====
var GID_SITE_BAIXA = 961434769; // aba do estoque (mesmo gid usado no site)
var PCT_KEY = "upsellerPct";    // chave da % Upseller global
var MKT_VERSION = 3;
var MKT_COL_COD = 1;            // A
var MKT_COL_TOTAL = 3;          // C = TOTAL UN
var MKT_COL_ATUAL = 8;          // H = ATUALIZACAO
var MKT_BK_SHEET = "_BACKUPS_MKT";      // aba oculta com os backups
var MKT_LOG_SHEET = "_LOG_AJUSTES_MKT"; // histórico de cada SKU alterado
var MKT_MAX_BACKUPS = 200;
var MKT_CHUNK = 40000;          // caracteres por célula (limite Google = 50.000)

// Logins do site: guardam só o HASH da senha, porque este arquivo fica no GitHub.
// Para criar ou trocar uma senha: edite usuário/senha em mktGerarHash (fim do
// arquivo), execute essa função, copie o hash do log e cole aqui.
var MKT_USERS = {
  user64: "6a20f69d631cbf241ca94c66c15c31886a4e41575630d42d03148dee094a5ac5",
  adm: "b3993d5984f5f4b9745543e36ddef81d8b02d9e0c5266f51e3d250d5d7b83cea",
  Silvia: "99b220a978cb77c52940e97b7cd2fe4aeaf01b7a82b57fe90a94a5989f86d7cf",
  Givaldo: "03c136766e7acc351a34ab94d8a6b44da81c3d61d85cd27eb837d3d0b89673d8",
  userFL: "c386678ae65400b335a23841f2ffbd2fd43a9bea55a639e97acd4a49f6037d2e",
  userDF: "8ad508659e8ed199412f58c124eb14cf1ed9513c3a4450c57d4345b955a83989"
};
var MKT_PRES_KEY = "mktPresence"; // chave do cache com as sessões abertas
var MKT_PRES_TTL = 90000;         // ms sem sinal até a sessão sair da lista

// ===== ENTRADAS DO WEB APP =====

// GET → % Upseller, status de lote, lista de backups
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (String(p.action || "").indexOf("sep_") === 0) return pctJson_(sepHandle_(p)); // CentraLux Separação
    if (p.action === "getPct") return getPctSite();
    if (p.action === "ping") return pctJson_({ ok: true, version: MKT_VERSION });
    if (p.action === "status") return pctJson_(mktBatchStatus_(p.batch));
    if (p.action === "listBackups") return pctJson_({ ok: true, backups: mktListBackups_() });
    // plano B: o site manda o lote por GET se o POST falhar
    if (p.action === "post" && p.payload) return pctJson_(mktHandle_(JSON.parse(p.payload)));
    return pctJson_({ ok: false, error: "acao desconhecida (GET)" });
  } catch (err) {
    return pctJson_({ ok: false, error: mktErr_(err) });
  }
}

// POST → ajuste em massa, backup, restauração, % global
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error("POST sem conteudo");
    var data = JSON.parse(e.postData.contents);
    if (String(data.action || "").indexOf("sep_") === 0) return pctJson_(sepHandle_(data)); // CentraLux Separação
    return pctJson_(mktHandle_(data));
  } catch (err) {
    return pctJson_({ ok: false, error: mktErr_(err) });
  }
}

function mktHandle_(data) {
  var a = data.action || (data.changes ? "legacy" : "");
  if (a === "login") return mktLogin_(data);
  if (a === "presence") return mktPresence_(data);
  if (a === "listBackups") return { ok: true, backups: mktListBackups_() };
  if (a === "status") return mktBatchStatus_(data.batch);
  // daqui para baixo tudo grava na planilha: exige login
  if (!mktUserOf_(data.token)) throw new Error("sessao expirada: entre de novo");
  if (a === "setPct") return JSON.parse(setPctSite(data).getContent());
  if (a === "apply") return mktWithLock_(function () { return mktApplyBatch_(data); });
  if (a === "legacy") return mktWithLock_(function () { return mktApplyLegacy_(data); });
  if (a === "backup") return mktWithLock_(function () {
    return { ok: true, backup: mktCreateBackup_("manual", data.note || "Backup manual", "", null) };
  });
  if (a === "restore") return mktWithLock_(function () { return mktRestore_(data.id, data.scope === "lote"); });
  throw new Error("acao desconhecida: " + a);
}

// ===== LOGIN =====

function mktSha_(txt) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, txt, Utilities.Charset.UTF_8), hex = "";
  for (var i = 0; i < b.length; i++) hex += ("0" + (b[i] & 255).toString(16)).slice(-2);
  return hex;
}
function mktPassHash_(user, pass) { return mktSha_("estoque-mkt|" + user + "|" + pass); }

// Segredo gerado na primeira execução; fica só nas propriedades do script.
function mktSecret_() {
  var pr = PropertiesService.getScriptProperties(), s = pr.getProperty("mktSecret");
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); pr.setProperty("mktSecret", s); }
  return s;
}
// Trocar a senha invalida o token de quem já estava conectado com ela.
function mktToken_(user) { return user + "." + mktSha_(mktSecret_() + "|" + user + "|" + MKT_USERS[user]); }

function mktUserOf_(token) {
  var user = String(token || "").split(".")[0];
  if (!user || !MKT_USERS.hasOwnProperty(user)) return null;
  return mktToken_(user) === token ? user : null;
}

function mktLogin_(data) {
  // o login aceita maiúsculas ou minúsculas; a senha precisa ser exata
  var typed = mktKey_(data.user), user = null;
  for (var u in MKT_USERS) if (u.toUpperCase() === typed) user = u;
  if (!user || mktPassHash_(user, String(data.pass == null ? "" : data.pass)) !== MKT_USERS[user]) {
    return { ok: false, error: "Login ou senha incorretos" };
  }
  return { ok: true, user: user, token: mktToken_(user) };
}

// ===== PRESENÇA =====
// data = { action:"presence", token, dev, tab, active, leave }
// dev = navegador/dispositivo, tab = aba, active = aba visível na tela.
// Usa o bloqueio do documento, separado do bloqueio dos ajustes de estoque:
// um ajuste demorado não trava a presença.
function mktPresence_(data) {
  var user = mktUserOf_(data.token);
  if (!user) throw new Error("sessao expirada: entre de novo");
  var dev = String(data.dev || "").slice(0, 40), tab = String(data.tab || "").slice(0, 40);
  if (!dev || !tab) throw new Error("presenca sem identificador");
  var cache = CacheService.getScriptCache(), lock = LockService.getDocumentLock();
  var locked = !!lock && lock.tryLock(4000);
  try {
    var now = new Date().getTime(), map = {}, txt = cache.get(MKT_PRES_KEY);
    if (txt) { try { map = JSON.parse(txt); } catch (e) { map = {}; } }
    for (var k in map) if (now - map[k].t > MKT_PRES_TTL) delete map[k];
    var key = dev + "|" + tab;
    if (data.leave) delete map[key];
    else map[key] = { u: user, d: dev, a: !!data.active, t: now };
    if (locked) cache.put(MKT_PRES_KEY, JSON.stringify(map), 600);
  } finally {
    if (locked) lock.releaseLock();
  }
  // um navegador com várias abas conta uma vez; ativo se qualquer aba está visível
  var byDev = {}, sessions = [];
  for (var m in map) {
    var s = map[m], cur = byDev[s.d];
    if (cur) cur.active = cur.active || s.a;
    else { byDev[s.d] = { dev: s.d, user: s.u, active: s.a }; sessions.push(byDev[s.d]); }
  }
  return { ok: true, sessions: sessions };
}

// ===== % UPSELLER GLOBAL (igual à sua versão) =====

function pctJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Grava a % global: { action: "setPct", pct: 40 }
function setPctSite(data) {
  var n = parseInt(data.pct, 10);
  if (isNaN(n)) return pctJson_({ ok: false, error: "pct invalido" });
  n = Math.min(100, Math.max(0, n));
  PropertiesService.getScriptProperties().setProperty(PCT_KEY, String(n));
  return pctJson_({ ok: true, pct: n });
}

// Lê a % global: GET ?action=getPct
function getPctSite() {
  var v = PropertiesService.getScriptProperties().getProperty(PCT_KEY);
  return pctJson_({ ok: true, pct: v == null ? null : Number(v) });
}

// ===== FORMATO ANTIGO (compatibilidade) =====
// { changes:[{cod, newTotal}] } → vira um ajuste "definir" com backup
function baixaEstoqueSite(data) {
  try {
    return pctJson_(mktWithLock_(function () { return mktApplyLegacy_(data); }));
  } catch (err) {
    return pctJson_({ ok: false, error: mktErr_(err) });
  }
}

// ===== UTIL =====

function mktErr_(err) { return String((err && err.message) || err); }
function mktKey_(v) { return String(v == null ? "" : v).replace(/^\s+|\s+$/g, "").toUpperCase(); }
function mktTz_() { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || "America/Sao_Paulo"; }
function mktHoje_() { return Utilities.formatDate(new Date(), mktTz_(), "dd/MM/yy"); } // mesmo formato de antes
function mktStamp_() { return Utilities.formatDate(new Date(), mktTz_(), "dd/MM/yyyy HH:mm:ss"); }
function mktNum_(v) {
  if (typeof v === "number") return v;
  var d = String(v == null ? "" : v).replace(/[^\d-]/g, "");
  return d && d !== "-" ? parseInt(d, 10) : 0;
}
function mktStockSheet_() {
  var abas = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (var i = 0; i < abas.length; i++) if (abas[i].getSheetId() === GID_SITE_BAIXA) return abas[i];
  throw new Error("Aba com gid " + GID_SITE_BAIXA + " nao encontrada");
}
function mktAux_(name, header, hide) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name, ss.getSheets().length);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
    sh.setFrozenRows(1);
    if (hide) sh.hideSheet();
  }
  return sh;
}
function mktLogSheet_() {
  return mktAux_(MKT_LOG_SHEET, ["Data/hora", "Lote", "Modo", "SKU", "Antes", "Qtd", "Depois", "Status", "Backup"], false);
}
function mktBkSheet_() {
  return mktAux_(MKT_BK_SHEET, ["ID", "Data/hora", "Tipo", "Descricao", "Lote", "Itens", "Dados"], true);
}
function mktWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Planilha ocupada com outra gravacao. Tente de novo em alguns segundos.");
  try { return fn(); } finally { lock.releaseLock(); }
}
function mktModeLabel_(m) { return m === "definir" ? "DEFINIR (=)" : m === "entrada" ? "ENTRADA (+)" : "BAIXA (-)"; }
function mktSameCell_(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return String(a) === String(b);
}

// ===== AJUSTE EM MASSA =====
// data = { action:"apply", batchId, mode:"saida"|"entrada"|"definir", items:[{cod, qty}] }
// O cálculo é feito AQUI com o valor ATUAL da planilha, dentro do lock.
// O mesmo batchId nunca é aplicado duas vezes.
function mktApplyBatch_(data) {
  var batchId = String(data.batchId || "").replace(/^\s+|\s+$/g, "");
  if (!batchId) throw new Error("lote sem batchId");
  var prev = mktBatchStatus_(batchId);
  if (prev.applied) { prev.duplicate = true; return prev; }

  var mode = (data.mode === "entrada" || data.mode === "definir") ? data.mode : "saida";
  var items = data.items || [];
  if (!items.length) throw new Error("lote vazio");

  var sh = mktStockSheet_();
  var values = sh.getRange(1, 1, sh.getLastRow(), MKT_COL_ATUAL).getValues();

  // backup completo ANTES de mexer
  var bk = mktCreateBackup_("auto", "Antes do ajuste " + mktModeLabel_(mode) + " - " + items.length + " SKU(s)", batchId, values);

  var rowOf = {};
  for (var i = 0; i < values.length; i++) {
    var k = mktKey_(values[i][MKT_COL_COD - 1]);
    if (k && !rowOf.hasOwnProperty(k)) rowOf[k] = i;
  }

  // soma SKUs repetidos no mesmo lote
  var merged = {}, order = [];
  for (var j = 0; j < items.length; j++) {
    var kk = mktKey_(items[j].cod);
    if (!kk) continue;
    var q = Math.max(0, mktNum_(items[j].qty));
    if (merged.hasOwnProperty(kk)) merged[kk].qty = mode === "definir" ? q : merged[kk].qty + q;
    else { merged[kk] = { cod: String(items[j].cod).replace(/^\s+|\s+$/g, ""), qty: q }; order.push(kk); }
  }

  var now = new Date(), hoje = mktHoje_();
  var updated = [], skipped = [], notFound = [], log = [];
  for (var o = 0; o < order.length; o++) {
    var it = merged[order[o]], r = rowOf[order[o]];
    if (r == null) {
      notFound.push(it.cod);
      log.push([now, batchId, mode, it.cod, "", it.qty, "", "nao encontrado", bk.id]);
      continue;
    }
    var before = mktNum_(values[r][MKT_COL_TOTAL - 1]);
    var after = mode === "definir" ? it.qty : mode === "entrada" ? before + it.qty : before - it.qty;
    if (after < 0) {
      skipped.push({ cod: it.cod, before: before, after: after });
      log.push([now, batchId, mode, it.cod, before, it.qty, after, "ignorado: ficaria negativo", bk.id]);
      continue;
    }
    sh.getRange(r + 1, MKT_COL_TOTAL).setValue(after);
    sh.getRange(r + 1, MKT_COL_ATUAL).setValue(hoje);
    updated.push({ cod: it.cod, row: r + 1, before: before, after: after, qty: it.qty });
  }
  SpreadsheetApp.flush();

  // confere o que ficou gravado
  var mismatch = [];
  for (var u = 0; u < updated.length; u++) {
    var ok = mktNum_(sh.getRange(updated[u].row, MKT_COL_TOTAL).getValue()) === updated[u].after;
    if (!ok) mismatch.push(updated[u].cod);
    log.push([now, batchId, mode, updated[u].cod, updated[u].before, updated[u].qty, updated[u].after,
      ok ? "ok" : "ERRO: nao conferiu", bk.id]);
  }
  if (log.length) {
    var ls = mktLogSheet_();
    ls.getRange(ls.getLastRow() + 1, 1, log.length, log[0].length).setValues(log);
  }
  return { ok: true, batchId: batchId, backupId: bk.id, updated: updated, skipped: skipped, notFound: notFound, mismatch: mismatch };
}

function mktApplyLegacy_(data) {
  var ch = data.changes || [], items = [];
  for (var i = 0; i < ch.length; i++) items.push({ cod: ch[i].cod, qty: ch[i].newTotal });
  return mktApplyBatch_({ batchId: "legacy-" + new Date().getTime(), mode: "definir", items: items });
}

// O lote já foi aplicado? (o log é a prova)
function mktBatchStatus_(batchId) {
  batchId = String(batchId || "").replace(/^\s+|\s+$/g, "");
  if (!batchId) return { ok: true, applied: false };
  var ls = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MKT_LOG_SHEET);
  if (!ls || ls.getLastRow() < 2) return { ok: true, applied: false };
  var all = ls.getRange(2, 1, ls.getLastRow() - 1, 9).getValues();
  var updated = [], skipped = [], notFound = [], mismatch = [], backupId = "", found = false;
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    if (String(r[1]) !== batchId) continue;
    found = true; backupId = String(r[8]);
    var st = String(r[7]), cod = String(r[3]);
    if (st === "ok") updated.push({ cod: cod, before: r[4], after: r[6] });
    else if (st.indexOf("ERRO") === 0) { updated.push({ cod: cod, before: r[4], after: r[6] }); mismatch.push(cod); }
    else if (st === "nao encontrado") notFound.push(cod);
    else skipped.push({ cod: cod, before: r[4], after: r[6] });
  }
  if (!found) return { ok: true, applied: false };
  return { ok: true, applied: true, batchId: batchId, backupId: backupId, updated: updated, skipped: skipped, notFound: notFound, mismatch: mismatch };
}

// ===== BACKUPS =====
// Guarda TOTAL UN (C) e ATUALIZACAO (H) de TODAS as linhas com SKU.
function mktCreateBackup_(tipo, desc, lote, values) {
  var sh = mktStockSheet_();
  if (!values) values = sh.getRange(1, 1, sh.getLastRow(), MKT_COL_ATUAL).getValues();
  var snap = [];
  for (var i = 0; i < values.length; i++) {
    var cod = String(values[i][MKT_COL_COD - 1]).replace(/^\s+|\s+$/g, "");
    if (!cod) continue;
    var at = values[i][MKT_COL_ATUAL - 1];
    snap.push([i + 1, cod, values[i][MKT_COL_TOTAL - 1], at instanceof Date ? "D" + at.getTime() : at]);
  }
  var txt = JSON.stringify(snap), chunks = [];
  for (var c = 0; c < txt.length; c += MKT_CHUNK) chunks.push(txt.slice(c, c + MKT_CHUNK));
  var id = Utilities.formatDate(new Date(), mktTz_(), "yyyyMMdd-HHmmss") + "-" + Math.floor(Math.random() * 1000);
  var at2 = mktStamp_();
  var row = [id, at2, tipo, desc, lote || "", String(snap.length)].concat(chunks);
  var bs = mktBkSheet_();
  bs.getRange(bs.getLastRow() + 1, 1, 1, row.length).setNumberFormat("@").setValues([row]);
  var extra = bs.getLastRow() - 1 - MKT_MAX_BACKUPS; // poda os mais antigos
  if (extra > 0) bs.deleteRows(2, extra);
  return { id: id, at: at2, tipo: tipo, desc: desc, itens: snap.length };
}

function mktListBackups_() {
  var bs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MKT_BK_SHEET);
  if (!bs || bs.getLastRow() < 2) return [];
  var v = bs.getRange(2, 1, bs.getLastRow() - 1, 6).getDisplayValues(), out = [];
  for (var i = v.length - 1; i >= 0; i--) {
    out.push({ id: v[i][0], at: v[i][1], tipo: v[i][2], desc: v[i][3], lote: v[i][4], itens: Number(v[i][5]) || 0 });
  }
  return out;
}

function mktReadBackup_(id) {
  var bs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MKT_BK_SHEET);
  if (!bs || bs.getLastRow() < 2) throw new Error("nenhum backup encontrado");
  var all = bs.getRange(2, 1, bs.getLastRow() - 1, bs.getLastColumn()).getDisplayValues();
  for (var i = 0; i < all.length; i++) {
    if (all[i][0] === String(id)) {
      var r = all[i];
      return { meta: { id: r[0], at: r[1], tipo: r[2], desc: r[3], lote: r[4] }, snap: JSON.parse(r.slice(6).join("")) };
    }
  }
  throw new Error("backup " + id + " nao encontrado");
}

// soLote=true  → "Desfazer ajuste": volta só os SKUs alterados naquele ajuste
// soLote=false → "Restaurar tudo": volta a aba inteira para o momento do backup
function mktRestore_(id, soLote) {
  var bk = mktReadBackup_(id);
  var only = null;
  if (soLote) {
    if (!bk.meta.lote) throw new Error("este backup nao esta ligado a um ajuste; use 'Restaurar tudo'");
    var st = mktBatchStatus_(bk.meta.lote);
    only = {};
    var cnt = 0;
    for (var u = 0; u < (st.updated || []).length; u++) { only[mktKey_(st.updated[u].cod)] = true; cnt++; }
    if (!cnt) throw new Error("esse ajuste nao alterou nenhum SKU");
  }
  var sh = mktStockSheet_();
  var values = sh.getRange(1, 1, sh.getLastRow(), MKT_COL_ATUAL).getValues();
  var safety = mktCreateBackup_("restauracao", "Antes de " + (soLote ? "desfazer ajuste" : "restaurar") + " " + bk.meta.at, "", values);

  // casa por SKU + ordem de ocorrência (para SKUs repetidos)
  var occ = {}, cur = {};
  for (var i = 0; i < values.length; i++) {
    var k = mktKey_(values[i][MKT_COL_COD - 1]);
    if (!k) continue;
    occ[k] = (occ[k] || 0) + 1;
    cur[k + "#" + occ[k]] = i;
  }
  var occB = {}, now = new Date(), lote = "RESTAURA-" + id, log = [], changed = 0, missing = [];
  for (var s = 0; s < bk.snap.length; s++) {
    var e = bk.snap[s], kb = mktKey_(e[1]);
    occB[kb] = (occB[kb] || 0) + 1;
    if (only && !only[kb]) continue;
    var idx = cur[kb + "#" + occB[kb]];
    if (idx == null) { missing.push(e[1]); continue; }
    var total = e[2];
    var at = (typeof e[3] === "string" && /^D-?\d+$/.test(e[3])) ? new Date(Number(e[3].slice(1))) : e[3];
    var before = values[idx][MKT_COL_TOTAL - 1];
    var sameTotal = mktSameCell_(before, total), sameAt = mktSameCell_(values[idx][MKT_COL_ATUAL - 1], at);
    if (sameTotal && sameAt) continue;
    if (!sameTotal) sh.getRange(idx + 1, MKT_COL_TOTAL).setValue(total);
    if (!sameAt) sh.getRange(idx + 1, MKT_COL_ATUAL).setValue(at);
    changed++;
    if (!sameTotal) log.push([now, lote, soLote ? "desfazer" : "restaurar", e[1], before, "", total, "ok", safety.id]);
  }
  SpreadsheetApp.flush();
  if (log.length) {
    var ls = mktLogSheet_();
    ls.getRange(ls.getLastRow() + 1, 1, log.length, log[0].length).setValues(log);
  }
  return { ok: true, restored: changed, totalChanged: log.length, missing: missing, safetyBackupId: safety.id, from: bk.meta };
}

// ===== BACKUP DIÁRIO (opcional) =====
// Acionadores (relógio) → Adicionar acionador → função backupDiarioMkt →
// Baseado no tempo → Contador de dias → escolha o horário.
function backupDiarioMkt() {
  mktWithLock_(function () { return mktCreateBackup_("diario", "Backup automatico diario", "", null); });
}

// =====================================================================
//  CENTRALUX SEPARAÇÃO — cole este bloco no FINAL do CONTAGEM.gs
//  Não tem doGet/doPost próprios: usa 1 linha no doGet e 1 no doPost.
// =====================================================================
/**
 *
 *  - Aba "Estoque Sistema": A = Cód (SKU), B = Estoque, C = Descrição  (somente leitura)
 *  - Aba "Log Separacao":   banco de dados dos pedidos em separação (1 linha por SKU)
 *  - Aba "Historico Separacao": criada automaticamente — registra inclusões, edições e exclusões
 */

var SEP_SS_ID = '1fRqUo8vH4awjCwV12U0fhR2bdBSRGFUVMlU8PozUsoQ';
var SEP_ABA_ESTOQUE = 'Estoque Sistema';
var SEP_ABA_LOG = 'Log Separacao';
var SEP_ABA_HIST = 'Historico Separacao';
var SEP_TZ = 'America/Sao_Paulo';

var SEP_LOG_HEADERS = ['ID', 'Pedido', 'Cliente', 'Vendedor', 'Data Entrada', 'SKU', 'Descrição', 'Qtd', 'Criado em', 'Atualizado em'];
var SEP_HIST_HEADERS = ['Data/Hora', 'Ação', 'ID', 'Pedido', 'Cliente', 'Vendedor', 'Data Entrada', 'SKUs'];

/* ---------------- Roteador (chamado pelo doGet/doPost do Código.gs) ---------------- */

function sepHandle_(data) {
  var a = String(data.action || '');
  if (a === 'sep_list') return { ok: true, pedidos: sepGetPedidos_() };
  if (a === 'sep_catalogo') return { ok: true, catalogo: sepGetCatalogo_() };
  if (a === 'sep_all') return { ok: true, pedidos: sepGetPedidos_(), catalogo: sepGetCatalogo_() };
  if (a === 'sep_save' || a === 'sep_delete') {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) throw new Error('Planilha ocupada. Tente de novo em alguns segundos.');
    try {
      if (a === 'sep_save') {
        var id = sepSavePedido_(typeof data.pedido === 'string' ? JSON.parse(data.pedido) : data.pedido);
        return { ok: true, id: id, pedidos: sepGetPedidos_() };
      }
      sepDeletePedido_(data.id);
      return { ok: true, pedidos: sepGetPedidos_() };
    } finally { lock.releaseLock(); }
  }
  throw new Error('acao desconhecida: ' + a);
}

/* ---------------- Abas ---------------- */

function sepNorm_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function sepSheet_(name, headers) {
  var ss = SpreadsheetApp.openById(SEP_SS_ID);
  var sh = ss.getSheets().find(s => sepNorm_(s.getName()) === sepNorm_(name));
  if (!sh) {
    if (!headers) throw new Error('Aba "' + name + '" não encontrada');
    sh = ss.insertSheet(name);
  }
  if (headers) {
    var first = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (first.join('') === '') {
      sh.getRange(1, 1, 1, headers.length).setValues([headers])
        .setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
      sh.setFrozenRows(1);
      sh.getRange('A:Z').setNumberFormat('@'); // tudo como texto (SKU e datas não viram números)
    }
  }
  return sh;
}

/* ---------------- Catálogo (Estoque Sistema) ---------------- */

function sepGetCatalogo_() {
  var sh = sepSheet_(SEP_ABA_ESTOQUE);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 3).getDisplayValues();
  var seen = {};
  var out = [];
  vals.forEach(r => {
    var sku = String(r[0]).trim();
    if (!sku || seen[sku]) return;
    seen[sku] = true;
    var desc = String(r[2]).replace(/^"+|"+$/g, '').trim();
    out.push([sku, desc, String(r[1]).trim()]); // [sku, descrição, estoque]
  });
  return out;
}

/* ---------------- Pedidos (Log Separacao) ---------------- */

function sepGetPedidos_() {
  var sh = sepSheet_(SEP_ABA_LOG, SEP_LOG_HEADERS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, SEP_LOG_HEADERS.length).getDisplayValues();
  var map = {};
  var order = [];
  vals.forEach(r => {
    var id = String(r[0]).trim();
    if (!id) return;
    if (!map[id]) {
      map[id] = {
        id: id, pedido: r[1], cliente: r[2], vendedor: r[3],
        dataEntrada: sepToIso_(r[4]), criadoEm: r[8], atualizadoEm: r[9], itens: []
      };
      order.push(id);
    }
    if (String(r[5]).trim()) map[id].itens.push({ sku: r[5], descricao: r[6], qtd: r[7] });
  });
  return order.map(id => map[id]);
}

function sepSavePedido_(p) {
  if (!p) throw new Error('Pedido vazio');
  if (!String(p.pedido || '').trim()) throw new Error('Informe o número do pedido');
  var sh = sepSheet_(SEP_ABA_LOG, SEP_LOG_HEADERS);
  var agora = Utilities.formatDate(new Date(), SEP_TZ, 'dd/MM/yyyy HH:mm:ss');
  var isNovo = !p.id;
  var id = p.id || Utilities.getUuid().slice(0, 8);

  let criadoEm = agora;
  if (!isNovo) {
    var antigo = sepGetPedidos_().find(x => x.id === id);
    if (antigo && antigo.criadoEm) criadoEm = antigo.criadoEm;
    sepRemoveRows_(sh, id);
  }

  var itens = (p.itens || []).filter(i => String(i.sku || '').trim());
  if (!itens.length) itens.push({ sku: '', descricao: '', qtd: '' });
  var data = sepToBr_(p.dataEntrada);
  var rows = itens.map(i => [
    id, String(p.pedido).trim(), String(p.cliente || '').trim(), String(p.vendedor || '').trim(),
    data, String(i.sku || '').trim(), String(i.descricao || '').trim(), String(i.qtd || ''),
    criadoEm, agora
  ]);
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, SEP_LOG_HEADERS.length).setNumberFormat('@').setValues(rows);

  sepHistorico_(isNovo ? 'INCLUÍDO' : 'EDITADO', id, p, data, itens);
  return id;
}

function sepDeletePedido_(id) {
  if (!id) throw new Error('ID não informado');
  var sh = sepSheet_(SEP_ABA_LOG, SEP_LOG_HEADERS);
  var antigo = sepGetPedidos_().find(x => x.id === id);
  sepRemoveRows_(sh, id);
  if (antigo) sepHistorico_('EXCLUÍDO', id, antigo, sepToBr_(antigo.dataEntrada), antigo.itens);
}

function sepRemoveRows_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return;
  var ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]).trim() === id) sh.deleteRow(i + 2);
  }
}

function sepHistorico_(acao, id, p, data, itens) {
  var sh = sepSheet_(SEP_ABA_HIST, SEP_HIST_HEADERS);
  var skus = (itens || []).filter(i => i.sku).map(i => i.sku + (i.qtd ? ' (x' + i.qtd + ')' : '')).join(', ');
  sh.appendRow([
    Utilities.formatDate(new Date(), SEP_TZ, 'dd/MM/yyyy HH:mm:ss'), acao, id,
    p.pedido || '', p.cliente || '', p.vendedor || '', data, skus
  ]);
}

/* ---------------- Datas ---------------- */

// "2026-10-23" -> "23/10/2026"
function sepToBr_(iso) {
  var s = String(iso || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[3] + '/' + m[2] + '/' + m[1];
  return s || Utilities.formatDate(new Date(), SEP_TZ, 'dd/MM/yyyy');
}

// "23/10/2026" -> "2026-10-23"
function sepToIso_(br) {
  var s = String(br || '').trim();
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return s;
}

/* Rode uma vez pelo editor para autorizar e criar os cabeçalhos */
function sepSetup() {
  sepSheet_(SEP_ABA_LOG, SEP_LOG_HEADERS);
  sepSheet_(SEP_ABA_HIST, SEP_HIST_HEADERS);
  Logger.log('Catálogo: ' + sepGetCatalogo_().length + ' SKUs');
}

// ===== SENHAS =====
// Execute no editor do Apps Script e veja o hash em "Registro de execução".
function mktGerarHash() {
  var usuario = "novo_usuario", senha = "nova_senha";
  Logger.log(usuario + ": " + mktPassHash_(usuario, senha));
}

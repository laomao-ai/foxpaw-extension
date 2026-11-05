// FoxPaw · 狐爪 — extension background (v1.9)
// Cloud agents reach this Chrome through the FoxPaw relay (outbound WSS,
// HMAC challenge-response; the pairing token itself never travels).
// Only tabs inside the "FoxPaw" tab group are controllable. Safety gate:
// deterministic action classification (CN/EN), confirmation cards for
// sensitive writes, handover hard line for secrets/payment/authorization.
'use strict';

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

const GROUP_TITLE = 'FoxPaw';
const VERSION = '1.34.1';
// 1.17 录制版: the flow format / conversion / Playwright export
// live in flow.js (pure, shared with Node tests and tools)
const FF = (() => { try { if (typeof importScripts === 'function' && !self.FoxFlow) importScripts('flow.js'); } catch (e) { console.warn('[foxpaw] flow.js not loaded', e); } return self.FoxFlow || null; })();
// 1.34 中 / EN：系统通知跟侧栏语言走（storage.uiLang，侧栏写入；没有时按 Chrome 界面语言）。词典与侧栏同一份 i18n.js。
const I18N = (() => { try { if (typeof importScripts === 'function' && !self.fpI18n) importScripts('i18n.js'); } catch (e) { console.warn('[foxpaw] i18n.js not loaded', e); } return self.fpI18n || null; })();
let uiLang = null;
try {
  const g = chrome.storage.local.get('uiLang');
  if (g && typeof g.then === 'function') g.then((o) => { if (o && (o.uiLang === 'en' || o.uiLang === 'zh')) uiLang = o.uiLang; }).catch(() => {});
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.uiLang) uiLang = c.uiLang.newValue === 'en' || c.uiLang.newValue === 'zh' ? c.uiLang.newValue : null; });
} catch { /* test mocks */ }
function l10n(s) { if (!I18N) return s; return (uiLang || I18N.lang) === 'en' ? I18N.en(s) : s; }
const RELAY_HTTP = 'https://foxpaw.aiyuancat.com'; // 1.31.0: default for NEW pairings; a stored pairing keeps its own address
const DEFAULTS = {
  pairing: '',          // wss://host/ext#<token>
  enabled: false,       // connection on/off (sign-out turns it off)
  access: 'write',      // 'off' = 全部暂停 | 'write' = normal. 1.27: the browser-level 只看 is gone ('read' reads as 'write')
  sensitive: 'ask',     // 'ask' 每次问我 | 'rules' 按站点规则 — confirm policy inside 可操作
  siteRules: {},        // origin -> 'allow' | 'ask' | 'block'
  remembered: [],       // approved bases: `${origin}|${category}|${formAction}`
  agentPause: {},       // device-level pause: agent ID -> true (v1.15, ; 'label:<name>' = legacy key from ≤1.14 until migrated)
};

/* ---------------- storage helpers ---------------- */
const ACCESS = ['off', 'read', 'write'];
let accessNow = 'write'; // sync mirror of cfg.access for hot paths (CDP event forwarding)
async function cfg() {
  const c = await chrome.storage.local.get({ foxpawCfg: DEFAULTS });
  const out = { ...DEFAULTS, ...c.foxpawCfg };
  if (out.access !== 'off') out.access = 'write'; // 1.27: only 全部暂停 is left; a stored 只看 (≤1.26) = no limit
  if (out.sensitive !== 'rules') out.sensitive = 'ask';
  accessNow = out.access;
  return out;
}
// v1.9 migration: session mode ask/auto -> sensitive ask/rules; access added
// (default 可操作); `enabled` keeps its connection meaning; 'deny' rules -> 'block'.
async function migrateCfg() {
  const { foxpawCfg: raw } = await chrome.storage.local.get('foxpawCfg');
  // 1.27: the browser-level 停用 / 只看 / 可操作 switch is gone (permission is per agent now);
  // a stored 只看 becomes 可操作 once (全部暂停 = 'off' stays as it was)
  if (raw && raw.cfgVersion === 19 && raw.access === 'read') {
    await chrome.storage.local.set({ foxpawCfg: { ...raw, access: 'write' } });
    audit('1.27 migration: browser access 只看 -> no browser-level limit (permission is per agent now)').catch(() => {});
  }
  if (!raw || raw.cfgVersion === 19) { await cfg(); return; }
  const next = { ...DEFAULTS, ...raw, cfgVersion: 19 };
  if (!('sensitive' in raw)) next.sensitive = raw.mode === 'auto' ? 'rules' : 'ask';
  if (raw.access !== 'off') next.access = 'write'; // 1.27
  delete next.mode;
  const rules = { ...(raw.siteRules || {}) };
  for (const k of Object.keys(rules)) if (rules[k] === 'deny') rules[k] = 'block';
  next.siteRules = rules;
  await chrome.storage.local.set({ foxpawCfg: next });
  accessNow = next.access;
}
function siteRule(c, origin) {
  const r = (c.siteRules || {})[origin];
  return r === 'deny' ? 'block' : r;
}
let cfgChain = Promise.resolve();
function saveCfg(patch) {
  // serialized read-modify-write (two quick setRule calls used to lose one)
  cfgChain = cfgChain.catch(() => {}).then(async () => {
    const c = await cfg();
    await chrome.storage.local.set({ foxpawCfg: { ...c, ...patch } });
  });
  return cfgChain;
}
// Install identity: a random, non-sensitive id that identifies THIS browser
// install across sign-outs. It lives in its own storage key on purpose —
// signOut clears credentials (foxpawCfg.pairing) and device state (foxpawUi),
// never this key, so a re-login can be recognised by the relay as the same
// browser and rebound to its existing device record instead of minting a
// duplicate. It is NOT a credential: the pairing string stays the secret.
const INSTALL_KEY = 'foxpawInstallId';
async function installId() {
  const st = await chrome.storage.local.get(INSTALL_KEY);
  if (st[INSTALL_KEY]) return st[INSTALL_KEY];
  const id = (crypto.randomUUID ? crypto.randomUUID()
    : 'fp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10));
  await chrome.storage.local.set({ [INSTALL_KEY]: id });
  return id;
}
// Web-session probe: while this browser is NOT connected, the
// panel's back face must still offer a way back in — and say so in terms
// of the website session when one exists. The website login is a cookie
// on the relay origin; the extension can read /auth/me with credentials.
// Throttled, fire-and-forget; result lands in foxpawUi.webAccount.
let webAccountAt = 0, webAccountBusy = false;
async function refreshWebAccount(force) {
  const now = Date.now();
  if (webAccountBusy || (!force && now - webAccountAt < 120000)) return;
  webAccountBusy = true; webAccountAt = now;
  try {
    const c = await cfg();
    if (c.pairing) { await setUi({ webAccount: null }); return; }
    const r = await fetch(RELAY_HTTP + '/auth/me', { credentials: 'include' });
    const j = r.ok ? await r.json().catch(() => null) : null;
    const email = j && j.account && j.account.email;
    await setUi({ webAccount: email ? { email: String(email) } : null });
  } catch { try { await setUi({ webAccount: null }); } catch { /* noop */ } }
  webAccountBusy = false;
}
// Local teardown shared by 断开 and 切换账号: credentials + device state
// only — foxpawInstallId survives on purpose (see installId()).
// 1.20: the panel remembers it WAS connected (「已断开 · 重新连接」, not the
// first-run three steps) — label + masked account only, never a credential.
async function teardownLocal(disconnected) {
  const { foxpawUi = {} } = await chrome.storage.local.get('foxpawUi');
  await saveCfg({ pairing: '', enabled: false });
  await setUi({ deviceLabel: '', deviceId: '', account: null, lastRun: null, runs: [],
    disconnected: disconnected ? { label: foxpawUi.deviceLabel || '', at: Date.now(), badge: (foxpawUi.account && foxpawUi.account.badge) || null, reason: disconnected } : null });
}
// 1.20 (/ P0-2): 断开 / 切换账号 tell the relay first. The request is authenticated by
// THIS device's credential (HMAC over "signout:<deviceId>:<ts>", the token never travels), so it
// needs no web session and no CSRF exemption; the relay voids the credential at once and, with
// web=true, ends the website session this browser sends (切换账号 promises 官网也会退出登录 — the old
// cookie-only POST /auth/logout from the extension origin was refused 403 by the relay's CSRF check).
function relayHttpOf(pairing) {
  const p = parsePairing(pairing);
  if (!p) return RELAY_HTTP;
  try { const u = new URL(p.url); return (u.protocol === 'ws:' ? 'http:' : 'https:') + '//' + u.host; } catch { return RELAY_HTTP; }
}
async function deviceSignout(pairing, deviceId, reason, web) {
  const p = parsePairing(pairing);
  if (!p || !deviceId) return { ok: false, error: 'not paired' };
  try {
    const ts = Math.floor(Date.now() / 1000);
    const proof = await hmacHex(p.token, `signout:${deviceId}:${ts}`);
    const r = await fetch(relayHttpOf(pairing) + '/auth/device/signout', { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: deviceId, ts, proof, reason, web: !!web }) });
    const j = await r.json().catch(() => ({}));
    await audit(`relay ${reason}: credential ${j.revoked ? 'voided' : 'not voided (' + (j.error || r.status) + ')'}${web ? `, web session ${j.web_logout ? 'ended' : 'not found'}` : ''}`);
    return { ok: r.ok, ...j };
  } catch (e) {
    await audit(`relay ${reason} failed: ${String((e && e.message) || e).slice(0, 80)} (local credentials cleared anyway)`);
    return { ok: false, error: String((e && e.message) || e) };
  }
}
/* ---- 1.20: this browser's local data is kept PER ACCOUNT ----
   Authorized tab groups, the local recording library, site rules / remembered approvals / agent
   pauses / confirm policy, the local task mirror. When the browser connects as another account (or
   切换账号 starts), the current account's share is stashed under its id and cleared: its groups are
   no longer ours (renamed 「已停用 · FoxPaw · …」, grey — no agent can see them), its recordings
   leave the library. Connecting back as that account restores them (groups by id, or by their
   disabled title after a browser restart). foxpawAcct = the account the live data belongs to. */
const ACCT_KEY = 'foxpawAcct';
const ACCT_STASH = 'foxpawAcctStash';
const ACCT_CFG = ['siteRules', 'remembered', 'agentPause', 'sensitive'];
const DISABLED_PREFIX = '已停用 · ';
let acctChain = Promise.resolve();
function acctSerial(fn) { acctChain = acctChain.catch(() => {}).then(fn); return acctChain; }
async function acctDeactivateNow(why) {
  const st = await chrome.storage.local.get([ACCT_KEY, ACCT_STASH, 'foxpawRecLibrary', 'foxpawTasks', 'foxpawTaskTombstones', GROUPS_KEY]);
  const id = st[ACCT_KEY];
  if (!id) return false;
  await groupsReady();
  const c = await cfg();
  const label = await deviceLabelNow();
  const groups = [];
  for (const gid of [...ownGroups]) {
    let title = '';
    try { const g = await chrome.tabGroups.get(gid); title = g.title || ''; } catch { /* gone */ }
    const dis = DISABLED_PREFIX + (title || groupTitle(label));
    try { await chrome.tabGroups.update(gid, { title: dis, color: 'grey' }); } catch { /* gone */ }
    groups.push({ id: gid, title: dis });
  }
  try { const tabs = (await chrome.tabs.query({})) || []; for (const t of tabs) if (isOwnGroup(t.groupId) || adopted.has(t.id)) await detachDebugger(t.id); } catch { /* noop */ }
  ownGroups.clear(); adopted.clear(); saveAdopted();
  const stash = { ...(st[ACCT_STASH] || {}) };
  stash[id] = { at: Date.now(), groups, recLibrary: st.foxpawRecLibrary || [], tasks: st.foxpawTasks || [],
    tombstones: st.foxpawTaskTombstones || [], cfg: Object.fromEntries(ACCT_CFG.map((k) => [k, c[k]])) };
  await chrome.storage.local.set({ [ACCT_STASH]: stash, [ACCT_KEY]: '', foxpawRecLibrary: [], foxpawTasks: [], foxpawTaskTombstones: [] });
  await saveCfg(Object.fromEntries(ACCT_CFG.map((k) => [k, DEFAULTS[k]])));
  await saveGroups({ migrated: true });
  await setUi({ windows: [], drafts: [], recLock: null });
  await audit(`local data of the previous account set aside (${why}): ${groups.length} group(s) no longer authorized, ${(st.foxpawRecLibrary || []).length} recording(s) hidden`);
  return true;
}
async function acctActivateNow(id) {
  if (!id) return;
  const st = await chrome.storage.local.get([ACCT_KEY, ACCT_STASH]);
  if (st[ACCT_KEY] === id) return;
  if (st[ACCT_KEY]) await acctDeactivateNow('connected as another account');
  const stash = { ...((await chrome.storage.local.get(ACCT_STASH))[ACCT_STASH] || {}) };
  const mine = stash[id];
  if (mine) {
    await groupsReady();
    let live = [];
    try { live = (await chrome.tabGroups.query({})) || []; } catch { live = []; }
    const label = await deviceLabelNow();
    let back = 0;
    for (const g of mine.groups || []) {
      const hit = live.find((x) => x.id === g.id && x.title === g.title) || live.filter((x) => x.title === g.title).length === 1 && live.find((x) => x.title === g.title);
      if (!hit) continue;
      ownGroups.add(hit.id); back++;
      try { await chrome.tabGroups.update(hit.id, { title: groupTitle(label), color: 'orange' }); } catch { /* gone */ }
    }
    await chrome.storage.local.set({ foxpawRecLibrary: mine.recLibrary || [], foxpawTasks: mine.tasks || [], foxpawTaskTombstones: mine.tombstones || [] });
    await saveCfg({ ...(mine.cfg || {}) });
    delete stash[id];
    await chrome.storage.local.set({ [ACCT_STASH]: stash });
    await saveGroups({ migrated: true });
    await audit(`local data of this account restored: ${back} group(s) authorized again, ${(mine.recLibrary || []).length} recording(s)`);
  }
  await vaultAdoptLocal(id).catch(() => {}); // 1.26 logins saved before connecting join this account
  await chrome.storage.local.set({ [ACCT_KEY]: id });
}
const acctDeactivate = (why) => acctSerial(() => acctDeactivateNow(why));
const acctActivate = (id) => acctSerial(() => acctActivateNow(id));
// The website connect flow's first step (loginStart / switchAccount):
// mint a device grant carrying this browser's install id and stash it
// for loginPoll. switchFrom (1.20): the account being left — the connect
// page warns when the website is still signed in to it.
async function startDeviceLogin(switchFrom) {
  const r = await fetch(RELAY_HTTP + '/auth/device/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Chrome 浏览器', installId: await installId(), ...(switchFrom ? { switchFrom } : {}) }) });
  const j = await r.json();
  if (!j.device_code) throw new Error(j.error || '发起登录失败');
  await chrome.storage.local.set({ foxpawLogin: { device_code: j.device_code, user_code: j.user_code, expires: Date.now() + j.expires_in * 1000 } });
  return { verifyUrl: j.verify_url, userCode: j.user_code };
}
async function audit(line, meta = {}) {
  const { foxpawAudit = [] } = await chrome.storage.local.get('foxpawAudit');
  foxpawAudit.unshift({ ts: new Date().toISOString(), line, ...meta });
  await chrome.storage.local.set({ foxpawAudit: foxpawAudit.slice(0, 300) });
  console.log('[foxpaw]', line);
}
let uiChain = Promise.resolve();
function setUi(patch) {
  // Serialize read-modify-write: concurrent patches (conn / presence /
  // recording / device label) used to race and clobber each other — a stale
  // 'connecting' landing after 'authed' left the side panel stuck on
  // 连接中 while the socket was fine (v1.3.0 bug, fixed in v1.3.1).
  uiChain = uiChain.then(async () => {
    const { foxpawUi = {} } = await chrome.storage.local.get('foxpawUi');
    await chrome.storage.local.set({ foxpawUi: { ...foxpawUi, ...patch } });
  });
  return uiChain;
}
function hostOfUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}
function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/* ---------------- classification (Nanobrowser-style, deterministic) ---------------- */
const CLASS_WORDS = {
  // 1.33.2: subscription / upgrade confirmations are payments too (a 「Subscribe to Project? $30/月」 dialog)
  // (bare 「Subscribe / 订阅 / Upgrade」 are decided by what is around them — a newsletter 订阅 is no payment)
  pay: ['支付', '付款', '下单', '购买', '结算', '充值', 'pay', 'purchase', 'checkout', 'buy now', 'place order', '充值',
    'confirm purchase', 'confirm payment', 'confirm and pay', '开通会员', '升级会员', '续费', '确认购买'],
  delete: ['删除', '注销', '清空', '销毁', 'delete', 'remove', 'destroy', '注销账号'],
  grant: ['授权', '授权并', 'grant', 'authorize', 'allow access'],
  // v1.18.1: 存入 / 入库 / 上架 / 下架 / 创建 / 生成 / generate are writes of the same kind
  // as 保存 / create (「存入仓库」 creates a product) — they were missing, so such clicks ran uncarded
  submit: ['提交', '发布', '发送', '保存', '确认', '发表', 'submit', 'publish', 'send', 'save', 'post', 'confirm', 'create', '提交订单',
    '存入', '入库', '上架', '下架', '创建', '生成', 'generate'],
};
// v1.15: Latin words match on word boundaries (「PayPal 登录」 is not a
// payment, 「Postcode」 is not a post); CJK words match as substrings.
const CLASS_RE = {};
for (const [cat, words] of Object.entries(CLASS_WORDS)) {
  const parts = words.map((w) => {
    const e = w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    return /^[a-z\s]+$/.test(w.toLowerCase()) ? '(?<![a-z])' + e + '(?![a-z])' : e;
  });
  CLASS_RE[cat] = new RegExp(parts.join('|'), 'i');
}
function classifyText(text) {
  const t = String(text || '');
  for (const cat of ['pay', 'grant', 'delete', 'submit']) {
    if (CLASS_RE[cat].test(t)) return cat;
  }
  return 'normal';
}
// 1.33.2 a plain 「Confirm」 / 「确定」 is a payment when the dialog (or card) it sits in is about buying:
// a subscribe / upgrade / purchase word AND a price or a billing period. amount = 「$30/月」 for the card.
const PAY_CTX_WORD = /subscri(be|ption)|upgrade|purchase|payment|checkout|billing|plan|订阅|升级|购买|付款|支付|开通|续费|套餐|会员|扣款/i;
const PAY_PRICE_RE = /(?:[$€£¥￥]|US\$|HK\$)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:元|美元|usd|rmb|cny|eur|\$)/i;
const PAY_PERIOD_RE = /(?:\/|per\s+|a\s+|每)\s?(?:mo(?:nth)?|月|yr|year|年|week|周|wk)\b|\bmonthly\b|\bannual(?:ly)?\b|\byearly\b|按月|按年|包月|包年|月付|年付|自动续费|\brecurring\b|\bbilled\b|\brenews?\b/i;
// a button whose own name says subscribe / upgrade — paid when a price or billing period sits right next to it
const PAY_BTN_NEAR = /subscri|upgrade|订阅|升级|开通|get (pro|plus|premium|started)|choose (this )?plan|select (this )?plan|start (free )?trial/i;
function payContext(text) {
  const t = String(text || '');
  return !!t && PAY_CTX_WORD.test(t) && (PAY_PRICE_RE.test(t) || PAY_PERIOD_RE.test(t));
}
function payAmount(text) {
  const t = String(text || '');
  const m = PAY_PRICE_RE.exec(t);
  if (!m) return /\bmonthly\b|按月|月付|包月|\/\s?mo/i.test(t) ? '按月扣费' : /\bannual|\byearly\b|按年|年付|包年/i.test(t) ? '按年扣费' : '';
  const after = t.slice(m.index + m[0].length, m.index + m[0].length + 24);
  const per = /^\s*(?:\/|per\s+|a\s+|每)\s?(mo(?:nth)?|月|yr|year|年|week|周|wk)/i.exec(after);
  const near = t.slice(Math.max(0, m.index - 40), m.index + 60);
  const unit = per ? per[1] : /\bmonthly\b|按月|月付|包月/i.test(near) ? 'mo' : /\bannual|\byearly\b|按年|年付|包年/i.test(near) ? 'yr' : '';
  const cn = /^(mo|month|月)/i.test(unit) ? '/月' : /^(yr|year|年)/i.test(unit) ? '/年' : /^(week|wk|周)/i.test(unit) ? '/周' : '';
  return (m[0].replace(/\s+/g, '') + cn).slice(0, 24);
}
const URL_BLACKLIST = ['chrome:', 'chrome-extension:', 'javascript:', 'data:', 'file:', 'ws:', 'wss:', 'view-source:', 'about:', 'edge:', 'brave:'];
function urlAllowed(url) {
  const u = String(url || '').toLowerCase();
  return !URL_BLACKLIST.some((p) => u.startsWith(p));
}

/* ---------------- tab group ACL + epochs ---------------- */
const epochs = new Map(); // tabId -> int
function bumpEpoch(tabId) { epochs.set(tabId, (epochs.get(tabId) || 0) + 1); }
/* ---- only THIS browser's groups (v1.16) ----
   Chrome sync copies saved tab groups to every signed-in device, so a
   title is not an identity: two machines each saw two 「FoxPaw」 groups and
   the extension trusted whichever came first. Now the extension records
   the ids of the groups IT created or claimed (storage.local
   foxpawGroups = {ids, migrated}); only tabs in those groups (plus popup
   windows adopted from them, ) are authorized. Titles carry the
   device label (「FoxPaw · 家里-Mac」). A same-titled group that is not on
   record is never authorized — the panel shows one line about it.
   Group ids do not survive a browser restart: on boot a record that no
   longer exists is dropped and the group titled exactly with THIS
   device's label (unique in its window) is re-claimed. Upgrading from
   ≤1.15 claims the single 「FoxPaw」 group of the current window once. */
const GROUPS_KEY = 'foxpawGroups';
const ownGroups = new Set();      // group ids this extension created / claimed
const adopted = new Map();        // popup-window tabId -> opener's group id (popups cannot join a group)
// 1.24 adopted tabs also live in storage.local ({tabId, gid, url, at}) so an extension reload / overwrite
// install (onInstalled reason=update) can restore them; storage.session alone is wiped by a reload. Restored only
// when the tab still exists, is still same-origin, still a popup and its opener group is still ours; a browser
// restart (onStartup — tab ids are new) never restores and drops the record.
const ADOPT_KEY = 'foxpawAdoptedL';
const adoptMeta = new Map();      // tabId -> { url, at }
let adoptStartup = false;         // onStartup fired in this worker → never restore
let groupsLoaded = null;
function groupTitle(label) {
  const l = String(label || '').trim();
  return l ? `${GROUP_TITLE} · ${l.slice(0, 24)}` : GROUP_TITLE;
}
async function deviceLabelNow() {
  try { const { foxpawUi = {} } = await chrome.storage.local.get('foxpawUi'); return foxpawUi.deviceLabel || ''; } catch { return ''; }
}
async function saveGroups(extra = {}) {
  const { [GROUPS_KEY]: prev = {} } = await chrome.storage.local.get(GROUPS_KEY);
  await chrome.storage.local.set({ [GROUPS_KEY]: { ...(prev || {}), ...extra, ids: [...ownGroups] } });
  publishGroupHint();
}
async function saveAdopted() {
  try { if (chrome.storage.session) await chrome.storage.session.set({ foxpawAdopted: [...adopted] }); } catch { /* best effort */ }
  for (const t of [...adoptMeta.keys()]) if (!adopted.has(t)) adoptMeta.delete(t);
  const list = [...adopted].map(([tabId, gid]) => ({ tabId, gid, url: (adoptMeta.get(tabId) || {}).url || '', at: (adoptMeta.get(tabId) || {}).at || Date.now() }));
  try { await chrome.storage.local.set({ [ADOPT_KEY]: list }); } catch { /* best effort */ }
}
function adoptNote(tabId, url) { const m = adoptMeta.get(tabId); adoptMeta.set(tabId, { url: url || (m && m.url) || '', at: (m && m.at) || Date.now() }); }
async function restoreAdopted(why) {
  await groupsReady();
  if (adoptStartup) return 0;
  const { [ADOPT_KEY]: list = [] } = await chrome.storage.local.get(ADOPT_KEY);
  let n = 0, dropped = 0;
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e.tabId !== 'number' || adopted.has(e.tabId)) continue;
    let tab = null, win = null;
    try { tab = await chrome.tabs.get(e.tabId); } catch { tab = null; }
    const u = tab ? (tab.url || tab.pendingUrl || '') : '';
    try { win = tab ? await chrome.windows.get(tab.windowId) : null; } catch { win = null; }
    const ok = tab && /^https?:/i.test(e.url || '') && /^https?:/i.test(u) && originOf(u) === originOf(e.url) && isOwnGroup(e.gid) && !(win && win.type === 'normal');
    if (!ok) { dropped++; continue; }
    adopted.set(e.tabId, e.gid); adoptMeta.set(e.tabId, { url: u, at: e.at || Date.now() }); bumpEpoch(e.tabId); n++;
  }
  await saveAdopted();
  if (n || dropped) audit(`adopted popup tabs after ${why}: ${n} restored, ${dropped} dropped`);
  if (n) { try { sendTabsSync(); } catch { /* not connected */ } }
  return n;
}
async function loadGroups() {
  const st = await chrome.storage.local.get(GROUPS_KEY);
  const rec = st[GROUPS_KEY] || {};
  for (const id of Array.isArray(rec.ids) ? rec.ids : []) ownGroups.add(id);
  try {
    if (chrome.storage.session) {
      const s2 = await chrome.storage.session.get('foxpawAdopted');
      for (const [t, g] of Array.isArray(s2 && s2.foxpawAdopted) ? s2.foxpawAdopted : []) adopted.set(t, g);
    }
    // same extension lifetime (service-worker restart): urls / times come back from the local record
    const { [ADOPT_KEY]: l1 = [] } = await chrome.storage.local.get(ADOPT_KEY);
    for (const e of Array.isArray(l1) ? l1 : []) if (e && adopted.has(e.tabId)) adoptMeta.set(e.tabId, { url: e.url || '', at: e.at || Date.now() });
  } catch { /* no session storage */ }
  let groups = [];
  try { groups = (await chrome.tabGroups.query({})) || []; } catch { groups = []; }
  if (!Array.isArray(groups)) groups = [];
  const live = new Set(groups.map((g) => g.id));
  let changed = false;
  // records that no longer exist (browser restart) -> drop, then re-claim by exact device title
  for (const id of [...ownGroups]) if (!live.has(id)) { ownGroups.delete(id); changed = true; }
  const label = await deviceLabelNow();
  if (label && !ownGroups.size) {
    const want = groupTitle(label);
    const byWin = new Map();
    for (const g of groups) if (g.title === want) byWin.set(g.windowId, [...(byWin.get(g.windowId) || []), g]);
    for (const list of byWin.values()) if (list.length === 1) { ownGroups.add(list[0].id); changed = true; }
  }
  // one-time upgrade from ≤1.15: the single legacy 「FoxPaw」 group of the current window
  if (!rec.migrated) {
    if (!ownGroups.size) {
      let wid = null;
      try { const w = await chrome.windows.getLastFocused(); wid = w && w.id != null ? w.id : null; } catch { /* none */ }
      const legacy = groups.filter((g) => g.title === GROUP_TITLE && (wid == null || g.windowId == null || g.windowId === wid));
      if (legacy.length === 1) {
        ownGroups.add(legacy[0].id);
        if (label) { try { await chrome.tabGroups.update(legacy[0].id, { title: groupTitle(label) }); } catch { /* keep old title */ } }
        audit(`claimed the existing FoxPaw group of this window (upgrade to ${VERSION})`);
      }
    }
    changed = true;
  }
  if (changed) await saveGroups({ migrated: true });
  else publishGroupHint();
}
function groupsReady() { if (!groupsLoaded) groupsLoaded = loadGroups().catch(() => {}); return groupsLoaded; }
function isOwnGroup(gid) { return gid !== undefined && gid !== null && gid !== -1 && ownGroups.has(gid); }
function tabAuthorized(tab) { return !!tab && (isOwnGroup(tab.groupId) || adopted.has(tab.id)); }
// the panel's one-line hint: same-titled groups that are not ours (Chrome sync)
async function publishGroupHint() {
  try {
    let groups = (await chrome.tabGroups.query({})) || [];
    if (!Array.isArray(groups)) groups = [];
    const foreign = groups.filter((g) => String(g.title || '').startsWith(GROUP_TITLE) && !ownGroups.has(g.id)).length;
    await setUi({ ownGroups: [...ownGroups], foreignGroups: foreign });
  } catch { /* noop */ }
}
// our group in this window (create on demand, recorded); returns its id
async function ownGroupInWindow(windowId, create, seedTabId) {
  let groups = [];
  try { groups = (await chrome.tabGroups.query(windowId != null ? { windowId } : {})) || []; } catch { groups = []; }
  if (!Array.isArray(groups)) groups = [];
  const mine = groups.find((g) => ownGroups.has(g.id) && (windowId == null || g.windowId == null || g.windowId === windowId));
  if (mine) return mine.id;
  if (!create) return -1;
  const gid = await chrome.tabs.group({ tabIds: [seedTabId] });
  await chrome.tabGroups.update(gid, { title: groupTitle(await deviceLabelNow()), color: 'orange' });
  ownGroups.add(gid);
  await saveGroups();
  return gid;
}
async function retitleOwnGroups(label) {
  for (const id of ownGroups) { try { await chrome.tabGroups.update(id, { title: groupTitle(label) }); } catch { /* gone */ } }
}
chrome.tabGroups.onRemoved.addListener((g) => { if (g && ownGroups.delete(g.id)) saveGroups(); else publishGroupHint(); });
chrome.tabGroups.onCreated.addListener(() => publishGroupHint());
async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { throw err('TAB_GONE', 'tab no longer exists'); }
}
async function assertControllable(tabId) {
  await groupsReady();
  const tab = await getTab(tabId);
  if (!tabAuthorized(tab)) {
    throw err('TAB_NOT_ASSIGNED', 'tab is not in the FoxPaw group — drag it into the group (or use the side panel button) to authorize it');
  }
  if (!/^https?:\/\//.test(tab.url || '')) throw err('TAB_INELIGIBLE', 'only http/https pages are controllable: ' + tab.url);
  return tab;
}
// closeTab / activateTab: group membership only (any scheme —
// closing a grouped chrome:// tab is fine, closing an ungrouped one never)
async function assertInGroup(tabId) {
  await groupsReady();
  const tab = await getTab(tabId);
  if (!tabAuthorized(tab)) throw err('TAB_NOT_ASSIGNED', 'tab is not in the FoxPaw group — agents can only close or focus authorized tabs');
  return tab;
}
chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) bumpEpoch(d.tabId); });
/* 1.31.0 network-idle: observe-only webRequest (no blocking) counts each tab's requests in flight, so
   scroll / autoScroll do not stop while a slow data request (no loading animation) is still on its way.
   Counted: document / frame / XHR-fetch / script / other. Not counted: images, fonts, styles, media, websocket, ping,
   csp reports; a response that turns out to be a stream (text/event-stream, multipart/x-mixed-replace) leaves the
   count at its headers; anything older than NET_LONG_MS is a long connection (long-poll) and ignored, so a page is
   never "busy forever". The map lives in memory only: a worker restart forgets it (= no data → DOM-only settle). */
const NET_LONG_MS = 10000;
const NET_TYPES = new Set(['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'other']);
const netReqs = new Map();        // tabId -> Map(requestId -> startedAt)
let netReady = false;
function netDone(d) {
  const m = netReqs.get(d.tabId);
  if (m && m.delete(d.requestId) && !m.size) netReqs.delete(d.tabId);
}
// 1.32 (field test 11-05: scroll took 11–13 s on pages with a customer-service widget): chat / analytics hosts and
// requests made inside sub-frames (where such widgets live) are never counted; a cross-site data request counts for
// NET_LONG_3P_MS at most (a widget's long-poll), the page's own for NET_LONG_MS.
const NET_LONG_3P_MS = 2500;
const NET_WIDGET_RE = /(^|\.)(53kf\.com|53kf\.cn|meiqia\.com|udesk\.cn|easemob\.com|tawk\.to|crisp\.chat|intercom\.io|intercomcdn\.com|livechatinc\.com|zopim\.com|zdassets\.com|zendesk\.com|qiyukf\.com|qiyukf\.net|sobot\.com|ntalker\.com|xiaoneng\.cn|live800\.com|talk99\.cn|kuaishang\.cn|looyu\.com|53kf\.net|hm\.baidu\.com|cnzz\.com|umeng\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|clarity\.ms|hotjar\.com|sentry\.io|growingio\.com|sensorsdata\.cn|51\.la|beacon\.qq\.com|aegis\.qq\.com|tongji\.baidu\.com)$/i;
function siteOfHost(h) {
  const p = String(h || '').toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const sl = p[p.length - 2];
  return (p[p.length - 1].length === 2 && /^(com|net|org|gov|edu|co|ac)$/.test(sl) ? p.slice(-3) : p.slice(-2)).join('.');
}
function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }
// since: a cross-site request only counts when it started after `since` (the scroll that may have triggered it) —
// a widget's long-poll that was already open never holds a scroll up
function netInflight(tabId, since) {
  const m = netReqs.get(tabId);
  if (!m) return 0;
  const now = Date.now();
  let n = 0;
  for (const [id, at] of m) {
    const lim = at < 0 ? NET_LONG_3P_MS : NET_LONG_MS;
    if (now - Math.abs(at) >= lim) m.delete(id);
    else if (!(at < 0 && since && -at < since)) n++;
  }
  if (!m.size) netReqs.delete(tabId);
  return n;
}
async function netIdle(tabId, ms, since) {
  const t0 = Date.now();
  while (netInflight(tabId, since) > 0 && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return netInflight(tabId, since) === 0;
}
try {
  if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
    const f = { urls: ['<all_urls>'] };
    chrome.webRequest.onBeforeRequest.addListener((d) => {
      if (d.tabId < 0 || !NET_TYPES.has(d.type)) return;
      if (d.type !== 'main_frame' && d.type !== 'sub_frame' && d.frameId) return;   // inside an iframe (widgets)
      const h = hostOf(d.url);
      if (NET_WIDGET_RE.test(h)) return;
      const third = d.type !== 'main_frame' && d.type !== 'sub_frame' && d.initiator && siteOfHost(hostOf(d.initiator)) !== siteOfHost(h);
      let m = netReqs.get(d.tabId);
      if (!m) { m = new Map(); netReqs.set(d.tabId, m); }
      if (!m.has(d.requestId)) m.set(d.requestId, third ? -Date.now() : Date.now()); // a redirect keeps its requestId and its start; < 0 = cross-site
    }, f);
    chrome.webRequest.onHeadersReceived.addListener((d) => {
      if (d.tabId < 0) return;
      const ct = (d.responseHeaders || []).find((h) => String(h.name).toLowerCase() === 'content-type');
      if (ct && /text\/event-stream|multipart\/x-mixed-replace/i.test(String(ct.value || ''))) netDone(d);
    }, f, ['responseHeaders']);
    chrome.webRequest.onCompleted.addListener(netDone, f);
    chrome.webRequest.onErrorOccurred.addListener(netDone, f);
    netReady = true;
  }
} catch (e) { console.warn('[foxpaw] webRequest unavailable — scroll settles on the DOM only', e); netReady = false; }
chrome.tabs.onRemoved.addListener((tabId) => { netReqs.delete(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { epochs.delete(tabId); focusGen.delete(tabId); focusCache.delete(tabId); if (adopted.delete(tabId)) saveAdopted(); detachDebugger(tabId); if (humanLocks.delete(tabId)) publishHumanLocks(); for (const u of [...userSteps.values()]) if (u.tabId === tabId) clearUserStep(u.id); });
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.url && adopted.has(tabId)) { adoptNote(tabId, info.url); saveAdopted(); } // keep the last known page for the same-origin check
  if (info.groupId !== undefined) {
    bumpEpoch(tabId);
    await groupsReady();
    if (!isOwnGroup(info.groupId) && !adopted.has(tabId)) detachDebugger(tabId);
  }
});

/* ---------------- debugger (on-demand) ---------------- */
const attached = new Set();
async function ensureDebugger(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
}
async function detachDebugger(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}
chrome.debugger.onDetach.addListener((src, reason) => {
  if (src.tabId) attached.delete(src.tabId);
  // 1.21 a detach while recording (the owner cancelled the debugging bar, DevTools took over) is reported
  if (src.tabId && rec && rec.active && recAttached.has(src.tabId)) { recAttached.delete(src.tabId); rec.net = rec.net || { armed: 0, fail: {}, events: 0 }; rec.net.detached = reason || 'detached'; recSave(); }
});
// network events leave the browser without credentials — cookie /
// authorization / token headers and the ExtraInfo cookie lists are cut
// before forwarding (a 只看 agent with Network.enable must not harvest
// sessions from the event stream). Sync, in-memory: no added round trip.
const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$|token|csrf|xsrf|api[-_]?key|secret|session|signature/i;
function scrubHeaders(h) {
  if (!h || typeof h !== 'object') return h;
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADER.test(k) ? '•••' : v;
  return out;
}
function scrubCdpEvent(method, params) {
  if (!params || !/^(Network|Fetch)\./.test(method)) return params;
  const p = { ...params };
  if (p.headers) p.headers = scrubHeaders(p.headers);
  if (p.request && p.request.headers) p.request = { ...p.request, headers: scrubHeaders(p.request.headers) };
  if (p.response && p.response.headers) p.response = { ...p.response, headers: scrubHeaders(p.response.headers), requestHeaders: p.response.requestHeaders ? scrubHeaders(p.response.requestHeaders) : undefined };
  if (p.redirectResponse && p.redirectResponse.headers) p.redirectResponse = { ...p.redirectResponse, headers: scrubHeaders(p.redirectResponse.headers) };
  if (p.responseHeaders) p.responseHeaders = Array.isArray(p.responseHeaders) ? p.responseHeaders.map((x) => (x && SECRET_HEADER.test(x.name || '') ? { ...x, value: '•••' } : x)) : scrubHeaders(p.responseHeaders);
  delete p.associatedCookies; delete p.blockedCookies; delete p.exemptedCookies; delete p.cookiePartitionKey;
  if (p.headersText) p.headersText = String(p.headersText).replace(/^((?:cookie|set-cookie|authorization)[^:]*:).*$/gim, '$1 •••');
  return p;
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId && cdpReadBusy.has(source.tabId) && /^Target\./.test(method)) { const q = cdpReadEvents.get(source.tabId); if (q) q.push({ method, params }); return; } // 1.30 frame read
  if (source.tabId && rec && rec.active) recCaptureNetwork(source.tabId, method, params);
  if (!source.tabId || accessNow === 'off' || !wsOpen()) return;
  wsSend({ type: 'cdpEvent', tabId: source.tabId, method, params: scrubCdpEvent(method, params) });
});

/* ---------------- recorder (v1.2): actions + network, local only ----------------
   The user demonstrates once; we capture three aligned layers — UI actions
   (injected listeners), network traffic (CDP Network domain), navigations —
   into a local session bundle that an agent later distills into a recipe or
   a standalone script. Secrets never enter the bundle: password values are
   masked, cookie/auth headers are dropped, sensitive body fields redacted.
   Raw recordings live only in this browser's local storage. */
let rec = null;
const recAttached = new Set();
const recNet = new Map();
const REC_KEY = 'foxpawRecording';
const REC_MAX_STEPS = 800;
const REC_MAX_REQUESTS = 400;

function recRedact(s) {
  return String(s ?? '').replace(/((?:password|passwd|pwd|token|secret|otp|captcha|api[-_]?key|auth)[^=:\s]{0,24}\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&",}]+)/gi, '$1"•••"');
}
function recCleanHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (/^(cookie|authorization|set-cookie|proxy-authorization)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
/* cloud copy = redacted copy. The raw recording stays in this
   browser (library + export 完整版); recording.sync and the panel's
   「脱敏版」 export both go through recRedactBundle:
   - input values of sensitive fields (password incl. after 显示密码,
     one-time codes, phone, ID, card) -> •••
   - URL query/fragment params named like code/ticket/token/session/... -> •••
   - request headers: Authorization/Cookie/X-*-Token/CSRF/... dropped
   - request bodies and response bodies are not uploaded: only length,
     MIME type and (JSON / form) top-level key names remain
   - steps observed on tabs outside the FoxPaw group are dropped. */
const REC_SECRET_PARAM = /^(code|auth_?code|ticket|st|token|access_token|id_token|refresh_token|session|sessionid|sid|sig|signature|sign|key|api_?key|secret|password|pwd|otp|captcha|state_token|jwt|t)$|token|secret|passw/i;
function recRedactUrl(url) {
  try {
    const u = new URL(String(url));
    for (const k of [...u.searchParams.keys()]) if (REC_SECRET_PARAM.test(k)) u.searchParams.set(k, '•••');
    if (u.hash && u.hash.includes('=')) {
      const hp = new URLSearchParams(u.hash.slice(1));
      for (const k of [...hp.keys()]) if (REC_SECRET_PARAM.test(k)) hp.set(k, '•••');
      u.hash = hp.toString();
    }
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    return u.toString().replace(/%E2%80%A2%E2%80%A2%E2%80%A2/g, '•••');
  } catch { return url === undefined ? undefined : String(url || '').replace(/([?&#](?:code|ticket|token|access_token|id_token)=)[^&#]*/gi, '$1•••'); }
}
function recFieldSensitive(e) {
  if (!e) return false;
  const hint = [e.name, e.nameAttr, e.id, e.placeholder, e.ariaLabel, e.label, e.autocomplete].filter(Boolean).join(' ');
  return e.type === 'password' || e.wasPassword === true || e.type === 'tel' || e.type === 'email'
    || /current-password|new-password|one-time-code|cc-|tel/.test(String(e.autocomplete || ''))
    || /^username$/.test(String(e.autocomplete || '')) // 1.17: login names are PII in the cloud copy too
    || /password|passwd|pwd|otp|auth[-_]?code|sms|captcha|验证码|校验码|动态码|手机|电话|phone|mobile|身份证|id[-_]?card|证件|银行卡|card|cvv|cvc|user.?name|account|账号|用户名/i.test(hint);
}
function recBodyShape(body) {
  if (body === undefined || body === null) return undefined;
  const str = String(body);
  let keys;
  try { const j = JSON.parse(str); if (j && typeof j === 'object' && !Array.isArray(j)) keys = Object.keys(j).slice(0, 40); } catch {
    if (/^[\w.%-]+=/.test(str)) keys = [...new URLSearchParams(str).keys()].slice(0, 40);
  }
  return { len: str.length, keys };
}
function recRedactBundle(b) {
  const out = { ...b, redacted: true };
  const typed = FF && FF.typedValues ? FF.typedValues(b.steps) : []; // 1.29.1 typed values never ride in a storage key name
  out.steps = (b.steps || []).filter((st) => !st.outOfGroup).map((st) => {
    const x = { ...st };
    if (x.kind === 'storage' && FF && FF.maskStorageKeys) for (const area of ['local', 'cookie']) if (x[area] && typeof x[area] === 'object') { const d = {}; for (const k of ['added', 'removed', 'changed']) d[k] = FF.maskStorageKeys(x[area][k], typed); x[area] = d; }
    if (x.url) x.url = recRedactUrl(x.url);
    if ((x.kind === 'input' || x.kind === 'fill') && (x.secret || recFieldSensitive(x.el) || x.value === '•••')) x.value = '•••';
    if (x.el && x.el.text && (x.kind === 'input' || x.kind === 'fill')) x.el = { ...x.el, text: undefined };
    if (x.frame && x.frame.url) x.frame = { ...x.frame, url: recRedactUrl(x.frame.url) };
    if (x.from && x.from.url) x.from = { ...x.from, url: recRedactUrl(x.from.url) };
    return x;
  });
  out.requests = (b.requests || []).filter((r) => !r.outOfGroup).map((r) => {
    const x = { ts: r.ts, tabId: r.tabId, method: r.method, url: recRedactUrl(r.url), type: r.type, status: r.status, mime: r.mime, redirect: r.redirect, error: r.error };
    const h = {};
    for (const [k, v] of Object.entries(r.headers || {})) if (!SECRET_HEADER.test(k)) h[k] = /^(referer|origin)$/i.test(k) ? recRedactUrl(v) : v;
    x.headers = h;
    // 录制 2.0: bodies keep their STRUCTURE with every value replaced by its type (<str:N> <url> <num>
    // <bool>); short business status fields (code / message / status …) keep their text
    if (r.postData !== undefined) { const sh = recBodyShape(r.postData); x.postData = { ...sh, shape: FF && FF.maskBody ? FF.maskBody(r.postData, '', 3000, true) : undefined }; }
    if (r.responseBody !== undefined) { const sh = recBodyShape(r.responseBody); x.responseBody = { len: sh.len, keys: sh.keys, mime: r.mime || '', shape: FF && FF.maskBody ? FF.maskBody(r.responseBody, r.mime || '', 6000) : undefined }; }
    if (r.respHeaders) x.respHeaders = { 'content-type': r.respHeaders['content-type'] || '' };
    if (r.poll) x.poll = r.poll;
    return x;
  });
  if (FF && FF.foldRequests) out.requests = FF.foldRequests(out.requests.filter((r) => !FF.isStaticRequest(r)));
  if (out.startTab && out.startTab.url) out.startTab = { ...out.startTab, url: recRedactUrl(out.startTab.url) };
  return out;
}
// #17: steps are appended in memory; storage is written at most every 400 ms
// (and at once on start/stop); a failed write is shown in the panel.
let recSaveTimer = null;
async function recSaveNow() {
  clearTimeout(recSaveTimer); recSaveTimer = null;
  if (!rec) return;
  try { await chrome.storage.local.set({ [REC_KEY]: rec }); } catch (e) { await setUi({ recSaveError: String((e && e.message) || e).slice(0, 120) }); }
}
function recSave() { if (!recSaveTimer) recSaveTimer = setTimeout(() => { recSaveTimer = null; recSaveNow(); recPublish(); }, 400); }
async function recPublish() {
  const live = rec ? rec.steps.filter((x) => !x.deleted).length : 0;
  await setUi({ recording: rec ? { active: rec.active, name: rec.name, startedAt: rec.startedAt, steps: rec.steps.length, live, requests: rec.requests.length, startTab: rec.startTab || null, scope: rec.scope || 0,
    // IA v1 (/ ): who records (owner / an agent), paused (owner pause or an agent's login pause), the
    // live step list for the recording screen (summaries only: secret values are never here), the save page
    source: rec.source || 'human', agentId: rec.agentId || '', agentLabel: rec.agentLabel || '', goal: rec.goal || '',
    paused: rec.paused || null, pauseHost: rec.pauseHost || '', pauseTab: rec.pauseTab == null ? null : rec.pauseTab, pausedAt: rec.pausedAt || 0,
    pendingSave: !!rec.pendingSave, autoName: rec.autoName || '', localId: rec.id, stoppedAt: rec.stoppedAt || null,
    stepsList: recStepsView(rec), vars: rec.flow ? recVarsView(rec.flow) : [], flowSteps: rec.flow ? rec.flow.steps.length : 0,
    flowSummary: rec.flow && FF && FF.stepList ? recFlowSummary(rec.flow) : [],
    // 1.21 (/ ): the recording SESSION (its tabs and why each joined), new tabs waiting for 加入 / 不加,
    // and why the network layer may be empty (instead of a silent 0)
    session: (rec.session || []).map((x) => ({ tabId: x.tabId, url: recShortUrl(x.url), why: x.why })), ask: (rec.ask || []).slice(0, 3),
    netNote: rec.pendingSave ? (rec.requests.length ? '' : (rec.netNoteFinal || '')) : recNetNote(rec) } : null });
  if (rec && rec.source === 'agent') { try { wsSend({ type: 'rec.state', steps: live, paused: rec.paused || null, agentId: rec.agentId }); } catch { /* offline */ } }
}
// one line per raw step for the recording screen: what was done, where, and whether it can become a variable
function recStepView(x, i) {
  const el = x.el || {};
  const nm = String(el.name || el.label || el.placeholder || el.text || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const host = (() => { try { return new URL(x.url || '').host; } catch { return ''; } })();
  let text = '', sub = '';
  switch (x.kind) {
    case 'navigate': text = `打开「${String(x.title || host || x.url || '').slice(0, 40)}」`; sub = String(x.url || '').replace(/^https?:\/\//, '').split('?')[0].slice(0, 60); break;
    case 'click': text = `点击「${nm || '元素'}」`; sub = [el.role === 'textbox' || el.tag === 'INPUT' ? '输入框' : el.role === 'button' || el.tag === 'BUTTON' ? '按钮' : el.role || '', el.nth ? `第 ${el.nth + 1} 个` : ''].filter(Boolean).join(' · '); break;
    case 'fill': case 'input': text = x.secret ? `输入${x.secret === 'otp' ? '验证码' : '密码'}（不记录）` : `输入「${String(x.value == null ? '' : x.value).slice(0, 30)}」`; sub = nm; break;
    case 'select': text = `选择「${String(x.value == null ? '' : x.value).slice(0, 24)}」`; sub = nm ? nm + ' · 下拉框' : '下拉框'; break;
    case 'check': text = `${x.checked ? '勾选' : '取消勾选'}「${nm || '选项'}」`; break;
    case 'press': text = `按 ${x.key || '键'}`; sub = nm; break;
    case 'scroll': text = '滚动页面'; break;
    case 'tabOpened': text = x.popup ? '打开了弹窗' : '打开了新标签'; sub = host; break;
    case 'tabClosed': text = '关闭标签'; break;
    case 'captcha': text = `出现人机校验${x.vendor ? '（' + x.vendor + '）' : ''}`; sub = '回放到这里停下，交给你'; break;
    case 'copy': text = '复制了内容'; sub = x.from ? '来自接口字段 ' + String(x.from.path || '').slice(0, 30) + ' → 流程输出' : '来自页面元素 → 流程输出'; break;
    default: text = x.kind || '步骤';
  }
  const canVar = (x.kind === 'fill' || x.kind === 'input' || x.kind === 'select') && !x.secret;
  return { i, text, sub, canVar, varName: x.varName || '', kind: x.kind };
}
function recStepsView(r) {
  const out = [];
  r.steps.forEach((x, i) => { if (!x.deleted && !['scroll', 'tabClosed', 'ui', 'storage'].includes(x.kind) && !(x.kind === 'navigate' && x.cause && x.cause !== 'typed' && i > 0)) out.push(recStepView(x, i)); });
  return out.slice(-60);
}
function recVarsView(flow) {
  return Object.entries((flow && flow.vars) || {}).map(([k, v]) => ({ name: k, label: v.label || k, kind: v.kind, secret: !!v.secret, sample: v.sample || '' }));
}
// save page 「步骤」 summary in plain words (stepList gives the raw step objects, never strings)
function recFlowSummary(flow) {
  const vars = (flow && flow.vars) || {};
  const val = (v) => (v && typeof v === 'object' && v.var ? `{${(vars[v.var] && vars[v.var].label) || v.var}}` : `「${String(v == null ? '' : v).slice(0, 20)}」`);
  const tg = (t) => { t = t || {}; return t.name || t.label || t.placeholder || t.text || t.testId || '元素'; };
  const one = (s) => {
    switch (s && s.type) {
      case 'navigate': { let u = s.url || ''; try { u = new URL(u).host; } catch { /* keep */ } return `打开 ${u}`; }
      case 'click': return `点击「${tg(s.target)}」`;
      case 'fill': return `输入 ${val(s.value)}`;
      case 'select': return `选择 ${val(s.value)}`;
      case 'check': return `${s.checked ? '勾选' : '取消勾选'}「${tg(s.target)}」`;
      case 'press': return `按 ${[...(s.mods || []), s.key].join('+')}`;
      case 'upload': return '上传文件';
      case 'wait': return '等待页面';
      case 'assert': return '确认结果';
      case 'extract': return '提取数据';
      case 'paginate': return '逐页处理';
      case 'userStep': return s.reason === 'captcha' ? '人机校验：停下交给你' : '停下等你亲手完成';
      case 'waitInput': return `等外部输入 {${(vars[s.var] && vars[s.var].label) || s.var}}`;
      case 'output': return `输出 ${s.name}`;
      default: return String((s && s.type) || '步骤');
    }
  };
  try { return FF.stepList(flow).slice(0, 40).map((x) => one(x).slice(0, 60)); } catch { return []; }
}
// 「站点·动作」 auto name: site from the start page title / host, action from the first page or button
function recAutoName(r) {
  const t = (r.startTab && r.startTab.title) || '';
  const parts = t.split(/\s*[-|·—_–]\s*/).map((x) => x.trim()).filter(Boolean);
  let host = '';
  try { host = new URL((r.startTab && r.startTab.url) || (r.steps.find((x) => x.url) || {}).url || '').host.replace(/^www\./, ''); } catch { /* none */ }
  const site = parts.length > 1 ? parts[parts.length - 1] : (host || parts[0] || '网页');
  let action = parts.length > 1 ? parts[0] : '';
  if (!action) {
    const c = r.steps.filter((x) => !x.deleted && x.kind === 'click' && x.el && (x.el.name || x.el.text)).pop();
    action = c ? String(c.el.name || c.el.text).trim().slice(0, 12) : (parts[0] && parts[0] !== site ? parts[0] : '录制');
  }
  return `${site.slice(0, 16)} · ${action.slice(0, 16)}`;
}
function recStep(step) {
  if (!rec || !rec.active) return;
  if (rec.paused) return; // paused (owner pause, or an agent recording waiting for the owner to log in) — nothing recorded
  if (rec.steps.length >= REC_MAX_STEPS) { rec.truncated = { ...(rec.truncated || {}), steps: true }; return; }
  rec.steps.push({ ts: Date.now(), ...step });
  recSave();
}
function recPushRequest(entry) {
  if (!rec || !rec.active) return;
  if (rec.requests.length >= REC_MAX_REQUESTS) { rec.truncated = { ...(rec.truncated || {}), requests: true }; return; }
  rec.requests.push(entry);
  recSave();
}
// 录制 2.0: which response field did the owner copy? (raw bodies are in this browser only; the copied
// text is used here in memory and dropped — the step keeps {method, url, path})
function recFindPath(o, t, p, d) {
  if (d > 12 || o === null || o === undefined) return null;
  if (typeof o === 'string' || typeof o === 'number') return String(o).trim() === t ? p : null;
  if (Array.isArray(o)) { for (let i = 0; i < o.length && i < 300; i++) { const r = recFindPath(o[i], t, `${p}[${i}]`, d + 1); if (r !== null) return r; } return null; }
  if (typeof o === 'object') { for (const k of Object.keys(o).slice(0, 300)) { const r = recFindPath(o[k], t, p ? `${p}.${k}` : k, d + 1); if (r !== null) return r; } }
  return null;
}
// the raw (unredacted) JSON body of a recorded response, IN MEMORY ONLY (never stored / synced): what a copy is
// matched against — the stored copy has password / token-like values masked already
const recRawBody = new WeakMap();
function recCopyFrom(text, tabId) {
  const t = String(text || '').trim();
  if (!rec || t.length < 2 || t.length > 2000) return null;
  for (let i = rec.requests.length - 1; i >= 0; i--) {
    const r = rec.requests[i];
    const body = r ? (recRawBody.get(r) || r.responseBody) : null;
    if (typeof body !== 'string' || (tabId !== undefined && r.tabId !== tabId)) continue;
    let j; try { j = JSON.parse(body); } catch { continue; }
    const path = recFindPath(j, t, '', 0);
    if (path !== null && path !== '') return { method: r.method || 'GET', url: r.url, path, reqTs: r.ts };
  }
  return null;
}
const recCaptchaLast = new Map(); // tabId -> {ts, vendor}
function recCaptchaSeen(tabId, vendor) {
  const now = Date.now(); const prev = recCaptchaLast.get(tabId);
  recCaptchaLast.set(tabId, { ts: now, vendor });
  return !!(prev && now - prev.ts < 20000);
}
function recCaptureNetwork(tabId, method, params) {
  if (!params) return;
  if (method === 'Network.requestWillBeSent') {
    if (rec && rec.net) rec.net.events = (rec.net.events || 0) + 1;
    // 录制 2.0: a request of a human-verification widget = a mark (who: 阿里云 …), never its data
    const cv = FF && FF.captchaVendor ? FF.captchaVendor(params.request && params.request.url) : null;
    if (cv && rec && rec.active && !rec.paused && !recCaptchaSeen(tabId, cv)) recStep({ kind: 'captcha', vendor: cv, via: 'request', host: (() => { try { return new URL(params.request.url).host; } catch { return ''; } })(), tabId });
    // noise: static files (images / scripts / styles / fonts / media) are not recorded by default
    if (FF && FF.isStaticRequest && FF.isStaticRequest({ type: params.type || '', url: params.request && params.request.url })) { if (rec && rec.net) rec.net.staticSkipped = (rec.net.staticSkipped || 0) + 1; return; }
    if (params.redirectResponse) {
      const prev = recNet.get(params.requestId);
      if (prev) {
        recPushRequest({ ...prev, status: params.redirectResponse.status, mime: params.redirectResponse.mimeType, redirect: true });
        recNet.delete(params.requestId);
      }
    }
    recNet.set(params.requestId, {
      ts: Date.now(), tabId, method: params.request.method, url: params.request.url,
      type: params.type || '', postData: params.request.postData ? recRedact(String(params.request.postData).slice(0, 4000)) : undefined,
      headers: recCleanHeaders(params.request.headers),
    });
  } else if (method === 'Network.responseReceived') {
    const e = recNet.get(params.requestId);
    if (e) {
      e.status = params.response.status;
      e.mime = params.response.mimeType;
      const h = recCleanHeaders(params.response.headers);
      e.respHeaders = { 'content-type': h['content-type'] || h['Content-Type'] || '', 'content-length': h['content-length'] || h['Content-Length'] || '' };
    }
  } else if (method === 'Network.loadingFinished') {
    const e = recNet.get(params.requestId);
    recNet.delete(params.requestId);
    if (!e) return;
    const done = (body, truncated, raw) => { const entry = { ...e, responseBody: body, bodyTruncated: truncated || undefined }; if (raw && /json/i.test(e.mime || '') || (raw && /^\s*[[{]/.test(raw))) recRawBody.set(entry, raw.slice(0, 20000)); recPushRequest(entry); };
    if (['XHR', 'Fetch', 'Document'].includes(e.type) && (params.encodedDataLength || 0) < 120000) {
      chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId })
        .then((r) => {
          if (r && typeof r.body === 'string') done(recRedact(r.body.slice(0, 20000)), r.body.length > 20000, r.body);
          else done(undefined);
        })
        .catch(() => done(undefined));
    } else {
      done(undefined);
    }
  } else if (method === 'Network.loadingFailed') {
    const e = recNet.get(params.requestId);
    recNet.delete(params.requestId);
    if (e) recPushRequest({ ...e, error: params.errorText || 'failed' });
  }
}
/* 1.17: the page probe is extension/recorder.js, injected into EVERY
   frame (allFrames) of authorized tabs — registered as a content script at
   document_start while recording (new pages / new tabs / OAuth popups are
   covered from their first event) and executed into pages already open. It
   reports only after foxpaw.rec.hello answered yes for its tab. */
const REC_SCRIPT_ID = 'foxpaw-recorder';
const recOwnAttach = new Set(); // tabs whose debugger the RECORDER attached (#15: never detach an agent's session)
const recTabs = new Set();      // tabs seen in this recording (tabClosed steps)
async function recRegister(on) {
  try { await chrome.scripting.unregisterContentScripts({ ids: [REC_SCRIPT_ID] }); } catch { /* not registered */ }
  if (!on) return;
  try {
    await chrome.scripting.registerContentScripts([{ id: REC_SCRIPT_ID, js: ['recorder.js'], matches: ['http://*/*', 'https://*/*'], allFrames: true, matchOriginAsFallback: true, runAt: 'document_start', persistAcrossSessions: false }]);
  } catch (e) { console.warn('[foxpaw] recorder registration failed', e); }
}
async function recArmTab(tabId, why) {
  recTabs.add(tabId);
  recSessionAdd(tabId, why);
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['recorder.js'] }); } catch { /* ineligible page */ }
  const net = rec ? (rec.net = rec.net || { armed: 0, fail: {}, events: 0 }) : null;
  try {
    const mine = !attached.has(tabId);
    try { await ensureDebugger(tabId); } catch (e) {
      // 1.21 the debugger is busy (DevTools open on this tab, another extension, or a stale session after a
      // service-worker restart). A stale session of OURS is reattached; anything else is reported, not swallowed.
      if (/already attached/i.test(String(e && e.message))) { try { await chrome.debugger.detach({ tabId }); } catch { /* not ours */ } await ensureDebugger(tabId); }
      else throw e;
    }
    if (mine) recOwnAttach.add(tabId);
    recAttached.add(tabId);
    try { await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}); } catch (e) {
      // our bookkeeping said attached but Chrome had dropped the session (a detach event lost across a
      // service-worker restart): attach again instead of silently recording 0 requests
      if (!/not attached/i.test(String(e && e.message))) throw e;
      attached.delete(tabId);
      await ensureDebugger(tabId);
      recOwnAttach.add(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    }
    if (net) { net.armed = recAttached.size; delete net.fail[tabId]; }
  } catch (e) {
    if (net) { net.fail[tabId] = String((e && e.message) || e).slice(0, 160); recSave(); }
  }
}
// ---- 1.21: the recording follows its SESSION, not only the group ----
// registrable domain (eTLD+1) without a public-suffix list: last two labels, last three under a known
// two-part suffix (co.uk, com.cn …); IPs and single labels stay whole
const REC_SLD2 = /^(com|net|org|gov|edu|ac|co|or|ne|go)\.(cn|uk|jp|kr|au|nz|hk|tw|in|br|sg|my|za|id|th|tr|mx)$/;
function recSiteOf(url) {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase(); } catch { return ''; }
  if (!h || /^\d+(\.\d+){3}$/.test(h) || h.includes(':') || !h.includes('.')) return h;
  const p = h.split('.');
  const two = p.slice(-2).join('.');
  return REC_SLD2.test(two) && p.length >= 3 ? p.slice(-3).join('.') : two;
}
function recShortUrl(u) { try { const x = new URL(u); return (x.host + x.pathname).replace(/\/$/, '').slice(0, 80); } catch { return String(u || '').slice(0, 80); } }
function recSessionAdd(tabId, why) {
  if (!rec || !rec.active) return;
  rec.session = rec.session || [];
  const have = rec.session.find((x) => x.tabId === tabId);
  if (have) { if (why && (have.why === 'group' || have.why === 'chat') && why !== have.why) have.why = why; return; }
  rec.session.push({ tabId, url: '', why: why || 'group' });
  if (rec.session.length > 30) rec.session = rec.session.slice(-30);
  chrome.tabs.get(tabId).then((t) => { const x = rec && rec.session && rec.session.find((y) => y.tabId === tabId); if (x && t) { x.url = t.url || t.pendingUrl || ''; recSave(); } }).catch(() => {});
}
function recSessionSites() {
  const out = new Set();
  for (const x of (rec && rec.session) || []) { if (x.why === 'chat') continue; const st = recSiteOf(x.url); if (st) out.add(st); }
  if (rec && rec.startTab && rec.startTab.url) { const st = recSiteOf(rec.startTab.url); if (st) out.add(st); }
  return out;
}
const recNewTabs = new Set();     // tabs created while recording that did not join through an opener (decided on their first URL)
const recAskedNo = new Set();     // tabs the owner said 「不加」 for
async function recConsiderTab(tabId, url) {
  if (!rec || !rec.active || !recNewTabs.has(tabId) || !/^https?:/i.test(url || '')) return;
  recNewTabs.delete(tabId);
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  await groupsReady();
  if (tabAuthorized(tab) || recTabs.has(tabId)) return;              // joined already (opener adoption, FoxPaw's own tab)
  const c = await cfg();
  if (siteRule(c, originOf(url)) === 'block') return;
  if (recSessionSites().has(recSiteOf(url))) {
    try { await groupTab(tabId); } catch { return; }
    await recOnTabOpened(tabId, null, url, false, 'site');
    await audit(`recording: a new tab on the same site joined (${recSiteOf(url)})`);
    return;
  }
  if (recAskedNo.has(tabId)) return;
  rec.ask = (rec.ask || []).filter((x) => x.tabId !== tabId).concat([{ tabId, url: recShortUrl(url), host: (() => { try { return new URL(url).host; } catch { return ''; } })() }]).slice(-3);
  recSave(); recPublish();
}
async function recJoinAnswer(tabId, join) {
  if (!rec || !rec.active) return { ok: false, error: '没有在录制' };
  const ask = (rec.ask || []).find((x) => x.tabId === tabId);
  rec.ask = (rec.ask || []).filter((x) => x.tabId !== tabId);
  if (!join) { recAskedNo.add(tabId); recSave(); await recPublish(); return { ok: true }; }
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { recSave(); await recPublish(); return { ok: false, error: '这个标签已经关了' }; }
  try { await groupTab(tabId); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  await recOnTabOpened(tabId, null, tab.url || (ask && ask.url) || '', false, 'asked');
  await recPublish();
  return { ok: true };
}
// why the network layer is empty, in words — '' while requests are coming in
function recNetNote(r) {
  if (!r || (r.requests || []).length) return '';
  const n = r.net || {};
  const fails = Object.values(n.fail || {});
  if (fails.length) {
    const f = fails[0];
    return /already attached|another debugger/i.test(f) ? '网络请求没录上：这个标签的调试器被占用了（开着开发者工具 F12，或别的扩展在用调试器）。关掉后在侧栏点「暂停」再「继续」重新接上。'
      : /Cannot access|cannot attach|chrome:\/\/|chrome-extension|webstore/i.test(f) ? '网络请求没录上：这个页面不允许扩展调试（浏览器内置页 / 应用商店 / 受企业策略限制）。'
        : '网络请求没录上：调试器没接上（' + f.slice(0, 60) + '）。';
  }
  if (n.detached === 'canceled_by_user') return '网络请求停了：录制中点了浏览器顶部「正在调试此浏览器」提示条上的「取消」。在侧栏点「暂停」再「继续」重新接上。';
  if (n.detached) return '网络请求停了：调试器被断开（' + n.detached + '）。在侧栏点「暂停」再「继续」重新接上。';
  if (!n.events && (r.steps || []).length) return '还没有网络请求：页面在录制前就加载完了，或这几步没有发出请求（刷新页面或继续操作会出现）。';
  return '';
}

async function recBroadcast(on) {
  for (const tabId of [...recTabs]) { try { await chrome.tabs.sendMessage(tabId, { type: 'foxpaw.rec.state', on }); } catch { /* no probe there */ } }
}
// 1.33.2: the tab the owner talks to the agent in (a chat page in the group) is not part of the flow.
// opts.skipTabId = that tab: never armed, its steps / navigations dropped, listed as 「与 Agent 对话 · 不录」;
// the owner can still add it (foxpaw.rec.unskip), and an agent recording that operates it adds it itself.
function recSkipped(tabId) { return !!(rec && Array.isArray(rec.skip) && rec.skip.includes(tabId)); }
const agentLastTab = new Map(); // agentId -> the group tab it last read / operated (this browser, this SW life)
async function recStart(name, source = 'human', startTab = null, agent = null, opts = {}) {
  const t = await listTabs();
  let startTabId = agent && agent.tabId != null ? agent.tabId : opts.startTabId != null ? opts.startTabId : null;
  if (startTabId === null) { try { const [at] = await chrome.tabs.query({ active: true, currentWindow: true }); if (at && t.assigned.some((x) => x.id === at.id)) startTabId = at.id; } catch { /* noop */ } }
  if (startTabId === null && t.assigned.length) startTabId = t.assigned[0].id;
  rec = { active: true, id: 'rec' + Date.now(), name: name || '', source, startTab, startTabId, scope: t.assigned.length, startedAt: new Date().toISOString(), steps: [], requests: [], truncated: {},
    ...(agent ? { agentId: agent.agentId || '', agentLabel: agent.agentLabel || '', goal: agent.goal || '', task: agent.task || '', loginPauses: 0 } : {}) };
  rec.session = []; rec.ask = []; rec.net = { armed: 0, fail: {}, events: 0 };
  rec.skip = opts.skipTabId != null && opts.skipTabId !== startTabId && t.assigned.some((x) => x.id === opts.skipTabId) ? [opts.skipTabId] : [];
  recNet.clear(); recTabs.clear(); recNewTabs.clear(); recAskedNo.clear();
  await recSaveNow(); await recPublish();
  await recRegister(true);
  if (startTabId != null && t.assigned.some((x) => x.id === startTabId)) await recArmTab(startTabId, 'start');
  for (const tab of t.assigned) if (tab.id !== startTabId) { if (recSkipped(tab.id)) recSessionAdd(tab.id, 'chat'); else await recArmTab(tab.id, 'group'); }
  await audit(`recording started: ${rec.name} (${t.assigned.length - rec.skip.length} tab(s) armed${rec.skip.length ? ', the chat tab left out' : ''})`);
}
async function recStop() {
  if (!rec) return null;
  rec.active = false;
  rec.paused = null;
  rec.stoppedAt = new Date().toISOString();
  await recRegister(false);
  await recBroadcast(false);
  for (const tabId of [...recAttached]) {
    if (!recOwnAttach.has(tabId)) continue; // an agent's debugger session: leave it (and its Network domain) alone
    try { await chrome.debugger.sendCommand({ tabId }, 'Network.disable', {}); } catch { /* noop */ }
    await detachDebugger(tabId);
  }
  recAttached.clear(); recOwnAttach.clear(); recTabs.clear(); recNewTabs.clear();
  recNet.clear();
  // the semantic flow is built once, at stop, from the raw local steps
  if (!rec.name) rec.autoName = recAutoName(rec);
  let flow = null;
  try { if (FF) flow = FF.fromRecording({ ...rec, name: rec.name || rec.autoName }); } catch (e) { console.warn('[foxpaw] flow conversion failed', e); }
  if (flow) rec.flow = flow;
  // IA v1: the owner's recording waits on the save page; it is ALREADY kept as a draft (来源 我录的)
  // so closing the panel loses nothing. An agent's recording goes back to the relay as its draft.
  if (rec.source !== 'agent') rec.pendingSave = true;
  await recSaveNow(); await recPublish();
  rec.ask = [];
  rec.netNoteFinal = recNetNote(rec) || (rec.requests.length ? '' : '这次录制没有网络请求。');
  const result = { flow: flow && FF ? FF.redactFlow(flow) : null, name: rec.name || rec.autoName, startedAt: rec.startedAt, stoppedAt: rec.stoppedAt, loginPauses: rec.loginPauses || 0, steps: rec.steps.filter((x) => !x.deleted).length,
    requests: rec.requests.length, netNote: rec.requests.length ? '' : rec.netNoteFinal }; // 1.21 the relay counts an agent draft's requests from this
  await recLibraryPut(rec.source === 'agent' ? 'draft' : 'draft');
  if (rec.source !== 'agent') recCloudSync('draft');
  await audit(`recording stopped: ${rec.name || rec.autoName} — ${rec.steps.length} steps, ${rec.requests.length} requests`);
  return result;
}
// 1.20: 断开 / 切换账号 / 被移除 END a recording on this browser — an agent's recording is
// kept locally as a draft marked 「设备断开中止」 (never sent as the agent's draft, never resumed on
// reconnect: rec is gone, so hello carries no recording); with all=true (切换账号) the owner's own
// recording ends too and stays as a draft of the account it was made under.
const REC_ABORT_CN = { signout: '设备断开中止', switch: '切换账号中止', removed: '设备被移除中止' };
async function recEndOnDisconnect(reason, all) {
  // the relay released its lock when this browser left it: drop our copy too, or the footer keeps
  // saying 「录制 · Claude 在录」 while disconnected / removed (1.20 )
  try { await setUi({ recLock: null }); } catch { /* noop */ }
  if (!rec) return false;
  if (rec.source !== 'agent' && !all) return false;
  const who = rec.source === 'agent' ? (rec.agentLabel || 'Agent') : '你';
  if (rec.active) {
    rec.aborted = REC_ABORT_CN[reason] || '设备断开中止';
    clearNotice('fxn-reclogin');
    try { await recStop(); } catch (e) { console.warn('[foxpaw] recStop on disconnect failed', e); }
  }
  rec = null;
  await chrome.storage.local.remove(REC_KEY);
  await recPublish(); refreshAction();
  await audit(`${who}'s recording ended: ${REC_ABORT_CN[reason] || reason} (kept as a local draft, not resumed on reconnect)`);
  return true;
}
// 1.33.2: add a left-out tab to the running recording (the owner's 「也录这个」, or the recording agent operating it)
async function recUnskip(tabId) {
  if (!rec || !rec.active || !recSkipped(tabId)) return false;
  rec.skip = rec.skip.filter((x) => x !== tabId);
  await recArmTab(tabId, 'asked');
  recSave(); await recPublish();
  return true;
}
async function recNoteAgentTab(ctx, tabId) {
  if (!ctx || !ctx.agentId || tabId == null) return;
  agentLastTab.set(ctx.agentId, tabId);
  if (rec && rec.active && rec.source === 'agent' && rec.agentId === ctx.agentId && recSkipped(tabId)) await recUnskip(tabId);
}
async function ownerActiveTabId() {
  try { const [at] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); if (at) return at.id; } catch { /* noop */ }
  try { const [at] = await chrome.tabs.query({ active: true, currentWindow: true }); if (at) return at.id; } catch { /* noop */ }
  return null;
}
// local library entry for this recording (replaced by localId on save / re-stop)
async function recLibraryPut(status) {
  if (!rec) return;
  try {
    const { foxpawRecLibrary = [] } = await chrome.storage.local.get('foxpawRecLibrary');
    const lib = (Array.isArray(foxpawRecLibrary) ? foxpawRecLibrary : []).filter((x) => !(x && x.localId === rec.id));
    lib.unshift({ localId: rec.id, status, name: rec.name || rec.autoName || '未命名录制', source: rec.source || 'human', agentLabel: rec.agentLabel || undefined,
      ...(rec.aborted ? { aborted: rec.aborted } : {}),
      startedAt: rec.startedAt || null, stoppedAt: rec.stoppedAt, steps: rec.steps.filter((x) => !x.deleted), requests: rec.requests,
      ...(rec.flow ? { flow: rec.flow } : {}), ...(rec.gap ? { gap: true } : {}), ...(rec.netNoteFinal && !rec.requests.length ? { netNote: rec.netNoteFinal } : {}) });
    await chrome.storage.local.set({ foxpawRecLibrary: lib.slice(0, 10) });
  } catch (e) { await setUi({ recSaveError: String((e && e.message) || e).slice(0, 120) }); }
}
// the cloud copy (redacted bundle + redacted flow), with its status: draft (unsaved) or active (saved)
function recCloudSync(status) {
  if (!rec) return;
  try {
    const bundle = { name: rec.name || rec.autoName || '未命名录制', source: rec.source || 'human', startedAt: rec.startedAt || null,
      stoppedAt: rec.stoppedAt, steps: rec.steps.filter((x) => !x.deleted), requests: rec.requests };
    const cloud = recRedactBundle(bundle);
    if (rec.netNoteFinal && !rec.requests.length) cloud.netNote = String(rec.netNoteFinal).slice(0, 200); // 1.21 // only the redacted copy leaves this browser
    if (rec.flow && FF) cloud.flow = FF.redactFlow(rec.flow); // 
    cloud.status = status;
    cloud.localId = rec.id;
    if (JSON.stringify(cloud).length < 1_500_000) wsSend({ type: 'recording.sync', recording: cloud });
  } catch { /* sync is best-effort */ }
}
async function recSaveAs(name) {
  if (!rec || !rec.pendingSave) return { ok: false, error: '没有待保存的录制' };
  rec.name = String(name || '').trim().slice(0, 40) || rec.autoName || '未命名流程';
  if (rec.flow) rec.flow = { ...rec.flow, name: rec.name };
  rec.pendingSave = false;
  await recLibraryPut('active');
  recCloudSync('active');
  await audit(`recording saved as flow: ${rec.name}`);
  rec = null;
  await chrome.storage.local.remove(REC_KEY);
  await recPublish();
  return { ok: true };
}
async function recDiscardToDraft() {
  // 放弃 = leave it as a draft (我录的): it stays in the console's 待审阅 (保存 / 删除)
  if (rec && rec.pendingSave) await audit(`recording left as draft: ${rec.autoName || rec.name}`);
  rec = null;
  await chrome.storage.local.remove(REC_KEY);
  await recPublish();
  return { ok: true };
}
async function recContinue() {
  if (!rec || !rec.pendingSave) return { ok: false };
  rec.pendingSave = false; rec.active = true; rec.flow = null; delete rec.stoppedAt;
  await recRegister(true);
  const t = await listTabs();
  for (const tab of t.assigned) await recArmTab(tab.id);
  await recSaveNow(); await recPublish();
  return { ok: true };
}
// an agent recording hit a login (password / code field, by the agent or the owner typing):
// pause; drop the login form steps already recorded on that tab back to its last navigation;
// the owner logs in («去处理»), then «好了，继续»; nothing typed meanwhile is recorded.
function recAgentLoginPause(ctx, tab) {
  if (!rec || !rec.active || rec.source !== 'agent' || rec.paused) return false;
  if (ctx && ctx.agentId && rec.agentId && ctx.agentId !== rec.agentId) return false;
  const tabId = ctx && ctx.tabId != null ? ctx.tabId : (tab && tab.id);
  for (let i = rec.steps.length - 1; i >= 0; i--) {
    const x = rec.steps[i];
    if (x.tabId !== tabId) continue;
    if (x.kind === 'navigate' || x.kind === 'tabOpened') break;
    if (['fill', 'input', 'check', 'select', 'press', 'click'].includes(x.kind)) x.deleted = true;
  }
  rec.paused = 'login';
  rec.pauseTab = tabId == null ? null : tabId;
  rec.pausedAt = Date.now();
  try { rec.pauseHost = new URL((tab && tab.url) || '').host.replace(/^www\./, ''); } catch { rec.pauseHost = ''; }
  rec.loginPauses = (rec.loginPauses || 0) + 1;
  recSave(); recPublish(); refreshAction();
  notifyOwner('fxn-reclogin', `${rec.agentLabel || 'Agent'} 需要你处理`, `录到登录页，需要你登录${rec.pauseHost ? ' ' + rec.pauseHost : ''}（登录不会被录进流程）`, rec.pauseTab);
  audit(`agent recording paused for a login (${rec.pauseHost || 'page'}) — the login is not recorded`, { agent: rec.agentLabel || undefined, agentId: rec.agentId || undefined });
  return true;
}
// a new tab / OAuth popup opened from an authorized tab while recording
async function recOnTabOpened(tabId, openerTabId, url, popup, why) {
  if (!rec || !rec.active) return;
  recNewTabs.delete(tabId);
  rec.ask = (rec.ask || []).filter((x) => x.tabId !== tabId);
  recStep({ kind: 'tabOpened', tabId, openerTabId: openerTabId == null ? undefined : openerTabId, url, popup: !!popup });
  await recArmTab(tabId, why || 'opener');
  recPublish();
}
// 1.21 a tab opened while recording that is not adopted through its opener is decided on its first URL
chrome.tabs.onCreated.addListener((tab) => { if (tab && rec && rec.active) { recNewTabs.add(tab.id); setTimeout(() => recNewTabs.delete(tab.id), 120000); const u = tab.pendingUrl || tab.url; if (/^https?:/i.test(u || '')) setTimeout(() => recConsiderTab(tab.id, u), 400); } });
chrome.tabs.onRemoved.addListener((tabId) => { recNewTabs.delete(tabId); if (rec && rec.ask && rec.ask.some((x) => x.tabId === tabId)) { rec.ask = rec.ask.filter((x) => x.tabId !== tabId); recSave(); } });
// navigation layer: webNavigation knows WHY a page changed (typed / link / form / redirect)
const REC_TYPED = /^(typed|auto_bookmark|generated|keyword|keyword_generated|start_page)$/;
async function recOnNavigate(d, spa) {
  if (!rec || !rec.active || d.frameId !== 0 || !/^https?:/.test(d.url || '')) return;
  let tab;
  try { tab = await chrome.tabs.get(d.tabId); } catch { return; }
  await groupsReady();
  if (!tabAuthorized(tab)) return; // nothing about tabs outside the group is recorded at all
  if (recSkipped(d.tabId)) return; // 1.33.2 the owner's chat-with-the-agent tab
  const q = d.transitionQualifiers || [];
  let cause = 'link';
  if (q.includes('from_address_bar') || REC_TYPED.test(d.transitionType || '')) cause = 'typed';
  else if (d.transitionType === 'reload') cause = 'reload';
  else if (q.includes('client_redirect') || q.includes('server_redirect')) cause = 'redirect';
  else if (d.transitionType === 'form_submit') cause = 'form';
  const navKey = d.tabId + '|' + d.url;
  if (navKey === recLastNav) return;
  recLastNav = navKey;
  recStep({ kind: 'navigate', tabId: d.tabId, url: d.url, cause: spa ? 'spa' : cause });
}
try {
  chrome.webNavigation.onCommitted.addListener((d) => { recOnNavigate(d, false); });
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => { recOnNavigate(d, true); });
} catch { /* mocks */ }
chrome.tabs.onRemoved.addListener((tabId) => { if (rec && rec.active && recTabs.has(tabId)) { recTabs.delete(tabId); recStep({ kind: 'tabClosed', tabId }); } });
// SW restart while recording (#19): re-register the probe, re-arm the group, mark the gap
(async () => {
  const { [REC_KEY]: saved } = await chrome.storage.local.get(REC_KEY);
  if (saved) {
    rec = saved;
    if (rec.active) {
      rec.gap = true;
      try { await groupsReady(); await recRegister(true); const t = await listTabs(); for (const tab of t.assigned) await recArmTab(tab.id); } catch { /* best effort */ }
      recSaveNow();
    }
    recPublish();
  }
})();

/* ---------------- tab inventory sync (for the CDP bridge) ---------------- */
let syncTimer = null;
function sendTabsSync() {
  if (!wsOpen()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const t = await listTabs();
      wsSend({ type: 'tabs.sync', assigned: t.assigned.map((x) => ({ id: x.id, title: x.title, url: x.url, active: x.active })) });
    } catch { /* noop */ }
  }, 250);
}
chrome.tabs.onCreated.addListener(sendTabsSync);
chrome.tabs.onRemoved.addListener(sendTabsSync);
let recLastNav = '';
chrome.tabs.onUpdated.addListener(async (id, info) => {
  if (info.groupId !== undefined || info.url || info.title || info.status === 'complete') sendTabsSync();
  if (info.url && recNewTabs.has(id)) setTimeout(() => recConsiderTab(id, info.url), 250);
  if (rec && rec.active && info.status === 'complete') {
    // pages that loaded before the probe was registered (or SW restarts): arm idempotently
    try {
      const tab = await chrome.tabs.get(id);
      if (tabAuthorized(tab)) await recArmTab(id);
    } catch { /* noop */ }
  }
});
chrome.tabGroups.onCreated.addListener(sendTabsSync);
chrome.tabGroups.onUpdated.addListener(sendTabsSync);
chrome.tabGroups.onRemoved.addListener(sendTabsSync);

/* ---------------- confirmation / ask manager ---------------- */
const pendingConfirms = new Map(); // id -> {resolve, meta}
const pendingAsks = new Map();     // id -> {resolve, meta}
let seqCounter = 0;
async function publishPending() {
  await setUi({
    pendingConfirms: [...pendingConfirms.values()].map((p) => p.meta),
    pendingAsks: [...pendingAsks.values()].map((p) => p.meta),
  });
  refreshAction();
}
/* v2.4: confirmations are mirrored to the relay, so the owner can also
   decide from the console. The panel stays the fastest path; a console
   decision applies only while the confirm is still pending here. */
function relayApprovalOpen(id, meta) {
  try {
    wsSend({ type: 'approval.open', id, agent: meta.agent || '', agentId: meta.agentId || '', ttlMs: meta.ttlMs || CONFIRM_TTL_MS,
             verb: meta.category || '', host: meta.host || '', title: meta.title || '', ...(meta.task ? { task: meta.task } : {}), ...(meta.amount ? { amount: String(meta.amount).slice(0, 24) } : {}) });
  } catch { /* offline: panel-only, as before */ }
}
function relayApprovalReport(id, decision, extra) {
  try { wsSend({ type: 'approval.report', id, decision, ...(extra || {}) }); } catch { /* noop */ }
}

/* ---------------- human tab locks + needs badge ----------------
   humanLocks: tabId -> {agent, since} — the tabs the browser owner has
   taken back for personal use （让开）. In-memory only (a lock describes
   this live session; the tab closing drops it — see tabs.onRemoved above).
   While a tab is locked, runCommand refuses EVERY agent command aimed at
   it: in front of a human lock all agents are equal. The roster's pending
   needs are counted into the toolbar badge alongside confirms/asks;
   rosterNeeds is refreshed by the presence handler. */
const humanLocks = new Map();
let rosterNeeds = 0;
function humanLocksList() {
  return [...humanLocks].map(([tabId, v]) => ({ tabId, agent: v.agent, agentId: v.agentId || '', since: v.since }));
}
async function publishHumanLocks() { await setUi({ humanLocks: humanLocksList() }); }

/* ---------------- cloud tasks mirror (v1.12, ) ----------------
   foxpawTasks in chrome.storage.local is the relay's mirror plus an offline
   cache. Cloud ids start with "tk"; older local ids ride along as legacy_id
   until the relay assigns a cloud id. Local edits are marked pending and
   reconciled via task.snapshot after every hello; conflicts resolve to the
   relay's version and the relay logs the overwrite (never silent, ). */
const RUN_STATUS_CN = { queued: '排队中', claimed: '已接单', running: '运行中', succeeded: '成功', failed: '失败', stopped: '已停下', cancelled: '已取消', undelivered: '未送达', expired: '已过期', missed: '已错过' };
const RUN_CODE_CN = { STEP_MISMATCH: '步骤对不上', RECORDING_GONE: '录制已删除', TAB_GONE: '标签页已关闭', DEVICE_OFFLINE: '设备离线', NO_AGENT: '没有可用的 Agent', AGENT_TIMEOUT: 'Agent 超时未回', DEVICE_LOST: '设备失联', USER_STOPPED: '被停下', REDLINE: '碰到红线', BUDGET: '步数预算用完', APPROVAL_EXPIRED: '审批已过期', RELAY_RESTART: '中继重启', AGENT_ERROR: 'Agent 出错' };
const RUN_FINAL = ['succeeded', 'failed', 'stopped', 'cancelled', 'undelivered', 'expired', 'missed'];
async function loadLocalTasks() {
  const { foxpawTasks = [] } = await chrome.storage.local.get('foxpawTasks');
  return Array.isArray(foxpawTasks) ? foxpawTasks : [];
}
async function storeLocalTasks(tasks) { await chrome.storage.local.set({ foxpawTasks: tasks }); }
function isCloudId(id) { return typeof id === 'string' && id.startsWith('tk'); }
function runToLocal(run) {
  return {
    status: RUN_STATUS_CN[run.status] || run.status,
    detail: run.note || RUN_CODE_CN[run.result_code] || '',
    at: ((run.finished_at || run.updated || run.created || 0) * 1000) || Date.now(),
    runId: run.id,
  };
}
function cloudToMirror(v, prev) {
  const m = {
    id: v.id, legacy_id: v.legacy_local_id || (prev && prev.legacy_id) || null,
    name: v.name, mode: v.mode, enabled: v.enabled !== false,
    executor: v.executor_label || (prev && prev.executor) || '',
    executor_agent_id: v.executor_agent_id || null,
    recordingName: v.recording_name || '', recording_id: v.recording_id || null,
    recording_unlinked: !!v.recording_unlinked,
    goal: v.goal || '', redlines: Array.isArray(v.redlines) ? v.redlines : [],
    budget_max_steps: v.budget_max_steps || null,
    schedule: v.schedule || null,
    scheduleText: v.schedule ? (v.schedule.cron + ' · ' + (v.schedule.tz || '')) : '',
    source: v.source || 'panel', rev: v.rev || 1,
    createdAt: (v.created || 0) * 1000 || Date.now(),
    lastRun: prev ? (prev.lastRun || null) : null,
    runHistory: prev ? (prev.runHistory || []) : [],
    pending: false,
  };
  if (v.last_run_status && !(prev && prev.lastRun && prev.lastRun.runId)) {
    m.lastRun = { status: RUN_STATUS_CN[v.last_run_status] || v.last_run_status,
                  detail: m.lastRun ? m.lastRun.detail : '', at: m.lastRun ? m.lastRun.at : Date.now() };
  }
  return m;
}
function mirrorToWire(t) {
  const w = { name: t.name, mode: t.mode || 'replay', enabled: t.enabled !== false,
              executor_agent_id: t.executor_agent_id || null,
              executor_label: t.executor_agent_id ? '' : (t.executor || ''),
              recording_id: t.recording_id || null, recording_name: t.recordingName || '',
              goal: t.goal || '', redlines: t.redlines || [],
              budget_max_steps: t.budget_max_steps || null,
              schedule: t.schedule || null, rev: t.rev };
  if (isCloudId(t.id)) w.id = t.id; else w.legacy_id = t.legacy_id || t.id;
  return w;
}
async function sendTaskSnapshot() {
  const tasks = await loadLocalTasks();
  const { foxpawTaskTombstones = [] } = await chrome.storage.local.get('foxpawTaskTombstones');
  const items = tasks.map((t) => {
    const w = mirrorToWire(t);
    if (t.pending) w.pending = true;
    if (!isCloudId(t.id)) {
      const hist = [t.lastRun, ...(t.runHistory || [])].filter(Boolean)
        .map((h) => ({ status: h.status, detail: h.detail, at: h.at }));
      if (hist.length) w.history = hist;
    }
    return w;
  });
  if (wsSend({ type: 'task.snapshot', tasks: items, deleted: foxpawTaskTombstones.map((x) => x.id) })) {
    if (foxpawTaskTombstones.length) await chrome.storage.local.set({ foxpawTaskTombstones: [] });
  }
}
async function applyTaskState(views) {
  const local = await loadLocalTasks();
  const byKey = new Map();
  for (const t of local) { byKey.set(t.id, t); if (t.legacy_id) byKey.set(t.legacy_id, t); }
  const next = (views || []).map((v) => cloudToMirror(v, byKey.get(v.id) || byKey.get(v.legacy_local_id)));
  for (const t of local) {
    if (t.pending && !next.some((n) => n.id === t.id || (t.legacy_id && n.legacy_id === t.legacy_id))) next.push(t);
  }
  await storeLocalTasks(next);
}
async function applyRunUpdate(run) {
  const tasks = await loadLocalTasks();
  const t = tasks.find((x) => x.id === run.task_id || x.cloudId === run.task_id);
  if (!t) { await onTraceRun(run); return; }
  const lr = runToLocal(run);
  t.lastRun = lr;
  if (RUN_FINAL.includes(run.status)) {
    t.runHistory = [lr, ...(t.runHistory || []).filter((h) => h.runId !== run.id)].slice(0, 5);
  }
  await storeLocalTasks(tasks);
  await audit(`task ${t.name}: ${lr.status}${lr.detail ? ' — ' + lr.detail : ''}`);
  await onTraceRun(run, t.name);
}

// 代录: a run whose task asked for a trace (record_trace) auto-starts
// the recorder when it begins and files the bundle as an agent recording
// when it ends. A human recording already in progress is never hijacked —
// the run is skipped (audited) and that recording captures what it sees.
let traceRun = null;
async function onTraceRun(run, taskName) {
  if (!run || !run.record_trace) return;
  if (run.status === 'running') {
    if (traceRun) return;
    if (rec && rec.active) {
      traceRun = { runId: run.id, skipped: true };
      await audit(`trace skipped for run ${run.id}: a recording is already active`);
      return;
    }
    traceRun = { runId: run.id, skipped: false };
    await recStart('代录：' + (taskName || run.task_name || '任务'), 'agent');
  } else if (RUN_FINAL.includes(run.status) && traceRun && traceRun.runId === run.id) {
    const skipped = traceRun.skipped;
    traceRun = null;
    if (!skipped && rec && rec.active && rec.source === 'agent') await recStop();
  }
}

function resolveConfirmFromRelay(msg) {
  const p = pendingConfirms.get(msg.id);
  if (!p) return; // already decided locally or timed out — local truth stands
  pendingConfirms.delete(msg.id);
  p.resolve({ approved: msg.decision === 'approved', via: 'console' });
  publishPending();
  audit(`confirm ${msg.decision === 'approved' ? 'APPROVED' : 'REJECTED'} (console): ${p.meta.title}`);
}
// card ids are unguessable (128-bit random), so nothing but the
// owner's own channels (this panel, or the console relayed as
// approval.decision — which an agent frame can no longer impersonate)
// can name one. Cards are signed with the command's OWN agent.
function randomId(prefix) {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return prefix + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// the card lives CONFIRM_TTL_MS; the relay is told (cmd.pending) and
// waits at least that long, so a card can never outlive the command.
function announcePending(ctx, ttlMs) {
  if (ctx && ctx.seq !== undefined && !ctx.local) wsSend({ type: 'cmd.pending', seq: ctx.seq, ttlMs });
}
// tests shorten the card lifetime through the worker global (a page can never reach it)
function confirmTtl() { return (typeof self !== 'undefined' && Number(self.__fpTestConfirmTtl)) || CONFIRM_TTL_MS; }
function waitConfirm(meta, ctx, timeoutMs = confirmTtl()) {
  const id = randomId('c');
  const who = { agent: (ctx && ctx.agentLabel) || meta.agent || '', agentId: (ctx && ctx.agentId) || '' };
  if (ctx) { if (ctx.cancelled) return Promise.resolve({ approved: false, cancelled: true }); ctx.confirmIds.add(id); }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingConfirms.delete(id); clearNotice('fxn-' + id); publishPending(); relayApprovalReport(id, 'expired'); resolve({ approved: false, timeout: true }); }, timeoutMs);
    pendingConfirms.set(id, { meta: { id, ...meta, ...who, expiresAt: Date.now() + timeoutMs, openedAt: Date.now() }, resolve: (v) => { clearTimeout(timer); clearNotice('fxn-' + id); if (ctx) ctx.confirmIds.delete(id); resolve(v); } });
    publishPending();
    // a card waiting for approval is announced like a USER_STEP (system notice only with the permission)
    notifyOwner('fxn-' + id, `${who.agent || 'Agent'} 等你批准`, `${meta.title || meta.category || ''}${meta.host ? ' · ' + meta.host : ''}`, ctx && ctx.tabId != null ? ctx.tabId : null);
    announcePending(ctx, timeoutMs);
    relayApprovalOpen(id, { ...meta, ...who, ttlMs: timeoutMs });
  });
}
function waitAsk(meta, ctx, timeoutMs = 300000) {
  const id = randomId('q');
  if (ctx) { if (ctx.cancelled) return Promise.resolve({ answer: null, cancelled: true }); ctx.confirmIds.add(id); }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingAsks.delete(id); publishPending(); resolve({ answer: null, timeout: true }); }, timeoutMs);
    pendingAsks.set(id, { meta: { id, ...meta }, resolve: (v) => { clearTimeout(timer); if (ctx) ctx.confirmIds.delete(id); resolve(v); } });
    publishPending();
    announcePending(ctx, timeoutMs);
  });
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'foxpaw.focus') { // focus watcher in a page frame
      if (sender && sender.tab && sender.tab.id != null) bumpFocus(sender.tab.id);
      return { ok: true };
    }
    if (msg.type === 'foxpaw.confirm') {
      const p = pendingConfirms.get(msg.id);
      if (p) {
        pendingConfirms.delete(msg.id);
        if (msg.approved && msg.remember && p.meta.basis) {
          const c = await cfg();
          if (!c.remembered.includes(p.meta.basis)) await saveCfg({ remembered: [...c.remembered, p.meta.basis] });
        }
        p.resolve({ approved: !!msg.approved, stop: !msg.approved && msg.stop === true });
        // / the window box (only offered on windowable cards) and an approved OTP card
        // become grants AT THE RELAY; the panel never creates a grant by itself
        const extra = {};
        if (msg.approved && msg.window && p.meta.windowable) extra.window = msg.window === 'task' ? 'task' : true; // 1.25 'task' = 「这次都放行」
        if (msg.approved && p.meta.otp) extra.grant = 'otp';
        relayApprovalReport(msg.id, msg.approved ? 'approved' : 'denied', extra);
        await publishPending();
        await audit(`confirm ${msg.approved ? 'APPROVED' : msg.stop ? 'STOPPED' : 'REJECTED'}${msg.window && p.meta.windowable ? (msg.window === 'task' ? ' + this task (这次都放行)' : ' + 5-min window') : ''}: ${p.meta.title}`);
      }
      sendResponse({ ok: true });
    } else if (msg.type === 'foxpaw.answerAsk') {
      const p = pendingAsks.get(msg.id);
      if (p) { pendingAsks.delete(msg.id); p.resolve({ answer: msg.answer || '' }); await publishPending(); }
      sendResponse({ ok: true });
    } else if (msg.type === 'foxpaw.assignCurrent') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { sendResponse({ ok: false, error: 'no active tab' }); return; }
      const gid = await groupTab(tab.id);
      await audit(`tab assigned to FoxPaw group: ${tab.title || tab.url}`);
      sendResponse({ ok: true, groupId: gid });
    } else if (msg.type === 'foxpaw.setAccess') {
      // 1.27: only 全部暂停 ('off') / 恢复 ('write') — an old 只看 request means no browser-level limit
      if (!ACCESS.includes(msg.access)) throw new Error('bad access');
      const v = msg.access === 'off' ? 'off' : 'write';
      const before = (await cfg()).access;
      await saveCfg({ access: v });
      if (before !== v) await audit(v === 'off' ? 'pause all (全部暂停)' : 'resumed (全部暂停 off)');
      return { ok: true, access: v };
    } else if (msg.type === 'foxpaw.agentAccess') {
      // 1.27: the agent row menu — this agent's permission, written to the relay (= console 「权限」)
      if (!msg.agentId || !ACCESS.includes(msg.access)) return { ok: false, error: 'BAD_ARGS' };
      const r = await panelAsk({ type: 'agent.access', agentId: String(msg.agentId), access: msg.access });
      await audit(`agent permission from the panel: ${msg.agent || msg.agentId} -> ${msg.access}${r.ok ? '' : ' (' + r.error + ')'}`);
      if (r.ok) agentLiveSet(String(msg.agentId), { access: msg.access, accessNow: msg.access });
      return r;
    } else if (msg.type === 'foxpaw.agentRename') {
      // 1.31.2: the agent row menu 「改名」 — written to the relay (= console Agent 详情「名称」)
      const label = String(msg.label || '').trim().slice(0, 40);
      if (!msg.agentId || !label) return { ok: false, error: 'BAD_ARGS' };
      const r = await panelAsk({ type: 'agent.rename', agentId: String(msg.agentId), label });
      await audit(`agent renamed from the panel: ${msg.agent || msg.agentId} -> ${label}${r.ok ? '' : ' (' + r.error + ')'}`);
      return r;
    } else if (msg.type === 'foxpaw.agentAvatar') {
      // 1.31.2: 换头像 / 恢复默认头像 from the row menu — the panel already cropped it to a 128 px PNG; the relay re-checks
      if (!msg.agentId || (!msg.reset && typeof msg.image !== 'string')) return { ok: false, error: 'BAD_ARGS' };
      const r = await panelAsk(msg.reset ? { type: 'agent.avatar', agentId: String(msg.agentId), reset: true }
        : { type: 'agent.avatar', agentId: String(msg.agentId), image: msg.image }, 10000);
      await audit(`agent avatar from the panel: ${msg.agent || msg.agentId} -> ${msg.reset ? 'default' : 'new image'}${r.ok ? '' : ' (' + r.error + ')'}`);
      return r;
    } else if (msg.type === 'foxpaw.agentTrust') {
      // 1.27: 不信任 / 信任当前网站（授权标签的主域，累加）/ 信任全部网站 (the panel asked to confirm)
      if (!msg.agentId) return { ok: false, error: 'BAD_ARGS' };
      const mode = msg.mode;
      let r;
      if (mode === 'none') r = await panelAsk({ type: 'trust.revoke', agentId: String(msg.agentId) });
      else if (mode === 'all') r = await panelAsk({ type: 'trust.set', agentId: String(msg.agentId), mode: 'all', confirm: msg.confirm === true });
      else if (mode === 'site') {
        const site = await authorizedSite(msg.tabId);
        if (!site) return { ok: false, error: 'NO_AUTH_TAB' };
        r = await panelAsk({ type: 'trust.set', agentId: String(msg.agentId), mode: 'site', site });
        r.site = site;
      } else return { ok: false, error: 'BAD_MODE' };
      await audit(`agent trust from the panel: ${msg.agent || msg.agentId} -> ${mode}${r.site ? ' ' + r.site : ''}${r.ok ? '' : ' (' + r.error + ')'}`);
      return r;
    } else if (msg.type === 'foxpaw.setSensitive') {
      await saveCfg({ sensitive: msg.value === 'rules' ? 'rules' : 'ask' });
      return { ok: true };
    } else if (msg.type === 'foxpaw.setRule') {
      const c = await cfg();
      const rules = { ...c.siteRules };
      if (msg.rule) rules[msg.origin] = msg.rule === 'deny' ? 'block' : msg.rule; else delete rules[msg.origin];
      await saveCfg({ siteRules: rules });
      return { ok: true };
    } else if (msg.type === 'foxpaw.kick') {
      if (wsSend({ type: 'kickCdp', agent: msg.agent || undefined, agentId: msg.agentId || undefined })) {
        await audit(`kicked CDP sessions from this device: ${msg.agent || '(all agents)'}`);
      }
      return { ok: true };
    } else if (msg.type === 'foxpaw.holdTab') {
      // 让开: the owner takes this tab back for personal use. Agents
      // are refused in runCommand until foxpaw.releaseTab （还给它）.
      const tabId = Number(msg.tabId);
      if (!Number.isFinite(tabId)) return { ok: false, error: 'bad tabId' };
      humanLocks.set(tabId, { agent: String(msg.agent || ''), agentId: String(msg.agentId || ''), since: Date.now() });
      await publishHumanLocks();
      await audit(`tab held by owner: ${tabId}${msg.agent ? ` (${msg.agent} yields)` : ''}`);
      return { ok: true };
    } else if (msg.type === 'foxpaw.userStepGo') {
      // 去处理: jump to the tab that needs the owner (the card stays until 处理好了)
      const u = userSteps.get(String(msg.id));
      if (!u) return { ok: false, error: 'gone' };
      return { ok: await focusTab(u.tabId) };
    } else if (msg.type === 'foxpaw.userStepDone') {
      const u = userSteps.get(String(msg.id));
      if (u) await audit(`owner handled a step for ${u.agent || 'agent'}: ${USER_REASON_CN[u.reason] || u.reason}${u.what ? ' ' + u.what : ''}`);
      return { ok: clearUserStep(String(msg.id)) };
    } else if (msg.type === 'foxpaw.releaseTab') {
      const tabId = Number(msg.tabId);
      if (humanLocks.delete(tabId)) {
        await publishHumanLocks();
        await audit(`tab released back to agents: ${tabId}`);
      }
      return { ok: true };
    } else if (msg.type === 'foxpaw.vaultCatch') {
      // 1.26 vaultcatch.js saw the owner sign in by hand on a page
      return vaultCatch(msg, sender);
    } else if (/^foxpaw\.vault/.test(msg.type) && sender && sender.tab) {
      return { ok: false, error: 'not from a page' }; // vault management only from the extension's own pages
    } else if (msg.type === 'foxpaw.vaultPut') {
      // 1.26 the owner adds / edits a login in the side panel (password optional on edit = keep)
      try {
        const r = await vaultPut({ id: msg.id || undefined, site: msg.site, user: msg.user, password: msg.password, note: msg.note }, msg.id ? {} : { source: 'owner', label: '' });
        try { wsSend({ type: 'vault.saved', site: r.item.site, user: r.item.user, by: 'owner', replaced: r.replaced }); } catch { /* offline */ }
        await audit(`login ${r.replaced ? 'updated' : 'saved'} in the panel: ${r.item.site} (${maskUser(r.item.user)})`);
        return { ok: true, item: r.item, replaced: r.replaced };
      } catch (e) { return { ok: false, code: e.code, error: String(e.message || e) }; }
    } else if (msg.type === 'foxpaw.vaultRemove') {
      const m = await vaultRemove(String(msg.id || ''));
      if (m) { try { wsSend({ type: 'vault.removed', site: m.site, user: m.user, by: 'panel' }); } catch { /* offline */ } await audit(`login deleted in the panel: ${m.site} (${maskUser(m.user)})`); }
      return { ok: !!m };
    } else if (msg.type === 'foxpaw.vaultReveal') {
      // the owner's eye button: the password goes to the extension's own panel only
      try { return { ok: true, password: await vaultReveal(String(msg.id || '')) }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
    } else if (msg.type === 'foxpaw.vaultOffer') {
      return vaultOfferDecide(msg.tabId, msg.save === true, msg.never === true);
    } else if (msg.type === 'foxpaw.vaultRefresh') {
      return { ok: true, items: await vaultPublish() };
    } else if (msg.type === 'foxpaw.trustRevoke') {
      // 1.25 「⋯ → 撤销信任」 — the relay owns trust; it clears it and stops stamping it at once
      if (!msg.agentId) return { ok: false, error: 'agent required' };
      intentDropAgent(String(msg.agentId)); // 1.29 back to 每次问我 means every intent too
      let sent = false;
      try { sent = wsSend({ type: 'trust.revoke', agentId: String(msg.agentId) }) !== false; } catch { sent = false; }
      await audit(`trust revoked from the panel: ${msg.agent || msg.agentId}${sent ? '' : ' (offline: not delivered)'}`);
      return { ok: sent };
    } else if (msg.type === 'foxpaw.agentPause') {
      // device-level pause （暂停它/恢复 in the card's ⋯ menu): this
      // device refuses the agent entirely; the account-level cap is the
      // console's business and is not touched here.
      // v1.15: keyed by agent ID; a label-only request (old panel
      // state) is stored as 'label:<name>' and migrated on the next roster.
      const c = await cfg();
      const agentPause = { ...(c.agentPause || {}) };
      const key = msg.agentId ? String(msg.agentId) : (msg.agent ? 'label:' + msg.agent : '');
      if (!key) return { ok: false, error: 'agent required' };
      if (msg.paused) { agentPause[key] = true; intentDropAgent(key); }
      else { delete agentPause[key]; if (msg.agent) delete agentPause['label:' + msg.agent]; }
      await saveCfg({ agentPause });
      await audit(`agent ${msg.paused ? 'paused' : 'resumed'} on this device: ${msg.agent || ''} (${key})`);
      return { ok: true, agentPause };
    } else if (msg.type === 'foxpaw.needResolve') {
      // the owner's decision on an agent's foxpaw_need_human call
      // rides the same authenticated socket back to the relay, which
      // completes the waiting tool call and clears the need.
      if (wsSend({ type: 'need_resolve', id: msg.id, action: msg.action })) {
        await audit(`need resolved by owner: ${msg.id} -> ${msg.action}`);
        return { ok: true };
      }
      return { ok: false, error: '还没连上' };
    } else if (msg.type === 'foxpaw.notifyTest') {
      const level = await notifyLevelNow();
      if (level !== 'denied') notifyOwner('fxn-test', 'FoxPaw 测试通知', '能看到这条，说明要你批准时会这样提醒你。', null);
      return { ok: true, level };
    } else if (msg.type === 'foxpaw.checkUpdate') {
      // the silent open-check only asks a relay this browser is paired with (an unpaired panel stays quiet)
      if (msg.silent && !parsePairing((await cfg()).pairing)) return { ok: false, skipped: 'unpaired', current: VERSION };
      return checkUpdateNow(); // 1.24 「检查更新」 / 侧栏打开即静默检查 — reuses /health extLatest, no new relay API
    } else if (msg.type === 'foxpaw.status') {
      refreshWebAccount();
      return connSnapshot();
    } else if (msg.type === 'foxpaw.reconnect') {
      const c = await cfg();
      Conn.attempt = 0;
      if (!c.enabled && c.pairing) await saveCfg({ enabled: true }); // storage listener connects
      else await connStart(true);
      return { ok: true };
    } else if (msg.type === 'foxpaw.setPairing') {
      const v = String(msg.pairing || '').trim();
      if (!parsePairing(v)) throw new Error('连接串格式不对');
      await saveCfg({ pairing: v, enabled: true });
      return { ok: true };
    } else if (msg.type === 'foxpaw.signOut') {
      // 断开这台浏览器 (1.20 ): the relay voids this device's credential first (an old copy of the
      // pairing can no longer connect), an agent recording ends (not resumed later), then the local
      // credentials go. The web session (官网登录) stays; foxpawInstallId is deliberately NOT touched
      // (see installId()); this account's local data stays for the one-click reconnect.
      const c = await cfg();
      const { foxpawUi: u0 = {} } = await chrome.storage.local.get('foxpawUi');
      const did = (Conn.device && Conn.device.id) || u0.deviceId || '';
      await saveCfg({ enabled: false });          // stop reconnecting before the relay drops us
      await recEndOnDisconnect('signout', false);
      const r = await deviceSignout(c.pairing, did, 'signout', false);
      await teardownLocal('signout');
      await audit('signed out on this browser');
      refreshWebAccount(true);
      return { ok: true, revoked: !!r.revoked };
    } else if (msg.type === 'foxpaw.switchAccount') {
      // 切换账号 (→ 1.20 ): void this device's credential AND end the web session through the
      // device-authenticated relay endpoint (the old cookie-only /auth/logout was refused 403), set
      // this account's local data aside (its groups stop being authorized), end any recording, then
      // start the normal connect flow. switchFrom lets the connect page warn if the website is
      // still signed in to the account being left. The old account keeps its 已断开 record.
      const c = await cfg();
      const { foxpawUi: u0 = {} } = await chrome.storage.local.get('foxpawUi');
      const did = (Conn.device && Conn.device.id) || u0.deviceId || '';
      const from = (Conn.account && Conn.account.id) || (u0.account && u0.account.id) || '';
      await saveCfg({ enabled: false });
      await recEndOnDisconnect('switch', true);
      const r = await deviceSignout(c.pairing, did, 'switch', true);
      await acctDeactivate('switch account');
      await teardownLocal('switch');
      await audit('switch account: credential voided + web session ended + local data set aside');
      const out = await startDeviceLogin(from);
      return { ...out, revoked: !!r.revoked, webLogout: !!r.web_logout };
    } else if (msg.type === 'foxpaw.diagnostics') {
      const c = await cfg();
      const st = await chrome.storage.local.get(['foxpawUi', 'foxpawAudit']);
      const ui = { ...(st.foxpawUi || {}) };
      return {
        kind: 'foxpaw-diagnostics', exportedAt: new Date().toISOString(), version: VERSION, ua: navigator.userAgent,
        conn: { ...connSnapshot(), account: Conn.account ? { plan: Conn.account.plan } : null },
        cfg: { enabled: c.enabled, access: c.access, sensitive: c.sensitive, paired: !!c.pairing, pairingHost: (parsePairing(c.pairing) || {}).url ? new URL(parsePairing(c.pairing).url).host : '', siteRules: c.siteRules, remembered: (c.remembered || []).length },
        ui: { deviceLabel: ui.deviceLabel, presence: ui.presence, roster: ui.roster, humanLocks: humanLocksList(), pending: (ui.pendingConfirms || []).length + (ui.pendingAsks || []).length + (Array.isArray(ui.roster) ? ui.roster.reduce((n, a) => n + ((a && a.needs) || []).length, 0) : 0), recording: ui.recording },
        audit: (st.foxpawAudit || []).slice(0, 80),
      };
    } else if (msg.type === 'foxpaw.loginStart') {
      return startDeviceLogin();
    } else if (msg.type === 'foxpaw.loginPoll') {
      const g = (await chrome.storage.local.get('foxpawLogin')).foxpawLogin;
      if (!g) return { status: 'none' };
      if (Date.now() > g.expires) { await chrome.storage.local.remove('foxpawLogin'); return { status: 'expired' }; }
      const r = await fetch(RELAY_HTTP + '/auth/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: g.device_code }) });
      const j = await r.json();
      if (j.status === 'approved') {
        await chrome.storage.local.remove('foxpawLogin');
        await saveCfg({ pairing: j.pairing, enabled: true }); // storage listener connects
        return { status: 'approved', device: j.device };
      }
      // 1.20: 「不是我，取消」 on the connect page ends the wait at once
      if (j.status === 'denied' || j.status === 'expired' || j.status === 'consumed') await chrome.storage.local.remove('foxpawLogin');
      return { status: j.status || 'pending' };
    // v1.17 (relay 3.0 ): connect-code exchange removed — browsers pair
    // only through the device-code flow (foxpaw.login above).
    } else if (msg.type === 'foxpaw.mintInvite') {
      if (!wsOpen()) return { ok: false, error: '还没连上，连上后再接入 Agent' };
      const seq = 'mint-' + Date.now();
      const done = new Promise((resolve) => {
        mintWaiters.set(seq, resolve);
        setTimeout(() => { if (mintWaiters.delete(seq)) resolve(null); }, 10000);
      });
      if (!wsSend({ type: 'mintInvite', label: String(msg.label || '').slice(0, 40), seq })) { mintWaiters.delete(seq); return { ok: false, error: '发送失败，稍后再试' }; }
      const r = await done;
      if (r) return { ok: true, code: r.code, claim: r.claim, guide: r.guide, expires: r.expires };
      return { ok: false, error: '服务器没有回应，稍后再试' };
    // v1.17 (relay 3.0 ): console tickets removed — the panel opens
    // /app#<view> directly; the owner's web session comes from the device
    // approval login in this same browser (or an email-code login).
    } else if (msg.type === 'foxpaw.rec.hello') {
      await groupsReady();
      return { on: !!(rec && rec.active && sender && sender.tab && tabAuthorized(sender.tab) && !recSkipped(sender.tab.id)) };
    } else if (msg.type === 'foxpaw.rec.step') {
      const arrived = Date.now();
      await groupsReady();
      // a step from a tab outside the group is dropped (not stored at all)
      if (!(sender && sender.tab && tabAuthorized(sender.tab))) return { ok: false, dropped: true };
      if (recSkipped(sender.tab.id)) return { ok: false, dropped: true, chat: true }; // 1.33.2 left out: talking to the agent is not the flow
      const st = { ...(msg.step || {}) };
      delete st.outOfGroup;
      // 1.29.1: the step's time = the page's event time (same machine clock), bounded to the last 5 s before it got
      // here — under load the click's message can arrive AFTER the request it set off, which then landed in the
      // previous (fill) step's after-window (e2e-rec2 「没等到请求」). Never later than arrival, never a page's fiction.
      { const pts = Number(st.pts); st.ts = Number.isFinite(pts) && pts <= arrived && pts >= arrived - 5000 ? pts : arrived; delete st.pts; }
      st.tabId = sender.tab.id;
      if (sender.frameId) st.frame = { id: sender.frameId, url: sender.url || st.url || '', top: false };
      if (st.secret) delete st.value; // never stored, whatever a page script claims
      if (st.kind === 'click' && st.el) st.cat = classifyText(st.el.name || st.el.text || '');
      // 录制 2.0: copy / ui / storage / captcha marks — only shapes and names are kept
      if (st.kind === 'copy') {
        const text = String(st.text || ''); delete st.text;
        if (!rec || !rec.active || rec.paused || !text) return { ok: true };
        st.len = text.length;
        const from = recCopyFrom(text, st.tabId);
        if (from) st.from = from; else if (!st.fromElement) return { ok: true }; // a copy from nowhere we can replay
        if (!st.fromElement) delete st.el;
      } else if (st.kind === 'ui') {
        const u = st.ui || {};
        st.ui = { kind: ['dialog', 'toast', 'button'].includes(u.kind) ? u.kind : 'text', text: String(u.text || '').slice(0, 60) };
        delete st.el;
        if (!st.ui.text || (FF && FF.SECRET_HINT && /\d{6,}/.test(st.ui.text) && /码|code/i.test(st.ui.text))) return { ok: true };
      } else if (st.kind === 'storage') {
        const keys = (d) => { const o = {}; for (const k of ['added', 'removed', 'changed']) o[k] = (Array.isArray(d && d[k]) ? d[k] : []).map((x) => String(x).slice(0, 60)).slice(0, 20); return o; };
        st.local = keys(st.local); st.cookie = keys(st.cookie); delete st.el; delete st.value;
      } else if (st.kind === 'captcha') {
        st.vendor = String(st.vendor || '人机校验').slice(0, 20); delete st.el; delete st.value;
        if (recCaptchaSeen(st.tabId, st.vendor)) return { ok: true };
      }
      // an agent's recording reaching a password / code field = a login — pause, drop the form, ask the owner
      if (st.secret && rec && rec.active && rec.source === 'agent' && !rec.paused) { recAgentLoginPause({ agentId: rec.agentId, tabId: st.tabId }, sender.tab); return { ok: true, paused: true }; }
      recStep(st);
      return { ok: true };
    } else if (msg.type === 'foxpaw.rec.start') {
      if ((await cfg()).access === 'off') return { ok: false, error: '已停用：先切到「只看」或「可操作」再录制' };
      if (rec && rec.pendingSave && !rec.active) await recDiscardToDraft(); // an unsaved recording is already a draft (我录的)
      if (rec && rec.active) return { ok: false, error: rec.source === 'agent' ? `${rec.agentLabel || 'Agent'} 正在录制，一台浏览器同时只能有一个录制` : '已经在录制了' };
      let startTab = null, at = null;
      try { [at] = await chrome.tabs.query({ active: true, currentWindow: true }); if (at) startTab = { title: at.title || '', url: at.url || '' }; } catch { /* best-effort */ }
      // 1.33.2: started while an agent's question waits (the agent asked the owner to record) — the flow starts
      // on the group tab that agent last worked on, and the tab the owner is on (where they talk to the agent)
      // is left out, so the reply typed there never becomes a step
      const opts = {};
      const asks = [...pendingAsks.values()].map((p) => p.meta).filter((m) => m && m.agentId);
      const lastAsk = asks[asks.length - 1];
      const aTab = lastAsk ? agentLastTab.get(lastAsk.agentId) : null;
      if (aTab != null && at && aTab !== at.id) {
        try {
          const t2 = await chrome.tabs.get(aTab);
          await groupsReady();
          if (t2 && tabAuthorized(t2)) { opts.startTabId = aTab; opts.skipTabId = at.id; startTab = { title: t2.title || '', url: t2.url || '' }; }
        } catch { /* that tab is gone: start where the owner is */ }
      }
      await recStart(msg.name, 'human', startTab, null, opts);
      return { ok: true, ...(opts.startTabId != null ? { startTabId: opts.startTabId, skipped: [opts.skipTabId] } : {}) };
    } else if (msg.type === 'foxpaw.rec.unskip') {
      return { ok: await recUnskip(Number(msg.tabId)) };
    } else if (msg.type === 'foxpaw.rec.startHere') {
      // group the current tab into the FoxPaw group, then start —
      // the panel's gate card offers this when the start page is out of scope.
      if ((await cfg()).access === 'off') return { ok: false, error: '已停用：先切到「只看」或「可操作」再录制' };
      if (rec && rec.pendingSave && !rec.active) await recDiscardToDraft(); // an unsaved recording is already a draft (我录的)
      if (rec && rec.active) return { ok: false, error: rec.source === 'agent' ? `${rec.agentLabel || 'Agent'} 正在录制，一台浏览器同时只能有一个录制` : '已经在录制了' };
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return { ok: false, error: '找不到当前标签' };
      await groupTab(tab.id);
      await recStart(msg.name, 'human', { title: tab.title || '', url: tab.url || '' });
      return { ok: true };
    } else if (msg.type === 'foxpaw.flow.run') {
      // the owner replays a flow from the panel (library index or a flow object); resume = {runId, from}
      let flow = msg.flow;
      if (!flow && !msg.runId) {
        const { foxpawRecLibrary = [] } = await chrome.storage.local.get('foxpawRecLibrary');
        const x = (foxpawRecLibrary || [])[Number(msg.index) || 0];
        flow = x && (x.flow || (FF ? FF.fromRecording(x) : null));
        if (!flow) return { ok: false, code: 'NO_FLOW', message: '这份录制没有可回放的流程' };
      }
      let tabId = msg.tabId;
      if (tabId === undefined && !msg.runId) {
        const [at] = await chrome.tabs.query({ active: true, currentWindow: true });
        await groupsReady();
        if (!at || !tabAuthorized(at)) return { ok: false, code: 'TAB_NOT_ASSIGNED', message: '先把要回放的标签加进 FoxPaw 组（＋当前页）' };
        tabId = at.id;
      }
      const ctx = newCtx({ kind: 'flowRun', agentLabel: '主人回放', agentId: '', tabId, __local: true });
      ctx.ownerReplay = true;
      try { return await flowExec({ flow, tabId, vars: msg.vars, from: msg.from, runId: msg.runId }, ctx); } catch (e) { return { ok: false, code: e.code || 'ERROR', message: String(e.message || e) }; }
    } else if (msg.type === 'foxpaw.flow.export') {
      // panel 「导出脚本」: Playwright (JS) for a library recording's flow
      const { foxpawRecLibrary = [] } = await chrome.storage.local.get('foxpawRecLibrary');
      const x = (foxpawRecLibrary || [])[Number(msg.index) || 0];
      const flow = x && (x.flow || (FF ? FF.fromRecording(x) : null));
      if (!flow || !FF) return { ok: false, message: '这份录制没有可导出的流程' };
      try { return { ok: true, flow, script: FF.toPlaywright(flow) }; } catch (e) { return { ok: false, message: String(e.message || e) }; }
    } else if (msg.type === 'foxpaw.rec.full') {
      // panel 「导出完整版」 (录制 2.0): the raw local copy, de-noised the same way (static files out, polls folded)
      const b = msg.bundle || {};
      return { ok: true, bundle: { ...b, requests: FF && FF.foldRequests ? FF.foldRequests((b.requests || []).filter((r) => !FF.isStaticRequest(r))) : b.requests } };
    } else if (msg.type === 'foxpaw.rec.redact') {
      // panel 「导出脱敏版」: same redaction as the cloud copy
      return { ok: true, bundle: recRedactBundle(msg.bundle || {}) };
    } else if (msg.type === 'foxpaw.rec.stop') {
      if (rec && rec.source === 'agent') return { ok: false, error: '这是 Agent 的录制：用「让它停下」' };
      await recStop();
      sendResponse({ ok: true });
    } else if (msg.type === 'foxpaw.rec.pause') {
      // IA v1: the owner's 暂停 / 继续 on the recording screen — nothing is recorded while paused
      if (!rec || !rec.active || rec.source === 'agent') return { ok: false };
      rec.paused = msg.paused ? 'owner' : null;
      if (!rec.paused) { // 1.21 继续 re-attaches the network layer of every session tab (after a busy / cancelled debugger)
        if (rec.net) { rec.net.fail = {}; delete rec.net.detached; }
        for (const tabId of [...recTabs]) await recArmTab(tabId);
      }
      await recSaveNow(); await recPublish();
      return { ok: true, paused: rec.paused };
    } else if (msg.type === 'foxpaw.rec.delStep') {
      if (!rec || rec.source === 'agent') return { ok: false };
      const x = rec.steps[Number(msg.i)];
      if (!x) return { ok: false };
      x.deleted = true;
      if (rec.pendingSave && FF) { try { rec.flow = FF.fromRecording({ ...rec, name: rec.name || rec.autoName }); } catch { /* keep */ } }
      await recSaveNow(); await recPublish();
      return { ok: true };
    } else if (msg.type === 'foxpaw.rec.setVar') {
      if (!rec || rec.source === 'agent') return { ok: false };
      const x = rec.steps[Number(msg.i)];
      if (!x || x.secret || !['fill', 'input', 'select'].includes(x.kind)) return { ok: false, error: '这一步不能设为变量' };
      const nm = String(msg.name || '').trim().slice(0, 40);
      if (nm) x.varName = nm; else delete x.varName;
      if (rec.pendingSave && FF) { try { rec.flow = FF.fromRecording({ ...rec, name: rec.name || rec.autoName }); } catch { /* keep */ } }
      await recSaveNow(); await recPublish();
      return { ok: true };
    } else if (msg.type === 'foxpaw.rec.save') {
      return recSaveAs(msg.name);
    } else if (msg.type === 'foxpaw.rec.discard') {
      return recDiscardToDraft();
    } else if (msg.type === 'foxpaw.rec.continue') {
      return recContinue();
    } else if (msg.type === 'foxpaw.rec.loginDone') {
      // 「好了，继续」 on an agent recording's login pause
      if (!rec || rec.source !== 'agent' || rec.paused !== 'login') return { ok: false };
      rec.paused = null; rec.pauseTab = null;
      clearNotice('fxn-reclogin');
      await recSaveNow(); await recPublish(); refreshAction();
      await audit('agent recording resumed after the owner logged in', { agent: rec.agentLabel || undefined, agentId: rec.agentId || undefined });
      return { ok: true };
    } else if (msg.type === 'foxpaw.rec.cancelAgent') {
      // 「让它停下」: the agent's recording ends without a draft
      if (!rec || rec.source !== 'agent') return { ok: false };
      const who = rec.agentLabel;
      rec.cancelled = true;
      clearNotice('fxn-reclogin');
      await recStop();
      rec = null;
      await chrome.storage.local.remove(REC_KEY);
      await recPublish(); refreshAction();
      try { wsSend({ type: 'rec.state', steps: 0, paused: 'cancelled', agentId: '' }); } catch { /* noop */ }
      await audit(`owner stopped ${who}'s recording (no draft)`);
      return { ok: true };
    } else if (msg.type === 'foxpaw.rec.join') {
      // 1.21 「把这个标签加入录制？」 加入 / 不加
      return recJoinAnswer(Number(msg.tabId), !!msg.join);
    } else if (msg.type === 'foxpaw.run.control') {
      // 1.21 the panel's 继续 / 重试 / 跳过 / 终止 on a paused run — the RELAY decides (one state machine with the console)
      const seq = 'rc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const p = new Promise((res) => { runCtlWaiters.set(seq, res); setTimeout(() => { if (runCtlWaiters.delete(seq)) res({ ok: false, error: '中继没有回应' }); }, 8000); });
      try { wsSend({ type: 'run.control', seq, runId: String(msg.runId || ''), action: String(msg.action || ''), ...(msg.action === 'input' ? { value: String(msg.value == null ? '' : msg.value).slice(0, 500) } : {}) }); } catch { runCtlWaiters.delete(seq); return { ok: false, error: '没连上中继' }; }
      const r = await p;
      return { ok: !!r.ok, error: r.error || '' };
    } else if (msg.type === 'foxpaw.window.revoke') {
      // 撤销 on the island: the RELAY revokes (and pushes the new window list)
      try { wsSend({ type: 'window.revoke', id: String(msg.id || '') }); } catch { return { ok: false, error: '没连上中继' }; }
      return { ok: true };
    } else if (msg.type === 'foxpaw.draft.decide') {
      // 收下 / 驳回 / 重录 from the panel: this browser belongs to the owner; the relay applies the state machine
      if (!['accept', 'reject', 'rerecord', 'delete'].includes(msg.action)) return { ok: false };
      try { wsSend({ type: 'draft.decide', id: String(msg.id || ''), action: msg.action }); } catch { return { ok: false, error: '没连上中继' }; }
      return { ok: true };
    } else if (msg.type === 'foxpaw.rec.clear') {
      rec = null;
      await chrome.storage.local.remove(REC_KEY);
      await recPublish();
      sendResponse({ ok: true });
    } else if (msg.type === 'foxpaw.task.run') {
      // v1.12: runs are born at the relay via run.request — no more
      // fire-and-forget broadcast; offline runs stay forbidden on purpose.
      const tasks = await loadLocalTasks();
      const t = tasks.find((x) => x.id === msg.taskId || x.legacy_id === msg.taskId);
      if (!t) return { ok: false, error: '任务不存在' };
      if ((await cfg()).access !== 'write') return { ok: false, error: '当前模式不允许运行任务，切到「可操作」再试' };
      if (!wsOpen()) return { ok: false, error: '还没连上：运行记录由中继保管，离线时不能发起运行' };
      if (!isCloudId(t.id) && !t.cloudId) { // just created locally: sync first so the relay knows it
        wsSend({ type: 'task.sync', task: mirrorToWire(t) });
        await new Promise((r) => setTimeout(r, 700));
      }
      if (!wsSend({ type: 'run.request', task_id: t.cloudId || t.id })) return { ok: false, error: '发送失败，稍后再试' };
      t.lastRun = { status: '排队中', detail: '', at: Date.now() };
      await storeLocalTasks(tasks);
      await audit(`task run requested from panel: ${t.name}`);
      return { ok: true };
    } else if (msg.type === 'foxpaw.task.sync') {
      const tasks = await loadLocalTasks();
      const t = tasks.find((x) => x.id === msg.taskId || x.legacy_id === msg.taskId);
      if (!t) return { ok: false, error: '任务不存在' };
      t.pending = true;
      await storeLocalTasks(tasks);
      if (wsOpen()) wsSend({ type: 'task.sync', task: mirrorToWire(t) });
      return { ok: true };
    } else if (msg.type === 'foxpaw.task.delete') {
      const { foxpawTaskTombstones = [] } = await chrome.storage.local.get('foxpawTaskTombstones');
      foxpawTaskTombstones.push({ id: msg.taskId, at: Date.now() });
      await chrome.storage.local.set({ foxpawTaskTombstones: foxpawTaskTombstones.slice(-50) });
      if (wsOpen()) wsSend({ type: 'task.delete', id: msg.taskId });
      return { ok: true };
    }
  })().then(
    (r) => { if (r !== undefined) { try { sendResponse(r); } catch { /* port already closed */ } } },
    (e) => { try { sendResponse({ __foxErr: String((e && e.message) || e) }); } catch { /* noop */ } }
  );
  return true;
});

/* ================= execution core (v1.15, ) =================
   The extension is the ONLY trust boundary. Every agent command — WS
   envelope, MCP (relayed as the same envelope), raw CDP pass-through,
   recording replay and scheduled tasks (both arrive as CDP) — runs
   through ONE function, execCore():

     1 access    browser mode × the agent's relayed cap (read / write / sensitive)
     2 who       device-level pause (by agent ID) and the owner's tab lock
     3 scope     the tab must be in this browser's FoxPaw group
     4 site      site rule `block` (tab origin and any target URL) + URL scheme
     5 classify  deterministic semantics of THIS action (element's own name,
                 focused field, CDP method) -> category
     6 approve   pay/grant/secret = USER_STEP (never by an agent);
                 delete/submit/unknown/fill/eval/session/upload -> policy,
                 card if needed; after an approval: re-check 2-3 + epoch +
                 relay cancel (an undelivered command never executes later)
     7 run       the action itself
     8 record    audit line

   Latency budget: plain reads, clicks on normal
   elements, navigation, scrolling and screenshots add NO card and NO
   relay round trip. The only new work on a hot path is one local
   executeScript hit-test on a raw-CDP mousePressed / Enter key (a few ms)
   — the same mechanism a ref click already used for its preflight. */

const CONFIRM_TTL_MS = 300000;  // 1.33.2 card lifetime 5 min (was 50 s: too short to answer on a phone); relay waits this + grace (never less) — 
// Session data (cookies, web storage, IndexedDB, Cache Storage) is SENSITIVE:
// never a read; refused in 只看; asks the owner in 可操作. Mirrors the relay's
// CDP_SENSITIVE_RE (the relay keeps the same list).
const CDP_SENSITIVE = /^(Network\.(getAllCookies|getCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies)|Storage\.\w+|DOMStorage\.\w+|IndexedDB\.\w+|CacheStorage\.\w+)$/;
const CDP_COOKIE_EVERY_CALL = /^(Network\.(getAllCookies|getCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies)|Storage\.(getCookies|setCookies|clearCookies))$/;
const SCHEME_OK = /^(https?:)$/;
function urlCheck(url, c) {
  const raw = String(url || '').trim();
  if (!raw || raw === 'about:blank') return 'about:blank';
  let u;
  try { u = new URL(raw); } catch { throw err('URL_NOT_ALLOWED', 'not a valid absolute URL'); }
  if (!SCHEME_OK.test(u.protocol)) throw err('URL_NOT_ALLOWED', 'only http/https URLs: ' + u.protocol);
  if (siteRule(c, u.origin) === 'block') throw err('SITE_BLOCKED', u.origin);
  return u.href;
}

/* ---- per-command context: seq, agent, the relay's cancel ---- */
const cmdCtx = new Map(); // seq -> ctx
function newCtx(msg) {
  return {
    seq: msg.seq, kind: msg.kind, agentId: msg.agentId || '', agentLabel: msg.agentLabel || '',
    agentCap: msg.agentCap || '', tabId: msg.tabId != null ? Number(msg.tabId) : null,
    caps: capsOf(msg),
    // IA v1 (relay 3.1, ): the task this command belongs to + the grants the RELAY decided
    // apply to it (approval windows for this agent+device+task, credential grants). Nothing here can
    // be set by an agent: the relay rebuilds every envelope and strips agent-sent credSource.
    task: typeof msg.task === 'string' ? msg.task.slice(0, 80) : '',
    grants: grantsOf(msg),
    cancelled: false, confirmIds: new Set(), local: !!msg.__local,
  };
}
function grantsOf(msg) {
  const g = msg && msg.grants && typeof msg.grants === 'object' ? msg.grants : {};
  const wins = Array.isArray(g.windows) ? g.windows.filter((w) => w && typeof w.id === 'string' && typeof w.host === 'string' && typeof w.verb === 'string') : [];
  const c = g.creds && typeof g.creds === 'object' ? g.creds : {};
  // 1.25 the agent's standing trust, stamped by the relay (≥3.5) only; absent = ask as before
  const t = g.trust && typeof g.trust === 'object' ? g.trust : null;
  const trust = t && t.mode === 'all' ? { mode: 'all', sites: [] }
    : t && t.mode === 'sites' && Array.isArray(t.sites) ? { mode: 'sites', sites: t.sites.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase()) } : null;
  return { windows: wins, trust: trust && (trust.mode === 'all' || trust.sites.length) ? trust : null,
    creds: { generated: c.generated === true, otp: c.otp === true, testSites: Array.isArray(c.testSites) ? c.testSites.filter((x) => typeof x === 'string') : [] } };
}
// categories a 5-minute window may cover (mirrors the relay's WINDOW_VERBS); pay / grant /
// secret / session / eval / tab / unknown never — and pay / grant / secret are USER_STEP before this
const WINDOW_VERBS = ['submit', 'delete', 'write', 'upload'];
function windowFor(ctx, cat, host) {
  if (!ctx || !ctx.task || !ctx.agentId || !WINDOW_VERBS.includes(cat)) return null;
  const now = Date.now();
  return (ctx.grants && ctx.grants.windows || []).find((w) => w.verb === cat && w.host === host && (!w.until || w.until > now)) || null;
}
/* 1.25 trust (「免审批」): the relay stamps the agent's standing trust (全部网站 / 指定网站, main domain
   incl. sub-domains) and 「这次都放行」 (a once-window: host '*', verb '*', bound to the task). Inside it the
   TRUST_VERBS skip the card and the agent may type its own values into secret boxes (1.29 password / code /
   商品卡密 / captcha characters). Never: pay / grant (USER_STEP before this), payment-class fields (card kind),
   local files (upload: 1.29 takes it out of trust).
   The browser master gate and the agent's cap are checked first (execCore step 1), so 停用 / 只看 /
   全部暂停 / this agent paused on the device always win. A local (owner) command has no trust. */
// 1.29 trust also covers running a script (eval — Playwright / connectOverCDP runs one for nearly every action)
// and an unknown write (a click into an iframe / unnamed widget); neither on a payment page
// …and NOT upload: a file path the agent names is read from the owner's disk — 本机文件 stays a card every time
const TRUST_VERBS = ['submit', 'delete', 'write', 'eval', 'unknown'];
const TRUST_NOT_ON_PAY = ['eval', 'unknown'];
function hostInSites(host, sites) {
  const h = String(host || '').toLowerCase().split(':')[0].replace(/\.$/, '');
  return !!h && (sites || []).some((d) => h === d || h.endsWith('.' + d));
}
function trustScope(ctx, host) {
  if (!ctx || !ctx.agentId || ctx.local) return null;
  const g = ctx.grants || {};
  const t = g.trust;
  if (t && t.mode === 'all') return { id: 'trust', basis: 'trust-all', label: '全部网站' };
  if (t && t.mode === 'sites') {
    const h = String(host || '').toLowerCase().split(':')[0];
    const d = (t.sites || []).find((x) => hostInSites(h, [x]));
    if (d) return { id: 'trust', basis: 'trust-site', label: d + ' 网站' };
  }
  const now = Date.now();
  const once = ctx.task && (g.windows || []).find((w) => w.once === true && w.host === '*' && w.verb === '*' && (!w.until || w.until > now));
  if (once) return { id: once.id, basis: 'once', label: '本次' };
  return null;
}
function trustFor(ctx, cat, host, tab) {
  if (!TRUST_VERBS.includes(cat)) return null;
  if (TRUST_NOT_ON_PAY.includes(cat) && tab && isPayPage(tab.title, tab.url)) return null;
  return trustScope(ctx, host);
}
/* 1.29 「一次操作意图只走一次流程级批准」: an UNTRUSTED agent's approved card covers the same intent —
   this agent + this site + this kind of action — for the rest of its task (no task: 30 minutes after the last use,
   at most 4 hours). Delete / upload / session data / pay / grant / secret are never covered (each one asks).
   Kept in the service worker only (a browser restart asks again); 停用 / 只看 / paused-on-device win first. */
const INTENT_CATS = ['write', 'eval', 'unknown', 'submit', 'stock'];
const INTENT_IDLE_MS = 30 * 60 * 1000;
const INTENT_MAX_MS = 4 * 60 * 60 * 1000;
const intents = new Map(); // key -> {at, last}
function intentKey(ctx, cat, host) {
  if (!ctx || ctx.local || !ctx.agentId || !host || !INTENT_CATS.includes(cat)) return null;
  return `${ctx.agentId}|${host}|${cat}|${ctx.task || ''}`;
}
function intentHas(key) {
  const x = key && intents.get(key);
  if (!x) return false;
  const now = Date.now();
  if (now - x.at > INTENT_MAX_MS || now - x.last > INTENT_IDLE_MS) { intents.delete(key); return false; }
  x.last = now;
  return true;
}
function intentAdd(key) { if (key) { const now = Date.now(); intents.set(key, { at: now, last: now }); } }
function intentDropAgent(agentId) { for (const k of [...intents.keys()]) if (k.startsWith(agentId + '|')) intents.delete(k); }
// a page that is about paying: a password typed here is a payment password, never filled on trust.
// 1.29 the URL decides by path words; the TITLE only by phrases that mean "pay now" — a bare 「支付」 in a
// platform's site-wide title (「…自动发卡平台，支付即发货」) no longer turns its login / goods pages into pay pages.
const PAY_URL_RE = /checkout|cashier|payment|\/pay(\/|\?|#|$)/i;
const PAY_TITLE_RE = /checkout|cashier|payment|收银台|付款|结算|确认支付|立即支付|订单支付|支付订单|扫码支付|去支付|支付中心|支付页/i;
function isPayPage(title, url) { return PAY_URL_RE.test(String(url || '')) || PAY_TITLE_RE.test(String(title || '')); }
// per-agent capabilities stamped by the relay on every command
// envelope. A relay without caps (≤2.8): seeAllTabs=false, rawCdp=true
// (keeps today's Playwright users working). Inside a caps object a missing
// flag is false.
function capsOf(msg) {
  const c = msg && msg.caps;
  if (!c || typeof c !== 'object') return { seeAllTabs: false, rawCdp: true };
  return { seeAllTabs: c.seeAllTabs === true, rawCdp: c.rawCdp === true };
}
function cancelCtx(ctx, why) {
  if (!ctx || ctx.cancelled) return;
  ctx.cancelled = why || 'cancelled';
  for (const id of ctx.confirmIds) {
    const p = pendingConfirms.get(id);
    if (p) { pendingConfirms.delete(id); p.resolve({ approved: false, cancelled: true }); relayApprovalReport(id, 'expired'); }
    const q = pendingAsks.get(id);
    if (q) { pendingAsks.delete(id); q.resolve({ answer: null, cancelled: true }); }
  }
  publishPending();
}
function cancelAllCtx(why) { for (const ctx of cmdCtx.values()) cancelCtx(ctx, why); }

/* ---- element semantics: the element's OWN accessible name ---- */
const SECRET_HINT = /password|passwd|pwd|passcode|otp|one.?time|验证码|校验码|动态码|短信码|sms.?code|verif\w*.?code|auth.?code|captcha|cvv|cvc|security.?code|卡号|card.?(no|num)|pin(code)?\b/i;
function pageElementInfo(sel, secretSrc) {
  const W = window;
  const SECRET_RE = new RegExp(secretSrc || 'password', 'i');
  if (!W.__foxpawPw) W.__foxpawPw = new WeakSet(); // fields ever seen as type=password (isolated world, survives 显示密码)
  for (const p of document.querySelectorAll('input[type="password"]')) W.__foxpawPw.add(p);
  let el = null;
  if (sel && sel.ref) {
    const m = /e(\d+)$/.exec(String(sel.ref));
    const wr = m && W.__fpEngine ? W.__fpEngine.refs.get(Number(m[1])) : null;
    el = (wr && wr.deref()) || document.querySelector('[data-foxpaw-ref="' + String(sel.ref).replace(/["\\]/g, '') + '"]');
  }
  else if (sel && sel.focused) { el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; }
  else if (sel && typeof sel.x === 'number') {
    el = document.elementFromPoint(sel.x, sel.y);
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(sel.x, sel.y); if (!inner || inner === el) break; el = inner; }
  }
  // 1.29 a SAME-ORIGIN iframe (rich editors: UEditor / KindEditor / TinyMCE 4 put a contenteditable body in an
  // about:blank frame) is looked into instead of being an unknown frame — a click into the editor is a field
  for (let i = 0; i < 3 && el && /^(IFRAME|FRAME)$/.test(el.tagName); i++) {
    let d = null;
    try { d = el.contentDocument; } catch { d = null; }
    if (!d || !d.body) break;
    let inner = null;
    if (sel && sel.focused) inner = d.activeElement;
    else if (sel && typeof sel.x === 'number') { const r = el.getBoundingClientRect(); inner = d.elementFromPoint(sel.x - r.left, sel.y - r.top); }
    if (!inner) break;
    if ((inner === d.body || inner === d.documentElement) && !(d.body.isContentEditable || d.designMode === 'on')) return { found: true, empty: true };
    el = inner;
    sel = { ...sel, inner: true };
  }
  if (!el || el === document.body || el === document.documentElement) return { found: !!el, empty: true };
  const tag = el.tagName;
  if (/^(IFRAME|FRAME|EMBED|OBJECT)$/.test(tag)) return { found: true, frame: true, tag };
  const CLICK = 'button,a[href],input,select,textarea,summary,label,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="option"],[onclick]';
  const t = (sel && (sel.focused || sel.ref)) ? el : ((el.closest && el.closest(CLICK)) || el);
  const tx = (v) => String(v || '').trim().replace(/\s+/g, ' ');
  const attr = (n) => (t.getAttribute && t.getAttribute(n)) || '';
  const lab = attr('aria-labelledby') ? attr('aria-labelledby').split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ') : '';
  const type = attr('type').toLowerCase();
  const isInput = t.tagName === 'INPUT';
  const inputBtn = isInput && /^(button|submit|reset|image)$/.test(type);
  const svgT = t.querySelector && t.querySelector('svg title');
  const img = t.querySelector && t.querySelector('img[alt]');
  const name = tx(attr('aria-label')) || tx(lab) || (isInput ? '' : tx(t.innerText || t.textContent)) || (inputBtn ? tx(t.value || attr('alt')) : '')
    || tx(attr('title')) || tx(img && img.getAttribute('alt')) || tx(svgT && svgT.textContent) || tx(attr('data-tooltip') || attr('data-title') || attr('data-original-title'))
    // 1.29 a field's own label / placeholder / name (typedInto tells the agent which box got the keys)
    || (isInput || t.tagName === 'TEXTAREA' ? tx((t.labels && t.labels[0] && (t.labels[0].innerText || t.labels[0].textContent)) || attr('placeholder') || attr('name')) : '');
  const icon = [t, ...(t.querySelectorAll ? t.querySelectorAll('i,svg,span,use,img') : [])].slice(0, 12)
    .map((n) => [n.getAttribute && n.getAttribute('class'), n.getAttribute && (n.getAttribute('href') || n.getAttribute('xlink:href')), n.getAttribute && n.getAttribute('data-icon')].filter(Boolean).join(' ')).join(' ');
  const role = attr('role');
  const buttonish = t.tagName === 'BUTTON' || inputBtn || /^(button|menuitem)$/.test(role);
  const form = t.form || (t.closest && t.closest('form'));
  const field = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
  // 1.29 the field's own name only — a long placeholder is instructions (「…如果存在卡号和密码可自行添加分隔符…」),
  // never a verdict; a multi-line box / rich editor / select is never a password box
  const ph = attr('placeholder');
  const hint = [attr('name'), t.id, ph.length <= 20 ? ph : '', attr('aria-label'), lab, (t.labels && t.labels[0] && t.labels[0].innerText) || ''].join(' ');
  const ac = attr('autocomplete').toLowerCase();
  const keyable = t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|image|file|hidden|range|color)$/.test(type);
  const secret = field && keyable && (type === 'password' || W.__foxpawPw.has(t) || /current-password|new-password|one-time-code|^cc-|\scc-/.test(ac) || SECRET_RE.test(hint));
  let secretKind = '';
  if (secret) {
    const h = hint + ' ' + ac;
    const near = ((t.closest && t.closest('form,[role="dialog"],.el-dialog,.modal,.ant-modal,.layui-layer')) || (t.parentElement && t.parentElement.parentElement) || t).textContent || '';
    const payCtx = /checkout|cashier|payment|\/pay(\/|\?|#|$)/i.test(location.href) || /checkout|cashier|payment|收银台|付款|结算|确认支付|立即支付|订单支付|支付订单|扫码支付|去支付|支付中心|支付页/i.test(document.title || '')
      || /银行|bank|信用卡|credit|debit|储蓄|开户行|持卡人|cardholder/i.test(near.slice(0, 3000));
    if (/(^|\s)cc-|cvv|cvc|cvn|security.?code|银行卡|信用卡|储蓄卡|支付密码|交易密码|付款密码|pay.?pass|payment.?pass|trade.?pass|transaction.?pass|u盾|ukey|安全码/i.test(h)) secretKind = 'card';
    else if (/captcha|人机|图形验证|图片验证|滑块/i.test(h)) secretKind = 'captcha';
    else if (/one-time-code|otp|one.?time|验证码|校验码|动态码|短信码|sms.?code|verif\w*.?code|auth.?code/i.test(h)) secretKind = 'otp';
    else if (/卡号|card.?(no|num)|卡密|激活码|兑换码|充值码|cd.?key|kami|license.?key|序列号/i.test(h)) secretKind = payCtx ? 'card' : 'stock';
    else secretKind = 'password';
  }
  // pure navigation (same rule as the page engine's classInfo): a same-site link, or a
  // link / menu item / tab inside a navigation container, not in a form and not a submit button
  const submitType = !!(form && (t.type === 'submit' || t.type === 'image') && /^(BUTTON|INPUT)$/.test(t.tagName));
  let navOnly = false;
  if (!form && !submitType) {
    const base = (h) => String(h || '').split('.').slice(-2).join('.');
    let link = false;
    if (t.tagName === 'A' && t.hasAttribute('href')) {
      const raw = attr('href').trim();
      try { const u = new URL(t.href, location.href); link = /^https?:$/.test(u.protocol) && !/^(#|javascript:)/i.test(raw) && !t.hasAttribute('download') && base(u.hostname) === base(location.hostname); } catch { link = false; }
    }
    let navBox = false;
    for (let p = t, i = 0; p && p !== document.body && i < 14; p = p.parentElement, i++) {
      const r = (p.getAttribute && p.getAttribute('role')) || '';
      if (/^(menu|dialog|alertdialog|listbox)$/.test(r) || p.tagName === 'FORM') break;
      const cl = typeof p.className === 'string' ? p.className : '';
      if (/^(NAV|ASIDE)$/.test(p.tagName) || /^(navigation|menubar|tablist)$/.test(r)
        || (/(^|[\s_-])(menu|nav|navbar|sider|sidebar|breadcrumb)([\s_-]|$)/i.test(cl) && !/dropdown|popover|popup|context|modal|drawer/i.test(cl))) { navBox = true; break; }
    }
    const linkish = t.tagName === 'A' || /^(link|menuitem|tab|treeitem)$/.test(role) || !!(t.closest && t.closest('li'));
    navOnly = link || (navBox && linkish);
  }
  let submitName = '';
  if (form && sel && sel.focused) {
    const b = form.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
    if (b) submitName = tx(b.getAttribute('aria-label') || b.innerText || b.value || b.getAttribute('title'));
  }
  return {
    found: true, tag: t.tagName, type, role, name: name.slice(0, 120), icon: icon.slice(0, 300), buttonish, field, secret, secretKind,
    // 1.33.2 the text of the dialog / modal the element sits in (what a bare 「Confirm」 confirms)
    ctx: (() => { const d = t.closest && t.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="popup" i]'); return d ? String(d.innerText || d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600) : ''; })(),
      // …or, outside any dialog, the small block around it (a plan card: 「Pro · $30/月 · Subscribe」)
      near: (() => { if (t.closest && t.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="popup" i]')) return ''; let p = t.parentElement; for (let i = 0; p && p !== document.body && i < 4; i++, p = p.parentElement) { const x = String(p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim(); if (x.length > 300) break; if (/[$€£¥￥]\s?\d|\d\s?(元|美元)|\/\s?(mo|month|月|年|yr)/i.test(x)) return x.slice(0, 300); } return ''; })(),
    fref: (t.getAttribute && t.getAttribute('data-foxpaw-ref')) || '', inner: !!(sel && sel.inner),
    inForm: !!form, formAction: form ? (form.action || '') : '', submitName: submitName.slice(0, 120),
    textarea: t.tagName === 'TEXTAREA' || !!t.isContentEditable, navOnly, submitType,
  };
}
const ICON_WORDS = { delete: ['delete', 'trash', 'remove', 'garbage', 'bin', 'destroy'], pay: ['pay', 'payment', 'checkout', 'wallet', 'purchase'], grant: ['authorize', 'grant'], submit: ['send', 'submit', 'save', 'publish', 'upload'] };
function classifyIcon(hint) {
  const toks = new Set(String(hint || '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  for (const cat of ['pay', 'grant', 'delete', 'submit']) if (ICON_WORDS[cat].some((w) => toks.has(w))) return cat;
  return '';
}
// classify by the element's OWN name (never by the form's submit
// button); a nameless icon button is classified by its icon class, else
// it is an UNKNOWN write; anything we cannot see into (iframe) is unknown.
function classifyElement(info) {
  if (!info || !info.found) return 'normal';
  if (info.empty) return 'normal';
  if (info.frame) return 'unknown';
  if (info.name) {
    const cat = classifyText(info.name);
    // a submit word on PURE navigation (same-site link / nav-menu item, no form, not a
    // submit button) only opens a page — 「商品发布」 in a side menu is not a publish.
    // pay / grant / delete words are never relaxed by this.
    if (cat === 'submit' && info.navOnly) return 'normal';
    // 1.33.2 a confirm-like button inside a dialog that is about buying (price / billing period) = pay
    if ((cat === 'submit' || cat === 'normal') && (info.buttonish || info.submitType || info.role === 'button')) {
      if (info.ctx && payContext(info.ctx) && (cat === 'submit' || PAY_BTN_NEAR.test(info.name))) return 'pay';
      if (!info.ctx && info.near && PAY_BTN_NEAR.test(info.name) && payContext(info.near + ' ' + info.name)) return 'pay';
    }
    if (cat !== 'normal') return cat;
    return (info.buttonish && classifyIcon(info.icon)) || 'normal';
  }
  const ic = classifyIcon(info.icon);
  if (ic) return ic;
  return info.buttonish ? 'unknown' : 'normal';
}

/* ---- 1.26 登录凭证 (login vault): logins the owner saved, kept encrypted on THIS machine ----
   Items live in chrome.storage.local per account (foxpawVault.b[<account id> | '_local']); the password is
   AES-GCM encrypted (WebCrypto) with a key generated on this machine (foxpawVaultKey, never sent anywhere;
   the item id is bound in as additional data). Nothing of a password ever leaves the extension: the relay
   only learns {id, site, user} (vault.index) for the console list and foxpaw_whoami; an agent asks for a
   login by site (foxpaw_login) and the extension types it here and reads back •••. No relay request,
   audit line, activity, recording or flow ever carries the value. Site = main domain (sub-domains match). */
const VAULT_KEY = 'foxpawVault';
const VAULT_CK = 'foxpawVaultKey';
const VAULT_NEVER = 'foxpawVaultNever';
const VAULT_MAX = 300;
const VAULT_CATS = ['login', 'vault'];
const VAULT_MULTI = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'com.hk', 'com.tw', 'co.uk', 'org.uk',
  'ac.uk', 'co.jp', 'ne.jp', 'or.jp', 'com.au', 'net.au', 'co.kr', 'com.sg', 'com.br', 'co.nz', 'co.in']); // = relay _MULTI_SUFFIX
// 'https://a.b.example.com:8443/x' → 'example.com' (same rule as the relay's trust_site_norm); '' = not a site
function siteMain(s) {
  let h = String(s == null ? '' : s).trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
  h = h.split('@').pop();
  if (h.startsWith('[')) return '';
  h = h.split(':')[0].replace(/^\.+|\.+$/g, '');
  while (h.startsWith('*.')) h = h.slice(2);
  if (!h || h.length > 253 || !/^[a-z0-9.-]+$/.test(h) || h.includes('..')) return '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h === 'localhost') return h;
  const p = h.split('.');
  if (p.length < 2 || p.some((x) => !x)) return '';
  const n = VAULT_MULTI.has(p.slice(-2).join('.')) && p.length >= 3 ? 3 : 2;
  return p.slice(-n).join('.');
}
const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array((String(h).match(/../g) || []).map((x) => parseInt(x, 16)));
async function vaultCryptoKey() {
  let hex = (await chrome.storage.local.get(VAULT_CK))[VAULT_CK];
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) {
    hex = toHex(crypto.getRandomValues(new Uint8Array(32)));
    await chrome.storage.local.set({ [VAULT_CK]: hex });
  }
  return crypto.subtle.importKey('raw', fromHex(hex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function vaultEnc(id, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('foxpaw-vault:' + id) }, await vaultCryptoKey(), new TextEncoder().encode(text));
  return { iv: toHex(iv), ct: toHex(new Uint8Array(ct)) };
}
async function vaultDec(it) {
  if (!it || !it.iv || !it.ct) throw err('VAULT_BROKEN', 'this saved login has no password');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(it.iv), additionalData: new TextEncoder().encode('foxpaw-vault:' + it.id) }, await vaultCryptoKey(), fromHex(it.ct));
    return new TextDecoder().decode(pt);
  } catch { throw err('VAULT_BROKEN', 'this saved login cannot be decrypted on this machine (key changed) — re-enter it in the side panel'); }
}
let vaultChain = Promise.resolve();
function vaultSerial(fn) { const p = vaultChain.catch(() => {}).then(fn); vaultChain = p.catch(() => {}); return p; }
async function vaultBucketId() { return (await chrome.storage.local.get(ACCT_KEY))[ACCT_KEY] || '_local'; }
async function vaultAll() { const v = (await chrome.storage.local.get(VAULT_KEY))[VAULT_KEY]; return v && typeof v === 'object' && v.b && typeof v.b === 'object' ? v : { v: 1, b: {} }; }
async function vaultItems() { const v = await vaultAll(); const b = v.b[await vaultBucketId()]; return Array.isArray(b) ? b : []; }
async function vaultWrite(items) { const v = await vaultAll(); v.b[await vaultBucketId()] = items; await chrome.storage.local.set({ [VAULT_KEY]: v }); }
function vaultMeta(it) { return { id: it.id, site: it.site, user: it.user || '', note: it.note || '', source: it.source || 'owner', by: it.by || '', created: it.created || 0, updated: it.updated || 0, used: it.used || 0 }; }
// the panel's list (no password) + the relay's index (site + account name only: no note, no password)
async function vaultPublish() {
  const metas = (await vaultItems()).map(vaultMeta).sort((a, b) => a.site.localeCompare(b.site) || a.user.localeCompare(b.user));
  try { await setUi({ vault: metas }); } catch { /* noop */ }
  try { wsSend({ type: 'vault.index', items: metas.map((m) => ({ id: m.id, site: m.site, user: m.user, updated: m.updated })) }); } catch { /* offline */ }
  return metas;
}
// add or update one login. Same site + account = update (a new password replaces the old one).
async function vaultPut(input, by = {}) {
  const site = siteMain(input.site);
  if (!site) throw err('BAD_SITE', '网站格式不对（填网址或域名，如 github.com）');
  const user = String(input.user == null ? '' : input.user).trim().slice(0, 200);
  const note = String(input.note == null ? '' : input.note).slice(0, 300);
  const password = input.password == null ? '' : String(input.password);
  if (password.length > 1000) throw err('BAD_PASSWORD', '密码太长');
  return vaultSerial(async () => {
    const items = (await vaultItems()).slice();
    let it = input.id ? items.find((x) => x.id === input.id) : null;
    if (input.id && !it) throw err('NOT_FOUND', '这条登录已经不在了');
    const same = items.find((x) => x !== it && x.site === site && (x.user || '') === user);
    if (it && same) throw err('DUPLICATE', `${site} 的账号 ${user || '（空）'} 已经存过了`);
    if (!it && same) it = same;
    if (!it && !password) throw err('BAD_PASSWORD', '密码不能为空');
    if (!it && items.length >= VAULT_MAX) throw err('VAULT_FULL', `最多存 ${VAULT_MAX} 条登录`);
    const now = Date.now();
    const id = it ? it.id : 'v' + toHex(crypto.getRandomValues(new Uint8Array(8)));
    const next = { ...(it || {}), id, site, user, note: input.note === undefined && it ? (it.note || '') : note, updated: now, created: it ? it.created : now,
      source: by.source || (it && it.source) || 'owner', by: by.label || (it && it.by) || '' };
    if (password) Object.assign(next, await vaultEnc(id, password));
    if (it) items[items.indexOf(it)] = next; else items.push(next);
    await vaultWrite(items);
    await vaultPublish();
    return { item: vaultMeta(next), replaced: !!it, prevSource: it ? (it.source || 'owner') : '' };
  });
}
async function vaultRemove(id) {
  return vaultSerial(async () => {
    const items = await vaultItems();
    const it = items.find((x) => x.id === id);
    if (!it) return null;
    await vaultWrite(items.filter((x) => x.id !== id));
    await vaultPublish();
    return vaultMeta(it);
  });
}
async function vaultReveal(id) {
  const it = (await vaultItems()).find((x) => x.id === id);
  if (!it) throw err('NOT_FOUND', '这条登录已经不在了');
  return vaultDec(it);
}
async function vaultTouch(id) {
  return vaultSerial(async () => { const items = (await vaultItems()).slice(); const i = items.findIndex((x) => x.id === id); if (i >= 0) { items[i] = { ...items[i], used: Date.now() }; await vaultWrite(items); } });
}
// a login entered BEFORE the browser was bound to an account joins that account the first time it connects
async function vaultAdoptLocal(acct) {
  if (!acct) return;
  await vaultSerial(async () => {
    const v = await vaultAll();
    const loc = Array.isArray(v.b._local) ? v.b._local : [];
    if (!loc.length) return;
    const mine = Array.isArray(v.b[acct]) ? v.b[acct] : [];
    const seen = new Set(mine.map((x) => x.site + '\n' + (x.user || '')));
    v.b[acct] = mine.concat(loc.filter((x) => !seen.has(x.site + '\n' + (x.user || ''))));
    delete v.b._local;
    await chrome.storage.local.set({ [VAULT_KEY]: v });
  });
}
const maskUser = (u) => { const s = String(u || ''); if (s.length <= 3) return s; const at = s.indexOf('@'); return at > 1 ? s.slice(0, 2) + '***' + s.slice(at) : s.slice(0, 3) + '***' + s.slice(-2); };
// tabs where an agent just typed a credential: the page's own submit is not offered for saving
const credTyped = new Map(); // tabId -> ts
/* 「保存到 FoxPaw」: the owner signs in by hand on a page, vaultcatch.js (content script) sees the submit and
   hands {user, password} to the background; the offer lives in memory only (password never in storage
   until the owner says 保存) for VAULT_OFFER_MS, shown as a side-panel banner + a notification. */
const VAULT_OFFER_MS = 5 * 60 * 1000;
const vaultOffers = new Map(); // tabId -> {tabId, site, user, password, at, update}
async function vaultOfferPublish() {
  const now = Date.now();
  for (const [k, o] of vaultOffers) if (now - o.at > VAULT_OFFER_MS) vaultOffers.delete(k);
  const last = [...vaultOffers.values()].sort((a, b) => b.at - a.at)[0];
  await setUi({ vaultOffer: last ? { tabId: last.tabId, site: last.site, user: last.user, update: !!last.update, at: last.at } : null });
}
async function vaultCatch(msg, sender) {
  const tab = sender && sender.tab;
  if (!tab || tab.id == null) return { ok: false };
  const url = String((sender && sender.url) || tab.url || '');
  if (!/^https?:/.test(url)) return { ok: false };
  const site = siteMain(hostOfUrl(url));
  if (!site) return { ok: false };
  if (isPayPage(tab.title, url)) return { ok: false, why: 'pay' };
  if (Date.now() - (credTyped.get(tab.id) || 0) < 30000) return { ok: false, why: 'agent' }; // the agent typed it (FoxPaw fill)
  const password = String(msg.password == null ? '' : msg.password);
  const user = String(msg.user == null ? '' : msg.user).trim().slice(0, 200);
  if (!password || password.length > 1000) return { ok: false };
  const never = ((await chrome.storage.local.get(VAULT_NEVER))[VAULT_NEVER] || []);
  if (Array.isArray(never) && never.includes(site)) return { ok: false, why: 'never' };
  const same = (await vaultItems()).find((x) => x.site === site && (x.user || '') === user);
  if (same) { try { if (await vaultDec(same) === password) return { ok: false, why: 'saved' }; } catch { /* re-offer */ } }
  vaultOffers.set(tab.id, { tabId: tab.id, site, user, password, at: Date.now(), update: !!same });
  await vaultOfferPublish();
  notifyOwner('fxn-vault-' + tab.id, same ? `更新 ${site} 的已存密码？` : `把 ${site} 的登录保存到 FoxPaw？`,
    `账号 ${user || '（未识别）'} · 密码只加密存在这台浏览器。打开 FoxPaw 侧栏点「保存」`, tab.id);
  return { ok: true };
}
async function vaultOfferDecide(tabId, save, never) {
  const o = vaultOffers.get(Number(tabId));
  vaultOffers.delete(Number(tabId));
  clearNotice('fxn-vault-' + tabId);
  let out = { ok: true };
  if (o && save && Date.now() - o.at <= VAULT_OFFER_MS) {
    const r = await vaultPut({ site: o.site, user: o.user, password: o.password }, { source: 'owner', label: '网页登录时保存' });
    try { wsSend({ type: 'vault.saved', site: r.item.site, user: r.item.user, by: 'owner', replaced: r.replaced }); } catch { /* offline */ }
    await audit(`login saved from the page: ${r.item.site} (${maskUser(r.item.user)})`);
    out = { ok: true, item: r.item };
  } else if (o && never) {
    const cur = ((await chrome.storage.local.get(VAULT_NEVER))[VAULT_NEVER] || []);
    await chrome.storage.local.set({ [VAULT_NEVER]: [...new Set([...(Array.isArray(cur) ? cur : []), o.site])].slice(-200) });
  } else if (save) out = { ok: false, error: '这次登录的提示已过期' };
  await vaultOfferPublish();
  return out;
}

/* ---- credential tiers: decided from the relay's stamps only ----
   1.29: inside trust (全部网站 / this site / 「这次都放行」) the agent types ANY value it brings
   into a password / code / 商品卡密 box — an account password it was told or made up, a code from email, the stock
   codes it is listing, the characters it read off an image captcha. The hard lines left: payment-class fields
   (card / CVV / 支付密码), any secret box on a payment page; the owner's OWN
   saved login only through foxpaw_login (the agent never has it). Untrusted: a 商品卡密 box asks once (category
   'stock'); approving it covers that agent + site for the task (intent, ). */
function credVerdict(ctx, tab, sec) {
  const g = (ctx && ctx.grants && ctx.grants.creds) || {};
  const origin = tab ? originOf(tab.url || '') : '';
  let ask = '';
  const plan = [];
  const trusted = tab ? trustScope(ctx, hostOfUrl(tab.url || '')) : null;
  const payPage = !!tab && isPayPage(tab.title, tab.url);
  for (const x of sec) {
    const kind = (x.cand.info && x.cand.info.secretKind) || 'password';
    const src = x.m.credSource;
    if (kind === 'card') return 'secret';                       // payment cards: never, whatever the grant
    if (ctx.local || !ctx.agentId) return 'secret';
    // 1.29 (the owner 22:34): a trusted agent may type the characters IT read off an image captcha; untrusted = as before
    if (kind === 'captcha' && !(trusted && !payPage)) return 'secret';
    if (kind === 'stock' && payPage) return 'secret';            // a 卡号 / 卡密 on a pay page is a prepaid / bank card
    if (src === 'assigned' && x.m.credGrant) plan.push([x, 'assigned']);
    else if (trusted && !payPage) plan.push([x, 'trust']);
    else if (src === 'generated' && g.generated) plan.push([x, 'generated']);
    else if (src === 'testsite' && origin && (g.testSites || []).includes(origin)) plan.push([x, 'testsite']);
    else if (kind === 'otp' && g.otp) plan.push([x, 'otp']);
    else if (kind === 'otp' && ctx.task) { plan.push([x, 'otp']); ask = ask || 'otp'; }
    else if (kind === 'stock') { plan.push([x, 'stock']); ask = 'stock'; }
    else return 'secret';                                        // the owner's own password: USER_STEP
  }
  for (const [x, src] of plan) { CRED_OK.set(x.m, src); }
  return ask || 'ok';
}
// field objects the gate cleared (a WeakMap, not a property: nothing an agent or a flow sends can set it)
const CRED_OK = new WeakMap();

/* ---- approvals ---- */
const CAT_CN_EXT = { submit: '提交', delete: '删除', write: '填写', upload: '上传', eval: '运行脚本', unknown: '未知写操作', stock: '填写商品卡密', session: '会话数据', tab: '使用未授权标签' };
/* 1.29 a card nobody answered in time fails THIS command only, with a code the agent can act on: nothing
   ran, nothing later is blocked (the relay's tab lease is per agent, the extension holds no queue), and once the
   owner approves one such action the same intent goes through for the rest of the task. */
function confirmTimeoutErr(cat, host) {
  const e = err('CONFIRM_TIMEOUT', `the owner did not answer the approval card within ${Math.round(confirmTtl() / 1000)} s — this command was NOT executed and never will be; other commands are not blocked. Ask the owner with foxpaw_need_human (or have them trust you for ${host || 'this site'} in the console), then retry this step; after one approval the same kind of action on this site is not asked again in this task.`);
  e.detail = { reason: 'no_answer', category: cat, host: host || '', waitedS: Math.round(confirmTtl() / 1000), retryable: true,
    next: 'foxpaw_need_human, then retry the same command' };
  return e;
}
const approvedOnce = new Set(); // `${family}|${origin}` approve-once per relay connection
function approvalNeeded(c, rule, category, basis, once) {
  // returns true when the owner must be asked
  if (category === 'normal') return false;
  if (category === 'pay') return true; // 1.33.2 every payment asks, whatever the rules / remembered / trust
  if (category === 'login' || category === 'vault') return true; // 1.26 a saved login is used / stored only with a card, or inside trust
  if (category === 'stock') return true; // 1.29 商品卡密 of an untrusted agent: one card per intent
  if (category === 'session' || category === 'upload' || category === 'tab') return !(once && approvedOnce.has(once));
  if (once && approvedOnce.has(once)) return false;
  // fill / script / unknown-write: ask only in 每次问我 on a site not set to allow (pre-1.15 fill/eval policy)
  if (category === 'write' || category === 'eval' || category === 'unknown') return c.sensitive !== 'rules' && rule !== 'allow';
  // delete / submit: remembered basis, or 按站点规则 + allow (unchanged)
  if (basis && (c.remembered || []).includes(basis)) return false;
  if (c.sensitive === 'rules' && rule === 'allow') return false;
  return true;
}

/* The one gate. act = {
     cls: 'read'|'write'|'sensitive'|'always', scope: 'control'|'group'|'none',
     targetUrl?, classify?: async (tab) => ({category, title, detail, basis, once}),
     run: async (tab) => result, audit: (result, cat) => string }   */
async function execCore(ctx, act) {
  const c = await cfg();
  // 1 access: 全部暂停 × the agent's own permission — the relay's live push (1.27 ) over the cap stamped on the
  // command (a flow run's envelope can be minutes old); local owner commands carry no agent
  if (act.cls !== 'always') {
    const live = ctx.agentId ? agentLive.get(ctx.agentId) : null;
    const agentCap = live ? live.accessNow : ctx.agentCap && ACCESS.includes(ctx.agentCap) ? ctx.agentCap : 'write';
    const caps = [c.access, agentCap];
    if (caps.includes('off')) throw err('PAUSED', 'FoxPaw is paused by the browser owner (mode 停用) — no commands are accepted right now');
    if (caps.includes('read') && act.cls === 'sensitive') throw err('READ_ONLY', 'read-only (只看): session data (cookies / storage) is never readable in this mode');
    if (caps.includes('read') && act.cls !== 'read') throw err('READ_ONLY', `FoxPaw is in read-only mode (只看) — "${ctx.kind}" is a write and was refused`);
  }
  // 2 who
  checkWho(c, ctx);
  // 3 scope
  let tab = null;
  if (act.scope === 'control') tab = await assertControllable(ctx.tabId);
  else if (act.scope === 'group') tab = await assertInGroup(ctx.tabId);
  if (tab) await recNoteAgentTab(ctx, tab.id); // 1.33.2
  // 4 site
  if (act.cls !== 'always' && tab && /^https?:/.test(tab.url || '') && siteRule(c, originOf(tab.url)) === 'block') {
    throw err('SITE_BLOCKED', `site blocked by rule: ${originOf(tab.url)}`);
  }
  let target = null;
  if (act.targetUrl !== undefined) target = urlCheck(act.targetUrl, c);
  // 5 classify
  let cat = 'normal', meta = null;
  if (act.classify) {
    const r = await act.classify(tab, target);
    if (r) { cat = r.category || 'normal'; meta = r; }
  }
  // 6 approve
  // 1.33.2: a payment is no longer a hard stop — it always asks the owner (a card every
  // time: never remembered, never inside trust / 「这次都放行」 / a 5-minute window); approved, the agent clicks it
  if (cat === 'grant') throw await userStepErr(ctx, cat, `${cat} actions are never executed by an agent — the owner must do this step personally`, meta && meta.title);
  if (cat === 'secret') {
    recAgentLoginPause(ctx, tab); // an agent recording hit a login — pause, the owner logs in, nothing of it is recorded
    throw await userStepErr(ctx, 'secret', 'this targets a secret field (password / one-time code / card) — the owner must type it personally', meta && meta.title);
  }
  const origin = tab ? originOf(tab.url) : (target ? originOf(target) : '');
  const rule = siteRule(c, origin);
  // a one-time code on a task with no otp grant yet: ask the owner once; approving the card
  // grants this agent+device+task (the relay records the grant), later codes in the task go through
  if (cat === 'otp') {
    const epoch0otp = ctx.tabId != null ? (epochs.get(ctx.tabId) || 0) : 0;
    const res = await waitConfirm({ kind: 'gate', category: 'otp', origin, title: meta && meta.title || '填写验证码',
      detail: '允许后，本任务里的验证码由它代填，不再打断你（只限这个任务；随时可在控制台撤销）',
      host: hostOfUrl((tab && tab.url) || ''), page: ((tab && tab.title) || '').slice(0, 60), tabId: ctx.tabId, task: ctx.task, otp: true }, ctx);
    if (!res.approved) {
      if (res.cancelled) throw err('CONFIRM_CANCELLED', 'the relay gave up waiting — this command is void and will never execute');
      if (res.stop) throw err('USER_STOPPED', 'the owner told you to stop: abandon this task, do not retry');
      if (res.timeout) throw confirmTimeoutErr('otp', hostOfUrl((tab && tab.url) || ''));
      throw err('USER_REJECTED', 'the owner did not allow filling this code — ask with foxpaw_need_human');
    }
    await recheckAfterConfirm(ctx, act, epoch0otp);
    if (meta && meta.after) meta.after();
    const out0 = await act.run(tab, target);
    if (act.audit) await audit(act.audit(out0, cat), { agent: ctx.agentLabel || undefined, agentId: ctx.agentId || undefined });
    return out0;
  }
  // a replay the OWNER started from the panel does not ask the owner to approve plain field
  // fills (it is their own recorded input); delete / submit / upload / session / script cards and
  // USER_STEP (pay / grant / secret) apply unchanged. Agent-started replays get every card.
  const ownerFill = ctx.ownerReplay === true && cat === 'write';
  const cardHost = hostOfUrl((tab && tab.url) || target || '');
  // the relay stamped a live window for this agent + device + task + site + kind → no card;
  // the use is reported to the relay, which writes the audit line (and logs a mismatch if it expired)
  const needCard = !!meta && !ownerFill && approvalNeeded(c, rule, cat, meta.basis, meta.once);
  // 1.25 … or the agent is trusted here (全部网站 / this site / 「这次都放行」 for this task)
  // 1.26 a saved login (login) / storing one (vault) — inside trust no card; a card when the owner
  // must decide on replacing their own saved login (meta.forceCard). meta.host = the site it is for.
  const vaultCat = VAULT_CATS.includes(cat);
  const payCat = cat === 'pay';
  const iKey = vaultCat || payCat ? null : intentKey(ctx, cat, cardHost);
  const win = !needCard || payCat ? null : vaultCat ? (meta.forceCard ? null : trustScope(ctx, meta.host || cardHost))
    : (windowFor(ctx, cat, cardHost) || trustFor(ctx, cat, cardHost, tab)
      || (intentHas(iKey) ? { id: 'intent', basis: 'intent', label: '已批准过的同类操作' } : null));
  if (vaultCat) ctx.vaultBasis = win ? { basis: win.basis, label: win.label, id: win.id } : { basis: 'card' };
  if (win && vaultCat) {
    await audit(`按信任放行（${win.label}）: ${cat} ${meta.host || cardHost} without a card${ctx.task ? ' (task ' + ctx.task + ')' : ''}`, { agent: ctx.agentLabel || undefined, agentId: ctx.agentId || undefined });
  } else if (win) {
    try { wsSend({ type: 'window.used', id: win.id, agentId: ctx.agentId, host: cardHost, verb: cat, title: String(meta.title || '').slice(0, 80), ...(win.basis ? { basis: win.basis } : {}) }); } catch { /* offline: audit stays local */ }
    await audit(win.basis === 'intent' ? `按已批准的同类操作放行: ${cat} on ${cardHost} without a card${ctx.task ? ' (task ' + ctx.task + ')' : ''}`
      : win.basis ? `按信任放行（${win.label}）: ${cat} on ${cardHost} without a card${ctx.task ? ' (task ' + ctx.task + ')' : ''}`
      : `window ${win.id}: ${cat} on ${cardHost} without a card (task ${ctx.task})`, { agent: ctx.agentLabel || undefined, agentId: ctx.agentId || undefined });
  } else if (meta && !ownerFill && approvalNeeded(c, rule, cat, meta.basis, meta.once)) {
    const epoch0 = ctx.tabId != null ? (epochs.get(ctx.tabId) || 0) : 0;
    const res = await waitConfirm({
      kind: 'gate', category: cat, basis: payCat ? '' : (meta.basis || ''), origin, title: meta.title || `${cat} on ${origin}`, ...(payCat ? { pay: true, amount: meta.amount || '' } : {}),
      detail: (meta.detail || meta.title || '') + (iKey ? `\n批准后，${ctx.task ? '本任务内' : '接下来 30 分钟内'}它在 ${cardHost} 的同类操作（${CAT_CN_EXT[cat] || cat}）不再逐次询问` : ''),
      intent: !!iKey, host: meta.host || cardHost, page: ((tab && tab.title) || '').slice(0, 60),
      tabId: ctx.tabId, task: ctx.task || '',
      windowable: !payCat && !!(ctx.task && ctx.agentId && !ctx.local && WINDOW_VERBS.includes(cat)),
    }, ctx);
    if (!res.approved) {
      if (res.cancelled) throw err('CONFIRM_CANCELLED', 'the relay gave up waiting — this command is void and will never execute');
      if (res.stop) throw err('USER_STOPPED', 'the owner told you to stop: abandon this task, do not retry');
      if (res.timeout) throw confirmTimeoutErr(cat, cardHost);
      throw err('USER_REJECTED', 'the owner did not approve this action');
    }
    await recheckAfterConfirm(ctx, act, epoch0);
    if (meta.once) approvedOnce.add(meta.once);
    intentAdd(iKey);
  }
  if (meta && meta.after) meta.after();
  // 7 run
  const out = await act.run(tab, target);
  // 8 record
  if (act.audit) await audit(act.audit(out, cat), { agent: ctx.agentLabel || undefined, agentId: ctx.agentId || undefined });
  return out;
}
/* ---- 「需要你处理」: a USER_STEP is announced to the owner, not only returned to the agent ----
   Each USER_STEP puts a card at the top of the panel （去处理 jumps to the tab）, counts into the
   toolbar badge, and a system notification (1.19.0: the "notifications" permission)
    whose click opens that tab AND the FoxPaw side panel. The agent gets detail.needYou + next: the existing
   foxpaw_need_human call is the resume signal (the owner's 「好了，继续」 completes it). */
const userSteps = new Map(); // id -> {id, tabId, agent, agentId, reason, what, page, host, since}
const USER_STEP_TTL_MS = 10 * 60 * 1000;
const USER_STEP_NEXT = 'the owner has been notified in the FoxPaw panel; call foxpaw_need_human with what you need done and wait — the owner\'s 「好了，继续」 is your signal to carry on';
const notifTabs = new Map(); // notification id -> tabId
function notifyOwner(nid, title, message, tabId) {
  const n = chrome.notifications;
  if (!n || typeof n.create !== 'function') return false; // no "notifications" permission: badge + panel only
  try {
    n.create(nid, { type: 'basic', iconUrl: 'icons/foxpaw-128.png', title: String(l10n(title)).slice(0, 60), message: String(l10n(message)).slice(0, 180), priority: 2, requireInteraction: true }, () => void (chrome.runtime && chrome.runtime.lastError));
    if (tabId != null) notifTabs.set(nid, tabId);
    return true;
  } catch { return false; }
}
// 1.20: whether Chrome lets FoxPaw show notifications at all (the macOS-level switch is
// invisible to extensions — the panel's 「发一条测试通知」 covers that). Published to foxpawUi.
function notifyLevelNow() {
  return new Promise((res) => {
    try {
      if (!chrome.notifications || !chrome.notifications.getPermissionLevel) return res('unknown');
      chrome.notifications.getPermissionLevel((lv) => { void (chrome.runtime && chrome.runtime.lastError); res(lv || 'unknown'); });
    } catch { res('unknown'); }
  });
}
async function publishNotifyLevel() { try { await setUi({ notifyLevel: await notifyLevelNow() }); } catch { /* noop */ } }
try { if (chrome.notifications && chrome.notifications.onPermissionLevelChanged) chrome.notifications.onPermissionLevelChanged.addListener((lv) => setUi({ notifyLevel: lv })); } catch { /* mocks */ }
publishNotifyLevel();
function clearNotice(nid) { notifTabs.delete(nid); try { if (chrome.notifications && chrome.notifications.clear) chrome.notifications.clear(nid); } catch { /* noop */ } }
async function focusTab(tabId) {
  if (tabId == null) return false;
  try {
    const t = await chrome.tabs.update(tabId, { active: true });
    const w = t && t.windowId != null ? t.windowId : (await chrome.tabs.get(tabId)).windowId;
    if (w != null && chrome.windows && chrome.windows.update) await chrome.windows.update(w, { focused: true });
    return true;
  } catch { return false; }
}
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((nid) => {
    const t = notifTabs.get(nid);
    // open the side panel first (a notification click is a user gesture), then jump to the tab
    try {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        const go = (wid) => Promise.resolve(chrome.sidePanel.open(t != null ? { tabId: t } : { windowId: wid })).catch(() => {});
        if (t != null) go(); else if (chrome.windows && chrome.windows.getLastFocused) chrome.windows.getLastFocused().then((w) => w && go(w.id)).catch(() => {});
      }
    } catch { /* older Chrome: the tab still opens */ }
    if (t != null) focusTab(t);
    clearNotice(nid);
  });
}
// an agent's raised hand (foxpaw_need_human, from the relay roster) is announced once per need
const needNotified = new Set();
function notifyNeeds(roster) {
  const live = new Set();
  for (const a of Array.isArray(roster) ? roster : []) {
    for (const n of (a && a.needs) || []) {
      if (!n || !n.id) continue;
      live.add(n.id);
      if (needNotified.has(n.id)) continue;
      needNotified.add(n.id);
      notifyOwner('fxn-need-' + n.id, `${a.label || 'Agent'} 需要你处理`, `${String(n.reason || '需要你处理一下').slice(0, 120)}${n.tabTitle ? ' · ' + n.tabTitle : ''}`, n.tabId != null ? n.tabId : null);
    }
  }
  for (const id of [...needNotified]) if (!live.has(id)) { needNotified.delete(id); clearNotice('fxn-need-' + id); }
}
async function publishUserSteps() {
  await setUi({ userSteps: [...userSteps.values()] });
  refreshAction();
}
function clearUserStep(id) {
  if (!userSteps.delete(id)) return false;
  clearNotice('fxn-' + id);
  publishUserSteps();
  return true;
}
async function raiseUserStep(ctx, tabId, reason, what) {
  for (const u of userSteps.values()) {
    if (u.tabId === tabId && u.reason === reason && u.what === (what || '')) { u.since = Date.now(); publishUserSteps(); return u.id; }
  }
  let page = '', host = '';
  if (tabId != null) { try { const t = await getTab(tabId); page = (t.title || '').slice(0, 60); host = hostOfUrl(t.url || ''); } catch { /* gone */ } }
  const id = randomId('u');
  const agent = (ctx && ctx.agentLabel) || '';
  userSteps.set(id, { id, tabId: tabId != null ? tabId : null, agent, agentId: (ctx && ctx.agentId) || '', reason, what: what || '', page, host, since: Date.now() });
  setTimeout(() => clearUserStep(id), USER_STEP_TTL_MS);
  await publishUserSteps();
  notifyOwner('fxn-' + id, `${agent || 'Agent'} 需要你亲自处理`, `${USER_REASON_CN[reason] || '需要主人亲自操作'}${what ? '：' + what : ''}${page ? ' · ' + page : ''}`, tabId);
  return id;
}
async function userStepErr(ctx, reason, message, what) {
  const e = err('USER_STEP', message);
  try {
    const id = await raiseUserStep(ctx, ctx ? ctx.tabId : null, reason, what);
    e.needYou = id;
    e.detail = { needYou: id, reason, next: USER_STEP_NEXT };
  } catch { /* the error itself still goes out */ }
  return e;
}
function checkWho(c, ctx) {
  const pz = c.agentPause || {};
  const L = ctx.agentLabel;
  if ((ctx.agentId && pz[ctx.agentId]) || (L && (pz['label:' + L] || (!/^g\d+$/.test(L) && pz[L])))) {
    throw err('AGENT_PAUSED_ON_DEVICE', `agent "${ctx.agentLabel || ctx.agentId}" is paused on this device by the browser owner — no commands are accepted until the owner resumes it`);
  }
  if (ctx.tabId != null && humanLocks.has(ctx.tabId)) {
    throw err('TAB_HELD_BY_HUMAN', 'the browser owner is using this tab right now — wait or ask via foxpaw_need_human');
  }
}
// between "card shown" and "approved" the world may have moved on.
async function recheckAfterConfirm(ctx, act, epoch0) {
  if (ctx.cancelled) throw err('CONFIRM_CANCELLED', 'the relay gave up waiting — this command is void and will never execute');
  const c = await cfg();
  if (c.access === 'off' || (c.access === 'read' && act.cls !== 'read')) throw err('STALE_AFTER_CONFIRM', 'browser mode changed while waiting for approval');
  checkWho(c, ctx);
  if (act.scope === 'control') await assertControllable(ctx.tabId);
  else if (act.scope === 'group') await assertInGroup(ctx.tabId);
  if (ctx.tabId != null && (epochs.get(ctx.tabId) || 0) !== epoch0) throw err('STALE_AFTER_CONFIRM', 'the page navigated while waiting for approval — take a new snapshot');
}

/* ---------------- page engine (v1.16, ) ----------------
   ONE self-contained function injected into a frame (top or any iframe —
   chrome.scripting reaches cross-origin frames with <all_urls>). It keeps
   a per-document registry in the isolated world, so a ref stays the SAME
   for the same element across snapshots (Playwright-style stable refs) and
   dies with the document. Refs are frame-local ('e12'); the background
   prefixes subframe refs with their frameId ('f3e12').
   Ops: snapshot | resolve | point | clickDom | fill | read | probe | iframes | focusWatch
   Open shadow roots are walked everywhere (snapshot, locators, hit-test). */
function fpPage(op, a) {
  a = a || {};
  const W = window;
  if (!W.__fpEngine || W.__fpEngine.v !== 3) W.__fpEngine = { v: 3, n: 0, ids: new WeakMap(), refs: new Map() };
  const E = W.__fpEngine;
  if (!W.__foxpawPw) W.__foxpawPw = new WeakSet(); // fields ever seen as type=password (survives 显示密码)
  const PW = W.__foxpawPw;
  const doc = document;
  const tx = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const norm = (v) => tx(v).toLowerCase();
  const attr = (el, n) => (el && el.getAttribute && el.getAttribute(n)) || '';
  for (const p of doc.querySelectorAll('input[type="password"]')) PW.add(p);
  // 1.29 a same-origin iframe whose document is editable = an iframe rich editor (UEditor / KindEditor /
  // TinyMCE 4 / CKEditor 4): listed, located and filled as ONE text box
  const frameDoc = (el) => { if (!el || el.tagName !== 'IFRAME') return null; try { const d = el.contentDocument; return d && d.body && (d.designMode === 'on' || d.body.isContentEditable || attr(d.body, 'contenteditable') === 'true') ? d : null; } catch { return null; } };
  // 1.29 component-library dropdowns (Element UI / Element Plus incl. el-select-v2, Ant, layui, iView, Arco, Naive)
  const COMBO_BOX = '.ant-select,.el-select,.el-select-v2,[class*="-select-selector"],.layui-form-select,.ivu-select,.arco-select,.n-base-selection,.vxe-select';
  const OPTION_SEL = '[role="option"],[class*="select-item-option"],[class*="dropdown-item"],[class*="dropdown__item"],[class*="select-option"],[class*="select__option"],li[class*="option"],dd[lay-value],.ivu-select-item,.el-cascader-node';
  const CASCADE_COLS = '.el-cascader-menu,.ant-cascader-menu,.ivu-cascader-menu,.arco-cascader-list-column';
  // 1.29.1 code editors keep their text in their own model and re-render the DOM from it; a value set from
  // outside is normalised / cut (tester 11-04 #9: Monaco kept only the tail). They get real typing + a read-back.
  const CODE_SEL = '.monaco-editor,.CodeMirror,.cm-editor,.ace_editor';
  const CODE_INPUT = 'textarea.inputarea,textarea.ime-text-area,.CodeMirror textarea,.cm-content,textarea.ace_text-input,textarea';
  const codeRootOf = (el) => (el && ((el.closest && el.closest(CODE_SEL)) || (el.querySelector && el.querySelector(CODE_SEL)))) || null;
  const codeKind = (root) => (root.classList.contains('monaco-editor') ? 'monaco' : root.classList.contains('CodeMirror') ? 'codemirror5' : root.classList.contains('cm-editor') ? 'codemirror6' : 'ace');
  const RICH_SEL = '[data-slate-editor],.ql-editor,.ProseMirror,.w-e-text,[data-w-e-textarea],.ck-editor__editable,.public-DraftEditor-content,[data-lexical-editor],.tox-edit-area,.mce-content-body,.note-editable,.vditor-reset';

  /* ---- tree walking (light DOM + open shadow roots) ---- */
  const roots = () => {
    const out = [doc];
    for (let i = 0; i < out.length; i++) {
      const all = out[i].querySelectorAll('*');
      for (const el of all) if (el.shadowRoot) { out.push(el.shadowRoot); for (const p of el.shadowRoot.querySelectorAll('input[type="password"]')) PW.add(p); }
    }
    return out;
  };
  const deepAll = (sel, rs) => { const out = []; for (const r of rs || roots()) for (const el of r.querySelectorAll(sel)) out.push(el); return out; };
  // 1.32 another extension's floating widget: a shadow root that resets the page CSS (:host{all:initial}) or loads
  // chrome-extension:// files; a light-DOM box (child of <html> / <body>) that loads chrome-extension:// files
  const EXT_RES = '[src^="chrome-extension:"],[href^="chrome-extension:"],[src^="moz-extension:"]';
  const extOverlays = () => {
    const out = { roots: new Set(), light: [], count: 0, inLight: () => false };
    const all = roots();
    for (const r of all.slice(1)) {
      let hit = false;
      try {
        for (const st of r.querySelectorAll('style')) { const t = st.textContent || ''; if (/:host\s*\{[^}]*\ball\s*:\s*initial/i.test(t) || /chrome-extension:\/\//i.test(t)) { hit = true; break; } }
        if (!hit && r.querySelector(EXT_RES + ',link[href^="chrome-extension:"]')) hit = true;
      } catch { hit = false; }
      if (hit) {
        out.roots.add(r); out.count++;
        // a widget's nested shadow roots go with it
        for (const q of all) { let h = q.host; while (h) { const rr = h.getRootNode && h.getRootNode(); if (rr === r) { out.roots.add(q); break; } h = rr && rr.host; } }
      }
    }
    const tops = [...(doc.body ? doc.body.children : []), ...doc.documentElement.children].filter((c) => c !== doc.body && c !== doc.head);
    for (const c of tops) {
      if (/^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(c.tagName)) continue;
      try { if (c.matches(EXT_RES) || c.querySelector(EXT_RES)) { out.light.push(c); out.count++; } } catch { /* noop */ }
    }
    if (out.light.length) out.inLight = (e) => out.light.some((b) => b.contains(e));
    return out;
  };
  // rendered text of one shadow root: text nodes whose element is shown, never <style> / <script> / <template>
  const shadowText = (r) => {
    const lines = [];
    const vis = new Map();
    let last = null;
    try {
      const w = doc.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(), k = 0; n && k < 20000; n = w.nextNode(), k++) {
        const el = n.parentElement;
        if (!el || el.closest('style,script,noscript,template')) continue;
        const v = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (!v) continue;
        if (!vis.has(el)) vis.set(el, visible(el));
        if (!vis.get(el)) continue;
        if (el === last && lines.length) lines[lines.length - 1] += ' ' + v; else lines.push(v);
        last = el;
      }
    } catch { /* noop */ }
    return lines.join('\n');
  };
  // 1.32 how much of the page is pictures (an 「整图」 page: the words are inside images)
  const imageWeight = (textLen) => {
    let count = 0, big = 0, area = 0, n = 0;
    const se = doc.scrollingElement || doc.documentElement;
    const pageArea = Math.max(1, (se.scrollWidth || W.innerWidth || 1) * Math.max(se.scrollHeight || 0, W.innerHeight || 1));
    for (const el of doc.querySelectorAll('img,picture,canvas,svg,[style*="background"]')) {
      if (++n > 3000) break;
      if (el.tagName === 'svg' && el.closest('a,button')) continue;
      if (/^(IMG|PICTURE|CANVAS|svg|SVG)$/.test(el.tagName) === false) { const bg = getComputedStyle(el).backgroundImage || ''; if (!/url\(/.test(bg)) continue; }
      const b = el.getBoundingClientRect();
      const ar = Math.max(0, b.width) * Math.max(0, b.height);
      if (ar < 2500) continue;
      count++;
      if (ar >= 60000) big++;
      area += ar;
    }
    const ratio = Math.min(1, area / pageArea);
    const heavy = big > 0 && ((textLen < 400) || (ratio > 0.35 && textLen < 2500));
    return { count, big, areaRatio: Math.round(ratio * 100) / 100, heavy: heavy || undefined };
  };
  // 1.32 a bot check page instead of the real one: 'js' = a WAF / compute check that passes by itself once the tab
  // renders (it stalls in a background tab); 'captcha' = a slider / puzzle / checkbox only a human may do
  const CHALLENGE_JS = /人机识别|人机检测|人机验证|安全访问验证|算力(与时间锁)?校验|时间锁校验|正在进行安全检测|浏览器安全检查|正在验证您?的浏览器|安全检查中|Checking (your browser|if the site connection is secure)|Just a moment\.\.\.|Verifying you are human|DDoS protection by|Please wait while we verify|Attention Required/i;
  const CHALLENGE_CAP = /拖动(下方)?滑块|向右(拖动|滑动)|滑块验证|请完成(下方)?(安全)?验证|点击(按钮)?(进行|开始)验证|按住.*验证|I'?m not a robot|我不是机器人|press (and|&) hold|select all (images|squares)/i;
  const CAP_WIDGET = 'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],iframe[src*="captcha"],.geetest_holder,.geetest_panel,[id^="nc_"][class*="nc-container"],.nc-container,#nc_1_wrapper,#tcaptcha_iframe,.tcaptcha-transform,[class*="captcha-slider"],[class*="slide-verify"],.yidun_slider';
  const challengeOfPage = () => {
    try {
      const title = String(doc.title || '');
      const body = doc.body ? String(doc.body.innerText || '').slice(0, 4000) : '';
      const short = body.replace(/\s+/g, '').length < 1200;
      if (!short) return null;
      const u = location.href;
      let widget = false;
      try { widget = [...doc.querySelectorAll(CAP_WIDGET)].some(visible); } catch { widget = false; }
      if (widget || CHALLENGE_CAP.test(body)) return { kind: 'captcha', title: title.slice(0, 80) };
      if (CHALLENGE_JS.test(title) || CHALLENGE_JS.test(body) || /[?&](challenge|__cf_chl_[a-z_]+)=|\/cdn-cgi\/challenge/i.test(u)) return { kind: 'js', title: title.slice(0, 80) };
    } catch { /* noop */ }
    return null;
  };
  const refOf = (el) => {
    let n = E.ids.get(el);
    if (!n) {
      n = ++E.n; E.ids.set(el, n);
      E.refs.set(n, typeof WeakRef !== 'undefined' ? new WeakRef(el) : { deref: () => el });
    }
    const ref = 'e' + n;
    if (el.getAttribute && el.getAttribute('data-foxpaw-ref') !== ref) { try { el.setAttribute('data-foxpaw-ref', ref); } catch { /* svg / readonly */ } }
    return ref;
  };
  const byRef = (ref) => {
    const m = /e(\d+)$/.exec(String(ref || ''));
    let el = null;
    if (m) { const w = E.refs.get(Number(m[1])); el = w ? w.deref() : null; }
    if (!el && ref) { const q = deepAll('[data-foxpaw-ref="' + String(ref).replace(/["\\]/g, '') + '"]'); el = q[0] || null; }
    return el && el.isConnected ? el : null;
  };

  /* ---- element state ---- */
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects || !el.getClientRects().length) return false;
    const b = el.getBoundingClientRect(); // Playwright: a non-empty box
    if (!(b.width > 0 && b.height > 0) && !el.getClientRects()[0].width) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.visibility !== 'collapse' && s.display !== 'none';
  };
  // v1.18.1: aria-disabled counts on the element itself, and on an ancestor only when that
  // ancestor is a widget / composite that can be disabled (Playwright's rule). A plain wrapper
  // <div aria-disabled="true"> (a finished wizard step, a skeleton) no longer marks every button
  // inside it NOT_ENABLED.
  const ARIA_DIS_ROLES = /^(application|button|composite|gridcell|group|input|link|menuitem|scrollbar|separator|tab|checkbox|columnheader|combobox|grid|listbox|menu|menubar|menuitemcheckbox|menuitemradio|option|radio|radiogroup|row|rowheader|searchbox|select|slider|spinbutton|switch|tablist|textbox|toolbar|tree|treegrid|treeitem)$/;
  const enabled = (el) => {
    try { if (el.matches && el.matches(':disabled')) return false; } catch { /* old engines */ }
    if (el.disabled) return false;
    if (attr(el, 'aria-disabled') === 'true') return false;
    for (let p = el.parentElement, i = 0; p && i < 40; p = p.parentElement, i++) {
      if (attr(p, 'aria-disabled') === 'true' && ARIA_DIS_ROLES.test(roleOf(p))) return false;
    }
    return true;
  };
  const IMPLICIT = (el) => {
    if (el.tagName === 'IFRAME') return frameDoc(el) ? 'textbox' : '';
    if (!attr(el, 'role') && /^(LI|DIV|DD|SPAN)$/.test(el.tagName) && el.matches && el.matches(OPTION_SEL) && el.closest && el.closest('[class*="dropdown"],[class*="popper"],[class*="select"],[role="listbox"],dl')) return 'option';
    const t = el.tagName;
    const ty = attr(el, 'type').toLowerCase();
    if (t === 'A' || t === 'AREA') return el.hasAttribute('href') ? 'link' : '';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return (el.multiple || Number(el.size) > 1) ? 'listbox' : 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'OPTION') return 'option';
    if (/^H[1-6]$/.test(t)) return 'heading';
    if (t === 'IMG') return attr(el, 'alt') === '' && el.hasAttribute('alt') ? 'presentation' : 'img';
    if (t === 'INPUT') {
      if (/^(button|submit|reset|image)$/.test(ty)) return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      if (ty === 'number') return 'spinbutton';
      if (ty === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (ty === 'hidden' || ty === 'file' || ty === 'color' || /^(date|time|datetime-local|month|week)$/.test(ty)) return ty === 'hidden' ? '' : 'textbox';
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    }
    if (el.isContentEditable && el.hasAttribute('contenteditable')) return 'textbox';
    return '';
  };
  // v1.18.1: an element the snapshot found clickable without semantics (cursor:pointer, arco-link,
  // row actions) carries data-foxpaw-click="button|link", so role locators find it too
  const roleOf = (el) => tx(attr(el, 'role')).split(' ')[0].toLowerCase() || IMPLICIT(el) || attr(el, 'data-foxpaw-click');
  const byIdIn = (el, id) => { const r = el.getRootNode && el.getRootNode(); return (r && r.getElementById ? r.getElementById(id) : null) || doc.getElementById(id); };
  const labelText = (el) => {
    const parts = [];
    // a <label> wrapping its control: the control's own text (select options, textarea) is not the name
    const own = (n) => { let t = ''; for (const c of n.childNodes) { if (c.nodeType === 3) t += c.nodeValue; else if (c.nodeType === 1 && !/^(SELECT|TEXTAREA|INPUT|OPTION|BUTTON|SCRIPT|STYLE)$/.test(c.tagName)) t += ' ' + own(c); } return t; };
    if (el.labels && el.labels.length) for (const l of el.labels) parts.push(tx(own(l)));
    return tx(parts.join(' '));
  };
  const NAME_FROM_CONTENT = /^(button|link|option|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem|heading|cell|columnheader|rowheader|switch|checkbox|radio|tooltip|row)$/;
  const accName = (el) => {
    const lb = attr(el, 'aria-labelledby');
    if (lb) { const t = tx(lb.split(/\s+/).map((id) => { const n = byIdIn(el, id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ')); if (t) return t; }
    const al = tx(attr(el, 'aria-label')); if (al) return al;
    const t = el.tagName; const ty = attr(el, 'type').toLowerCase();
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(t) && !/^(button|submit|reset|image)$/.test(ty)) {
      const l = labelText(el); if (l) return l;
    }
    if (t === 'INPUT' && /^(button|submit|reset)$/.test(ty)) return tx(el.value || (ty === 'submit' ? 'Submit' : ty === 'reset' ? 'Reset' : ''));
    if ((t === 'INPUT' && ty === 'image') || t === 'IMG') { const alt = tx(attr(el, 'alt')); if (alt) return alt; }
    const role = roleOf(el);
    if (NAME_FROM_CONTENT.test(role) || t === 'BUTTON' || t === 'A' || t === 'SUMMARY' || t === 'LABEL') {
      const c = tx(el.innerText !== undefined ? el.innerText : el.textContent);
      if (c) return c.slice(0, 200);
      const img = el.querySelector && el.querySelector('img[alt]'); if (img && tx(img.alt)) return tx(img.alt);
      const st = el.querySelector && el.querySelector('svg title'); if (st && tx(st.textContent)) return tx(st.textContent);
    }
    const ti = tx(attr(el, 'title')); if (ti) return ti;
    const ph = tx(attr(el, 'placeholder') || attr(el, 'aria-placeholder')); if (ph) return ph;
    if (t === 'SELECT' || role === 'combobox') { const sel = el.querySelector && el.querySelector('[class*="selection-item"],[class*="selected-value"]'); if (sel) return tx(sel.getAttribute('title') || sel.textContent); }
    return '';
  };
  // v1.18.1: menus and dialogs themselves are listed too (Radix / portal layers), so an
  // agent sees that a menu / dialog is open and what it is called
  const INTERACTIVE_ROLES = /^(button|link|checkbox|radio|switch|combobox|listbox|option|menuitem|menuitemcheckbox|menuitemradio|tab|textbox|searchbox|slider|spinbutton|treeitem|gridcell|menu|menubar|dialog|alertdialog)$/;
  const INTERACTIVE_SEL = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,[contenteditable]:not([contenteditable="false"]),[role],[tabindex]:not([tabindex="-1"]),[onclick],iframe,' + OPTION_SEL;
  const isInteractive = (el) => {
    const t = el.tagName;
    if (t === 'IFRAME') return !!frameDoc(el);
    if (!attr(el, 'role') && IMPLICIT(el) === 'option') return !el.matches('.is-disabled,.layui-disabled,[aria-disabled="true"]');
    if (/^(A|AREA)$/.test(t)) return el.hasAttribute('href');
    if (/^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(t)) return !(t === 'INPUT' && attr(el, 'type').toLowerCase() === 'hidden');
    if (el.hasAttribute('contenteditable') && el.isContentEditable) return true;
    const r = tx(attr(el, 'role')).split(' ')[0].toLowerCase();
    if (r) return INTERACTIVE_ROLES.test(r);
    return el.hasAttribute('tabindex') || el.hasAttribute('onclick');
  };

  /* ---- classification view of an element (same semantics as ) ---- */
  const SECRET_RE = new RegExp(a.secret || 'password', 'i');
  const isField = (el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.isContentEditable || !!frameDoc(el);
  // 1.29 a secret is a ONE-LINE key-in box (input) named as one by its own name / id / aria-label / label /
  // autocomplete; a placeholder counts only when short (a long one is instructions: a shop site's 卡密 textarea says
  // 「…如果存在卡号和密码可自行添加分隔符…」). A textarea, rich editor or select is never a password box.
  const hintOf = (el) => {
    const lab = attr(el, 'aria-labelledby') ? attr(el, 'aria-labelledby').split(/\s+/).map((id) => { const n = byIdIn(el, id); return n ? n.textContent : ''; }).join(' ') : '';
    const ph = attr(el, 'placeholder');
    return [attr(el, 'name'), el.id, ph.length <= 20 ? ph : '', attr(el, 'aria-label'), lab, labelText(el)].join(' ');
  };
  const keyable = (el) => el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|image|file|hidden|range|color)$/.test(attr(el, 'type').toLowerCase());
  const isSecret = (el) => {
    if (!isField(el) || !keyable(el)) return false;
    const ty = attr(el, 'type').toLowerCase();
    const ac = attr(el, 'autocomplete').toLowerCase();
    return ty === 'password' || PW.has(el) || /current-password|new-password|one-time-code|^cc-|\scc-/.test(ac) || SECRET_RE.test(hintOf(el));
  };
  // / 1.29 which kind of secret — card (payment class: never fillable by an agent), captcha, otp,
  // stock (商品库存的卡号 / 卡密 / 激活码 / 兑换码 on a page that is NOT about paying — inventory, not a payment card),
  // password (the rest)
  const payCtxOf = (el) => {
    if (/checkout|cashier|payment|\/pay(\/|\?|#|$)/i.test(location.href) || /checkout|cashier|payment|收银台|付款|结算|确认支付|立即支付|订单支付|支付订单|扫码支付|去支付|支付中心|支付页/i.test(doc.title || '')) return true;
    const box = (el.closest && el.closest('form,[role="dialog"],.el-dialog,.modal,.ant-modal,.layui-layer')) || (el.parentElement && el.parentElement.parentElement) || el;
    return /银行|bank|信用卡|credit|debit|储蓄|开户行|持卡人|cardholder/i.test(String(box.textContent || '').slice(0, 3000));
  };
  const secretKindOf = (el) => {
    const ac = attr(el, 'autocomplete').toLowerCase();
    const hint = hintOf(el) + ' ' + ac;
    // 1.25 payment-class = card numbers / CVV and pay / trade passwords, U-shield: never filled by an agent, trusted or not
    if (/(^|\s)cc-|cvv|cvc|cvn|security.?code|银行卡|信用卡|储蓄卡|支付密码|交易密码|付款密码|pay.?pass|payment.?pass|trade.?pass|transaction.?pass|u盾|ukey|安全码/i.test(hint)) return 'card';
    if (/captcha|人机|图形验证|图片验证|滑块/i.test(hint)) return 'captcha'; // a human check: the owner's, or a TRUSTED agent's own reading (1.29 )
    if (/one-time-code|otp|one.?time|验证码|校验码|动态码|短信码|sms.?code|verif\w*.?code|auth.?code/i.test(hint)) return 'otp';
    if (/卡号|card.?(no|num)|卡密|激活码|兑换码|充值码|cd.?key|kami|license.?key|序列号/i.test(hint)) return payCtxOf(el) ? 'card' : 'stock';
    return 'password';
  };
  const clsName = (t) => {
    const lab = attr(t, 'aria-labelledby') ? attr(t, 'aria-labelledby').split(/\s+/).map((id) => { const n = byIdIn(t, id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ') : '';
    const ty = attr(t, 'type').toLowerCase();
    const isInput = t.tagName === 'INPUT';
    const inputBtn = isInput && /^(button|submit|reset|image)$/.test(ty);
    const svgT = t.querySelector && t.querySelector('svg title');
    const img = t.querySelector && t.querySelector('img[alt]');
    return tx(attr(t, 'aria-label')) || tx(lab) || (isInput || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' ? '' : tx(t.innerText !== undefined ? t.innerText : t.textContent)) || (inputBtn ? tx(t.value || attr(t, 'alt')) : '')
      || tx(attr(t, 'title')) || tx(img && img.getAttribute('alt')) || tx(svgT && svgT.textContent) || tx(attr(t, 'data-tooltip') || attr(t, 'data-title') || attr(t, 'data-original-title'));
  };
  const classInfo = (el) => {
    const CLICK = 'button,a[href],input,select,textarea,summary,label,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="option"],[onclick]';
    const t = (el.closest && el.closest(CLICK)) || el;
    const ty = attr(t, 'type').toLowerCase();
    const inputBtn = t.tagName === 'INPUT' && /^(button|submit|reset|image)$/.test(ty);
    const role = attr(t, 'role');
    const icon = [t, ...(t.querySelectorAll ? t.querySelectorAll('i,svg,span,use,img') : [])].slice(0, 12)
      .map((n) => [n.getAttribute && n.getAttribute('class'), n.getAttribute && (n.getAttribute('href') || n.getAttribute('xlink:href')), n.getAttribute && n.getAttribute('data-icon')].filter(Boolean).join(' ')).join(' ');
    const form = t.form || (t.closest && t.closest('form'));
    const submitType = !!(form && (t.type === 'submit' || t.type === 'image') && /^(BUTTON|INPUT)$/.test(t.tagName));
    return {
      found: true, tag: t.tagName, type: ty, role, name: clsName(t).slice(0, 120), icon: icon.slice(0, 300),
      ctx: (() => { const d = t.closest && t.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="popup" i]'); return d ? String(d.innerText || d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600) : ''; })(),
      // …or, outside any dialog, the small block around it (a plan card: 「Pro · $30/月 · Subscribe」)
      near: (() => { if (t.closest && t.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="popup" i]')) return ''; let p = t.parentElement; for (let i = 0; p && p !== document.body && i < 4; i++, p = p.parentElement) { const x = String(p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim(); if (x.length > 300) break; if (/[$€£¥￥]\s?\d|\d\s?(元|美元)|\/\s?(mo|month|月|年|yr)/i.test(x)) return x.slice(0, 300); } return ''; })(),
      buttonish: t.tagName === 'BUTTON' || inputBtn || /^(button|menuitem)$/.test(role), field: isField(el), secret: isSecret(el),
      secretKind: isSecret(el) ? secretKindOf(el) : '',
      inForm: !!form, formAction: form ? (form.action || '') : '', textarea: el.tagName === 'TEXTAREA' || !!el.isContentEditable,
      submitType, navOnly: navOnlyOf(t, form, submitType),
    };
  };
  const valueOf = (el) => {
    if (el.tagName === 'SELECT') return [...el.selectedOptions].map((o) => tx(o.label || o.textContent)).join(', ');
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
      const ty = attr(el, 'type').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return el.checked ? 'checked' : '';
      if (ty === 'file') return [...(el.files || [])].map((f) => f.name).join(', ');
      return String(el.value == null ? '' : el.value);
    }
    if (el.isContentEditable) return tx(el.innerText !== undefined ? el.innerText : el.textContent);
    { const d = frameDoc(el); if (d) return tx(d.body.innerText !== undefined ? d.body.innerText : d.body.textContent); }
    return undefined;
  };
  const describe = (el, rich) => {
    const role = roleOf(el);
    const secret = isSecret(el);
    const o = { ref: refOf(el), role, name: accName(el).slice(0, 120), tag: el.tagName, type: attr(el, 'type').toLowerCase() || '' };
    const v = valueOf(el);
    if (v !== undefined) o.value = secret && v ? '•••' : String(v).slice(0, 100);
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(o.type)) o.checked = !!el.checked;
    else if (attr(el, 'aria-checked')) o.checked = attr(el, 'aria-checked') === 'true';
    if (!enabled(el)) o.disabled = true;
    if (attr(el, 'aria-expanded')) o.expanded = attr(el, 'aria-expanded') === 'true';
    if (el.href && el.tagName === 'A') o.href = String(el.href).slice(0, 300);
    if (el.getRootNode && el.getRootNode() !== doc) o.shadow = true;
    if (secret) o.secret = true;
    if (el.tagName === 'SELECT') o.options = [...el.options].slice(0, 25).map((x) => tx(x.label || x.textContent));
    if (el.readOnly) o.readonly = true;
    if (rich) { o.visible = visible(el); o.enabled = enabled(el); o.info = classInfo(el); }
    return o;
  };

  /* ---- locators: ref | role(+name) | label | text | selector | option ---- */
  const pick = (els, getText, want, exact) => {
    if (want === undefined || want === null || want === '') return els;
    const w = norm(want);
    const ex = els.filter((e) => norm(getText(e)) === w);
    if (ex.length || exact) return ex;
    const sub = els.filter((e) => norm(getText(e)).includes(w));
    if (sub.length) return sub;
    // 「确 定」: Ant Design spaces two-character CJK button labels
    const ns = (v) => norm(v).replace(/\s+/g, '');
    const w2 = ns(want);
    return els.filter((e) => ns(getText(e)) === w2 || ns(getText(e)).includes(w2));
  };
  const resolveEls = (spec) => {
    const rs = roots();
    if (spec.ref) { const el = byRef(spec.ref); return el ? [el] : []; }
    if (spec.selector) {
      try { return deepAll(String(spec.selector), rs); } catch { throw new Error('BAD_SELECTOR'); }
    }
    if (spec.role) {
      const want = String(spec.role).toLowerCase();
      const pool = deepAll('[role],a,area,button,input,select,textarea,summary,option,h1,h2,h3,h4,h5,h6,img,[contenteditable],[data-foxpaw-click]', rs).filter((e) => roleOf(e) === want);
      return pick(pool, accName, spec.name, spec.exact);
    }
    if (spec.label) {
      const pool = deepAll('input:not([type="hidden"]),select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="searchbox"],[role="listbox"],iframe', rs).filter((e) => e.tagName !== 'IFRAME' || frameDoc(e));
      const lbl = (e) => {
        const lb = attr(e, 'aria-labelledby');
        const t = lb ? lb.split(/\s+/).map((id) => { const n = byIdIn(e, id); return n ? n.textContent : ''; }).join(' ') : '';
        return tx(t) || tx(attr(e, 'aria-label')) || labelText(e);
      };
      let hits = pick(pool, lbl, spec.label, spec.exact);
      if (!hits.length) hits = pick(pool, (e) => attr(e, 'placeholder'), spec.label, spec.exact);
      if (!hits.length) hits = pick(pool, (e) => attr(e, 'name'), spec.label, true);
      // 1.29 a form-item label that is not tied to its control (Element / Ant / layui forms: <label for="prop">
      // with no such id) — the first field inside the same form item
      if (!hits.length) {
        const labs = deepAll('label,.el-form-item__label,.ant-form-item-label,.layui-form-label,.ivu-form-item-label,.arco-form-item-label,.n-form-item-label,th', rs);
        const lh = pick(labs, (e) => String(e.innerText !== undefined ? e.innerText : e.textContent).replace(/^[\s*＊:：]+|[\s*＊:：]+$/g, ''), spec.label, spec.exact);
        const out = [];
        for (const l of lh) {
          const box = (l.closest && l.closest('.el-form-item,.ant-form-item,.layui-form-item,.ivu-form-item,.arco-form-item,.n-form-item,.form-group,.form-item,tr')) || l.parentElement;
          const inBox = box ? pool.filter((e) => box.contains(e) && e !== l) : [];
          const c = inBox.find((e) => visible(e)) || inBox[0];
          if (c && !out.includes(c)) out.push(c);
        }
        hits = out;
      }
      return hits;
    }
    if (spec.text !== undefined) {
      const want = norm(spec.text);
      const own = (e) => (e.tagName === 'INPUT' ? e.value : (e.innerText !== undefined ? e.innerText : e.textContent));
      const pool = deepAll('body *', rs).filter((e) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HTML|HEAD)$/.test(e.tagName));
      const match = (e, exact) => { const t = norm(own(e)); return exact ? t === want : t.includes(want); };
      const innermost = (list) => list.filter((e) => !list.some((o) => o !== e && e.contains(o)));
      let hits = innermost(pool.filter((e) => match(e, true)));
      if (!hits.length && !spec.exact) hits = innermost(pool.filter((e) => match(e, false)));
      return hits;
    }
    if (spec.option !== undefined) {
      let pool = deepAll(OPTION_SEL + ',.ant-cascader-menu-item,.ivu-cascader-menu-item,.arco-cascader-option', rs).filter(visible).filter((e) => !(e.matches && e.matches('.is-disabled,.layui-disabled,[aria-disabled="true"],.ant-cascader-menu-item-disabled')));
      // 1.29 a cascader level = the col-th visible menu column
      if (spec.col !== undefined) { const cols = deepAll(CASCADE_COLS, rs).filter(visible); const col = cols[Number(spec.col)]; pool = col ? pool.filter((e) => col.contains(e)) : []; }
      const t = (e) => attr(e, 'title') || attr(e, 'aria-label') || e.textContent;
      const hits = pick(pool, t, spec.option, spec.exact);
      return hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
    }
    return [];
  };

  /* ---- geometry / hit test ---- */
  const deepFromPoint = (x, y) => {
    let el = doc.elementFromPoint(x, y);
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
    return el;
  };
  const hitsTarget = (el, hit) => {
    if (!hit) return false;
    if (hit === el || el.contains(hit)) return true;
    if (el.shadowRoot && el.shadowRoot.contains(hit)) return true;
    let n = hit; // composed ancestors (hit inside a shadow tree hosted by el)
    for (let i = 0; n && i < 50; i++) { if (n === el) return true; n = n.parentNode || n.host; }
    const lab = hit.closest && hit.closest('label');
    if (lab && lab.control === el) return true;
    return false;
  };
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
  const describeHit = (h) => (h ? (tx(clsName(h) || accName(h)).slice(0, 40) || h.tagName.toLowerCase() + (h.id ? '#' + h.id : '') + (h.className && typeof h.className === 'string' ? '.' + h.className.split(/\s+/)[0] : '')) : '');

  /* ---- events ---- */
  const fire = (el, type, Ctor, init) => { try { el.dispatchEvent(new (Ctor || Event)(type, { bubbles: true, cancelable: true, composed: true, ...(init || {}) })); } catch { el.dispatchEvent(new Event(type, { bubbles: true })); } };
  const focusEl = (el) => {
    let fired = false;
    const f = () => { fired = true; };
    el.addEventListener('focus', f, { once: true });
    try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    el.removeEventListener('focus', f);
    if (!fired) { // background tabs: focus() moves activeElement without events
      try { el.dispatchEvent(new FocusEvent('focus', { bubbles: false })); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true })); } catch { /* noop */ }
    }
  };
  const blurEl = (el) => {
    let fired = false;
    const f = () => { fired = true; };
    el.addEventListener('blur', f, { once: true });
    try { el.blur(); } catch { /* noop */ }
    el.removeEventListener('blur', f);
    if (!fired) { try { el.dispatchEvent(new FocusEvent('blur', { bubbles: false })); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true })); } catch { /* noop */ } }
  };
  const protoSetter = (el, prop) => {
    let p = Object.getPrototypeOf(el);
    while (p) { const d = Object.getOwnPropertyDescriptor(p, prop); if (d && d.set) return d.set; p = Object.getPrototypeOf(p); }
    return null;
  };
  const setNative = (el, v) => {
    const set = protoSetter(el, 'value');
    if (set) set.call(el, v); else el.value = v;
  };
  const truthy = (v) => v === true || /^(true|on|yes|1|checked|是|勾选|选中)$/i.test(String(v).trim());
  const kindOf = (el) => {
    const t = el.tagName; const ty = attr(el, 'type').toLowerCase(); const role = tx(attr(el, 'role')).toLowerCase();
    if (el.closest && el.closest('.ant-picker') && t === 'INPUT') return 'datepicker';
    if (t === 'IFRAME') return frameDoc(el) ? 'richframe' : 'text';
    if (el.closest && el.closest('.el-cascader,.ant-cascader,.ivu-cascader,.arco-cascader') && t !== 'SELECT') return 'cascader';
    if (el.closest && el.closest(COMBO_BOX) && t !== 'SELECT' && !el.isContentEditable) return 'combobox';
    if (t === 'SELECT') return 'select';
    if (t === 'TEXTAREA') return 'textarea';
    if (t === 'INPUT') {
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'file') return 'file';
      if (/^(date|time|datetime-local|month|week)$/.test(ty)) return 'date';
      if (ty === 'number' || ty === 'range') return 'number';
      if (ty === 'email') return 'email';
      if (ty === 'password') return 'password';
      if (role === 'combobox' && el.readOnly) return 'combobox';
      return 'text';
    }
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (role === 'radio') return 'radio';
    if (role === 'combobox' || role === 'listbox') return 'combobox';
    if (el.isContentEditable) return 'contenteditable';
    if (role === 'textbox') return 'contenteditable';
    return 'text';
  };

  // keep the snapshot in document order when an element is added after the main query
  const insertInOrder = (list, el) => {
    const FOLLOWING = 4;
    let i = list.findIndex((x) => { try { const pos = el.compareDocumentPosition(x); return !!(pos & FOLLOWING) && !(pos & 1); } catch { return false; } });
    if (i < 0) i = list.length;
    list.splice(i, 0, el);
  };
  /* ---- card radios / checkboxes: the hidden input's stand-in ---- */
  const coveredInput = (inp) => {
    if (!visible(inp)) return true;
    const r = inp.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return true;
    if (Number(getComputedStyle(inp).opacity) === 0) return true;
    const vw = W.innerWidth || doc.documentElement.clientWidth; const vh = W.innerHeight || doc.documentElement.clientHeight;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > vw || y > vh) return false; // off screen: cannot tell, keep the input
    const hit = deepFromPoint(x, y);
    return !!hit && !hitsTarget(inp, hit);
  };
  const proxyOf = (inp) => {
    for (const l of inp.labels || []) if (visible(l)) return l;
    const l2 = inp.closest && inp.closest('label');
    if (l2 && visible(l2)) return l2;
    for (let p = inp.parentElement, i = 0; p && p !== doc.body && i < 4; p = p.parentElement, i++) {
      if (!visible(p)) continue;
      if (/^(radio|checkbox|option|switch|menuitemradio|menuitemcheckbox)$/.test(attr(p, 'role')) || getComputedStyle(p).cursor === 'pointer') return p;
    }
    for (let p = inp.parentElement, i = 0; p && p !== doc.body && i < 3; p = p.parentElement, i++) {
      if (visible(p) && tx(p.innerText !== undefined ? p.innerText : p.textContent)) return p;
    }
    return null;
  };
  // fill / read on a label or a card stand-in act on the real control
  const controlOf = (el) => {
    if (!el) return el;
    const pf = attr(el, 'data-foxpaw-proxy-for');
    if (pf) { const c = byRef(pf); if (c) return c; }
    if (el.tagName === 'LABEL' && el.control) return el.control;
    return el;
  };
  /* ---- pure navigation: same-site link, or a link / menu item / tab in a nav container ---- */
  const navOnlyOf = (t, form, submitType) => {
    if (form || submitType) return false;
    const base = (h) => String(h || '').split('.').slice(-2).join('.');
    let link = false;
    if (t.tagName === 'A' && t.hasAttribute('href')) {
      const raw = attr(t, 'href').trim();
      try { const u = new URL(t.href, location.href); link = /^https?:$/.test(u.protocol) && !/^(#|javascript:)/i.test(raw) && !t.hasAttribute('download') && base(u.hostname) === base(location.hostname); } catch { link = false; }
    }
    let navBox = false;
    for (let p = t, i = 0; p && p !== doc.body && i < 14; p = p.parentElement, i++) {
      const r = attr(p, 'role');
      if (/^(menu|dialog|alertdialog|listbox)$/.test(r) || p.tagName === 'FORM') break;
      const cl = typeof p.className === 'string' ? p.className : '';
      if (/^(NAV|ASIDE)$/.test(p.tagName) || /^(navigation|menubar|tablist)$/.test(r)
        || (/(^|[\s_-])(menu|nav|navbar|sider|sidebar|breadcrumb)([\s_-]|$)/i.test(cl) && !/dropdown|popover|popup|context|modal|drawer/i.test(cl))) { navBox = true; break; }
    }
    const linkish = t.tagName === 'A' || /^(link|menuitem|tab|treeitem)$/.test(attr(t, 'role')) || !!(t.closest && t.closest('li'));
    return link || (navBox && linkish);
  };

  /* ---- OBSCURED: when the element on top IS the thing to click ----
     'card'  : the target is a radio / checkbox input (or its stand-in) and the point lands on its
               own card (a common ancestor within 4 levels) — not on another control;
     'same'  : a control with the same role + name sits on top (a modal's real 「确定」 above a stale
               copy) — clicking the point clicks that one;
     'parent': the point lands on an ancestor of the target within 3 levels (target has
               pointer-events:none) and on no other control.
     Anything else stays OBSCURED. */
  const CTRL_SEL = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[data-foxpaw-click]';
  const retargetOf = (el, hit) => {
    if (!hit || hit === doc.body || hit === doc.documentElement) return '';
    const ctl = hit.closest ? hit.closest(CTRL_SEL) : null;
    const target = controlOf(el);
    const isToggle = target && target.tagName === 'INPUT' && /^(radio|checkbox)$/.test(attr(target, 'type').toLowerCase());
    if (ctl && ctl !== el && ctl !== target && !ctl.contains(el)) {
      const lab = ctl.tagName === 'LABEL' ? ctl : null;
      if (lab && lab.control === target) return 'card';
      if (roleOf(ctl) === roleOf(el) && norm(clsName(ctl) || accName(ctl)) && norm(clsName(ctl) || accName(ctl)) === norm(clsName(el) || accName(el))) return 'same';
      return '';
    }
    if (isToggle) {
      for (let p = target.parentElement, i = 0; p && p !== doc.body && i < 4; p = p.parentElement, i++) if (p.contains(hit)) return 'card';
    }
    for (let p = el.parentElement, i = 0; p && p !== doc.body && i < 3; p = p.parentElement, i++) if (p === hit) return 'parent';
    return '';
  };
  /* ---- did the click do anything? ---- */
  const stateOf = (el) => {
    const t = controlOf(el);
    const det = el.closest && el.closest('details');
    return [t && t.checked, t && t.value, attr(el, 'aria-expanded'), attr(el, 'aria-pressed'), attr(el, 'aria-selected'), det ? det.open : null].join('|');
  };
  const NOISE_CLS = /wave|ripple|click-animating|tooltip|focus-visible|hover/i;
  const armEffect = (el) => {
    const old = W.__fpEffect;
    if (old) { try { old.mo.disconnect(); } catch { /* noop */ } try { if (old.po) old.po.disconnect(); } catch { /* noop */ } }
    const st = { el, url: location.href, state: stateOf(el), active: doc.activeElement, muts: 0, net: 0, submits: 0, subEv: [], invalid: 0, at: Date.now() };
    const mine = (n) => n === el; // the clicked element's own hover / active / focus classes are not an effect
    st.mo = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'attributes') {
          if (/^data-foxpaw/.test(m.attributeName || '')) continue;
          if (mine(m.target) && /^(class|style)$|animating/.test(m.attributeName || '')) continue;
          if (m.attributeName === 'class' && NOISE_CLS.test(String(m.target.className || '') + ' ' + String(m.oldValue || ''))) continue;
        }
        if (m.type === 'childList') {
          const nodes = [...m.addedNodes, ...m.removedNodes];
          if (nodes.length && nodes.every((n) => n.nodeType === 1 && NOISE_CLS.test(String(n.className || '')))) continue;
        }
        st.muts++;
      }
    });
    try { st.mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true }); } catch { /* noop */ }
    try { if (W.PerformanceObserver) { st.po = new PerformanceObserver((l) => { st.net += l.getEntries().length; }); st.po.observe({ type: 'resource', buffered: false }); } } catch { st.po = null; }
    if (!W.__fpEffectHooked) {
      W.__fpEffectHooked = true;
      doc.addEventListener('submit', (e) => { const s0 = W.__fpEffect; if (s0) { s0.submits++; s0.subEv.push(e); } }, true);
      doc.addEventListener('invalid', () => { const s0 = W.__fpEffect; if (s0) s0.invalid++; }, true);
    }
    W.__fpEffect = st;
  };

  /* ================= ops ================= */
  if (op === 'snapshot') {
    // 1.32 other extensions' floating widgets (a shadow root reset with :host{all:initial} or one that loads
    // chrome-extension:// files; a light-DOM box that does) are not the page — neither their text nor their buttons
    const xr = extOverlays();
    const rs = roots().filter((r) => !xr.roots.has(r));
    const max = a.max || 200;
    const forms = [...doc.querySelectorAll('form')].map((f, i) => {
      const btn = f.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
      return { index: i, action: f.action || '', method: (f.method || 'get').toUpperCase(), submitText: btn ? accName(btn) : '' };
    });
    const formEls = [...doc.querySelectorAll('form')];
    // 1.28.1 a time budget — a huge page (tens of thousands of nodes) returns a partial list (slow:true)
    // instead of running until the command times out
    const t0 = Date.now();
    const budget = Number(a.budgetMs) || 0;
    let slow = false;
    const over = () => { if (!slow && budget && Date.now() - t0 > budget) slow = true; return slow; };
    let els = [];
    { let n = 0; for (const e of deepAll(INTERACTIVE_SEL, rs)) { if ((++n & 63) === 0 && over()) break; if (isInteractive(e) && visible(e) && !xr.inLight(e)) els.push(e); } }
    const extra = new Map(); // el -> overrides for its entry
    // card radios / checkboxes whose <input> is hidden or covered: the label / card is the ref
    for (const inp of slow ? [] : deepAll('input[type="radio"],input[type="checkbox"]', rs)) {
      if (over()) break;
      if (!coveredInput(inp)) continue;
      const px = proxyOf(inp);
      if (!px) continue;
      try { px.setAttribute('data-foxpaw-proxy-for', refOf(inp)); } catch { /* noop */ }
      const at = els.indexOf(inp);
      if (els.includes(px)) { if (at >= 0) els.splice(at, 1); } else if (at >= 0) els[at] = px; else insertInOrder(els, px);
      extra.set(px, { role: roleOf(inp), name: (accName(inp) || tx(px.innerText !== undefined ? px.innerText : px.textContent)).slice(0, 120), checked: !!inp.checked,
        proxyFor: refOf(inp), proxy: px.tagName === 'LABEL' ? 'label' : 'card', type: attr(inp, 'type').toLowerCase(), disabled: !enabled(inp) || undefined });
    }
    // clickables without semantics: cursor:pointer + link/button-ish class, row actions
    const have = new Set(els);
    const inInteractive = (e) => { for (let p = e.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) if (have.has(p) || (isInteractive(p) && /^(A|BUTTON|SUMMARY|LABEL)$/.test(p.tagName))) return true; return false; };
    const CLICKISH = 'a:not([href]),[class*="link"],[class*="btn"],[class*="button"],[class*="action"],[class*="click"],[class*="operat"],td span,td a,td div,td i,[role="row"] span,[role="gridcell"] span';
    const clicks = [];
    let scanned = 0;
    for (const e of slow ? [] : deepAll(CLICKISH, rs)) {
      if (++scanned > 4000 || ((scanned & 63) === 0 && over())) break;
      if (have.has(e) || /^(BODY|HTML|SVG|PATH|USE|INPUT|SELECT|TEXTAREA|OPTION|LABEL|FORM|TABLE|TBODY|TR|TD|UL|OL)$/.test(e.tagName.toUpperCase()) || xr.inLight(e)) continue;
      const cs = getComputedStyle(e);
      if (cs.cursor !== 'pointer' || !visible(e)) continue;
      const par = e.parentElement;
      if (par && getComputedStyle(par).cursor === 'pointer' && (attr(par, 'class').match(/link|btn|button|action|click|operat/i) || par.tagName === 'A')) continue; // keep the outermost
      const name = tx(attr(e, 'aria-label') || attr(e, 'title') || (e.innerText !== undefined ? e.innerText : e.textContent));
      if (!name || name.length > 60) continue;
      if (e.querySelector && e.querySelector('a[href],button,input,select,textarea,[role="button"],[role="link"]')) continue;
      if (inInteractive(e)) continue;
      clicks.push(e);
    }
    for (const e of clicks) {
      const r = e.tagName === 'A' || /link/i.test(attr(e, 'class')) ? 'link' : 'button';
      try { if (!attr(e, 'role') && attr(e, 'data-foxpaw-click') !== r) e.setAttribute('data-foxpaw-click', r); } catch { /* noop */ }
      insertInOrder(els, e); have.add(e); extra.set(e, { clickable: true });
    }
    // open layers first (Radix / portal menus, dialogs, popovers render at the END of
    // <body>; with a long page they fell past maxElements and never showed up)
    const layerOf = (e) => {
      for (let p = e, i = 0; p && p !== doc.body && p !== doc.documentElement && i < 40; p = p.parentElement || (p.getRootNode && p.getRootNode().host), i++) {
        const r = attr(p, 'role');
        if (/^(dialog|alertdialog|menu|listbox)$/.test(r) || attr(p, 'aria-modal') === 'true') return r || 'dialog';
        if (p.hasAttribute && (p.hasAttribute('data-radix-popper-content-wrapper') || p.hasAttribute('data-radix-portal'))) return 'popover';
        const cl = typeof p.className === 'string' ? p.className : '';
        if (/(^|[\s_-])(modal|drawer|dropdown|popover|popup|picker-dropdown|select-dropdown|trigger-popup)([\s_-]|$)/i.test(cl)) {
          const st = getComputedStyle(p);
          if (st.position === 'fixed' || st.position === 'absolute' || /modal|drawer/i.test(cl)) return /modal|drawer/i.test(cl) ? 'dialog' : 'popover';
        }
      }
      return '';
    };
    const layered = els.map((e) => ({ e, layer: layerOf(e) }));
    els = [...layered.filter((x) => x.layer), ...layered.filter((x) => !x.layer)].map((x) => x.e);
    const layerMap = new Map(layered.map((x) => [x.e, x.layer]));
    const off = Math.max(0, Number(a.offset) || 0);
    const elements = els.slice(off, off + max).map((el) => {
      const o = describe(el, false);
      const f = el.closest && el.closest('form');
      o.formIndex = f ? formEls.indexOf(f) : -1;
      const x = extra.get(el);
      if (x) for (const [k, v] of Object.entries(x)) if (v !== undefined) o[k] = v;
      if (x && x.proxyFor) delete o.value;
      if (/^(dialog|alertdialog|menu|menubar|listbox)$/.test(o.role) && !o.name) {
        const h = el.querySelector && el.querySelector('h1,h2,h3,h4,[class*="title"],[class*="header"]');
        if (h) o.name = tx(h.innerText !== undefined ? h.innerText : h.textContent).slice(0, 80);
      }
      if (layerMap.get(el)) o.layer = layerMap.get(el);
      // row actions: which row this 「编辑 / 删除」 belongs to
      const row = el.closest && el.closest('tr,[role="row"]');
      if (row && !/^(dialog|alertdialog|menu|listbox)$/.test(o.role)) {
        const cells = [...row.children].filter((c) => !c.contains(el)).map((c) => tx(c.innerText !== undefined ? c.innerText : c.textContent)).filter(Boolean);
        const rt = cells.slice(0, 3).join(' | ').slice(0, 80);
        if (rt) o.row = rt;
      }
      return o;
    });
    const iframes = deepAll('iframe,frame', rs).filter(visible).map((f) => { const r = f.getBoundingClientRect(); return { rect: [r.left + (f.clientLeft || 0), r.top + (f.clientTop || 0), f.clientWidth || r.width, f.clientHeight || r.height], src: f.src || '', name: attr(f, 'name') || attr(f, 'title') }; });
    // 1.32 the whole readable text (no 6000 cap — the worker pages it with textOffset / textLimit). body.innerText
    // never holds <style> / <script>; open shadow roots are walked for rendered text only (their <style> was what
    // filled the old cap with CSS); other extensions' widgets are left out.
    let text = doc.body ? (doc.body.innerText !== undefined ? doc.body.innerText : doc.body.textContent) : '';
    for (const box of xr.light) { const t = box.innerText; if (t && t.trim()) text = text.replace(t, ''); }
    for (const r of rs.slice(1)) { const t = shadowText(r); if (t) text += '\n' + t; }
    text = String(text).replace(/\n{3,}/g, '\n\n');
    over();
    const imgs = imageWeight(String(text).trim().length);
    let subframes = 0;
    for (const f of deepAll('iframe,frame', rs)) { const src = attr(f, 'src'); if (attr(f, 'srcdoc') || (src && !/^about:/i.test(src) && !/^javascript:/i.test(src))) subframes++; }
    return { title: doc.title, url: location.href, text: String(text).slice(0, a.textMax || 2000000), forms, elements, total: els.length, truncated: els.length > max || slow || undefined, slow: slow || undefined, iframes, subframes,
      overlaysSkipped: xr.count || undefined, images: imgs, challenge: challengeOfPage() || undefined };
  }
  // 1.26 a sign-in form: the visible password box (never a payment / code box), the account box before
  // it (or alone, on a username-first page) and the button that sends it. No values are read.
  if (op === 'loginFields') {
    const rs = roots();
    const inputs = deepAll('input', rs).filter((el) => visible(el) && enabled(el) && !el.readOnly);
    const isPw = (el) => attr(el, 'type').toLowerCase() === 'password' || PW.has(el);
    const pws = inputs.filter(isPw);
    const card = pws.some((el) => secretKindOf(el) === 'card');
    const pw = pws.find((el) => secretKindOf(el) === 'password') || null;
    const userish = (el) => /^(text|email|tel|)$/.test(attr(el, 'type').toLowerCase()) && !isPw(el) && !isSecret(el);
    const score = (el) => {
      const ac = attr(el, 'autocomplete').toLowerCase();
      const h = [attr(el, 'name'), el.id, attr(el, 'placeholder'), attr(el, 'aria-label'), labelText(el)].join(' ');
      let n = 0;
      if (/username|email/.test(ac)) n += 4;
      if (attr(el, 'type').toLowerCase() === 'email') n += 3;
      if (/user|login|account|e-?mail|phone|mobile|账号|帐号|用户名|邮箱|手机|登录名/i.test(h)) n += 2;
      if (/search|搜索|keyword|coupon|captcha|验证码/i.test(h) || attr(el, 'type').toLowerCase() === 'search') n -= 6;
      return n;
    };
    let user = null;
    if (pw) {
      const form = pw.form || (pw.closest && pw.closest('form'));
      const scope = inputs.filter((el) => userish(el) && (!form || form.contains(el)) && (el.compareDocumentPosition(pw) & 4) && score(el) > -3);
      user = scope.sort((x, y) => score(y) - score(x) || (scope.indexOf(y) - scope.indexOf(x)))[0] || null;
    } else {
      const c = inputs.filter((el) => userish(el) && score(el) >= 2);
      user = c.sort((x, y) => score(y) - score(x))[0] || null;
    }
    const base = pw || user;
    const form = base && (base.form || (base.closest && base.closest('form')));
    const GO = /^\s*(登\s*录|登入|立即登录|账号登录|log\s*-?\s*in|sign\s*-?\s*in|continue|next|下一步|继续|进入|确定|submit)\b/i;
    const btns = deepAll('button,input[type="submit"],input[type="image"],[role="button"]', rs).filter((b) => visible(b) && enabled(b) && b !== base);
    const named = (b) => GO.test(clsName(b));
    let btn = null;
    if (form) btn = btns.find((b) => (b.form === form || form.contains(b)) && named(b)) || btns.find((b) => (b.form === form || form.contains(b)) && b.type === 'submit') || null;
    if (!btn && base) btn = btns.find((b) => named(b) && !/注册|sign\s*up|register|forgot|忘记/i.test(clsName(b))) || null;
    return { pw: pw ? describe(pw, true) : null, user: user ? describe(user, true) : null, btn: btn ? describe(btn, true) : null, card };
  }
  if (op === 'loginSubmit') {
    const el = byRef(a.ref);
    if (!el) return { ok: false };
    const f = el.form || (el.closest && el.closest('form'));
    if (f && typeof f.requestSubmit === 'function') { try { f.requestSubmit(); return { ok: true, via: 'requestSubmit' }; } catch { /* fall through */ } }
    fire(el, 'keydown', KeyboardEvent, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
    fire(el, 'keyup', KeyboardEvent, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
    return { ok: true, via: 'enter' };
  }
  if (op === 'resolve') {
    let els;
    try { els = resolveEls(a.spec || {}); } catch (e) { return { error: e.message === 'BAD_SELECTOR' ? 'BAD_SELECTOR' : 'RESOLVE_FAILED', message: String(e.message || e) }; }
    const vis = els.filter(visible);
    const list = (vis.length ? vis : els).slice(0, 15);
    return { count: els.length, visibleCount: vis.length, cands: list.map((el) => describe(el, true)) };
  }
  if (op === 'point') {
    const el = byRef(a.ref);
    if (!el) return { gone: true };
    if (a.arm) {
      // watch what the click is about to do: a form submit or link follow that is
      // NOT prevented means a navigation is coming (so the background waits for it)
      const st = W.__fpNavArm = { ev: [], unload: false, at: Date.now() };
      if (!W.__fpNavHooked) {
        W.__fpNavHooked = true;
        doc.addEventListener('submit', (e) => { if (W.__fpNavArm) W.__fpNavArm.ev.push(e); }, true);
        doc.addEventListener('click', (e) => { const l = e.composedPath ? e.composedPath().find((n) => n && n.tagName === 'A' && n.hasAttribute('href')) : null; if (l && W.__fpNavArm) { W.__fpNavArm.ev.push(e); W.__fpNavArm.link = l; } }, true);
        W.addEventListener('beforeunload', () => { if (W.__fpNavArm) W.__fpNavArm.unload = true; }, true);
      }
      void st;
      armEffect(el);
    }
    if (!visible(el)) return { visible: false };
    let r = el.getBoundingClientRect();
    const vw = W.innerWidth || doc.documentElement.clientWidth; const vh = W.innerHeight || doc.documentElement.clientHeight;
    const inView = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
    let scrolled = false;
    if (a.scroll !== false && !inView) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch { el.scrollIntoView(); }
      const r1 = el.getBoundingClientRect();
      scrolled = Math.abs(r1.top - r.top) > 0.5 || Math.abs(r1.left - r.left) > 0.5; // only a real move counts
      r = r1;
    }
    // centre of the part inside the viewport
    const l = Math.max(r.left, 0), t = Math.max(r.top, 0), rr = Math.min(r.right, vw), bb = Math.min(r.bottom, vh);
    const x = rr > l ? (l + rr) / 2 : r.left + r.width / 2;
    const y = bb > t ? (t + bb) / 2 : r.top + r.height / 2;
    const hit = deepFromPoint(x, y);
    const ok = hitsTarget(el, hit);
    const rt = ok ? '' : retargetOf(el, hit);
    return { rect: rectOf(el), x, y, hitOk: ok, retarget: rt || undefined, obscuredBy: ok ? '' : describeHit(hit), enabled: enabled(el), scrolled, name: (clsName(el) || accName(el)).slice(0, 80), hidden: doc.visibilityState === 'hidden' };
  }
  if (op === 'clickDom') {
    const el = byRef(a.ref);
    if (!el) return { ok: false, error: 'gone' };
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch { /* noop */ }
    const r = el.getBoundingClientRect(); const init = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: W };
    fire(el, 'pointerdown', W.PointerEvent || MouseEvent, init); fire(el, 'mousedown', MouseEvent, init);
    focusEl(el);
    fire(el, 'pointerup', W.PointerEvent || MouseEvent, init); fire(el, 'mouseup', MouseEvent, init);
    el.click();
    return { ok: true, clicked: (clsName(el) || accName(el) || el.tagName).slice(0, 80) };
  }
  if (op === 'navHint') {
    const st = W.__fpNavArm;
    if (!st) return { expect: false };
    W.__fpNavArm = null;
    if (st.unload) return { expect: true };
    for (const e of st.ev) {
      if (e.defaultPrevented) continue;
      if (e.type === 'submit') return { expect: true };
      const l = st.link; const h = l ? String(l.getAttribute('href') || '') : '';
      if (l && !/^(#|javascript:)/i.test(h) && !(l.target && l.target !== '_self') && !l.hasAttribute('download')) return { expect: true };
    }
    return { expect: false };
  }
  if (op === 'effect') {
    // what the last armed click changed (polled by the background for a short window)
    const st = W.__fpEffect;
    if (!st) return { armed: false };
    const el = st.el;
    const sig = [];
    if (location.href !== st.url) sig.push('url');
    if (st.muts) sig.push('dom');
    if (st.net) sig.push('network');
    if (st.submits) sig.push('submit');
    if (st.invalid) sig.push('invalid');
    if (el && el.isConnected && stateOf(el) !== st.state) sig.push('state');
    if (doc.activeElement !== st.active && doc.activeElement && doc.activeElement !== doc.body && doc.activeElement !== el) sig.push('focus');
    if (el && !el.isConnected) sig.push('detached');
    const t = el && el.isConnected ? (el.closest && el.closest('button,input')) || el : null;
    const form = t && (t.form || (t.closest && t.closest('form')));
    const submitBtn = !!(t && form && /^(BUTTON|INPUT)$/.test(t.tagName) && (t.type === 'submit' || t.type === 'image'));
    const summary = !!(el && el.isConnected && el.closest && el.closest('summary') && el.closest('summary').parentElement && el.closest('summary').parentElement.tagName === 'DETAILS');
    const ctl = el && el.isConnected ? controlOf(el) : null;
    const toggle = !!(ctl && ctl.tagName === 'INPUT' && /^(radio|checkbox)$/.test(attr(ctl, 'type').toLowerCase()));
    if (a.done) { try { st.mo.disconnect(); } catch { /* noop */ } try { if (st.po) st.po.disconnect(); } catch { /* noop */ } W.__fpEffect = null; }
    const prevented = st.subEv.filter((e) => e.defaultPrevented).length; // read now: the page's handlers have run
    return { armed: true, sig, muts: st.muts, net: st.net, submits: st.submits, prevented, invalid: st.invalid, submitBtn, summary, toggle,
      radioOn: toggle && attr(ctl, 'type').toLowerCase() === 'radio' && ctl.checked };
  }
  if (op === 'fallback') {
    // the click did nothing visible — the one native action this element stands for
    const el = byRef(a.ref);
    if (!el) return { ok: false, error: 'gone' };
    if (a.how === 'details') {
      const det = el.closest('summary').parentElement;
      det.open = !det.open;
      return { ok: true, how: 'details.open', open: det.open };
    }
    if (a.how === 'toggle') {
      const c = controlOf(el);
      const before = c.checked;
      c.click(); // native toggle + input/change, what the label would have done
      return { ok: c.checked !== before || (attr(c, 'type') === 'radio' && c.checked), how: 'input.click', checked: c.checked };
    }
    if (a.how === 'submit') {
      const t = (el.closest && el.closest('button,input')) || el;
      const form = t.form || t.closest('form');
      if (!form) return { ok: false, error: 'no form' };
      if (form.checkValidity && !form.checkValidity()) {
        const bad = [...form.elements].filter((x) => x.validity && !x.validity.valid).slice(0, 5).map((x) => accName(x) || attr(x, 'name') || x.tagName.toLowerCase());
        return { ok: false, how: 'requestSubmit', invalid: bad };
      }
      try { if (form.requestSubmit) form.requestSubmit(t.type === 'submit' || t.type === 'image' ? t : undefined); else form.submit(); } catch (e) { return { ok: false, error: String(e.message || e) }; }
      return { ok: true, how: 'requestSubmit' };
    }
    return { ok: false, error: 'bad how' };
  }
  if (op === 'iframes') {
    return deepAll('iframe,frame').map((f) => { const r = f.getBoundingClientRect(); return { x: r.left + (f.clientLeft || 0), y: r.top + (f.clientTop || 0), w: f.clientWidth, h: f.clientHeight, src: f.src || '' }; });
  }
  if (op === 'frameSize') return { w: W.innerWidth, h: W.innerHeight, url: location.href };
  if (op === 'probe') {
    // wait_for: text present/absent, selector state — one pass, background polls
    const out = {};
    if (a.text !== undefined) {
      const body = (doc.body ? (doc.body.innerText !== undefined ? doc.body.innerText : doc.body.textContent) : '') + ' ' + roots().slice(1).map((r) => r.textContent).join(' ');
      out.text = norm(body).includes(norm(a.text));
    }
    if (a.selector) {
      let els = [];
      try { els = deepAll(String(a.selector)); } catch { return { error: 'BAD_SELECTOR' }; }
      out.attached = els.length > 0; out.visible = els.some(visible);
    }
    return out;
  }
  if (op === 'focusWatch') {
    if (!W.__fpFocusWatch) {
      W.__fpFocusWatch = true;
      const note = () => { try { chrome.runtime.sendMessage({ type: 'foxpaw.focus' }); } catch { /* page gone */ } };
      doc.addEventListener('focusin', note, true);
      doc.addEventListener('focusout', note, true);
    }
    return true;
  }
  if (op === 'read') {
    const el = controlOf(byRef(a.ref));
    if (!el) return { gone: true };
    const k = kindOf(el);
    if (k === 'combobox') {
      const box = (el.closest && (el.closest(COMBO_BOX) || el.closest('[role="combobox"]') || el.closest('[class*="select"]'))) || el;
      // Element Plus ≥2.5 shows the choice in its (non-transparent) placeholder; Ant in selection-item; layui / Element UI 2 in the input
      const item = box.querySelector && (box.querySelector('[class*="selection-item"],[class*="selected-value"],.el-select__selected-item:not(.el-select__placeholder),.el-select-v2__selected-item:not(.el-select-v2__placeholder)')
        || box.querySelector('.el-select__placeholder:not(.is-transparent),.el-select-v2__placeholder:not(.is-transparent)'));
      const iv = el.tagName === 'INPUT' ? el.value : '';
      return { actual: tx(item ? (item.getAttribute('title') || item.textContent) : (iv || box.innerText || box.textContent)), kind: k };
    }
    return { actual: valueOf(el), kind: k, secret: isSecret(el) };
  }
  if (op === 'fill') {
    // one field; returns {ok, actual, kind} or {need: 'combo'|'insertText'|'file'}
    const el = controlOf(byRef(a.ref));
    if (!el) return { ok: false, error: 'element gone' };
    if (isSecret(el) && !a.allowSecret) return { ok: false, error: 'secret field', secret: true };
    const det = kindOf(el);
    const kind = a.kind && det === 'text' ? a.kind : det;
    const v = a.value;
    if (a.dryRun) { el.style.outline = '2px solid #e8590c'; try { el.scrollIntoView({ block: 'center' }); } catch { /* noop */ } return { ok: true, kind, dryRun: true }; }
    if (!enabled(el)) return { ok: false, kind, error: 'disabled' };
    const croot = !a.domOnly && kind !== 'file' && codeRootOf(el);
    if (croot) { const inp = croot.querySelector(CODE_INPUT); return { need: 'code', kind: 'code', editor: codeKind(croot), input: inp ? refOf(inp) : undefined }; }
    if (kind === 'combobox' || kind === 'file' || kind === 'datepicker' || kind === 'cascader') return { need: kind, kind };
    if (kind === 'checkbox' || kind === 'radio') {
      let target = el;
      if (kind === 'radio' && typeof v === 'string' && !/^(true|false|on|off|yes|no|1|0)$/i.test(v.trim()) && el.tagName === 'INPUT') {
        const scope = el.form || doc;
        const group = [...scope.querySelectorAll('input[type="radio"]')].filter((r) => r.name && r.name === el.name);
        target = group.find((r) => r.value === v) || group.find((r) => norm(labelText(r)) === norm(v)) || group.find((r) => norm(labelText(r)).includes(norm(v))) || null;
        if (!target) return { ok: false, kind, error: 'no radio option "' + v + '"', options: group.map((r) => labelText(r) || r.value) };
      }
      const want = kind === 'radio' && target !== el ? true : truthy(v);
      const isOn = () => (target.tagName === 'INPUT' ? !!target.checked : attr(target, 'aria-checked') === 'true');
      if (isOn() !== want) {
        if (kind === 'radio' && !want) return { ok: false, kind, error: 'cannot uncheck a radio' };
        focusEl(target); target.click();
      }
      return { ok: isOn() === want, kind, actual: isOn() ? 'checked' : '', ref: target !== el ? refOf(target) : undefined };
    }
    if (kind === 'select') {
      const vals = Array.isArray(v) ? v.map(String) : [String(v)];
      const opts = [...el.options];
      const chosen = [];
      for (const w of vals) {
        const o = opts.find((x) => x.value === w) || opts.find((x) => norm(x.label || x.textContent) === norm(w)) || opts.find((x) => norm(x.label || x.textContent).includes(norm(w)));
        if (!o) return { ok: false, kind, error: 'no option "' + w + '"', options: opts.slice(0, 25).map((x) => tx(x.label || x.textContent)) };
        chosen.push(o);
      }
      // 1.29 layui hides the native select behind its own list — click ITS option so layui's own handler
      // updates the shown value and fires form.on('select') (dependent fields load from there)
      const lay = !el.multiple && el.nextElementSibling && el.nextElementSibling.classList && el.nextElementSibling.classList.contains('layui-form-select') ? el.nextElementSibling : null;
      const dd = lay && [...lay.querySelectorAll('dd[lay-value]')].find((d) => attr(d, 'lay-value') === chosen[0].value);
      if (dd && !dd.classList.contains('layui-disabled')) { try { dd.click(); } catch { /* noop */ } }
      focusEl(el);
      for (const o of opts) o.selected = chosen.includes(o);
      if (!el.multiple) { const set = protoSetter(el, 'value'); if (set) set.call(el, chosen[0].value); }
      fire(el, 'input', Event); fire(el, 'change', Event);
      blurEl(el);
      const actual = [...el.selectedOptions].map((o) => tx(o.label || o.textContent));
      return { ok: chosen.every((o) => o.selected), kind, actual: actual.join(', ') };
    }
    if (kind === 'richframe') {
      // iframe editors keep their content in the frame's body and copy it out on submit (UEditor sync / TinyMCE
      // triggerSave / KindEditor sync): write paragraphs there, tell the editor via input / keyup
      const d = frameDoc(el);
      const lines = String(v == null ? '' : v).split(/\r?\n/);
      const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      try { el.focus(); d.body.focus(); } catch { /* noop */ }
      d.body.innerHTML = lines.map((l) => '<p>' + (esc(l) || '<br>') + '</p>').join('');
      for (const ty of ['input', 'keyup', 'change']) { try { d.body.dispatchEvent(new (d.defaultView.Event)(ty, { bubbles: true })); } catch { /* noop */ } }
      const actual = tx(d.body.innerText !== undefined ? d.body.innerText : d.body.textContent);
      return { ok: actual.replace(/\s+/g, '') === lines.join('').replace(/\s+/g, ''), kind, actual: actual.slice(0, 200) };
    }
    if (kind === 'contenteditable' && !a.domOnly && el.closest && el.closest(RICH_SEL)) {
      // 1.29 model-backed editors (Slate → wangEditor 5, Quill, ProseMirror / TipTap, CKEditor 5, Lexical) only
      // take TRUSTED input (beforeinput): the background types it for real
      return { need: 'richtext', kind };
    }
    if (kind === 'contenteditable') {
      focusEl(el);
      const sel = W.getSelection && W.getSelection();
      if (sel && doc.createRange) { const rg = doc.createRange(); rg.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(rg); }
      let done = false;
      try { done = doc.execCommand && doc.execCommand('insertText', false, String(v)); } catch { done = false; }
      if (!done || norm(el.innerText !== undefined ? el.innerText : el.textContent) !== norm(v)) {
        el.textContent = String(v);
        fire(el, 'input', W.InputEvent || Event, { inputType: 'insertText', data: String(v) });
      }
      blurEl(el);
      const actual = tx(el.innerText !== undefined ? el.innerText : el.textContent);
      return { ok: actual === tx(v), kind, actual };
    }
    // text / textarea / email / password(non-secret never reaches here) / number / date / datepicker
    const s = String(v == null ? '' : v);
    focusEl(el);
    try { if (el.select && /^(text|search|url|tel|password|)$/.test(attr(el, 'type').toLowerCase()) ) el.select(); } catch { /* noop */ }
    fire(el, 'beforeinput', W.InputEvent || Event, { inputType: 'insertText', data: s });
    setNative(el, s);
    fire(el, 'input', W.InputEvent || Event, { inputType: 'insertText', data: s });
    if (kind === 'datepicker') {
      fire(el, 'keydown', KeyboardEvent, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
      fire(el, 'keyup', KeyboardEvent, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
    }
    fire(el, 'change', Event);
    if (!a.keepFocus) blurEl(el);
    const actual = String(el.value == null ? '' : el.value);
    // 1.29 a price box that formats 9.9 → 9.90 / 1000 → 1,000.00 took the value (no re-typing, which is where
    // values used to land in the neighbouring box)
    const numEq = (x, y) => { const cx = String(x).replace(/[,\s¥￥$]/g, ''), cy = String(y).replace(/[,\s¥￥$]/g, ''); return /^-?\d+(\.\d+)?$/.test(cy) && /^-?\d+(\.\d+)?$/.test(cx) && Number(cx) === Number(cy); };
    const ok = kind === 'number' ? (Number(actual) === Number(s) || actual === s) : (actual === s || numEq(actual, s));
    return { ok, kind, actual, need: ok ? undefined : 'insertText' };
  }
  if (op === 'focusSelect') {
    const el = byRef(a.ref);
    if (!el) return false;
    focusEl(el);
    try { if (el.select) el.select(); else if (el.isContentEditable) { const sel = W.getSelection(); const rg = doc.createRange(); rg.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(rg); } } catch { /* noop */ }
    return true;
  }
  // 1.29.1 what a code editor shows — its rendered lines (in order) and the highest line number in the gutter
  if (op === 'codeRead') {
    const el = byRef(a.ref);
    const root = codeRootOf(el);
    if (!root) return { gone: true };
    const ed = codeKind(root);
    const LINE = { monaco: '.view-lines .view-line', codemirror5: '.CodeMirror-code pre.CodeMirror-line,.CodeMirror-code pre', codemirror6: '.cm-content .cm-line', ace: '.ace_text-layer .ace_line' }[ed];
    const NUM = { monaco: '.line-numbers', codemirror5: '.CodeMirror-linenumber', codemirror6: '.cm-lineNumbers .cm-gutterElement', ace: '.ace_gutter-cell' }[ed];
    const top = (n) => { const t = parseFloat((n.style && n.style.top) || ''); return Number.isNaN(t) ? null : t; };
    let lines = [...new Set([...root.querySelectorAll(LINE)])];
    if (lines.length && lines.every((n) => top(n) !== null)) lines.sort((x, y) => top(x) - top(y));
    const text = lines.map((n) => String(n.textContent || '').replace(/\u00a0/g, ' ').replace(/[\u200b\u200c\u200d\ufeff]/g, ''));
    let lastNo = 0;
    for (const n of root.querySelectorAll(NUM)) { const v = parseInt(String(n.textContent || '').trim(), 10); if (v > lastNo) lastNo = v; }
    return { editor: ed, lines: text, lastNo: lastNo || null };
  }
  if (op === 'blur') { const el = byRef(a.ref); if (el) { fire(el, 'change', Event); blurEl(el); } return true; }
  // 1.29 is THIS element (or something inside it) the focused one? Real typing goes wherever focus is —
  // checking first is what keeps a value out of the neighbouring box
  if (op === 'focusCheck') {
    const el = byRef(a.ref);
    if (!el) return { gone: true };
    let f = doc.activeElement;
    while (f && f.shadowRoot && f.shadowRoot.activeElement) f = f.shadowRoot.activeElement;
    const ok = !!f && (f === el || el.contains(f) || (f.closest && el.isContentEditable && f.closest('[contenteditable]') === el));
    return { ok, focused: f ? (tx(clsName(f) || accName(f)).slice(0, 40) || f.tagName.toLowerCase()) : '' };
  }
  // 1.29 the open dropdown list of a component select — scroll it one page (virtual lists render only what
  // is in view) / list what is visible now
  const openLists = () => deepAll('.el-select-dropdown__wrap,.el-scrollbar__wrap,.el-vl__window,.el-select-dropdown__list,.rc-virtual-list-holder,.ant-select-dropdown,[role="listbox"],.layui-form-selected dl,.ivu-select-dropdown,.arco-select-popup-inner,.n-virtual-list,.v-binder-follower-content [class*="scrollbar-container"]')
    .filter((e) => visible(e) && e.scrollHeight > e.clientHeight + 2);
  if (op === 'optScroll') {
    const box = openLists().pop();
    if (!box) return { moved: false, none: true };
    const before = box.scrollTop;
    if (a.top) box.scrollTop = 0; else box.scrollTop = before + Math.max(40, Math.floor(box.clientHeight * 0.8));
    try { box.dispatchEvent(new Event('scroll', { bubbles: true })); } catch { /* noop */ }
    return { moved: box.scrollTop !== before, at: box.scrollTop, end: box.scrollTop + box.clientHeight >= box.scrollHeight - 2 };
  }
  if (op === 'optList') {
    let pool = deepAll(OPTION_SEL + ',.ant-cascader-menu-item').filter(visible);
    if (a.col !== undefined) { const col = deepAll(CASCADE_COLS).filter(visible)[Number(a.col)]; pool = col ? pool.filter((e) => col.contains(e)) : []; }
    return { options: pool.map((e) => tx(attr(e, 'title') || e.textContent)).filter(Boolean).slice(0, 30) };
  }
  // 1.30 read kit (tester 11-04): extract / query / scroll / pageState / rect. Read-only — nothing here changes the
  // page except its scroll position (scroll). Secret boxes never give their value (•••).
  const frameMeta = () => ({ url: location.href, title: doc.title, origin: location.origin });
  // iframes that hold (or will hold) a document worth reading — an empty / about: one is not counted
  const subframeCount = (rs) => { let n = 0; for (const f of deepAll('iframe,frame', rs)) { const src = attr(f, 'src'); if (attr(f, 'srcdoc') || (src && !/^about:/i.test(src) && !/^javascript:/i.test(src))) n++; } return n; };
  const strOf = (v) => (typeof v === 'string' ? v : v && typeof v.baseVal === 'string' ? v.baseVal : '');
  const textOf = (el, n) => tx(el.innerText !== undefined ? el.innerText : el.textContent).slice(0, n || 200);
  const reOf = (s) => { if (s === undefined || s === null || s === '') return null; try { return new RegExp(String(s), 'i'); } catch { return false; } };
  const urlOfEl = (el, name) => {
    if (name) {
      if (/^value$/i.test(name) && isSecret(el)) return '•••';
      if (/^(href|src|action)$/i.test(name)) return strOf(el[name.toLowerCase()]) || attr(el, name);
      return attr(el, name);
    }
    return strOf(el.href) || strOf(el.src) || attr(el, 'href') || attr(el, 'src') || attr(el, 'data-href') || attr(el, 'data-url') || '';
  };
  // 1.32 (field test 11-05: one img src = 1.1 MB of base64): a data: URI comes back as its head + length unless
  // full:true; any other attribute value is cut at maxLen (default 2000)
  const clipVal = (v) => {
    if (typeof v !== 'string') return v;
    if (/^data:/i.test(v) && v.length > 120 && !a.full) {
      const m = /^data:([^;,]*)/i.exec(v);
      return v.slice(0, 64) + `…[data URI ${m && m[1] ? m[1] + ' ' : ''}已截断：共 ${v.length} 字符，要原文传 full:true]`;
    }
    const cap = a.full ? 1500000 : Math.min(Math.max(Number(a.maxLen) || 2000, 50), 200000);
    return v.length > cap ? v.slice(0, cap) + `…[+${v.length - cap}]` : v;
  };
  if (op === 'extract') {
    const rs = roots();
    let els;
    try { els = deepAll(a.selector || 'a[href],area[href]', rs); } catch { return { error: 'BAD_SELECTOR' }; }
    const re = reOf(a.match), tre = reOf(a.textMatch);
    if (re === false || tre === false) return { error: 'BAD_REGEX' };
    const seen = new Map();
    let matched = 0;
    for (const el of els) {
      if (a.visibleOnly && !visible(el)) continue;
      const u0 = urlOfEl(el, a.attr);
      const t = textOf(el, 200);
      if (re && !re.test(u0)) continue;
      if (tre && !tre.test(t)) continue;
      const u = clipVal(u0);
      matched++;
      const key = a.dedupe === 'none' ? '#' + matched : a.dedupe === 'text' ? 't:' + t : (u ? 'u:' + u : 't:' + t);
      const hit = seen.get(key);
      if (hit) { hit.n = (hit.n || 1) + 1; continue; }
      const o = {};
      if (u) o.href = u;
      if (t && a.text !== false) o.text = t;
      seen.set(key, o);
    }
    return { ...frameMeta(), matched, items: [...seen.values()], subframes: subframeCount(rs) };
  }
  if (op === 'query') {
    const rs = roots();
    let els;
    try { els = deepAll(String(a.selector || ''), rs); } catch { return { error: 'BAD_SELECTOR' }; }
    if (a.visibleOnly) els = els.filter(visible);
    const one = (el, get, name) => {
      if (!el) return null;
      if (get === 'text') return textOf(el, Math.min(Number(a.maxLen) || 500, 100000));
      if (get === 'href') return clipVal(strOf(el.href) || attr(el, 'href') || null);
      if (get === 'value') return isSecret(el) ? '•••' : (el.value !== undefined ? clipVal(String(el.value)) : null);
      if (get === 'attr') return name ? clipVal(urlOfEl(el, name) || el.getAttribute(name)) : null;
      if (get === 'visible') return visible(el);
      if (get === 'checked') return !!el.checked;
      return null;
    };
    const get = a.get || 'text';
    if (get === 'count') return { ...frameMeta(), count: els.length };
    if (get === 'exists') return { ...frameMeta(), count: els.length, exists: els.length > 0 };
    const fields = a.fields && typeof a.fields === 'object' ? Object.entries(a.fields).slice(0, 20) : null;
    const lim = Math.min(Number(a.limit) || 200, 5000);
    const rows = [];
    for (const el of els.slice(0, lim)) {
      let v;
      if (fields) {
        v = {};
        for (const [k, f] of fields) {
          const spec = typeof f === 'string' ? { get: f } : (f || {});
          let sub = el;
          if (spec.selector) { try { sub = el.querySelector(String(spec.selector)); } catch { return { error: 'BAD_SELECTOR' }; } }
          v[k] = one(sub, spec.get || 'text', spec.attr);
        }
      } else v = one(el, get, a.attr);
      rows.push(a.withRef ? { ref: refOf(el), value: v } : v);
    }
    return { ...frameMeta(), count: els.length, values: rows, subframes: subframeCount(rs) };
  }
  const scrollBox = () => {
    const se = doc.scrollingElement || doc.documentElement;
    const cached = E.scroller && E.scroller.deref ? E.scroller.deref() : null;
    if (cached && cached.isConnected && cached.scrollHeight > cached.clientHeight + 4) return cached;
    if (se && se.scrollHeight > (W.innerHeight || se.clientHeight) + 4) return se;
    let best = null, area = 0, n = 0;
    for (const e of doc.getElementsByTagName('*')) {
      if (++n > 30000) break;
      if (e.scrollHeight <= e.clientHeight + 20 || e.clientHeight < 80) continue;
      const oy = getComputedStyle(e).overflowY;
      if (!/auto|scroll|overlay/.test(oy) || !visible(e)) continue;
      const ar = e.clientWidth * e.clientHeight;
      if (ar > area) { area = ar; best = e; }
    }
    if (best) E.scroller = typeof WeakRef !== 'undefined' ? new WeakRef(best) : { deref: () => best };
    return best || se;
  };
  const pageState = () => {
    const box = scrollBox();
    const se = doc.scrollingElement || doc.documentElement;
    const isPage = box === se;
    const y = isPage ? (W.scrollY || se.scrollTop || 0) : box.scrollTop;
    const view = isPage ? (W.innerHeight || se.clientHeight) : box.clientHeight;
    let interactive = 0;
    try { interactive = doc.querySelectorAll(INTERACTIVE_SEL).length; } catch { interactive = 0; }
    let res = 0;
    try { res = performance.getEntriesByType('resource').length; } catch { res = 0; }
    return { url: location.href, title: doc.title, readyState: doc.readyState, y: Math.round(y), height: box.scrollHeight, view,
      atBottom: y + view >= box.scrollHeight - 4, container: isPage ? 'page' : describeHit(box), links: doc.links.length,
      interactive, nodes: doc.getElementsByTagName('*').length, textLength: doc.body ? String(doc.body.innerText || '').length : 0, resources: res,
      challenge: a.challenge ? (challengeOfPage() || undefined) : undefined };
  };
  if (op === 'pageState') return pageState();
  // 1.30.1 settle: wait in the page until it has been quiet for quietMs (no node added / removed, no resource
  // finished, document complete) or it grew past base (height / links). A MutationObserver + PerformanceObserver
  // mark activity; nothing is polled through the extension, so a static page answers after one quiet window.
  if (op === 'settle') {
    const quietMs = Math.max(100, Number(a.quietMs) || 400);
    // once something happened (a spinner / skeleton inserted, a request finished) the page is probably loading:
    // the window widens to activeQuietMs so a slower request still lands in this round
    const activeQuietMs = Math.max(quietMs, Number(a.activeQuietMs) || quietMs);
    const capMs = Math.max(quietMs, Number(a.capMs) || 2500);
    const base = a.base || null;
    const box = scrollBox();
    return new Promise((resolve) => {
      const t0 = Date.now();
      let last = t0, act = 0, grewAt = 0, done = false, tm = null;
      const moreLinks = () => !!base && doc.links.length > (base.links || 0);
      const grown = () => !!base && (box.scrollHeight > (base.height || 0) || moreLinks());
      let mo = null, po = null;
      const finish = (why) => {
        if (done) return; done = true;
        try { mo && mo.disconnect(); } catch { /* noop */ }
        try { po && po.disconnect(); } catch { /* noop */ }
        clearTimeout(tm);
        resolve({ ...pageState(), grew: grown(), settled: why, activity: act, settleMs: Date.now() - t0 });
      };
      const mark = () => { last = Date.now(); act++; };
      try { mo = new MutationObserver((ms) => { for (const m of ms) if (m.addedNodes.length || m.removedNodes.length) { mark(); break; } }); mo.observe(doc.documentElement, { childList: true, subtree: true }); } catch { mo = null; }
      try { po = new PerformanceObserver((l) => { if (l.getEntries().length) mark(); }); po.observe({ type: 'resource', buffered: false }); } catch { po = null; }
      const tick = () => {
        if (done) return;
        const now = Date.now();
        if (moreLinks()) {
          if (!grewAt) grewAt = now;
          // new links: return once the batch has been quiet briefly (or 1 s after it started growing)
          if (now - last >= Math.min(150, quietMs) || now - grewAt >= 1000) return finish('grew');
        } else if (now - last >= (act ? activeQuietMs : quietMs) && doc.readyState === 'complete') return finish(grown() ? 'grew' : 'quiet');
        // only taller (a spinner / skeleton row, images): keep watching for the real rows within the wider window
        if (now - t0 >= capMs) return finish('cap');
        tm = setTimeout(tick, 40);
      };
      tm = setTimeout(tick, 40);
    });
  }
  if (op === 'scroll') {
    if (a.to === 'element') {
      let el = a.ref ? byRef(a.ref) : null;
      if (!el && a.selector) { try { el = deepAll(String(a.selector))[0] || null; } catch { return { error: 'BAD_SELECTOR' }; } }
      if (!el) return { error: 'NOT_FOUND' };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      return { ...pageState(), element: describeHit(el) };
    }
    const box = scrollBox();
    const se = doc.scrollingElement || doc.documentElement;
    const isPage = box === se;
    const view = isPage ? (W.innerHeight || se.clientHeight) : box.clientHeight;
    const cur = isPage ? (W.scrollY || se.scrollTop || 0) : box.scrollTop;
    const target = a.to === 'top' ? 0 : a.to === 'bottom' ? box.scrollHeight : cur + Number(a.screens || 1) * Math.max(50, Math.floor(view * 0.9));
    if (isPage) W.scrollTo(0, target); else box.scrollTop = target;
    // nudge lazy loaders that listen on wheel / window scroll
    try { (isPage ? W : box).dispatchEvent(new Event('scroll')); } catch { /* noop */ }
    return pageState();
  }
  if (op === 'rect') {
    const el = byRef(a.ref);
    if (!el) return { gone: true };
    const r = el.getBoundingClientRect();
    return { x: r.left + W.scrollX, y: r.top + W.scrollY, w: r.width, h: r.height, top: W === W.top };
  }
  return { error: 'UNKNOWN_OP' };
}

/* ---------------- frames, locators, auto-wait, real input (v1.16, ) ---------------- */
const AUTO_WAIT_MS = 5000;      // actionability wait (attached/visible/enabled/stable); per call `timeout`, cfg.autoWaitMs
const NAV_START_MS = 25;       // after a click: how long a script-driven navigation may take to START
                                // (a click that submitted a form / followed a link waits up to NAV_START_LINK_MS)
const NAV_START_LINK_MS = 1500;
const LOAD_TIMEOUT_MS = 15000;  // navigation: load (or DOMContentLoaded + quiet window) cap — never an error, reported
const LOAD_QUIET_MS = 500;      // after DOMContentLoaded, return if load has not come within this window
const OBSCURED_MS = 1000;       // an element covered this long -> OBSCURED (no 5 s hang behind a modal)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAW_CDP_MS = 15000; // 1.28.1 one raw CDP call (below the relay's 25 s command limit)
function withTimeout(p, ms, code) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(err(code || 'TIMEOUT', 'timed out after ' + ms + ' ms')), ms); })]).finally(() => clearTimeout(t));
}
function splitRef(ref) {
  const m = /^f(\d+)(e\d+)$/.exec(String(ref || ''));
  return m ? { frameId: Number(m[1]), local: m[2] } : { frameId: 0, local: String(ref || '') };
}
function joinRef(frameId, local) { return frameId ? `f${frameId}${local}` : local; }
// run the page engine in one frame, a list of frames, or all frames; result rows carry frameId
// 1.28.1: every injection is time-bounded — a frame that never answers (a big SPA such as Feishu
// messenger, a background tab Chrome froze / throttles, a sub-frame stuck before document_idle) can no
// longer hang its command until the relay gives up (EXT_TIMEOUT). Read-only ops inject at once
// (injectImmediately: no wait for document_idle) one frame at a time: a slow sub-frame is skipped and
// named (framesSkipped); a main frame that does not answer = TAB_FROZEN / PAGE_SLOW with what to do.
const READ_OPS = new Set(['snapshot', 'resolve', 'probe', 'iframes', 'frameSize', 'loginFields', 'read', 'extract', 'query', 'pageState', 'rect', 'settle']);
const FRAME_MAIN_MS = 10000;   // main frame (and single-frame calls)
const FRAME_SUB_MS = 4000;     // each sub-frame of an all-frames read
const SNAP_TEXT_LIMIT = 20000;    // 1.32 one snapshot carries ≤ 20000 chars of text; textOffset pages the rest
const SNAPSHOT_BUDGET_MS = 6000; // the page engine's own time budget for one snapshot (truncates, never hangs)
async function frameStuckErr(tabId, op, ms) {
  let t = null;
  try { t = await withTimeout(chrome.tabs.get(tabId), 1500, 'TIMEOUT'); } catch { t = null; }
  const bg = t && (t.discarded || t.frozen || t.active === false);
  const e = bg
    ? err('TAB_FROZEN', `the tab did not answer within ${Math.round(ms / 1000)} s (${op}) — it is in the background and Chrome is throttling / freezing it${t.discarded ? ' (discarded)' : ''}. Call foxpaw_activate_tab on it first, then retry. Other commands are not affected.`)
    : err('PAGE_SLOW', `the page did not answer within ${Math.round(ms / 1000)} s (${op}) — it is busy (a very large page or a long script). Wait a moment and retry, or use foxpaw_activate_tab and retry; other commands are not affected.`);
  e.detail = { tabId, op, timeoutMs: ms, active: t ? !!t.active : undefined, discarded: t ? !!t.discarded : undefined, frozen: t ? !!t.frozen : undefined, next: 'foxpaw_activate_tab then retry' };
  return e;
}
async function injectOne(tabId, frameIds, all, op, args, ms) {
  const target = all ? { tabId, allFrames: true } : { tabId, frameIds };
  const spec = { target, func: fpPage, args };
  if (READ_OPS.has(op)) spec.injectImmediately = true;
  return withTimeout(chrome.scripting.executeScript(spec), ms, 'FRAME_TIMEOUT');
}
async function inFrames(tabId, op, arg, frameIds) {
  const a1 = { secret: SECRET_HINT.source, ...(arg || {}) };
  if (op === 'snapshot' && !a1.budgetMs) a1.budgetMs = SNAPSHOT_BUDGET_MS;
  const args = [op, a1];
  const rowsOf = (rows) => (rows || []).map((r) => ({ frameId: r.frameId || 0, result: r.result }));
  const fail = async (e, ms) => {
    if (e && e.code === 'FRAME_TIMEOUT') throw await frameStuckErr(tabId, op, ms);
    if (frameIds && frameIds.length === 1 && frameIds[0] !== 0) throw err('STALE_REF', 'that frame is gone (navigated or removed) — take a new snapshot');
    throw err('PAGE_UNREACHABLE', String((e && e.message) || e));
  };
  if (frameIds || !READ_OPS.has(op)) {
    try { return rowsOf(await injectOne(tabId, frameIds, !frameIds, op, args, FRAME_MAIN_MS)); } catch (e) { return fail(e, FRAME_MAIN_MS); }
  }
  // all-frames read: one injection per frame, in parallel, each with its own limit
  let frames = null;
  try { frames = await withTimeout(chrome.webNavigation.getAllFrames({ tabId }), 2000, 'FRAME_TIMEOUT'); } catch { frames = null; }
  if (!Array.isArray(frames) || !frames.length || !frames.some((f) => f && f.frameId === 0)) {
    try { return rowsOf(await injectOne(tabId, null, true, op, args, FRAME_MAIN_MS)); } catch (e) { return fail(e, FRAME_MAIN_MS); }
  }
  const ids = [...new Set(frames.filter((f) => f && Number.isInteger(f.frameId) && !f.errorOccurred).map((f) => f.frameId))].slice(0, 40);
  const res = await Promise.all(ids.map((id) => injectOne(tabId, [id], false, op, args, id === 0 ? FRAME_MAIN_MS : FRAME_SUB_MS)
    .then((rows) => ({ id, rows }), (e) => ({ id, e }))));
  const main = res.find((r) => r.id === 0);
  if (main && main.e) return fail(main.e, FRAME_MAIN_MS);
  const out = [];
  const skipped = [];
  for (const r of res) {
    if (r.e) { skipped.push({ frameId: r.id, why: r.e.code === 'FRAME_TIMEOUT' ? 'timeout' : 'unreachable' }); continue; }
    for (const row of rowsOf(r.rows)) out.push({ ...row, frameId: row.frameId || r.id });
  }
  if (skipped.length) out.skipped = skipped;
  return out;
}
/* ---- 1.30 read kit: frames the page engine does not reach, read through CDP ----
   chrome.scripting reaches every frame webNavigation lists — cross-site ones (OOPIF), sandboxed, data: and srcdoc
   included. Two gaps remain: frames webNavigation never lists (blob: documents some widgets build) and frames whose
   injection is refused (rows.skipped why:'unreachable'). When a document holds more iframes than were reached, the
   frames are found through CDP — the main target's frame tree (same process: an isolated world in that frame) and
   the tab's iframe targets (out-of-process: flatten auto-attach, an isolated world in the target) — and the same
   read-only page-engine op runs there. Refs of these frames are readOnly (the engine cannot act in them). */
const cdpReadBusy = new Set();   // tabIds whose Target.* events are consumed here (not forwarded to agents)
const cdpReadEvents = new Map(); // tabId -> [{method, params}]
const CDP_FRAME_BASE = 100000;   // frame ids handed to CDP-read frames (never a real webNavigation id)
async function cdpFrameRows(tabId, rows, op, arg) {
  const skipped = rows.skipped || [];
  const unreach = skipped.filter((s) => s.why === 'unreachable');
  const expected = rows.reduce((n, r) => n + ((r.result && r.result.subframes) || 0), 0);
  const reachedN = rows.filter((r) => r.frameId !== 0).length + skipped.length;
  if (!READ_OPS.has(op) || (!unreach.length && expected <= reachedN)) return { rows: [], still: skipped };
  try { await withTimeout(ensureDebugger(tabId), 5000, 'CDP_TIMEOUT'); } catch { return { rows: [], still: skipped }; }
  const send = (m, p, sessionId) => withTimeout(chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, m, p || {}), 5000, 'CDP_TIMEOUT');
  const a1 = { secret: SECRET_HINT.source, ...(arg || {}) };
  if (op === 'snapshot' && !a1.budgetMs) a1.budgetMs = 3000;
  const expr = `(${fpPage.toString()})(${JSON.stringify(op)}, ${JSON.stringify(a1)})`;
  const evalIn = async (frameId, sessionId) => {
    const w = await send('Page.createIsolatedWorld', { frameId, worldName: 'foxpaw-read' }, sessionId);
    const r = await send('Runtime.evaluate', { expression: expr, contextId: w.executionContextId, returnByValue: true, awaitPromise: true }, sessionId);
    if (!r || r.exceptionDetails || !r.result) throw new Error('evaluate failed');
    return r.result.value;
  };
  // every frame CDP knows: same-process ones from the frame tree, out-of-process ones as iframe targets
  const cands = [];
  try {
    const t = await send('Page.getFrameTree');
    const walk = (n, root) => { if (!n) return; if (!root) cands.push({ id: n.frame.id, url: n.frame.url || '' }); (n.childFrames || []).forEach((c) => walk(c, false)); };
    walk(t && t.frameTree, true);
  } catch { /* no tree */ }
  cdpReadBusy.add(tabId); cdpReadEvents.set(tabId, []);
  try {
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(250);
    for (const e of cdpReadEvents.get(tabId) || []) {
      const ti = e.method === 'Target.attachedToTarget' && e.params && e.params.targetInfo;
      if (ti && ti.type === 'iframe') cands.push({ id: ti.targetId, url: ti.url || '', sessionId: e.params.sessionId });
    }
  } catch { /* no targets */ } finally { cdpReadBusy.delete(tabId); cdpReadEvents.delete(tabId); }
  // which candidates were not reached: match by url (a multiset — the same widget can be embedded twice)
  let frames = [];
  try { frames = await withTimeout(chrome.webNavigation.getAllFrames({ tabId }), 2000, 'FRAME_TIMEOUT'); } catch { frames = []; }
  const reached = rows.filter((r) => r.frameId !== 0 && r.result).map((r) => String(r.result.url || ''));
  const unreachUrls = unreach.map((s) => ((frames || []).find((f) => f && f.frameId === s.frameId) || {}).url || '');
  const out = [];
  const left = [];
  let n = 0;
  for (const c of cands) {
    const k = reached.indexOf(c.url);
    if (k >= 0) { reached.splice(k, 1); continue; }
    const u = unreachUrls.indexOf(c.url);
    const fromSkip = u >= 0 ? unreach[u] : null;
    if (u >= 0) unreachUrls.splice(u, 1, null);
    if (!fromSkip && (!c.url || c.url === 'about:blank')) continue;   // an empty / not-yet-loaded frame
    try {
      out.push({ frameId: fromSkip ? fromSkip.frameId : CDP_FRAME_BASE + (++n), result: await evalIn(c.id, c.sessionId), via: 'cdp' });
    } catch { if (fromSkip) left.push(fromSkip); }
  }
  for (let x = 0; x < unreach.length; x++) if (unreachUrls[x] !== null && !left.includes(unreach[x])) left.push(unreach[x]);
  return { rows: out, still: [...skipped.filter((s) => s.why !== 'unreachable'), ...left] };
}
// all frames for a read op, with the CDP fallback; rows carry frameId (+ via:'cdp')
async function readFrames(tabId, op, arg, mainOnly) {
  if (mainOnly) return inFrames(tabId, op, arg, [0]);
  const rows = await inFrames(tabId, op, arg);
  const fb = await cdpFrameRows(tabId, rows, op, arg).catch(() => ({ rows: [], still: rows.skipped || [] }));
  if (!fb.rows.length) return rows;
  const out = [...rows, ...fb.rows];
  if (fb.still.length) out.skipped = fb.still;
  return out;
}
// what the frames are: url, origin, whether cross-origin to the top document
function frameInfo(row, topOrigin) {
  const r = row.result || {};
  let origin = r.origin || '';
  if (!origin) { try { origin = new URL(r.url).origin; } catch { origin = ''; } }
  const o = { frame: 'f' + row.frameId, frameId: row.frameId, url: String(r.url || '').slice(0, 300), title: String(r.title || '').slice(0, 120) };
  if (origin && topOrigin && origin !== topOrigin) o.crossOrigin = true;
  if (row.via) o.via = row.via;
  return o;
}
/* ---- 1.30 scroll: to bottom (repeat until the height / list stops growing), top, N screens, an element ---- */
const SHOT_MAX_H = 12000;          // 1.30 full-page screenshots stop here (cropped:true)
const SHOT_MAX_B64 = 1400000;      // ≈ 1 MB image: one WS frame the relay and the link carry comfortably
/* 1.32 bot checks (field test 11-05: a WAF 「人机识别检测」 / 「算力与时间锁校验」 page sat in a background tab for 30 s and
   passed in 0.4 s once the tab was in front — a hidden tab does not render, so the check never finishes).
   kind 'js': the tab is brought to the front of ITS OWN window (the window is not focused / raised), we wait until
   the check is gone (≤ challengeWait, default 8 s), then the tab that was in front of that window gets the front back
   — unless the owner switched tabs meanwhile. kind 'captcha' (slider / puzzle / checkbox): never touched, never
   solved — USER_STEP for the owner. Not passed in time: USER_STEP too. challenge:'off' skips all of it. */
const CHALLENGE_WAIT_MS = 8000;
// run fn with the tab in front of its own window (the window itself is not focused), then give the front back
async function briefFront(tabId, fn) {
  const t = await chrome.tabs.get(tabId);
  let prev = null;
  try { const [a0] = await chrome.tabs.query({ active: true, windowId: t.windowId }); prev = a0 ? a0.id : null; } catch { prev = null; }
  const t0 = Date.now();
  await chrome.tabs.update(tabId, { active: true });
  await new Promise((r) => setTimeout(r, 150));
  const res = { value: null, ms: 0, restored: false };
  try { res.value = await fn(); } finally {
    res.ms = Date.now() - t0;
    try { const now = await chrome.tabs.get(tabId); if (now.active && prev != null && prev !== tabId) { await chrome.tabs.update(prev, { active: true }); res.restored = true; } } catch { /* gone */ }
  }
  return res;
}
async function passChallenge(tabId, ctx, msg, stuckOp) {
  // stuckOp (snapshot): probe on the read's own clock — a tab that cannot answer a tiny pageState in FRAME_MAIN_MS
  // would not answer the read either, so report TAB_FROZEN / PAGE_SLOW for that read now instead of adding a probe
  // timeout in front of it (bg-hang: the frozen-tab answer must stay ≤ ~10 s)
  let s0 = null;
  if (stuckOp) {
    try { s0 = await inFrame(tabId, 0, 'pageState', { challenge: true }); } catch (e) {
      if (e && (e.code === 'TAB_FROZEN' || e.code === 'PAGE_SLOW')) throw await frameStuckErr(tabId, stuckOp, FRAME_MAIN_MS);
      s0 = null;
    }
  } else s0 = await pageStateOf(tabId, 0, 2500, { challenge: true });
  if (!s0 || !s0.challenge) return null;
  const out = { kind: s0.challenge.kind, title: s0.challenge.title, passed: false };
  const wait = Math.min(Math.max(Number(msg && msg.challengeWait) || CHALLENGE_WAIT_MS, 1000), 20000);
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { return out; }
  let prev = null, fg = false;
  const t0 = Date.now();
  if (out.kind === 'js') {
    if (!tab.active) {
      try { const [a0] = await chrome.tabs.query({ active: true, windowId: tab.windowId }); prev = a0 ? a0.id : null; } catch { prev = null; }
      try { await chrome.tabs.update(tabId, { active: true }); fg = true; } catch { fg = false; }
    }
    let okRuns = 0;
    while (Date.now() - t0 < wait) {
      await new Promise((r) => setTimeout(r, 250));
      const z = await pageStateOf(tabId, 0, 1500, { challenge: true });
      if (!z) { okRuns = 0; continue; }                      // reloading after the check
      if (z.challenge && z.challenge.kind === 'captcha') { out.kind = 'captcha'; break; }
      if (!z.challenge && z.readyState !== 'loading' && (z.textLength > 0 || z.interactive > 0)) { if (++okRuns >= 2) { out.passed = true; break; } } else okRuns = 0;
    }
    out.waitedMs = Date.now() - t0;
    if (fg) {
      out.foregroundMs = Date.now() - t0;
      let still = null;
      try { still = await chrome.tabs.get(tabId); } catch { still = null; }
      if (still && still.active && prev != null && prev !== tabId) {
        try { await chrome.tabs.update(prev, { active: true }); out.restored = true; } catch { out.restored = false; }
      }
    }
    try { await audit(`bot check (${out.kind}) on tab ${tabId}: ${out.passed ? 'passed' : 'not passed'} in ${out.waitedMs} ms${fg ? ', in front ' + out.foregroundMs + ' ms' : ''}`); } catch { /* noop */ }
  }
  if (out.passed) { out.note = '人机/算力校验已自动放行（标签短暂切到前台后已切回）'; return out; }
  const what = out.kind === 'captcha' ? '页面要求人机验证（滑块 / 拼图 / 勾选）' : '页面的安全校验没有自动放行';
  const e = await userStepErr(Object.assign({}, ctx, { tabId }), 'captcha',
    `${what} — FoxPaw 不会替你过验证：请用 foxpaw_need_human 请主人处理，主人完成后再继续 · bot check needs the owner`, out.title || '');
  e.detail = Object.assign({}, e.detail || {}, { challenge: out });
  throw e;
}
async function navPageState(tabId, why) {
  const s = await pageStateOf(tabId, 0, 2500);
  if (!s) return { state: 'unknown', readable: false, next: 'the page did not answer — try foxpaw_snapshot once; if it fails, retry the navigation' };
  const readable = s.textLength > 200 || s.interactive >= 5;
  return { state: readable ? (s.readyState === 'complete' ? 'readable' : 'partial') : 'blank', readable,
    page: { readyState: s.readyState, title: String(s.title || '').slice(0, 120), url: s.url, elements: s.interactive, links: s.links, textLength: s.textLength, nodes: s.nodes },
    next: readable ? (why === 'error' ? 'the browser reported a load error but the page is rendered and readable — read it (foxpaw_snapshot / foxpaw_extract); do not retry'
      : 'the page is rendered and readable (only some resources are still loading) — call foxpaw_snapshot / foxpaw_extract now, do not retry the navigation')
      : (why === 'error' ? 'the page did not load (see error) and nothing is readable — check the URL; retry once at most'
        : 'nothing readable yet — foxpaw_wait_for the text you expect (or wait a moment and foxpaw_snapshot); retry the navigation only if that fails') };
}
// 1.30.1 a round ends after one quiet window in the page (no DOM add / remove, no resource finishing) or as
// soon as the page grows; the first round without growth stops. Not scrollable at all → return at once.
const SCROLL_QUIET_MS = 400;      // quiet window (settleMs overrides, 200–5000)
const SCROLL_ACTIVE_QUIET_MS = 1200; // the window after activity was seen in the round (a loader is at work)
const SCROLL_ROUND_CAP_MS = 2500; // one round never waits longer (a page that keeps mutating: carousel, clock)
const SCROLL_MAX_ROUNDS = 40;
const NET_MAX_WAITS = 6;          // 1.31.0: network waits per settle (each ends when the tab's requests are done)
async function pageStateOf(tabId, frameId, ms, arg) {
  try { return await withTimeout(inFrame(tabId, frameId || 0, 'pageState', arg || {}), ms || 3000, 'FRAME_TIMEOUT'); } catch { return null; }
}
async function scrollRun(tabId, o) {
  const frameId = o.frameId || 0;
  const budget = Math.min(Math.max(Number(o.timeout) || 20000, 2000), 55000);
  const t0 = Date.now();
  const before = await pageStateOf(tabId, frameId);
  const go = async (arg) => {
    const r = await inFrame(tabId, frameId, 'scroll', arg);
    if (r && r.error === 'NOT_FOUND') throw err('NOT_FOUND', 'element to scroll to was not found: ' + (o.ref ? 'ref ' + o.ref : o.selector));
    if (r && r.error === 'BAD_SELECTOR') throw err('BAD_SELECTOR', 'invalid CSS selector: ' + o.selector);
    return r;
  };
  const quietMs = Math.min(Math.max(Number(o.settleMs) || SCROLL_QUIET_MS, 200), 5000);
  const roundCap = Math.max(SCROLL_ROUND_CAP_MS, quietMs * 3);
  const left = () => budget - (Date.now() - t0);
  const settle = async (base, q, cap, aq) => {
    const ms = Math.max(q, Math.min(cap, left()));
    try { return await withTimeout(inFrame(tabId, frameId, 'settle', { quietMs: q, activeQuietMs: aq || q, capMs: ms, base }), ms + 3000, 'FRAME_TIMEOUT'); } catch { return null; }
  };
  // 1.31.0 the page looked quiet but this tab still has requests in flight (a slow API, no spinner) →
  // wait for them in the worker, then one more quiet window in the page, until it grows or the network is idle
  const net = { observed: netReady, waits: 0, waitedMs: 0 };
  const settleNet = async (base, q, cap, aq, netCap) => {
    let r = await settle(base, q, cap, aq);
    if (!netReady) return r;
    const n0 = Date.now();
    const nleft = () => Math.min(left(), netCap ? netCap - (Date.now() - n0) : Infinity);
    while (r && !r.grew && net.waits < NET_MAX_WAITS && nleft() > 0 && netInflight(tabId, t0) > 0) {
      net.waits++;
      const w0 = Date.now();
      await netIdle(tabId, Math.max(0, nleft()), t0);
      net.waitedMs += Date.now() - w0;
      r = await settle(base, Math.min(q, 300), cap, aq) || r;
    }
    return r;
  };
  let rounds = 0, stoppedBy = 'done', st = null, after = null;
  if (o.to === 'bottom') {
    const maxRounds = Math.min(Math.max(Number(o.maxRounds) || SCROLL_MAX_ROUNDS, 1), 200);
    let short = null;
    if (before && before.height <= before.view + 8 && before.y <= 4) {
      // nothing to scroll: no round — one quiet window only, in case a loader is still filling the first screen
      // (the bench's lazy pages: 20 rows, the sentinel in view, 20 more 250 ms later)
      // 1.32 this probe waits on the network for 2 s at most (a page with nothing to scroll took 11 s)
      short = await settleNet(before, quietMs, roundCap, Math.max(quietMs, SCROLL_ACTIVE_QUIET_MS), 2000);
      if (!short || (!short.grew && short.height <= short.view + 8)) { stoppedBy = 'notScrollable'; after = short || before; }
      else short = null;
    }
    if (stoppedBy !== 'notScrollable') {
      let prev = before || {};
      for (;;) {
        st = await go({ to: 'bottom' }); rounds++;
        const r = await settleNet(st, quietMs, roundCap, Math.max(quietMs, SCROLL_ACTIVE_QUIET_MS));
        after = r || st;
        // growth during the scroll itself (a loader that appends synchronously on the scroll event) counts too
        const grewInScroll = !!st && (st.height > (prev.height || 0) || st.links > (prev.links || 0)) && !(r && r.atBottom);
        if (!r || (!r.grew && !grewInScroll)) { stoppedBy = 'stable'; break; }
        prev = after;
        if (rounds >= maxRounds) { stoppedBy = 'maxRounds'; break; }
        if (left() <= 0) { stoppedBy = 'timeout'; break; }
      }
    }
  } else {
    if (o.to === 'top') st = await go({ to: 'top' });
    else if (o.to === 'element') st = await go({ to: 'element', ref: o.local || o.ref, selector: o.selector });
    else st = await go({ to: 'by', screens: Number(o.screens) || 1 });
    rounds = 1;
    after = await settleNet(null, Math.min(quietMs, 300), 1500) || st;
  }
  after = after || st || {};
  const out = { ok: true, to: o.to === 'by' ? 'screens' : o.to, rounds, stoppedBy, waitedMs: Date.now() - t0, quietMs,
    height: after.height, heightBefore: before ? before.height : undefined, y: after.y, atBottom: after.atBottom,
    links: after.links, linksBefore: before ? before.links : undefined, interactive: after.interactive, container: after.container };
  if (o.to === 'by') out.screens = Number(o.screens) || 1;
  if (st && st.element) out.element = st.element;
  out.grew = !!(before && (after.height > before.height || after.links > before.links));
  out.net = net;
  return out;
}
async function inFrame(tabId, frameId, op, arg) {
  const rows = await inFrames(tabId, op, arg, [frameId || 0]);
  return rows.length ? rows[0].result : null;
}
async function autoWaitMs(c, v) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 60000);
  const d = Number(c && c.autoWaitMs);
  return Number.isFinite(d) && d >= 0 ? Math.min(d, 60000) : AUTO_WAIT_MS;
}
// a target spec from an action's arguments (ref | role+name | label | text | selector)
function specOf(m) {
  if (!m) return null;
  if (m.ref) return { ref: String(m.ref) };
  if (m.role) return { role: String(m.role), name: m.name, exact: !!m.exact };
  if (m.label !== undefined && m.label !== null && m.label !== '') return { label: String(m.label), exact: !!m.exact };
  if (m.text !== undefined && m.text !== null && m.text !== '') return { text: String(m.text), exact: !!m.exact };
  if (m.selector) return { selector: String(m.selector) };
  return null;
}
function specText(s) {
  if (!s) return '?';
  if (s.ref) return 'ref ' + s.ref;
  if (s.role) return `role=${s.role}${s.name !== undefined ? ` name="${s.name}"` : ''}`;
  if (s.label) return `label "${s.label}"`;
  if (s.text !== undefined) return `text "${s.text}"`;
  if (s.selector) return `selector ${s.selector}`;
  if (s.option !== undefined) return `option "${s.option}"`;
  return '?';
}
async function resolveOnce(tabId, spec) {
  let rows;
  if (spec.ref) {
    const { frameId, local } = splitRef(spec.ref);
    rows = await inFrames(tabId, 'resolve', { spec: { ref: local } }, [frameId]);
  } else {
    rows = await inFrames(tabId, 'resolve', { spec });
  }
  const cands = [];
  for (const row of rows) {
    const r = row.result;
    if (!r) continue;
    if (r.error === 'BAD_SELECTOR') throw err('BAD_SELECTOR', 'invalid CSS selector: ' + spec.selector);
    for (const c of r.cands || []) cands.push({ ...c, ref: joinRef(row.frameId, c.ref), frameId: row.frameId, local: c.ref });
  }
  const vis = cands.filter((c) => c.visible);
  return vis.length ? vis : cands;
}
function candList(cands) {
  return cands.slice(0, 10).map((c) => ({ ref: c.ref, role: c.role, name: c.name, tag: c.tag, frame: c.frameId || undefined }));
}
// 1.26 the sign-in form on a tab (top frame first, then frames); refs given by the agent win
async function loginFieldsOf(tabId, msg) {
  const out = { pw: null, user: null, btn: null, card: false };
  const asCand = (row, c) => c ? { ...c, ref: joinRef(row.frameId, c.ref), frameId: row.frameId, local: c.ref } : null;
  const t0 = Date.now();
  for (;;) {
    const rows = await inFrames(tabId, 'loginFields', {});
    rows.sort((x, y) => (x.frameId === 0 ? -1 : 0) - (y.frameId === 0 ? -1 : 0));
    const hit = rows.find((r) => r.result && r.result.pw) || rows.find((r) => r.result && r.result.user);
    out.card = rows.some((r) => r.result && r.result.card);
    if (hit) { out.pw = asCand(hit, hit.result.pw); out.user = asCand(hit, hit.result.user); out.btn = asCand(hit, hit.result.btn); }
    if (hit || Date.now() - t0 > 2500) break;
    await sleep(150);
  }
  if (msg.passwordRef) { const c = await locate(tabId, { ref: String(msg.passwordRef) }, { timeout: 1500 }); const k = c.info && c.info.secretKind; if (k && k !== 'password') { out.pw = null; out.card = out.card || k === 'card'; } else out.pw = c; }
  if (msg.userRef) out.user = await locate(tabId, { ref: String(msg.userRef) }, { timeout: 1500 });
  return out;
}
/* Auto-wait (Playwright actionability): attached → visible → enabled
   (stable + receives-events are checked at the click itself). Several
   matches = AMBIGUOUS with candidates (never "the first one"); `nth`
   picks one explicitly. A ref that no longer exists fails at once. */
async function locate(tabId, spec, o = {}) {
  if (!spec) throw err('BAD_TARGET', 'give a target: ref, {role,name}, label, text or selector');
  const t0 = Date.now();
  const timeout = o.timeout === undefined ? AUTO_WAIT_MS : o.timeout;
  let last = null, i = 0;
  for (;;) {
    let cands = await resolveOnce(tabId, spec);
    if (spec.ref && !cands.length) throw err('STALE_REF', 'element not found — page changed, re-snapshot');
    if (o.nth !== undefined && o.nth !== null && cands.length > 1) { const k = Number(o.nth); cands = cands[k] ? [cands[k]] : []; }
    if (cands.length > 1) {
      const e = err('AMBIGUOUS', `${specText(spec)} matches ${cands.length} elements — use one of the candidate refs (or pass nth)`);
      e.candidates = candList(cands);
      throw e;
    }
    if (cands.length === 1) {
      const c = cands[0];
      if (c.visible && (c.enabled || o.enabled === false)) return c;
      last = c;
    }
    if (last && !last.visible && o.allowHidden && o.allowHidden(last) && Date.now() - t0 >= Math.min(timeout, 600)) return last;
    if (Date.now() - t0 >= timeout) {
      if (!last) throw err('NOT_FOUND', `no element for ${specText(spec)} after ${timeout} ms`);
      if (!last.visible) throw err('NOT_VISIBLE', `${specText(spec)} exists but is not visible after ${timeout} ms`);
      // before calling it NOT_ENABLED, look again — a short grace re-check (the button is
      // mid-transition), and if the page has moved on since the command started (navigated / URL
      // changed / new document), that is progress, not an error
      for (const g0 = Date.now(); Date.now() - g0 < NOT_ENABLED_GRACE_MS;) {
        await sleep(120);
        const again = await resolveOnce(tabId, spec).catch(() => []);
        if (again.length === 1 && again[0].visible && again[0].enabled) return again[0];
        if (o.start && await pageAdvanced(tabId, o.start)) break;
      }
      const adv = o.start ? await pageAdvanced(tabId, o.start) : null;
      if (adv) { const e = err('PAGE_ADVANCED', `${specText(spec)} is disabled, but the page already moved on`); e.pageAdvanced = adv; throw e; }
      throw err('NOT_ENABLED', `${specText(spec)} is disabled after ${timeout} ms (re-checked)`);
    }
    await sleep([0, 30, 60, 100, 150, 200, 250][Math.min(i++, 6)]);
  }
}
// where the page was when a command started; pageAdvanced() says whether it has moved on
const NOT_ENABLED_GRACE_MS = 1000;
async function pageMark(tabId) {
  let url = '';
  try { url = (await getTab(tabId)).url || ''; } catch { url = ''; }
  return { seq: navSeq(tabId), epoch: epochs.get(tabId) || 0, url };
}
async function pageAdvanced(tabId, m) {
  if (!m) return null;
  let url = m.url;
  try { url = (await getTab(tabId)).url || ''; } catch { /* tab gone */ }
  const nav = navSeq(tabId) > m.seq || (epochs.get(tabId) || 0) !== m.epoch;
  if (!nav && url === m.url) return null;
  return { from: m.url, to: url, navigated: nav };
}
// absolute (top-viewport) offset of a frame: walk up parents matching each
// child frame to its <iframe> element (url, then size+order)
async function frameOffset(tabId, frameId) {
  if (!frameId) return { x: 0, y: 0 };
  let frames = [];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch { frames = []; }
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  let x = 0, y = 0, cur = byId.get(frameId);
  for (let guard = 0; cur && cur.parentFrameId >= 0 && guard < 10; guard++) {
    const parent = cur.parentFrameId;
    const sibs = frames.filter((f) => f.parentFrameId === parent);
    const els = (await inFrame(tabId, parent, 'iframes', {})) || [];
    let hit = els.filter((e) => e.src && e.src === cur.url);
    if (hit.length !== 1) {
      const size = await inFrame(tabId, cur.frameId, 'frameSize', {}).catch(() => null);
      const same = size ? els.filter((e) => Math.abs(e.w - size.w) <= 1 && Math.abs(e.h - size.h) <= 1) : [];
      if (same.length === 1) hit = same;
      else if (els.length === sibs.length) hit = [els[sibs.indexOf(cur)]];
      else hit = [];
    }
    if (!hit.length || !hit[0]) return null;
    x += hit[0].x; y += hit[0].y;
    cur = byId.get(parent);
  }
  return { x, y };
}
async function cdpMouseClick(tabId, x, y) {
  await ensureDebugger(tabId);
  const send = (p) => withTimeout(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', p), 2500, 'INPUT_TIMEOUT');
  // mouseMoved is rAF-aligned input: in a tab that is not painting (background)
  // its ack waits ~1 s for a frame. Fire it without waiting — the renderer
  // flushes queued moves before the discrete press, so hover still happens first.
  const move = send({ type: 'mouseMoved', x, y, button: 'none' }).catch(() => {});
  await send({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  void move;
}
/* Real click: scroll into view → stable (same box on two reads) → hit
   test at the click point (the element itself must receive it, else
   OBSCURED) → CDP mouse move/press/release at that point. element.click()
   only when CDP is unavailable (debugger busy / frame offset unknown). */
async function realClick(tabId, cand, o = {}) {
  const t0 = Date.now();
  const timeout = o.timeout === undefined ? AUTO_WAIT_MS : o.timeout;
  let prev = null, obscuredSince = 0, lastObs = '';
  for (let i = 0; ; i++) {
    const p = await inFrame(tabId, cand.frameId, 'point', { ref: cand.local, arm: true });
    if (!p || p.gone) throw err('STALE_REF', 'element detached before the click — re-snapshot');
    if (p.visible === false) { if (Date.now() - t0 > timeout) throw err('NOT_VISIBLE', 'element became invisible'); await sleep(50); prev = null; continue; }
    const stable = prev && !p.scrolled && prev.rect.join() === p.rect.join();
    if (!stable) { prev = p; if (Date.now() - t0 > timeout) throw err('NOT_STABLE', 'element kept moving for ' + timeout + ' ms'); if (i) await sleep(16); continue; }
    if (!p.hitOk && !p.retarget) {
      if (!obscuredSince) obscuredSince = Date.now();
      lastObs = p.obscuredBy;
      if (Date.now() - obscuredSince >= Math.min(OBSCURED_MS, timeout) || Date.now() - t0 > timeout) {
        const e = err('OBSCURED', `the element is covered by 「${lastObs || '另一个元素'}」 — close it first (or click that)`);
        e.detail = { point: [Math.round(p.x), Math.round(p.y)], rect: p.rect, coveredBy: lastObs };
        throw e;
      }
      await sleep(80); prev = null; continue;
    }
    if (!p.enabled && o.enabled !== false) {
      if (Date.now() - t0 > timeout) {
        const adv = o.start ? await pageAdvanced(tabId, o.start) : null;
        if (adv) { const e = err('PAGE_ADVANCED', 'the element is disabled, but the page already moved on'); e.pageAdvanced = adv; throw e; }
        throw err('NOT_ENABLED', 'element is disabled');
      }
      await sleep(60); continue;
    }
    let via = 'cdp';
    const tPoint = Date.now();
    const off = cand.frameId ? await frameOffset(tabId, cand.frameId) : { x: 0, y: 0 };
    // `trusted: false` = the DOM event sequence on purpose (not isTrusted)
    if (!off || o.trusted === false) via = 'dom';
    else {
      try { await cdpMouseClick(tabId, off.x + p.x, off.y + p.y); } catch (e) { via = 'dom'; }
    }
    if (o.timing) { o.timing.point = tPoint - t0; o.timing.input = Date.now() - tPoint; }
    if (via === 'dom') {
      const r = await inFrame(tabId, cand.frameId, 'clickDom', { ref: cand.local });
      if (!r || !r.ok) throw err('CLICK_FAILED', (r && r.error) || 'click failed');
    }
    return { via, name: p.name, retargeted: p.hitOk ? undefined : p.retarget, point: [Math.round(off ? off.x + p.x : p.x), Math.round(off ? off.y + p.y : p.y)] };
  }
}

/* ---- click effect: poll the armed observer for a short window ---- */
const NO_EFFECT_MS = 450;
async function clickEffect(tabId, cand, ms) {
  let last = null;
  for (const t0 = Date.now(); ;) {
    try { last = await inFrame(tabId, cand.frameId, 'effect', {}); } catch { return null; } // page gone = it navigated
    if (!last || !last.armed) return last;
    if (last.sig.length && !(last.sig.length === 1 && last.sig[0] === 'focus')) return last;
    if (Date.now() - t0 >= ms) return last;
    await sleep(50);
  }
}
// the target stayed disabled but the page moved on — report progress, not NOT_ENABLED
function pageAdvancedResult(tabId, adv, cand) {
  return { ok: true, performed: false, pageAdvanced: adv, ref: cand ? cand.ref : undefined, epoch: epochs.get(tabId) || 0,
    note: 'the target was disabled, but the page has already moved on (navigated / URL changed) — nothing was clicked; take a new snapshot' };
}

/* ---- navigation tracking (webNavigation, top frame) ---- */
const navState = new Map(); // tabId -> {seq, url, started, dcl, done, spa, error}
const navWaiters = new Set();
function navNotify() { for (const f of [...navWaiters]) { try { f(); } catch { /* noop */ } } }
function navUpdate(tabId, patch, fresh) {
  const prev = navState.get(tabId) || { seq: 0 };
  navState.set(tabId, fresh ? { seq: prev.seq + 1, started: Date.now(), ...patch } : { ...prev, ...patch });
  navNotify();
}
try {
  chrome.webNavigation.onBeforeNavigate.addListener((d) => { if (d.frameId === 0) navUpdate(d.tabId, { url: d.url }, true); });
  chrome.webNavigation.onDOMContentLoaded.addListener((d) => { if (d.frameId === 0) navUpdate(d.tabId, { dcl: Date.now() }); });
  chrome.webNavigation.onCompleted.addListener((d) => { if (d.frameId === 0) navUpdate(d.tabId, { done: Date.now(), url: d.url }); });
  chrome.webNavigation.onErrorOccurred.addListener((d) => { if (d.frameId === 0) navUpdate(d.tabId, { done: Date.now(), error: d.error }); });
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => { if (d.frameId === 0) navUpdate(d.tabId, { url: d.url, spa: true, dcl: Date.now(), done: Date.now() }, true); });
} catch { /* test mocks */ }
function navSeq(tabId) { return (navState.get(tabId) || { seq: 0 }).seq; }
function waitEvent(pred, ms) {
  return new Promise((resolve) => {
    if (pred()) { resolve(true); return; }
    let t = null;
    const f = () => { if (pred()) { navWaiters.delete(f); clearTimeout(t); resolve(true); } };
    navWaiters.add(f);
    t = setTimeout(() => { navWaiters.delete(f); resolve(pred()); }, ms);
  });
}
// after an action: did a navigation start (within startMs)? then wait for
// load, or DOMContentLoaded + LOAD_QUIET_MS, capped at loadMs
async function settleNavigation(tabId, seq0, startMs, loadMs) {
  const started = await waitEvent(() => navSeq(tabId) > seq0, startMs);
  if (!started) return null;
  const st = () => navState.get(tabId) || {};
  if (st().spa) return { url: st().url, load: 'spa' };
  const deadline = Date.now() + loadMs;
  for (;;) {
    const s = st();
    if (s.done) return { url: s.url, load: s.error ? 'error' : 'load', error: s.error || undefined };
    if (s.dcl && Date.now() - s.dcl >= LOAD_QUIET_MS) return { url: s.url, load: 'domcontentloaded' };
    const left = deadline - Date.now();
    if (left <= 0) return { url: s.url, load: 'timeout' };
    await waitEvent(() => { const z = st(); return !!z.done || (z.dcl && Date.now() - z.dcl >= LOAD_QUIET_MS); }, Math.min(left, s.dcl ? LOAD_QUIET_MS + 20 : left));
  }
}

/* ---- new tabs opened from an authorized tab join its group ---- */
const openedSeen = new Map(); // tabId -> ts (dedupe onCreated / onCreatedNavigationTarget)
const openedBy = new Map();   // openerTabId -> [{tabId, url, ts}] recent, for click results
async function adoptOpened(openerTabId, tabId, url) {
  if (openerTabId == null || tabId == null || openedSeen.has(tabId)) return;
  openedSeen.set(tabId, Date.now());
  setTimeout(() => openedSeen.delete(tabId), 60000);
  try {
    await groupsReady();
    const c = await cfg();
    if (c.access === 'off' && !(rec && rec.active)) return;   // 1.21 a recording keeps its tabs even with agents off
    let src;
    try { src = await chrome.tabs.get(openerTabId); } catch { return; }
    if (!tabAuthorized(src)) return;
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    const u = url || tab.pendingUrl || tab.url || '';
    if (/^https?:/i.test(u) && siteRule(c, originOf(u)) === 'block') { await audit(`new tab not joined (site blocked): ${originOf(u)}`); return; }
    const srcGid = isOwnGroup(src.groupId) ? src.groupId : adopted.get(src.id);
    let win = null;
    try { win = await chrome.windows.get(tab.windowId); } catch { win = null; }
    if (win && win.type && win.type !== 'normal') {
      adopted.set(tabId, srcGid); adoptNote(tabId, u); await saveAdopted();         // popup windows cannot hold a group
    } else if (!isOwnGroup(tab.groupId)) {
      await groupTab(tabId, tab.windowId === src.windowId ? srcGid : undefined);
    }
    bumpEpoch(tabId);
    const list = (openedBy.get(openerTabId) || []).filter((x) => Date.now() - x.ts < 30000);
    list.push({ tabId, url: u, ts: Date.now() });
    openedBy.set(openerTabId, list);
    navNotify();
    wsSend({ type: 'event', event: 'tab_opened', tabId, openerTabId, url: u });
    sendTabsSync();
    await audit(`new tab from an authorized tab joined FoxPaw: ${tabId} (opener ${openerTabId}) ${u}`);
    if (rec && rec.active) await recOnTabOpened(tabId, openerTabId, u, !!(win && win.type && win.type !== 'normal'));
  } catch { /* best effort */ }
}
// 联调: adoptions still in flight per opener, so a click that opened a tab
// can wait for it to finish joining and report it in `opened` (the popup
// window path takes several async hops; without this the click result
// sometimes raced ahead of the adoption).
const adoptPending = new Map(); // openerTabId -> Set<Promise>
function trackAdopt(openerTabId, p) {
  if (openerTabId == null) return p;
  let set = adoptPending.get(openerTabId);
  if (!set) { set = new Set(); adoptPending.set(openerTabId, set); }
  set.add(p);
  p.finally(() => { set.delete(p); if (!set.size && adoptPending.get(openerTabId) === set) adoptPending.delete(openerTabId); });
  return p;
}
async function adoptionsSettled(openerTabId, maxMs) {
  const set = adoptPending.get(openerTabId);
  if (!set || !set.size) return;
  await Promise.race([Promise.allSettled([...set]), sleep(maxMs)]);
}
try { chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => trackAdopt(d.sourceTabId, adoptOpened(d.sourceTabId, d.tabId, d.url))); } catch { /* mocks */ }
chrome.tabs.onCreated.addListener((tab) => { if (tab && tab.openerTabId != null) trackAdopt(tab.openerTabId, sleep(30).then(() => adoptOpened(tab.openerTabId, tab.id, tab.pendingUrl || tab.url))); });
function openedSince(tabId, ts) { return (openedBy.get(tabId) || []).filter((x) => x.ts >= ts).map((x) => ({ tabId: x.tabId, url: x.url })); }

/* ---- focus cache for typing ----
   Raw CDP typing (Playwright type(), insertText per char) used to run one
   page script per keystroke to see whether the focused field is secret.
   Now: one check per (tab, document, focus generation). A focus watcher in
   every frame bumps the generation on focusin/focusout; mouse presses,
   Tab/Enter, script execution, our own click/fill and navigation also
   invalidate. Secret answers are cached too (they refuse every key). */
const focusGen = new Map();   // tabId -> int
const focusCache = new Map(); // tabId -> {key, info}
function bumpFocus(tabId) { focusGen.set(tabId, (focusGen.get(tabId) || 0) + 1); focusCache.delete(tabId); }
async function focusedInfo(tabId) {
  const key = `${epochs.get(tabId) || 0}|${focusGen.get(tabId) || 0}`;
  const hit = focusCache.get(tabId);
  if (hit && hit.key === key) return hit.info;
  let info = await elementInfo(tabId, { focused: true });
  if (info && info.frame) {
    // focus is inside an iframe: ask every frame; any focused secret field wins
    try {
      const rows = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageElementInfo, args: [{ focused: true }, SECRET_HINT.source] });
      const fields = (rows || []).map((r) => r.result).filter((r) => r && r.found && !r.empty && !r.frame);
      info = fields.find((r) => r.secret) || fields.find((r) => r.field) || { found: true, frame: true, secret: false };
    } catch { info = { found: true, frame: true, unreachable: true }; }
  }
  if (!focusWatched.has(tabId)) {
    focusWatched.add(tabId);
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: fpPage, args: ['focusWatch', {}] }).catch(() => {});
  }
  focusCache.set(tabId, { key, info });
  return info;
}
const focusWatched = new Set();
chrome.webNavigation.onCommitted.addListener((d) => { focusWatched.delete(d.tabId); bumpFocus(d.tabId); });

// one field of a fill: page engine first (native setter + events,
// read back); custom dropdowns are clicked open and the option clicked;
// a text field the page refused (mask / custom input) gets real typing
// (CDP Input.insertText) and is read back again; files go through
// DOM.setFileInputFiles (top frame).
const FILL_KIND = { textbox: '', text: 'text', textarea: 'textarea', password: 'password', email: 'email', number: 'number', slider: 'number', date: 'date',
  select: 'select', combobox: '', cascader: '', checkbox: 'checkbox', switch: 'checkbox', radio: 'radio', contenteditable: 'contenteditable', file: 'file' };
/* framework model read-back. Runs in the page's MAIN world (the isolated world cannot see
   React fibers / Vue instances): the value the FRAMEWORK holds for this field — React: the
   nearest component above the input that has a `value` prop (Ant / Arco InputNumber, Form.Item
   control), else the controlled input's own prop; Vue 3: modelValue of the owning component;
   Vue 2: the instance's value prop. Read-only; non-secret fields only (fill refuses secrets
   before this runs). Returns {fw:''} when no framework is attached to the element. */
function pageModel(ref) {
  const find = (root, r) => {
    const hit = root.querySelector('[data-foxpaw-ref="' + String(r).replace(/["\\]/g, '') + '"]');
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const h = find(el.shadowRoot, r); if (h) return h; }
    return null;
  };
  let el = find(document, ref);
  if (!el) return { found: false };
  const pf = el.getAttribute('data-foxpaw-proxy-for');
  if (pf) el = find(document, pf) || el;
  if (el.tagName === 'LABEL' && el.control) el = el.control;
  const out = { found: true, fw: '' };
  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
  const keys = Object.keys(el);
  const pk = keys.find((k) => k.startsWith('__reactProps$'));
  const fk = keys.find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  if (pk || fk) {
    out.fw = 'react';
    const own = pk ? el[pk] : null;
    let f = fk ? el[fk] : null;
    for (let i = 0; f && i < 12; i++, f = f.return) {
      const ty = f.type;
      if (typeof ty === 'string') {
        // a host node above the field that holds several fields = we left the field's own widget
        if (i > 0 && f.stateNode && f.stateNode.querySelectorAll && f.stateNode.querySelectorAll('input,textarea,select').length > 1) break;
        continue;
      }
      const comp = typeof ty === 'function' || (ty && typeof ty === 'object' && (ty.render || ty.type));
      if (comp && has(f.memoizedProps, 'value')) { out.model = f.memoizedProps.value; out.from = (ty.displayName || ty.name || (ty.render && (ty.render.displayName || ty.render.name)) || 'component'); break; }
    }
    if (!has(out, 'model') && has(own, 'value')) { out.model = own.value; out.from = 'input'; }
  } else if (el.__vueParentComponent) {
    out.fw = 'vue3';
    for (let c = el.__vueParentComponent, i = 0; c && i < 6; c = c.parent, i++) {
      if (c.props && c.props.modelValue !== undefined) { out.model = c.props.modelValue; out.from = (c.type && (c.type.name || c.type.__name)) || 'component'; break; }
    }
  } else {
    for (let n = el, i = 0; n && i < 6; n = n.parentElement, i++) {
      if (n.__vue__) { out.fw = 'vue2'; const vm = n.__vue__; if (vm.$props && has(vm.$props, 'value')) { out.model = vm.$props.value; out.from = (vm.$options && vm.$options.name) || 'component'; } break; }
    }
  }
  if (has(out, 'model')) {
    const m = out.model;
    out.modelType = m === null ? 'null' : typeof m;
    out.model = m == null ? null : typeof m === 'object' ? (() => { try { return JSON.stringify(m).slice(0, 200); } catch { return '[object]'; } })() : (typeof m === 'string' ? m.slice(0, 200) : m);
  }
  return out;
}
async function modelRead(tabId, cand) {
  try {
    const rows = await chrome.scripting.executeScript({ target: { tabId, frameIds: [cand.frameId || 0] }, world: 'MAIN', func: pageModel, args: [cand.local] });
    return rows && rows[0] ? rows[0].result : null;
  } catch { return null; }
}
const MODEL_KINDS = /^(text|textarea|email|number|date|)$/;
function modelMatches(m, want, kind) {
  if (m.modelType === 'object' || m.modelType === 'function') return null; // not comparable (dayjs / moment…)
  const v = m.model;
  if (v === null || v === undefined || v === '') return want === '';
  if (kind === 'number' || typeof v === 'number') return Number(v) === Number(want) && String(want).trim() !== '';
  return String(v) === want || String(v).trim() === want.trim();
}
// poll the model briefly (frameworks commit on the next tick / after blur)
async function verifyModel(tabId, cand, value, kind, ms = 600) {
  const want = String(value == null ? '' : value);
  let m = null;
  for (const t0 = Date.now(); ;) {
    m = await modelRead(tabId, cand);
    if (!m || !m.fw || !Object.prototype.hasOwnProperty.call(m, 'model')) return { checked: false, fw: (m && m.fw) || '' };
    const ok = modelMatches(m, want, kind);
    if (ok === null) return { checked: false, fw: m.fw };
    if (ok || Date.now() - t0 >= ms) return { checked: true, ok, m };
    await sleep(60);
  }
}
/* 1.29 real typing goes to whatever has focus. Focus the target, CHECK it is focused (click it for real once
   if not), and refuse rather than type into another box (FOCUS_LOST) — 「售价框焦点串字段」. */
async function focusForTyping(tabId, cand) {
  await inFrame(tabId, cand.frameId, 'focusSelect', { ref: cand.local });
  let f = await inFrame(tabId, cand.frameId, 'focusCheck', { ref: cand.local }).catch(() => null);
  if (f && f.ok) return;
  try { await realClick(tabId, cand, { timeout: 1500 }); } catch { /* fall through to the check */ }
  await inFrame(tabId, cand.frameId, 'focusSelect', { ref: cand.local });
  f = await inFrame(tabId, cand.frameId, 'focusCheck', { ref: cand.local }).catch(() => null);
  if (f && f.ok) return;
  const e = err('FOCUS_LOST', `could not put the cursor in "${cand.name || cand.ref}" — focus stays on ${f && f.focused ? '"' + f.focused + '"' : 'another element'}; nothing was typed (typing now would land in the wrong box). Take a new snapshot and retry, or click the box first`);
  e.detail = { field: cand.name || '', focused: (f && f.focused) || '' };
  throw e;
}
const numEq = (x, y) => { const cx = String(x).replace(/[,\s¥￥$]/g, ''), cy = String(y).replace(/[,\s¥￥$]/g, ''); return /^-?\d+(\.\d+)?$/.test(cy) && /^-?\d+(\.\d+)?$/.test(cx) && Number(cx) === Number(cy); };
async function typeReal(tabId, cand, value) {
  await focusForTyping(tabId, cand);
  await ensureDebugger(tabId);
  await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: String(value) }), 2500, 'INPUT_TIMEOUT');
  await inFrame(tabId, cand.frameId, 'blur', { ref: cand.local });
}
// 1.29 rich editors — select everything, then type line by line with a real Enter between lines
async function typeRich(tabId, cand, value) {
  await focusForTyping(tabId, cand);
  await ensureDebugger(tabId);
  const send = (m, p) => withTimeout(chrome.debugger.sendCommand({ tabId }, m, p), 2500, 'INPUT_TIMEOUT');
  const lines = String(value == null ? '' : value).split(/\r?\n/);
  // replace what is there: the selection from focusSelect, then Delete (editors that ignore a programmatic range get Ctrl/Cmd+A)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: /Mac/i.test(navigator.userAgent || '') ? 4 : 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: /Mac/i.test(navigator.userAgent || '') ? 4 : 2 });
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  for (let i = 0; i < lines.length; i++) {
    if (i) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    if (lines[i]) await send('Input.insertText', { text: lines[i] });
  }
  await sleep(60);
}
// 1.29.1 the editor's own model, from the page's world (Monaco global, CodeMirror 5 wrapper.CodeMirror,
// CodeMirror 6 view on .cm-content, ACE el.env.editor) — read it, or set it when real typing did not take
function pageCodeModel(ref, setTo) {
  const find = (root, r) => {
    const hit = root.querySelector('[data-foxpaw-ref="' + String(r).replace(/["\\]/g, '') + '"]');
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const h = find(el.shadowRoot, r); if (h) return h; }
    return null;
  };
  const el = find(document, ref);
  if (!el) return { found: false };
  const SEL = '.monaco-editor,.CodeMirror,.cm-editor,.ace_editor';
  const root = el.closest(SEL) || el.querySelector(SEL);
  if (!root) return { found: false };
  let api = null;
  try {
    if (root.classList.contains('monaco-editor')) {
      const M = window.monaco;
      const eds = M && M.editor && typeof M.editor.getEditors === 'function' ? M.editor.getEditors() : [];
      const ed = eds.find((e) => { const n = e.getDomNode && e.getDomNode(); return n && (n === root || n.contains(root) || root.contains(n)); });
      if (ed) api = { get: () => ed.getValue(), set: (v) => { const md = ed.getModel(); if (md && ed.executeEdits) { ed.executeEdits('foxpaw', [{ range: md.getFullModelRange(), text: v }]); if (ed.pushUndoStop) ed.pushUndoStop(); } else ed.setValue(v); } };
    } else if (root.classList.contains('CodeMirror')) {
      const cm = root.CodeMirror;
      if (cm && cm.getValue) api = { get: () => cm.getValue(), set: (v) => cm.setValue(v) };
    } else if (root.classList.contains('cm-editor')) {
      const c = root.querySelector('.cm-content');
      const cv = c && c.cmView;
      const view = cv && (cv.view || (cv.rootView && cv.rootView.view));
      if (view && view.state) api = { get: () => view.state.doc.toString(), set: (v) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }) };
    } else {
      const ed = (root.env && root.env.editor) || null;
      if (ed && ed.getValue) api = { get: () => ed.getValue(), set: (v) => ed.setValue(v, 1) };
    }
  } catch { api = null; }
  if (!api) return { found: true, model: null };
  try {
    if (typeof setTo === 'string') api.set(setTo);
    return { found: true, model: String(api.get()), set: typeof setTo === 'string' };
  } catch (e) { return { found: true, model: null, error: String(e && e.message || e).slice(0, 120) }; }
}
async function codeModel(tabId, cand, setTo) {
  try {
    const rows = await chrome.scripting.executeScript({ target: { tabId, frameIds: [cand.frameId || 0] }, world: 'MAIN', func: pageCodeModel, args: [cand.local, setTo === undefined ? null : setTo] });
    return rows && rows[0] ? rows[0].result : null;
  } catch { return null; }
}
const codeNorm = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n');
// read back: the model when the page lets us, otherwise the rendered lines + the gutter's last line number
async function codeVerify(tabId, cand, want) {
  const w = codeNorm(want);
  const wl = w.split('\n');
  for (let i = 0; ; i++) {
    const m = await codeModel(tabId, cand);
    if (m && typeof m.model === 'string') {
      const got = codeNorm(m.model);
      if (got === w || i >= 4) return { ok: got === w, verified: 'model', actual: got, actualLen: got.length, actualLines: got.split('\n').length };
    } else {
      const v = await inFrame(tabId, cand.frameId, 'codeRead', { ref: cand.local }).catch(() => null);
      const lines = (v && v.lines) || [];
      const lastNo = v && v.lastNo;
      const all = lastNo ? lines.length >= lastNo : lines.length >= wl.length; // every line of the editor is rendered
      let ok;
      if (lastNo && lastNo !== wl.length) ok = false;
      else if (lines.length >= wl.length) ok = lines.slice(0, wl.length).join('\n') === w && lines.length === wl.length;
      else { // only part is rendered (virtual scroll): those lines must be a run of the wanted lines, ending at the cursor (the end)
        const tail = wl.slice(wl.length - lines.length);
        ok = lines.length > 0 && lines.join('\n') === tail.join('\n');
      }
      const shown = lines.join('\n');
      if (ok || i >= 4) return { ok, verified: all ? 'visible' : 'visible-partial', actual: shown, actualLen: all ? shown.length : undefined, actualLines: lastNo || lines.length, ...(ok && !all ? { note: `编辑器只渲染了 ${lines.length} 行（共 ${lastNo || '?'} 行），按可见行 + 行号核对` } : {}) };
    }
    await sleep(80);
  }
}
async function typeCode(tabId, cand, value) {
  await focusForTyping(tabId, cand);
  await ensureDebugger(tabId);
  const send = (mth, p) => withTimeout(chrome.debugger.sendCommand({ tabId }, mth, p), 4000, 'INPUT_TIMEOUT');
  const mod = /Mac/i.test(navigator.userAgent || '') ? 4 : 2;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: mod, commands: ['selectAll'] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: mod });
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  if (String(value)) await send('Input.insertText', { text: codeNorm(value) });
  await sleep(80);
}
async function fillCode(tabId, cand, r, value) {
  const want = codeNorm(value);
  const c = r.input ? { ...cand, local: r.input } : cand; // type into the editor's own input (hidden textarea / .cm-content)
  let typed = false, typeErr = '';
  try { await typeCode(tabId, c, want); typed = true; } catch (e) { if (e && e.code === 'FOCUS_LOST') return { ok: false, kind: 'code', editor: r.editor, error: e.message }; typeErr = String((e && e.message) || e); }
  let v = await codeVerify(tabId, c, want);
  let via = typed ? 'insertText' : '';
  if (!v.ok) {
    // the editor rewrote real typing (auto-indent / auto-close) or typing could not run: set its model directly
    const m = await codeModel(tabId, c, want);
    if (m && m.set) { v = await codeVerify(tabId, c, want); via = 'model'; }
  }
  const out = { ok: v.ok, kind: 'code', editor: r.editor, via: via || undefined, verified: v.verified, actual: String(v.actual || '').slice(0, 200), actualLen: v.actualLen, expectedLen: want.length, ...(v.note ? { note: v.note } : {}) };
  if (!v.ok) out.error = `${r.editor} 编辑器${typeErr ? '（键盘输入失败：' + typeErr.slice(0, 80) + '）' : ''}：期望 ${want.length} 字符 / ${want.split('\n').length} 行，编辑器里实际 ${v.actualLen !== undefined ? v.actualLen + ' 字符 / ' : ''}${v.actualLines} 行`;
  return out;
}
// 1.29.1 every fill is read back; a value the page cut or rewrote is a clear failure with both lengths, never a
// silent success (FILL_MISMATCH)
const READBACK_KINDS = /^(text|textarea|email|number|date|datepicker|contenteditable|code|search|url|tel|)$/;
async function fillOne(tabId, cand, m, dryRun) {
  const r = await fillOneChecked(tabId, cand, m, dryRun);
  if (dryRun || !r || r.ok || !m || typeof m !== 'object' || CRED_OK.has(m) || Array.isArray(m.value) || typeof m.value === 'boolean') return r;
  if (!READBACK_KINDS.test(r.kind || '') || typeof r.actual !== 'string' || r.actual === '•••') return r;
  const want = codeNorm(m.value);
  const n = r.actualLen !== undefined ? r.actualLen : (r.kind === 'code' ? null : codeNorm(r.actual).length);
  return { ...r, code: 'FILL_MISMATCH', expectedLen: want.length, ...(n === null ? {} : { actualLen: n }),
    error: `写入被截断/改写：期望 ${want.length} 字符，实际 ${n === null ? '长度未知（编辑器只渲染了部分行）' : n + ' 字符'}${r.error ? '（' + r.error + '）' : ''}` };
}
async function fillOneChecked(tabId, cand, m, dryRun) {
  lastClickField.delete(tabId);
  const r = await fillOneRaw(tabId, cand, m, dryRun);
  if (dryRun || !r || !r.ok || !MODEL_KINDS.test(r.kind || '')) return r;
  if (m && typeof m === 'object' && CRED_OK.has(m)) return r; // 1.25: a credential (incl. a code) is never read back or re-typed
  const value = m.value;
  // (a) the DOM a moment later: a controlled component that re-renders from its own
  // state puts the old value back
  await sleep(40);
  const back = await inFrame(tabId, cand.frameId, 'read', { ref: cand.local }).catch(() => null);
  const domNow = back ? String(back.actual ?? '') : r.actual;
  const domOk = r.kind === 'number' ? (Number(domNow) === Number(value) || domNow === String(value)) : (domNow === String(value) || numEq(domNow, value));
  // (b) the framework's model
  let v = await verifyModel(tabId, cand, value, r.kind);
  if (domOk && (!v.checked || v.ok)) return { ...r, actual: domNow, verified: v.checked ? 'model' : 'dom', model: v.checked ? v.m.model : undefined };
  // remedy: real typing (trusted input events) + commit (change / blur), then read both again
  let typed = false;
  try { await typeReal(tabId, cand, value); typed = true; } catch (e) { if (e && e.code === 'FOCUS_LOST') return { ok: false, kind: r.kind, actual: domNow, error: e.message }; typed = false; }
  const back2 = await inFrame(tabId, cand.frameId, 'read', { ref: cand.local }).catch(() => null);
  const dom2 = back2 ? String(back2.actual ?? '') : domNow;
  const dom2Ok = r.kind === 'number' ? (Number(dom2) === Number(value) || dom2 === String(value)) : (dom2 === String(value) || numEq(dom2, value));
  v = await verifyModel(tabId, cand, value, r.kind);
  if (dom2Ok && (!v.checked || v.ok)) return { ...r, actual: dom2, via: 'insertText', verified: v.checked ? 'model' : 'dom', model: v.checked ? v.m.model : undefined };
  const out = { ok: false, kind: r.kind, actual: dom2, verified: v.checked ? 'model' : 'dom' };
  if (v.checked) {
    out.model = v.m.model;
    out.error = `the page's data did not take the value: ${v.m.fw} ${v.m.from || ''} holds ${JSON.stringify(v.m.model)} but "${value}" was filled (the box shows "${dom2}")${typed ? ' — real typing did not help either' : ''}`;
  } else out.error = `the page changed the value to "${dom2}" (controlled component / input mask)`;
  return out;
}
async function fillOneRaw(tabId, cand, m, dryRun) {
  const kind = m.kind ? (FILL_KIND[String(m.kind).toLowerCase()] ?? '') : '';
  const value = m.value;
  const credOk = !!(m && typeof m === 'object' && CRED_OK.has(m)); // set by the fill gate only, after the relay's grant checked out
  const r = await inFrame(tabId, cand.frameId, 'fill', { ref: cand.local, value, kind: kind || undefined, dryRun, allowSecret: credOk || undefined });
  if (!r) return { ok: false, error: 'page unreachable' };
  if (r.secret) throw await userStepErr({ tabId }, 'secret', 'this targets a secret field — the owner must type it personally', cand.name);
  if (credOk) return { ok: !!r.ok, actual: r.ok ? '•••' : '', kind: r.kind, error: r.error }; // a credential is never read back
  const readBack = async (pred, ms) => { // components commit asynchronously: poll briefly
    let actual = '';
    for (const t0 = Date.now(); ;) {
      const back = await inFrame(tabId, cand.frameId, 'read', { ref: cand.local });
      actual = back ? String(back.actual ?? '') : '';
      if (pred(actual) || Date.now() - t0 > ms) return actual;
      await sleep(40);
    }
  };
  if (r.need === 'combobox') {
    await realClick(tabId, cand, { timeout: 2000 });
    // 1.29 options live in a body-level popper (Element / Ant portal) and virtual lists render only the rows in
    // view: look, then scroll the open list a page at a time; a filterable select gets the text typed as a filter
    const want = String(value);
    const find = async (ms) => { try { return await locate(tabId, { option: want }, { timeout: ms }); } catch (e) { if (e.code === 'AMBIGUOUS') { const x = err('AMBIGUOUS', `option "${want}" is not unique`); throw x; } return null; } };
    let opt = null;
    try {
      opt = await find(1500);
      if (!opt) {
        await inFrame(tabId, cand.frameId, 'optScroll', { top: true }).catch(() => null);
        for (let i = 0; i < 60 && !opt; i++) {
          opt = await find(150);
          if (opt) break;
          const sc = await inFrame(tabId, cand.frameId, 'optScroll', {}).catch(() => null);
          if (!sc || !sc.moved) break;
          await sleep(60);
        }
      }
      if (!opt && cand.tag === 'INPUT' && !cand.readonly) {
        try { await typeReal(tabId, cand, want); await sleep(250); opt = await find(1500); } catch { /* not filterable */ }
      }
    } catch (e) { return { ok: false, kind: 'combobox', error: e.message }; }
    if (!opt) {
      const seen = await inFrame(tabId, cand.frameId, 'optList', {}).catch(() => null);
      return { ok: false, kind: 'combobox', error: `option "${want}" not found in the dropdown`, options: seen && seen.options && seen.options.length ? seen.options : undefined };
    }
    await realClick(tabId, opt, { timeout: 2000 });
    const wl = want.trim().toLowerCase();
    const actual = await readBack((a) => a.toLowerCase().includes(wl), 800);
    return { ok: actual.toLowerCase().includes(wl), kind: 'combobox', actual };
  }
  if (r.need === 'cascader') {
    // 1.29 「软件/会员」 = click 软件 in the first column (opens the next), then 会员 in the second …
    const parts = (Array.isArray(value) ? value.map(String) : String(value).split(/\s*[/／>＞→]\s*/)).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return { ok: false, kind: 'cascader', error: 'give the path as text, e.g. "软件/会员"' };
    await realClick(tabId, cand, { timeout: 2000 });
    for (let i = 0; i < parts.length; i++) {
      let node = null;
      try { node = await locate(tabId, { option: parts[i], col: i }, { timeout: 2500 }); } catch (e) {
        const seen = await inFrame(tabId, cand.frameId, 'optList', { col: i }).catch(() => null);
        return { ok: false, kind: 'cascader', error: e.code === 'AMBIGUOUS' ? `"${parts[i]}" is not unique in level ${i + 1}` : `"${parts[i]}" not found in level ${i + 1} of the cascader`, options: seen && seen.options && seen.options.length ? seen.options : undefined };
      }
      await realClick(tabId, node, { timeout: 2000 });
      await sleep(120);
    }
    const back = await inFrame(tabId, cand.frameId, 'read', { ref: cand.local }).catch(() => null);
    const actual = back ? String(back.actual ?? '') : '';
    const okC = parts.every((x) => actual.includes(x));
    return { ok: okC, kind: 'cascader', actual, ...(okC ? {} : { error: `the cascader shows "${actual}" after choosing ${parts.join(' / ')}` }) };
  }
  if (r.need === 'code') return fillCode(tabId, cand, r, value);
  if (r.need === 'richtext') {
    let typed = false;
    try { await typeRich(tabId, cand, value); typed = true; } catch (e) { if (e && e.code === 'FOCUS_LOST') return { ok: false, kind: 'contenteditable', error: e.message }; }
    const want = String(value == null ? '' : value).replace(/\s+/g, '');
    let back = await inFrame(tabId, cand.frameId, 'read', { ref: cand.local }).catch(() => null);
    let actual = back ? String(back.actual ?? '') : '';
    if (!typed || actual.replace(/\s+/g, '') !== want) {
      // no debugger / the editor refused trusted typing: the DOM route (execCommand) as before
      const r2 = await inFrame(tabId, cand.frameId, 'fill', { ref: cand.local, value, kind: 'contenteditable', domOnly: true });
      actual = r2 ? String(r2.actual ?? '') : actual;
      return { ok: !!(r2 && r2.ok), kind: 'contenteditable', actual: actual.slice(0, 200), actualLen: actual.length, via: 'dom', ...(r2 && r2.ok ? {} : { error: 'the editor did not take the text (rich editor refused both real typing and DOM insert)' }) };
    }
    await inFrame(tabId, cand.frameId, 'blur', { ref: cand.local }).catch(() => null);
    return { ok: true, kind: 'contenteditable', actual: actual.slice(0, 200), via: 'insertText' };
  }
  if (r.need === 'datepicker') {
    // custom pickers (Ant / rc-picker): open it, type the date for real, Enter
    await realClick(tabId, cand, { timeout: 2000 });
    await focusForTyping(tabId, cand);
    await ensureDebugger(tabId);
    await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: String(value) }), 2500, 'INPUT_TIMEOUT');
    for (const type of ['rawKeyDown', 'keyUp']) {
      await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }), 2500, 'INPUT_TIMEOUT');
    }
    const actual = await readBack((a) => a === String(value), 600);
    if (actual !== String(value)) return { ok: false, kind: 'datepicker', actual, error: 'the picker did not accept "' + value + '" (format?)' };
    await inFrame(tabId, cand.frameId, 'blur', { ref: cand.local });
    return { ok: true, kind: 'datepicker', actual };
  }
  if (r.need === 'file') {
    if (cand.frameId) return { ok: false, kind: 'file', error: 'file inputs inside iframes are not supported' };
    const files = (Array.isArray(value) ? value : [value]).map(String);
    await ensureDebugger(tabId);
    const docR = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 0 });
    const q = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', { nodeId: docR.root.nodeId, selector: `[data-foxpaw-ref="${cand.local}"]` });
    if (!q || !q.nodeId) return { ok: false, kind: 'file', error: 'file input not reachable (shadow DOM?)' };
    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { nodeId: q.nodeId, files });
    const back = await inFrame(tabId, 0, 'read', { ref: cand.local });
    return { ok: !!(back && back.actual), kind: 'file', actual: back ? back.actual : '' };
  }
  if (r.need === 'insertText') {
    try {
      await focusForTyping(tabId, cand);
      await ensureDebugger(tabId);
      await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: String(value) }), 2500, 'INPUT_TIMEOUT');
      await inFrame(tabId, cand.frameId, 'blur', { ref: cand.local });
      const back = await inFrame(tabId, cand.frameId, 'read', { ref: cand.local });
      const actual = back ? String(back.actual ?? '') : '';
      const okT = actual === String(value) || numEq(actual, value);
      return { ok: okT, kind: r.kind, actual, error: okT ? undefined : `the page changed the value to "${actual}" (input mask / normalisation)` };
    } catch (e) {
      if (e && e.code === 'FOCUS_LOST') return { ok: false, kind: r.kind, actual: r.actual, error: e.message };
      return { ok: false, kind: r.kind, actual: r.actual, error: `the page changed the value to "${r.actual}"` };
    }
  }
  return r;
}

/* ---------------- CDP semantics ----------------
   Raw CDP is a first-class entrance to execCore, not a side door:
   - script execution (Runtime.evaluate & co): existing card, approve once
     per connection per origin for the evaluate family;
   - Input.dispatchMouseEvent mousePressed: hit-test the point and classify
     the element exactly like a ref click (pay -> USER_STEP, delete/submit
     -> card, unknown/iframe -> card in 每次问我); the matching mouseReleased
     inherits that decision; moves / wheel / hover pass straight through;
   - Input.insertText / dispatchKeyEvent: the focused field — secret ->
     USER_STEP; Enter classifies the form's default button like a click;
     plain typing passes (no card);
   - Page.navigate: URL scheme + site block (no card);
   - DOM.setFileInputFiles: always a card;
   - session data (CDP_SENSITIVE): card (cookies every call; per-origin
     storage once per connection), refused under 只看;
   - everything else: access + scope + site block only. */
const CDP_SCRIPT_EXEC = new Set([
  'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.compileScript',
  'Runtime.runScript', 'Page.addScriptToEvaluateOnNewDocument',
  'Debugger.evaluateOnCallFrame', 'Debugger.setScriptSource',
]);
const CDP_BLOCK_ONLY = new Set(['Page.createIsolatedWorld']);
const CDP_CONDITIONAL_EXEC = new Set(['Debugger.setBreakpoint', 'Debugger.setBreakpointByUrl']);
const CDP_EVAL_FAMILY = new Set(['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.compileScript', 'Runtime.runScript']);
function cdpScriptDetail(method, params) {
  const p = params || {};
  const src = p.expression || p.functionDeclaration || p.source || p.scriptSource || p.condition || (p.scriptId ? `scriptId ${p.scriptId}` : '');
  return String(src).slice(0, 200);
}
const pressDecision = new Map(); // tabId -> ts of an allowed mousePressed (its release inherits it)
// 1.29 the text box an agent's foxpaw_click last put the cursor in (cleared by a coordinate click, Tab, fill)
const lastClickField = new Map(); // tabId -> {local, frameId, name, at}
const LAST_CLICK_FIELD_MS = 60000;
async function elementInfo(tabId, sel) {
  try { return await execScript(tabId, pageElementInfo, [sel, SECRET_HINT.source]); } catch { return { found: false, unreachable: true }; }
}
function clickMeta(tab, info, cat, via) {
  const name = String((info && info.name) || (info && info.frame ? '内嵌框架里的元素' : '无名按钮')).slice(0, 30);
  if (cat === 'pay') { // 1.33.2 every time a card, marked 付款 with the amount / period when the page shows one
    const amount = payAmount(`${(info && (info.ctx || info.near)) || ''} ${(info && info.name) || ''}`);
    return { category: 'pay', title: `点击「${name}」${amount ? `（${amount}）` : ''}`, detail: [via, ((info && (info.ctx || info.near)) || '').slice(0, 120)].filter(Boolean).join(' · '), amount, basis: '' };
  }
  return { category: cat, title: `点击「${name}」`, detail: via || '', basis: `${originOf(tab.url)}|${cat}|${(info && info.formAction) || ''}|${name}` };
}
async function cdpClassify(tab, method, params, ctx) {
  const p = params || {};
  const origin = originOf(tab.url);
  if (CDP_SENSITIVE.test(method)) {
    return { category: 'session', title: '读取或改动登录会话数据（Cookie / 本地存储）', detail: method,
      once: CDP_COOKIE_EVERY_CALL.test(method) ? null : `session|${method.split('.')[0]}|${origin}` };
  }
  if (method === 'Page.createIsolatedWorld' && p.grantUniversalAccess === true) throw err('GRANT_UNIVERSAL_ACCESS', 'grantUniversalAccess=true is not allowed');
  if (CDP_BLOCK_ONLY.has(method)) return null;
  if (!/^Input\./.test(method) && !CDP_READ.test(method)) bumpFocus(tab.id); // DOM.focus / scripts / navigation may move focus
  if (CDP_SCRIPT_EXEC.has(method) || (CDP_CONDITIONAL_EXEC.has(method) && String(p.condition || '').trim())) {
    // 1.29 an agent's approved script card covers that agent + site + task (intent), no longer every agent
    // on the origin; a command with no agent identity (pre-2.9 relay) keeps the old approve-once per connection
    return { category: 'eval', title: '在页面上运行一段脚本', detail: cdpScriptDetail(method, p) || method,
      once: CDP_EVAL_FAMILY.has(method) && !(ctx && ctx.agentId) ? `eval|${origin}` : null };
  }
  if (method === 'Input.dispatchMouseEvent' || method === 'Input.emulateTouchFromMouseEvent') {
    if (p.type === 'mousePressed') { bumpFocus(tab.id); lastClickField.delete(tab.id); } // a press can move focus
    if (p.type === 'mouseReleased') {
      const t = pressDecision.get(tab.id);
      if (t && Date.now() - t < 15000) { pressDecision.delete(tab.id); return null; }
    } else if (p.type !== 'mousePressed') return null; // move / wheel / hover: no semantics
    const info = await elementInfo(tab.id, { x: Number(p.x) || 0, y: Number(p.y) || 0 });
    const cat = info.unreachable ? 'unknown' : classifyElement(info);
    if (cat === 'normal') { if (p.type === 'mousePressed') pressDecision.set(tab.id, Date.now()); return null; }
    const m = clickMeta(tab, info, cat, `坐标点击 (${Math.round(p.x)}, ${Math.round(p.y)})`);
    m.after = () => { if (p.type === 'mousePressed') pressDecision.set(tab.id, Date.now()); };
    return m;
  }
  if (method === 'Input.dispatchTouchEvent') {
    if (p.type !== 'touchStart') return null;
    bumpFocus(tab.id);
    const pt = (p.touchPoints || [])[0] || {};
    const info = await elementInfo(tab.id, { x: Number(pt.x) || 0, y: Number(pt.y) || 0 });
    const cat = info.unreachable ? 'unknown' : classifyElement(info);
    return cat === 'normal' ? null : clickMeta(tab, info, cat, '触摸点击');
  }
  if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent' || method === 'Input.imeSetComposition') {
    const isEnter = method === 'Input.dispatchKeyEvent' && (p.type === 'keyDown' || p.type === 'rawKeyDown' || p.type === 'char')
      && (p.key === 'Enter' || p.code === 'Enter' || p.code === 'NumpadEnter' || p.windowsVirtualKeyCode === 13 || p.text === '\r');
    const isTab = method === 'Input.dispatchKeyEvent' && (p.key === 'Tab' || p.code === 'Tab' || p.windowsVirtualKeyCode === 9);
    if (isTab || isEnter) bumpFocus(tab.id); // focus may move: re-check now and after
    if (isTab) lastClickField.delete(tab.id);
    const typesText = method !== 'Input.dispatchKeyEvent' || (p.text && p.type !== 'keyUp') || isEnter;
    if (!typesText) return null;
    const info = await focusedInfo(tab.id); // cached per (document, focus generation)
    if (isEnter) bumpFocus(tab.id);
    // 1.29 text never goes "somewhere": into no field at all, or into another box than the one the agent's last
    // foxpaw_click put the cursor in (the page moved focus) → refused, nothing typed
    if (method === 'Input.insertText' && !isEnter) {
      if (!info.found || info.empty || (!info.field && !info.frame)) {
        const e = err('NO_FOCUSED_FIELD', 'no text box has the cursor — Input.insertText would type into nothing (or trigger page hotkeys). Click the box with foxpaw_click (it reports focused:true) or use foxpaw_fill');
        e.detail = { focused: info.name || info.tag || '' }; throw e;
      }
      const lc = lastClickField.get(tab.id);
      if (lc && Date.now() - lc.at < LAST_CLICK_FIELD_MS && !lc.frameId && !info.inner && !info.frame && info.fref !== lc.local) {
        const e = err('FOCUS_MOVED', `you clicked "${lc.name || lc.local}" but the cursor is now in "${info.name || info.tag}" — nothing was typed. Click the box again (or use foxpaw_fill with its ref)`);
        e.detail = { clicked: lc.name || '', focused: info.name || '' }; throw e;
      }
    }
    if (ctx && !isEnter) ctx.typedInto = { name: String(info.name || '').slice(0, 60), tag: info.tag || '', ...(info.secret ? { secret: info.secretKind || 'password' } : {}) };
    if (info.secret && !isEnter) {
      // 1.29 raw CDP typing obeys the same credential rule as fill — inside trust the agent's own password /
      // code / 商品卡密 / captcha characters go in (never a payment-class box or anything on a payment page)
      const k = info.secretKind || 'password';
      if (k === 'card' || !ctx || ctx.local || !ctx.agentId || isPayPage(tab.title, tab.url)) return { category: 'secret' };
      if (trustScope(ctx, hostOfUrl(tab.url || ''))) return { category: 'normal', credInput: { field: String(info.name || '字段').slice(0, 40), kind: k } };
      if (k === 'stock') return { category: 'stock', title: '向商品卡密框输入', detail: '商品库存的卡号 / 卡密（不是支付卡）', host: hostOfUrl(tab.url || '') };
      return { category: 'secret' };
    }
    if (isEnter && info.inForm && !info.textarea) {
      const cat = classifyText(info.submitName);
      return cat === 'normal' ? null : { category: cat, title: `回车提交「${String(info.submitName).slice(0, 30)}」`, detail: '键盘回车会提交表单', basis: `${origin}|${cat}|${info.formAction || ''}|${info.submitName}` };
    }
    return null;
  }
  if (method === 'DOM.setFileInputFiles') {
    return { category: 'upload', title: '向页面上传本机文件', detail: (p.files || []).map(String).join('；').slice(0, 200) };
  }
  return null;
}

const snapState = new Map(); // tabId -> {epoch, counter}
async function execScript(tabId, func, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r.result;
}
async function groupTab(tabId, preferGid) {
  await groupsReady();
  let wid = null;
  try { const t = await chrome.tabs.get(tabId); wid = t && t.windowId != null ? t.windowId : null; } catch { /* mocked / gone */ }
  let gid = preferGid !== undefined && isOwnGroup(preferGid) ? preferGid : await ownGroupInWindow(wid, false);
  if (gid === -1) gid = await ownGroupInWindow(wid, true, tabId);
  else await chrome.tabs.group({ tabIds: [tabId], groupId: gid });
  bumpEpoch(tabId);
  return gid;
}
// Every handler is a thin description of ONE action for execCore; none of
// them checks anything itself (one gate, not one per entrance).
/* ---------------- flow replay (1.17, ) ----------------
   A foxpaw.flow/1 flow is replayed HERE, step by step, and every step is one
   ordinary execCore() call (the same handlers an agent uses): the access
   gate, pause / human lock, group scope, site rules, semantic classes and
   approval cards all apply unchanged. Targets are resolved semantically
   (role+name → label → placeholder → test id → text → CSS last). A pay /
   authorize click, a secret field or an explicit userStep STOPS the run:
   the owner does that step personally, then the run resumes from the next
   step (runId + from). Failures report the step number, the reason and a
   screenshot key. The old agent-pw Playwright replay is deprecated. */
const flowRuns = new Map(); // runId -> {flow, tabs, vars, data, at}
const FLOW_SHOT_KEY = 'foxpawFlowShots';
const KEYMAP = { Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Space: [32, 'Space', ' '],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'] };
function keyParams(key, mods) {
  const m = (mods || []).reduce((a, x) => a | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[x] || 0), 0);
  let code, vk, text;
  if (KEYMAP[key]) [vk, code, text] = KEYMAP[key];
  else if (/^F(\d{1,2})$/.test(key)) { vk = 111 + Number(key.slice(1)); code = key; }
  else if (/^[A-Za-z]$/.test(key)) { vk = key.toUpperCase().charCodeAt(0); code = 'Key' + key.toUpperCase(); text = key; }
  else if (/^\d$/.test(key)) { vk = key.charCodeAt(0); code = 'Digit' + key; text = key; }
  if (m & 6) text = undefined; // Ctrl / Meta shortcuts type nothing
  const k = key === 'Space' ? ' ' : key;
  return { down: { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: m, ...(text ? { text, unmodifiedText: text } : {}) },
    up: { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: m } };
}
async function flowFrameUrls(tabId) {
  try { const fr = await chrome.webNavigation.getAllFrames({ tabId }); return new Map((fr || []).map((f) => [f.frameId, f.url || ''])); } catch { return new Map(); }
}
// a recorded target -> one live ref (unique match), waiting like auto-wait does
async function flowResolve(tabId, target, timeout) {
  const specs = FF.targetSpecs(target);
  if (!specs.length) throw err('BAD_TARGET', 'step has no usable target');
  const t0 = Date.now();
  let ambiguous = null;
  for (let i = 0; ; i++) {
    for (const sp of specs) {
      let c;
      try { c = await resolveOnce(tabId, sp); } catch (e) { if (e.code === 'BAD_SELECTOR') continue; throw e; }
      if (c.length > 1 && target.frame && target.frame.url) {
        const urls = await flowFrameUrls(tabId);
        const pre = String(target.frame.url).replace(/\*$/, '');
        const inF = c.filter((x) => String(urls.get(x.frameId) || '').startsWith(pre));
        if (inF.length) c = inF;
      }
      if (c.length === 1) return { ref: c[0].ref, cand: c[0], spec: sp };
      if (c.length > 1 && !ambiguous) ambiguous = { sp, c };
    }
    if (ambiguous && Number.isInteger(target.nth) && ambiguous.c.length > target.nth && ambiguous.sp.role) return { ref: ambiguous.c[target.nth].ref, cand: ambiguous.c[target.nth], spec: ambiguous.sp };
    if (Date.now() - t0 >= timeout) {
      if (ambiguous) { const e = err('AMBIGUOUS', `several elements match ${FF.describeTarget(target)} — the page changed since recording`); e.candidates = candList(ambiguous.c); throw e; }
      throw err('NOT_FOUND', `element not found: ${FF.describeTarget(target)}`);
    }
    ambiguous = null;
    await sleep(i < 4 ? 60 : 150);
  }
}
async function flowShot(tabId, runId, at) {
  try {
    await ensureDebugger(tabId);
    const r = await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 }), 10000, 'CDP_TIMEOUT');
    if (!r || !r.data) return null;
    const key = `flowshot:${runId}:${at}`;
    const { [FLOW_SHOT_KEY]: shots = {} } = await chrome.storage.local.get(FLOW_SHOT_KEY);
    const keep = Object.entries(shots).sort((a, b) => b[1].ts - a[1].ts).slice(0, 5);
    await chrome.storage.local.set({ [FLOW_SHOT_KEY]: Object.fromEntries([...keep, [key, { ts: Date.now(), tabId, dataUrl: 'data:image/jpeg;base64,' + r.data }]]) });
    return { store: 'chrome.storage.local', key: `${FLOW_SHOT_KEY}["${key}"]`, id: key, bytes: Math.round(r.data.length * 0.75) };
  } catch { return null; }
}
class FlowStop extends Error { constructor(code, message, extra) { super(message); this.code = code; this.flowStop = true; Object.assign(this, extra || {}); } }
const USER_REASON_CN = { pay: '付款', grant: '授权', secret: '密码 / 验证码 / 卡号等秘密字段', captcha: '验证码 / 人机校验', manual: '需要主人亲自操作', file: '选择本机文件' };
async function flowStep(run, s, sub) {
  const tab = run.tabs[s.tab || 't0'];
  if (tab === undefined) throw err('TAB_GONE', `tab ${s.tab} of the flow is not open (the step that opens it did not run)`);
  sub.tabId = tab;
  const wait = Math.min(Number(s.timeout) || Number(run.opts.timeout) || AUTO_WAIT_MS, 60000);
  const val = (v) => {
    if (v && typeof v === 'object') {
      const def = (run.flow.vars || {})[v.var] || {};
      // 录制 2.0: a value handed in WHILE the run waited (waitInput) — typed through the same gate as any fill
      if (run.inputs && run.inputs[v.var] !== undefined && run.inputs[v.var] !== '') return run.inputs[v.var];
      if (FF.isSecretKind(def.kind)) throw new FlowStop('USER_STEP', `${USER_REASON_CN.secret}「${def.label || v.var}」由主人亲自填写`, { reason: 'secret', var: v.var });
      if (run.vars[v.var] === undefined || run.vars[v.var] === '') throw new FlowStop('NEED_VAR', `缺少变量 ${v.var}（${def.label || def.kind || ''}）`, { reason: 'var', var: v.var });
      return run.vars[v.var];
    }
    return v;
  };
  const fillField = async (target, value, kind) => {
    const r0 = await flowResolve(tab, target, wait);
    const r = await handlers.fill({ tabId: tab, fields: [{ ref: r0.ref, value, ...(kind ? { kind } : {}) }] }, sub);
    const f = (r.fields || [])[0] || {};
    if (!r.ok || !f.ok) throw err('FILL_MISMATCH', `${FF.describeTarget(target)}: ${f.error || '页面上的值是「' + String(f.actual) + '」'}`);
    return { via: r0.spec, actual: kind === 'checkbox' ? f.actual : undefined };
  };
  switch (s.type) {
    case 'navigate': return handlers.navigate({ tabId: tab, url: s.url }, sub);
    case 'click': {
      const r0 = await flowResolve(tab, s.target, wait);
      const t0 = Date.now();
      let r;
      try { r = await handlers.click({ tabId: tab, ref: r0.ref }, sub); } catch (e) {
        // a popup that closes itself on this click (OAuth 「继续」): the tab is gone = done
        if (s.closes && /TAB_GONE|PAGE_UNREACHABLE|TAB_NOT_ASSIGNED/.test(e.code || '')) return { closed: true };
        throw e;
      }
      if (s.opens) {
        let opened = (r.opened || [])[0];
        for (let i = 0; !opened && i < 40; i++) { await sleep(75); opened = openedSince(tab, t0)[0]; }
        if (!opened) throw err('NO_NEW_TAB', 'this click should open a new tab / popup but none joined FoxPaw');
        run.tabs[s.opens] = opened.tabId;
      }
      return { via: r0.spec, navigated: r.navigated, opened: r.opened };
    }
    case 'fill': return fillField(s.target, val(s.value), s.kind);
    case 'select': return fillField(s.target, val(s.value), s.kind === 'combobox' ? undefined : s.kind);
    case 'check': return fillField(s.target, !!s.checked, undefined);
    case 'upload': {
      const v = run.vars[s.value.var];
      if (!v) throw new FlowStop('USER_STEP', `${USER_REASON_CN.file}：由主人亲自选择要上传的文件`, { reason: 'file', var: s.value.var });
      return fillField(s.target, v, 'file');
    }
    case 'press': {
      if (s.target) { const r0 = await flowResolve(tab, s.target, wait); const { frameId, local } = splitRef(r0.ref); await inFrame(tab, frameId, 'focusSelect', { ref: local }); }
      const kp = keyParams(s.key, s.mods);
      return execCore(sub, { cls: 'write', scope: 'control',
        classify: (t) => cdpClassify(t, 'Input.dispatchKeyEvent', kp.down),
        run: async () => {
          bumpFocus(tab);
          const seq0 = navSeq(tab);
          await ensureDebugger(tab);
          await chrome.debugger.sendCommand({ tabId: tab }, 'Input.dispatchKeyEvent', kp.down);
          await chrome.debugger.sendCommand({ tabId: tab }, 'Input.dispatchKeyEvent', kp.up);
          const nav = s.key === 'Enter' ? await settleNavigation(tab, seq0, NAV_START_LINK_MS, LOAD_TIMEOUT_MS) : null;
          return { pressed: [...(s.mods || []), s.key].join('+'), navigated: nav && nav.url };
        },
        audit: (o) => `flow press tab=${tab} ${o.pressed}` });
    }
    case 'wait': case 'assert': {
      const c = s.type === 'wait' ? s.for : s.that;
      const to = s.type === 'assert' ? Math.min(Number(s.timeout) || 3000, 60000) : Math.min(Number(s.timeout) || 15000, 60000);
      try {
        if (c.url || c.text !== undefined || c.textGone !== undefined || c.selector) {
          return await handlers.waitFor({ tabId: tab, url: c.url, text: c.text, textGone: c.textGone, selector: c.selector, state: c.state, timeout: to }, sub);
        }
        if (c.visible) { await flowResolve(tab, c.visible, to); return { ok: true }; }
        if (c.title !== undefined) {
          const t0 = Date.now();
          for (;;) { const t = await getTab(tab); if (String(t.title || '').includes(c.title)) return { ok: true }; if (Date.now() - t0 > to) throw err('WAIT_TIMEOUT', `title has no 「${c.title}」`); await sleep(120); }
        }
        if (c.value) {
          const r0 = await flowResolve(tab, c.value.target, to);
          const { frameId, local } = splitRef(r0.ref);
          const got = await inFrame(tab, frameId, 'read', { ref: local });
          if (got && got.secret) throw err('ASSERT_SECRET', 'secret fields are never read back');
          const want = val(c.value.equals);
          if (String(got && got.actual) !== String(want)) throw err('ASSERT_FAILED', `${FF.describeTarget(c.value.target)} 的值是「${got && got.actual}」，期望「${want}」`);
          return { ok: true };
        }
      } catch (e) {
        if (s.type === 'assert' && /WAIT_TIMEOUT|NOT_FOUND/.test(e.code || '')) throw err('ASSERT_FAILED', `断言不成立：${JSON.stringify(c).slice(0, 160)}`);
        throw e;
      }
      throw err('BAD_STEP', 'empty condition');
    }
    case 'scroll': return execCore(sub, { cls: 'write', scope: 'control', run: async () => {
      for (let i = 0; i < (s.times || 1); i++) {
        await chrome.scripting.executeScript({ target: { tabId: tab }, func: (to, dy) => { if (to === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight); else if (to === 'top') window.scrollTo(0, 0); else window.scrollBy(0, dy); }, args: [s.to || null, Number(s.dy) || 600] });
        await sleep(Number(s.waitMs) || 300);
      }
      return { scrolled: s.times || 1 };
    } });
    case 'extract': {
      if ((s.provider || 'builtin') !== 'builtin') throw err('PROVIDER_NOT_AVAILABLE', `采集提供方「${s.provider}」尚未接入`);
      const r = await execCore(sub, { cls: 'read', scope: 'control', run: async () => {
        const spec = { list: s.list, fields: s.fields, auto: s.auto, meta: s.meta, attachments: s.attachments, max: s.max };
        const t0 = Date.now();
        for (;;) {
          let out;
          try { [{ result: out }] = await chrome.scripting.executeScript({ target: { tabId: tab }, func: FF.pageExtract, args: [spec] }); } catch (e) { throw err('EXTRACT_FAILED', String((e && e.message) || e)); }
          const want = s.list || s.auto;
          if (!want || (out && out.rows.length && !out.loading) || Date.now() - t0 > Math.max(wait, 2000)) return out || { rows: [] };
          await sleep(150);
        }
      }, audit: (o) => `flow extract tab=${tab} ${o.rows.length} row(s)` });
      const into = s.into || 'rows';
      const rows = (r.rows || []).map((x) => (run.visiting ? { ...x, _sourceUrl: run.visiting } : x));
      (run.data[into] = run.data[into] || []).push(...rows);
      if (r.meta) (run.data.meta = run.data.meta || []).push(r.meta);
      if (r.attachments) (run.data.attachments = run.data.attachments || []).push(...r.attachments);
      return { rows: rows.length, mode: r.mode };
    }
    case 'paginate': {
      let pages = 0;
      for (let page = 1; page <= s.maxPages; page++) {
        for (let j = 0; j < s.body.length; j++) await flowRunOne(run, s.body[j], sub, `${run.at}.${j + 1}`);
        pages = page;
        if (page === s.maxPages) break;
        let clickArgs;
        if (s.next.auto) {
          const [{ result: f }] = await chrome.scripting.executeScript({ target: { tabId: tab }, func: FF.pageFindNext, args: [] });
          if (!f || !f.found || f.disabled) break;
          clickArgs = { tabId: tab, selector: '[data-foxpaw-next]' };
        } else {
          let r0;
          try { r0 = await flowResolve(tab, s.next, 1500); } catch { break; } // no 「next」 any more = last page
          if (r0.cand && (r0.cand.enabled === false || r0.cand.disabled)) break;
          clickArgs = { tabId: tab, ref: r0.ref };
        }
        const sig = async () => { const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab }, func: () => { const t = document.body ? document.body.innerText || '' : ''; return { t: t.length + ':' + t.slice(0, 400) + t.slice(-400), loading: /加载中|loading/i.test(t.slice(0, 3000)) }; } }); return result; };
        const before = await sig();
        await handlers.click(clickArgs, sub);
        const t0 = Date.now();
        for (;;) { const now = await sig().catch(() => null); if (now && now.t !== before.t && !now.loading) break; if (Date.now() - t0 > 15000) throw err('PAGE_NOT_CHANGED', 'clicked 「next page」 but the page did not change within 15 s'); await sleep(120); }
      }
      return { pages };
    }
    case 'visit': {
      const urls = (run.data[s.from] || []).map((x) => x && x[s.urlField || 'url']).filter((u) => /^https?:/.test(u || '')).slice(0, s.max);
      let ok = 0;
      for (const u of urls) {
        run.visiting = u;
        try {
          await handlers.navigate({ tabId: tab, url: u }, sub);
          for (let j = 0; j < s.body.length; j++) await flowRunOne(run, s.body[j], sub, `${run.at}.${j + 1}`);
          ok++;
        } catch (e) {
          if (e.flowStop || /USER_STEP|PAUSED|READ_ONLY|AGENT_PAUSED_ON_DEVICE|TAB_HELD_BY_HUMAN|CONFIRM_CANCELLED/.test(e.code || '')) throw e;
          (run.data.failures = run.data.failures || []).push({ url: u, error: (e.code ? e.code + ': ' : '') + String(e.message || e) });
        } finally { run.visiting = null; }
      }
      return { visited: urls.length, ok };
    }
    case 'closeTab': { const r = await handlers.closeTab({ tabId: tab }, sub); delete run.tabs[s.tab]; return r; }
    case 'userStep': throw new FlowStop('USER_STEP', `第 ${run.at} 步是「${USER_REASON_CN[s.reason] || s.reason}」${s.vendor ? '（' + s.vendor + '）' : ''}：${s.note || '由主人亲自完成'}`, { reason: s.reason });
    case 'waitInput': {
      if (run.inputs && run.inputs[s.var] !== undefined && run.inputs[s.var] !== '') return { input: s.var };
      const def = (run.flow.vars || {})[s.var] || {};
      throw new FlowStop('NEED_INPUT', `第 ${run.at} 步等外部输入「${s.prompt || def.label || s.var}」`, { reason: 'input', var: s.var, prompt: String(s.prompt || def.label || s.var).slice(0, 60), varKind: def.kind || 'text' });
    }
    case 'output': {
      // 录制 2.0: an element source is read here; a response-field source is filled by the exported script
      let v;
      if (s.target) {
        const r0 = await flowResolve(tab, s.target, wait);
        const { frameId, local } = splitRef(r0.ref);
        const got = await execCore(sub, { cls: 'read', scope: 'control', run: async () => inFrame(tab, frameId, 'read', { ref: local }), audit: () => `flow output ${s.name} tab=${tab}` });
        if (got && got.secret) throw err('ASSERT_SECRET', 'secret fields are never read back');
        v = got && got.actual !== undefined ? got.actual : null;
      }
      (run.data.outputs = run.data.outputs || {})[s.name] = v === undefined ? null : v;
      if (v === undefined && s.request) (run.data.outputsFromScript = run.data.outputsFromScript || []).push(s.name);
      return { output: s.name };
    }
    default: throw err('BAD_STEP', 'unknown step type ' + s.type);
  }
}
async function flowRunOne(run, s, sub, label) {
  const t0 = Date.now();
  try {
    const r = await flowStep(run, s, sub);
    run.timing.push({ at: label, id: s.id, type: s.type, ms: Date.now() - t0 });
    return r;
  } catch (e) {
    if (!e.at) { e.at = label; e.stepId = s.id; e.stepType = s.type; e.stepTab = run.tabs[s.tab || 't0']; }
    throw e;
  }
}
/* ---- 1.21: 运行不黑盒 + 失败改暂停 ----
   A run the relay records (msg.relayRunId, stamped by relay ≥3.4) reports every step
   (run.step: running → ok / failed, ms, a compressed JPEG of the tab) so the console and
   the panel show live progress. msg.onFail === 'pause': a failing step does not end the run —
   it returns paused (pauseKind 'fail', resume {runId, from: the same step}) and keeps the run
   here; the relay later resends {runId, from} (retry = same step, continue / skip = next step).
   Codes that mean "stop, do not ask" (cancelled, read-only, paused by the owner, bad flow)
   still fail. Without relayRunId / onFail the behaviour is exactly 1.20 (old relays). */
const RUN_HARD_STOP = /^(CONFIRM_CANCELLED|READ_ONLY|PAUSED|AGENT_PAUSED_ON_DEVICE|BAD_FLOW|BAD_ARGS|FLOW_UNAVAILABLE|TAB_HELD_BY_HUMAN|RUN_ABORTED)$/;
const runCtx = new Map(); // relayRunId -> ctx of the segment running now (run.abort cancels it)
async function runShot(tabId) {
  // small JPEG for the relay: ≤ 800 px wide, quality 45 (≈ 30–80 KB); never throws
  try {
    await ensureDebugger(tabId);
    let clip;
    try {
      const m = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics', {});
      const v = (m && (m.cssVisualViewport || m.visualViewport)) || null;
      if (v && v.clientWidth > 0 && v.clientHeight > 0) clip = { x: v.pageX || 0, y: v.pageY || 0, width: v.clientWidth, height: Math.min(v.clientHeight, 2000), scale: Math.min(1, 800 / v.clientWidth) };
    } catch { /* no metrics: full-size capture */ }
    const r = await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 45, ...(clip ? { clip } : {}) }), 10000, 'CDP_TIMEOUT');
    if (!r || !r.data || r.data.length > 380000) return null;
    return r.data;
  } catch { return null; }
}
// 录制 2.0: values for waitInput steps. They come as msg.inputs (relay ≥3.7) or — older relays / the
// legacy resume — as msg.vars for a variable a waitInput step asks for. Kept on the run only (never stored).
function flowTakeInputs(run, msg) {
  const want = new Set();
  const walk = (steps) => (steps || []).forEach((x) => { if (x && x.type === 'waitInput') want.add(x.var); if (x && x.body) walk(x.body); });
  walk(run.flow.steps);
  if (!want.size) return;
  run.inputs = run.inputs || {};
  for (const src of [msg.vars, msg.inputs]) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) if (want.has(k) && (typeof v === 'string' || typeof v === 'number') && String(v) !== '') run.inputs[k] = String(v).slice(0, 500);
  }
}
async function flowExec(msg, ctx) {
  if (!FF) throw err('FLOW_UNAVAILABLE', 'flow.js not loaded');
  let run;
  if (msg.runId && flowRuns.has(msg.runId)) {
    run = flowRuns.get(msg.runId);
    Object.assign(run.vars, msg.vars && typeof msg.vars === 'object' ? msg.vars : {});
    flowTakeInputs(run, msg);
  } else {
    const flow = msg.flow;
    const v = FF.validate(flow);
    if (!v.ok) throw err('BAD_FLOW', 'flow does not validate: ' + v.errors.slice(0, 5).join('; '));
    if (msg.tabId === undefined || msg.tabId === null) throw err('BAD_ARGS', 'tabId (the start tab, t0) is required');
    run = { id: 'fr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), flow, tabs: { t0: Number(msg.tabId) }, vars: {}, data: {}, opts: { timeout: msg.timeout } };
    for (const [k, id] of Object.entries(msg.tabs && typeof msg.tabs === 'object' ? msg.tabs : {})) if (/^t[1-9]\d*$/.test(k) && Number.isInteger(Number(id))) run.tabs[k] = Number(id);
    for (const [k, val] of Object.entries(msg.vars && typeof msg.vars === 'object' ? msg.vars : {})) {
      const def = (flow.vars || {})[k];
      if (def && !FF.isSecretKind(def.kind)) run.vars[k] = val; // secret values are never accepted: the owner types them
    }
    flowTakeInputs(run, msg);
    flowRuns.set(run.id, run);
    if (flowRuns.size > 20) flowRuns.delete(flowRuns.keys().next().value);
  }
  run.timing = [];
  const relayRunId = typeof msg.relayRunId === 'string' && msg.relayRunId ? msg.relayRunId : null;
  const onFail = msg.onFail === 'pause' ? 'pause' : 'fail';
  if (relayRunId) { run.relayRunId = relayRunId; runCtx.set(relayRunId, ctx); }
  const rep = (o) => { if (relayRunId) { try { wsSend({ type: 'run.step', runId: relayRunId, ...o }); } catch { /* offline: the result still reports */ } } };
  const tabUrl = async (tabId) => { try { return (await chrome.tabs.get(tabId)).url || ''; } catch { return ''; } };
  const steps = run.flow.steps;
  const from = Math.max(1, Number(msg.from) || 1);
  const t0 = Date.now();
  const sub = Object.create(ctx); // live view of ctx (cancellation, confirm ids) with a per-step tabId
  try {
    // the start tab must be controllable before anything happens
    await execCore(Object.assign(Object.create(ctx), { tabId: run.tabs.t0 }), { cls: 'write', scope: 'control', run: async () => true });
    for (let i = from; i <= steps.length; i++) {
      run.at = i;
      if (ctx.cancelled) throw err(ctx.runAborted ? 'RUN_ABORTED' : 'CONFIRM_CANCELLED', ctx.runAborted ? 'the run was ended (终止)' : 'the caller gave up — the replay stopped');
      const ts = Date.now();
      rep({ n: i, st: 'running' });
      try {
        await flowRunOne(run, steps[i - 1], sub, String(i));
        if (relayRunId) {
          const tid = run.tabs[steps[i - 1].tab || 't0'];
          const live = steps[i - 1].closes ? run.tabs.t0 : tid;
          rep({ n: i, st: 'ok', ms: Date.now() - ts, url: await tabUrl(live), shot: await runShot(live) });
        }
      } catch (e) {
        const s = steps[i - 1];
        const base = { ok: false, runId: run.id, at: i, of: steps.length, step: e.at || String(i), stepId: e.stepId || s.id, type: e.stepType || s.type,
          code: e.code || 'ERROR', message: String(e.message || e), ms: Date.now() - t0, timing: run.timing, data: run.data, tabs: run.tabs };
        const stepTab = e.stepTab !== undefined ? e.stepTab : run.tabs[(s && s.tab) || 't0'];
        if (e.code === 'NEED_INPUT') {
          // 录制 2.0: wait for outside input (a code …) — the Agent or the owner hands it in, the run goes on
          base.paused = true;
          base.pauseKind = 'input';
          base.reason = 'input';
          base.input = { var: e.var, prompt: e.prompt, kind: e.varKind };
          base.resume = { runId: run.id, from: i };
          base.next = `调用 foxpaw_run {run_id, action:'input', value:'…'} 交上「${e.prompt}」，运行从这一步接着跑`;
          if (relayRunId) rep({ n: i, st: 'failed', ms: Date.now() - ts, code: base.code, message: base.message.slice(0, 200) });
          else notifyOwner('fxn-run-' + run.id, `流程「${run.flow.name || ''}」第 ${i} 步等你输入`, `「${e.prompt}」`, stepTab);
        } else if (e.code === 'USER_STEP' || e.code === 'NEED_VAR') {
          // the owner does this step (or gives the variable): resume with {runId, from: at+1} (NEED_VAR: from: at)
          base.paused = true;
          base.pauseKind = 'user_step';
          base.reason = e.reason || (/pay/.test(base.message) ? 'pay' : /grant|authorize/.test(base.message) ? 'grant' : /secret|password|card/.test(base.message) ? 'secret' : 'manual');
          base.resume = { runId: run.id, from: e.code === 'NEED_VAR' ? i : i + 1 };
          if (e.var) base.var = e.var;
          if (e.code === 'USER_STEP') { // tell the owner, not only the agent
            base.needYou = e.needYou || await raiseUserStep({ ...ctx, tabId: stepTab }, base.reason, s && (s.note || s.label || ''));
            base.next = USER_STEP_NEXT;
          }
          if (relayRunId) rep({ n: i, st: 'failed', ms: Date.now() - ts, code: base.code, message: base.message.slice(0, 200), url: await tabUrl(stepTab), shot: await runShot(stepTab) });
        } else {
          const shot = await flowShot(stepTab, run.id, base.step);
          if (shot) base.shot = shot;
          if (e.candidates) base.candidates = e.candidates;
          if (relayRunId) rep({ n: i, st: 'failed', ms: Date.now() - ts, code: base.code, message: base.message.slice(0, 200), url: await tabUrl(stepTab), shot: await runShot(stepTab) });
          if (onFail === 'pause' && !RUN_HARD_STOP.test(base.code)) {
            // 1.21 wait for a human instead of failing — retry = same step, continue / skip = next
            base.paused = true;
            base.pauseKind = 'fail';
            base.resume = { runId: run.id, from: i };
            notifyOwner('fxn-run-' + (relayRunId || run.id), `流程「${run.flow.name || ''}」停在第 ${i} 步`, `${String(base.message).slice(0, 80)} — 在侧栏或控制台处理：继续 / 重试 / 跳过 / 终止`, stepTab);
          }
        }
        await audit(`flow ${run.flow.name || ''}: ${base.paused ? 'paused' : 'failed'} at step ${base.step}/${steps.length} ${base.code}`, { agent: ctx.agentLabel || undefined, agentId: ctx.agentId || undefined });
        await setUi({ flowRun: { runId: run.id, name: run.flow.name || '', paused: !!base.paused, at: base.step, of: steps.length, code: base.code, message: base.message.slice(0, 200), shot: base.shot ? base.shot.id : null, ts: Date.now() } });
        return base;
      }
    }
  } finally {
    if (relayRunId && runCtx.get(relayRunId) === ctx) runCtx.delete(relayRunId);
  }
  flowRuns.delete(run.id);
  const out = { ok: true, runId: run.id, steps: steps.length, ms: Date.now() - t0, timing: run.timing, data: run.data, tabs: run.tabs };
  await audit(`flow ${run.flow.name || ''}: done (${steps.length} steps, ${out.ms} ms)`, { agent: ctx.agentLabel || undefined, agentId: ctx.agentId || undefined });
  await setUi({ flowRun: { runId: run.id, name: run.flow.name || '', ok: true, of: steps.length, ms: out.ms, ts: Date.now() } });
  return out;
}
// relay ≥3.4: 终止 a run (paused: forget it here; running: cancel at the next step)
function runAbort(relayRunId, extRunId) {
  const c = runCtx.get(relayRunId);
  if (c) { c.runAborted = true; c.cancelled = true; }
  if (extRunId) flowRuns.delete(extRunId);
  for (const [id, r] of flowRuns) if (r.relayRunId === relayRunId) flowRuns.delete(id);
  clearNotice('fxn-run-' + relayRunId);
}

const handlers = {
  async ping(msg, ctx) {
    return execCore(ctx, { cls: 'read', scope: 'none', run: async () => ({ pong: true, version: VERSION, ts: Date.now() }) });
  },

  async listTasks(msg, ctx) {
    // an agent only sees tasks whose executor is itself or unset.
    return execCore(ctx, { cls: 'read', scope: 'none', run: async () => {
      const tasks = await loadLocalTasks();
      return { tasks: tasks.filter((t) => !ctx.agentId || !t.executor_agent_id || t.executor_agent_id === ctx.agentId) };
    } });
  },

  async taskResult({ taskId, status, detail }, ctx) {
    // legacy compat: the relay links cloud results itself; this
    // handler only serves old agents whose results were not linked.
    return execCore(ctx, { cls: 'write', scope: 'none', run: async () => {
      const foxpawTasks = await loadLocalTasks();
      const t = foxpawTasks.find((x) => x.id === taskId || x.legacy_id === taskId);
      if (!t) throw err('TASK_GONE', 'task not found: ' + taskId);
      t.lastRun = { status: String(status || '成功'), detail: String(detail || ''), at: Date.now() };
      t.runHistory = [t.lastRun, ...(Array.isArray(t.runHistory) ? t.runHistory : [])].slice(0, 5);
      await chrome.storage.local.set({ foxpawTasks });
      return { ok: true, task: t };
    }, audit: (o) => `task ${o.task.name}: ${o.task.lastRun.status}${detail ? ' — ' + detail : ''}` });
  },

  async tabs(msg, ctx) {
    return execCore(ctx, { cls: 'read', scope: 'none', run: async () => {
      const t = await listTabs();
      // only when the relay stamped caps.seeAllTabs for THIS agent do
      // titles/URLs of tabs outside the group leave the browser — read-only
      // metadata; such tabs can never be snapshotted or operated.
      if (ctx.caps.seeAllTabs) {
        const all = await chrome.tabs.query({});
        const ids = new Set(t.assigned.map((x) => x.id));
        // v1.17: blank / new-tab / extension pages (incl. this panel) are noise, never listed
        let own = '';
        try { own = chrome.runtime.getURL ? chrome.runtime.getURL('') : ''; } catch { own = ''; }
        const noise = (u) => !u || u === 'about:blank' || u.startsWith('about:') || (own && u.startsWith(own)) || u.startsWith('chrome-extension://') || u.startsWith('chrome://newtab') || u.startsWith('chrome-search://');
        const outside = (all || []).filter((x) => !ids.has(x.id) && !noise(x.url || x.pendingUrl || '')).map((x) => ({ id: x.id, title: (x.title || '').slice(0, 80), url: x.url || '', active: !!x.active, assigned: false, readonly: true }));
        return { ...t, outside, all: [...t.assigned, ...outside] };
      }
      return t;
    } });
  },

  // 1.30 paging (offset / limit → total, nextOffset), sub-frames grouped with their url (cross-origin / OOPIF
  // through scripting, unreachable ones through CDP), autoScroll (scroll to the bottom first), frames:'main'.
  async snapshot(msg, ctx) {
    const { tabId, maxElements } = msg;
    return execCore(ctx, { cls: 'read', scope: 'control', run: async (tab) => {
      const epoch0 = epochs.get(tabId) || 0;
      let scrolled = null;
      // 1.32 a bot-check page in a background tab: bring it forward briefly in its own window, then back
      let challenge = null;
      if (msg.challenge !== 'off') challenge = await passChallenge(tabId, ctx, msg, 'snapshot');
      if (msg.autoScroll) scrolled = await scrollRun(tabId, { to: 'bottom', timeout: Number(msg.scrollTimeout) || 15000, maxRounds: msg.maxRounds });
      const epoch = epochs.get(tabId) || epoch0;
      const paged = msg.offset !== undefined || msg.limit !== undefined;
      const offset = Math.max(0, Math.floor(Number(msg.offset) || 0));
      const limit = Math.min(Math.max(1, Math.floor(Number(msg.limit) || Number(maxElements) || 200)), paged ? 1000 : 600);
      const rows = await readFrames(tabId, 'snapshot', { max: Math.min(offset + limit, 6000) }, msg.frames === 'main');
      const topRow = rows.find((r) => r.frameId === 0) || rows[0] || {};
      const top = topRow.result || { title: tab.title, url: tab.url, text: '', forms: [], elements: [] };
      let topOrigin = '';
      try { topOrigin = new URL(top.url || tab.url).origin; } catch { topOrigin = ''; }
      const out = { title: top.title, url: top.url, text: top.text, forms: top.forms || [], elements: [], epoch, frames: [] };
      const all = [];
      let total = 0;
      for (const row of rows) {
        const r = row.result;
        if (!r) continue;
        total += Number.isFinite(r.total) ? r.total : (r.elements || []).length;
        for (const e of r.elements || []) {
          const o = { ...e, ref: joinRef(row.frameId, e.ref) };
          if (row.frameId) { o.frame = row.frameId; o.formIndex = -1; }
          if (row.via === 'cdp') o.readOnly = true;
          all.push(o);
        }
        if (row.frameId) {
          out.frames.push({ ...frameInfo(row, topOrigin), elements: (r.elements || []).length, total: Number.isFinite(r.total) ? r.total : undefined });
          if (r.text && r.text.trim()) out.text += `\n\n[frame f${row.frameId}${row.via === 'cdp' ? ' via cdp' : ''} ${String(r.url).slice(0, 80)}]\n` + String(r.text).slice(0, 200000);
        }
        if (r.truncated) out.truncated = true;
        if (r.slow) out.slow = true; // 1.28.1 the page engine hit its time budget — the list is partial
      }
      // 1.32 text paging (field test 11-05: the text stopped at 6000 and could not be paged): textOffset /
      // textLimit (default 20000) → textTotal, textNextOffset, textHasMore
      const fullText = String(out.text || '');
      const tOff = Math.max(0, Math.floor(Number(msg.textOffset) || 0));
      const tLim = Math.min(Math.max(200, Math.floor(Number(msg.textLimit) || SNAP_TEXT_LIMIT)), 200000);
      out.text = fullText.slice(tOff, tOff + tLim);
      out.textTotal = fullText.length;
      out.textOffset = tOff;
      out.textHasMore = tOff + tLim < fullText.length;
      out.textNextOffset = out.textHasMore ? tOff + tLim : null;
      if (top.overlaysSkipped) out.overlaysSkipped = top.overlaysSkipped;
      if (top.images && top.images.heavy) {
        out.imageHeavy = true;
        out.images = { count: top.images.count, big: top.images.big, areaRatio: top.images.areaRatio };
        out.hint = '正文主要是图片（文字在图里，text 读不到）：用 foxpaw_screenshot {fullPage:true} 看图 · the page is mostly pictures — take foxpaw_screenshot {fullPage:true}';
      }
      if (challenge) out.challenge = challenge;
      if (tOff > 0 && msg.offset === undefined) {
        // text-only page: the elements came with textOffset 0
        out.elements = []; delete out.forms; out.note = 'textOffset > 0: text only (elements / forms come with the first page)';
        out._url = tab.url;
        return out;
      }
      if (paged) {
        out.elements = all.slice(offset, offset + limit);
        out.total = total;
        out.offset = offset;
        out.limit = limit;
        out.nextOffset = offset + out.elements.length < total ? offset + out.elements.length : null;
        if (offset > 0 && msg.textOffset === undefined) { delete out.text; delete out.textTotal; delete out.textOffset; delete out.textHasMore; delete out.textNextOffset; delete out.forms; out.note = 'page ' + (Math.floor(offset / limit) + 1) + ': text / forms only on offset 0 (page the text with textOffset)'; }
        out.truncated = out.nextOffset !== null || out.slow || undefined;
      } else {
        out.elements = all; // legacy shape: each frame up to maxElements (default 200)
        if (total > all.length) { out.total = total; out.truncated = true; out.more = `${total} elements, ${all.length} listed — page through all of them with offset / limit (nextOffset), or use foxpaw_extract / foxpaw_query`; }
      }
      if (scrolled) out.scrolled = { rounds: scrolled.rounds, stoppedBy: scrolled.stoppedBy, height: scrolled.height, links: scrolled.links, grew: scrolled.grew };
      if (rows.skipped && rows.skipped.length) out.framesSkipped = rows.skipped; // frames that did not answer in time
      if (!out.frames.length) delete out.frames;
      out._url = tab.url;
      return out;
    }, audit: (d) => `snapshot tab=${tabId} ${d._url} (${d.elements.length} elements)` }).then((d) => { delete d._url; return d; });
  },

  // 1.30 foxpaw_extract: every match on the page (all frames by default) — CSS selector and / or URL regex,
  // de-duplicated list + counts. Read only.
  async extract(msg, ctx) {
    const { tabId } = msg;
    return execCore(ctx, { cls: 'read', scope: 'control', run: async (tab) => {
      const limit = Math.min(Math.max(1, Math.floor(Number(msg.limit) || 2000)), 10000);
      const arg = { selector: msg.selector ? String(msg.selector) : undefined, match: msg.match, textMatch: msg.textMatch, attr: msg.attr ? String(msg.attr) : undefined,
        visibleOnly: !!msg.visibleOnly, dedupe: msg.dedupe, text: msg.withText === false ? false : undefined, full: !!msg.full };
      const rows = await readFrames(tabId, 'extract', arg, msg.frames === 'main');
      for (const row of rows) {
        const r = row.result || {};
        if (r.error === 'BAD_SELECTOR') throw err('BAD_SELECTOR', 'invalid CSS selector: ' + msg.selector);
        if (r.error === 'BAD_REGEX') throw err('BAD_REGEX', 'invalid regular expression: ' + (msg.match || msg.textMatch));
      }
      let topOrigin = '';
      const topRow = rows.find((r) => r.frameId === 0);
      try { topOrigin = new URL((topRow && topRow.result && topRow.result.url) || tab.url).origin; } catch { topOrigin = ''; }
      const seen = new Map();
      const frames = [];
      let matched = 0;
      for (const row of rows) {
        const r = row.result;
        if (!r || r.error) continue;
        matched += r.matched || 0;
        frames.push({ ...frameInfo(row, topOrigin), matched: r.matched || 0, count: (r.items || []).length });
        for (const it of r.items || []) {
          const key = msg.dedupe === 'none' ? '#' + seen.size : msg.dedupe === 'text' ? 't:' + (it.text || '') : (it.href ? 'u:' + it.href : 't:' + (it.text || ''));
          const hit = seen.get(key);
          if (hit) { hit.n = (hit.n || 1) + (it.n || 1); continue; }
          seen.set(key, row.frameId ? { ...it, frame: 'f' + row.frameId } : { ...it });
        }
      }
      const uniq = [...seen.values()];
      const out = { url: tab.url, count: uniq.length, matched, items: uniq.slice(0, limit), frames };
      if (uniq.length > limit) { out.truncated = true; out.note = `${uniq.length} unique matches, ${limit} listed (raise limit, max 10000)`; }
      if (msg.groupByFrame) {
        out.frames = frames.map((f) => ({ ...f, items: out.items.filter((x) => (x.frame || 'f0') === f.frame).map(({ frame, ...x }) => x) }));
        delete out.items;
      }
      if (rows.skipped && rows.skipped.length) out.framesSkipped = rows.skipped;
      return out;
    }, audit: (d) => `extract tab=${tabId} ${d.count} unique / ${d.matched} matched` });
  },

  // 1.30 foxpaw_query: structured read-only DOM query — selector + text / href / attr / value / count / exists
  // (or fields per match). No script from the agent runs; secret boxes give •••.
  async query(msg, ctx) {
    const { tabId } = msg;
    return execCore(ctx, { cls: 'read', scope: 'control', run: async (tab) => {
      if (!msg.selector) throw err('BAD_ARGS', 'selector is required');
      const get = msg.get || 'text';
      if (!/^(text|href|attr|value|count|exists|visible|checked)$/.test(get)) throw err('BAD_ARGS', 'get = text | href | attr | value | count | exists | visible | checked');
      if (get === 'attr' && !msg.attr) throw err('BAD_ARGS', 'get:"attr" needs attr (the attribute name)');
      const arg = { selector: String(msg.selector), get, attr: msg.attr ? String(msg.attr) : undefined, fields: msg.fields, limit: msg.limit,
        visibleOnly: !!msg.visibleOnly, withRef: !!msg.withRef, maxLen: msg.maxLen, full: !!msg.full };
      const rows = await readFrames(tabId, 'query', arg, msg.frames !== 'all');
      let count = 0;
      const values = [];
      const frames = [];
      const lim = Math.min(Number(msg.limit) || 200, 5000);
      for (const row of rows) {
        const r = row.result;
        if (!r) continue;
        if (r.error === 'BAD_SELECTOR') throw err('BAD_SELECTOR', 'invalid CSS selector: ' + msg.selector);
        count += r.count || 0;
        if (rows.length > 1) frames.push({ frame: 'f' + row.frameId, url: String(r.url || '').slice(0, 300), count: r.count || 0 });
        for (const v of r.values || []) {
          if (values.length >= lim) break;
          values.push(row.frameId && v && typeof v === 'object' && v.ref ? { ...v, ref: joinRef(row.frameId, v.ref), frame: 'f' + row.frameId } : v);
        }
      }
      const out = { url: tab.url, selector: msg.selector, get, count };
      if (get === 'exists') out.exists = count > 0;
      else if (get !== 'count') { out.values = values; if (count > values.length) out.truncated = true; }
      if (frames.length) out.frames = frames;
      return out;
    }, audit: (d) => `query tab=${tabId} ${String(msg.selector).slice(0, 60)} ${d.get} (${d.count})` });
  },

  // 1.30 foxpaw_scroll: to bottom (repeat until nothing more loads), top, N screens, an element — then wait for
  // the DOM / network to settle. Scrolling only moves the view: read class.
  async scroll(msg, ctx) {
    const { tabId } = msg;
    return execCore(ctx, { cls: 'read', scope: 'control', run: async () => {
      let to = msg.to;
      const o = { timeout: msg.timeout, settleMs: msg.settleMs, maxRounds: msg.maxRounds };
      if (msg.ref || msg.selector) {
        to = 'element';
        if (msg.ref) { const { frameId, local } = splitRef(msg.ref); o.frameId = frameId; o.local = local; o.ref = msg.ref; }
        else o.selector = String(msg.selector);
      } else if (typeof to === 'number' || /^-?\d+(\.\d+)?$/.test(String(to || ''))) { o.screens = Number(to); to = 'by'; }
      else if (to === undefined || to === null || to === '') to = 'bottom';
      if (!/^(bottom|top|by|element)$/.test(to)) throw err('BAD_ARGS', 'to = "bottom" | "top" | a number of screens (e.g. 2, -1); or give ref / selector');
      if (msg.screens !== undefined && to === 'by') o.screens = Number(msg.screens);
      o.to = to;
      return scrollRun(tabId, o);
    }, audit: (d) => `scroll tab=${tabId} ${d.to} rounds=${d.rounds} ${d.stoppedBy}` });
  },

  // 1.30 foxpaw_screenshot: viewport / full page / one element, JPEG (or PNG) sized to fit the transport
  async screenshot(msg, ctx) {
    const { tabId } = msg;
    return execCore(ctx, { cls: 'read', scope: 'control', run: async () => {
      const spec = specOf(msg);
      let rect = null;
      if (spec) {
        const cand = await locate(tabId, spec, { timeout: Math.min(Number(msg.timeout) || 3000, 10000), nth: msg.nth });
        if (cand.frameId) throw err('BAD_ARGS', 'element screenshots work on the top document only — this element is inside a frame; take a viewport or full-page screenshot');
        const r = await inFrame(tabId, 0, 'rect', { ref: cand.local });
        if (!r || r.gone || !(r.w > 0 && r.h > 0)) throw err('NOT_VISIBLE', 'the element has no size on screen');
        rect = r;
      }
      try { await withTimeout(ensureDebugger(tabId), 8000, 'CDP_TIMEOUT'); } catch (e) {
        throw err('CDP_ATTACH_FAILED', 'could not attach to the tab for a screenshot: ' + String((e && e.message) || e));
      }
      const send = (m, p) => withTimeout(chrome.debugger.sendCommand({ tabId }, m, p || {}), 10000, 'CDP_TIMEOUT');
      const m = await send('Page.getLayoutMetrics');
      const vv = (m && (m.cssVisualViewport || m.visualViewport)) || { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 };
      const cs = (m && (m.cssContentSize || m.contentSize)) || { width: vv.clientWidth, height: vv.clientHeight };
      // 1.32 clip = a region of the page in CSS px {x, y, width, height} (page coordinates)
      const cl = msg.clip && typeof msg.clip === 'object' ? msg.clip : null;
      if (cl && !(Number(cl.width) > 0 && Number(cl.height) > 0)) throw err('BAD_ARGS', 'clip needs {x, y, width, height} in CSS px, width / height > 0');
      const mode = rect ? 'element' : cl ? 'region' : msg.fullPage ? 'full' : 'viewport';
      let clip, cropped = false;
      if (mode === 'region') clip = { x: Math.max(0, Number(cl.x) || 0), y: Math.max(0, Number(cl.y) || 0), width: Math.ceil(Math.min(Number(cl.width), 8000)), height: Math.ceil(Math.min(Number(cl.height), SHOT_MAX_H)) };
      else if (mode === 'element') clip = { x: Math.max(0, rect.x - 4), y: Math.max(0, rect.y - 4), width: Math.ceil(rect.w + 8), height: Math.ceil(Math.min(rect.h + 8, SHOT_MAX_H)) };
      else if (mode === 'full') { cropped = cs.height > SHOT_MAX_H; clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.ceil(Math.min(cs.height, SHOT_MAX_H)) }; }
      else clip = { x: vv.pageX || 0, y: vv.pageY || 0, width: vv.clientWidth, height: vv.clientHeight };
      let fmt = msg.format === 'png' ? 'png' : 'jpeg';
      let q = Math.min(Math.max(Number(msg.quality) || 70, 20), 95);
      let scale = Math.min(1, Math.min(Math.max(Number(msg.maxWidth) || 1280, 200), 2560) / Math.max(1, clip.width));
      let data = null, front = null;
      for (let i = 0; i < 6; i++) {
        let r;
        try {
          const cp = { format: fmt, ...(fmt === 'jpeg' ? { quality: q } : {}), clip: { ...clip, scale }, captureBeyondViewport: mode !== 'viewport' };
          const cap = () => send('Page.captureScreenshot', cp);
          let tNow = null;
          if (!front) tNow = await withTimeout(chrome.tabs.get(tabId), 1500, 'TIMEOUT').catch(() => null);
          // a hidden tab: a short first try (Chrome often still paints it), then the brief front
          const first = () => (tNow && tNow.active === false ? withTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', cp), 3000, 'CDP_TIMEOUT') : cap());
          try { r = await first(); } catch (e0) {
            // 1.32 a background tab produced no frame — bring it to the front of its own window for the shot, then back
            const t0 = await withTimeout(chrome.tabs.get(tabId), 1500, 'TIMEOUT').catch(() => null);
            if (!(e0 && e0.code === 'CDP_TIMEOUT' && t0 && t0.active === false && !front)) throw e0;
            front = await briefFront(tabId, cap);
            r = front.value;
          }
        } catch (e) {
          if (e && e.code === 'CDP_TIMEOUT') {
            const t = await withTimeout(chrome.tabs.get(tabId), 1500, 'TIMEOUT').catch(() => null);
            const bg = t && (t.active === false || t.discarded || t.frozen);
            const x = err('CDP_TIMEOUT', 'the screenshot got no frame from the tab in 10 s' + (bg ? ' — the tab is in the background: call foxpaw_activate_tab first, then retry' : ' — the page is busy; retry'));
            x.detail = { tabId, background: !!bg, next: bg ? 'foxpaw_activate_tab then retry' : 'retry' };
            throw x;
          }
          throw e;
        }
        data = r && r.data;
        if (!data) throw err('SCREENSHOT_FAILED', 'Chrome returned no image');
        if (data.length <= SHOT_MAX_B64) break;
        // too big for one frame: PNG → JPEG, then lower quality and size
        if (fmt === 'png') fmt = 'jpeg'; else { q = Math.max(30, q - 15); scale *= 0.75; }
        data = null;
      }
      if (!data) throw err('SCREENSHOT_TOO_LARGE', 'the image stays above the size limit — use a viewport or element screenshot, or a smaller maxWidth');
      const out = { image: data, mime: fmt === 'png' ? 'image/png' : 'image/jpeg', mode, width: Math.round(clip.width * scale), height: Math.round(clip.height * scale),
        bytes: Math.round(data.length * 0.75), scale: Math.round(scale * 1000) / 1000 };
      if (fmt === 'jpeg') out.quality = q;
      if (front) out.foreground = { ms: front.ms, restored: front.restored };
      if (cropped) { out.cropped = true; out.pageHeight = Math.round(cs.height); out.note = `page is ${Math.round(cs.height)} px tall; the first ${SHOT_MAX_H} px are shown`; }
      return out;
    }, audit: (d) => `screenshot tab=${tabId} ${d.mode} ${d.width}x${d.height} ${d.bytes} B` });
  },

  async click(msg, ctx) {
    const { tabId, epoch } = msg;
    const spec = specOf(msg);
    let cand = null, wait = AUTO_WAIT_MS, tClassify = Date.now(), start = null, advanced = null;
    return execCore(ctx, {
      cls: 'write', scope: 'control',
      classify: async (tab) => {
        tClassify = Date.now();
        if (epoch !== undefined && epoch !== null && epoch !== (epochs.get(tabId) || 0)) throw err('STALE_DOCUMENT', 'page navigated since snapshot — take a new snapshot');
        wait = await autoWaitMs(await cfg(), msg.timeout);
        start = await pageMark(tabId);
        try { cand = await locate(tabId, spec, { timeout: wait, nth: msg.nth, start }); } catch (e) {
          if (e.code !== 'PAGE_ADVANCED') throw e;
          advanced = e.pageAdvanced; return null; // nothing to click and nothing to approve
        }
        return clickMeta(tab, cand.info, classifyElement(cand.info));
      },
      run: async () => {
        if (advanced) return pageAdvancedResult(tabId, advanced);
        bumpFocus(tabId);
        const seq0 = navSeq(tabId);
        const t0 = Date.now();
        const timing = { locate: t0 - tClassify };
        let r;
        try { r = await realClick(tabId, cand, { timeout: wait, timing, trusted: msg.trusted === false ? false : undefined, start }); } catch (e) {
          if (e.code === 'PAGE_ADVANCED') return pageAdvancedResult(tabId, e.pageAdvanced, cand);
          throw e;
        }
        const tNav = Date.now();
        // did the click submit a form / follow a link (not prevented)? then wait for
        // that navigation; otherwise only a short window for script-driven ones
        let expect = false;
        if (!msg.noWaitAfter && navSeq(tabId) === seq0) { try { const h = await inFrame(tabId, cand.frameId, 'navHint', {}); expect = !!(h && h.expect); } catch { expect = true; } }
        let nav = msg.noWaitAfter ? null : await settleNavigation(tabId, seq0, expect ? NAV_START_LINK_MS : NAV_START_MS, LOAD_TIMEOUT_MS);
        await adoptionsSettled(tabId, 1000);
        const out = { ok: true, clicked: (r.name || cand.name || cand.tag || '').slice(0, 80), ref: cand.ref, via: r.via, category: classifyElement(cand.info), timing };
        if (r.retargeted) out.retargeted = r.retargeted;
        // effect check: a click that changed nothing (no navigation, new tab, DOM change,
        // request, submit, state or focus change) is reported as noEffect — never a silent ok
        if (!msg.noWaitAfter && !nav && !openedSince(tabId, t0).length) {
          const eff = await clickEffect(tabId, cand, NO_EFFECT_MS);
          if (eff && eff.armed) {
            out.effect = eff.sig;
            if (!eff.sig.length && eff.radioOn) out.already = 'checked';
            else if (!eff.sig.length || (eff.sig.length === 1 && eff.sig[0] === 'focus' && eff.submitBtn)) {
              const how = eff.summary ? 'details' : eff.toggle ? 'toggle' : eff.submitBtn && !eff.submits && !eff.invalid ? 'submit' : '';
              if (how) {
                const seq1 = navSeq(tabId);
                const fb = await inFrame(tabId, cand.frameId, 'fallback', { ref: cand.local, how }).catch((e) => ({ ok: false, error: String(e.message || e) }));
                out.fallback = (fb && fb.how) || how;
                if (fb && fb.invalid) out.invalid = fb.invalid;
                if (fb && fb.ok) {
                  // a submit the page did not preventDefault means a real navigation is coming
                  let eff2 = await clickEffect(tabId, cand, NO_EFFECT_MS);
                  const realSubmit = how === 'submit' && (!eff2 || !eff2.armed || eff2.submits > eff2.prevented);
                  nav = await settleNavigation(tabId, seq1, realSubmit ? NAV_START_LINK_MS : NAV_START_MS, LOAD_TIMEOUT_MS);
                  out.effect = nav ? ['navigation'] : (eff2 && eff2.sig) || [];
                  if (!nav && !out.effect.length && how !== 'toggle' && how !== 'details') out.noEffect = true;
                } else {
                  out.noEffect = true;
                  out.fallbackError = (fb && (fb.error || (fb.invalid ? 'form is invalid' : ''))) || 'fallback failed';
                }
              } else out.noEffect = true;
              if (out.noEffect) out.hint = 'the click changed nothing on the page (no navigation, DOM change, request or submit) — check the target, or try another way (keyboard Enter, a different element)';
            }
          }
          inFrame(tabId, cand.frameId, 'effect', { done: true }).catch(() => {});
        } else if (nav) out.effect = ['navigation'];
        else if (openedSince(tabId, t0).length) out.effect = ['opened'];
        timing.nav = Date.now() - tNav;
        if (nav) { out.navigated = nav.url; out.load = nav.load; out.epoch = epochs.get(tabId) || 0; }
        const opened = openedSince(tabId, t0);
        if (opened.length) out.opened = opened;
        // 1.29 「点售价框不聚焦，键盘输入打进标题框」: a click on a text box must leave the cursor IN it — check, put it
        // there if the page did not, and remember it so raw CDP typing can refuse to land anywhere else
        const typeBox = cand.info && cand.info.field && cand.tag !== 'SELECT' && !/^(checkbox|radio|file|button|submit|reset|image)$/.test(cand.type || '');
        if (typeBox && !out.navigated) {
          let f = await inFrame(tabId, cand.frameId, 'focusCheck', { ref: cand.local }).catch(() => null);
          if (f && !f.ok) { await inFrame(tabId, cand.frameId, 'focusSelect', { ref: cand.local }).catch(() => null); f = await inFrame(tabId, cand.frameId, 'focusCheck', { ref: cand.local }).catch(() => null); if (f && f.ok) out.focusFixed = true; }
          bumpFocus(tabId);
          if (f && f.ok) { out.focused = true; lastClickField.set(tabId, { local: cand.local, frameId: cand.frameId || 0, name: cand.name || '', at: Date.now() }); }
          else { out.focused = false; out.focusLost = (f && f.focused) || 'another element'; out.hint = `the box did not take the cursor (focus is on ${out.focusLost}) — do not type with raw CDP now; use foxpaw_fill on this box`; lastClickField.set(tabId, { local: cand.local, frameId: cand.frameId || 0, name: cand.name || '', at: Date.now() }); }
        } else lastClickField.delete(tabId);
        // 1.29 a native <select> opens Chrome's own popup, which no page script or CDP mouse event can pick from
        if (cand.tag === 'SELECT') { out.hint = 'this is a native <select>: choose with foxpaw_fill {ref, value: "<option text or value>"} — clicking only opens the browser\'s own list'; delete out.noEffect; }
        return out;
      },
      audit: (o, cat) => `click tab=${tabId} ${o.ref || ''} cat=${cat} via=${o.via || '-'} -> ${o.clicked || ''}${o.navigated ? ' => ' + o.navigated : ''}${o.fallback ? ' fallback=' + o.fallback : ''}${o.noEffect ? ' NO-EFFECT' : ''}${o.pageAdvanced ? ' page-advanced' : ''}`,
    });
  },

  /* fill. Accepts the MCP contract {fields:[{ref|selector|label|role,name|text, value, kind?}]}
     and the legacy {mapping} (array from the CLI; object {refOrSelector: value} from ≤2.8 relays).
     Default dryRun: false for `fields` / object mappings (MCP), true for the legacy array (CLI). */
  async fill(msg, ctx) {
    const { tabId } = msg;
    let items, dryRun;
    if (Array.isArray(msg.fields)) { items = msg.fields; dryRun = msg.dryRun === true; }
    else if (msg.mapping && typeof msg.mapping === 'object' && !Array.isArray(msg.mapping)) {
      items = Object.entries(msg.mapping).map(([k, v]) => (/^(f\d+)?e\d+$|^s\d+_\d+$/.test(k) ? { ref: k, value: v } : { auto: k, value: v }));
      dryRun = msg.dryRun === true;
    } else if (Array.isArray(msg.mapping)) { items = msg.mapping; dryRun = msg.dryRun !== false; }
    else items = [];
    if (!items.length) throw err('BAD_FIELDS', 'fields: give [{ref|selector|label|role,name, value}]');
    const resolved = [];
    return execCore(ctx, {
      cls: 'write', scope: 'control',
      classify: async (tab) => {
        const wait = await autoWaitMs(await cfg(), msg.timeout);
        const t0 = Date.now();
        const missing = [];
        for (const m of items) {
          const left = Math.max(0, wait - (Date.now() - t0));
          let cand = null, e1 = null;
          const cssish = m.auto && (/^[#.[]|[[\]=:>~+*]/.test(m.auto) || /^[a-z][a-z0-9-]*$/i.test(m.auto));
          const tries = m.auto ? (cssish ? [{ selector: m.auto }, { label: m.auto }] : [{ label: m.auto }, { selector: m.auto }]) : [specOf(m)];
          for (const sp of tries) {
            try { cand = await locate(tabId, sp, { timeout: m.auto && sp.selector ? Math.min(left, 300) : left, enabled: false, allowHidden: (c) => c.tag === 'SELECT' || /^(checkbox|radio)$/.test(c.type || '') }); break; } catch (e) { e1 = e; if (e.code === 'AMBIGUOUS' && !m.auto) throw e; }
          }
          if (!cand) { missing.push(`${m.auto || specText(specOf(m))}${e1 && e1.code === 'AMBIGUOUS' ? '（不唯一）' : ''}`); continue; }
          resolved.push({ m, cand });
        }
        const sec = resolved.filter((x) => x.cand.info && x.cand.info.secret);
        let askOtp = false, askStock = false;
        if (sec.length) {
          // credentials by source: the owner's own saved passwords and payment cards stay USER_STEP;
          // a value generated in this task / assigned by the owner to this task / for a marked test site,
          // and codes on a task the owner allowed, are filled — each only with the relay's grant.
          const v = credVerdict(ctx, tab, sec);
          if (v === 'secret') return { category: 'secret' };
          askOtp = v === 'otp';
          askStock = v === 'stock';
        }
        if (missing.length) throw err('FIELD_NOT_FOUND', 'some fields not found: ' + missing.join(', '));
        if (askOtp && !dryRun) return { category: 'otp', title: `填写验证码（${sec.length} 个字段）` };
        if (askStock && !dryRun) return { category: 'stock', title: `填写商品卡密（${sec.length} 个字段）`, detail: '商品库存的卡号 / 卡密（不是支付卡）', host: hostOfUrl((tab && tab.url) || '') };
        if (dryRun) return null;
        const label = (x) => x.m.label || x.m.name || x.cand.name || x.m.ref || x.m.selector || x.m.auto || x.cand.ref;
        const hasFile = resolved.some((x) => (x.m.kind || '') === 'file' || x.cand.type === 'file');
        return { category: hasFile ? 'upload' : 'write', title: `填写 ${resolved.length} 个字段`,
          detail: resolved.map((x) => `${label(x)}：${x.cand.type === 'file' ? '（本机文件）' : CRED_OK.has(x.m) ? '•••' : String(x.m.value).slice(0, 40)}`).join('；') };
      },
      run: async () => {
        bumpFocus(tabId);
        const fields = [];
        for (const { m, cand } of resolved) {
          let r;
          try { r = await fillOne(tabId, cand, m, dryRun); } catch (e) { r = { ok: false, error: (e.code ? e.code + ': ' : '') + String(e.message || e) + (e.detail ? ' ' + JSON.stringify(e.detail) : '') }; }
          const f = { ok: !!r.ok, actual: r.actual, kind: r.kind, ref: cand.ref, field: m.label || m.name || m.selector || m.ref || m.auto || cand.name };
          if (r.verified) f.verified = r.verified;           // 'model' (framework value read back) | 'dom'
          if (r.model !== undefined) f.model = r.model;
          if (r.via) f.via = r.via;
          if (r.editor) f.editor = r.editor;           // 1.29.1 monaco / codemirror5 / codemirror6 / ace
          if (r.code) f.code = r.code;                 // FILL_MISMATCH: cut / rewritten by the page
          if (r.expectedLen !== undefined) f.expectedLen = r.expectedLen;
          if (r.actualLen !== undefined) f.actualLen = r.actualLen;
          if (r.note) f.note = r.note;
          if (r.error) f.error = r.error;
          if (r.options) f.options = r.options;
          if (dryRun) { f.dryRun = true; f.wouldFill = m.value; }
          fields.push(f);
        }
        const ok = fields.every((f) => f.ok);
        const credUsed = resolved.filter((x) => CRED_OK.has(x.m) && !dryRun).map((x) => ({ field: String(x.m.label || x.m.name || x.cand.name || '字段').slice(0, 40), source: CRED_OK.get(x.m), grant: x.m.credGrant || undefined }));
        if (credUsed.length) { // audit at the relay: field + source only, never the value
          credTyped.set(tabId, Date.now());
          try { const t = await getTab(tabId); wsSend({ type: 'cred.used', agentId: ctx.agentId, task: ctx.task || '', origin: originOf((t && t.url) || ''), fields: credUsed }); } catch { /* offline */ }
        }
        // legacy `report` (CLI) mirrors `fields`
        return { ok, fields, dryRun: dryRun || undefined, report: fields.map((f) => ({ field: f.field, ok: f.ok, ...(dryRun ? { dryRun: true, wouldFill: f.wouldFill } : { filled: f.actual }), ...(f.error ? { error: f.error } : {}) })) };
      },
      audit: (o) => `fill tab=${tabId} dryRun=${dryRun} ok=${o.ok} fields=${items.length}`,
    });
  },

  /* 1.26 foxpaw_login: sign in on this tab with a login the owner saved for its site (main domain,
     sub-domains included). The agent names the site (or nothing = the tab's site) and never sees the
     password: the extension types it here, reads back •••, and may press the sign-in button. Trusted
     agent (全部网站 / this site / 「这次都放行」) = no card; otherwise one card 「允许 X 用你的 Y 登录」.
     Never on a payment page or into a payment-class box. A username-first page (no password box yet)
     gets the account only: call again on the password page. */
  async login(msg, ctx) {
    const { tabId } = msg;
    const submit = msg.submit !== false;
    let item = null, lf = null, host = '';
    return execCore(ctx, {
      cls: 'write', scope: 'control',
      classify: async (tab) => {
        const url = (tab && tab.url) || '';
        if (!/^https?:/.test(url)) throw err('NOT_A_SITE', 'this tab is not a web page — navigate to the site\'s sign-in page first');
        host = hostOfUrl(url);
        if (ctx.local || !ctx.agentId) throw err('NO_AGENT', 'foxpaw_login is for agents');
        const want = msg.site ? siteMain(msg.site) : '';
        if (msg.site && !want) throw err('BAD_SITE', `not a site: ${String(msg.site).slice(0, 80)}`);
        const all = await vaultItems();
        if (want && !hostInSites(host, [want])) {
          throw err('LOGIN_SITE_MISMATCH', `the tab is on ${host}, not ${want} — a saved login is only typed on its own site (sub-domains included); navigate there first`);
        }
        let cands = all.filter((x) => hostInSites(host, [x.site]) && (!want || x.site === want || hostInSites(x.site, [want])));
        if (msg.user != null && msg.user !== '') cands = cands.filter((x) => (x.user || '') === String(msg.user));
        if (!cands.length) throw err('NO_SAVED_LOGIN', `no saved login for ${want || siteMain(host) || host}${msg.user ? ' (account ' + msg.user + ')' : ''} — the owner adds one in the FoxPaw side panel (我 → 登录凭证); or ask with foxpaw_need_human`);
        if (cands.length > 1) { const e = err('AMBIGUOUS_LOGIN', `${cands.length} saved logins fit ${host} — pass user (one of: ${cands.map((x) => x.user || '""').join(', ')})`); e.detail = { users: cands.map((x) => x.user || '') }; throw e; }
        item = cands[0];
        if (isPayPage(tab.title, url)) return { category: 'secret', title: '付款页不能用已存登录' };
        lf = await loginFieldsOf(tabId, msg);
        if (!lf.pw && lf.card) return { category: 'secret', title: '这是付款类密码框（支付 / 交易密码），已存登录不能填' };
        if (!lf.pw && !lf.user) throw err('NO_LOGIN_FORM', `no sign-in form on this page (no password or account box) — open ${item.site}'s sign-in page first`);
        const who = ctx.agentLabel || 'Agent';
        return { category: 'login', host,
          title: `用已存登录 ${item.site}${item.user ? '（账号 ' + maskUser(item.user) + '）' : ''}`,
          detail: `允许 ${who} 用你的 ${item.site} 登录（账号 ${item.user || '—'}）？密码由 FoxPaw 在本机填入，${who} 看不到。` };
      },
      run: async () => {
        bumpFocus(tabId);
        credTyped.set(tabId, Date.now());
        const out = { ok: true, site: item.site, user: item.user || '', step: lf.pw ? 'password' : 'username', filled: [] };
        if (lf.user && item.user) {
          let r;
          try { r = await fillOne(tabId, lf.user, { value: item.user }, false); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
          out.filled.push({ field: 'account', ok: !!r.ok, ...(r.error ? { error: r.error } : {}) });
        }
        if (lf.pw) {
          const pass = await vaultReveal(item.id);
          const m = { value: pass };
          CRED_OK.set(m, 'vault');
          let r;
          try { r = await fillOne(tabId, lf.pw, m, false); } catch (e) { r = { ok: false, error: e.code === 'USER_STEP' ? 'USER_STEP' : 'fill failed' }; }
          out.filled.push({ field: 'password', ok: !!r.ok, actual: r.ok ? '•••' : '', ...(r.error ? { error: String(r.error).replace(pass, '•••') } : {}) });
        }
        out.ok = out.filled.length > 0 && out.filled.every((f) => f.ok);
        if (out.ok && submit) {
          credTyped.set(tabId, Date.now());
          const seq0 = navSeq(tabId);
          try {
            if (lf.btn) { await realClick(tabId, lf.btn, { timeout: 3000 }); out.submitted = 'click'; }
            else { const s = await inFrame(tabId, (lf.pw || lf.user).frameId, 'loginSubmit', { ref: (lf.pw || lf.user).local }); out.submitted = (s && s.via) || 'enter'; }
          } catch (e) { out.submitted = false; out.submitError = String((e && e.code) || e.message || e).slice(0, 80); }
          const nav = await settleNavigation(tabId, seq0, 800, Math.min(Number(msg.timeout) || LOAD_TIMEOUT_MS, 30000)).catch(() => null);
          if (nav) { out.navigated = nav.url; out.load = nav.load; out.epoch = epochs.get(tabId) || 0; }
        }
        if (!lf.pw) out.next = 'the site asks for the password on the next page — call foxpaw_login again there';
        const vb = ctx.vaultBasis || { basis: 'card' };
        try { wsSend({ type: 'vault.used', agentId: ctx.agentId, task: ctx.task || '', host, site: item.site, user: item.user || '', basis: vb.basis, ...(vb.id && vb.id !== 'trust' ? { id: vb.id } : {}) }); } catch { /* offline */ }
        vaultTouch(item.id).catch(() => {});
        return out;
      },
      audit: (o) => `login tab=${tabId} site=${item && item.site} account=${item && maskUser(item.user)} step=${o.step} ok=${o.ok}${o.submitted ? ' submitted=' + o.submitted : ''} (${(ctx.vaultBasis || {}).basis || '-'})`,
    });
  },

  /* 1.26 foxpaw_login_save: an agent that just created an account stores what it chose (site + account
     + password) in the owner's vault on this browser. Reply = •••, never the value. Inside trust for that
     site no card; replacing a login the OWNER saved always asks. */
  async vaultSave(msg, ctx) {
    const c0 = msg.cred && typeof msg.cred === 'object' ? msg.cred : {};
    const site = siteMain(c0.site || msg.site);
    const user = String(c0.user == null ? '' : c0.user).trim().slice(0, 200);
    const password = c0.password == null ? '' : String(c0.password);
    if (!site) throw err('BAD_SITE', 'site: give the site\'s address or domain (e.g. tavily.com)');
    if (!password) throw err('BAD_ARGS', 'password is required');
    let prev = null;
    return execCore(ctx, {
      cls: 'write', scope: 'none',
      classify: async () => {
        if (ctx.local || !ctx.agentId) throw err('NO_AGENT', 'foxpaw_login_save is for agents');
        prev = (await vaultItems()).find((x) => x.site === site && (x.user || '') === user) || null;
        const who = ctx.agentLabel || 'Agent';
        return { category: 'vault', host: site, forceCard: !!(prev && (prev.source || 'owner') === 'owner'),
          title: `保存登录凭证 ${site}${user ? '（账号 ' + maskUser(user) + '）' : ''}`,
          detail: `${who} 想把 ${site} 的账号 ${user || '—'} 存进 FoxPaw（密码只加密存在这台浏览器）${prev ? '，会替换你已存的同一账号的密码' : ''}` };
      },
      run: async () => {
        const r = await vaultPut({ site, user, password, note: c0.note }, { source: 'agent', label: ctx.agentLabel || 'Agent' });
        const vb = ctx.vaultBasis || { basis: 'card' };
        try { wsSend({ type: 'vault.saved', agentId: ctx.agentId, task: ctx.task || '', site, user, by: 'agent', replaced: r.replaced, basis: vb.basis }); } catch { /* offline */ }
        return { ok: true, saved: { site, user, password: '•••' }, replaced: r.replaced };
      },
      audit: () => `login saved by agent: ${site} (${maskUser(user)}) (${(ctx.vaultBasis || {}).basis || '-'})`,
    });
  },

  async navigate(msg, ctx) {
    const { tabId, url } = msg;
    return execCore(ctx, { cls: 'write', scope: 'control', targetUrl: url, run: async (tab, target) => {
      const seq0 = navSeq(tabId);
      await chrome.tabs.update(tabId, { url: target });
      bumpEpoch(tabId);
      const out = { navigated: target };
      if (msg.waitUntil !== 'none') {
        const nav = await settleNavigation(tabId, seq0, 3000, Math.min(Number(msg.timeout) || LOAD_TIMEOUT_MS, 60000));
        if (nav) { out.load = nav.load; out.url = nav.url; if (nav.error) out.error = nav.error; }
        // 1.30 (tester 11-04 #7): a load timeout often means one slow request, not an unreadable page — say what is there.
        // 1.32 (field test 11-05): the same for load:'error' (net::ERR_ABORTED on a page that did render)
        if (nav && (nav.load === 'timeout' || nav.load === 'error')) Object.assign(out, await navPageState(tabId, nav.load));
        if (msg.challenge !== 'off' && (!nav || nav.load !== 'error' || out.readable)) {
          const ch = await passChallenge(tabId, ctx, msg);
          if (ch) {
            out.challenge = ch;
            const s2 = await navPageState(tabId, 'challenge');
            out.url = (s2.page && s2.page.url) || out.url;
            Object.assign(out, { state: s2.state, readable: s2.readable, page: s2.page });
          }
        }
        out.epoch = epochs.get(tabId) || 0;
      }
      return out;
    }, audit: (o) => `navigate tab=${tabId} -> ${o.navigated}${o.load ? ' (' + o.load + ')' : ''}` });
  },

  /* wait_for: text appears / disappears, selector state, URL (substring,
     glob with *, or /regex/). Read class; polls locally (no relay trips). */
  async waitFor(msg, ctx) {
    const { tabId } = msg;
    return execCore(ctx, { cls: 'read', scope: 'control', run: async () => {
      const timeout = Math.min(Number(msg.timeout) || AUTO_WAIT_MS, 60000);
      const t0 = Date.now();
      const state = msg.state || (msg.selector ? 'visible' : undefined);
      const urlOk = (u) => {
        if (msg.url === undefined || msg.url === null || msg.url === '') return true;
        const w = String(msg.url);
        if (/^\/.+\/[a-z]*$/.test(w)) { const i = w.lastIndexOf('/'); try { return new RegExp(w.slice(1, i), w.slice(i + 1)).test(u); } catch { return false; } }
        if (w.includes('*')) return new RegExp('^' + w.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(u);
        return u.includes(w);
      };
      const want = { text: msg.text, gone: msg.textGone };
      if (want.text === undefined && want.gone === undefined && !msg.selector && !msg.url) throw err('BAD_WAIT', 'give text, textGone, selector or url');
      for (let i = 0; ; i++) {
        const tab = await getTab(tabId);
        let ok = urlOk(tab.url || '');
        if (ok && (want.text !== undefined || want.gone !== undefined || msg.selector)) {
          const probeArg = { text: want.text !== undefined ? want.text : want.gone, selector: msg.selector };
          const rows = await inFrames(tabId, 'probe', probeArg).catch(() => []);
          const res = rows.map((r) => r.result || {});
          if (res.some((r) => r.error === 'BAD_SELECTOR')) throw err('BAD_SELECTOR', 'invalid CSS selector: ' + msg.selector);
          if (want.text !== undefined) ok = ok && res.some((r) => r.text);
          if (want.gone !== undefined) ok = ok && !res.some((r) => r.text);
          if (msg.selector) {
            const att = res.some((r) => r.attached), vis = res.some((r) => r.visible);
            ok = ok && ({ attached: att, detached: !att, visible: vis, hidden: !vis }[state] ?? vis);
          }
        }
        if (ok) return { ok: true, waitedMs: Date.now() - t0, url: tab.url };
        if (Date.now() - t0 >= timeout) throw err('WAIT_TIMEOUT', `condition not met after ${timeout} ms`);
        await sleep(i < 3 ? 50 : 120);
      }
    } });
  },

  async cdp({ tabId, method, params = {} }, ctx) {
    const m = String(method || '');
    let credIn = null;
    if (!ctx.caps.rawCdp) throw err('RAW_CDP_NOT_GRANTED', 'raw CDP (incl. Playwright connectOverCDP) is a separate grant — the owner has not enabled 原始模式 for this agent; use the FoxPaw tools (snapshot / click / fill / wait_for)');
    return execCore(ctx, {
      cls: commandClass('cdp', { method: m }), scope: 'control',
      targetUrl: m === 'Page.navigate' ? (params || {}).url : undefined,
      classify: async (tab) => { const r = await cdpClassify(tab, m, params || {}, ctx); if (r && r.credInput) credIn = r.credInput; return r; },
      run: async () => {
        // 1.28.1 raw CDP is time-bounded — Page.captureScreenshot on a background / frozen tab waits for a
        // frame Chrome never paints; the agent gets CDP_TIMEOUT with what to do, other commands go on
        try { await withTimeout(ensureDebugger(tabId), 8000, 'CDP_TIMEOUT'); } catch (e) {
          if (e && e.code === 'CDP_TIMEOUT') throw err('CDP_TIMEOUT', 'attaching the debugger to this tab did not finish in 8 s — another debugger (DevTools / another extension) may hold it; close it and retry');
          throw err('CDP_ATTACH_FAILED', String((e && e.message) || e));
        }
        let result;
        try { result = await withTimeout(chrome.debugger.sendCommand({ tabId }, m, params), RAW_CDP_MS, 'CDP_TIMEOUT'); } catch (e) {
          if (e && e.code === 'CDP_TIMEOUT') {
            const t = await withTimeout(chrome.tabs.get(tabId), 1500, 'TIMEOUT').catch(() => null);
            const bg = t && (t.active === false || t.discarded || t.frozen);
            const x = err('CDP_TIMEOUT', `${m} got no answer from the tab in ${RAW_CDP_MS / 1000} s` + (bg ? ' — the tab is in the background (Chrome does not paint / runs it throttled): call foxpaw_activate_tab first, then retry' : ' — the page is busy; retry, or use foxpaw_snapshot') + '. Other commands are not affected.');
            x.detail = { method: m, tabId, timeoutMs: RAW_CDP_MS, background: !!bg, next: bg ? 'foxpaw_activate_tab then retry' : 'retry' };
            throw x;
          }
          throw e;
        }
        if (m === 'Page.navigate') bumpEpoch(tabId);
        if (credIn) { // field name + source only, never the value (same audit as fill)
          credTyped.set(tabId, Date.now());
          try { const t = await getTab(tabId); wsSend({ type: 'cred.used', agentId: ctx.agentId, task: ctx.task || '', origin: originOf((t && t.url) || ''), fields: [{ field: credIn.field, source: 'trust' }] }); } catch { /* offline */ }
        }
        // 1.29 say WHERE the text went (focus moves between fields on many forms) — name / tag only, no value
        if (ctx.typedInto && /^Input\.(insertText|imeSetComposition|dispatchKeyEvent)$/.test(m)) return { result, typedInto: ctx.typedInto };
        return { result };
      },
      audit: (o, cat) => `cdp tab=${tabId} ${m}${cat !== 'normal' ? ' cat=' + cat : ''}`,
    });
  },

  async createTab({ url }, ctx) {
    return execCore(ctx, { cls: 'write', scope: 'none', targetUrl: url || 'about:blank', run: async (tab, target) => {
      const t = await chrome.tabs.create({ url: target, active: false });
      await groupTab(t.id);
      return { tabId: t.id, _url: target };
    }, audit: (o) => `createTab -> ${o.tabId} ${o._url}` }).then((o) => ({ tabId: o.tabId }));
  },

  async closeTab({ tabId }, ctx) {
    return execCore(ctx, { cls: 'write', scope: 'group', run: async () => {
      await chrome.tabs.remove(tabId);
      return { closed: tabId };
    }, audit: () => `closeTab ${tabId}` });
  },

  async activateTab({ tabId }, ctx) {
    return execCore(ctx, { cls: 'write', scope: 'group', run: async () => {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab && tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      return { activated: tabId };
    } });
  },

  async cdpDetach({ tabId }, ctx) {
    return execCore(ctx, { cls: 'always', scope: 'none', run: async () => { await detachDebugger(tabId); return { detached: tabId }; } });
  },

  async findTabs({ query }, ctx) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) throw err('BAD_QUERY', 'query required');
    await groupsReady();
    const all = (await chrome.tabs.query({})) || [];
    const match = all.filter((t) => ((t.title || '') + ' ' + (t.url || '')).toLowerCase().includes(q));
    const slim = (t) => ({ tabId: t.id, title: t.title || '', url: t.url || '' });
    const inside = match.filter((t) => tabAuthorized(t));
    if (inside.length) return execCore(ctx, { cls: 'read', scope: 'none', run: async () => ({ found: inside.map(slim), authorized: true }) });
    const out = match.find((t) => /^https?:/.test(t.url || ''));
    if (!out) return execCore(ctx, { cls: 'read', scope: 'none', run: async () => ({ found: [], authorized: false }) });
    try {
      return await execCore(ctx, {
        cls: 'read', scope: 'none', targetUrl: out.url,
        classify: async () => ({ category: 'tab', title: '使用一个未授权的标签',
          detail: '「' + (out.title || out.url) + '」不在狐爪组内，允许后会加入组内。' }),
        run: async () => { await groupTab(out.id); return { found: [slim(out)], authorized: true }; },
        audit: () => 'tab assigned via findTabs for ' + (ctx.agentLabel || 'Agent') + ': ' + (out.title || out.url),
      });
    } catch (e) {
      // (P2): a refusal never reveals how many outside tabs matched
      if (e.code === 'USER_REJECTED' || e.code === 'CONFIRM_TIMEOUT' || e.code === 'SITE_BLOCKED') return { found: [], authorized: false };
      throw e;
    }
  },

  // replay a foxpaw.flow/1 flow: every step is its own execCore() call
  async flowRun(msg, ctx) { return flowExec(msg, ctx); },
  // IA v1 教 Agent 录: foxpaw_recording_start / stop. One recording per browser (the relay holds
  // the lock too); the agent's own commands on the group's tabs are what gets recorded.
  async recordStart(msg, ctx) {
    return execCore(ctx, { cls: 'write', scope: 'group', run: async (tab) => {
      if (rec && (rec.active || rec.pendingSave)) throw err('REC_BUSY', rec.source === 'agent' ? `${rec.agentLabel || 'an agent'} is already recording in this browser` : 'the owner is recording in this browser right now');
      // 1.33.2: the owner is usually on the page where they talk to this agent — that tab is left out
      const own = await ownerActiveTabId();
      await recStart(String(msg.name || '').slice(0, 40), 'agent', { title: (tab && tab.title) || '', url: (tab && tab.url) || '' },
        { agentId: ctx.agentId, agentLabel: ctx.agentLabel, goal: String(msg.goal || '').slice(0, 200), task: ctx.task, tabId: tab ? tab.id : null },
        { skipTabId: own != null && tab && own !== tab.id ? own : null });
      await recPublish(); refreshAction();
      return { recording: true, startTab: tab ? tab.id : null, armedTabs: rec.scope - (rec.skip || []).length, ...((rec.skip || []).length ? { leftOut: rec.skip, note: "the owner's active tab (where they talk to you) is not recorded; operate it with a tool to include it" } : {}) };
    }, audit: () => `agent recording started: ${String(msg.goal || '').slice(0, 60)}` });
  },
  async recordStop(msg, ctx) {
    return execCore(ctx, { cls: 'write', scope: 'none', run: async () => {
      if (!rec || !rec.active || rec.source !== 'agent') throw err('NOT_RECORDING', 'no agent recording is running in this browser');
      if (rec.agentId && ctx.agentId && rec.agentId !== ctx.agentId) throw err('NOT_RECORDING', 'this recording belongs to another agent');
      if (msg.name) rec.name = String(msg.name).slice(0, 40);
      const out = await recStop();
      rec = null;
      await chrome.storage.local.remove(REC_KEY);
      await recPublish(); refreshAction();
      return out || { flow: null };
    }, audit: (o) => `agent recording stopped: ${(o && o.steps) || 0} steps` });
  },

  async ask({ question, options }, ctx) {
    return execCore(ctx, { cls: 'read', scope: 'none', run: async () => {
      // v1.17: the card says who asks and until when (ui-interaction #10)
      const res = await waitAsk({ question, options: options || null, agent: ctx.agentLabel || '', agentId: ctx.agentId || '', until: Date.now() + 300000 }, ctx);
      if (res.cancelled) throw err('CONFIRM_CANCELLED', 'the relay gave up waiting');
      if (res.timeout) throw err('ASK_TIMEOUT', 'user did not answer in time');
      return { answer: res.answer };
    } });
  },
};
async function listTabs() {
  await groupsReady();
  const all = (await chrome.tabs.query({})) || [];
  const slim = (t) => ({ id: t.id, title: (t.title || '').slice(0, 80), url: t.url || '', active: !!t.active, assigned: true, ...(adopted.has(t.id) ? { popup: true } : {}) });
  // v1.9.1: agents only ever see authorized tabs. `all` is kept for wire
  // compatibility and mirrors `assigned` — tabs outside this browser's own
  // FoxPaw groups (titles/URLs) never leave the browser unless the relay
  // stamped caps.seeAllTabs for the agent (, tabs handler).
  const assigned = all.filter((t) => tabAuthorized(t)).map(slim);
  const gids = [...ownGroups];
  return { groupId: gids.length ? gids[0] : -1, groupIds: gids, assigned, all: assigned };
}

/* ---------------- relay connection controller (v1.9) ----------------
   One controller owns the socket. Every socket gets a generation id and
   every handler / timer first checks it still belongs to the current
   generation — a late onclose from a replaced socket can no longer flip a
   healthy connection back to "reconnecting" (the v1.3–v1.8 stuck-state bug).

   States (derived here and only here):
     off           disabled or not signed in            (reason: signed_out | disabled)
     connecting    socket opening / handshaking
     online        authenticated
     retrying      waiting for the next attempt          (attempt, nextRetryAt)
     needs_action  user must act; no automatic retry      (reason: badpairing | auth_rejected)
   storage.foxpawConn holds a cached snapshot for cold starts only — it is
   never trusted over the live controller. The panel subscribes over a
   long-lived port ('foxpaw-panel') and receives a push on every change. */
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 10000;
// 1.28.1: after 5 failed attempts in a row the wait grows to 1–5 minutes (no hammering a relay that is
// down); navigator.onLine=false = no attempts at all until the 'online' event (then at once)
const RETRY_SLOW_AFTER = 5;
const RETRY_SLOW_MIN_MS = 60000;
const RETRY_SLOW_CAP_MS = 300000;
// 1.28.1: liveness. Relay ≥3.7.1 sends an app-level ping every 20 s; no frame at all for STALE_MS on a
// socket that has seen pings = half-dead (TCP up, nothing flows) → close it and reconnect.
const STALE_MS = 65000;
const HANDSHAKE_TIMEOUT_MS = 15000;
const KEEPALIVE_MS = 20000;
const Conn = {
  gen: 0, ws: null, wsSince: 0,
  state: 'off', reason: 'signed_out', attempt: 0, nextRetryAt: 0, since: Date.now(),
  device: null, account: null, relayVersion: '', pairingFp: '',
  extLatest: '', relayHttp: '', // 1.22 「有新版」 — the relay's download version + where to fetch it
  retryTimer: null, hsTimer: null, keepalive: null,
  lastRx: 0, relayPings: false, startSeq: 0, sockets: new Set(), dup: null, // 1.28.1 
};
const mintWaiters = new Map();
const runCtlWaiters = new Map(); // 1.21 seq -> resolve for the panel's 继续 / 重试 / 跳过 / 终止
var runsPaused = 0;               // paused runs on this browser (relay run.list) — counted in the badge
const ticketWaiters = new Map(); // console SSO: seq -> resolve; ticket values transit memory only, never storage
const panelPorts = new Set();

function connSnapshot() {
  return {
    state: Conn.state, reason: Conn.reason, attempt: Conn.attempt, nextRetryAt: Conn.nextRetryAt,
    since: Conn.since, device: Conn.device, account: Conn.account, relayVersion: Conn.relayVersion, dup: Conn.dup,
    extLatest: Conn.extLatest, relayHttp: Conn.relayHttp,
    version: VERSION, pairingFp: Conn.pairingFp, at: Date.now(),
  };
}
function broadcast(msg) {
  for (const p of [...panelPorts]) { try { p.postMessage(msg); } catch { panelPorts.delete(p); } }
}
function setState(state, extra = {}) {
  const before = JSON.stringify({ ...connSnapshot(), at: 0 });
  if (state !== Conn.state) Conn.since = Date.now();
  Conn.state = state;
  Object.assign(Conn, { reason: '', nextRetryAt: 0 }, extra);
  const snap = connSnapshot();
  if (JSON.stringify({ ...snap, at: 0 }) === before) return;
  chrome.storage.local.set({ foxpawConn: snap }).catch(() => {});
  broadcast({ type: 'conn', snap });
  refreshAction();
}
function pairingFp(s) {
  // short non-reversible fingerprint so a cached needs_action can tell
  // whether the user has changed credentials since
  let h = 2166136261;
  for (const ch of String(s || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return s ? h.toString(16) : '';
}
// 1.31.1: a stored pairing on the old auto-generated relay hostname moves to foxpaw.aiyuancat.com — the SAME relay, the same
// token, no re-pairing. The new address is tried first; it is written to storage only after the relay says auth.ok there.
// Any failure before that falls straight back to the stored (old) address and the move is tried again an hour later.
const MIGRATE_FROM = /^foxpaw-\d{1,3}(?:-\d{1,3}){3}\.sslip\.io$/;   // 1.31.2: the old auto-generated relay hostname
const MIGRATE_TO = 'foxpaw.aiyuancat.com';
const MIGRATE_RETRY_MS = 3600e3;
const MIGRATE_KEY = 'foxpawDomainMigrate';   // { nextTry } — when to try the new address again after a failure
const DOMAIN_NOTE_KEY = 'foxpawDomainNote';  // { host, at } — the panel's one-time 「已切到新地址」 note (× removes it)
function migratedPairing(s) {
  const p = parsePairing(s);
  if (!p) return '';
  const m = /^wss:\/\/([^/?#]+)(\/[^#]*)?$/i.exec(p.url);
  if (!m || !MIGRATE_FROM.test(m[1].toLowerCase())) return '';
  return 'wss://' + MIGRATE_TO + (m[2] || '') + '#' + p.token;
}
async function migrateDue() {
  if (Date.now() < (Conn.migrateSkipUntil || 0)) return false;
  const st = await chrome.storage.local.get(MIGRATE_KEY).catch(() => ({}));
  const nt = Number((st[MIGRATE_KEY] || {}).nextTry) || 0;
  if (Date.now() < nt) { Conn.migrateSkipUntil = nt; return false; }
  return true;
}
function migrateFailed(why) {
  const nextTry = Date.now() + MIGRATE_RETRY_MS;
  Conn.migrateSkipUntil = nextTry;
  chrome.storage.local.set({ [MIGRATE_KEY]: { nextTry } }).catch(() => {});
  audit(`new address ${MIGRATE_TO} did not connect (${why}) — back on the old address, will try again in an hour`).catch(() => {});
}
async function migrateCommit(from, to) {
  // only if the stored pairing is still the one we started from (the user may have re-paired meanwhile)
  let ok = false;
  cfgChain = cfgChain.catch(() => {}).then(async () => {
    const c = await cfg();
    if (c.pairing !== from) return;
    Conn.migratedTo = to;   // the storage listener must not reconnect for this write: this socket already IS the new address
    await chrome.storage.local.set({ foxpawCfg: { ...c, pairing: to } });
    ok = true;
  });
  await cfgChain.catch(() => {});
  if (!ok) return false;
  Conn.pairingFp = pairingFp(to);
  await chrome.storage.local.set({ [DOMAIN_NOTE_KEY]: { host: MIGRATE_TO, at: Date.now() } }).catch(() => {});
  await chrome.storage.local.remove(MIGRATE_KEY).catch(() => {});
  await audit(`moved to the new address ${MIGRATE_TO} (same relay, same pairing)`).catch(() => {});
  return true;
}
function parsePairing(s) {
  const m = /^(.+)#([0-9a-fA-F]{32,})$/.exec(String(s || '').trim());
  if (!m) return null;
  return { url: m[1], token: m[2] };
}
async function hmacHex(token, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function wsOpen() { return !!(Conn.ws && Conn.ws.readyState === WebSocket.OPEN && Conn.state === 'online'); }
function wsSend(obj) {
  if (!Conn.ws || Conn.ws.readyState !== WebSocket.OPEN) return false;
  try { Conn.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}

// 1.27: a panel-row change waits for the relay's panel.ack (3.6.1+); offline = OFFLINE at once.
// 1.28.1: no ack in 5 s is judged by the relay's /health version, not assumed: an older relay (<3.6.1)
// = RELAY_OLD (use the console); a relay new enough = the link is stuck (STUCK) → reconnect now.
const panelAcks = new Map(); // ref -> resolve
let panelRef = 0;
function verLt(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0), pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
}
function ackTimeoutVerdict() {
  const v = Conn.relayVersion;
  if (v && /^\d+(\.\d+)*$/.test(v) && verLt(v, '3.6.1')) return 'RELAY_OLD';
  return 'STUCK';
}
function panelAsk(obj, ms = 5000) {
  if (!wsOpen()) return Promise.resolve({ ok: false, error: 'OFFLINE' });
  const ref = `p${Date.now().toString(36)}${++panelRef}`;
  const gen = Conn.gen;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      panelAcks.delete(ref);
      const v = ackTimeoutVerdict();
      if (v === 'STUCK' && gen === Conn.gen) { audit('relay did not acknowledge in 5 s — reconnecting'); Conn.attempt = 0; connFail(gen, 'ack_timeout'); }
      resolve({ ok: false, error: v });
    }, ms);
    panelAcks.set(ref, (m) => { clearTimeout(t); panelAcks.delete(ref); resolve(m); });
    if (!wsSend({ ...obj, ref })) { clearTimeout(t); panelAcks.delete(ref); resolve({ ok: false, error: 'OFFLINE' }); }
  });
}
// 1.27: each agent's own permission as the relay last pushed it (roster access / accessNow, relay 3.6.1+).
// execCore judges with it — a console / panel change applies to the very next step, even inside a running
// flow whose envelope was stamped earlier. No entry (older relay) = the command's own agentCap.
const agentLive = new Map(); // agentId -> {access, accessNow}
function agentLiveSet(id, v) { if (id && v && ACCESS.includes(v.accessNow)) agentLive.set(id, { access: v.access, accessNow: v.accessNow }); }
function agentLiveFromRoster(roster) {
  if (!Array.isArray(roster)) return;
  agentLive.clear();
  for (const a of roster) if (a && a.id && ACCESS.includes(a.accessNow)) agentLiveSet(String(a.id), a);
}
// the authorized tab whose site 「信任当前网站」 means: the given tab, else the active tab, else the most recently
// used tab of this browser's FoxPaw group — only http(s), only a tab that is actually authorized; main domain
async function authorizedSite(tabId) {
  await groupsReady();
  const ok = (t) => t && tabAuthorized(t) && /^https?:/.test(t.url || '');
  let tab = null;
  if (tabId != null) { try { tab = await chrome.tabs.get(Number(tabId)); } catch { tab = null; } }
  if (!ok(tab)) {
    const all = await chrome.tabs.query({}).catch(() => []);
    const mine = all.filter(ok);
    tab = mine.find((t) => t.active) || mine.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
  }
  return ok(tab) ? siteMain(tab.url) : '';
}

/* Close the current socket (if any) and retire its generation. */
function teardown() {
  Conn.gen += 1;
  clearTimeout(Conn.retryTimer); Conn.retryTimer = null;
  clearTimeout(Conn.hsTimer); Conn.hsTimer = null;
  clearInterval(Conn.keepalive); Conn.keepalive = null;
  try { chrome.alarms.clear('foxpaw-reconnect'); } catch { /* noop */ }
  const old = Conn.ws;
  Conn.ws = null;
  if (old) { try { old.close(); } catch { /* noop */ } }
  // 1.28.1: exactly one socket — any other this worker ever opened is closed too (an orphan would keep
  // the relay's device slot and swallow its commands)
  for (const x of [...Conn.sockets]) { Conn.sockets.delete(x); if (x !== old) { try { x.close(); } catch { /* noop */ } } }
  Conn.lastRx = 0; Conn.relayPings = false;
  rosterNeeds = 0;
  agentLive.clear();
  for (const f of [...panelAcks.values()]) f({ ok: false, error: 'OFFLINE' });
  setUi({ presence: [], roster: null });
  // a command whose socket died can never report back — void it
  // (its cards close; an approval arriving later executes nothing)
  cancelAllCtx('disconnected');
}

async function connStart(force = false) {
  const my = ++Conn.startSeq; // 1.28.1 of overlapping calls only the last one opens a socket
  const c = await cfg();
  if (my !== Conn.startSeq) return;
  const fp = pairingFp(c.pairing);
  if (!c.pairing || !c.enabled) {
    teardown();
    setState('off', { reason: c.pairing ? 'disabled' : 'signed_out', attempt: 0, pairingFp: fp });
    return;
  }
  const p = parsePairing(c.pairing);
  if (!p) {
    // a stored string that is not a pairing can never succeed: stop, ask the user
    teardown();
    setState('needs_action', { reason: 'badpairing', attempt: 0, pairingFp: fp });
    return;
  }
  if (!force) {
    if (Conn.state === 'needs_action' && Conn.pairingFp === fp) return;
    if (Conn.ws && Conn.ws.readyState === WebSocket.OPEN) return;
    if (Conn.ws && Conn.ws.readyState === WebSocket.CONNECTING && Date.now() - Conn.wsSince < HANDSHAKE_TIMEOUT_MS) return;
  }
  if (netOffline()) { teardown(); waitForNetwork(fp); return; } // 1.28.1 no attempt while the OS says offline
  // 1.31.1 an pairing on the old auto-generated hostname tries the new address first (committed only on auth.ok)
  const trial = migratedPairing(c.pairing) && (await migrateDue()) ? migratedPairing(c.pairing) : '';
  if (my !== Conn.startSeq) return;
  const url = trial ? parsePairing(trial).url : p.url;
  teardown();
  Conn.trial = trial ? { from: c.pairing, to: trial } : null;
  const gen = Conn.gen;
  const attempt = Conn.attempt + 1;
  setState('connecting', { attempt, pairingFp: fp, dup: null });
  let sock;
  try { sock = new WebSocket(url); } catch (e) { connFail(gen, 'open_failed'); return; }
  Conn.ws = sock;
  Conn.sockets.add(sock);
  Conn.wsSince = Date.now();
  Conn.hsTimer = setTimeout(() => { if (gen === Conn.gen && Conn.state === 'connecting') connFail(gen, 'handshake_timeout'); }, HANDSHAKE_TIMEOUT_MS);
  sock.onmessage = async (ev) => {
    // 1.28.1: a frame on a socket of an older generation = an orphan the relay still talks to — close it
    // now (before: silently dropped, so the relay's commands and panel.acks vanished while it showed online)
    if (gen !== Conn.gen) { Conn.sockets.delete(sock); try { sock.close(); } catch { /* noop */ } return; }
    Conn.lastRx = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'ping' && msg.kind === undefined) { Conn.relayPings = true; wsSend({ type: 'pong', t: msg.t }); return; }
    // a frame carrying `kind` is an agent COMMAND and nothing else.
    // Its `type` (if any) is ignored, so an agent can never smuggle a
    // control frame (auth.error / approval.decision / presence / task.*)
    // through the relay — the relay strips it too (belt and braces).
    if (msg.kind !== undefined) {
      if (msg.seq !== undefined) await runCommand(msg, gen);
      return;
    }
    if (msg.type === 'cmd.cancel') { cancelCtx(cmdCtx.get(msg.seq), 'relay_timeout'); return; }
    if (msg.type === 'auth.challenge') {
      const proof = await hmacHex(p.token, msg.nonce);
      if (gen !== Conn.gen) return;
      const inst = await installId().catch(() => '');
      if (gen !== Conn.gen) return;
      // 1.28.1 install id lets the relay tell a reconnect of THIS browser from a second copy using the same credential
      try { sock.send(JSON.stringify({ type: 'auth.response', role: 'extension', proof, version: VERSION, install: inst })); } catch { /* onclose follows */ }
      return;
    }
    if (msg.type === 'auth.ok') {
      approvedOnce.clear(); // a new connection re-asks approve-once families (eval / storage)
      clearTimeout(Conn.hsTimer); Conn.hsTimer = null;
      if (Conn.trial) { const t = Conn.trial; Conn.trial = null; await migrateCommit(t.from, t.to); if (gen !== Conn.gen) return; }
      setState('online', { attempt: 0, device: msg.device || null, account: msg.account || null,
        extLatest: typeof msg.extLatest === 'string' ? msg.extLatest.slice(0, 20) : '', relayHttp: wsToHttp(url) });
      if (msg.device) {
        const prevLabel = await deviceLabelNow();
        await setUi({ deviceLabel: msg.device.label, deviceId: msg.device.id, account: msg.account || null, disconnected: null });
        // 1.20: the live local data must be THIS account's (stash another account's share first)
        if (msg.account && msg.account.id) await acctActivate(String(msg.account.id));
        await groupsReady();
        if (msg.device.label && msg.device.label !== prevLabel) retitleOwnGroups(msg.device.label);
      }
      audit('connected to relay');
      fetchRelayVersion(url, gen);
      const t = await listTabs().catch(() => null);
      if (gen !== Conn.gen) return;
      if (t) wsSend({ type: 'hello', tabs: t.assigned, version: VERSION, ua: navigator.userAgent, access: (await cfg()).access,
        // an agent recording that survived an SW restart / reconnect keeps its relay lock
        ...(rec && rec.active && rec.source === 'agent' ? { recording: { agentId: rec.agentId, goal: rec.goal, steps: rec.steps.filter((x) => !x.deleted).length } } : {}) });
      sendTaskSnapshot().catch(() => {}); // migration + mirror reconcile
      vaultPublish().catch(() => {}); // 1.26 which sites have a saved login (site + account only)
      clearInterval(Conn.keepalive);
      let kaN = 0;
      Conn.lastRx = Date.now();
      Conn.keepalive = setInterval(() => {
        if (gen !== Conn.gen) return;
        if (connStale()) { audit('no frame from the relay for ' + Math.round((Date.now() - Conn.lastRx) / 1000) + ' s — reconnecting'); Conn.attempt = 0; connFail(gen, 'stale'); return; }
        wsSend({ type: 'keepalive' });
        if (++kaN % 90 === 0) fetchRelayVersion(url, gen); // 1.22 every ~30 min — a new download shows up without a reconnect
      }, KEEPALIVE_MS);
      return;
    }
    if (msg.type === 'auth.error') {
      // 1.31.1 rejected on the NEW address while trying the move → never terminal; back to the old address
      if (Conn.trial) { connFail(gen, 'auth_error_new_address'); return; }
      // credentials rejected: terminal until the user signs in again
      teardown();
      setState('needs_action', { reason: 'auth_rejected', attempt: 0 });
      audit('relay rejected this browser\'s credentials');
      recEndOnDisconnect('removed', false); // 1.20 never carried into a later connection
      return;
    }
    // 1.28.1: relay ≥3.7.1 — another FoxPaw (another browser / profile, or an old copy) is connected with
    // THIS browser's credential and the two kept replacing each other. Stop here (no reconnect loop) and say so.
    if (msg.type === 'device.replaced') {
      const o = msg.other && typeof msg.other === 'object' ? msg.other : {};
      const dup = { version: String(o.version || '').slice(0, 20), ua: String(o.ua || '').slice(0, 160), at: Date.now() };
      teardown();
      setState('needs_action', { reason: 'duplicate', attempt: 0, dup });
      audit(`another FoxPaw (${dup.version || 'unknown version'}) uses this browser's credential — stopped reconnecting`);
      return;
    }
    if (msg.type === 'device.revoked') {
      // 1.20: the relay dropped this device (removed in the console, or our own 断开 / 切换账号).
      // Removed = needs_action now (no reconnect loop against a dead credential); the agent recording ends.
      recEndOnDisconnect(msg.reason === 'switch' ? 'switch' : msg.reason === 'signout' ? 'signout' : 'removed', false);
      if (msg.reason === 'removed') { teardown(); setState('needs_action', { reason: 'removed', attempt: 0 }); audit('this browser was removed in the console'); }
      return;
    }
    if (msg.type === 'inviteMinted') { const r = mintWaiters.get(msg.seq); if (r) { mintWaiters.delete(msg.seq); r(msg); } return; }
    if (msg.type === 'consoleTicketIssued' || msg.type === 'consoleTicketError') { const r = ticketWaiters.get(msg.seq); if (r) { ticketWaiters.delete(msg.seq); r(msg); } return; }
    if (msg.type === 'approval.decision') { resolveConfirmFromRelay(msg); return; }
    // 1.26 the owner deletes a saved login from the console (the relay only knows its id / site / account)
    if (msg.type === 'vault.remove') {
      const m = await vaultRemove(String(msg.id || ''));
      if (m) { wsSend({ type: 'vault.removed', site: m.site, user: m.user, by: 'console' }); await audit(`login deleted from the console: ${m.site} (${maskUser(m.user)})`); }
      else await vaultPublish();
      return;
    }
    if (msg.type === 'owner.flowRun') { ownerFlowRun(msg); return; }
    // relay ≥3.4: the runs on this browser (running / paused) for the panel's run cards; 终止
    if (msg.type === 'run.list') { const rl = Array.isArray(msg.runs) ? msg.runs.slice(0, 6) : []; runsPaused = rl.filter((x) => x && x.status === 'paused').length;
      // 1.24.1: the relay keeps a finished run in run.list for ~20 s — remember the newest one for the island's 「最近」 row
      const fin = rl.filter((x) => x && x.ended && ['succeeded', 'failed', 'stopped'].includes(x.status)).sort((a, b) => b.ended - a.ended)[0];
      setUi(fin ? { runs: rl, lastRun: { id: fin.id, name: fin.name || '', status: fin.status, ended: fin.ended, of: fin.of || 0 } } : { runs: rl }); refreshAction(); return; }
    if (msg.type === 'run.abort') { runAbort(String(msg.runId || ''), msg.extRunId ? String(msg.extRunId) : ''); return; }
    if (msg.type === 'run.controlResult') { const r = runCtlWaiters.get(msg.seq); if (r) { runCtlWaiters.delete(msg.seq); r(msg); } return; }
    if (msg.type === 'task.ack') {
      if (msg.ok && msg.id) {
        const tasks = await loadLocalTasks();
        let tgt = tasks.find((x) => x.id === msg.id || x.legacy_id === msg.id);
        if (!tgt) { const pend = tasks.filter((x) => x.pending); if (pend.length === 1) tgt = pend[0]; }
        if (tgt) { tgt.pending = false; if (msg.rev) tgt.rev = msg.rev; if (msg.id && !isCloudId(tgt.id)) tgt.cloudId = msg.id; await storeLocalTasks(tasks); }
      }
      return;
    }
    if (msg.type === 'task.state') { await applyTaskState(msg.tasks || []); return; }
    if (msg.type === 'taskRunUpdate') { if (msg.run) await applyRunUpdate(msg.run); return; }
    if (msg.type === 'run.accepted') { if (!msg.ok) await audit('task run refused: ' + (msg.error || '')); return; }
    if (msg.type === 'panel.ack') { const f = panelAcks.get(String(msg.ref || '')); if (f) f({ ok: !!msg.ok, error: msg.error || '', trust: msg.trust, access: msg.access }); return; }
    if (msg.type === 'presence') {
      agentLiveFromRoster(msg.roster); // 1.27: per-agent permission pushed by the relay applies at once
      // roster entries carry pending needs; the badge counts them
      rosterNeeds = Array.isArray(msg.roster) ? msg.roster.reduce((n, a) => n + ((a && a.needs) || []).length, 0) : 0;
      refreshAction();
      notifyNeeds(msg.roster);
      setUi({ presence: msg.agents || [], roster: msg.roster || null,
        // IA v1 (relay 3.1): live approval windows on this device, drafts waiting for review, the relay's recording lock
        ...(Array.isArray(msg.windows) ? { windows: msg.windows } : {}), ...(Array.isArray(msg.drafts) ? { drafts: msg.drafts } : {}),
        ...('recLock' in msg ? { recLock: msg.recLock || null } : {}) });
      migratePauseKeys(msg.roster);
      return;
    }
  };
  sock.onclose = () => { Conn.sockets.delete(sock); if (gen === Conn.gen) connFail(gen, 'closed'); };
  sock.onerror = () => { try { sock.close(); } catch { /* noop */ } };
  sock.onopen = () => { if (gen !== Conn.gen) { Conn.sockets.delete(sock); try { sock.close(); } catch { /* noop */ } } };
}

// IA v1: the owner runs a flow from the console. It runs in a NEW tab joined to the FoxPaw
// group, as an ordinary command (not an owner replay): every card and every USER_STEP stop applies here.
async function ownerFlowRun(msg) {
  const report = (result) => { try { wsSend({ type: 'owner.flowRun.result', runId: msg.runId, result }); } catch { /* offline */ } };
  try {
    const flow = msg.flow;
    if (!flow || flow.schema !== 'foxpaw.flow/1') return report({ ok: false, code: 'BAD_FLOW', message: 'not a foxpaw.flow/1 flow' });
    // 1.21: the relay resumes a paused run in its own tabs — {from, tabs, extRunId}; no new tab
    const rs = msg.resume && typeof msg.resume === 'object' ? msg.resume : null;
    let tabId;
    if (rs) {
      tabId = Number((rs.tabs || {}).t0);
      const t = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (!t) return report({ ok: false, code: 'TAB_GONE', at: Number(rs.from) || 1, message: 'the run\'s tab was closed — start the flow again' });
    } else {
      // open the flow's start page (an about:blank tab is not controllable: TAB_INELIGIBLE), group it, wait for it
      const nav = (flow.steps || []).find((s) => s && s.type === 'navigate' && /^https?:\/\//.test(s.url || ''));
      if (!nav) return report({ ok: false, code: 'NO_START_URL', message: 'the flow has no start page (no navigate step)' });
      const tab = await chrome.tabs.create({ url: nav.url, active: true });
      await groupTab(tab.id);
      for (let i = 0; i < 100; i++) { const t = await chrome.tabs.get(tab.id).catch(() => null); if (!t || (t.status === 'complete' && /^https?:/.test(t.url || ''))) break; await new Promise((r) => setTimeout(r, 100)); }
      tabId = tab.id;
    }
    const ctx = newCtx({ kind: 'flowRun', agentLabel: '控制台运行', agentId: '', tabId, __local: true });
    const r = await flowExec({ flow, tabId, vars: msg.vars || {}, inputs: msg.inputs || undefined, relayRunId: msg.runId, onFail: msg.onFail,
      ...(rs ? { from: rs.from, tabs: rs.tabs, runId: rs.extRunId || undefined } : {}) }, ctx);
    clearNotice('fxn-run-' + msg.runId);
    report({ ok: !!(r && r.ok), paused: !!(r && r.paused), pauseKind: r && r.pauseKind, at: r && r.at, code: r && r.code, reason: r && r.reason, input: r && r.input,
      message: r && r.message ? String(r.message).slice(0, 200) : '', runId: r && r.runId, tabs: r && r.tabs });
    if (r && r.paused && r.pauseKind === 'fail') notifyOwner('fxn-run-' + msg.runId, `流程「${flow.name || msg.name || ''}」停在第 ${r.at} 步`, `${String(r.message || '').slice(0, 80)} — 在侧栏或控制台处理`, tabId);
    await audit(`console flow run ${msg.runId}: ${r && r.ok ? 'ok' : r && r.paused ? 'paused' : 'failed ' + (r && r.code)}`);
  } catch (e) {
    report({ ok: false, code: e.code || 'ERROR', message: String(e.message || e).slice(0, 200) });
  }
}

function connFail(gen, why) {
  if (gen !== Conn.gen) return;
  // 1.31.1 the new address failed before auth.ok → straight back to the stored (old) address, no backoff
  if (Conn.trial) {
    Conn.trial = null;
    if (!netOffline()) { migrateFailed(why); Conn.attempt = Math.max(0, Conn.attempt - 1); teardown(); connStart(true); return; }
  }
  const attempt = Conn.attempt;
  teardown();
  const g2 = Conn.gen;
  if (netOffline()) { waitForNetwork(Conn.pairingFp, attempt); return; }
  const delay = retryDelay(attempt);
  setState('retrying', { attempt, nextRetryAt: Date.now() + delay, reason: why });
  Conn.retryTimer = setTimeout(() => { if (g2 === Conn.gen) connStart(true); }, delay);
  // Backstop: setTimeout dies with the service worker; an alarm does not.
  try { chrome.alarms.create('foxpaw-reconnect', { delayInMinutes: Math.max(delay, 30000) / 60000 }); } catch { /* noop */ }
}

// 1.28.1: 1 s, 2 s, 4 s … capped at 10 s for the first five attempts; then 1–5 minutes
function retryDelay(attempt) {
  if (attempt > RETRY_SLOW_AFTER) {
    const base = Math.min(RETRY_SLOW_CAP_MS, RETRY_SLOW_MIN_MS * 2 ** (attempt - RETRY_SLOW_AFTER - 1));
    return Math.min(RETRY_SLOW_CAP_MS, Math.max(RETRY_SLOW_MIN_MS, Math.round(base * (0.85 + Math.random() * 0.15))));
  }
  const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.7 + Math.random() * 0.3)); // jitter
}
function netOffline() { try { return !!(self.navigator && self.navigator.onLine === false); } catch { return false; } }
function waitForNetwork(fp, attempt = Conn.attempt) {
  clearTimeout(Conn.retryTimer); Conn.retryTimer = null;
  try { chrome.alarms.clear('foxpaw-reconnect'); } catch { /* noop */ }
  setState('retrying', { attempt, nextRetryAt: 0, reason: 'net_offline', ...(fp !== undefined ? { pairingFp: fp } : {}) });
}
function connStale() {
  return Conn.state === 'online' && Conn.relayPings && Conn.lastRx > 0 && Date.now() - Conn.lastRx > STALE_MS;
}
try {
  self.addEventListener('online', () => { if (Conn.state === 'retrying' || Conn.state === 'connecting') { Conn.attempt = 0; connStart(true); } });
} catch { /* mocks */ }
function wsToHttp(wsUrl) { try { const u = new URL(wsUrl); return (u.protocol === 'ws:' ? 'http:' : 'https:') + '//' + u.host; } catch { return ''; } }
async function fetchRelayVersion(wsUrl, gen) {
  try {
    const u = new URL(wsUrl);
    const base = (u.protocol === 'ws:' ? 'http:' : 'https:') + '//' + u.host;
    const j = await (await fetch(base + '/health')).json();
    if (gen === Conn.gen && j && j.version) setState(Conn.state, { relayVersion: String(j.version), attempt: Conn.attempt, nextRetryAt: Conn.nextRetryAt, reason: Conn.reason,
      relayHttp: base, ...(typeof j.extLatest === 'string' ? { extLatest: j.extLatest.slice(0, 20) } : {}) });
  } catch { /* optional */ }
}

/* 1.24 ask the relay for the download version NOW (side panel opened / 「检查更新」 clicked).
   Same public /health the handshake path already reads; works while the WS is down (unpaired → official relay).
   Returns { ok, latest, current }; ok:false when the relay is unreachable or has no readable download (extLatest ""). */
async function checkUpdateNow() {
  const base = relayHttpOf((await cfg()).pairing); // the paired relay (or the official one when unpaired)
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(base + '/health', { cache: 'no-store', signal: ac.signal });
    const j = r.ok ? await r.json() : null;
    const latest = j && typeof j.extLatest === 'string' ? j.extLatest.slice(0, 20) : '';
    if (j && typeof j.extLatest === 'string') {
      setState(Conn.state, { attempt: Conn.attempt, nextRetryAt: Conn.nextRetryAt, reason: Conn.reason, extLatest: latest,
        relayHttp: base, ...(j.version && Conn.state === 'online' ? { relayVersion: String(j.version) } : {}) });
    }
    if (!/^\d+(\.\d+){0,3}$/.test(latest)) return { ok: false, current: VERSION };
    return { ok: true, latest, current: VERSION };
  } catch { return { ok: false, current: VERSION }; } finally { clearTimeout(to); }
}

/* ---------------- access modes + command dispatch ---------------- */
// One table: which agent commands are reads. Everything else is a write.
// 'always' kinds only reduce access (release a debugger) and pass in every mode.
const CMD_CLASS = {
  ping: 'read', tabs: 'read', snapshot: 'read', listTasks: 'read', findTabs: 'read', ask: 'read', waitFor: 'read',
  extract: 'read', query: 'read', scroll: 'read', screenshot: 'read', // 1.30 read kit: reading the page, no card
  click: 'write', fill: 'write', login: 'write', vaultSave: 'write', navigate: 'write', flowRun: 'write', recordStart: 'write', recordStop: 'write', createTab: 'write', closeTab: 'write', activateTab: 'write', taskResult: 'write',
  cdp: 'cdp', cdpDetach: 'always',
};
// CDP methods that only observe (or set up observation). Runtime.evaluate,
// Input.*, Page.navigate, DOM.set*… are writes; CDP_SENSITIVE (cookies /
// storage) is checked FIRST and is never a read.
const CDP_READ = /^(\w+)\.(get\w*|describe\w*|query\w*|enable|disable|capture\w*|search\w*|resolveNode|requestNode|requestChildNodes|setLifecycleEventsEnabled|setAutoAttach|setDiscoverTargets|runIfWaitingForDebugger|performSearch|discardSearchResults)$/;
function commandClass(kind, msg) {
  const k = CMD_CLASS[kind];
  if (k === 'cdp') {
    const m = String((msg && msg.method) || '');
    if (CDP_SENSITIVE.test(m)) return 'sensitive';
    if (m === 'Fetch.enable') return 'write'; // pauses every request of the tab: not an observation
    return CDP_READ.test(m) ? 'read' : 'write';
  }
  return k || 'write';
}
function accessGate(access, kind, msg) {
  const cls = commandClass(kind, msg);
  if (cls === 'always') return null;
  if (access === 'off') return err('PAUSED', 'FoxPaw is paused by the browser owner (mode 停用) — no commands are accepted right now');
  if (access === 'read' && cls !== 'read') return err('READ_ONLY', `FoxPaw is in read-only mode (只看) — "${kind}" is a write and was refused`);
  return null;
}
// legacy 'label:<name>' pause keys (≤1.14) -> agent ID, once the roster names it unambiguously
async function migratePauseKeys(roster) {
  if (!Array.isArray(roster)) return;
  const c = await cfg();
  const pz = { ...(c.agentPause || {}) };
  let changed = false;
  for (const k of Object.keys(pz)) {
    const label = k.startsWith('label:') ? k.slice(6) : (/^g\d+$/.test(k) ? null : k);
    if (label === null) continue;
    const hits = roster.filter((a) => a && a.id && a.label === label);
    if (hits.length === 1) { pz[hits[0].id] = pz[k]; delete pz[k]; changed = true; }
    else if (!k.startsWith('label:')) { pz['label:' + k] = pz[k]; delete pz[k]; changed = true; }
  }
  if (changed) await saveCfg({ agentPause: pz });
}
async function runCommand(msg, gen) {
  const ctx = newCtx(msg);
  if (msg.seq !== undefined) cmdCtx.set(msg.seq, ctx);
  let reply;
  try {
    if (!handlers[msg.kind]) throw err('UNKNOWN_KIND', 'unknown command: ' + msg.kind);
    const data = await handlers[msg.kind](msg, ctx); // every handler = one execCore() call
    reply = { seq: msg.seq, ok: true, data };
  } catch (e) {
    reply = { seq: msg.seq, ok: false, error: { code: e.code || 'ERROR', message: String(e.message || e) } };
    if (e.candidates) reply.error.candidates = e.candidates; // AMBIGUOUS: pick one ref, never "the first"
    if (e.detail) reply.error.detail = e.detail;
    audit(`cmd ${msg.kind} FAILED ${reply.error.code}: ${reply.error.message}`, { agent: ctx.agentLabel || undefined, agentId: ctx.agentId || undefined });
  } finally {
    cmdCtx.delete(msg.seq);
  }
  if (gen === Conn.gen && !ctx.cancelled) wsSend(reply);
}

/* ---------------- toolbar icon ---------------- */
function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* noop */ }
}
const ICON_PLAIN = { 16: 'icons/foxpaw-16.png', 32: 'icons/foxpaw-32.png', 48: 'icons/foxpaw-48.png', 128: 'icons/foxpaw-128.png' };
const ICON_DOT = { 16: 'icons/foxpaw-dot-16.png', 32: 'icons/foxpaw-dot-32.png', 48: 'icons/foxpaw-dot-48.png', 128: 'icons/foxpaw-dot-128.png' };
// Quiet by default: online = small green dot in the icon; text badges only
// for things that need the user's eyes (pending count, needs_action "!").
function refreshAction() {
  try {
    const pending = pendingConfirms.size + pendingAsks.size + rosterNeeds + userSteps.size + runsPaused + (rec && rec.active && rec.paused === 'login' ? 1 : 0); // an agent recording waiting for the owner to log in counts too
    const online = Conn.state === 'online';
    // the green-dot icons are separate design assets; until they are in the package fall back to the plain logo
    Promise.resolve(chrome.action.setIcon({ path: online ? ICON_DOT : ICON_PLAIN })).catch(() => { try { return chrome.action.setIcon({ path: ICON_PLAIN }); } catch { return null; } }).catch(() => {});
    if (pending > 0) setBadge(String(pending), '#ff7a1a');
    else if (Conn.state === 'needs_action') setBadge('!', '#e03131');
    else setBadge('');
  } catch { /* noop */ }
}

/* ---------------- lifecycle wiring ---------------- */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'foxpaw-panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  try { port.postMessage({ type: 'conn', snap: connSnapshot() }); } catch { /* noop */ }
  // opening the panel while waiting to retry = try now (not while the OS says offline)
  if (Conn.state === 'retrying' && !netOffline()) connStart(true);
});
chrome.alarms.create('foxpaw-watchdog', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // a pending login grant keeps polling in the background, panel or not
  const lg = (await chrome.storage.local.get('foxpawLogin')).foxpawLogin;
  if (lg) {
    if (Date.now() > lg.expires) await chrome.storage.local.remove('foxpawLogin');
    else {
      try {
        const r = await fetch(RELAY_HTTP + '/auth/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: lg.device_code }) });
        const j = await r.json();
        if (j.status === 'approved') {
          await chrome.storage.local.remove('foxpawLogin');
          await saveCfg({ pairing: j.pairing, enabled: true }); // storage listener restarts the controller
        }
      } catch { /* next alarm retries */ }
    }
  }
  if (Conn.state === 'online' && Conn.ws && Conn.ws.readyState === WebSocket.OPEN) {
    // 1.28.1 the half-dead check also runs here (an interval can be lost with a worker restart)
    if (connStale()) { audit('watchdog: no frame from the relay for ' + Math.round((Date.now() - Conn.lastRx) / 1000) + ' s — reconnecting'); Conn.attempt = 0; connFail(Conn.gen, 'stale'); return; }
    sendTabsSync(); return;
  }
  if (Conn.state === 'needs_action' || Conn.state === 'off') return;
  if (Conn.state === 'retrying') { if (netOffline()) return; if (Date.now() >= Conn.nextRetryAt) connStart(true); return; }
  const dead = !Conn.ws || Conn.ws.readyState === WebSocket.CLOSED || Conn.ws.readyState === WebSocket.CLOSING;
  if (dead) connStart(true);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.foxpawCfg) return;
  const n = changes.foxpawCfg.newValue || {};
  const o = changes.foxpawCfg.oldValue || {};
  // 1.31.1 the domain move's own write (old → new address, same token) keeps the live socket
  const moved = Conn.migratedTo && n.pairing === Conn.migratedTo && n.enabled === o.enabled;
  if (moved) Conn.migratedTo = '';
  if (!moved && (n.pairing !== o.pairing || n.enabled !== o.enabled)) { Conn.attempt = 0; connStart(true); }
  if (n.access !== o.access) {
    refreshAction();
    wsSend({ type: 'mode', access: n.access }); // relay shows it in the console (it never relaxes enforcement)
    if (n.access === 'off') {
      // paused: drop agents' CDP sessions and our debugger attachments
      wsSend({ type: 'kickCdp' });
      for (const t of [...attached]) if (!recAttached.has(t)) detachDebugger(t);
    }
  }
});
async function boot() {
  await migrateCfg();
  await groupsReady();
  // Cold start (SW restart): the cached snapshot is display-only. Restore a
  // needs_action only when credentials are unchanged; otherwise reconnect.
  const { foxpawConn: cached } = await chrome.storage.local.get('foxpawConn');
  const c = await cfg();
  if (cached && cached.state === 'needs_action' && cached.reason !== 'duplicate' && cached.pairingFp && cached.pairingFp === pairingFp(c.pairing) && c.enabled) {
    setState('needs_action', { reason: cached.reason || 'auth_rejected', attempt: 0, pairingFp: cached.pairingFp });
    return;
  }
  await connStart(true);
}
chrome.runtime.onStartup.addListener(() => {
  adoptStartup = true;            // 1.24 browser restart — tab ids changed, never restore adopted tabs
  chrome.storage.local.remove(ADOPT_KEY).catch(() => {});
  connStart();
});
chrome.runtime.onInstalled.addListener((d) => {
  connStart();
  // extension reload / overwrite install: give onStartup (if this is also a browser launch) a moment to say so
  if (d && d.reason === 'update') setTimeout(() => { restoreAdopted('extension update').catch(() => {}); }, 400);
  // 1.31.0 tell the owner once, in the panel, what an overwrite update added (permissions)
  if (d && d.reason === 'update') {
    const prev = String(d.previousVersion || '0');
    const lt = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };
    if (lt(prev, '1.31.0')) chrome.storage.local.set({ foxpawUpdNote: { version: VERSION, from: prev, text: '新增权限：观察网络请求（只读，用于判断页面加载完成），滚动读页会等慢接口回来再停' } }).catch(() => {});
  }
});
const booted = boot();
// test hook (harmless in production): lets the harness drive the controller
self.__foxpaw = { retryDelay, panelAsk, ackTimeoutVerdict, inFrames, connStale, STALE_MS, userSteps, notifTabs, pageModel, fpPage, Conn, connStart, connSnapshot, accessGate, commandClass, booted, classifyElement, recRedactBundle, scrubCdpEvent, CDP_SENSITIVE, CDP_READ, CONFIRM_TTL_MS,
  migratedPairing, MIGRATE_KEY, DOMAIN_NOTE_KEY, ownGroups, adopted, adoptMeta, restoreAdopted, ADOPT_KEY, groupTitle, capsOf, focusCache, focusGen, fpPage, FF, flowRuns, keyParams, recRedactUrl };

'use strict';
/* FoxPaw side panel — 1.23: the 灵动岛 replaces the header bar, the
   connection strip and the status card. Older notes: v1.18 panel UI refresh: header brand +
   connection capsule, AgentStatusIsland (the one most important state),
   access switch row, Agent | 录制 tabs, attention card / current tab card /
   authorized tabs / usage summary / folded resting agents; 「我的」 back face.
   Every state, count and title below comes from real data (conn snapshot,
   foxpawUi roster / locks / confirms / asks, chrome.tabs); every button
   sends a message the background already handles — nothing is simulated.
   Connection state arrives by push over a long-lived port from the
   background controller (fallback: one status query). Other data is
   re-read only when storage changes — no polling of connection state. */
const $ = (id) => document.getElementById(id);
const CONSOLE = 'https://foxpaw.aiyuancat.com/app'; // 1.31.0: new default domain (the paired relay's own address wins where the panel knows it)
const SITE = CONSOLE.replace(/\/app$/, ''); // site origin — the panel's exit rows live here
// 1.31.0: a paired browser keeps its relay's own address (the website sign-in lives there); unpaired → SITE
const siteBase = () => (conn && /^https?:\/\//.test(conn.relayHttp || '') ? conn.relayHttp : SITE);

/* ---------- background bridge ---------- */
async function send(m) {
  const r = await Promise.race([
    chrome.runtime.sendMessage(m),
    new Promise((_, rej) => setTimeout(() => rej(new Error('后台无响应')), 8000)),
  ]);
  if (r && r.__foxErr) throw new Error(r.__foxErr);
  return r;
}
let conn = { state: 'off', reason: 'signed_out', attempt: 0, nextRetryAt: 0 };
let port = null;
function openPort() {
  try {
    port = chrome.runtime.connect({ name: 'foxpaw-panel' });
    port.onMessage.addListener((m) => { if (m && m.type === 'conn' && m.snap) { conn = m.snap; connKnown = true; schedule(); } });
    port.onDisconnect.addListener(() => { port = null; setTimeout(() => { openPort(); pullStatus(); }, 1000); });
  } catch { port = null; }
}
async function pullStatus() {
  const s = await send({ type: 'foxpaw.status' }).catch(() => null);
  if (s && s.state) { conn = s; connKnown = true; schedule(); }
}

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const pad = (n) => String(n).padStart(2, '0');
function toDate(ts) {
  if (!ts) return null;
  const d = new Date(typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : String(ts).replace(' ', 'T'));
  return isNaN(d) ? null : d;
}
function when(ts) {
  const d = toDate(ts);
  if (!d) return '';
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function hhmm(ts) { const d = toDate(ts); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }
// relative last-activity phrasing — '刚刚' / 'N 分钟前' / 'N 小时前' /
// '昨天' / 'N 天前', and the same with the 来过 suffix for card sublines.
function agoCore(ts) {
  const d = toDate(ts);
  if (!d) return '';
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 120) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (d.toDateString() === new Date().toDateString()) return `${Math.floor(s / 3600)} 小时前`;
  if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return '昨天';
  return `${Math.max(1, Math.floor(s / 86400))} 天前`;
}
function agoCame(ts) { const c = agoCore(ts); return c ? `${c}来过` : ''; }
function nextRunText(ts) {
  const d = toDate(ts);
  if (!d) return '';
  const day = d.toDateString() === new Date().toDateString() ? '今天'
    : d.toDateString() === new Date(Date.now() + 864e5).toDateString() ? '明天'
    : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `下次 ${day} ${hhmm(ts)} 来`;
}
const HUES = [16, 210, 265, 160, 330, 45, 190, 120];
function hue(label) { let h = 0; for (const c of String(label)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; }
// 1.31.2: an agent's avatar = the image its owner set in the console (relay roster `avatar`, an https URL on the relay);
// none = the default letter disc. Agents can never set it.
let avatarOf = {};
function avImg(label) {
  const u = avatarOf[label];
  return u && /^https?:\/\//.test(u) ? `<img src="${esc(u)}" alt="" referrerpolicy="no-referrer">` : '';
}
function avInner(label) { return avImg(label) || esc(String(label || '?').slice(0, 1).toUpperCase()); }
function avatar(label, cls = '', bg = null) {
  const style = bg ? `background:${bg}` : `background:hsl(${hue(label)} 58% 50%)`;
  return `<div class="av ${cls}" style="${style}">${avInner(label)}</div>`;
}
// 1.20: first two + last two of the name part — owner-a@ and owner-b@ used to both read
// 「own***@」; the relay's mask_email applies the same rule, plus a stable avatar color per account.
function maskEmail(e) {
  const m = /^([^@]+)@(.+)$/.exec(String(e || ''));
  if (!m) return '';
  const n = m[1];
  if (n.length <= 2) return n.slice(0, 1) + '…@' + m[2];
  if (n.length <= 4) return n.slice(0, 1) + '…' + n.slice(-1) + '@' + m[2];
  return n.slice(0, 2) + '…' + n.slice(-2) + '@' + m[2];
}
const maskEmail1 = maskEmail;
const ACCT_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c7cfa'];
function acctColor(a) {
  if (a && a.badge && a.badge.color) return a.badge.color;
  let h = 0; for (const ch of String((a && a.email) || '').toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCT_COLORS[h % ACCT_COLORS.length];
}
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function toast(btn, text, ms = 1800) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = btn.dataset.label; }, ms);
}
let toastTimer = null;
function showToast(text, ms = 3200) {
  const t = $('toast');
  if (!t) return;
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/* ---------- copy: one state, one sentence ---------- */
const ACCESS_TEXT = { off: '已停用', read: '只看', write: '可操作' };
function connLine(c, device) {
  const s = c.state;
  if (s === 'online') return `已连接 · ${device || '这台浏览器'}`;
  if (s === 'connecting') return '正在连接…';
  if (s === 'retrying') {
    const sec = Math.max(0, Math.ceil((c.nextRetryAt - Date.now()) / 1000));
    if (c.reason === 'net_offline' && !c.nextRetryAt) return '电脑没联网，联网后自动重连';
    return sec > 0 ? `连接断开，${sec} 秒后自动重试` : '正在重试…';
  }
  if (s === 'needs_action') return c.reason === 'badpairing' ? '连接码无效，需要重新连接' : c.reason === 'removed' ? '这台浏览器已在控制台被移除'
    : c.reason === 'duplicate' ? '另一个 FoxPaw 正用这台浏览器的连接' : '这台浏览器的连接已失效';
  if (D.ui && D.ui.disconnected) return '已断开 · 可以随时重新连接';
  if (c.reason === 'disabled') return '连接已关闭，可在「我的」里重新连接';
  return '未连接，这台浏览器还没连上';
}
function connShort(c) {
  return { online: '已连接', connecting: '正在连接', retrying: '正在重试', needs_action: '需要重新连接', off: c.reason === 'disabled' ? '已关闭' : '未连接' }[c.state] || '—';
}
const CAT_TEXT = { submit: '提交表单', delete: '删除内容', write: '填写表单', eval: '在页面运行脚本', tab: '使用一个未授权的标签', gate: '做一个敏感操作' };

/* ---------- state ---------- */
let D = { cfg: {}, ui: {}, audit: [], tasks: [], lib: [], rec: null, tabs: [], gids: [], cur: null, feedSeen: 0 };
let curTab = 'agent';
let loginPolling = null;
const sigs = {};
function changed(key, val) { const s = JSON.stringify(val); if (sigs[key] === s) return false; sigs[key] = s; return true; }

async function load() {
  const st = await chrome.storage.local.get(['foxpawCfg', 'foxpawUi', 'foxpawAudit', 'foxpawTasks', 'foxpawRecLibrary', 'foxpawRecording', 'foxpawFeedSeen', 'foxpawGroups', 'foxpawUpdDismissed', 'foxpawUpdNote', 'foxpawDomainNote', 'foxpawAgentsSeen']);
  const tabs = await chrome.tabs.query({}).catch(() => []);
  // v1.16: only groups THIS browser created / claimed count — a
  // same-titled group synced from another device is not ours
  const gids = Array.isArray(st.foxpawGroups && st.foxpawGroups.ids) ? st.foxpawGroups.ids : [];
  const lib = Array.isArray(st.foxpawRecLibrary) ? st.foxpawRecLibrary.slice() : [];
  const rec = st.foxpawRecording || null;
  if (!lib.length && rec && !rec.active && (rec.steps || []).length) {
    lib.push({ name: rec.name || '未命名录制', source: 'human', startedAt: rec.startedAt, stoppedAt: rec.stoppedAt, steps: rec.steps, requests: rec.requests || [], legacy: true });
  }
  D = {
    cfg: { access: 'write', sensitive: 'ask', siteRules: {}, ...(st.foxpawCfg || {}) },  // access: 'off' = 全部暂停, else normal (1.27 )
    ui: st.foxpawUi || {}, audit: st.foxpawAudit || [], tasks: Array.isArray(st.foxpawTasks) ? st.foxpawTasks : [],
    lib, rec: (st.foxpawUi || {}).recording || null, tabs: tabs || [], gids, cur: (tabs || []).find((t) => t.active) || null,
    feedSeen: st.foxpawFeedSeen || 0, updDismissed: st.foxpawUpdDismissed || '', updNote: st.foxpawUpdNote || null, domNote: st.foxpawDomainNote || null,
    agSeen: Array.isArray(st.foxpawAgentsSeen) ? st.foxpawAgentsSeen : null,   // 1.33.0: agents already introduced
  };
  if (D.cfg.access !== 'off') D.cfg.access = 'write'; // 1.27: a stored 只看 (≤1.26) = no browser-level limit
  loaded = true;
  render();
}
let pending = null;
function schedule() { clearTimeout(pending); pending = setTimeout(() => render(), 16); }
let loadTimer = null;
function reload() { clearTimeout(loadTimer); loadTimer = setTimeout(load, 60); }

/* ---------- derived ---------- */
function roster() {
  // Homepage order: who needs the owner first — needs count
  // desc, then state (working > recent > rest), then label.
  const rank = { working: 0, recent: 1, rest: 2 };
  const nNeeds = (a) => (Array.isArray(a.needs) ? a.needs.length : 0);
  const byHome = (a, b) => (nNeeds(b) - nNeeds(a)) || ((rank[a.state] ?? 1) - (rank[b.state] ?? 1)) || String(a.label).localeCompare(String(b.label));
  const ui = D.ui;
  if (Array.isArray(ui.roster) && ui.roster.length) return ui.roster.slice().sort(byHome);
  return (ui.presence || []).map((a) => ({ label: a.label, state: 'working', tabs: a.tabs, since: a.since, tabList: a.tabList || [] })).sort(byHome);
}

/* ---------- homepage: needs / yield / field / colours ---------- */
const AGENT_COLORS = ['#e8641c', '#5b7ba5', '#7a9a5b', '#8a8578', '#7a5ba5', '#4a7a8c'];
let colorOf = {};
const openAgents = new Set();
let agFold = (() => { try { return localStorage.getItem('fxAgFold') === '1'; } catch { return false; } })();
function setAgFold(v) { agFold = !!v; try { localStorage.setItem('fxAgFold', agFold ? '1' : '0'); } catch { /* noop */ } render(); }
// 「休息中 · 3 个」 / 「1 个在干 · 2 个休息」 / 「1 个等你 · …」 — island line 3 and the folded list row
function agentSummary(list) {
  const need = list.filter((a) => agentNeeds(a).length).length;
  const work = list.filter((a) => !agentNeeds(a).length && a.state === 'working').length;
  const rest = list.length - need - work;
  const parts = [];
  if (need) parts.push(`${need} 个等你`);
  if (work) parts.push(`${work} 个在干`);
  if (rest) parts.push(need || work ? `${rest} 个休息` : '');
  const head = need || work ? parts.filter(Boolean).join(' · ') : `${list.length} 个休息中`;
  const line = need || work ? head : `休息中 · ${list.length} 个`;
  return { head, line };
}
let menuFor = null;
const localPaused = new Set();
function agentNeeds(a) { return Array.isArray(a && a.needs) ? a.needs : []; }
function isPaused(label, id) {
  // v1.15: pause is keyed by agent ID ('label:<name>' = legacy)
  const m = D.cfg.agentPause;
  if (m && typeof m === 'object') {
    if (id && id in m) return !!m[id];
    if (('label:' + label) in m) return !!m['label:' + label];
    if (!id && label in m) return !!m[label];
  }
  return localPaused.has(id || label);
}
// relay 3.0.1: tabList entries carry via — 'lease' (write lease) or a CDP
// session (presence) = really controlling; 'touch' = read / operated
// recently without a lease: shown as 刚看过 / 刚操作, never as 控制中, and
// never offered 「我要用这个」.
function isControlling(t, presSet) { return !!t && t.via !== 'touch' && (t.via === 'lease' || !!(presSet && presSet.has(t.id))); }
// relay 3.0.1 marks touch.kind 'write' for operations; anything else was a read
function touchText(t) { return t && t.kind === 'write' ? '刚操作' : '刚看过'; }
// first letter of the site; IP / localhost hosts say nothing, so the title's first letter instead
function siteLetter(t) { const h = hostOf((t && t.url) || ''); const base = h && !/^(\d+\.){3}\d+$|^localhost$|^\[/.test(h) ? h : ((t && t.title) || h || '?'); return base.slice(0, 1).toUpperCase(); }
async function activateTab(tabId) {
  if (tabId == null) return;
  try { await chrome.tabs.update(tabId, { active: true }); } catch { /* tab already gone */ }
  try {
    const t = chrome.tabs.get ? await chrome.tabs.get(tabId) : null;
    if (t && t.windowId != null && chrome.windows && chrome.windows.update) await chrome.windows.update(t.windowId, { focused: true });
  } catch { /* best effort */ }
}
function inMine(t) { return !!t && D.gids.includes(t.groupId); }
function myTabs() { return D.tabs.filter(inMine); }
function paired() { return !!(D.cfg.pairing && String(D.cfg.pairing).trim()); }

/* ---------- render ---------- */
/* ---------- render ---------- */
// IA v1 (1.19, ): one page — no Agent / 录制 tabs. While the OWNER records (or is on the
// save page) the recording screen replaces the home; everything else is the live scene.
function ownerRec() { const r = D.rec; return !!(r && r.source !== 'agent' && (r.active || r.pendingSave)); }
function agentRec() { const r = D.rec; return r && r.source === 'agent' && r.active ? r : null; }
function render() {
  renderHeader();
  renderVaultOffer();
  renderUpdBar();
  const recMode = ownerRec();
  $('v-agent').classList.toggle('on', !recMode);
  $('v-rec').classList.toggle('on', recMode);
  // 1.33.2: what waits on the owner (an agent's question, approvals, user steps) stays answerable while
  // the owner records — the one #pending box moves into the recording screen instead of hiding with
  // the home. The side panel is an extension page: nothing typed here is ever a recorded step.
  const pend = $('pending'), slot = recMode ? $('recPendSlot') : $('vaultOffer');
  if (pend && slot && (recMode ? pend.parentElement !== slot : pend.previousElementSibling !== slot)) { if (recMode) slot.append(pend); else slot.after(pend); }
  if (recMode) { renderPending(); renderRecView(); } else renderAgent();
  renderIsland(roster());
  renderAskBar();
  renderFooter();
  if ($('flip').classList.contains('flipped')) renderMe();
}

function renderHeader() {
  const email = D.ui.account && D.ui.account.email;
  $('btnMe').textContent = email ? email.slice(0, 1).toUpperCase() : '我';
  $('btnMe').style.background = email ? acctColor(D.ui.account) : '';
  $('btnMe').style.color = email ? '#fff' : '';
  $('btnMe').title = email ? '我 · ' + maskEmail(email) : '我';
}

function renderAccessNote() {
  const a = D.cfg.access;
  const n = $('accessNote');
  const islandSays = a === 'off' && paired() && conn.state === 'online' && roster().length > 0;
  n.className = 'note' + (a === 'off' && !islandSays ? ' off' : a === 'read' ? ' read' : ' hidden');
  n.textContent = a === 'off' ? '已停用：Agent 的所有操作都会被拒绝。可在「我」里切换。' : a === 'read' ? '只看：Agent 只能读取页面，不能点击或填写。' : '';
  // 1.20: FoxPaw's Chrome notifications are off -> approval / login prompts would arrive silently
  const nn = $('notifyNote');
  const off = paired() && D.ui.notifyLevel === 'denied';
  nn.className = 'note read' + (off ? '' : ' hidden');
  if (off) nn.innerHTML = '系统通知被关了：要你批准时只会在这里和图标角标提示。开启：Chrome 设置 → 隐私和安全 → 网站设置 → 通知（Mac 还要在 系统设置 → 通知 → Google Chrome 里允许）。';
}

// (1.18.1): USER_STEPs this browser refused for an agent (pay / authorize / password /
// code / file) — pinned above approvals. An agent that already raised its hand (need card) for
// the same tab is shown there instead, with 「好了，继续」.
const USTEP_CN = { pay: '付款', grant: '授权', secret: '填写密码 / 验证码 / 卡号', captcha: '过验证码 / 人机校验', manual: '亲自操作一步', file: '选择本机文件' };
function userStepsShown() {
  const steps = Array.isArray(D.ui.userSteps) ? D.ui.userSteps : [];
  const needTabs = new Set();
  for (const a of roster()) for (const n of agentNeeds(a)) if (n.tabId != null) needTabs.add(n.tabId);
  return steps.filter((u) => u.tabId == null || !needTabs.has(u.tabId));
}
/* ---------- 需要你处理 · 要批准 ---------- */
const VERB_TEXT = { pay: '付款', submit: '提交', delete: '删除', write: '填写', upload: '上传文件', eval: '在页面运行脚本', tab: '使用一个未授权的标签', session: '读写登录数据', unknown: '做一个看不清的操作', otp: '填写验证码', gate: '做一个敏感操作', login: '用你的已存登录', vault: '保存登录凭证' };
function tabTitleOf(tabId) { const t = D.tabs.find((x) => x.id === tabId); return t ? (t.title || t.url || '') : ''; }
function renderPending() {
  const confs = D.ui.pendingConfirms || [];
  const asks = D.ui.pendingAsks || [];
  const steps = userStepsShown();
  if (!changed('pending', [steps.map((u) => [u.id, u.since]), confs.map((p) => p.id), asks.map((p) => p.id), Math.floor(Date.now() / 60000)])) return;
  const box = $('pending');
  box.innerHTML = '';
  for (const u of steps) {
    const who = u.agent || 'Agent';
    const what = USTEP_CN[u.reason] || '亲自操作一步';
    const where = [u.host, u.page].filter(Boolean).join(' · ') || '已授权的标签';
    const card = el(`<div class="card needc ustep" data-id="${esc(u.id)}">
      <div class="k">需要你处理 · ${esc(when(u.since) || '刚刚')}</div>
      <h3 title="${esc(who)} 需要你${esc(what)}">${esc(who)} 需要你${esc(what)}</h3>
      <p>这一步 Agent 不能替你做。去那个标签亲自处理，处理完点「处理好了」；Agent 举手等你时，在它的卡上点「好了，继续」它就接着做。</p>
      <div class="tabref"><span class="sq sm">${esc(siteLetter({ title: u.page || u.host }))}</span><span class="ell" title="${esc(where)}${u.what ? ' · ' + esc(u.what) : ''}">${esc(where)}${u.what ? ' · ' + esc(u.what) : ''}</span></div>
      <div class="acts">${u.tabId != null ? '<button class="btn pri" data-a="go">去处理</button>' : ''}<button class="btn${u.tabId != null ? '' : ' pri'}" data-a="done">处理好了</button></div>
    </div>`);
    const go = card.querySelector('[data-a=go]');
    if (go) go.onclick = () => send({ type: 'foxpaw.userStepGo', id: u.id }).catch(() => activateTab(u.tabId));
    card.querySelector('[data-a=done]').onclick = () => send({ type: 'foxpaw.userStepDone', id: u.id }).catch(() => {});
    box.append(card);
  }
  for (const p of confs) {
    const who = p.agent || 'Agent';
    const verb = VERB_TEXT[p.category] || VERB_TEXT.gate;
    const what = p.category === 'login' || p.category === 'vault' ? String(p.title || '').replace(/^(用已存登录|保存登录凭证)\s*/, '') || verb
      : p.title && !/^\w+ on /.test(p.title) ? p.title : verb;
    const where = [p.page || p.host || hostOf(p.origin || ''), p.detail && p.detail !== p.title ? p.detail : ''].filter(Boolean).join(' · ');
    const otp = p.category === 'otp' || p.otp;
    const card = el(`<div class="card needc appr" data-id="${esc(p.id)}">
      <div class="k">需要你处理 · ${esc(when(p.openedAt || Date.now()) || '刚刚')}</div>
      <h3>${what && what !== verb ? `${esc(who)} 要${esc(verb)}：${esc(what)}` : `${esc(who)} 要${esc(verb)}`}</h3>
      ${p.category === 'pay' ? `<div class="paytag"><b>付款</b>${p.amount ? `<span>${esc(p.amount)}</span>` : ''}</div>` : ''}
      <p>${p.category === 'pay' ? '批准后它会替你点下去，可能马上扣费。付款每次都要你批准，不会记住，信任也不免。' : p.category === 'login' ? '密码由 FoxPaw 在本机填入，Agent 看不到；只用这一次。' : p.category === 'vault' ? '密码只加密存在这台浏览器，Agent 之后可以用它登录（看不到密码）。' : otp ? '允许后，本任务里的验证码由它代填，不再打断你。' : p.category === 'delete' ? '删除后可能无法恢复。' : p.category === 'submit' ? '提交后通常不能撤回。' : '批准后它才会继续。'}</p>
      ${where ? `<div class="tabref"><span class="sq sm">${esc(siteLetter({ url: p.origin, title: p.page }))}</span><span class="ell" title="${esc(where)}">${esc(where)}</span></div>` : ''}
      ${p.windowable ? '<label class="chk"><input type="checkbox" data-a="win"> <span>接下来 5 分钟内，本任务的同类操作不再问</span></label><div class="oncehint">「这次都放行」：本次任务里的填写 / 提交 / 删除 / 运行脚本都不再问，任务结束就失效；付款每次都要你批准，本机文件仍交你。</div>'
        : p.basis ? '<label class="chk"><input type="checkbox" data-a="rem"> <span>记住同类，下次不再问</span></label>' : ''}
      <div class="acts"><button class="btn pri" data-a="ok">${otp ? '允许本任务代填' : '批准'}</button>${p.windowable ? '<button class="btn" data-a="once" title="本次任务里的填写 / 提交 / 删除 / 运行脚本都不再问，任务结束就失效">这次都放行</button>' : ''}${p.tabId != null ? '<button class="btn" data-a="look">去看看</button>' : '<button class="btn" data-a="no">拒绝</button>'}<button class="btn stopx" data-a="stop">让它停下</button></div>
    </div>`);
    const win = card.querySelector('[data-a=win]');
    const rem = card.querySelector('[data-a=rem]');
    card.querySelector('[data-a=ok]').onclick = () => send({ type: 'foxpaw.confirm', id: p.id, approved: true, window: !!(win && win.checked), remember: !!(rem && rem.checked) }).catch(() => {});
    const once = card.querySelector('[data-a=once]'); // 1.25 
    if (once) once.onclick = () => send({ type: 'foxpaw.confirm', id: p.id, approved: true, window: 'task' }).catch(() => {});
    const look = card.querySelector('[data-a=look]');
    if (look) look.onclick = () => activateTab(p.tabId);
    const no = card.querySelector('[data-a=no]');
    if (no) no.onclick = () => send({ type: 'foxpaw.confirm', id: p.id, approved: false }).catch(() => {});
    card.querySelector('[data-a=stop]').onclick = () => send({ type: 'foxpaw.confirm', id: p.id, approved: false, stop: true }).catch(() => {});
    box.append(card);
  }
  for (const q of asks) {
    const card = el(`<div class="card ask">
      <div class="ah">${avatar(q.agent || 'Agent', 'sm')}<b class="ell">${esc(q.agent || 'Agent')} 想问你</b><span class="pill violet">等你回答</span></div>
      ${q.until ? `<p class="muted" style="margin-top:2px">${Math.max(1, Math.round((q.until - Date.now()) / 60000))} 分钟内不回答，它会按「没有回答」停下</p>` : ''}
      <p class="q">${esc(q.question || '')}</p>
      <div class="inline" style="margin-top:10px"><input class="field" placeholder="输入你的回答" aria-label="回答 ${esc(q.agent || 'Agent')} 的问题"><button class="btn pri">回答</button></div>
    </div>`);
    const inp = card.querySelector('input');
    const go = () => send({ type: 'foxpaw.answerAsk', id: q.id, answer: inp.value }).catch(() => {});
    card.querySelector('button').onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    box.append(card);
  }
}

function renderLockBanners() {
  const locks = Array.isArray(D.ui.humanLocks) ? D.ui.humanLocks : [];
  if (!changed('locks', locks.map((l) => [l.tabId, l.agent]))) return;
  const box = $('lockBanners');
  box.innerHTML = '';
  for (const l of locks) {
    const tab = D.tabs.find((t) => t.id === l.tabId);
    const title = (tab && tab.title) || '这个标签';
    const b = el(`<div class="lockbanner">
      <b title="${esc(title)}">你正在用『${esc(title)}』</b>
      <p>${esc(l.agent || 'Agent')} 已让开，在旁边排队等。用完点「还给它」，它会从刚才那一步接着跑。</p>
      <div class="btnrow"><button class="btn blue" data-a="release">还给它</button><button class="btn" data-a="stop">让它停下</button></div>
    </div>`);
    b.querySelector('[data-a=release]').onclick = () => send({ type: 'foxpaw.releaseTab', tabId: l.tabId }).catch(() => {});
    b.querySelector('[data-a=stop]').onclick = () => {
      if (l.agentId || l.agent) localPaused.add(l.agentId || l.agent);
      send({ type: 'foxpaw.agentPause', agentId: l.agentId || undefined, agent: l.agent, paused: true }).catch(() => {});
      render();
    };
    box.append(b);
  }
}

/* ---------- 需要你处理 · 要动手 (needs / an agent recording waiting for a login) ---------- */
function renderNeeds(list) {
  const items = [];
  for (const a of list) for (const n of agentNeeds(a)) items.push({ a, n });
  if (!changed('needs', [items.map(({ a, n }) => [a.label, n.id, n.reason, n.tabId, n.tabTitle, n.since]), Math.floor(Date.now() / 60000)])) return;
  const zone = $('needZone');
  zone.innerHTML = '';
  for (const { a, n } of items) {
    const tt = n.tabTitle || tabTitleOf(n.tabId);
    const card = el(`<div class="card needc need" data-need="${esc(n.id)}">
      <div class="k">需要你处理 · ${esc(when(n.since) || '刚刚')}</div>
      <h3>${esc(a.label)}：${esc(n.reason || '需要你处理一下')}</h3>
      <p>处理完点「好了，继续」，${esc(a.label)} 会接着做；等不到回答它会按失败停下。</p>
      ${tt ? `<div class="tabref"><span class="sq sm">${esc(siteLetter({ title: tt }))}</span><span class="ell" title="${esc(tt)}">${esc(tt)}</span></div>` : ''}
      <div class="acts">${n.tabId != null ? '<button class="btn pri" data-a="go">去处理</button>' : ''}<button class="btn${n.tabId != null ? '' : ' pri'}" data-a="continue">好了，继续</button><button class="btn stopx" data-a="stop">让它停下</button></div>
      ${n.tabId != null ? '<div class="subacts"><button class="takebtn quiet" data-a="yield">我要自己用这个标签 ›</button></div>' : ''}
    </div>`);
    const go = card.querySelector('[data-a=go]');
    if (go) go.onclick = () => activateTab(n.tabId);
    const done = (btn, text) => { btn.disabled = true; btn.textContent = text; };
    card.querySelector('[data-a=continue]').onclick = async (e) => {
      const r = await send({ type: 'foxpaw.needResolve', id: n.id, action: 'continue' }).catch((er) => ({ ok: false, error: er.message }));
      if (r && r.ok) done(e.target, '已告诉它'); else showToast('没送到：' + ((r && r.error) || '还没连上'));
    };
    card.querySelector('[data-a=stop]').onclick = async () => {
      if (!confirm(`让「${a.label}」放弃这件事？它会收到「停下」，不再等你。`)) return;
      const r = await send({ type: 'foxpaw.needResolve', id: n.id, action: 'stop' }).catch((er) => ({ ok: false, error: er.message }));
      if (!(r && r.ok)) showToast('没送到：' + ((r && r.error) || '还没连上'));
    };
    const yb = card.querySelector('[data-a=yield]');
    if (yb) yb.onclick = async () => {
      await send({ type: 'foxpaw.needResolve', id: n.id, action: 'yield' }).catch(() => {});
      if (n.tabId != null) await send({ type: 'foxpaw.holdTab', tabId: n.tabId, agent: a.label, agentId: a.id }).catch(() => {});
    };
    zone.append(card);
  }
}
function renderRecPause() {
  const r = agentRec();
  const p = r && r.paused === 'login' ? r : null;
  if (!changed('recpause', p ? [p.agentLabel, p.pauseHost, p.pauseTab, p.live, Math.floor(Date.now() / 60000)] : null)) return;
  const box = $('recPause');
  box.innerHTML = '';
  if (!p) return;
  const who = p.agentLabel || 'Agent';
  const card = el(`<div class="card needc" id="recPauseCard">
    <div class="k">需要你处理 · ${esc(when(p.pausedAt) || '刚刚')}</div>
    <h3>${esc(who)} 录到登录页，需要你登录${esc(p.pauseHost ? ' ' + p.pauseHost : '')}</h3>
    <p>登录不会被录进流程。登好后点「好了，继续」，${esc(who)} 接着录第 ${(p.live || 0) + 1} 步。</p>
    <div class="acts">${p.pauseTab != null ? '<button class="btn pri" data-a="go">去处理</button>' : ''}<button class="btn${p.pauseTab != null ? '' : ' pri'}" data-a="cont">好了，继续</button><button class="btn stopx" data-a="stop">让它停下</button></div>
  </div>`);
  const go = card.querySelector('[data-a=go]');
  if (go) go.onclick = () => activateTab(p.pauseTab);
  card.querySelector('[data-a=cont]').onclick = () => send({ type: 'foxpaw.rec.loginDone' }).catch(() => {});
  card.querySelector('[data-a=stop]').onclick = () => { if (confirm(`让 ${who} 停止这次录制？已录的步骤不会生成草稿。`)) send({ type: 'foxpaw.rec.cancelAgent' }).catch(() => {}); };
  box.append(card);
}

/* ---------- 1.21 运行卡 —— 运行中（进度条 + 正在做哪一步）/ 暂停等处理（原因 + 继续 / 重试 / 跳过 / 终止） ----------
   Data = the relay's run.list for this browser (one state machine with the console); buttons go back to the relay. */
const RUN_ACT_CN = { continue: '我来做完这一步，然后继续', retry: '重试', skip: '跳过', abort: '终止', input: '交上，继续' };
function runCtl(runId, action, btn, value) {
  if (action === 'abort' && !confirm('终止这次运行？已完成的步骤不会撤回。')) return;
  if (action === 'input' && !String(value || '').trim()) { showToast('先填上要交的值'); return; }
  if (btn) btn.disabled = true;
  send({ type: 'foxpaw.run.control', runId, action, ...(action === 'input' ? { value: String(value).trim() } : {}) }).then((r) => { if (!r || !r.ok) { showToast('没处理成：' + ((r && r.error) || '还没连上')); if (btn) btn.disabled = false; } })
    .catch((e) => { showToast('没处理成：' + e.message); if (btn) btn.disabled = false; });
}
function renderRuns() {
  const runs = (Array.isArray(D.ui.runs) ? D.ui.runs : []).filter((x) => x && (x.status === 'running' || x.status === 'paused'));
  if (!changed('runs', [runs, conn.state])) return;
  const box = $('runZone');
  box.innerHTML = '';
  for (const r of runs.slice(0, 4)) {
    const of = r.of || 0, done = Math.min(r.done || 0, of);
    const pct = of ? Math.round((done / of) * 100) : 0;
    const apct = of && r.status === 'paused' ? Math.round(100 / of) : 0;
    const bar = `<div class="prog"><div class="bar"><i style="width:${pct}%"></i>${apct ? `<i class="a" style="width:${apct}%"></i>` : ''}</div><span>${r.status === 'paused' ? r.cur : Math.max(done, (r.cur || 1) - 1)} / ${of} 步</span></div>`;
    if (r.status === 'running') {
      box.append(el(`<div class="card runc" data-run="${esc(r.id)}"><div class="rh"><span class="rdot" aria-hidden="true"></span><b>${esc(r.name || '流程')}</b><span class="pill green">运行中</span></div>
        ${bar}<div class="rl">${`正在：${esc(r.label || '准备中')}`}${r.task ? ' · ' + esc(r.task) : ''}${r.by ? ' · ' + esc(r.by) : ''}</div></div>`));
      continue;
    }
    const p = r.pause || {};
    const user = p.kind === 'user_step';
    const inp = p.kind === 'input' ? (p.input || {}) : null; // 1.28 运行中等外部输入（验证码等）
    const acts = !r.live ? ['abort'] : inp ? ['input', 'skip', 'abort'] : ['continue', 'retry', 'skip', 'abort'];
    const card = el(`<div class="card needc runp" data-run="${esc(r.id)}">
      <div class="k">需要你处理 · 暂停</div>
      <h3>${esc(r.name || '流程')} 卡在第 ${esc(r.cur || p.at || '?')} 步</h3>
      <p>${esc(p.label && p.label !== p.reason ? p.label + '：' : '')}${esc(p.reason || '这一步没做成')}${user ? '' : '。标签保持原样，你可以去页面上看看。'}</p>
      ${bar}
      ${inp ? `<div class="rinp"><input class="field" data-in="1" maxlength="500" autocomplete="off" placeholder="${esc(inp.prompt || '要交的值')}" aria-label="${esc(inp.prompt || '外部输入')}"></div>` : ''}
      ${p.recorder && p.recorder.label ? `<p class="muted">流程由 ${esc(p.recorder.label)} 录制</p>` : ''}
      <div class="acts">${acts.map((a) => `<button class="btn${a === 'continue' || a === 'input' ? ' pri' : a === 'abort' ? ' stopx' : ''}" data-a="${a}">${a === 'continue' && user ? '我做完了，继续' : RUN_ACT_CN[a]}</button>`).join('')}</div>
      ${r.live ? '' : '<p>这台浏览器的扩展版本较旧，只能终止。</p>'}
    </div>`);
    card.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => runCtl(r.id, b.dataset.a, b, b.dataset.a === 'input' ? (card.querySelector('[data-in]') || {}).value : undefined); });
    box.append(card);
  }
}
/* 1.22 ：「有新版 x.y.z · 下载」—— 版本来自中继（握手 auth.ok / /health 的 extLatest = 下载件 manifest 版本） */
function verLt(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0), pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y; }
  return false;
}
// 1.31.0 permissions a version adds (Chrome lists them on the extension page; unpacked installs get no prompt
// and an overwrite update is never disabled for them). Shown in the 「有新版」 bar when the upgrade crosses that version,
// and once after the update itself (bg stores foxpawUpdNote on onInstalled reason=update).
const PERM_NOTES = [['1.31.0', '新增权限：观察网络请求（只读，用于判断页面加载完成）']];
function permNotesBetween(from, to) { return PERM_NOTES.filter(([v]) => verLt(from, v) && !verLt(to, v)).map(([, t]) => t); }
function renderUpdDone() {
  const n = D.updNote, box = $('updDone');
  if (!box) return;
  const show = !!(n && n.version && n.text);
  box.classList.toggle('hidden', !show);
  if (!show) return;
  $('updDoneT').textContent = `已更新到 ${n.version}`;
  $('updDoneP').textContent = n.text;
  $('updDoneX').onclick = () => { D.updNote = null; chrome.storage.local.remove('foxpawUpdNote').catch(() => {}); renderUpdDone(); };
}
// 1.31.1 once, after the background moved this browser's pairing to the new address (× = never again)
function renderDomNote() {
  const n = D.domNote, box = $('domNote');
  if (!box) return;
  const show = !!(n && n.host);
  box.classList.toggle('hidden', !show);
  if (!show) return;
  $('domNoteT').textContent = `已切到新地址 ${n.host}`;
  $('domNoteX').onclick = () => { D.domNote = null; chrome.storage.local.remove('foxpawDomainNote').catch(() => {}); renderDomNote(); };
}
// 1.33.0 (relay 3.8.7): least privilege, said once when a new agent first shows up on this browser (× = seen)
const PRIVACY_LINE = '它默认看不到任何页面，只能看你逐个授权的标签，随时可以收回；付款每次都要你批准；密码、验证码等默认由你来，除非你主动信任某个 Agent；每一步都有记录可查。';
function renderPrivNote() {
  const box = $('privNote');
  if (!box) return;
  const ros = Array.isArray(D.ui.roster) ? D.ui.roster.filter((a) => a && a.id) : null;
  if (!paired() || conn.state !== 'online' || !ros) { box.classList.add('hidden'); return; }
  const ids = ros.map((a) => a.id);
  if (!Array.isArray(D.agSeen)) {   // first look after install / upgrade: whoever is here already is known
    D.agSeen = ids;
    chrome.storage.local.set({ foxpawAgentsSeen: ids }).catch(() => {});
  }
  const fresh = ros.filter((a) => !D.agSeen.includes(a.id));
  box.classList.toggle('hidden', !fresh.length);
  if (!fresh.length) return;
  $('privNoteT').textContent = fresh.length > 1 ? `${fresh.length} 个新 Agent 已接入：${fresh.map((a) => a.label).join('、')}` : `新 Agent「${fresh[0].label}」已接入`;
  $('privNoteP').textContent = PRIVACY_LINE;
  $('privNoteX').onclick = () => { D.agSeen = [...new Set([...D.agSeen, ...ids])]; chrome.storage.local.set({ foxpawAgentsSeen: D.agSeen }).catch(() => {}); renderPrivNote(); };
}
function renderUpdBar() {
  renderUpdDone();
  renderDomNote();
  renderPrivNote();
  const latest = String(conn.extLatest || ''), cur = String(conn.version || '');
  const show = !!(latest && cur && /^\d+(\.\d+){0,3}$/.test(latest) && verLt(cur, latest) && D.updDismissed !== latest);
  $('updBar').classList.toggle('hidden', !show);
  if (!show) return;
  $('updText').textContent = `有新版 ${latest}`;
  const perms = permNotesBetween(cur, latest);
  $('updPerm').textContent = perms.join('；');
  $('updPerm').classList.toggle('hidden', !perms.length);
  const url = siteBase() + '/download/extension';
  $('updDl').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url }); };
  $('updX').onclick = () => { D.updDismissed = latest; chrome.storage.local.set({ foxpawUpdDismissed: latest }).catch(() => {}); renderUpdBar(); };
}

/* 1.24 ：「检查更新」—— 立刻向中继要最新版本（后台复用 /health 的 extLatest，不加接口）。
   manual=false：侧栏每次打开静默查一次，结果只经 conn 推送更新小条（尊重「关过」）；
   manual=true：有新版 → 清掉关过的记录、回到正面显示小条；已是最新 → 短暂提示；取不到 → 提示稍后再试。 */
let updChecking = false;
async function checkUpdate(manual) {
  if (updChecking) return;
  updChecking = true;
  const b = $('meChk');
  if (manual && b) { b.disabled = true; b.textContent = '检查中…'; }
  if (manual) { islDetKey = ''; renderIsland(roster()); }
  let r = null;
  try { r = await send({ type: 'foxpaw.checkUpdate', silent: !manual }); } catch { r = null; }
  updChecking = false;
  if (b) { b.disabled = false; b.textContent = '检查更新'; }
  if (manual) { islDetKey = ''; renderIsland(roster()); }
  if (!manual) return;
  const cur = String((r && r.current) || conn.version || chrome.runtime.getManifest?.().version || '');
  if (!r || !r.ok) { showToast('暂时查不到，稍后再试', 2600); return; }
  if (cur && verLt(cur, r.latest)) {
    conn = { ...conn, extLatest: r.latest };
    D.updDismissed = ''; chrome.storage.local.remove('foxpawUpdDismissed').catch(() => {});
    if ($('flip').classList.contains('flipped')) flip(false);
    renderUpdBar();
    return;
  }
  // 1.26 apply the answer here too, so the bar hides in the same tick the toast shows
  // (the bg's conn push only reaches render() after a 16 ms debounce — the toast used to win that race)
  conn = { ...conn, extLatest: r.latest };
  renderUpdBar();
  showToast(`已是最新 ${cur}`, 2600);
}
$('meChk').onclick = (e) => { e.stopPropagation(); checkUpdate(true); };
// 1.34 中 / EN：语言跟浏览器界面走，「我 → 语言」手动切换并记住（localStorage + storage.uiLang，后台通知也跟着）
{
  const L = window.fpI18n;
  const seg = $('langSeg');
  if (L && seg) {
    seg.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.v === L.lang); b.onclick = () => { if (b.dataset.v === L.lang) return; L.set(b.dataset.v); location.reload(); }; });
    try { chrome.storage.local.set({ uiLang: L.lang }); } catch { /* noop */ }
  } else if ($('langRow')) $('langRow').classList.add('hidden');
}

/* 1.21 ：录制中打开了别的网站的新标签 → 「把这个标签加入录制？」 */
function renderAskBar() {
  const r = D.rec;
  const a = r && r.active && Array.isArray(r.ask) && r.ask.length ? r.ask[r.ask.length - 1] : null;
  $('askBar').classList.toggle('hidden', !a);
  if (!a || !changed('ask', a)) return;
  const site = (r.session || []).map((x) => hostOf('https://' + x.url)).find(Boolean) || '';
  $('askText').textContent = `你新开了 ${a.host || a.url}${site ? `（不是 ${site}，也不是从录制标签打开的）` : ''}`;
  $('askYes').onclick = () => send({ type: 'foxpaw.rec.join', tabId: a.tabId, join: true }).then((x) => { if (!x || !x.ok) showToast('没加上：' + ((x && x.error) || '')); }).catch(() => {});
  $('askNo').onclick = () => send({ type: 'foxpaw.rec.join', tabId: a.tabId, join: false }).catch(() => {});
}
const SESS_WHY = { start: ['起点', ''], group: ['组内标签', ''], opener: ['从录制标签打开 · 自动加入', 'g'], site: ['同主域 · 自动加入', 'g'], asked: ['你选择加入', 'g'], chat: ['与 Agent 对话 · 不录', ''] };

/* ---------- 待你审阅: drafts an agent made; only the owner accepts / rejects / asks for a re-record ---------- */
function renderDrafts() {
  const ds = (Array.isArray(D.ui.drafts) ? D.ui.drafts : []).filter((d) => d.source === 'agent_record' || d.source === 'agent_run');
  if (!changed('drafts', [ds.map((d) => [d.id, d.name, d.steps]), Math.floor(Date.now() / 60000)])) return;
  const box = $('drafts');
  box.innerHTML = '';
  for (const d of ds.slice(0, 3)) {
    const who = d.agentLabel || 'Agent';
    const meta = [`${d.steps || 0} 步`, d.vars && d.vars.length ? `填写项：${d.vars.join('、')}` : '无需填写', when(d.created)].filter(Boolean).join(' · ');
    const card = el(`<div class="card needc review" data-draft="${esc(d.id)}">
      <div class="k">待你审阅 · ${d.source === 'agent_run' ? 'Agent 整理' : 'Agent 录制'}</div>
      <h3>${d.source === 'agent_run' ? `${esc(who)} 整理了流程「${esc(d.goal || d.name)}」` : `${esc(who)} 录制了流程「${esc(d.name)}」`}</h3>
      <p>${esc(meta)}</p>
      <div class="acts"><button class="btn pri" data-a="accept" style="flex:none;padding:0 18px">收下</button><button class="btn" data-a="look">查看步骤</button>
        <button class="btn ghost" data-a="${d.source === 'agent_run' ? 'reject' : 'rerecord'}">${d.source === 'agent_run' ? '驳回' : '重录'}</button></div>
    </div>`);
    card.querySelector('[data-a=accept]').onclick = (e) => { e.target.disabled = true; send({ type: 'foxpaw.draft.decide', id: d.id, action: 'accept' }).then((r) => { if (!(r && r.ok)) showToast('没送到：' + ((r && r.error) || '还没连上')); }).catch(() => {}); };
    card.querySelector('[data-a=look]').onclick = () => openConsole('flow/' + encodeURIComponent(d.id));
    const rj = card.querySelector('[data-a=reject],[data-a=rerecord]');
    rj.onclick = () => { if (confirm(rj.dataset.a === 'reject' ? `驳回「${d.name}」？它不会生效。` : `让 ${who} 重录「${d.name}」？这份草稿作废。`)) send({ type: 'foxpaw.draft.decide', id: d.id, action: rj.dataset.a }).catch(() => {}); };
    box.append(card);
  }
  if (ds.length) box.append(el('<p class="dnote">草稿收下后才会生效；Agent 不能改已生效的流程。</p>'));
}

// 1.25 a small 「已信任」 tag on a trusted agent's row (全部网站 / N 站); 「⋯ → 撤销信任」 revokes it
function trustTag(a) {
  const t = a && a.trust;
  if (!t || (t.mode !== 'all' && t.mode !== 'sites')) return '';
  const sites = Array.isArray(t.sites) ? t.sites : [];
  const txt = t.mode === 'all' ? '已信任·全部' : `已信任·${sites.length === 1 ? sites[0] : sites.length + '站'}`;
  const tip = t.mode === 'all' ? '信任全部网站：填写 / 提交 / 删除 / 运行脚本不再逐次问你；付款每次都要你批准，本机文件仍交你' : `信任这些网站（含子域）：${sites.join('、')}`;
  return `<span class="trusttag" title="${esc(tip)}">${esc(txt)}</span>`;
}

// 1.27: an agent's own permission — the relay roster's access (3.6.1+), a just-clicked value until the
// relay's push confirms it; '' = unknown (older relay: the chip is hidden, the menu says to use the console)
const PERM_TEXT = { off: '停用', read: '只看', write: '可操作' };
const permPending = new Map(); // agentId -> access clicked in the menu, until the roster says so
function agentAccess(a) {
  const p = a && permPending.get(a.id);
  if (p && a.access === p) permPending.delete(a.id);
  else if (p) return p;
  return a && PERM_TEXT[a.access] ? a.access : '';
}
function panelErr(code) {
  // 1.28.1 RELAY_OLD only when the relay's /health version really is older than 3.6.1; otherwise STUCK
  return { OFFLINE: '还没连上中继', RELAY_OLD: '中继还没升级到 3.6.1，先在控制台改', STUCK: '和中继的通信卡住了，正在重连，稍后再点一次', NOT_FOUND: '找不到这个 Agent', LABEL_TAKEN: '已经有同名的 Agent 了，换个名字', EMPTY_LABEL: '名字不能为空', TOO_LARGE: '图片太大了：不超过 256 KB', BAD_TYPE: '只支持 PNG / JPG / WebP 图片', BAD_IMAGE: '这不是有效的图片', NEED_128: '图片需要是 128 px 方图',
    NO_AUTH_TAB: '先打开一个授权标签', CONFIRM_REQUIRED: '需要确认', BAD_SITE: '这个网址不能信任' }[code] || code || '未知原因';
}
const PANEL_MULTI = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'com.hk', 'com.tw', 'co.uk', 'org.uk',
  'ac.uk', 'co.jp', 'ne.jp', 'or.jp', 'com.au', 'net.au', 'co.kr', 'com.sg', 'com.br', 'co.nz', 'co.in']); // = relay _MULTI_SUFFIX
function mainSite(url) {
  let h = ''; try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return ''; h = u.hostname.toLowerCase(); } catch { return ''; }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h === 'localhost') return h;
  const p = h.split('.').filter(Boolean);
  if (p.length < 2) return '';
  return p.slice(-(PANEL_MULTI.has(p.slice(-2).join('.')) && p.length >= 3 ? 3 : 2)).join('.');
}
// 「信任当前网站」 = the active authorized tab, else the most recently used one (the background re-checks it)
function curAuthSite() {
  const mine = myTabs().filter((t) => mainSite(t.url || ''));
  const t = mine.find((x) => x.active) || mine.slice().sort((x, y) => (y.lastAccessed || 0) - (x.lastAccessed || 0))[0];
  return t ? { tabId: t.id, site: mainSite(t.url) } : null;
}

function agentCard(a, tasks, access, presMap) {
  const st = a.state;
  const color = colorOf[a.label];
  // one status badge per card; the subline carries facts only —
  // which tab / how long ago it came / when it will come next.
  let line;
  if (st === 'working') {
    const tl = Array.isArray(a.tabList) ? a.tabList : [];
    const ctl = tl.filter((t) => t.via !== 'touch');
    if (ctl.length) {
      const t0 = ctl[0] && ctl[0].title ? `「${ctl[0].title}」` : `${ctl.length} 个标签`;
      line = `正在操作 ${t0}${tl.length > 1 ? ` 等 ${tl.length} 个` : ''}`;
    } else if (tl.length) {
      const t0 = tl[0] && tl[0].title ? `「${tl[0].title}」` : `${tl.length} 个标签`;
      line = `${touchText(tl[0])}${t0}${tl.length > 1 ? ` 等 ${tl.length} 个` : ''}`;
    } else if (a.tabs) line = `正在操作 ${a.tabs} 个标签`;
    else line = '最近在活动，没有具体到某个标签';
  } else if (st === 'recent') line = a.elsewhere ? `在「${a.elsewhere}」上工作中` : (agoCame(a.lastSeenTs) || '刚刚来过');
  else line = (a.nextRun && nextRunText(a.nextRun)) || agoCame(a.lastSeenTs) || agoCame(a.lastSeen) || '很久没来过';
  // 1.24: compact row — tinted avatar · name + semantic dot + state word · fact line · capability chip · ⋯
  const needN = agentNeeds(a).length;
  const stw = needN ? ['need', '等你'] : st === 'working' ? ['work', '在干'] : st === 'recent' ? ['recent', '刚来过'] : ['rest', '休息'];
  const mineTasks = tasks.filter((t) => (t.executor || '') === a.label).slice(0, 3);
  const paused = isPaused(a.label, a.id);
  // 1.27: the chip is THIS agent's own permission (relay roster access = console 「权限」); click = the menu
  const acc = agentAccess(a);
  const cap = paused ? `<button class="cap amber" type="button" aria-haspopup="menu" title="这台设备拒绝它的所有操作，点一下可以恢复或改权限">本机已暂停</button>`
    : acc ? `<button class="cap ${acc === 'write' ? 'acc' : acc === 'read' ? 'blue' : ''}" type="button" aria-haspopup="menu" title="${esc(a.label)} 的权限：${ACCESS_TEXT[acc]}${a.accessNow && a.accessNow !== acc ? `（临时提权中：${ACCESS_TEXT[a.accessNow]}）` : ''} · 点一下改权限 / 信任">${esc(PERM_TEXT[acc])}</button>` : '';
  const card = el(`<div class="agent agrow ${st}${openAgents.has(a.label) ? ' open' : ''}">
    <div class="ahead"><span class="av agav" style="--c:${color}">${avInner(a.label)}</span>
      <div class="main">
        <div class="r1"><b title="${esc(a.label)}">${esc(a.label)}</b><span class="sw ${stw[0]}"><i class="sd" aria-hidden="true"></i>${stw[1]}</span>${trustTag(a)}</div>
        <div class="r2">${esc(line)}</div>
      </div>
      ${cap}
      <button class="morebtn" aria-label="${esc(a.label)} 的更多操作" title="更多" aria-haspopup="menu">⋯</button>
    </div>
  </div>`);
  const ahead = card.querySelector('.ahead');
  ahead.tabIndex = 0;
  ahead.setAttribute('role', 'button');
  ahead.setAttribute('aria-expanded', String(openAgents.has(a.label)));
  ahead.setAttribute('aria-label', `${a.label}：${line}（展开它在用的标签）`);
  ahead.onclick = (e) => {
    if (e.target.closest('button')) return;
    openAgents.has(a.label) ? openAgents.delete(a.label) : openAgents.add(a.label);
    render();
  };
  ahead.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === ahead) { e.preventDefault(); ahead.click(); } };
  const toggleMenu = (e) => {
    e.stopPropagation();
    menuFor = menuFor === a.label ? null : a.label;
    render();
  };
  card.querySelector('.morebtn').onclick = toggleMenu;
  const capBtn = card.querySelector('button.cap');
  if (capBtn) capBtn.onclick = toggleMenu;
  if (menuFor === a.label) {
    const paused = isPaused(a.label, a.id);
    // 1.27: 权限 + 信任 right on the row — written to the relay, the same data as the console's Agent page
    const acc = agentAccess(a);
    const tr = a.trust && (a.trust.mode === 'all' || a.trust.mode === 'sites') ? a.trust : null;
    const trSites = tr && tr.mode === 'sites' && Array.isArray(tr.sites) ? tr.sites : [];
    const cur = curAuthSite();
    const tMode = !tr ? 'none' : tr.mode === 'all' ? 'all' : cur && trSites.includes(cur.site) ? 'site' : 'other';
    const radio = (v, on, label, sub, dis) => `<button class="mi" type="button" role="menuitemradio" data-t="${v}" aria-checked="${on}"${dis ? ' disabled' : ''}><i class="rk" aria-hidden="true"></i><span class="ml">${label}</span>${sub ? `<span class="ms">${sub}</span>` : ''}</button>`;
    const m = el(`<div class="adrop agmenu" role="menu" aria-label="${esc(a.label)}">
      <div class="mh">权限</div>
      <div class="seg accseg sm" role="radiogroup" aria-label="${esc(a.label)} 的权限">${['off', 'read', 'write'].map((v) => `<button type="button" role="radio" data-p="${v}" data-v="${v}" aria-checked="${acc === v}" class="${acc === v ? 'on' : ''}"${acc ? '' : ' disabled'}>${PERM_TEXT[v]}</button>`).join('')}</div>
      ${acc ? '' : '<div class="mnote">中继还没升级到 3.6.1，权限先在控制台改</div>'}
      <div class="mh">信任</div>
      ${radio('none', tMode === 'none', '不信任', '每次问我')}
      ${radio('site', tMode === 'site', '信任当前网站', cur ? esc(cur.site) : '先打开一个授权标签', !cur)}
      ${radio('all', tMode === 'all', '信任全部网站', '')}
      ${trSites.length ? `<div class="mnote" title="${esc(trSites.join('、'))}">已信任 ${esc(trSites.length > 3 ? trSites.slice(0, 3).join('、') + ` 等 ${trSites.length} 个` : trSites.join('、'))}</div>` : ''}
      <div class="msep"></div>
      <button data-a="rename"${acc ? '' : ' disabled'}>改名</button>
      <button data-a="avatar"${acc ? '' : ' disabled'}>换头像</button>
      ${a.avatar ? '<button data-a="avreset">恢复默认头像</button>' : ''}
      <button data-a="pause">${paused ? '恢复它' : '暂停它（这台设备）'}</button>
      <button data-a="kick" class="danger">断开</button>
    </div>`);
    m.querySelectorAll('[data-p]').forEach((b) => { b.onclick = async (e) => {
      e.stopPropagation();
      const v = b.dataset.p;
      menuFor = null;
      if (v === acc) { render(); return; }
      permPending.set(a.id, v); render();
      const r = await send({ type: 'foxpaw.agentAccess', agentId: a.id, agent: a.label, access: v }).catch((x) => ({ ok: false, error: String(x.message || x) }));
      if (!(r && r.ok)) { permPending.delete(a.id); render(); showToast('没改成：' + panelErr(r && r.error)); return; }
      showToast(`${a.label} · ${PERM_TEXT[v]}`, 1800);
    }; });
    m.querySelectorAll('[data-t]').forEach((b) => { b.onclick = async (e) => {
      e.stopPropagation();
      const v = b.dataset.t;
      if (v === 'all' && tMode === 'all') { menuFor = null; render(); return; }
      if (v === 'none' && tMode === 'none') { menuFor = null; render(); return; }
      if (v === 'all' && !confirm(`信任「${a.label}」在全部网站免审批？付款每次都要你批准，随时可改回。`)) return;
      menuFor = null; render();
      const r = await send({ type: 'foxpaw.agentTrust', agentId: a.id, agent: a.label, mode: v, confirm: v === 'all', tabId: cur ? cur.tabId : null })
        .catch((x) => ({ ok: false, error: String(x.message || x) }));
      if (!(r && r.ok)) { showToast('没改成：' + panelErr(r && r.error)); return; }
      showToast(v === 'none' ? `${a.label} · 不信任（每次问我）` : v === 'all' ? `${a.label} · 信任全部网站` : `${a.label} · 信任 ${r.site || (cur && cur.site) || '当前网站'}`, 2000);
    }; });
    // 1.31.2: 改名 (= console Agent 详情「名称」) — written to the relay; names are unique per account
    m.querySelector('[data-a=rename]').onclick = async (e) => {
      e.stopPropagation();
      menuFor = null; render();
      const v = (prompt(`给「${a.label}」改个名字（最多 40 个字）`, a.label) || '').trim().slice(0, 40);
      if (!v || v === a.label) return;
      const r = await send({ type: 'foxpaw.agentRename', agentId: a.id, agent: a.label, label: v }).catch((x) => ({ ok: false, error: String(x.message || x) }));
      if (!(r && r.ok)) { showToast('没改成：' + panelErr(r && r.error)); return; }
      showToast(`已改名为「${v}」`, 1800);
    };
    // 1.31.2: 换头像 — PNG / JPG / WebP ≤256 KB, cropped to a centred 128 px square PNG here; the relay re-checks it
    m.querySelector('[data-a=avatar]').onclick = (e) => {
      e.stopPropagation();
      menuFor = null; render();
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) { showToast('只支持 PNG / JPG / WebP 图片'); return; }
        if (f.size > 256 * 1024) { showToast('图片太大了：不超过 256 KB'); return; }
        let image;
        try {
          const bmp = await createImageBitmap(f);
          const side = Math.min(bmp.width, bmp.height);
          const cv = document.createElement('canvas'); cv.width = cv.height = 128;
          cv.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 128, 128);
          image = cv.toDataURL('image/png');
        } catch { showToast('这不是有效的图片'); return; }
        const r = await send({ type: 'foxpaw.agentAvatar', agentId: a.id, agent: a.label, image }).catch((x) => ({ ok: false, error: String(x.message || x) }));
        showToast(r && r.ok ? `${a.label} · 头像已更新` : '没换成：' + panelErr(r && r.error), 1800);
      };
      inp.click();
    };
    const avr = m.querySelector('[data-a=avreset]');
    if (avr) avr.onclick = async (e) => {
      e.stopPropagation();
      menuFor = null; render();
      const r = await send({ type: 'foxpaw.agentAvatar', agentId: a.id, agent: a.label, reset: true }).catch((x) => ({ ok: false, error: String(x.message || x) }));
      showToast(r && r.ok ? `${a.label} · 已恢复默认头像` : '没改成：' + panelErr(r && r.error), 1800);
    };
    m.querySelector('[data-a=pause]').onclick = async () => {
      const next = !isPaused(a.label, a.id);
      const k = a.id || a.label;
      if (next) localPaused.add(k); else localPaused.delete(k);
      menuFor = null;
      await send({ type: 'foxpaw.agentPause', agentId: a.id, agent: a.label, paused: next }).catch(() => {});
      render();
    };
    m.querySelector('[data-a=kick]').onclick = () => {
      menuFor = null;
      // v1.17 (ui-interaction #12): destructive actions say what happens first
      if (!confirm(`让「${a.label}」停下并断开？它马上停手，可以再接回来；要永久移除请到控制台。`)) { render(); return; }
      send({ type: 'foxpaw.kick', agent: a.label, agentId: a.id }).catch(() => {});
      render();
    };
    card.append(m);
  }
  if (openAgents.has(a.label)) {
    const tl = Array.isArray(a.tabList) ? a.tabList : [];
    const f = el('<div class="tabfield"></div>');
    if (mineTasks.length) f.append(el(`<div class="agtasks">流程 · ${mineTasks.map((t) => `<span title="${esc(t.name)}">${esc(t.name)}${t.lastRun && t.lastRun.status === '成功' ? ' ✓' : ''}</span>`).join('、')}</div>`));
    if (!tl.length) f.append(el(`<div class="empty" style="padding:8px">${st === 'working' ? '最近在活动，没有具体到某个标签。' : '它现在没有在用任何标签。'}</div>`));
    for (const t of tl) {
      const controlling = isControlling(t, presMap[a.label]);
      const touch = t.via === 'touch';
      const row = el(`<div class="frow">
        <span class="bar" style="background:${color}"></span>
        <div class="sq">${esc(siteLetter(t))}</div>
        <div class="tx"><span class="t" title="${esc(t.title || t.url || '')}">${esc(t.title || t.url || '')}</span><span class="s"><span class="stx">${esc(t.url ? hostOf(t.url) : (controlling ? '正在操作这一页' : touch ? '最近读过或操作过，没拿写租约' : '已授权，它还没开始用'))}</span>${controlling ? '<button class="holdbtn">我要用这个</button>' : ''}</span></div>
        <span class="pill ${controlling ? 'acc' : ''}">${controlling ? '控制中' : touch ? esc(touchText(t)) : '已授权'}</span>
        <span class="chev">›</span>
      </div>`);
      row.onclick = () => activateTab(t.id);
      const hb = row.querySelector('.holdbtn');
      if (hb) hb.onclick = (e) => { e.stopPropagation(); send({ type: 'foxpaw.holdTab', tabId: t.id, agent: a.label, agentId: a.id }).catch(() => {}); };
      f.append(row);
    }
    card.append(f);
  }
  return card;
}


function renderAgent() {
  renderPending();
  renderAccessNote();
  const list = roster();
  const mine = myTabs();
  const online = conn.state === 'online';
  const onboarding = !paired();
  // 1.20: disconnected ≠ never connected — one 「已断开 · 重新连接」 card instead of the three steps
  const wasOn = onboarding && D.ui.disconnected;
  $('offCard').classList.toggle('hidden', !wasOn);
  if (wasOn) {
    const dc = D.ui.disconnected;
    $('offTitle').textContent = dc.reason === 'switch' ? '正在切换账号' : `已断开${dc.label ? ' · ' + dc.label : ''}`;
    $('offText').textContent = dc.reason === 'switch'
      ? '用新账号在打开的网页上登录并确认，这台浏览器就归到新账号；原账号授权的标签已取消授权，切回原账号时恢复。'
      : '授权的标签和本机录制都保留着；重新连接后接着用，不会新建设备。';
    $('offGo').textContent = dc.reason === 'switch' ? '打开连接页' : '重新连接';
    $('offGo').classList.toggle('hidden', !!loginPolling);
    $('offWait').classList.toggle('hidden', !loginPolling);
  }
  $('firstAgent').classList.toggle('hidden', onboarding || list.length > 0 || !online);
  if (!onboarding && online && !list.length) {
    // 1.20: the three steps keep real progress ticks after connecting (①✓ connected, ② ✓ once a tab is authorized)
    const st = [true, mine.length > 0, false];
    const cur = st.indexOf(false) + 1;
    st.forEach((d, i) => {
      const el = $('fa' + (i + 1));
      el.classList.toggle('done', d); el.classList.toggle('cur', i + 1 === cur);
      el.querySelector('i').textContent = d ? '✓' : String(i + 1);
    });
  }
  $('onboard').classList.toggle('hidden', !onboarding || !!wasOn);
  $('agentZone').classList.toggle('hidden', onboarding);
  if (onboarding) {
    const s1 = paired() && online;
    const s2 = paired() && mine.length > 0;
    const cur = !s1 ? 1 : !s2 ? 2 : 3;
    [1, 2, 3].forEach((i) => {
      const n = $('ob' + i);
      const done = i === 1 ? s1 : i === 2 ? s2 : false;
      n.classList.toggle('done', done);
      n.classList.toggle('cur', i === cur);
      n.querySelector('.n').textContent = done ? '✓' : String(i);
    });
    $('ob1Text').textContent = s1 ? `已连接 · ${D.ui.deviceLabel || '这台浏览器'}`
      : paired() ? (conn.state === 'needs_action' ? '连接已失效，重新连接一次就好。' : '正在连接，稍等一下。') : '打开官网，点一下确认就连上。';
    $('obWait').classList.toggle('hidden', !loginPolling);
    $('obInvite').disabled = !s1;
    return;
  }
  const tasks = D.tasks;
  const access = [...permPending].join(',') + '|' + (menuFor ? JSON.stringify(curAuthSite()) : ''); // 1.27 row menu inputs
  colorOf = {};
  avatarOf = {};
  for (const a of (Array.isArray(D.ui.roster) ? D.ui.roster : [])) if (a && a.avatar) avatarOf[a.label] = String(a.avatar);
  const rawLabels = (Array.isArray(D.ui.roster) && D.ui.roster.length) ? D.ui.roster.map((a) => a.label) : list.map((a) => a.label);
  rawLabels.forEach((lab, i) => { if (!(lab in colorOf)) colorOf[lab] = AGENT_COLORS[i % AGENT_COLORS.length]; });
  for (const a of list) if (!(a.label in colorOf)) colorOf[a.label] = AGENT_COLORS[Object.keys(colorOf).length % AGENT_COLORS.length];
  const presMap = {};
  for (const p of (D.ui.presence || [])) presMap[p.label] = new Set((p.tabList || []).map((t) => t.id));
  renderLockBanners();
  renderRecPause();
  renderRuns();
  renderNeeds(list);
  renderDrafts();
  // 1.24: the Agent list comes first (every agent, compact rows); 「收起」 folds it to ONE summary row
  $('agSec').classList.toggle('hidden', !online && !list.length);
  $('agCount').textContent = list.length;
  $('agFold').classList.toggle('hidden', !list.length);
  $('agFold').textContent = agFold ? '展开' : '收起';
  $('agFold').setAttribute('aria-expanded', String(!agFold));
  if (changed('agents', [list, online, tasks.map((t) => [t.id, t.name, t.executor]), access, Math.floor(Date.now() / 60000), [...openAgents].sort(), agFold, menuFor, [...localPaused].sort(), D.cfg.agentPause || {}, colorOf])) {
    const box = $('agents');
    box.innerHTML = '';
    if (list.length && agFold) {
      const stack = list.slice(0, 4).map((a) => `<span class="av agav" style="--c:${colorOf[a.label]}">${avInner(a.label)}</span>`).join('');
      const fr = el(`<button class="list agfold" id="agFoldRow" aria-label="展开 Agent 列表"><span class="stack">${stack}</span><span class="tx"><b>${esc(agentSummary(list).head)}</b><span>${esc(list.map((a) => a.label).join('、'))}</span></span><span class="go">展开</span></button>`);
      fr.onclick = () => setAgFold(false);
      box.append(fr);
    } else if (list.length) {
      const l = el('<div class="list aglist"></div>');
      for (const a of list) l.append(agentCard(a, tasks, access, presMap));
      box.append(l);
    }
  }
  // authorized tabs, each with who is on it: X 在用 / X 等你 / X 录制中 / 刚看过 / 空闲 / 你在用
  const users = {};
  const touched = {};
  for (const a of list) for (const t of (a.tabList || [])) { if (t.via === 'touch') { if (!(t.id in touched)) touched[t.id] = [a.label, t]; } else users[t.id] = a.label; }
  const waiting = {};
  for (const a of list) for (const n of agentNeeds(a)) if (n.tabId != null) waiting[n.tabId] = a.label;
  for (const p of (D.ui.pendingConfirms || [])) if (p.tabId != null && !(p.tabId in waiting)) waiting[p.tabId] = p.agent || 'Agent';
  const ar = agentRec();
  const recTab = ar ? (ar.paused === 'login' && ar.pauseTab != null ? ar.pauseTab : null) : null;
  $('tabCount').textContent = mine.length;
  const nForeign = Number(D.ui.foreignGroups) || 0;
  const fh = $('foreignHint');
  if (fh) { fh.classList.toggle('hidden', !nForeign); fh.textContent = nForeign ? `另有 ${nForeign} 个 FoxPaw 组不是这台浏览器建的（多半是 Chrome 同步过来的），里面的标签 Agent 碰不到。不想看到它可在 Chrome 设置 → 同步 里关掉「已保存的标签组」。` : ''; }
  const lockedTabs = new Set((Array.isArray(D.ui.humanLocks) ? D.ui.humanLocks : []).map((l) => l.tabId));
  if (changed('tabs', [mine.map((t) => [t.id, t.title, t.url]), users, waiting, Object.keys(touched), [...lockedTabs], ar && [ar.agentLabel, ar.paused, recTab, D.ui.recLock]])) {
    const box = $('tabList');
    box.innerHTML = '';
    if (!mine.length) box.append(el('<div class="empty ei-wrap"><span class="ei" aria-hidden="true"><svg><use href="#i-tabs"/></svg></span><b>还没有授权的标签</b><span>点「＋ 当前页」，或把标签拖进 FoxPaw 组；Agent 只能碰这里列出的标签。</span></div>'));
    for (const t of mine) {
      const h = hostOf(t.url || '');
      const held = lockedTabs.has(t.id);
      const title = t.title || t.url || '';
      const u = users[t.id];
      const recHere = ar && (recTab === t.id || (!recTab && u === ar.agentLabel));
      const status = held ? '<span class="pill amber">你在用</span>'
        : waiting[t.id] ? `<span class="pill tabpill wait">${esc(waiting[t.id])} 等你</span>`
        : recHere ? `<span class="pill tabpill rec">${esc(ar.agentLabel || 'Agent')} 录制中</span>`
        : u ? `<span class="pill tabpill use">${esc(u)} 在用</span>`
        : touched[t.id] ? `<span class="pill" title="${esc(touched[t.id][0])} ${esc(touchText(touched[t.id][1]))}">${esc(touchText(touched[t.id][1]))}</span>` : '<span class="pill">空闲</span>';
      const row = el(`<div class="row${held ? ' held' : ''}"><button class="rowmain" title="${esc(title)}" aria-label="切到标签：${esc(title)}"><div class="sq" aria-hidden="true">${esc(siteLetter(t))}</div>
        <div class="tx"><span class="t">${esc(title)}</span><span class="s">${esc(h)}</span></div></button>
        ${status}
        <button class="x" title="取消授权" aria-label="取消授权：${esc(title)}">✕</button></div>`);
      row.querySelector('.rowmain').onclick = () => activateTab(t.id);
      row.querySelector('.x').onclick = async () => { try { await chrome.tabs.ungroup(t.id); } catch { /* gone */ } reload(); };
      box.append(row);
    }
  }
  const curIn = inMine(D.cur);
  $('btnAssign').classList.toggle('hidden', !!curIn || !D.cur);
}

/* ---------- 灵动岛 (1.23, ): header + connection strip + status card in ONE island ---------- */
// Always shown. Priority: boot (not loaded yet — never flash 未连接 before the real state) > not paired >
// offline > waiting for you (approval / need / user step / login / question) > the owner recording >
// an agent recording > no agents > master switch off > running > paused > idle.
// Line 1 = who · what (14px); line 2 = dot + state word + device / extra (12px). A button only when you must act.
let islandKey = '';
let islDetKey = '';
let islOpen = false;
let loaded = false;
let connKnown = false;
setTimeout(() => { if (!connKnown) { connKnown = true; schedule(); } }, 1500); // no status answer → stop waiting
function liveWorking(list) {
  // 1.23: an agent controlling a tab THIS browser has leads (its title can be shown and 看标签 works)
  const tabRank = (a) => { const tl = Array.isArray(a.tabList) ? a.tabList : []; const known = (t) => t.id != null && D.tabs.some((x) => x.id === t.id);
    return tl.some((t) => t.via !== 'touch' && known(t)) ? 3 : tl.some((t) => t.via !== 'touch') ? 2 : tl.length ? 1 : 0; };
  return list.filter((a) => a.state === 'working' && !isPaused(a.label, a.id)).sort((x, y) => tabRank(y) - tabRank(x));
}
function windowsFor(label, id) {
  const now = Date.now();
  return (Array.isArray(D.ui.windows) ? D.ui.windows : []).filter((w) => w.until > now && (w.agentId === id || w.agentLabel === label));
}
function liveWindows() { const now = Date.now(); return (Array.isArray(D.ui.windows) ? D.ui.windows : []).filter((w) => w.until > now); }
function mmss(ms) { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; }
function devName() { return D.ui.deviceLabel || '这台浏览器'; }
// the tab an agent is on: a controlled tab this browser knows first
function agentTab(a) {
  const tl = Array.isArray(a.tabList) ? a.tabList : [];
  const known = (t) => t.id != null && D.tabs.some((x) => x.id === t.id);
  const t0 = tl.find((t) => t.via !== 'touch' && known(t)) || tl.find((t) => t.via !== 'touch') || tl.find(known) || tl[0] || null;
  const title = t0 && ((D.tabs.find((x) => x.id === t0.id) || {}).title || t0.title);
  return { t0, title, known: !!(t0 && known(t0)) };
}
function islandModel(list) {
  const dev = devName();
  if (!loaded || (paired() && !connKnown)) return { s: 'boot', c: 'off', l1: '', st: '', sub: '' };
  if (!paired()) {
    if (loginPolling) return { s: 'offline', c: 'retrying', l1: '<b>正在连接</b> · 等你在网页上确认', st: '等你确认', sub: '确认后这里会自动接上' };
    const dc = D.ui.disconnected;
    if (dc) return { s: 'offline', c: 'off', l1: dc.reason === 'switch' ? '<b>正在切换账号</b>' : `<b>已断开</b>${dc.label ? ' · ' + esc(dc.label) : ''}`, st: '未连接', sub: '可以随时重新连接' };
    return { s: 'offline', c: 'off', l1: '<b>这台浏览器还没连上</b>', st: '未连接', sub: '连上后 Agent 才能用', act: { text: '连接', pri: true, run: startLogin } };
  }
  const s = conn.state;
  if (s !== 'online') {
    const title = connLine(conn, D.ui.deviceLabel);
    if (s === 'retrying' || s === 'connecting') {
      const sec = Math.max(0, Math.ceil(((conn.nextRetryAt || 0) - Date.now()) / 1000));
      // 1.28.1 no 「第 N 次」 counter; offline = waits for the network instead of counting down
      const netOff = s === 'retrying' && conn.reason === 'net_offline' && !conn.nextRetryAt;
      const sub = s === 'connecting' ? dev : netOff ? '电脑没联网，联网后自动重连' : sec > 60 ? `约 ${Math.ceil(sec / 60)} 分钟后自动重试` : sec > 0 ? `${sec} 秒后自动重试` : '正在重试…';
      return { s: 'offline', c: 'retrying', l1: s === 'connecting' ? '<b>正在连接</b> · 稍等一下' : '<b>连接断开了</b> · Agent 暂时用不了', st: s === 'connecting' ? '连接中' : '重连中', sub, title };
    }
    if (s === 'needs_action' && conn.reason === 'duplicate') {
      // 1.28.1 two FoxPaw copies (another browser / profile, or an old unpacked copy) share this browser's credential
      const v = conn.dup && conn.dup.version ? `（版本 ${esc(conn.dup.version)}）` : '';
      return { s: 'offline', c: 'needs_action', l1: '<b>另一个 FoxPaw 在用这台浏览器的连接</b>', st: '已停止重连',
        sub: `另一份 FoxPaw${v}正用同一个连接，两边会互相顶掉。到 chrome://extensions 和其它浏览器 / 配置文件里移除多余或旧版的 FoxPaw，再点「重新连接」。`,
        title, act: { text: '重新连接', pri: true, run: () => send({ type: 'foxpaw.reconnect' }).catch(() => {}) } };
    }
    if (s === 'needs_action') {
      const l1 = conn.reason === 'badpairing' ? '<b>连接码无效</b> · 需要重连' : conn.reason === 'removed' ? '<b>已在控制台被移除</b> · 需要重连' : '<b>连接已失效</b> · 需要重连';
      if (loginPolling) return { s: 'offline', c: 'needs_action', l1, st: '等你确认', sub: '在打开的网页上确认一下，这里会自动接上', title };
      return { s: 'offline', c: 'needs_action', l1, st: '未连接', sub: dev, title, act: { text: '重新连接', pri: true, run: startLogin } };
    }
    return { s: 'offline', c: 'off', l1: conn.reason === 'disabled' ? '<b>连接已关闭</b> · 可在「我」里重新连接' : '<b>没连上</b> · Agent 现在用不了这台浏览器', st: '未连接', sub: dev, title };
  }
  const needs = [];
  for (const a of list) for (const n of agentNeeds(a)) needs.push({ a, n });
  const confs = D.ui.pendingConfirms || [];
  const asks = D.ui.pendingAsks || [];
  const steps = userStepsShown();
  const ar = agentRec();
  const loginWait = ar && ar.paused === 'login' ? 1 : 0;
  const more = needs.length + steps.length + confs.length + asks.length + loginWait - 1;
  const moreSub = more > 0 ? `还有 ${more} 件` : dev;
  const byLabel = (l) => list.find((a) => a.label === l) || { label: l };
  const who = (l) => `<b>${esc(l || 'Agent')}</b>`;
  if (confs.length) {
    const p = confs[0];
    const tt = p.category === 'login' || p.category === 'vault' ? '' : p.tabId != null ? tabTitleOf(p.tabId) : ''; // 1.26 the site, not the tab title
    return { s: 'attention', agent: byLabel(p.agent || 'Agent'), l1: `${who(p.agent)} 想${esc(VERB_TEXT[p.category] || VERB_TEXT.gate)}「${esc(tt || p.host || '已授权的标签')}」`, st: '等你批准', sub: moreSub,
      act: { text: '去批准', pri: true, run: () => focusIn('pending') } };
  }
  if (needs.length) {
    const { a, n } = needs[0];
    return { s: 'attention', agent: a, l1: `${who(a.label)} ${esc(n.reason || '需要你处理一下')}`, st: '等你处理', sub: moreSub,
      act: n.tabId != null ? { text: '去处理', pri: true, run: () => activateTab(n.tabId) } : { text: '去看看', pri: true, run: () => focusIn('needZone') } };
  }
  if (steps.length) {
    const u = steps[0];
    return { s: 'attention', agent: byLabel(u.agent || 'Agent'), l1: u.page ? `${who(u.agent)} 需要你${esc(USTEP_CN[u.reason] || '亲自操作一步')} · ${esc(u.page)}` : `${who(u.agent)} 需要你${esc(USTEP_CN[u.reason] || '亲自操作一步')}`, st: '需要你处理', sub: moreSub,
      act: u.tabId != null ? { text: '去处理', pri: true, run: () => send({ type: 'foxpaw.userStepGo', id: u.id }).catch(() => activateTab(u.tabId)) } : { text: '去看看', pri: true, run: () => focusIn('pending') } };
  }
  if (loginWait) {
    return { s: 'attention', agent: byLabel(ar.agentLabel || 'Agent'), l1: `${who(ar.agentLabel)} 录到了登录页`, st: '等你登录', sub: more > 0 ? moreSub : (ar.pauseHost || dev),
      act: ar.pauseTab != null ? { text: '去处理', pri: true, run: () => activateTab(ar.pauseTab) } : { text: '去看看', pri: true, run: () => focusIn('recPause') } };
  }
  if (asks.length) {
    const q = asks[0];
    return { s: 'attention', agent: byLabel(q.agent || 'Agent'), l1: `${who(q.agent)} 问：${esc(q.question || '有个问题想问你')}`, st: '等你回答', sub: moreSub,
      act: { text: '去回答', pri: true, run: () => focusIn('pending', 'input') } };
  }
  if (ownerRec()) {
    const r = D.rec;
    const site = recSite(r);
    if (r.pendingSave) return { s: 'recording', you: true, l1: `<b>你录完了</b> · ${r.live || (r.steps || []).length || 0} 步，保存成流程`, st: '待保存', sub: site.name || dev };
    return { s: r.paused ? 'paused' : 'recording', you: true, l1: `<b>你在录制</b> · 第 ${(r.live || 0) + 1} 步`, st: r.paused ? '已暂停' : '录制中', sub: site.name || dev };
  }
  if (ar) {
    const what = ar.goal || (ar.startTab && ar.startTab.title);
    return { s: 'recording', agent: byLabel(ar.agentLabel || 'Agent'), l1: `${who(ar.agentLabel)} ${what ? `在录「${esc(what)}」` : '在已授权的标签里录制'}`, st: `录制中 · 第 ${(ar.live || 0) + 1} 步`, sub: dev };
  }
  if (!list.length) return { s: 'idle', l1: '<b>已就绪</b> · 等第一个 Agent 接入', st: '已连接', sub: dev }; // the card below says how
  if (D.cfg.access === 'off') return { s: 'paused', l1: '<b>已全部暂停</b> · Agent 的操作都会被拒绝', st: '已连接', sub: dev }; // 1.27 恢复 is in the expansion
  const lw = liveWorking(list);
  const live = lw[0];
  if (live) {
    const { t0, title } = agentTab(live);
    const verb = t0 && t0.via === 'touch' ? touchText(t0) : '正在操作';
    const what = title ? `${verb}「${esc(title)}」` : live.tabs ? `正在操作 ${live.tabs} 个标签` : '最近在活动';
    const extra = lw.length > 1 ? ` · 另 ${lw.length - 1} 个也在干` : ''; // 1.27 no permission word on the island
    return { s: 'running', agent: live, l1: `${who(live.label)} ${what}`, st: '运行中', sub: dev + extra };
  }
  const paused = list.find((a) => isPaused(a.label, a.id));
  if (paused) {
    return { s: 'paused', agent: paused, l1: `${who(paused.label)} 在这台设备上暂停了`, st: '已暂停', sub: dev,
      act: { text: '恢复', run: () => resumeAgent(paused) } };
  }
  let fresh = null;
  for (const a of list) if (a.lastSeenTs && (!fresh || a.lastSeenTs > fresh.lastSeenTs)) fresh = a;
  const fd = fresh && toDate(fresh.lastSeenTs);
  const l1 = fd && Date.now() - fd.getTime() < 864e5 ? `<b>没人在用</b> · ${esc(fresh.label)} ${agoCore(fresh.lastSeenTs)}来过` : `<b>没人在用</b> · ${list.length} 个 Agent 都在休息`;
  return { s: 'idle', l1, st: '已连接', sub: dev };
}
async function resumeAgent(a) {
  localPaused.delete(a.id || a.label);
  await send({ type: 'foxpaw.agentPause', agentId: a.id, agent: a.label, paused: false }).catch(() => {});
  render();
}
function focusIn(id, sel = 'button') {
  const z = $(id);
  if (!z) return;
  z.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const f = z.querySelector(sel);
  if (f) f.focus({ preventScroll: true });
}
const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
// 「不闪」 (same rule as the console since 3.3.2): signature compare first, then patch only what changed —
// the island is never hidden / rebuilt, the account button and expansion keep focus and scroll.
// 1.24.1: line 1 = the state (16/600); a 「<b>状态</b> · 附注」 tail is a note (secondary gray, regular weight)
function splitL1(h) { const mm = /^<b>([\s\S]*?)<\/b> · ([\s\S]*)$/.exec(h || ''); return mm ? `<b>${mm[1]}</b><span class="inote"> · ${mm[2]}</span>` : (h || ''); }
// names: 「tester、Claude」 / 「tester、Claude 等 3 个」 — long lists never run off the line
function nameList(list, max = 2) { const n = list.map((a) => a.label); return n.length <= max ? n.join('、') : `${n.slice(0, max).join('、')} 等 ${n.length} 个`; }
function islAgentLine(list) {
  const s = agentSummary(list);
  const allRest = s.line.startsWith('休息中');
  return allRest ? `休息中 · ${nameList(list)}` : `${s.line} · ${nameList(list)}`;
}
function renderIsland(list) {
  const m = islandModel(list);
  const box = $('island');
  $('views').classList.toggle('dim', paired() && (conn.state === 'retrying' || conn.state === 'needs_action'));
  const agentLabel = m.agent ? m.agent.label : '';
  // 1.27: line 2 = 「已连接 · 设备」 only (no 可操作 — permission is per agent, on its row); line 3 = the Agent summary
  const onl = m.s !== 'boot' && paired() && conn.state === 'online';
  const agTx = onl && list.length ? islAgentLine(list) : '';
  const key = JSON.stringify([m.s, m.c || '', m.l1, m.st, m.sub, m.title || '', m.act && [m.act.text, !!m.act.pri], agentLabel, agentLabel && colorOf[agentLabel], agentLabel && avatarOf[agentLabel], agTx]);
  if (key !== islandKey) {
    const prevS = islandKey ? JSON.parse(islandKey)[0] : '';
    islandKey = key;
    box.dataset.s = m.s;
    box.dataset.c = m.c || (conn.state === 'online' ? 'online' : conn.state);
    const w = $('islWho');
    if (agentLabel && avImg(agentLabel)) w.innerHTML = avImg(agentLabel);
    else w.textContent = agentLabel ? String(agentLabel).slice(0, 1).toUpperCase() : '';
    w.style.background = agentLabel ? (colorOf[agentLabel] || `hsl(${hue(agentLabel)} 58% 46%)`) : '';
    $('islFox').title = '';
    $('islL1').innerHTML = splitL1(m.l1);
    $('islL1').title = $('islL1').textContent;
    $('islSt').textContent = m.st;
    $('islSep').textContent = m.st && m.sub ? '·' : '';
    $('islSub').textContent = m.sub;
    $('islL2').title = m.title || [m.st, m.sub].filter(Boolean).join(' · ');
    $('islAg').classList.toggle('hidden', !agTx);
    $('islAgTx').textContent = agTx;
    $('islAg').title = agTx;
    const act = $('islAct');
    act.innerHTML = '';
    if (m.act) {
      const btn = el(`<button class="ib${m.act.pri ? ' pri' : ''}">${esc(m.act.text)}</button>`);
      btn.onclick = (e) => { e.stopPropagation(); m.act.run(); };
      act.append(btn);
    }
    if (prevS && prevS !== m.s && prevS !== 'boot' && !reducedMotion()) { box.classList.remove('swap'); void box.offsetWidth; box.classList.add('swap'); }
  }
  renderIslandDet(list, m);
}
// 1.24.1 expansion = 「接下来我要管什么」, never a repeat of the collapsed island. Blocks in order, each only
// when it has content (no empty titles): ① 待你处理 (every approval / need / user step / login wait / question /
// paused run, one line + 去处理) · ② 正在做 / 最近一次 (a running flow run, else the last finished one) · ③ 放行倒计时 ·
// ④ 这台浏览器 (device · connected for · version + 检查更新; 1.27: no browser-level 权限 — it is per agent) ·
// ⑤ 全部暂停 / 恢复 + 控制台 ›. Data = handshake + foxpawUi only (no new relay interface).
const RUN_END_CN = { succeeded: '成功', failed: '失败', stopped: '已终止' };
function todoItems(list) {
  const out = [];
  const confs = D.ui.pendingConfirms || [];
  const asks = D.ui.pendingAsks || [];
  for (const p of confs) out.push({ k: 'c:' + p.id, t: p.tabId != null && tabTitleOf(p.tabId) ? `${p.agent || 'Agent'} 想${VERB_TEXT[p.category] || VERB_TEXT.gate}「${tabTitleOf(p.tabId)}」` : p.host ? `${p.agent || 'Agent'} 想${VERB_TEXT[p.category] || VERB_TEXT.gate} · ${p.host}` : `${p.agent || 'Agent'} 想${VERB_TEXT[p.category] || VERB_TEXT.gate}`, tag: '批准', go: () => focusIn('pending') });
  for (const a of list) for (const n of agentNeeds(a)) out.push({ k: 'n:' + n.id, t: `${a.label}：${n.reason || '需要你处理一下'}`, tag: '接手', go: () => (n.tabId != null ? activateTab(n.tabId) : focusIn('needZone')) });
  for (const u of userStepsShown()) out.push({ k: 'u:' + u.id, t: u.page ? `${u.agent || 'Agent'} 需要你${USTEP_CN[u.reason] || '亲自操作一步'} · ${u.page}` : `${u.agent || 'Agent'} 需要你${USTEP_CN[u.reason] || '亲自操作一步'}`, tag: '接手', go: () => (u.tabId != null ? send({ type: 'foxpaw.userStepGo', id: u.id }).catch(() => activateTab(u.tabId)) : focusIn('pending')) });
  const ar = agentRec();
  if (ar && ar.paused === 'login') out.push({ k: 'l', t: `${ar.agentLabel || 'Agent'} 录到登录页，需要你登录${ar.pauseHost ? ' ' + ar.pauseHost : ''}`, tag: '登录', go: () => (ar.pauseTab != null ? activateTab(ar.pauseTab) : focusIn('recPause')) });
  for (const q of asks) out.push({ k: 'q:' + q.id, t: `${q.agent || 'Agent'} 问：${q.question || '有个问题想问你'}`, tag: '回答', go: () => focusIn('pending', 'input') });
  for (const r of (Array.isArray(D.ui.runs) ? D.ui.runs : [])) if (r && r.status === 'paused') {
    const p = r.pause || {};
    out.push({ k: 'r:' + r.id, t: `${r.name || '流程'} 停在第 ${r.cur || p.at || '?'} 步：${p.reason || '这一步没做成'}`, tag: '运行暂停', go: () => focusIn('runZone') });
  }
  return out;
}
function runNow() {
  const rs = Array.isArray(D.ui.runs) ? D.ui.runs : [];
  return rs.find((r) => r && r.status === 'running') || null;
}
function lastRun() {
  const rs = (Array.isArray(D.ui.runs) ? D.ui.runs : []).filter((r) => r && RUN_END_CN[r.status] && r.ended);
  const lr = D.ui.lastRun && RUN_END_CN[D.ui.lastRun.status] ? D.ui.lastRun : null;
  return [...rs, ...(lr ? [lr] : [])].sort((a, b) => (b.ended || 0) - (a.ended || 0))[0] || null;
}
function connFor() {
  if (conn.state !== 'online' || !conn.since) return '';
  const m = Math.floor(Math.max(0, Date.now() - conn.since) / 60000);
  return m < 1 ? '刚连上' : m < 60 ? `已连接 ${m} 分钟` : m < 1440 ? `已连接 ${Math.floor(m / 60)} 小时${m % 60 ? ' ' + (m % 60) + ' 分' : ''}` : `已连接 ${Math.floor(m / 1440)} 天`;
}
// 1.27: the browser-level 停用 / 只看 / 可操作 is gone; 全部暂停 / 恢复 is the only browser switch left
// (cfg.access 'off' / 'write'; a stored 只看 from ≤1.26 reads as 'write'). Permission is per agent, on its row.
async function setAccess(v) {
  v = v === 'off' ? 'off' : 'write';
  const cur = D.cfg.access === 'off' ? 'off' : 'write';
  if (v === cur) return;
  D.cfg.access = v;
  render();
  await send({ type: 'foxpaw.setAccess', access: v }).catch(() => {});
  showToast(v === 'off' ? '已全部暂停：Agent 的操作都会被拒绝' : '已恢复：Agent 可以按各自的权限操作', 2400);
}
function renderIslandDet(list, m) {
  const box = $('island');
  box.classList.toggle('open', islOpen);
  $('islMain').setAttribute('aria-expanded', String(islOpen));
  const online = paired() && conn.state === 'online';
  const todos = online ? todoItems(list) : [];
  const run = online ? runNow() : null;
  const last = !run && paired() ? lastRun() : null;
  const wins = online ? liveWindows() : [];
  const winAgents = new Set(wins.map((w) => w.agentLabel || w.agentId));
  const ver = conn.version || (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '');
  const key = JSON.stringify([islOpen, paired(), conn.state, devName(), D.cfg.access, todos.map((t) => [t.k, t.t]),
    run && [run.id, run.name, run.cur, run.of, run.label], last && [last.id, last.status, when(last.ended)],
    wins.map((w) => [w.id, w.agentLabel, w.verbText, mmss(w.until - Date.now())]), connFor(), ver, updChecking]);
  if (key === islDetKey) return;
  islDetKey = key;
  const dl = $('islDl');
  dl.innerHTML = '';
  if (!islOpen) return; // collapsed: nothing to keep up to date
  const blk = (id, title, cls = '') => { const b = el(`<section class="iblk ${cls}" id="${id}">${title ? `<div class="ibt">${title}</div>` : ''}</section>`); dl.append(b); return b; };
  // ① 待你处理
  if (todos.length) {
    const b = blk('islTodo', `待你处理<span class="ibn">${todos.length}</span>`, 'amber');
    for (const t of todos) {
      const row = el(`<div class="dr todo"><i class="tdot" aria-hidden="true"></i><span class="v" title="${esc(t.t)}">${esc(t.t)}</span><button class="mini go">去处理</button></div>`);
      row.querySelector('button').onclick = (e) => { e.stopPropagation(); t.go(); };
      b.append(row);
    }
  }
  // ② 正在做 / 最近一次
  if (run) {
    const b = blk('islRun', '正在做');
    const r = el(`<button class="dr runrow" type="button" title="打开运行详情"><i class="rdot2" aria-hidden="true"></i><span class="v"><b>${esc(run.name || '流程')}</b><span class="rs">第 ${Math.max(1, run.cur || 1)}/${run.of || '?'} 步${run.label ? ' · ' + esc(run.label) : ''}</span></span><span class="chev">›</span></button>`);
    r.onclick = (e) => { e.stopPropagation(); openConsole('runs/' + encodeURIComponent(run.id)); };
    b.append(r);
  } else if (last) {
    const b = blk('islRun', '');
    const r = el(`<button class="dr runrow last" type="button" title="打开运行详情"><span class="k">最近</span><span class="v">${esc(last.name || '流程')} · <span class="${last.status === 'succeeded' ? 'ok' : 'bad'}">${RUN_END_CN[last.status]}</span> · ${esc(when(last.ended) || '')}</span><span class="chev">›</span></button>`);
    r.onclick = (e) => { e.stopPropagation(); openConsole('runs/' + encodeURIComponent(last.id)); };
    b.append(r);
  }
  // ③ 放行倒计时
  if (wins.length) {
    const w = blk('islWin', '');
    w.setAttribute('role', 'status');
    wins.forEach((x) => {
      const who = winAgents.size > 1 ? esc(x.agentLabel || 'Agent') + ' ' : '';
      const row = el(`<div class="dr"><span class="k">放行</span><span class="v">${who}已放行同类操作${x.verbText ? '「' + esc(x.verbText) + '」' : ''} · 剩 <b>${mmss(x.until - Date.now())}</b></span><button class="mini" aria-label="撤销放行">撤销</button></div>`);
      row.querySelector('button').onclick = (e) => { e.stopPropagation(); send({ type: 'foxpaw.window.revoke', id: x.id }).catch(() => {}); };
      w.append(row);
    });
  }
  // ④ 这台浏览器 (only once there is a device: paired)
  if (paired()) {
    const b = blk('islDev', '这台浏览器');
    const cf = connFor();
    const st = conn.state === 'online' ? `<span class="ok">${esc(cf || '已连接')}</span>` : `<span class="bad">${esc(connShort(conn))}</span>`;
    b.append(el(`<div class="dr"><span class="v"><b>${esc(devName())}</b> · ${st}</span></div>`));
    const vr = el(`<div class="dr"><span class="v">扩展 v${esc(ver)}</span><button class="mini" id="islChk" type="button">${updChecking ? '检查中…' : '检查更新'}</button></div>`);
    vr.querySelector('button').onclick = (e) => { e.stopPropagation(); checkUpdate(true); };
    b.append(vr);
  }
  // ⑤ 底部快捷
  const ft = el('<div class="ifoot" id="islFoot"></div>');
  if (paired()) {
    const off = (D.cfg.access || 'write') === 'off';
    const pb = el(`<button class="ib2 ${off ? 'resume' : 'stop'}" id="islPauseAll" type="button">${off ? '恢复' : '全部暂停'}</button>`);
    pb.onclick = (e) => { e.stopPropagation(); setAccess(off ? 'write' : 'off'); };
    ft.append(pb);
  }
  const cb = el('<button class="ib2 link" id="islConsole" type="button">控制台 ›</button>');
  cb.onclick = (e) => { e.stopPropagation(); openConsole('overview'); };
  ft.append(cb);
  dl.append(ft);
}
function toggleIsland() { islOpen = !islOpen; render(); }
$('agFold').onclick = () => setAgFold(!agFold);
$('island').addEventListener('click', (e) => {
  if (e.target.closest('button, a, input, .det')) return;
  toggleIsland();
});
$('islMain').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleIsland(); } });

/* ---------- 我来录: live steps · delete · 设为变量 · save page ---------- */
function recSite(r) {
  const t = (r && r.startTab) || {};
  const parts = String(t.title || '').split(/\s*[-|·—_–]\s*/).filter(Boolean);
  return { name: parts.length > 1 ? parts[parts.length - 1] : (parts[0] || ''), host: hostOf(t.url || '') };
}
function renderRecView() {
  const r = D.rec;
  const save = !!r.pendingSave;
  $('recLiveView').classList.toggle('hidden', save);
  $('recSaveView').classList.toggle('hidden', !save);
  if (!save) {
    const site = recSite(r);
    $('recSiteName').textContent = site.name;
    $('recSiteHost').textContent = site.host;
    $('recLab').textContent = r.paused ? '已暂停' : '录制中';
    $('recDot').classList.toggle('paused', !!r.paused);
    tickRecTimer();
    // 1.21 the network layer is never a silent 0 — live count, or why it is empty
    const nreq = r.requests || 0;
    $('recNet').className = 'rnet' + (!nreq && r.netNote ? ' warn' : '');
    $('recNet').innerHTML = nreq ? `${r.live || 0} 步 · <b>${nreq} 个网络请求</b>（含响应摘要）` : esc(r.netNote || `${r.live || 0} 步 · 还没有网络请求`);
    const sess = Array.isArray(r.session) ? r.session : [];
    $('recSess').classList.toggle('hidden', sess.length < 2);
    if (changed('recsess', sess)) {
      $('recSessList').innerHTML = sess.map((x) => { const w = SESS_WHY[x.why] || [x.why, '']; return `<div class="tr"><span class="u">${esc(x.url || '新标签')}</span><span class="why ${w[1]}">${esc(w[0])}</span>${x.why === 'chat' ? `<button class="link" data-unskip="${esc(String(x.tabId))}" title="这个标签上的操作也录进流程">也录</button>` : ''}</div>`; }).join('');
      // 1.33.2 the chat-with-the-agent tab is left out; one tap adds it back
      for (const b of $('recSessList').querySelectorAll('[data-unskip]')) b.onclick = () => send({ type: 'foxpaw.rec.unskip', tabId: Number(b.dataset.unskip) }).catch(() => {});
    }
    const outNow = D.cur && !inMine(D.cur);
    $('recWarn').classList.toggle('hidden', !outNow);
    $('recWarn').textContent = outNow ? '你正在看的标签不在 FoxPaw 组里，它上面的操作不会被录。' : '';
    const se = D.ui.recSaveError;
    $('recSaveErr').classList.toggle('hidden', !se);
    $('recSaveErr').textContent = se ? '录制没能存到本机：' + se : '';
    const steps = Array.isArray(r.stepsList) ? r.stepsList : [];
    if (changed('recsteps', [steps, r.paused])) {
      const box = $('recSteps');
      box.innerHTML = '';
      steps.forEach((x, k) => {
        const row = el(`<div class="rstep" data-i="${x.i}"><span class="no">${k + 1}</span>
          <div class="t"><b>${esc(x.text)}</b>${x.sub ? `<span class="s">${esc(x.sub)}</span>` : ''}${x.varName ? `<span class="varchip">{ } ${esc(x.varName)}</span>` : ''}</div>
          <div class="ops">${x.canVar ? `<button class="op" data-a="var">${x.varName ? '改变量' : '{ } 设为变量'}</button>` : ''}<button class="opx" data-a="del" title="删掉这一步" aria-label="删掉第 ${k + 1} 步">✕</button></div></div>`);
        const vb = row.querySelector('[data-a=var]');
        if (vb) vb.onclick = () => {
          const nm = prompt('变量叫什么？运行时会让你填这个值（留空 = 不设为变量）', x.varName || x.sub || '');
          if (nm === null) return;
          send({ type: 'foxpaw.rec.setVar', i: x.i, name: nm.trim() }).catch(() => {});
        };
        row.querySelector('[data-a=del]').onclick = () => send({ type: 'foxpaw.rec.delStep', i: x.i }).catch(() => {});
        box.append(row);
      });
      box.append(el(`<div class="rstep live"><span class="no">·</span><div class="t"><b>${r.paused ? '已暂停，点「继续」接着录…' : steps.length ? '等待下一步…' : '在网页里操作，第一步会出现在这里…'}</b></div></div>`));
    }
    return;
  }
  // save page
  const vars = (Array.isArray(r.vars) ? r.vars : []).filter((v) => !v.secret);
  const secretN = (Array.isArray(r.vars) ? r.vars : []).filter((v) => v.secret).length;
  const dur = r.startedAt && r.stoppedAt ? Math.max(0, Math.round((new Date(r.stoppedAt) - new Date(r.startedAt)) / 1000)) : 0;
  $('recSaveMeta').textContent = `${r.flowSteps || 0} 步 · 用时 ${dur >= 60 ? Math.floor(dur / 60) + ' 分 ' : ''}${dur % 60} 秒`;
  // 1.21 the result says how many requests were captured — or why none
  $('recSaveNet').className = 'rnet' + (!r.requests && r.netNote ? ' warn' : '');
  $('recSaveNet').innerHTML = r.requests ? `<b>${r.requests} 个网络请求</b>（含响应摘要，导出时一起带上）` : esc(r.netNote || '这次录制没有网络请求。');
  if (!recNameTouched && document.activeElement !== $('recName')) $('recName').value = r.name || r.autoName || '';
  $('recVarCount').textContent = vars.length;
  $('recStepCount').textContent = r.flowSteps || 0;
  if (changed('recsave', [vars, secretN, r.flowSummary, recSumOpen])) {
    const vb = $('recVars');
    vb.innerHTML = '';
    if (!vars.length) vb.append(el('<div class="empty" style="padding:12px">没有变量。录制时点步骤上的「设为变量」，运行时就能换成别的值。</div>'));
    for (const v of vars) vb.append(el(`<div class="vrow"><span class="vi">{ }</span><div class="tx"><b>${esc(v.label)}</b><span>${v.sample ? '示例：' + esc(v.sample) : esc(v.kind === 'text' ? '文本' : v.kind)}</span></div></div>`));
    if (secretN) vb.append(el(`<div class="vrow"><span class="vi">•••</span><div class="tx"><b>${secretN} 个秘密字段</b><span>密码 / 验证码不记录，运行到这里由你亲自填</span></div></div>`));
    const sum = $('recSum');
    sum.innerHTML = (r.flowSummary || []).map((t, k) => `<span>${k + 1} ${esc(t)}</span>`).join('') || '<span class="muted">没有录到步骤</span>';
    sum.classList.toggle('clamp', !recSumOpen);
    $('recStepsToggle').textContent = recSumOpen ? '收起' : '展开';
  }
}
let recNameTouched = false;
let recSumOpen = false;
function tickRecTimer() {
  const r = D.rec;
  if (!r || !r.startedAt || r.pendingSave) return;
  const s = Math.max(0, Math.floor((Date.now() - new Date(r.startedAt).getTime()) / 1000));
  $('recTimer').textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/* ---------- 本机录制 (back face): the local library — replay, Playwright export, full / redacted bundles ---------- */
function renderLib() {
  $('libCount').textContent = D.lib.length;
  if (!changed('lib', [D.lib.map((x) => [x.name, x.stoppedAt, (x.steps || []).length, x.status]), libOpen])) return;
  $('libList').classList.toggle('hidden', !libOpen);
  $('libToggle').textContent = libOpen ? '收起' : '展开';
  const box = $('libList');
  box.innerHTML = '';
  if (!D.lib.length) box.append(el('<div class="card"><div class="empty">还没有录制。点首页底部的「录制」开始。</div></div>'));
  for (const x of D.lib) {
    const card = el(`<div class="card item">
      <div class="r1"><b>${esc(x.name || '未命名录制')}</b>${x.source === 'agent' ? `<span class="pill violet">${esc(x.agentLabel || 'Agent')} 录制</span>` : x.status === 'draft' ? '<span class="pill violet">草稿</span>' : '<span class="pill acc">我录的</span>'}</div>
      <div class="meta">${esc(when(x.stoppedAt || x.startedAt))} · ${(x.steps || []).length} 步 · ${(x.requests || []).length} 个接口</div>
      <div class="acts"><button class="btn sm" data-a="replay">在当前标签回放</button><button class="btn sm" data-a="pw">导出回放脚本</button></div>
      <div class="acts"><button class="btn sm" data-a="full">导出完整版</button><button class="btn sm" data-a="red">导出脱敏版</button><button class="btn sm danger" data-a="del">删除</button></div>
    </div>`);
    card.querySelector('[data-a=replay]').onclick = () => replayFlow(D.lib.indexOf(x), x);
    card.querySelector('[data-a=pw]').onclick = async () => {
      const r = await send({ type: 'foxpaw.flow.export', index: D.lib.indexOf(x) }).catch(() => null);
      if (!r || !r.ok) { alert((r && r.message) || '导出失败'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.script], { type: 'text/javascript' }));
      a.download = `foxpaw-flow-${(x.name || 'flow').replace(/[^\w一-龥-]+/g, '_')}.js`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    card.querySelector('[data-a=full]').onclick = () => downloadBundle(x, false);
    card.querySelector('[data-a=red]').onclick = () => downloadBundle(x, true);
    card.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`删除本机录制「${x.name}」？（控制台里的流程不受影响）`)) return;
      const { foxpawRecLibrary = [] } = await chrome.storage.local.get('foxpawRecLibrary');
      await chrome.storage.local.set({ foxpawRecLibrary: (foxpawRecLibrary || []).filter((y) => !(y.name === x.name && (y.stoppedAt || '') === (x.stoppedAt || ''))) });
      if (x.legacy) await chrome.storage.local.remove('foxpawRecording');
      reload();
    };
    box.append(card);
  }
}
let libOpen = false;


/* ---------- 录制 ---------- */
function recSensitive(e) {
  if (!e) return false;
  const hint = [e.name, e.id, e.placeholder, e.ariaLabel].filter(Boolean).join(' ');
  return e.type === 'password' || e.type === 'tel'
    || /password|passwd|otp|auth[-_]?code|验证码|校验码|手机|电话|phone|mobile|身份证|id[-_]?card|银行卡|card|cvv/i.test(hint);
}
function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function downloadBundle(r, redacted) {
  let b = { kind: 'foxpaw-recording', version: 1, exportedAt: new Date().toISOString(), redacted: !!redacted, ...r };
  if (redacted) {
    // v1.15: the background's redaction — identical to the cloud
    // copy, covering network requests too (headers / bodies / URL tokens)
    const res = await send({ type: 'foxpaw.rec.redact', bundle: b }).catch(() => null);
    if (res && res.bundle) b = res.bundle;
    else b.steps = (b.steps || []).map((s) => (s.kind === 'input' && recSensitive(s.el) ? { ...s, value: '•••' } : s)).filter((s) => !s.outOfGroup);
    if (!(res && res.bundle)) b.requests = [];
  } else {
    // 1.28 the full copy is de-noised too (static files out, steady polls folded into one row)
    const res = await send({ type: 'foxpaw.rec.full', bundle: b }).catch(() => null);
    if (res && res.bundle) b = res.bundle;
  }
  downloadJson(b, `foxpaw-recording-${(r.name || 'session').replace(/[^\w一-龥-]+/g, '_')}${redacted ? '-redacted' : ''}.json`);
}

async function replayFlow(index, x) {
  const vars = {};
  for (const [k, v] of Object.entries((x.flow && x.flow.vars) || {})) {
    if (v.secret) continue; // secret fields: the replay stops and you type them yourself
    const val = prompt(`回放「${x.name || ''}」需要：${v.label || k}`, '');
    if (val === null) return;
    vars[k] = val;
  }
  let r = await send({ type: 'foxpaw.flow.run', index, vars }).catch(() => null);
  for (let i = 0; i < 30 && r && r.paused; i++) {
    const what = r.reason === 'pay' ? '付款' : r.reason === 'grant' ? '授权' : r.reason === 'secret' ? '密码 / 验证码等秘密字段' : '这一步';
    if (!confirm(`回放停在第 ${r.at}/${r.of} 步：${what}由你亲自完成。\n${r.message}\n\n做完后点「确定」继续，点「取消」结束回放。`)) return;
    r = await send({ type: 'foxpaw.flow.run', runId: r.runId, from: r.resume.from }).catch(() => null);
  }
  if (r && r.ok) alert(`回放完成：${r.steps} 步，用时 ${Math.round(r.ms / 100) / 10} 秒${r.data && r.data.rows ? `，采集 ${r.data.rows.length} 行` : ''}`);
  else if (r) alert(`回放在第 ${r.at || '?'} 步失败：${r.code || ''} ${r.message || ''}${r.shot ? '\n截图已存在本机（' + r.shot.id + '）' : ''}`);
}


/* ---------- footer ---------- */
function renderFooter() {
  const mode = ownerRec() ? (D.rec.pendingSave ? 'save' : 'live') : 'home';
  $('ftHome').classList.toggle('hidden', mode !== 'home');
  $('ftRecBar').classList.toggle('hidden', mode !== 'live');
  $('ftSaveBar').classList.toggle('hidden', mode !== 'save');
  if (mode === 'live') $('recPauseBtn').textContent = D.rec.paused ? '继续' : '暂停';
  // the relay's lock only means something while we are connected to it
  const lk = conn.state === 'online' && D.ui.recLock && D.ui.recLock.agentLabel ? D.ui.recLock : null;
  const ar = agentRec() || (lk ? { agentLabel: lk.agentLabel } : null);
  $('ftRecText').textContent = ar ? `录制 · ${ar.agentLabel || 'Agent'} 在录` : '录制';
  $('ftRec').disabled = !!ar || D.cfg.access === 'off';
  $('ftRec').title = ar ? '一台浏览器同时只能有一个录制' : D.cfg.access === 'off' ? '已全部暂停：先在灵动岛里点「恢复」' : '点一下就开始录，在网页里照常操作';
  $('ftRec').classList.toggle('hidden', !paired());
}

/* ---------- 我的 ---------- */
function renderMe() {
  const acct = D.ui.account;
  $('meAv').style.background = acct && acct.email ? acctColor(acct) : '';
  if (acct && acct.email) {
    $('meAv').textContent = acct.email.slice(0, 1).toUpperCase();
    $('meName').textContent = '我的账户';
    $('meEmail').textContent = maskEmail(acct.email);
  } else if (paired()) {
    $('meAv').textContent = '我';
    $('meName').textContent = '这台浏览器';
    $('meEmail').textContent = '未绑定账户，可在控制台登录后迁入';
  } else {
    $('meAv').textContent = '我';
    $('meName').textContent = '未连接';
    $('meEmail').textContent = '连接后，这台浏览器归到你的账户下';
  }
  // unpaired back face offers the connect card instead of a dead
  // end — same loginStart flow as onboarding step 1, incl. waiting state.
  const showConnect = !paired();
  $('meConnect').classList.toggle('hidden', !showConnect);
  if (showConnect) {
    const wa = D.ui.webAccount;
    $('meConnectHint').textContent = wa && wa.email ? `官网已登录 ${maskEmail1(wa.email)}，点一下连上` : '打开官网，点一下确认就连上。';
    $('meConnectBtn').classList.toggle('hidden', !!loginPolling);
    $('meConnectWait').classList.toggle('hidden', !loginPolling);
  }
  $('mePlan').classList.toggle('hidden', !(acct && acct.email));
  $('meSwitch').classList.toggle('hidden', !(acct && acct.email));
  $('meDevice').textContent = D.ui.deviceLabel || '—';
  $('meConn').textContent = connShort(conn);
  $('meVer').textContent = 'v' + (conn.version || chrome.runtime.getManifest?.().version || '');
  document.querySelectorAll('#sensSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === (D.cfg.sensitive || 'ask')));
  const rules = Object.entries(D.cfg.siteRules || {});
  $('rulesCount').textContent = `${rules.length} 条`;
  if (changed('rules', rules)) {
    const names = { allow: '放行', ask: '每次问我', block: '禁止', deny: '禁止' };
    const box = $('ruleList');
    box.innerHTML = rules.length ? '' : '<div class="empty" style="padding:8px">还没有站点规则</div>';
    for (const [o, r] of rules) {
      const row = el(`<div class="row"><div class="tx"><span class="t">${esc(hostOf(o) || o)}</span></div><span class="pill ${r === 'allow' ? 'green' : r === 'ask' ? '' : 'red'}">${esc(names[r] || r)}</span><button class="x" aria-label="删除">✕</button></div>`);
      row.querySelector('.x').onclick = () => send({ type: 'foxpaw.setRule', origin: o, rule: '' }).catch(() => {});
      box.append(row);
    }
  }
  $('meSignOut').classList.toggle('hidden', !paired());
  $('meReconnect').classList.toggle('hidden', !paired()); // unpaired: the connect card above is the one way back in
  renderLib();
  renderVault();
}

/* ---------- navigation ---------- */
function flip(on) { $('flip').classList.toggle('flipped', on); for (const k of Object.keys(sigs)) delete sigs[k]; render(); }
$('btnMe').onclick = () => { flip(true); send({ type: 'foxpaw.vaultRefresh' }).catch(() => {}); };
$('btnBack').onclick = () => flip(false);

/* ---------- actions ---------- */
document.querySelectorAll('#sensSeg button').forEach((b) => {
  b.onclick = () => send({ type: 'foxpaw.setSensitive', value: b.dataset.v }).catch(() => {});
});

async function startLogin() {
  try {
    const r = await send({ type: 'foxpaw.loginStart' });
    if (r && r.verifyUrl) chrome.tabs.create({ url: r.verifyUrl });
    clearInterval(loginPolling);
    loginPolling = setInterval(pollLogin, 3000);
    render();
  } catch (e) {
    $('ob1Text').textContent = '没能打开官网：' + (e.message || e);
  }
}
async function pollLogin() {
  const r = await send({ type: 'foxpaw.loginPoll' }).catch(() => ({ status: 'pending' }));
  if (r.status === 'pending') return;
  clearInterval(loginPolling); loginPolling = null;
  // 1.20: 「不是我，取消」 on the connect page / an expired request ends the wait with a word
  if (r.status === 'denied') showToast('这次连接已在网页上取消，没有连上任何账户');
  else if (r.status === 'expired') showToast('连接请求过期了，再点一次「连接这台浏览器」');
  reload();
}
$('offGo').onclick = startLogin;
$('offCancel').onclick = (e) => { e.preventDefault(); clearInterval(loginPolling); loginPolling = null; render(); };
$('obCancel').onclick = (e) => { e.preventDefault(); clearInterval(loginPolling); loginPolling = null; render(); };

async function assignCurrent() {
  const r = await send({ type: 'foxpaw.assignCurrent' }).catch(() => null);
  if (r && r.ok === false) { /* no eligible tab */ }
  reload();
}
$('btnAssign').onclick = assignCurrent;
$('obAssign').onclick = assignCurrent;

// v1.17 (relay 3.0 ): management lives in the console — the panel only
// opens it (no ticket: the owner's session comes from the device-approval
// login in this same browser; hash routes work on relay 2.9 and 3.0 alike).
function openConsole(view) { return openSite(siteBase() + '/app#' + (view || 'agents')); }
$('ftConsole').onclick = () => openConsole('overview');
// 1.33.0 (relay 3.8.7): 「邀请 Agent」 opens the console's invite dialog straight away (#invite; older relays: overview)
$('obInvite').onclick = () => openConsole('invite');
$('firstAgentGo').onclick = () => openConsole('invite');
$('agInvite').onclick = () => openConsole('invite');

// 我来录: one click starts. A current page outside the FoxPaw group joins it first (it is the start page).
async function startRec() {
  if (D.cfg.access === 'off') { showToast('已全部暂停：先在灵动岛里点「恢复」'); return; }
  const eligible = D.cur && /^https?:/.test(D.cur.url || '');
  const r = await send({ type: eligible && !inMine(D.cur) ? 'foxpaw.rec.startHere' : 'foxpaw.rec.start', name: '' }).catch((e) => ({ ok: false, error: e.message }));
  if (r && r.ok === false) showToast(r.error || '没能开始录制');
  recNameTouched = false; recSumOpen = false;
}
$('ftRec').onclick = startRec;
$('recPauseBtn').onclick = () => send({ type: 'foxpaw.rec.pause', paused: !(D.rec && D.rec.paused) }).catch(() => {});
$('recStopBtn').onclick = () => send({ type: 'foxpaw.rec.stop' }).catch(() => {});
$('recBack').onclick = () => send({ type: 'foxpaw.rec.continue' }).catch(() => {});
$('recName').oninput = () => { recNameTouched = true; };
$('recStepsToggle').onclick = () => { recSumOpen = !recSumOpen; render(); };
$('recSaveBtn').onclick = async () => {
  const r = await send({ type: 'foxpaw.rec.save', name: $('recName').value.trim() }).catch((e) => ({ ok: false, error: e.message }));
  if (r && r.ok) showToast('已保存为流程，可在控制台运行或打开定时'); else showToast((r && r.error) || '没能保存');
};
$('recDiscard').onclick = async () => {
  if (!confirm('不保存这次录制？它会留在控制台「流程 › 待审阅」里（来源「你录制」），之后仍可保存或删除。')) return;
  await send({ type: 'foxpaw.rec.discard' }).catch(() => {});
};
$('libToggle').onclick = () => { libOpen = !libOpen; render(); };

/* 我的 actions */
/* ---------- 1.26 登录凭证 ---------- */
let vaultEdit = null;          // null = form closed; '' = adding; id = editing
const vaultShown = new Map();  // id -> revealed password (panel memory only, hidden again on re-render after 20 s)
function vaultItems() { return Array.isArray(D.ui.vault) ? D.ui.vault : []; }
function renderVault() {
  const items = vaultItems();
  $('vaultCount').textContent = `${items.length} 个`;
  const now = Date.now();
  for (const [k, v] of vaultShown) if (now - v.at > 20000) vaultShown.delete(k);
  if (!changed('vault', [items, [...vaultShown.keys()], vaultEdit])) return;
  const box = $('vaultList');
  box.innerHTML = items.length ? '' : '<div class="empty" style="padding:8px">还没有保存登录。添加后，Agent 要登录这个网站时就能直接用。</div>';
  for (const it of items) {
    const sh = vaultShown.get(it.id);
    const meta = [it.source === 'agent' ? `${it.by || 'Agent'} 存的` : '', it.note || ''].filter(Boolean).join(' · ');
    const row = el(`<div class="row lgrow" data-id="${esc(it.id)}"><div class="tx"><span class="t">${esc(it.site)}</span>
      <span class="s">${esc(it.user || '（无账号）')}</span><span class="s${sh ? ' pwshow' : ''}">密码 <span class="pwv">${sh ? esc(sh.pw) : '••••••••'}</span>${meta ? ' · ' + esc(meta) : ''}</span></div>
      <button class="x" data-a="eye" aria-label="${sh ? '隐藏密码' : '显示密码'}" title="${sh ? '隐藏密码' : '显示密码'}"><svg><use href="#i-${sh ? 'eyeoff' : 'eye'}"/></svg></button>
      <button class="x" data-a="edit" aria-label="编辑" title="编辑"><svg><use href="#i-edit"/></svg></button>
      <button class="x" data-a="del" aria-label="删除" title="删除">✕</button></div>`);
    row.querySelector('[data-a=eye]').onclick = async () => {
      if (vaultShown.has(it.id)) { vaultShown.delete(it.id); renderVault(); return; }
      const r = await send({ type: 'foxpaw.vaultReveal', id: it.id }).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok) { vaultShown.set(it.id, { pw: r.password, at: Date.now() }); renderVault(); setTimeout(renderVault, 20500); } else showToast((r && r.error) || '没能显示');
    };
    row.querySelector('[data-a=edit]').onclick = () => openVaultForm(it);
    row.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`删除 ${it.site} 的登录（${it.user || '无账号'}）？删除后 Agent 立即不能再用它。`)) return;
      const r = await send({ type: 'foxpaw.vaultRemove', id: it.id }).catch(() => null);
      showToast(r && r.ok ? '已删除' : '没能删除');
    };
    box.append(row);
  }
  $('vaultForm').classList.toggle('hidden', vaultEdit === null);
  $('vaultAdd').classList.toggle('hidden', vaultEdit !== null);
}
function openVaultForm(it) {
  vaultEdit = it ? it.id : '';
  $('vaultBox').classList.remove('hidden');
  $('vSite').value = it ? it.site : (D.cur && /^https?:/.test(D.cur.url || '') ? hostOf(D.cur.url) : '');
  $('vUser').value = it ? it.user : '';
  $('vPass').value = ''; $('vPass').type = 'password';
  $('vPass').placeholder = it ? '新密码（不改就留空）' : '密码';
  $('vNote').value = it ? it.note : '';
  renderVault();
  (it ? $('vPass') : $('vSite')).focus();
}
$('vaultToggle').onclick = () => { $('vaultBox').classList.toggle('hidden'); send({ type: 'foxpaw.vaultRefresh' }).catch(() => {}); };
$('vaultAdd').onclick = () => openVaultForm(null);
$('vCancel').onclick = () => { vaultEdit = null; $('vPass').value = ''; renderVault(); };
$('vPassEye').onclick = () => { $('vPass').type = $('vPass').type === 'password' ? 'text' : 'password'; };
$('vSave').onclick = async () => {
  const site = $('vSite').value.trim(), user = $('vUser').value.trim(), password = $('vPass').value;
  if (!site) { showToast('填一下网站'); return; }
  if (!vaultEdit && !password) { showToast('填一下密码'); return; }
  const r = await send({ type: 'foxpaw.vaultPut', id: vaultEdit || undefined, site, user, password: password || undefined, note: $('vNote').value }).catch((e) => ({ ok: false, error: e.message }));
  if (r && r.ok) { $('vPass').value = ''; vaultEdit = null; renderVault(); showToast(r.replaced ? `已更新 ${r.item.site}` : `已保存 ${r.item.site}`); }
  else showToast((r && r.error) || '没能保存');
};
// 「保存到 FoxPaw」: the owner just signed in by hand somewhere
function renderVaultOffer() {
  const o = D.ui.vaultOffer;
  const live = o && Date.now() - (o.at || 0) < 5 * 60 * 1000 ? o : null;
  if (!changed('voffer', live)) return;
  const box = $('vaultOffer');
  box.innerHTML = '';
  if (!live) return;
  const card = el(`<div class="card voffer"><div class="k">登录凭证</div>
    <h3>${live.update ? `更新 ${esc(live.site)} 的已存密码？` : `把 ${esc(live.site)} 的登录保存到 FoxPaw？`}</h3>
    <p class="muted">账号 ${esc(live.user || '（没认出来，保存后可编辑）')} · 密码只加密存在这台浏览器。以后 Agent 要登录 ${esc(live.site)} 时直接用，看不到密码。</p>
    <div class="btnrow"><button class="btn" data-a="never">这个网站不再问</button><button class="btn" data-a="no">不用</button><button class="btn pri" data-a="yes">保存</button></div></div>`);
  const go = (save, never) => send({ type: 'foxpaw.vaultOffer', tabId: live.tabId, save, never }).then((r) => { if (save) showToast(r && r.ok ? `已保存 ${live.site}` : (r && r.error) || '没能保存'); }).catch(() => {});
  card.querySelector('[data-a=yes]').onclick = () => go(true, false);
  card.querySelector('[data-a=no]').onclick = () => go(false, false);
  card.querySelector('[data-a=never]').onclick = () => go(false, true);
  box.append(card);
}
$('rulesToggle').onclick = () => $('rulesBox').classList.toggle('hidden');
$('ruleAdd').onclick = async () => {
  let o = $('ruleOrigin').value.trim();
  if (!o) return;
  if (!/^https?:\/\//.test(o)) o = 'https://' + o;
  try { o = new URL(o).origin; } catch { return; }
  await send({ type: 'foxpaw.setRule', origin: o, rule: $('ruleValue').value }).catch(() => {});
  $('ruleOrigin').value = '';
};
// Exit rows: if a tab from this site is already open, switch to it (and
// navigate it) instead of stacking a new tab on every click.
async function openSite(url) {
  try {
    const tabs = await chrome.tabs.query({ url: siteBase() + '/*' });
    const t = (tabs || []).find((x) => x && x.id != null);
    if (t && chrome.tabs.update) {
      await chrome.tabs.update(t.id, { url, active: true });
      if (chrome.windows && chrome.windows.update && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
      return;
    }
  } catch { /* fall back to a fresh tab below */ }
  await chrome.tabs.create({ url });
}
document.querySelectorAll('#manage .row[data-go]').forEach((r) => { r.onclick = () => openConsole(r.dataset.go); });
$('goHome').onclick = () => openSite(siteBase() + '/');
$('meReconnect').onclick = () => send({ type: 'foxpaw.reconnect' }).catch(() => {});
$('meNotifyTest').onclick = async () => {
  const r = await send({ type: 'foxpaw.notifyTest' }).catch(() => null);
  showToast(r && r.level === 'denied' ? 'FoxPaw 的通知被关了：Chrome 设置 → 网站设置 → 通知里开启' : '已发出一条测试通知。没看到的话，去系统设置 → 通知里允许 Google Chrome', 5200);
};
$('meDiag').onclick = async () => {
  const d = await send({ type: 'foxpaw.diagnostics' }).catch((e) => ({ error: e.message }));
  downloadJson(d, `foxpaw-diagnostics-${new Date().toISOString().slice(0, 10)}.json`);
};
$('meConnectBtn').onclick = startLogin;
$('meConnectCancel').onclick = (e) => { e.preventDefault(); clearInterval(loginPolling); loginPolling = null; render(); };
$('meSignOut').onclick = async () => {
  if (!confirm('断开这台浏览器？官网登录不受影响，这台设备的记录会保留，以后点一下就能重新连上。')) return;
  await send({ type: 'foxpaw.signOut' }).catch(() => {});
  flip(false);
};
$('meSwitch').onclick = async () => {
  const cur = D.ui.account && D.ui.account.email ? maskEmail(D.ui.account.email) : '当前账户';
  if (!confirm(`切换账号？\n· 这台浏览器从 ${cur} 断开，官网也会退出登录，然后打开连接页。\n· 为 ${cur} 授权的标签会取消授权（任何 Agent 都看不到），本机录制也一起收起；切回 ${cur} 时恢复。\n· 用新账号登录并确认后，这台浏览器就归到新账号名下（原账号下的设备记录会保留为「已断开」）。`)) return;
  try {
    const r = await send({ type: 'foxpaw.switchAccount' });
    if (r && r.verifyUrl) chrome.tabs.create({ url: r.verifyUrl });
    clearInterval(loginPolling);
    loginPolling = setInterval(pollLogin, 3000);
    flip(false);
    render();
  } catch (e) {
    showToast('切换没能完成：' + (e.message || e));
  }
};

/* ---------- boot ---------- */
// the card ⋯ menu is a floating dropdown — a click anywhere outside
// it (or Escape) dismisses it. The ⋯ button itself stopPropagation()s,
// and menu items clear menuFor in their own handlers first.
document.addEventListener('click', (e) => {
  if (menuFor && !e.target.closest('.adrop') && !e.target.closest('.morebtn') && !e.target.closest('.agrow button.cap')) { menuFor = null; render(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuFor) { menuFor = null; render(); }
});
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && !ch.foxpawConn) reload(); });
for (const ev of ['onUpdated', 'onRemoved', 'onActivated', 'onCreated']) {
  try { chrome.tabs[ev] && chrome.tabs[ev].addListener(reload); } catch { /* noop */ }
}
openPort();
pullStatus();
load();
checkUpdate(false); // 1.24 every panel open checks once, silently
// countdown + relative times only; no storage reads, no status polling
setInterval(() => {
  if (ownerRec()) tickRecTimer();                       // recording clock
  if (conn.state === 'retrying' || conn.state === 'connecting' || (D.ui.windows || []).length) renderIsland(roster()); // retry / 放行 countdowns on the island
}, 1000);

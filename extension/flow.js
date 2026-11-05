/* FoxPaw 流程格式 foxpaw.flow/1（扩展 1.17 录制版）
   One pure module, no chrome.* — loaded by the service worker
   (importScripts) and by Node tests / tools (require). It owns:
     - the flow format: validate(flow)
     - recording → flow conversion: fromRecording(rec)
     - the cloud copy: redactFlow(flow)
     - locator candidates for replay: targetSpecs(target)
     - a Playwright (JS) export: toPlaywright(flow)
   Values of secret fields (password / one-time code / card / token) never
   reach this module from the recorder; PII (email / phone / ID / account)
   becomes a variable whose value is not stored in the flow. */
(function (root) {
  'use strict';
  const SCHEMA = 'foxpaw.flow/1';
  const STEP_TYPES = ['navigate', 'click', 'fill', 'select', 'check', 'press', 'upload', 'wait', 'assert', 'scroll',
    'extract', 'paginate', 'visit', 'closeTab', 'userStep', 'waitInput', 'output'];
  const SECRET_KINDS = ['password', 'otp', 'card', 'token'];
  const PII_KINDS = ['email', 'phone', 'idcard', 'account'];
  const VAR_KINDS = [...SECRET_KINDS, ...PII_KINDS, 'text', 'file'];
  const PROVIDERS = ['builtin', 'zhuazhuaxie']; // zhuazhuaxie: reserved hook, not implemented
  const USER_REASONS = ['pay', 'grant', 'secret', 'captcha', 'manual'];
  const KEY_RE = /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|F\d{1,2}|[A-Za-z0-9])$/;
  const MODS = ['Control', 'Meta', 'Alt', 'Shift'];

  /* ---------- sensitivity (mirrors background SECRET_HINT + recFieldSensitive) ---------- */
  const SECRET_HINT = /password|passwd|pwd|passcode|otp|one.?time|验证码|校验码|动态码|短信码|sms.?code|verif\w*.?code|auth.?code|captcha|cvv|cvc|security.?code|卡号|card.?(no|num)|pin(code)?\b/i;
  function fieldKind(d) {
    if (!d) return null;
    if (d.sens) return d.sens;
    const ac = String(d.autocomplete || '').toLowerCase();
    const hint = [d.nameAttr, d.id, d.placeholder, d.label, d.name].filter(Boolean).join(' ');
    if (d.type === 'password' || d.wasPassword || /current-password|new-password/.test(ac)) return 'password';
    if (/one-time-code/.test(ac) || /otp|one.?time|验证码|校验码|动态码|短信码|sms.?code|verif\w*.?code|auth.?code|captcha/i.test(hint)) return 'otp';
    if (/^cc-|\scc-/.test(ac) || /cvv|cvc|security.?code|卡号|card.?(no|num)|银行卡/i.test(hint)) return 'card';
    if (/token|api.?key|secret/i.test(hint)) return 'token';
    if (/password|passwd|pwd|passcode|pin(code)?\b/i.test(hint)) return 'password';
    if (d.type === 'email' || /email|邮箱/i.test(hint) || ac === 'email') return 'email';
    if (d.type === 'tel' || /^tel/.test(ac) || /phone|mobile|手机|电话/i.test(hint)) return 'phone';
    if (/身份证|id.?card|证件/i.test(hint)) return 'idcard';
    if (/^username$/.test(ac) || /user.?name|account|login|账号|账户名|用户名/i.test(hint)) return 'account';
    return null;
  }
  const isSecretKind = (k) => SECRET_KINDS.includes(k);

  /* ---------- URL redaction (same parameter list as background recRedactUrl) ---------- */
  const SECRET_PARAM = /^(code|auth_?code|ticket|st|token|access_token|id_token|refresh_token|session|sessionid|sid|sig|signature|sign|key|api_?key|secret|password|pwd|otp|captcha|state_token|jwt|t)$|token|secret|passw/i;
  function redactUrl(url) {
    if (url === undefined || url === null) return url;
    try {
      const u = new URL(String(url));
      for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.set(k, '•••');
      if (u.hash && u.hash.includes('=')) {
        const hp = new URLSearchParams(u.hash.slice(1));
        for (const k of [...hp.keys()]) if (SECRET_PARAM.test(k)) hp.set(k, '•••');
        u.hash = hp.toString();
      }
      if (u.username || u.password) { u.username = ''; u.password = ''; }
      return u.toString().replace(/%E2%80%A2%E2%80%A2%E2%80%A2/g, '•••');
    } catch { return String(url).replace(/([?&#](?:code|ticket|token|access_token|id_token)=)[^&#]*/gi, '$1•••'); }
  }
  // a stable wait pattern for a page reached by a click/redirect: origin + path, query ignored
  function urlPattern(url) {
    try { const u = new URL(String(url)); return u.origin + u.pathname + '*'; } catch { return null; }
  }
  // a literal that looks like PII / a credential even though its field did not say so
  const LITERAL_RISK = /^[^\s@]+@[^\s@]+\.[^\s@]+$|^\+?\d[\d\s-]{6,}\d$|^\d{15,19}$|^[A-Za-z0-9_\-.]{24,}$|^\d{17}[\dXx]$|^eyJ[\w-]+\./;

  /* ---------- targets ---------- */
  const clean = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n || 120) : undefined; };
  function targetOf(d) {
    if (!d) return null;
    const t = {};
    if (d.role) t.role = d.role;
    if (clean(d.name)) t.name = clean(d.name);
    if (clean(d.label)) t.label = clean(d.label);
    if (clean(d.placeholder)) t.placeholder = clean(d.placeholder);
    if (clean(d.testId, 80)) t.testId = clean(d.testId, 80);
    if (clean(d.text, 80) && !['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(d.role)) t.text = clean(d.text, 80);
    if (d.css) t.css = String(d.css).slice(0, 300);
    if (typeof d.nth === 'number' && d.nth > 0) t.nth = d.nth;
    if (d.frame && d.frame.url) t.frame = { url: urlPattern(d.frame.url) || undefined, ...(d.frame.name ? { name: String(d.frame.name).slice(0, 60) } : {}) };
    return t;
  }
  const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');
  // replay order: semantic first, CSS last (the CSS path is a fallback only)
  function targetSpecs(t) {
    if (!t) return [];
    const out = [];
    if (t.role && t.name) out.push({ role: t.role, name: t.name, exact: true });
    if (t.label) out.push({ label: t.label, exact: true });
    if (t.placeholder) out.push({ selector: `[placeholder="${cssEsc(t.placeholder)}"]` });
    if (t.testId) out.push({ selector: `[data-testid="${cssEsc(t.testId)}"]` });
    if (t.role && t.name) out.push({ role: t.role, name: t.name });
    if (t.text) out.push({ text: t.text, exact: true });
    if (t.css) out.push({ selector: t.css });
    return out;
  }
  function sameTarget(a, b) {
    if (!a || !b) return false;
    if (a.css && b.css && a.css === b.css && (a.name || '') === (b.name || '')) return true;
    return !!(a.role && a.role === b.role && a.name && a.name === b.name && (a.css || '') === (b.css || ''));
  }
  function describeTarget(t) {
    if (!t) return '?';
    if (t.role && t.name) return `${t.role}「${t.name}」`;
    return t.label || t.placeholder || t.text || t.testId || t.css || '?';
  }

  /* ---------- vars ---------- */
  function varKey(base, used) {
    let k = String(base || 'value').toLowerCase()
      .replace(/邮箱|email/g, 'email').replace(/密码|password|passwd|pwd/g, 'password').replace(/验证码|otp|code/g, 'otp')
      .replace(/手机|电话|phone|mobile|tel/g, 'phone').replace(/账号|用户名|username|account|login/g, 'account')
      .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'value';
    if (/^\d/.test(k)) k = 'v_' + k;
    let n = k, i = 2;
    while (used[n]) n = `${k}_${i++}`;
    return n;
  }


  /* ---------- 录制 2.0: network shape, noise, captcha ---------- */
  // response / request bodies keep their STRUCTURE; values are replaced by their type. Short business status
  // fields (code / message / status …) keep the original text, because that is what a replay waits on.
  const KEEP_KEY = /^(code|status|state|success|succ|ok|errcode|errno|err_?code|error_?code|result_?code|ret|retcode|resultcode|message|msg|errmsg|err_?msg|error|error_?message|error_?msg|reason|type|result|status_?code|status_?text|biz_?code|sub_?code|sub_?msg)$/i;
  const URLISH = /^(https?:)?\/\/[^\s]+$|^\/[\w\-./%]+\.(png|jpe?g|gif|webp|svg|pdf|js|css)(\?|$)/i;
  function maskValue(v, key, depth, opt) {
    if (v === null || v === undefined) return v;
    if (depth > opt.depth) return '<…>';
    // a request body keeps NO value (its 「code」 is a verification code); a response keeps short status fields —
    // never a 6+ digit run (that is a code / an id, not a status)
    const keep = !opt.noKeep && key !== undefined && KEEP_KEY.test(String(key));
    if (typeof v === 'string') {
      if (keep && v.length <= 80 && !LITERAL_RISK.test(v.trim()) && !URLISH.test(v) && !/\d{6,}/.test(v)) return v;
      return URLISH.test(v.trim()) ? '<url>' : `<str:${v.length}>`;
    }
    if (typeof v === 'number') return keep && Math.abs(v) < 100000 ? v : '<num>';
    if (typeof v === 'boolean') return keep ? v : '<bool>';
    if (Array.isArray(v)) {
      const out = v.slice(0, opt.items).map((x) => maskValue(x, undefined, depth + 1, opt));
      if (v.length > opt.items) out.push(`<+${v.length - opt.items}>`);
      return out;
    }
    if (typeof v === 'object') {
      const o = {}; let n = 0;
      for (const k of Object.keys(v)) { if (n++ >= opt.keys) { o['<more>'] = Object.keys(v).length - opt.keys; break; } o[k] = maskValue(v[k], k, depth + 1, opt); }
      return o;
    }
    return `<${typeof v}>`;
  }
  // body (string) -> masked string; JSON keeps its tree, a form keeps its keys, anything else becomes <text:N>
  function maskBody(body, mime, maxLen, request) {
    if (body === undefined || body === null) return undefined;
    const str = String(body);
    const cap = maxLen || 6000;
    let j;
    try { j = JSON.parse(str); } catch { j = undefined; }
    if (j !== undefined && j !== null && typeof j === 'object') {
      for (const opt of [{ depth: 8, items: 3, keys: 60 }, { depth: 5, items: 1, keys: 30 }, { depth: 3, items: 1, keys: 12 }]) {
        const m = JSON.stringify(maskValue(j, undefined, 0, { ...opt, noKeep: !!request }));
        if (m.length <= cap) return m;
      }
      return JSON.stringify({ '<truncated>': str.length });
    }
    if (/^[\w.%\-[\]]+=/.test(str) && !/\s/.test(str.slice(0, 200))) {
      const o = {};
      try { for (const [k, v] of new URLSearchParams(str)) o[k] = !request && KEEP_KEY.test(k) && v.length <= 40 && !LITERAL_RISK.test(v) && !/\d{6,}/.test(v) ? v : `<str:${v.length}>`; } catch { /* noop */ }
      return JSON.stringify(o).slice(0, cap);
    }
    if (/html/i.test(mime || '') || /^\s*</.test(str)) return `<html:${str.length}>`;
    return `<text:${str.length}>`;
  }
  const STATIC_TYPES = /^(Image|Stylesheet|Script|Font|Media|Manifest|TextTrack|Prefetch|SignedExchange|CSPViolationReport)$/;
  const STATIC_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|m4a|ogg|wav)(\?|$)/i;
  function isStaticRequest(r) {
    if (!r) return false;
    if (STATIC_TYPES.test(r.type || '')) return true;
    if ((r.type || '') === 'Document' || /^(XHR|Fetch|EventSource|WebSocket)$/.test(r.type || '')) return false;
    try { return STATIC_EXT.test(new URL(r.url).pathname); } catch { return false; }
  }
  // the same request repeated at a steady pace (a status poll) -> one row {poll:{count, everyMs, from, to}}
  function reqKey(r) {
    let path = r.url;
    try { const u = new URL(r.url); path = u.origin + u.pathname + '?' + [...new Set(u.searchParams.keys())].sort().join('&'); } catch { /* keep */ }
    return (r.method || 'GET') + ' ' + path + ' ' + (r.tabId === undefined ? '' : r.tabId);
  }
  function foldRequests(list, minCount) {
    const min = minCount || 3;
    const groups = new Map();
    (list || []).forEach((r, i) => { if (!r) return; const k = reqKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
    const folded = new Map(); // first index -> poll info
    const drop = new Set();
    for (const idx of groups.values()) {
      if (idx.length < min) continue;
      const ts = idx.map((i) => Number(list[i].ts) || 0);
      const gaps = ts.slice(1).map((t, k) => t - ts[k]).filter((g) => g >= 0).sort((a, b) => a - b);
      const med = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)] : 0;
      if (!(med > 0 && med <= 30000 && gaps[gaps.length - 1] <= Math.max(3 * med, med + 3000) && gaps[0] >= med / 3)) continue; // not a steady poll
      const statuses = {};
      for (const i of idx) { const st = String(list[i].status === undefined ? '' : list[i].status); statuses[st] = (statuses[st] || 0) + 1; }
      folded.set(idx[0], { count: idx.length, everyMs: med, from: ts[0], to: ts[ts.length - 1], statuses });
      for (const i of idx.slice(1)) drop.add(i);
    }
    const out = [];
    (list || []).forEach((r, i) => { if (!r || drop.has(i)) return; out.push(folded.has(i) ? { ...r, poll: folded.get(i) } : r); });
    return out;
  }
  // a request that belongs to a human-verification (slider / puzzle) widget -> who runs it (阿里云 …), or null
  const CAPTCHA_HOST = [
    [/(captcha|nocaptcha|afs)[\w.-]*\.aliyun(cs)?\.com$|^cf\.aliyun\.com$/i, '阿里云'], [/geetest\.com$/i, '极验'],
    [/(^|\.)captcha\.qq\.com$|captcha\.gtimg\.com$/i, '腾讯'], [/(^|\.)recaptcha\.net$/i, 'reCAPTCHA'], [/hcaptcha\.com$/i, 'hCaptcha'],
    [/(^|\.)dun\.163\.com$|163yun\.com$/i, '网易易盾'], [/challenges\.cloudflare\.com$/i, 'Cloudflare'],
  ];
  function captchaVendor(url) {
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    for (const [re, name] of CAPTCHA_HOST) if (re.test(u.host)) return name;
    const tail = u.pathname + u.search;
    if (/aliyun|alicdn/i.test(u.host) && /captcha|nocaptcha|\/afs/i.test(tail)) return '阿里云';
    if (/(^|\.)(google|gstatic)\.com$/i.test(u.host) && /recaptcha/i.test(u.pathname)) return 'reCAPTCHA';
    if (/captcha/i.test(u.pathname) && !STATIC_EXT.test(u.pathname)) return '人机校验';
    return null;
  }

  /* ---------- validation ---------- */
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function validTarget(t) { return isObj(t) && targetSpecs(t).length > 0; }
  function validate(flow) {
    const errors = [];
    const e = (m) => { if (errors.length < 50) errors.push(m); };
    if (!isObj(flow)) return { ok: false, errors: ['flow must be an object'] };
    if (flow.schema !== SCHEMA) e(`schema must be "${SCHEMA}"`);
    if (!Array.isArray(flow.steps)) e('steps must be an array');
    const vars = isObj(flow.vars) ? flow.vars : {};
    if (flow.vars !== undefined && !isObj(flow.vars)) e('vars must be an object');
    for (const [k, v] of Object.entries(vars)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(k)) e(`var name "${k}" must match [a-z][a-z0-9_]*`);
      if (!isObj(v) || !VAR_KINDS.includes(v.kind)) { e(`var ${k}: kind must be one of ${VAR_KINDS.join('/')}`); continue; }
      if (isSecretKind(v.kind) && ('value' in v || 'default' in v || 'sample' in v)) e(`var ${k}: a ${v.kind} variable never carries a value`);
      if (PII_KINDS.includes(v.kind) && ('value' in v || 'sample' in v)) e(`var ${k}: a ${v.kind} variable never carries a value`);
    }
    // 录制 2.0: human-written goal / exception-branch notes, per-step notes, per-step 「after」 (what the step
    // triggered: requests / UI changes / storage key names) — all optional, older readers ignore them
    if (flow.goal !== undefined && (typeof flow.goal !== 'string' || flow.goal.length > 500)) e('goal must be a string (≤500)');
    if (flow.branches !== undefined && (typeof flow.branches !== 'string' || flow.branches.length > 4000)) e('branches must be a string (≤4000)');
    const tabs = new Set(['t0', ...Object.entries(isObj(flow.tabs) ? flow.tabs : {}).filter(([k, v]) => /^t\d+$/.test(k) && isObj(v) && v.existing === true).map(([k]) => k)]);
    const ids = new Set();
    const usedVars = new Set();
    const checkValue = (v, where) => {
      if (isObj(v)) {
        if (typeof v.var !== 'string') e(`${where}: value object must be {var:"name"}`);
        else if (!vars[v.var]) e(`${where}: undeclared var "${v.var}"`);
        else usedVars.add(v.var);
      } else if (!['string', 'number', 'boolean'].includes(typeof v)) e(`${where}: value must be a literal or {var}`);
    };
    const walk = (steps, path, depth) => {
      if (!Array.isArray(steps)) return;
      steps.forEach((s, i) => {
        const w = `${path}[${i}]`;
        if (!isObj(s)) { e(`${w}: step must be an object`); return; }
        if (!STEP_TYPES.includes(s.type)) { e(`${w}: unknown step type "${s.type}"`); return; }
        if (s.id !== undefined) { if (ids.has(s.id)) e(`${w}: duplicate id ${s.id}`); ids.add(s.id); }
        const tab = s.tab || 't0';
        if (!/^t\d+$/.test(tab)) e(`${w}: tab must look like t0, t1 …`);
        else if (!tabs.has(tab)) e(`${w}: tab ${tab} is used before a step opens it`);
        const needT = () => { if (!validTarget(s.target)) e(`${w} (${s.type}): target needs role+name / label / placeholder / testId / text / css`); };
        if (s.note !== undefined && (typeof s.note !== 'string' || s.note.length > 500)) e(`${w}: note must be a string (≤500)`);
        if (s.after !== undefined) {
          const a = s.after;
          if (!isObj(a)) e(`${w}: after must be an object`);
          else {
            if (a.requests !== undefined && (!Array.isArray(a.requests) || a.requests.some((r) => !isObj(r) || typeof r.url !== 'string'))) e(`${w}: after.requests must be [{method, url}]`);
            if (a.ui !== undefined && (!Array.isArray(a.ui) || a.ui.some((u) => !isObj(u) || typeof u.text !== 'string'))) e(`${w}: after.ui must be [{kind, text}]`);
          }
        }
        switch (s.type) {
          case 'navigate': if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) e(`${w}: navigate.url must be http(s)`); break;
          case 'click': needT();
            if (s.opens !== undefined) { if (!/^t\d+$/.test(s.opens) || s.opens === 't0') e(`${w}: opens must be a new tab ref (t1, t2 …)`); else tabs.add(s.opens); }
            break;
          case 'fill': needT(); checkValue(s.value, w); break;
          case 'select': needT(); checkValue(s.value, w); break;
          case 'check': needT(); if (typeof s.checked !== 'boolean') e(`${w}: check.checked must be boolean`); break;
          case 'press':
            if (typeof s.key !== 'string' || !KEY_RE.test(s.key)) e(`${w}: press.key not supported: ${s.key}`);
            if (s.mods !== undefined && (!Array.isArray(s.mods) || s.mods.some((m) => !MODS.includes(m)))) e(`${w}: press.mods must be a subset of ${MODS.join('/')}`);
            if (s.target !== undefined) needT();
            break;
          case 'upload': needT(); if (!isObj(s.value) || !vars[s.value.var] || vars[s.value.var].kind !== 'file') e(`${w}: upload.value must be {var} of kind file`); else usedVars.add(s.value.var); break;
          case 'wait': case 'assert': {
            const c = s.type === 'wait' ? s.for : s.that;
            if (!isObj(c)) { e(`${w}: ${s.type === 'wait' ? 'for' : 'that'} must be an object`); break; }
            const keys = ['text', 'textGone', 'url', 'selector', 'visible', 'value', 'title'].filter((k) => c[k] !== undefined);
            if (keys.length !== 1) e(`${w}: give exactly one condition (text / textGone / url / selector / visible / value / title)`);
            if (c.visible !== undefined && !validTarget(c.visible)) e(`${w}: visible needs a target`);
            if (c.value !== undefined && (!isObj(c.value) || !validTarget(c.value.target) || c.value.equals === undefined)) e(`${w}: value needs {target, equals}`);
            if (s.type === 'wait' && c.value !== undefined) e(`${w}: wait cannot check a value (use assert)`);
            break;
          }
          case 'scroll': if (s.to !== undefined && !['bottom', 'top'].includes(s.to)) e(`${w}: scroll.to is bottom|top`);
            if (s.times !== undefined && !(Number.isInteger(s.times) && s.times > 0 && s.times <= 200)) e(`${w}: scroll.times 1..200`);
            break;
          case 'extract': {
            const p = s.provider || 'builtin';
            if (!PROVIDERS.includes(p)) e(`${w}: provider must be one of ${PROVIDERS.join('/')}`);
            if (s.into !== undefined && !/^[a-z][a-z0-9_]{0,31}$/.test(s.into)) e(`${w}: into must be a name`);
            if (p === 'builtin' && !s.auto && !isObj(s.list) && !isObj(s.fields) && !s.meta && !s.attachments) e(`${w}: extract needs auto, list{item, fields}, fields{}, meta or attachments`);
            if (s.auto !== undefined && ![true, 'links', 'list'].includes(s.auto)) e(`${w}: auto is true | "links" | "list"`);
            if (isObj(s.list) && ((typeof s.list.item !== 'string' && typeof s.list.itemXPath !== 'string') || !isObj(s.list.fields))) e(`${w}: list needs item (CSS) or itemXPath, and fields`);
            for (const [k, f] of Object.entries(Object.assign({}, isObj(s.fields) ? s.fields : {}, isObj(s.list) && isObj(s.list.fields) ? s.list.fields : {}))) {
              if (!isObj(f)) { e(`${w}: field ${k} must be an object`); continue; }
              if (f.regex !== undefined) { try { new RegExp(f.regex); } catch { e(`${w}: field ${k} regex invalid`); } }
            }
            break;
          }
          case 'paginate':
            if (!(isObj(s.next) && s.next.auto === true) && !validTarget(s.next)) e(`${w}: paginate.next needs a target or {auto:true}`);
            if (!(Number.isInteger(s.maxPages) && s.maxPages >= 1 && s.maxPages <= 500)) e(`${w}: paginate.maxPages 1..500`);
            if (depth > 0) e(`${w}: paginate cannot nest`);
            if (!Array.isArray(s.body) || !s.body.length) e(`${w}: paginate.body must be a non-empty step list`);
            else { if (s.body.some((b) => b && (b.type === 'paginate' || b.type === 'visit'))) e(`${w}: paginate cannot nest`); walk(s.body, w + '.body', depth + 1); }
            break;
          case 'visit':
            if (typeof s.from !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(s.from)) e(`${w}: visit.from must name collected rows (e.g. "rows")`);
            if (s.urlField !== undefined && typeof s.urlField !== 'string') e(`${w}: visit.urlField must be a field name`);
            if (!(Number.isInteger(s.max) && s.max >= 1 && s.max <= 500)) e(`${w}: visit.max 1..500`);
            if (depth > 0) e(`${w}: visit cannot nest`);
            if (!Array.isArray(s.body) || !s.body.length || s.body.some((b) => !b || !['extract', 'wait', 'assert', 'scroll', 'click'].includes(b.type))) e(`${w}: visit.body: extract / wait / assert / scroll / click steps only`);
            else walk(s.body, w + '.body', depth + 1);
            break;
          case 'closeTab': if (tab === 't0') e(`${w}: the start tab t0 is not closed by a flow`); break;
          case 'userStep': if (!USER_REASONS.includes(s.reason)) e(`${w}: userStep.reason must be ${USER_REASONS.join('/')}`); break;
          case 'waitInput':
            if (typeof s.var !== 'string' || !vars[s.var]) e(`${w}: waitInput.var must name a declared variable`);
            else usedVars.add(s.var);
            if (s.prompt !== undefined && typeof s.prompt !== 'string') e(`${w}: waitInput.prompt must be a string`);
            break;
          case 'output':
            if (typeof s.name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(s.name)) e(`${w}: output.name must be a name`);
            if (s.target === undefined && !isObj(s.request)) e(`${w}: output needs a target (element) or request {method, url} + path`);
            if (s.target !== undefined) needT();
            if (isObj(s.request) && (typeof s.request.url !== 'string' || typeof s.path !== 'string')) e(`${w}: output.request needs url, and path`);
            break;
          default: break;
        }
      });
    };
    walk(flow.steps, 'steps', 0);
    return { ok: errors.length === 0, errors, usedVars: [...usedVars] };
  }

  /* ---------- recording -> flow ---------- */
  const TEXTISH = /^(textbox|searchbox|spinbutton)$/;
  function isTexty(d) { return !!d && (TEXTISH.test(d.role || '') || (d.tag === 'input' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/.test(d.type || '')) || d.tag === 'textarea' || d.editable); }
  function isCheckish(d) { return !!d && ((d.tag === 'input' && /^(checkbox|radio)$/.test(d.type || '')) || /^(checkbox|radio|switch)$/.test(d.role || '') || d.labelFor === 'check'); }
  // ≤1.16 recordings: kind 'input' (password value '•••'), descriptor {name: name attribute, ariaLabel, text}
  function legacyStep(s) {
    if (!s || !s.el || !('ariaLabel' in s.el || s.kind === 'input')) return s.kind === 'input' ? { ...s, kind: 'fill' } : s;
    const o = s.el;
    const content = /^(button|a|summary|label)$/.test(o.tag || '') || /^(button|link|menuitem|tab|option)$/.test(o.role || '');
    const el = { tag: o.tag, type: o.type, role: o.role, name: o.ariaLabel || (content ? o.text : undefined), label: o.ariaLabel,
      placeholder: o.placeholder, nameAttr: o.name, id: o.id, css: o.css, autocomplete: o.autocomplete, wasPassword: o.wasPassword,
      text: content ? o.text : undefined };
    for (const k of Object.keys(el)) if (el[k] === undefined) delete el[k];
    const out = { ...s, el };
    if (s.kind === 'input') { out.kind = 'fill'; if (s.value === '•••' || o.type === 'password' || o.wasPassword) { out.secret = 'password'; delete out.value; } }
    return out;
  }
  // 录制 2.0: each action step learns what it set off — the API requests it triggered (same tab, until the
  // next action, ≤ 8 s; static files and steady polls left out), the UI change it caused (a dialog / a toast / a
  // button that changed its text), and which storage keys changed (names only). The export waits on these.
  // 1.29.1: storage key NAMES can carry what the person typed (e.g. demoUser:user01). Before a key name is
  // kept, every value typed in this recording (≥ 3 chars) and every segment that looks like PII / a credential is
  // masked to •••; the shape of the key (prefix, separators) stays so the step still reads.
  function typedValues(list) {
    const out = new Set();
    for (const s of list || []) {
      if (!s || !/^(input|fill|select)$/.test(s.kind || '')) continue;
      const v = typeof s.value === 'string' ? s.value.trim() : (typeof s.value === 'number' ? String(s.value) : '');
      if (v.length >= 3 && v !== '•••' && v.length <= 2000) out.add(v);
    }
    return [...out].sort((a, b) => b.length - a.length);
  }
  const segRisky = (seg) => seg.length >= 5 && LITERAL_RISK.test(seg) && !/^[A-Za-z_\-.]+$/.test(seg);
  function maskKeyName(key, typed) {
    let k = String(key == null ? '' : key);
    const low = () => k.toLowerCase();
    for (const v of typed || []) {
      const lv = v.toLowerCase(); let i;
      while ((i = low().indexOf(lv)) >= 0) k = k.slice(0, i) + '•••' + k.slice(i + v.length);
    }
    k = k.split(/([:|/#=,;&?_\s]+)/).map((seg) => (segRisky(seg) ? '•••' : seg)).join('');
    k = k.replace(/\d{8,}/g, '•••'); // a phone / an id / a long number glued into the name
    return k;
  }
  function maskStorageKeys(list, typed) { return (Array.isArray(list) ? list : []).map((x) => maskKeyName(x, typed)); }
  function annotateAfter(steps, raw, rec, opts, tabRef) {
    const reqs = foldRequests(((opts && opts.requests) || (rec && rec.requests) || []).filter((r) => r && !r.outOfGroup && !isStaticRequest(r) && !captchaVendor(r.url)));
    // a captcha mark is not an action of the person: it neither gets nor ends a window
    const acts = steps.filter((x) => x._rts && !(x.type === 'userStep' && x.reason === 'captcha'));
    const tabOf = (id) => (id === undefined || id === null ? 't0' : (tabRef.get(id) || null));
    // 1.29.1: what the person typed never reaches a key name or a UI text kept in the flow
    const typed = typedValues((rec && Array.isArray(rec.steps) ? rec.steps : null) || raw);
    const hasTyped = (t) => { const l = String(t).toLowerCase(); return typed.some((v) => l.includes(v.toLowerCase())); };
    acts.forEach((a, k) => {
      const t0 = a._rts;
      const nx = acts[k + 1];
      const end = Math.min(t0 + 8000, nx ? nx._rts : Infinity);
      const inWin = (x) => x && Number(x.ts) >= t0 - 50 && Number(x.ts) < end && tabOf(x.tabId) === a.tab;
      const rq = []; const seen = new Set();
      for (const r of reqs) {
        if (!inWin(r) || r.poll || !/^(XHR|Fetch)$/.test(r.type || '')) continue;
        const u = urlPattern(redactUrl(r.url)); const key = (r.method || 'GET') + ' ' + u;
        if (!u || seen.has(key)) continue;
        seen.add(key); rq.push({ method: r.method || 'GET', url: u, ...(r.status ? { status: r.status } : {}) });
      }
      const ui = []; const store = { local: new Set(), cookie: new Set(), removed: new Set() };
      const mk = (key) => maskKeyName(String(key).slice(0, 60), typed);
      for (const x of raw) {
        if (!inWin(x)) continue;
        if (x.kind === 'ui' && x.ui && x.ui.text && ui.length < 3 && !ui.some((u) => u.text === x.ui.text) && !hasTyped(x.ui.text)) ui.push({ kind: String(x.ui.kind || 'text').slice(0, 12), text: clean(x.ui.text, 60) });
        if (x.kind === 'storage') {
          for (const area of ['local', 'cookie']) { const d = x[area] || {}; for (const key of [...(d.added || []), ...(d.changed || [])]) store[area].add(mk(key)); for (const key of d.removed || []) store.removed.add(area + ':' + mk(key)); }
        }
      }
      const after = {};
      if (rq.length) after.requests = rq.slice(0, 4);
      if (ui.length) after.ui = ui;
      if (store.local.size || store.cookie.size || store.removed.size) after.storage = { ...(store.local.size ? { local: [...store.local].slice(0, 20) } : {}), ...(store.cookie.size ? { cookie: [...store.cookie].slice(0, 20) } : {}), ...(store.removed.size ? { removed: [...store.removed].slice(0, 20) } : {}) };
      if (Object.keys(after).length) a.after = after;
    });
  }
  function fromRecording(rec, opts) {
    opts = opts || {};
    const raw = (rec && Array.isArray(rec.steps) ? rec.steps : []).filter((s) => s && !s.outOfGroup && !s.deleted).map(legacyStep); // IA v1: steps the owner deleted while recording are gone
    const tabRef = new Map(); // tabId -> tN
    const tabInfo = {};
    let tabN = 0;
    const refOf = (tabId) => {
      if (tabId === undefined || tabId === null) return 't0';
      if (!tabRef.has(tabId)) tabRef.set(tabId, 't' + (tabN++));
      return tabRef.get(tabId);
    };
    // the start tab is t0
    const firstTab = raw.find((s) => s.tabId !== undefined && s.kind !== 'tabOpened');
    if (rec && rec.startTabId !== undefined) refOf(rec.startTabId); else if (firstTab) refOf(firstTab.tabId);
    const vars = {};
    const steps = [];
    const notes = [];
    let lastAction = null; // last emitted click/press/fill step (for waits / opens)
    const push = (s) => { steps.push(s); return s; };
    const startUrl = rec && rec.startTab && rec.startTab.url;
    if (startUrl && /^https?:/.test(startUrl)) push({ type: 'navigate', tab: 't0', url: startUrl });
    const outNames = {};
    const sameValue = new Map(); // kind|recorded value -> var (in memory only: the value is never written to the flow)
    const varFor = (d, kind, recorded) => {
      const base = d.label || d.name || d.placeholder || d.nameAttr || d.id || kind;
      // one var per field (same field typed twice = same var); PII typed with the SAME value in
      // two fields (e.g. the account at sign-up and at login) = one var
      const sig = kind + '|' + (d.css || '') + '|' + (d.label || d.name || '');
      for (const [k, v] of Object.entries(vars)) if (v._sig === sig) return k;
      const vkey = recorded !== undefined && recorded !== '' && PII_KINDS.includes(kind) ? kind + '|' + recorded : null;
      if (vkey && sameValue.has(vkey)) return sameValue.get(vkey);
      const key = varKey(SECRET_KINDS.includes(kind) || PII_KINDS.includes(kind) ? (kind === 'account' ? 'account' : kind) : base, vars);
      vars[key] = { kind, label: clean(d.label || d.name || d.placeholder, 40) || kind, secret: isSecretKind(kind), _sig: sig };
      if (vkey) sameValue.set(vkey, key);
      return key;
    };
    // IA v1: 「设为变量」 while recording — the owner named a fill / select value as a text
    // variable; the recorded value becomes its sample (shown as 示例; never for secret / PII fields)
    const ownerVar = (s) => {
      const label = clean(s.varName, 40);
      for (const [k, v] of Object.entries(vars)) if (v._owner === label) return k;
      const key = varKey(label, vars);
      vars[key] = { kind: 'text', label, _owner: label };
      const sample = s.value == null ? '' : String(s.value).slice(0, 120);
      if (sample) vars[key].sample = sample;
      return key;
    };
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      const tab = refOf(s.tabId);
      const d = s.el ? { ...s.el, frame: s.frame && !s.frame.top ? s.frame : undefined } : null;
      const tgt = d ? targetOf(d) : null;
      const nextOf = (pred, within) => { for (let j = i + 1; j < raw.length && j <= i + (within || 4); j++) if (pred(raw[j])) return j; return -1; };
      switch (s.kind) {
        case 'navigate': {
          if (!/^https?:/.test(s.url || '')) break;
          const typed = s.cause === 'typed' || s.cause === 'reload';
          const prevNav = [...steps].reverse().find((x) => x.tab === tab && (x.type === 'navigate' || (x.type === 'wait' && x.for && x.for.url)));
          const pat = urlPattern(s.url);
          if (typed || (!lastAction && !steps.some((x) => x.tab === tab && x.type !== 'navigate'))) {
            if (!(prevNav && prevNav.type === 'navigate' && prevNav.url === s.url)) push({ type: 'navigate', tab, url: s.url });
          } else if (pat && !(prevNav && prevNav.type === 'wait' && prevNav.for.url === pat) && !(prevNav && prevNav.type === 'navigate' && urlPattern(prevNav.url) === pat)) {
            push({ type: 'wait', tab, for: { url: pat } });
          }
          break;
        }
        case 'tabOpened': {
          const nt = refOf(s.tabId);
          tabInfo[nt] = { popup: !!s.popup };
          // the click (in the opener tab) that opened it
          const opener = s.openerTabId !== undefined ? refOf(s.openerTabId) : null;
          const c = [...steps].reverse().find((x) => x.type === 'click' && (!opener || x.tab === opener) && !x.opens);
          if (c) c.opens = nt;
          else notes.push(`tab ${nt} opened without a recorded click`);
          if (s.url && /^https?:/.test(s.url) && !steps.some((x) => x.tab === nt && x.type === 'wait' && x.for && x.for.url === urlPattern(s.url))) push({ type: 'wait', tab: nt, for: { url: urlPattern(s.url) } });
          break;
        }
        case 'tabClosed': {
          const c = [...steps].reverse().find((x) => x.tab === tab);
          if (c && c.type === 'click') c.closes = true;
          break;
        }
        case 'click': {
          if (!tgt) break;
          // a click on a field that is then typed into: the fill focuses it
          if (isTexty(d) && nextOf((n) => (n.kind === 'fill' || n.kind === 'press') && n.el && n.el.css === d.css, 6) >= 0) break;
          // checkbox / radio (or its label): the check step carries the state
          if (isCheckish(d) && nextOf((n) => n.kind === 'check', 2) >= 0) break;
          if (d.tag === 'select') break;
          // component select: open + option click -> one select step
          if (d.comp === 'select') {
            const j = nextOf((n) => n.kind === 'click' && n.el && n.el.comp === 'option', 3);
            if (j >= 0) { lastAction = push({ type: 'select', tab, target: tgt, value: clean(raw[j].el.optionText || raw[j].el.name || raw[j].el.text, 120) || '', kind: 'combobox' }); i = j; break; }
          }
          if (d.comp === 'datepicker') {
            const j = nextOf((n) => n.kind === 'click' && n.el && n.el.comp === 'datecell', 4);
            if (j >= 0) { lastAction = push({ type: 'fill', tab, target: tgt, value: raw[j].el.date || '', kind: 'date' }); i = j; break; }
          }
          if (d.comp === 'option' || d.comp === 'datecell') { notes.push('a dropdown option / date cell click without its opener was kept as a plain click'); }
          if (s.cat === 'pay' || s.cat === 'grant') {
            lastAction = push({ type: 'userStep', tab, reason: s.cat, target: tgt, note: s.cat === 'pay' ? '付款由主人亲自完成，回放到这里停下' : '授权由主人亲自完成，回放到这里停下' });
            break;
          }
          const prev = steps[steps.length - 1];
          // double click events on the same thing within 300 ms (label + control): one click
          if (prev && prev.type === 'click' && prev.tab === tab && sameTarget(prev.target, tgt) && s.ts && prev._ts && s.ts - prev._ts < 300) break;
          lastAction = push({ type: 'click', tab, target: tgt, _ts: s.ts });
          break;
        }
        case 'fill': {
          if (!tgt) break;
          const kind = s.secret || fieldKind(d);
          let value;
          if (s.secret || isSecretKind(kind) || PII_KINDS.includes(kind)) value = { var: varFor(d, kind, s.secret ? undefined : s.value) };
          else if (s.varName) value = { var: ownerVar(s) };
          else value = String(s.value == null ? '' : s.value).slice(0, 2000);
          // 录制 2.0: a one-time code is only known while the flow runs -> 「wait for outside input」 first
          if (kind === 'otp' && value && value.var) {
            const pv = steps[steps.length - 1];
            if (!(pv && pv.type === 'waitInput' && pv.var === value.var) && !(pv && pv.type === 'fill' && pv.value && pv.value.var === value.var)) {
              push({ type: 'waitInput', tab, var: value.var, prompt: (vars[value.var] && vars[value.var].label) || '验证码' });
            }
          }
          const prev = steps[steps.length - 1];
          if (prev && prev.type === 'fill' && prev.tab === tab && sameTarget(prev.target, tgt)) { prev.value = value; break; }
          const st = { type: 'fill', tab, target: tgt, value };
          if (d.editable) st.kind = 'contenteditable';
          if (d.type && /^(date|time|datetime-local|month|week)$/.test(d.type)) st.kind = 'date';
          lastAction = push(st);
          break;
        }
        case 'select': if (tgt) lastAction = push({ type: 'select', tab, target: tgt, value: s.varName ? { var: ownerVar(s) } : String(s.value == null ? '' : s.value).slice(0, 300) }); break;
        case 'check': if (tgt) {
          const prev = steps[steps.length - 1];
          if (prev && prev.type === 'check' && prev.tab === tab && sameTarget(prev.target, tgt)) { prev.checked = !!s.checked; break; }
          lastAction = push({ type: 'check', tab, target: tgt, checked: !!s.checked });
        } break;
        case 'press': {
          if (!KEY_RE.test(s.key || '')) break;
          const st = { type: 'press', tab, key: s.key };
          const mods = (s.mods || []).filter((m) => MODS.includes(m));
          if (mods.length) st.mods = mods;
          if (tgt && (isTexty(d) || d.role)) st.target = tgt;
          lastAction = push(st);
          break;
        }
        case 'upload': if (tgt) { const k = varKey('file', vars); vars[k] = { kind: 'file', label: clean(d.label || d.name, 40) || '文件' }; lastAction = push({ type: 'upload', tab, target: tgt, value: { var: k } }); } break;
        case 'scroll': {
          const prev = steps[steps.length - 1];
          if (prev && prev.type === 'scroll' && prev.tab === tab) { if (s.to === 'bottom') prev.to = 'bottom'; prev.times = Math.min(200, (prev.times || 1) + 1); break; }
          push({ type: 'scroll', tab, ...(s.to === 'bottom' ? { to: 'bottom' } : { dy: Math.max(-20000, Math.min(20000, Math.round(Number(s.dy) || 600))) }) });
          break;
        }
        case 'captcha': {
          // 录制 2.0 HARD LINE: a human-verification check is only MARKED — nothing of it is recorded
          // (no drag track); the replay stops here and the owner does it
          const pv = steps[steps.length - 1];
          if (pv && pv.type === 'userStep' && pv.reason === 'captcha') { if (s.vendor && !pv.vendor) pv.vendor = String(s.vendor).slice(0, 20); break; }
          const vendor = s.vendor ? String(s.vendor).slice(0, 20) : '';
          lastAction = push({ type: 'userStep', tab, reason: 'captcha', ...(vendor ? { vendor } : {}), note: `这里出现人机校验${vendor ? '（' + vendor + '）' : ''}：回放到这里停下，交给主人亲手完成（FoxPaw 不录轨迹、不自动过）` });
          break;
        }
        case 'copy': {
          // 录制 2.0: what the owner copied becomes a flow OUTPUT — linked to the response field it came
          // from (the recorder side matched it; the copied text itself is never stored)
          const st = { type: 'output', tab, name: varKey((d && (d.label || d.name || d.placeholder)) || (s.from && s.from.path ? String(s.from.path).split(/[.[\]]/).filter(Boolean).pop() : '') || 'copied', outNames) };
          outNames[st.name] = true;
          if (s.from && s.from.url && typeof s.from.path === 'string') { st.request = { method: String(s.from.method || 'GET').toUpperCase(), url: urlPattern(redactUrl(s.from.url)) || redactUrl(s.from.url) }; st.path = s.from.path.slice(0, 200); }
          if (tgt && s.fromElement) st.target = tgt;
          if (st.request || st.target) push(st); else notes.push('a copy with no source (not in a response, no element) was not kept');
          break;
        }
        default: break;
      }
      if (steps.length && steps[steps.length - 1] === lastAction && lastAction._rts === undefined) { lastAction._rts = s.ts || 0; lastAction._rtab = s.tabId; }
    }
    annotateAfter(steps, raw, rec, opts, tabRef);
    // collection: the same 「next page」 click repeated → paginate + extract (auto list)
    const out = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.type === 'click' && !s.opens) {
        let j = i; const run = [s];
        while (j + 1 < steps.length) {
          const n = steps[j + 1];
          if (n.type === 'click' && n.tab === s.tab && sameTarget(n.target, s.target)) { run.push(n); j++; }
          else if (n.type === 'wait' && n.tab === s.tab && run.length) { j++; }
          else break;
        }
        if (run.length >= 2 || (opts.collect && run.length >= 1 && /下一页|next|›|»|更多|load more/i.test(s.target.name || s.target.text || ''))) {
          out.push({ type: 'paginate', tab: s.tab, next: s.target, maxPages: run.length + 1, body: [{ type: 'extract', tab: s.tab, auto: true, into: 'rows' }] });
          i = j; continue;
        }
      }
      out.push(s);
    }
    // a tab that was already open (not opened by a recorded click): the replay caller maps it
    const opened = new Set(['t0']);
    for (const s of out) if (s.opens) opened.add(s.opens);
    for (const s of out) for (const x of [s, ...(s.body || [])]) if (x.tab && !opened.has(x.tab)) { tabInfo[x.tab] = { ...(tabInfo[x.tab] || {}), existing: true }; }
    let n = 0;
    for (const s of out) { delete s._ts; delete s._rts; delete s._rtab; s.id = 's' + (++n); if (s.body) for (const b of s.body) { delete b._ts; b.id = 's' + n + '.' + (s.body.indexOf(b) + 1); } }
    for (const v of Object.values(vars)) { delete v._sig; delete v._owner; }
    const flow = {
      schema: SCHEMA, name: (rec && rec.name) || '未命名流程', createdAt: (rec && (rec.stoppedAt || rec.startedAt)) || new Date(0).toISOString(),
      source: (rec && rec.source) || 'human', vars, tabs: { t0: { role: 'start' }, ...Object.fromEntries(Object.entries(tabInfo).map(([k, v]) => [k, v])) }, steps: out,
    };
    if (rec && rec.goal) flow.goal = String(rec.goal).slice(0, 500);
    if (rec && rec.gap) flow.gap = true; // service worker restarted while recording: steps may be missing
    if (notes.length) flow.notes = notes.slice(0, 20);
    return flow;
  }

  /* ---------- cloud copy ---------- */
  function redactFlow(flow) {
    const f = JSON.parse(JSON.stringify(flow || {}));
    f.redacted = true;
    f.vars = f.vars || {};
    let n = 0;
    const scrubStep = (s) => {
      if (s.url) s.url = redactUrl(s.url);
      if (s.for && s.for.url) s.for.url = redactUrl(s.for.url);
      if (s.that && s.that.url) s.that.url = redactUrl(s.that.url);
      for (const t of [s.target, s.next, s.that && s.that.visible, s.that && s.that.value && s.that.value.target]) if (t && t.frame && t.frame.url) t.frame.url = redactUrl(t.frame.url);
      if ((s.type === 'fill' || s.type === 'select') && typeof s.value === 'string' && LITERAL_RISK.test(s.value.trim()) && !/^\d{4}-\d{2}-\d{2}$/.test(s.value.trim())) {
        const k = varKey('redacted_' + (++n), f.vars);
        f.vars[k] = { kind: 'text', label: describeTarget(s.target), redactedLiteral: true };
        s.value = { var: k };
      }
      if (s.that && s.that.value && typeof s.that.value.equals === 'string' && LITERAL_RISK.test(s.that.value.equals.trim())) s.that.value.equals = '•••';
      if (s.after && s.after.storage) for (const a of ['local', 'cookie', 'removed']) if (Array.isArray(s.after.storage[a])) s.after.storage[a] = maskStorageKeys(s.after.storage[a], []); // 
      if (s.body) s.body.forEach(scrubStep);
    };
    (f.steps || []).forEach(scrubStep);
    for (const v of Object.values(f.vars)) { delete v.value; delete v.default; delete v.sample; }
    return f;
  }

  /* ---------- Playwright (JS) export ---------- */
  const J = (v) => JSON.stringify(v);
  function pwLocators(t) {
    // ordered candidates, each a (page|frame) => Locator expression
    const c = [];
    if (t.role && t.name) c.push(`(p) => p.getByRole(${J(t.role)}, { name: ${J(t.name)}, exact: true })`);
    if (t.label) c.push(`(p) => p.getByLabel(${J(t.label)}, { exact: true })`);
    if (t.placeholder) c.push(`(p) => p.getByPlaceholder(${J(t.placeholder)}, { exact: true })`);
    if (t.testId) c.push(`(p) => p.getByTestId(${J(t.testId)})`);
    if (t.role && t.name) c.push(`(p) => p.getByRole(${J(t.role)}, { name: ${J(t.name)} })`);
    if (t.text) c.push(`(p) => p.getByText(${J(t.text)}, { exact: true })`);
    if (t.css) c.push(`(p) => p.locator(${J(t.css)})`);
    return `[${c.join(', ')}], ${t.nth ? t.nth : 'undefined'}, ${t.frame && t.frame.url ? J(t.frame.url) : 'undefined'}`;
  }
  const envName = (k) => 'FP_' + k.toUpperCase();
  function toPlaywright(flow, opts) {
    opts = opts || {};
    const v = validate(flow);
    if (!v.ok) throw new Error('invalid flow: ' + v.errors.join('; '));
    const L = [];
    const vars = flow.vars || {};
    const cmt = (t) => String(t || '').replace(/\r?\n/g, ' ').replace(/\*\//g, '* /').slice(0, 300);
    // 录制 2.0: variables filled by a waitInput step are asked for WHILE the script runs (callback /
    // polling), never read up front from the environment
    const inputVars = new Set();
    const outReqs = [];
    const walkAll = (steps) => (steps || []).forEach((x) => { if (x.type === 'waitInput') inputVars.add(x.var); if (x.type === 'output' && x.request) outReqs.push({ key: x.name, method: x.request.method || 'GET', url: x.request.url }); if (x.body) walkAll(x.body); });
    walkAll(flow.steps);
    L.push(`// FoxPaw 流程导出（${SCHEMA}）：${cmt(flow.name)}`);
    if (flow.goal) L.push(`// 目标：${cmt(flow.goal)}`);
    if (flow.branches) for (const ln of String(flow.branches).split(/\r?\n/).filter(Boolean).slice(0, 20)) L.push(`// 异常分支：${cmt(ln)}`);
    // 3.8.7 the site's notes (站点经验) travel with the export, as comments for a local AI / the reader
    const notes = Array.isArray(opts.notes) ? opts.notes.filter((n) => n && n.text).slice(0, 30) : [];
    for (const n of notes) {
      L.push(`// 站点经验${n.site ? '（' + cmt(n.site) + '）' : ''}${n.topic ? ' · ' + cmt(n.topic) : ''}：${cmt(n.title)}`);
      for (const ln of String(n.text).split(/\r?\n/).filter((x) => x.trim()).slice(0, 40)) L.push(`//   ${cmt(ln)}`);
    }
    L.push('// 运行：npm i playwright 后，变量用环境变量给，例如：');
    L.push('//   ' + (Object.keys(vars).filter((k) => !inputVars.has(k)).map((k) => `${envName(k)}=…`).join(' ') || '') + ' node flow.js');
    if (inputVars.size) {
      L.push(`// 运行中等外部输入（${[...inputVars].join('、')}，如验证码）：脚本跑到那一步才要值——`);
      L.push('//   作为模块：require(\'./flow.js\')({ onInput: async ({ name, prompt }) => 取到的值 })');
      L.push('//   命令行：FP_INPUT_DIR=<目录> 时轮询 <目录>/<变量名> 文件（读到即删）；在终端里运行则直接提问。');
    }
    L.push('// FP_CDP=<CDP 地址> 可连到已开的浏览器；FP_CHROMIUM=<路径> 指定浏览器；HEADED=1 显示窗口。');
    L.push('// 付款 / 授权 / 人机校验步骤（userStep）不由脚本执行：脚本停在那里，退出码 3，由主人亲自完成。');
    L.push('// 返回（模块）/ 最后一行输出（命令行）：{ ok, data, outputs }。');
    L.push("'use strict';");
    L.push("const { chromium } = require('playwright');");
    L.push(`const V = {${Object.keys(vars).map((k) => inputVars.has(k) ? `\n  ${k}: undefined, // ${vars[k].kind}：运行中等外部输入（askInput）` : `\n  ${k}: process.env.${envName(k)}, // ${vars[k].kind}${vars[k].secret ? '（秘密：只从环境变量来，不写进脚本）' : ''}`).join('')}\n};`);
    L.push(`function need(k) { if (V[k] === undefined || V[k] === '') throw new Error('缺少环境变量 FP_' + k.toUpperCase()); return V[k]; }`);
    L.push(`// 运行中等外部输入：回调（模块用法）> 轮询 FP_INPUT_DIR/<名字> > 终端提问
async function askInput(name, prompt, opts, step) {
  if (opts && typeof opts.onInput === 'function') {
    const v = await opts.onInput({ name, prompt, step });
    if (v === undefined || v === null || String(v) === '') throw new Error('外部输入为空：' + name);
    return String(v);
  }
  const dir = process.env.FP_INPUT_DIR;
  if (dir) {
    const fs = require('fs'); const f = require('path').join(dir, name);
    const limit = (Number(process.env.FP_INPUT_TIMEOUT) || 300) * 1000; const t0 = Date.now();
    console.error('[FoxPaw] 第 ' + step + ' 步等外部输入「' + prompt + '」：请把值写进 ' + f);
    for (;;) {
      try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) { try { fs.unlinkSync(f); } catch (e) { /* keep */ } return v; } } catch (e) { /* not yet */ }
      if (Date.now() - t0 > limit) throw new Error('等外部输入超时：' + prompt);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (process.stdin.isTTY) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
    const v = await new Promise((r) => rl.question(prompt + '：', r)); rl.close(); return String(v).trim();
  }
  throw new Error('第 ' + step + ' 步要外部输入「' + prompt + '」：用模块回调 onInput、FP_INPUT_DIR 轮询目录，或在终端里运行');
}
// 步骤触发的接口：动作前开始等、动作后收（等不到只警告，不失败）
const globRe = (g) => new RegExp('^' + String(g).replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*') + '$');
function waitReq(p, list) {
  return Promise.all(list.map((x) => p.waitForResponse((r) => r.request().method() === x.method && globRe(x.url).test(r.url()), { timeout: Number(process.env.FP_REQ_TIMEOUT) || 15000 })
    .catch(() => console.error('[FoxPaw] 没等到请求 ' + x.method + ' ' + x.url))));
}
async function softText(p, texts) {
  for (const t of texts) await p.getByText(t).first().waitFor({ timeout: 5000 }).catch(() => console.error('[FoxPaw] 没看到界面变化「' + t + '」'));
}
function pick(o, path) {
  let v = o;
  for (const k of String(path).split(/\\.|\\[(\\d+)\\]/).filter((x) => x !== undefined && x !== '')) { if (v === null || v === undefined) return undefined; v = v[/^\\d+$/.test(k) ? Number(k) : k]; }
  return v;
}
`);
    L.push(`// one poll over the page's frames (main first, a recorded frame hint first when given): the first
// candidate that matches exactly one element wins; nth picks among several (recorded duplicates)
async function inAnyFrame(page, cands, nth, frameHint) {
  const t0 = Date.now();
  const limit = Number(process.env.FP_TIMEOUT) || 10000;
  for (;;) {
    if (page.isClosed()) throw new Error('标签已关闭');
    let frames = page.frames();
    if (frameHint) { const pre = frameHint.replace(/\\*$/, ''); frames = [...frames.filter((f) => f.url().startsWith(pre)), ...frames.filter((f) => !f.url().startsWith(pre))]; }
    for (const c of cands) {
      for (const f of frames) {
        const l = c(f);
        const n = await l.count().catch(() => 0);
        if (n === 1) return l;
        if (n > 1 && nth !== undefined) return l.nth(nth);
      }
    }
    if (Date.now() - t0 > limit) throw new Error('找不到唯一的目标元素');
    await new Promise((r) => setTimeout(r, 150));
  }
}
`);
    L.push(`const pageExtract = ${pageExtract.toString()};
const pageFindNext = ${pageFindNext.toString()};
async function extractRows(p, spec) {
  // like the extension: a list / auto extract waits (≤5 s) until rows are there and the page is not 「加载中」
  const t0 = Date.now();
  for (;;) { const r = await p.evaluate(pageExtract, spec); if (!(spec.list || spec.auto) || (r.rows.length && !r.loading) || Date.now() - t0 > 5000) return r; await p.waitForTimeout(150); }
}`);
    L.push('const CLI = require.main === module;');
    L.push('async function main(opts) {');
    L.push('  opts = opts || {};');
    L.push(`  const browser = process.env.FP_CDP ? await chromium.connectOverCDP(process.env.FP_CDP) : await chromium.launch({ headless: !process.env.HEADED, executablePath: process.env.FP_CHROMIUM || undefined });`);
    L.push('  const context = browser.contexts()[0] || await browser.newContext();');
    L.push('  const tabs = { t0: await context.newPage() };');
    L.push('  const data = {}, outputs = {};');
    L.push('  let n = 0, visiting = null, result;');
    if (outReqs.length) {
      // 输出变量来自接口：录制时复制的值在哪个请求的哪个字段，运行时就从那个响应里取
      L.push(`  const OUT_REQ = ${J(outReqs)};`);
      L.push('  const lastBody = {};');
      L.push("  context.on('response', async (r) => { for (const o of OUT_REQ) { if (r.request().method() === o.method && globRe(o.url).test(r.url())) { try { lastBody[o.key] = await r.json(); } catch (e) { /* not JSON */ } } } });");
    }
    L.push('  try {');
    const val = (x) => (x && typeof x === 'object' ? `need(${J(x.var)})` : J(String(x)));
    const emit = (s, ind) => {
      const I = ' '.repeat(ind);
      const p = `tabs.${s.tab || 't0'}`;
      const T = (t) => `await inAnyFrame(${p}, ${pwLocators(t)})`;
      L.push(`${I}n = ${J(s.id || '')}; // ${s.type}${s.target ? ' ' + describeTarget(s.target).replace(/[\r\n]/g, ' ') : ''}`);
      if (s.note) L.push(`${I}// 备注：${cmt(s.note)}`);
      const af = s.after || {};
      if (af.storage) L.push(`${I}// 这一步改了存储（只记键名）：${[af.storage.local && 'localStorage ' + af.storage.local.join('、'), af.storage.cookie && 'cookie ' + af.storage.cookie.join('、'), af.storage.removed && '删除 ' + af.storage.removed.join('、')].filter(Boolean).join('；')}`);
      const wreq = Array.isArray(af.requests) && af.requests.length && ['click', 'fill', 'select', 'check', 'press', 'upload'].includes(s.type);
      const wui = Array.isArray(af.ui) && af.ui.length && ['click', 'fill', 'select', 'check', 'press', 'upload'].includes(s.type);
      if (wreq || wui) { L.push(`${I}{`); if (wreq) L.push(`${I}  const _w = waitReq(${p}, ${J(af.requests.map((r) => ({ method: r.method || 'GET', url: r.url })))});`); }
      const closeAfter = () => { if (wreq) L.push(`${I}  await _w;`); if (wui) L.push(`${I}  await softText(${p}, ${J(af.ui.map((u) => u.text))});`); if (wreq || wui) L.push(`${I}}`); };
      switch (s.type) {
        case 'navigate': L.push(`${I}await ${p}.goto(${J(s.url)});`); break;
        case 'click':
          if (s.opens) {
            L.push(`${I}{ const [np] = await Promise.all([context.waitForEvent('page'), (${T(s.target)}).click()]); tabs.${s.opens} = np; await np.waitForLoadState('domcontentloaded').catch(() => {}); }`);
          } else if (s.closes) L.push(`${I}await (${T(s.target)}).click({ noWaitAfter: true }).catch((e) => { if (!${p}.isClosed()) throw e; });`);
          else L.push(`${I}await (${T(s.target)}).click();`);
          break;
        case 'fill':
          if (s.kind === 'date') L.push(`${I}{ const l = ${T(s.target)}; if (await l.evaluate((e) => !!e.closest('.ant-picker'))) { await l.click(); await l.fill(${val(s.value)}); await l.press('Enter'); } else await l.fill(${val(s.value)}); }`);
          else L.push(`${I}await (${T(s.target)}).fill(String(${val(s.value)}));`);
          break;
        case 'select':
          L.push(`${I}{ const l = ${T(s.target)}; if (await l.evaluate((e) => e.tagName === 'SELECT')) await l.selectOption({ label: ${val(s.value)} }); else { await l.click(); await ${p}.getByRole('option', { name: ${val(s.value)} }).or(${p}.getByTitle(${val(s.value)}, { exact: true })).first().click(); } }`);
          break;
        case 'check': L.push(`${I}await (${T(s.target)}).setChecked(${s.checked ? 'true' : 'false'});`); break;
        case 'press': {
          const combo = [...(s.mods || []), s.key === 'Space' ? ' ' : s.key].join('+');
          L.push(s.target ? `${I}await (${T(s.target)}).press(${J(combo)});` : `${I}await ${p}.keyboard.press(${J(combo)});`);
          break;
        }
        case 'upload': L.push(`${I}await (${T(s.target)}).setInputFiles(need(${J(s.value.var)}));`); break;
        case 'wait': case 'assert': {
          const c = s.type === 'wait' ? s.for : s.that;
          const to = `{ timeout: ${Number(s.timeout) || 15000} }`;
          if (c.url) L.push(`${I}await ${p}.waitForURL(${J(c.url)}, ${to});`);
          else if (c.text) L.push(`${I}await ${p}.getByText(${J(c.text)}).first().waitFor(${to});`);
          else if (c.textGone) L.push(`${I}await ${p}.getByText(${J(c.textGone)}).first().waitFor({ state: 'hidden', timeout: ${Number(s.timeout) || 15000} });`);
          else if (c.selector) L.push(`${I}await ${p}.locator(${J(c.selector)}).first().waitFor({ state: ${J(c.state || 'visible')}, timeout: ${Number(s.timeout) || 15000} });`);
          else if (c.visible) L.push(`${I}await (${T(c.visible)}).waitFor(${to});`);
          else if (c.title) L.push(`${I}if (!(await ${p}.title()).includes(${J(c.title)})) throw new Error('断言失败：标题不含 ' + ${J(c.title)});`);
          else if (c.value) L.push(`${I}{ const got = await (${T(c.value.target)}).inputValue().catch(async () => (await (${T(c.value.target)}).innerText())); if (String(got) !== String(${val(c.value.equals)})) throw new Error('断言失败：值是 ' + got); }`);
          break;
        }
        case 'scroll':
          L.push(`${I}for (let i = 0; i < ${s.times || 1}; i++) { await ${p}.mouse.wheel(0, ${s.to === 'bottom' ? 100000 : s.to === 'top' ? -100000 : (s.dy || 600)}); await ${p}.waitForTimeout(${Number(s.waitMs) || 300}); }`);
          break;
        case 'extract': {
          if ((s.provider || 'builtin') !== 'builtin') { L.push(`${I}throw new Error('采集提供方 ${s.provider} 尚未接入');`); break; }
          const into = J(s.into || 'rows');
          L.push(`${I}{ const r = await extractRows(${p}, ${J({ list: s.list, fields: s.fields, auto: s.auto, meta: s.meta, attachments: s.attachments, max: s.max })}); (data[${into}] = data[${into}] || []).push(...r.rows.map((x) => (visiting ? { ...x, _sourceUrl: visiting } : x))); if (r.meta) (data.meta = data.meta || []).push(r.meta); if (r.attachments) (data.attachments = data.attachments || []).push(...r.attachments); }`);
          break;
        }
        case 'paginate':
          L.push(`${I}for (let page = 1; page <= ${s.maxPages}; page++) {`);
          for (const b of s.body) emit(b, ind + 2);
          L.push(`${I}  if (page === ${s.maxPages}) break;`);
          if (s.next && s.next.auto) {
            L.push(`${I}  const f = await ${p}.evaluate(pageFindNext);`);
            L.push(`${I}  if (!f.found || f.disabled) break;`);
            L.push(`${I}  const next = ${p}.locator('[data-foxpaw-next]').first();`);
          } else {
            L.push(`${I}  const next = ${T(s.next)};`);
            L.push(`${I}  if (await next.isDisabled().catch(() => true)) break;`);
          }
          L.push(`${I}  const before = await ${p}.evaluate(() => document.body.innerText);`);
          L.push(`${I}  await next.click();`);
          L.push(`${I}  await ${p}.waitForFunction((b) => document.body.innerText !== b && !/加载中|loading/i.test(document.body.innerText), before, { timeout: 15000 });`);
          L.push(`${I}}`);
          break;
        case 'visit':
          L.push(`${I}{ const list = (data[${J(s.from)}] || []).map((x) => x && x[${J(s.urlField || 'url')}]).filter((u) => /^https?:/.test(u || '')).slice(0, ${s.max});`);
          L.push(`${I}  for (const u of list) { visiting = u; try { await ${p}.goto(u);`);
          for (const b of s.body) emit(b, ind + 4);
          L.push(`${I}  } catch (e) { (data.failures = data.failures || []).push({ url: u, error: String(e && e.message || e) }); } } visiting = null; }`);
          break;
        case 'closeTab': L.push(`${I}await ${p}.close();`); break;
        case 'userStep':
          L.push(`${I}console.log(${J(`停在第 ${s.id} 步：${s.reason === 'pay' ? '付款' : s.reason === 'grant' ? '授权' : s.reason === 'captcha' ? '人机校验' + (s.vendor ? '（' + s.vendor + '）' : '') : '需要主人亲自操作'}（${s.note || ''}）—— 脚本不代办，请主人亲自完成。`)});`);
          L.push(`${I}result = { ok: false, stoppedAt: n, reason: ${J(s.reason)}, data, outputs };`);
          L.push(`${I}if (CLI) { console.log(JSON.stringify(result)); process.exitCode = 3; }`);
          L.push(`${I}return result;`);
          break;
        case 'waitInput':
          L.push(`${I}V[${J(s.var)}] = await askInput(${J(s.var)}, ${J(s.prompt || (vars[s.var] && vars[s.var].label) || s.var)}, opts, n);`);
          break;
        case 'output': {
          L.push(`${I}{ let v;`);
          if (s.request) {
            L.push(`${I}  for (let i = 0; i < 50 && lastBody[${J(s.name)}] === undefined; i++) await ${p}.waitForTimeout(100);`);
            L.push(`${I}  v = pick(lastBody[${J(s.name)}], ${J(s.path)});`);
          }
          if (s.target) L.push(`${I}  if (v === undefined) v = await (${T(s.target)}).evaluate((e) => ('value' in e && e.tagName !== 'BUTTON' ? e.value : e.innerText));`);
          L.push(`${I}  outputs[${J(s.name)}] = v; }`);
          break;
        }
        default: break;
      }
      closeAfter();
    };
    for (const s of flow.steps) emit(s, 4);
    L.push("    result = { ok: true, data, outputs };");
    L.push("    if (CLI) console.log(JSON.stringify(result));");
    L.push('  } catch (e) {');
    L.push("    result = { ok: false, at: n, error: String(e && e.message || e), data, outputs };");
    L.push("    console.error('第 ' + n + ' 步失败：' + (e && e.message || e));");
    L.push('    if (CLI) process.exitCode = 1;');
    L.push('  } finally {');
    L.push('    if (!process.env.FP_KEEP_OPEN) await (process.env.FP_CDP ? Promise.resolve() : browser.close());');
    L.push('  }');
    L.push('  return result;');
    L.push('}');
    L.push('module.exports = main;');
    L.push('if (CLI) main({});');
    return L.join('\n') + '\n';
  }

  /* ---------- page-side collection (runs inside the page: self-contained, no closures) ----------
     Collection heuristics (non-LLM, self-contained):
       - list detection: main-content area, nav/sidebar/footer
         exclusion, row ancestor, container clustering (biggest ≥5, ≥2× runner-up, gap ≥5), date in row
       - field rules: CSS or XPath, attribute, text regex
       - page metadata: meta / og: / twitter: / JSON-LD (no prompt guessing)
       - attachments: links to documents / files, typed by extension
       - next page: pager container, 下一页 text, framework
         next classes, current page number + 1 — FoxPaw only LOCATES it; the click goes through execCore.
     Not included: LLM extraction / AI field recommendation, cloud document parsing, login/quota/sync. */
  function pageExtract(spec) {
    spec = spec || {};
    const tx = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const xp = (expr, ctx) => { const out = []; try { const r = document.evaluate(expr, ctx || document, null, 7, null); for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i)); } catch (e) { throw new Error('BAD_XPATH ' + expr); } return out; };
    const one = (root, f) => {
      let n = root;
      if (f.sel) { try { n = root.querySelector(f.sel); } catch (e) { throw new Error('BAD_SELECTOR ' + f.sel); } }
      else if (f.xpath) n = xp(f.xpath, root)[0] || null;
      if (!n) return null;
      let v;
      if (f.attr) { v = n.getAttribute(f.attr); if (v && /^(href|src)$/.test(f.attr)) { try { v = new URL(v, location.href).href; } catch (e) { /* keep */ } } }
      else v = tx(n.innerText !== undefined ? n.innerText : n.textContent);
      if (v != null && f.regex) { const m = String(v).match(new RegExp(f.regex)); v = m ? (m[1] !== undefined ? m[1] : m[0]) : null; }
      return v == null ? null : String(v).slice(0, 4000);
    };
    const rec = (root, fields) => { const o = {}; for (const k of Object.keys(fields)) o[k] = one(root, fields[k] || {}); return o; };
    const out = { rows: [], url: location.href };
    if (spec.list) {
      const items = spec.list.itemXPath ? xp(spec.list.itemXPath) : [...document.querySelectorAll(spec.list.item)];
      out.rows = items.slice(0, spec.max || 1000).map((el) => rec(el, spec.list.fields));
      out.mode = 'list';
    } else if (spec.fields) { out.rows = [rec(document, spec.fields)]; out.mode = 'fields'; }
    if (spec.meta) {
      const m = {};
      for (const el of document.querySelectorAll('meta[name],meta[property]')) { const k = el.getAttribute('name') || el.getAttribute('property'); if (/^(description|keywords|author|og:|twitter:|article:)/i.test(k) && el.content) m[k] = el.content.slice(0, 1000); }
      const ld = [];
      for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) { try { ld.push(JSON.parse(sc.textContent)); } catch (e) { /* skip */ } }
      out.meta = { title: document.title, url: location.href, tags: m, jsonld: ld.slice(0, 5) };
    }
    if (spec.attachments) {
      const EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|wps|ofd)(?=$|[?#])/i;
      const TYPE = { pdf: 'pdf', doc: 'word', docx: 'word', xls: 'excel', xlsx: 'excel', ppt: 'ppt', pptx: 'ppt', zip: 'archive', rar: 'archive', '7z': 'archive', csv: 'csv', txt: 'text', wps: 'word', ofd: 'ofd' };
      const seen = new Set(); const list = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href || ''; const name = tx(a.textContent);
        if (!/^https?:/i.test(href) || seen.has(href)) continue;
        const ext = (EXT.exec(new URL(href).pathname) || [])[1];
        if (!ext && !(/附件|下载/.test(name) && name.length <= 60)) continue;
        seen.add(href);
        list.push({ name: (name || decodeURIComponent(new URL(href).pathname.split('/').pop() || '附件')).slice(0, 200), url: href, type: ext ? (TYPE[ext.toLowerCase()] || 'unknown') : 'unknown' });
      }
      out.attachments = list.slice(0, 100);
    }
    if (spec.auto) {
      const ROW = 'li, tr, p, dd, dt, article, .item, .list-item, .list_item, .news-item, .article-item';
      const CHROME = 'nav, aside, footer, header, [role="navigation"], [role="banner"], [role="contentinfo"], [class*="sidebar"], [class*="side-bar"], [class*="navbar"], [class*="site-header"], [class*="site-footer"], [class*="pagination"], [class*="pager"]';
      const PAGER = /^(首页|上一页|下一页|尾页|末页|more|更多|\d+|\.\.\.|>|<|›|‹|>>|<<)$/i;
      let rows = [];
      if (spec.auto !== 'list') {
        // links mode (GrabCrab list detection, simplified)
        const cands = []; const seen = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.href || ''; const title = tx(a.getAttribute('title') || a.textContent);
          if (!href || /^javascript:/i.test(href) || title.length < 5 || PAGER.test(title) || seen.has(href)) continue;
          try { if (new URL(href).origin !== location.origin) continue; } catch (e) { continue; }
          try { if (a.closest(CHROME)) continue; } catch (e) { /* old engines */ }
          seen.add(href);
          const row = a.closest(ROW) || a.parentElement;
          const ctx = row ? tx(row.textContent) : title;
          const dm = ctx.match(/(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2})/);
          cands.push({ el: a, box: (row && row.parentElement) || a.parentElement, item: { title, url: href, date: dm ? dm[1] : '', context: ctx.slice(0, 300) } });
        }
        const groups = new Map();
        for (const c of cands) { if (!groups.has(c.box)) groups.set(c.box, []); groups.get(c.box).push(c.item); }
        const g = [...groups.values()].sort((x, y) => y.length - x.length);
        if (g.length && g[0].length >= 5 && g[0].length >= (g[1] ? g[1].length : 0) * 2 && g[0].length - (g[1] ? g[1].length : 0) >= 5) rows = g[0];
        else if (g.length && g[0].length >= 3 && g.length === 1) rows = g[0];
      }
      if (!rows.length) {
        // list mode: the biggest group of same-tag siblings carrying text (no links needed)
        let best = null;
        for (const par of document.querySelectorAll('ul,ol,tbody,div,section,dl')) {
          try { if (par.closest(CHROME)) continue; } catch (e) { /* noop */ }
          const kids = [...par.children].filter((c) => tx(c.textContent) && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(c.tagName));
          if (kids.length < 3) continue;
          const tag = kids[0].tagName; const same = kids.filter((c) => c.tagName === tag);
          if (same.length >= 3 && same.length >= kids.length * 0.8 && (!best || same.length > best.length)) best = same;
        }
        rows = (best || []).map((el) => { const a = el.querySelector && el.querySelector('a[href]'); const t = tx(el.innerText !== undefined ? el.innerText : el.textContent); return a ? { title: t.slice(0, 300), url: a.href } : { title: t.slice(0, 300) }; });
      }
      out.rows = rows.slice(0, spec.max || 1000);
      out.mode = 'auto';
    }
    out.loading = /加载中|loading/i.test(tx(document.body ? document.body.innerText || document.body.textContent : '').slice(0, 2000)) && out.rows.length <= 1;
    return out;
  }
  // locate the 「next page」 control; returns a CSS-free description the background turns into a click
  function pageFindNext() {
    const tx = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const mark = (el, how) => {
      const dis = !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || /(^|\s|-)disabled(\s|$)/.test(String(el.className || '')) || (el.closest && el.closest('.ant-pagination-disabled,.disabled')));
      el.setAttribute('data-foxpaw-next', '1');
      return { found: true, how, disabled: dis, text: tx(el.textContent).slice(0, 20) };
    };
    for (const old of document.querySelectorAll('[data-foxpaw-next]')) old.removeAttribute('data-foxpaw-next');
    const box = document.getElementById('pagination') || document.querySelector('.pagination, .pager, [class*=fenye], [class*=fanye], [class*=page-num], [class*=pageNum], .ant-pagination, .el-pagination, .layui-laypage');
    if (box) {
      for (const el of box.querySelectorAll('a, button, span, li, div')) { const t = tx(el.textContent); if (/下一页|下页|下1页|后一页|next/i.test(t) && t.length <= 10 && !el.querySelector('a,button')) return mark(el, 'pager-text'); }
      const fw = box.querySelector('.ant-pagination-next, .el-pagination .btn-next, .layui-laypage-next, .next, .page-next, [class*=next]');
      if (fw) return mark(fw.querySelector('button,a') || fw, 'pager-class');
    }
    const links = [...document.querySelectorAll('a, button, [role="button"], span[onclick], li[onclick], div[onclick]')];
    for (const el of links) { const t = tx(el.textContent); if (/^(下一页|下页|下1页|后一页|后页|next|next page|›|»|>>)$/i.test(t)) return mark(el, 'text'); }
    for (const el of links) { const t = tx(el.textContent); if (t.length <= 8 && /下一页|下页|next/i.test(t)) return mark(el, 'fuzzy'); }
    const nums = [...(box || document).querySelectorAll('a, span, li')];
    const cur = nums.find((el) => /\b(current|active|selected|on)\b/i.test(String(el.className || '')) && /^\d+$/.test(tx(el.textContent)));
    if (cur) { const n = Number(tx(cur.textContent)) + 1; const nx = nums.find((el) => el.tagName === 'A' && tx(el.textContent) === String(n)); if (nx) return mark(nx, 'page-number'); }
    return { found: false };
  }

  // Steps counted for display / run reports (paginate body counts once)
  function stepList(flow) { return (flow && Array.isArray(flow.steps)) ? flow.steps : []; }

  const api = { SCHEMA, STEP_TYPES, SECRET_KINDS, PII_KINDS, VAR_KINDS, PROVIDERS, fieldKind, isSecretKind, redactUrl, urlPattern, targetOf, targetSpecs, describeTarget,
    validate, fromRecording, redactFlow, toPlaywright, stepList, SECRET_HINT, pageExtract, pageFindNext,
    maskBody, isStaticRequest, foldRequests, captchaVendor, annotateAfter, typedValues, maskKeyName, maskStorageKeys };
  root.FoxFlow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

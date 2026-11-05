/* FoxPaw 录制探针（扩展 1.17 录制版）
   Injected into EVERY frame of an authorized tab while recording
   (registerContentScripts allFrames + matchOriginAsFallback at
   document_start for new pages; executeScript allFrames for pages already
   open). It only reports after the service worker said yes to
   foxpaw.rec.hello (tab in this browser's FoxPaw group, recording on), so
   nothing leaves a page outside the group.
   Each event becomes a semantic step: role + accessible name / label /
   placeholder / test id / text, CSS path only as a fallback. Values of
   secret fields (password — also after 显示密码 —, one-time codes, card,
   token) are NEVER read: the step says {secret:'password'} instead. */
(() => {
  const W = window;
  if (W.__fpRec2) { try { W.__fpRec2.hello(); } catch { /* old copy */ } return; }
  let on = false, asked = false;
  const queue = [];
  const send = (step) => {
    step.url = location.href;
    step.pts = Date.now(); // 1.29.1: when it happened on the page (a click's own fetch starts after this), not when the worker got it
    if (!asked) { if (queue.length < 200) queue.push(step); return; }
    if (!on) return;
    try { chrome.runtime.sendMessage({ type: 'foxpaw.rec.step', step }); } catch { /* extension reloaded */ }
  };
  const hello = () => {
    const done = (r) => { asked = true; on = !!(r && r.on); const q = queue.splice(0); if (on) { for (const s of q) send(s); setTimeout(() => { store0 = null; storeCheck(); captchaScan(); }, 50); } };
    try {
      const p = chrome.runtime.sendMessage({ type: 'foxpaw.rec.hello' }, (r) => { void (chrome.runtime && chrome.runtime.lastError); done(r); });
      if (p && typeof p.then === 'function') p.then(done, () => done(null));
    } catch { done(null); }
  };
  W.__fpRec2 = { hello, state: () => ({ on, asked }) };
  try { chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'foxpaw.rec.state') { asked = true; on = !!m.on; } }); } catch { /* stub */ }

  const tx = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const attr = (el, n) => (el && el.getAttribute && el.getAttribute(n)) || '';
  const PW = W.__foxpawRecPw = W.__foxpawRecPw || new WeakSet(); // ever type=password (survives 显示密码)
  const notePw = (root) => { try { for (const p of (root || document).querySelectorAll('input[type="password"]')) PW.add(p); } catch { /* noop */ } };
  notePw();
  document.addEventListener('focusin', (e) => { notePw(); const t = e.composedPath ? e.composedPath()[0] : e.target; if (t && t.type === 'password') PW.add(t); }, true);

  /* ---- roles / names: same rules as the page engine (background fpPage) ---- */
  const IMPLICIT = (el) => {
    const t = el.tagName; const ty = attr(el, 'type').toLowerCase();
    if (t === 'A' || t === 'AREA') return el.hasAttribute('href') ? 'link' : '';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return (el.multiple || Number(el.size) > 1) ? 'listbox' : 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'OPTION') return 'option';
    if (/^H[1-6]$/.test(t)) return 'heading';
    if (t === 'INPUT') {
      if (/^(button|submit|reset|image)$/.test(ty)) return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      if (ty === 'number') return 'spinbutton';
      if (ty === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (ty === 'hidden') return '';
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    }
    if (el.isContentEditable && el.hasAttribute('contenteditable')) return 'textbox';
    return '';
  };
  const roleOf = (el) => tx(attr(el, 'role')).split(' ')[0].toLowerCase() || IMPLICIT(el);
  const byIdIn = (el, id) => { const r = el.getRootNode && el.getRootNode(); return (r && r.getElementById ? r.getElementById(id) : null) || document.getElementById(id); };
  const labelText = (el) => {
    const own = (n) => { let t = ''; for (const c of n.childNodes) { if (c.nodeType === 3) t += c.nodeValue; else if (c.nodeType === 1 && !/^(SELECT|TEXTAREA|INPUT|OPTION|BUTTON|SCRIPT|STYLE)$/.test(c.tagName)) t += ' ' + own(c); } return t; };
    const parts = [];
    if (el.labels && el.labels.length) for (const l of el.labels) parts.push(tx(own(l)));
    return tx(parts.join(' '));
  };
  const NAME_FROM_CONTENT = /^(button|link|option|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem|heading|cell|columnheader|rowheader|switch|checkbox|radio|tooltip|row)$/;
  const accName = (el) => {
    const lb = attr(el, 'aria-labelledby');
    if (lb) { const t = tx(lb.split(/\s+/).map((id) => { const n = byIdIn(el, id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ')); if (t) return t; }
    const al = tx(attr(el, 'aria-label')); if (al) return al;
    const t = el.tagName; const ty = attr(el, 'type').toLowerCase();
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(t) && !/^(button|submit|reset|image)$/.test(ty)) { const l = labelText(el); if (l) return l; }
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
    return '';
  };
  const SECRET_HINT = /password|passwd|pwd|passcode|otp|one.?time|验证码|校验码|动态码|短信码|sms.?code|verif\w*.?code|auth.?code|captcha|cvv|cvc|security.?code|卡号|card.?(no|num)|pin(code)?\b/i;
  const secretKind = (el) => {
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName) && !el.isContentEditable) return null;
    const ty = attr(el, 'type').toLowerCase(); const ac = attr(el, 'autocomplete').toLowerCase();
    const hint = [attr(el, 'name'), el.id, attr(el, 'placeholder'), attr(el, 'aria-label'), labelText(el)].join(' ');
    if (ty === 'password' || PW.has(el) || /current-password|new-password/.test(ac)) return 'password';
    if (/one-time-code/.test(ac) || /otp|one.?time|验证码|校验码|动态码|短信码|sms.?code|verif\w*.?code|auth.?code|captcha/i.test(hint)) return 'otp';
    if (/^cc-|\scc-/.test(ac) || /cvv|cvc|security.?code|卡号|card.?(no|num)|银行卡/i.test(hint)) return 'card';
    if (/token|api.?key|secret/i.test(hint)) return 'token';
    if (SECRET_HINT.test(hint)) return 'password';
    return null;
  };
  const cssPath = (el) => {
    const parts = [];
    let n = el;
    for (let d = 0; n && n.nodeType === 1 && d < 5; d++) {
      let s = n.tagName.toLowerCase();
      if (n.id && !/\d{3,}|^:|^rc_|^el-id/.test(n.id)) { parts.unshift(s + '#' + (W.CSS && CSS.escape ? CSS.escape(n.id) : n.id)); break; }
      const p = n.parentElement;
      if (p) { const same = [...p.children].filter((c) => c.tagName === n.tagName); if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`; }
      parts.unshift(s);
      n = p;
    }
    return parts.join(' > ');
  };
  const ROLE_POOL = '[role],a,area,button,input,select,textarea,summary,option,h1,h2,h3,h4,h5,h6,img,[contenteditable]';
  const nthOf = (el, role, name) => {
    if (!role || !name) return 0;
    try {
      const same = [...document.querySelectorAll(ROLE_POOL)].slice(0, 3000).filter((x) => roleOf(x) === role && tx(accName(x)) === name);
      return same.length > 1 ? Math.max(0, same.indexOf(el)) : 0;
    } catch { return 0; }
  };
  const comp = (el) => {
    if (!el.closest) return undefined;
    if (el.closest('.ant-select-item-option,.el-select-dropdown__item,[role="option"]')) return 'option';
    if (el.closest('.ant-picker-cell,.el-date-table td')) return 'datecell';
    if (el.closest('.ant-picker,.el-date-editor')) return 'datepicker';
    if (el.closest('.ant-select,.el-select') && el.tagName !== 'SELECT') return 'select';
    return undefined;
  };
  const CLICKABLE = 'button,a[href],input,select,textarea,summary,label,option,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="radio"],[role="option"],[role="combobox"],[role="treeitem"],[role="gridcell"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
  // the element a click / key really meant: the first interactive node on the composed path
  const realTarget = (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const n of path) { if (n && n.nodeType === 1 && n.matches && n.matches(CLICKABLE)) return n; if (n === document.body) break; }
    return path[0] && path[0].nodeType === 1 ? path[0] : e.target;
  };
  // component widgets: point the step at the control a locator can find
  const widget = (el) => {
    const c = comp(el);
    if (c === 'select') { const box = el.closest('.ant-select,.el-select'); return { el: (box && box.querySelector('input[role="combobox"],input')) || el, c }; }
    if (c === 'datepicker') { const box = el.closest('.ant-picker,.el-date-editor'); return { el: (box && box.querySelector('input')) || el, c }; }
    if (c === 'option') return { el: el.closest('.ant-select-item-option,.el-select-dropdown__item,[role="option"]'), c };
    if (c === 'datecell') return { el: el.closest('.ant-picker-cell,td'), c };
    return { el, c };
  };
  const describe = (raw) => {
    const { el, c } = widget(raw);
    if (!el || !el.tagName) return null;
    const role = roleOf(el);
    const name = tx(accName(el)).slice(0, 120);
    const label = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || /^(textbox|combobox|checkbox|radio|switch|slider|spinbutton|searchbox|listbox)$/.test(role)
      ? (tx(attr(el, 'aria-label')) || labelText(el)).slice(0, 80) : '';
    const d = {
      tag: el.tagName.toLowerCase(), type: attr(el, 'type').toLowerCase() || undefined, role: role || undefined, name: name || undefined,
      label: label || undefined, placeholder: tx(attr(el, 'placeholder')).slice(0, 80) || undefined,
      testId: attr(el, 'data-testid') || attr(el, 'data-test-id') || attr(el, 'data-test') || undefined,
      text: !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? tx(el.innerText !== undefined ? el.innerText : el.textContent).slice(0, 80) || undefined : undefined,
      id: el.id || undefined, nameAttr: attr(el, 'name') || undefined, autocomplete: attr(el, 'autocomplete') || undefined,
      wasPassword: PW.has(el) || undefined, editable: (el.isContentEditable && el.tagName !== 'INPUT') || undefined,
      css: cssPath(el), comp: c, shadow: (el.getRootNode && el.getRootNode() !== document) || undefined,
    };
    const nth = nthOf(el, role, name); if (nth) d.nth = nth;
    if (c === 'option') d.optionText = tx(attr(el, 'title') || el.textContent).slice(0, 120);
    if (c === 'datecell') d.date = attr(el, 'title') || undefined;
    if (el.tagName === 'LABEL' && el.control && /^(checkbox|radio)$/.test(el.control.type || '')) d.labelFor = 'check';
    for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
    return d;
  };

  /* ---- typing: one fill step per field, flushed on change / blur / Enter / Tab / leaving ---- */
  const pending = new Map(); // element -> true
  const valueOf = (el) => (el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' ? tx(el.innerText !== undefined ? el.innerText : el.textContent) : String(el.value == null ? '' : el.value));
  // what was last reported per field, as a local signature (length + hash) that never leaves the page:
  // the same value reported twice (change + blur, or a re-focus) is one step
  const lastSig = new WeakMap();
  const sigOf = (v) => { let h = 5381; for (let i = 0; i < v.length; i++) h = ((h * 33) ^ v.charCodeAt(i)) >>> 0; return v.length + ':' + h; };
  const flush = (el) => {
    if (!pending.has(el)) return;
    if (asked && !on) { pending.delete(el); return; } // outside the recording: nothing is even looked at
    pending.delete(el);
    const sig = sigOf(valueOf(el));
    if (lastSig.get(el) === sig) return;
    lastSig.set(el, sig);
    const d = describe(el); if (!d) return;
    const sk = secretKind(el);
    if (sk) send({ kind: 'fill', el: d, secret: sk });               // the value is never read
    else send({ kind: 'fill', el: d, value: valueOf(el).slice(0, 2000) });
  };
  const flushAll = (except) => { for (const el of [...pending.keys()]) if (el !== except) flush(el); };
  const isTextField = (el) => el && ((el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/.test(attr(el, 'type').toLowerCase())) || el.tagName === 'TEXTAREA' || (el.isContentEditable && el.tagName !== 'INPUT'));
  const editableHost = (n) => { let x = n; while (x && x.nodeType === 1 && x.parentElement && x.parentElement.isContentEditable) x = x.parentElement; return x; };
  document.addEventListener('input', (e) => {
    if (asked && !on) return;
    let t = e.composedPath ? e.composedPath()[0] : e.target;
    if (t && t.isContentEditable && !/^(INPUT|TEXTAREA)$/.test(t.tagName)) t = editableHost(t);
    if (isTextField(t) && !inCaptcha(t)) pending.set(t, true);
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!t || !t.tagName || inCaptcha(t)) return;
    const ty = attr(t, 'type').toLowerCase();
    if (t.tagName === 'SELECT') { flushAll(); const d = describe(t); if (d) send({ kind: 'select', el: d, value: [...t.selectedOptions].map((o) => tx(o.label || o.textContent)).join(', ') }); return; }
    if (t.tagName === 'INPUT' && (ty === 'checkbox' || ty === 'radio')) { flushAll(); const d = describe(t); if (d) send({ kind: 'check', el: d, checked: !!t.checked }); return; }
    if (t.tagName === 'INPUT' && ty === 'file') { const d = describe(t); if (d) send({ kind: 'upload', el: d, count: (t.files || []).length }); return; }
    if (isTextField(t)) { pending.set(t, true); flush(t); }
  }, true);
  document.addEventListener('focusout', (e) => { const t = e.composedPath ? e.composedPath()[0] : e.target; if (pending.has(t)) flush(t); }, true);
  const SKIP_SHORTCUT = /^[cvxazy]$/i;
  let lastEnter = 0;
  document.addEventListener('keydown', (e) => {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (inCaptcha(t)) return;
    const mods = [e.ctrlKey && 'Control', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    const k = e.key === ' ' ? 'Space' : e.key;
    const plain = mods.filter((m) => m !== 'Shift').length === 0;
    if (/^(Enter|Tab|Escape)$/.test(k) || (!plain && /^[A-Za-z0-9]$|^F\d{1,2}$|^(Enter|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(k) && !SKIP_SHORTCUT.test(k))) {
      if (t && pending.has(t)) flush(t);
      if (k === 'Enter') lastEnter = Date.now();
      const d = t && t !== document.body && t.tagName ? describe(t) : null;
      send({ kind: 'press', key: k, mods: mods.length ? mods : undefined, el: d || undefined, ...(e.isTrusted === false ? { synthetic: true } : {}) });
    }
  }, true);
  document.addEventListener('click', (e) => {
    if (asked && !on) return;
    if (inCaptcha(e.composedPath ? e.composedPath()[0] : e.target)) return; // 录制 2.0: nothing inside a human-verification widget is recorded
    const t = realTarget(e);
    if (!t || t === document.body || t === document.documentElement) return;
    // the click a browser fires on the default button when Enter submits a form (implicit
    // submission: detail 0, no pointer position) is the Enter step, not a second action
    if (e.detail === 0 && !e.clientX && !e.clientY && Date.now() - lastEnter < 600) return;
    flushAll(isTextField(t) ? t : null);
    const d = describe(t);
    if (d) send({ kind: 'click', el: d, ...(e.isTrusted === false ? { synthetic: true } : {}) });
  }, true);
  W.addEventListener('pagehide', () => flushAll(), true);

  /* ---- 录制 2.0: copy → output, UI changes, storage key names, human-verification marks ---- */
  let lastAct = 0;
  const acted = () => { lastAct = Date.now(); setTimeout(storeCheck, 900); };
  for (const ev of ['click', 'keydown', 'change']) document.addEventListener(ev, (e) => { if (e.isTrusted !== false) acted(); }, true);
  const visible = (el) => { try { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; if (r.right <= 0 || r.bottom <= 0 || r.left >= (W.innerWidth || 1e5) || r.top >= (W.innerHeight || 1e5)) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0; } catch { return false; } };
  // human verification (slider / puzzle): MARK only — nothing inside it is ever recorded (hard line: the owner does it)
  const CAPTCHA_SEL = '[id^="nc_"][id$="_wrapper"],.nc-container,.nc_wrapper,[id^="aliyunCaptcha"],.aliyun-captcha,.geetest_panel,.geetest_holder,.geetest_box,#tcaptcha_iframe,#tcaptcha_transform,.tcaptcha-transform,iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="captcha"],.yidun,.yidun_popup,[class*="slide-verify"],[class*="slider-verify"],[class*="captcha-slider"],[class*="slidecaptcha"],[class*="slider-captcha"]';
  const vendorOf = (el) => { const k = String((el.id || '') + ' ' + (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '') + ' ' + (attr(el, 'src') || '')); return /(^|\W)nc[_-]|aliyun/i.test(k) ? '阿里云' : /geetest/i.test(k) ? '极验' : /tcaptcha/i.test(k) ? '腾讯' : /recaptcha/i.test(k) ? 'reCAPTCHA' : /hcaptcha/i.test(k) ? 'hCaptcha' : /yidun/i.test(k) ? '网易易盾' : '人机校验'; };
  const CAPTCHA_FRAME = W !== W.top && /captcha|geetest|nocaptcha|yidun|turing\./i.test(location.host + location.pathname);
  const inCaptcha = (n) => { if (CAPTCHA_FRAME) return true; try { return !!(n && n.closest && n.closest(CAPTCHA_SEL)); } catch { return false; } };
  const seenCaptcha = new WeakSet();
  const captchaScan = () => {
    if (!on) return;
    let els = [];
    try { els = [...document.querySelectorAll(CAPTCHA_SEL)]; } catch { /* noop */ }
    for (const el of els) { if (seenCaptcha.has(el) || !visible(el)) continue; seenCaptcha.add(el); send({ kind: 'captcha', vendor: vendorOf(el), via: 'page' }); return; }
  };
  // UI changes right after an action: a dialog, a toast / message, a button whose text changed (countdowns)
  const DIALOG_SEL = '[role="dialog"],[role="alertdialog"],dialog[open],.ant-modal,.el-dialog,.modal.show,.el-message-box,.arco-modal,.layui-layer';
  const TOAST_SEL = '[role="alert"],[role="status"],.ant-message-notice,.ant-notification-notice,.el-message,.el-notification,.arco-message,.toast,[class*="toast"],.layui-layer-msg';
  const seenUi = new WeakMap();
  const uiText = (el) => tx(el.innerText !== undefined ? el.innerText : el.textContent).slice(0, 60);
  const uiCheck = (el) => {
    if (!on || Date.now() - lastAct > 4000 || !el || el.nodeType !== 1) return;
    let kind = null;
    try { if (el.matches(DIALOG_SEL)) kind = 'dialog'; else if (el.matches(TOAST_SEL)) kind = 'toast'; } catch { return; }
    if (!kind || inCaptcha(el) || !visible(el)) return;
    const t = uiText(el);
    if (!t || seenUi.get(el) === t || secretKind(el)) return;
    seenUi.set(el, t);
    send({ kind: 'ui', ui: { kind, text: t } });
  };
  let btnWatch = null;
  document.addEventListener('click', (e) => {
    if (!on || inCaptcha(e.composedPath ? e.composedPath()[0] : e.target)) return;
    const t = realTarget(e);
    if (!t || !(t.tagName === 'BUTTON' || roleOf(t) === 'button')) return;
    const before = uiText(t); btnWatch = t;
    setTimeout(() => { if (btnWatch !== t || !t.isConnected) return; const now = uiText(t); if (now && now !== before) send({ kind: 'ui', ui: { kind: 'button', text: now, was: before } }); }, 1200);
  }, true);
  try {
    new MutationObserver((muts) => {
      if (!on) return;
      for (const m of muts) {
        if (m.type === 'attributes') { uiCheck(m.target); continue; }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          uiCheck(n);
          try { for (const x of n.querySelectorAll(DIALOG_SEL + ',' + TOAST_SEL)) uiCheck(x); } catch { /* noop */ }
        }
      }
      clearTimeout(captchaScan.t); captchaScan.t = setTimeout(captchaScan, 300);
    }).observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'aria-hidden'] });
  } catch { /* no observer */ }
  // storage: key NAMES only (values are hashed here and never leave the page)
  const snapStore = () => {
    const l = {}, c = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); l[k] = sigOf(String(localStorage.getItem(k) || '')); } } catch { /* blocked */ }
    try { for (const part of String(document.cookie || '').split(';')) { const i = part.indexOf('='); const k = (i < 0 ? part : part.slice(0, i)).trim(); if (k) c[k] = sigOf(i < 0 ? '' : part.slice(i + 1)); } } catch { /* blocked */ }
    return { l, c };
  };
  const diffKeys = (a, b) => ({ added: Object.keys(b).filter((k) => !(k in a)), removed: Object.keys(a).filter((k) => !(k in b)), changed: Object.keys(b).filter((k) => k in a && a[k] !== b[k]) });
  let store0 = null;
  function storeCheck() {
    if (!on) { store0 = null; return; }
    const now = snapStore();
    if (!store0) { store0 = now; return; }
    const local = diffKeys(store0.l, now.l), cookie = diffKeys(store0.c, now.c);
    store0 = now;
    const any = (d) => d.added.length + d.removed.length + d.changed.length;
    const cut = (d) => ({ added: d.added.slice(0, 20), removed: d.removed.slice(0, 20), changed: d.changed.slice(0, 20) });
    if (any(local) || any(cookie)) send({ kind: 'storage', local: cut(local), cookie: cut(cookie) });
  }
  setInterval(() => { if (on) storeCheck(); }, 2000);
  // copy: what was copied is matched to a response field by the service worker (in memory) and dropped
  let copyRec = null;
  document.addEventListener('copy', (e) => {
    if (asked && !on) return;
    let text = '', src = null;
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) { try { text = String(a.value || '').substring(a.selectionStart, a.selectionEnd); } catch { /* no selection api */ } src = a; }
    if (!text) { const sel = W.getSelection && W.getSelection(); text = sel ? String(sel) : ''; const nd = sel && sel.anchorNode; src = nd ? (nd.nodeType === 1 ? nd : nd.parentElement) : null; }
    copyRec = { text, src };
    setTimeout(() => {   // after page handlers (e.clipboardData.setData) ran
      const c = copyRec; copyRec = null;
      if (!c) return;
      const t = tx(c.text).slice(0, 2000);
      if (!t) return;
      if (c.src && secretKind(c.src)) return;                       // a secret field: never
      const fromElement = !!(c.src && c.src.isConnected && visible(c.src) && !attr(c.src, 'readonly'));
      const d = fromElement ? describe(c.src) : null;
      send({ kind: 'copy', text: t, fromElement: !!d || undefined, el: d || undefined });
    }, 0);
  }, true);
  W.addEventListener('copy', (e) => { try { const v = e.clipboardData && e.clipboardData.getData('text/plain'); if (v && copyRec) copyRec.text = v; } catch { /* noop */ } }, false);
  try { chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'foxpaw.rec.state' && m.on) { store0 = null; setTimeout(() => { storeCheck(); captchaScan(); }, 50); } }); } catch { /* stub */ }
  if (CAPTCHA_FRAME) setTimeout(() => { if (on) send({ kind: 'captcha', vendor: vendorOf({ id: '', className: location.host, getAttribute: () => '' }), via: 'frame' }); }, 300);
  /* ---- scrolling (top frame): infinite lists are collected by scrolling ---- */
  if (W === W.top) {
    let y0 = W.scrollY, timer = null;
    W.addEventListener('scroll', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const dy = W.scrollY - y0;
        if (Math.abs(dy) < 300) return;
        y0 = W.scrollY;
        const bottom = W.innerHeight + W.scrollY >= (document.documentElement.scrollHeight || 0) - 40;
        send({ kind: 'scroll', dy: Math.round(dy), ...(bottom ? { to: 'bottom' } : {}) });
      }, 400);
    }, { passive: true, capture: true });
  }
  hello();
})();

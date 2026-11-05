'use strict';
/* FoxPaw 1.26 「保存到 FoxPaw」: when the OWNER signs in by hand on a page, offer to save the
   login. Runs in the extension's isolated world (the page cannot see or call it). It only looks at a form
   at the moment it is sent (submit / Enter in a password box / a click on its sign-in button), skips
   payment pages and payment / code boxes, and hands {user, password} to the FoxPaw background, which asks
   the owner first (side panel / notification). Nothing is stored or sent anywhere else from here. */
(() => {
  if (window.__foxpawVaultCatch) return;
  window.__foxpawVaultCatch = true;
  const PAY = /checkout|cashier|payment|\/pay(\/|\?|#|$)|支付|收银台|付款|结算/i;
  const CARD = /(^|\s)cc-|card.?(no|num)|卡号|cvv|cvc|cvn|security.?code|银行卡|信用卡|支付密码|交易密码|付款密码|pay.?pass|payment.?pass|trade.?pass|transaction.?pass|u盾|ukey|安全码/i;
  const CODE = /one-time-code|otp|one.?time|验证码|校验码|动态码|短信码|sms.?code|verif\w*.?code|auth.?code|captcha|人机|图形验证/i;
  const GO = /^\s*(登\s*录|登入|立即登录|log\s*-?\s*in|sign\s*-?\s*in|continue|next|下一步|继续|进入|确定|submit)\b/i;
  const attr = (el, n) => (el && el.getAttribute && el.getAttribute(n)) || '';
  const hint = (el) => [attr(el, 'name'), el.id, attr(el, 'placeholder'), attr(el, 'aria-label'), attr(el, 'autocomplete')].join(' ');
  const shown = (el) => !!(el && el.getClientRects && el.getClientRects().length);
  let last = 0;
  function grab(from) {
    const root = (from && (from.form || (from.closest && from.closest('form')))) || document;
    const pws = [...root.querySelectorAll('input[type="password"]')].filter((p) => p.value && shown(p) && !CARD.test(hint(p)) && !CODE.test(hint(p)));
    if (!pws.length) return null;
    // a sign-up form (new + confirm, same value) or a sign-in form: the first one is the password
    const pw = pws[0];
    const inputs = [...root.querySelectorAll('input')];
    const before = inputs.slice(0, inputs.indexOf(pw)).filter((i) => /^(text|email|tel|)$/i.test(attr(i, 'type')) && i.value && shown(i) && !CODE.test(hint(i)) && !CARD.test(hint(i)) && !/search|搜索/i.test(hint(i)));
    const pref = before.filter((i) => /username|email/i.test(attr(i, 'autocomplete')) || /^email$/i.test(attr(i, 'type')) || /user|login|account|mail|phone|mobile|账号|帐号|用户名|邮箱|手机/i.test(hint(i)));
    const u = pref.pop() || before.pop();
    return { user: u ? String(u.value).trim() : '', password: String(pw.value) };
  }
  function offer(from) {
    if (Date.now() - last < 1500) return;
    if (PAY.test(location.href + ' ' + document.title)) return;
    const g = grab(from);
    if (!g) return;
    last = Date.now();
    try { chrome.runtime.sendMessage({ type: 'foxpaw.vaultCatch', user: g.user, password: g.password }, () => void (chrome.runtime.lastError)); } catch { /* extension reloaded */ }
  }
  document.addEventListener('submit', (e) => offer(e.target && e.target.querySelector ? e.target.querySelector('input[type="password"]') || e.target : null), true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && attr(e.target, 'type').toLowerCase() === 'password') offer(e.target); }, true);
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button,input[type="submit"],[role="button"]') : null;
    if (!b) return;
    const f = b.form || b.closest('form');
    const name = (b.innerText || b.value || attr(b, 'aria-label') || '').trim();
    if ((f && f.querySelector('input[type="password"]')) || GO.test(name)) offer(f ? f.querySelector('input[type="password"]') : null);
  }, true);
})();

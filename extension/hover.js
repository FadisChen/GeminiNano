// 未啟用「翻譯此頁」時，滑鼠停在文字區塊上就彈出該區塊的譯文，補足全頁翻譯遺漏的區塊
(() => {
  const N = window.__nano;
  const SKIP = 'script,style,noscript,pre,code,textarea,select,input,svg,math,[translate="no"],[data-nano-tools],.nt-run,.ytp-caption-window-container,.nt-yt';
  const DWELL = 350, MAX_CHARS = 3000;
  const cache = new Map();
  let enabled = false, timer = 0, token = 0, shown = null, ctrl = null, pool = null;
  let pos = { x: 0, y: 0 };

  chrome.storage.local.get({ hoverTranslate: true })
    .then(values => { enabled = values.hoverTranslate; })
    .catch(error => console.error('[nano] 設定讀取失敗', error));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.hoverTranslate) return;
    enabled = changes.hoverTranslate.newValue !== false;
    if (!enabled) hide();
  });

  const inline = el => /^(inline|contents)/.test(getComputedStyle(el).display);
  // 取滑鼠所在的最小文字區塊：非 inline，且自身有文字或只含 inline 子元素。
  function blockOf(el) {
    while (el && el !== document.body && el !== document.documentElement && inline(el)) el = el.parentElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.closest(SKIP) || el.isContentEditable) return null;
    const ownText = [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.data.trim());
    return ownText || [...el.children].every(inline) ? el : null;
  }

  function place(text, anchor) {
    if (window.__nt?.isOn()) return;
    const tip = N.ui().tip;
    tip.textContent = text;
    tip.hidden = false;
    const left = Math.min(anchor.x + 12, innerWidth - tip.offsetWidth - 8);
    let top = anchor.y + 18;
    if (top + tip.offsetHeight > innerHeight - 8) top = anchor.y - tip.offsetHeight - 12;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }
  function hide() {
    clearTimeout(timer);
    if (!shown) return;
    token++; shown = null;
    N.ui().tip.hidden = true;
  }
  async function show(block) {
    if (window.__nt?.isOn() || !block.isConnected) return;
    const text = block.innerText.replace(/\s+/g, ' ').trim();
    const lang = text.length >= 3 && text.length <= MAX_CHARS ? N.detect(text, block) : null;
    if (!lang) return;
    const mine = ++token, anchor = { ...pos };
    shown = block;
    place('翻譯中…', anchor);
    try {
      const key = `${lang}\n${text}`;
      let output = cache.get(key);
      if (output === undefined) {
        if (!pool) { ctrl = new AbortController(); pool = N.translatorPool(ctrl.signal); }
        output = await (await pool(lang)).translate(text, { signal: ctrl.signal });
        cache.set(key, output);
      }
      if (token === mine) place(output, anchor);
    } catch (error) {
      if (token === mine) place(`翻譯失敗：${error.message}`, anchor);
    }
  }

  document.addEventListener('mousemove', e => { pos = { x: e.clientX, y: e.clientY }; }, { passive: true });
  document.addEventListener('mouseover', e => {
    clearTimeout(timer);
    if (shown && !shown.contains(e.target)) hide();
    if (!enabled || shown || window.__nt?.isOn() || !(e.target instanceof Element)) return;
    const block = blockOf(e.target);
    if (block) timer = setTimeout(() => { void show(block); }, DWELL);
  });
  document.documentElement.addEventListener('mouseleave', hide);
  document.addEventListener('scroll', hide, { capture: true, passive: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  window.addEventListener('pagehide', () => { hide(); ctrl?.abort(); });
})();

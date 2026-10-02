// 每個頁面載入時執行的輕量載入器：只讀一次設定，依設定啟用「滑鼠停留翻譯」或請 background 注入全頁翻譯。
// 滑鼠停留翻譯：未啟用「翻譯此頁」時，滑鼠停在文字區塊上就彈出該區塊的譯文，補足全頁翻譯遺漏的區塊。
(() => {
  const N = window.__nano;
  const DWELL = 350, MAX_CHARS = 3000;
  let enabled = false, timer = 0, token = 0, shown = null, ctrl = null, pool = null;
  let pos = { x: 0, y: 0 };

  // 取滑鼠所在的最小文字區塊：非 inline，且自身有文字或只含 inline 子元素。
  function blockOf(el) {
    while (el && el !== document.body && el !== document.documentElement && N.isInline(el)) el = el.parentElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.closest(N.SKIP_BLOCK)) return null;
    const ownText = [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.data.trim());
    return ownText || [...el.children].every(child => N.isInline(child)) ? el : null;
  }

  const busy = () => window.__nt?.isOn() || window.__nt?.isPicking();

  function place(text, anchor) {
    if (busy()) return;
    const tip = N.ui().tip;
    tip.textContent = text;
    tip.hidden = false;
    const left = Math.min(anchor.x + 12, innerWidth - tip.offsetWidth - 8);
    let top = anchor.y + 18;
    if (top + tip.offsetHeight > innerHeight - 8) top = anchor.y - tip.offsetHeight - 12;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }
  const onMove = e => { pos = { x: e.clientX, y: e.clientY }; };
  function hide() {
    clearTimeout(timer);
    document.removeEventListener('mousemove', onMove);
    if (!shown) return;
    token++; shown = null;
    N.ui().tip.hidden = true;
  }
  async function show(block) {
    if (busy() || !block.isConnected) return;
    const text = block.innerText.replace(/\s+/g, ' ').trim();
    const lang = text.length >= 3 && text.length <= MAX_CHARS ? N.detect(text, block) : null;
    if (!lang) return;
    const mine = ++token, anchor = { ...pos };
    shown = block;
    place('翻譯中…', anchor);
    try {
      if (!await N.confirmLanguage(text, lang, block)) { if (token === mine) hide(); return; }
      if (!pool) { ctrl = new AbortController(); pool = N.translatorPool(ctrl.signal); }
      const output = await N.translateText(await pool(lang), lang, text, ctrl.signal);
      if (token === mine) place(output, anchor);
    } catch (error) {
      if (token === mine) place(`翻譯失敗：${error.message}`, anchor);
    }
  }

  // 只在需要時追蹤滑鼠：mouseover 找到候選區塊後才監聽 mousemove，停留計時結束即移除。
  function onOver(e) {
    clearTimeout(timer);
    if (shown && !shown.contains(e.target)) hide();
    if (shown || busy() || !(e.target instanceof Element)) return;
    const block = blockOf(e.target);
    if (!block) { document.removeEventListener('mousemove', onMove); return; }
    pos = { x: e.clientX, y: e.clientY };
    document.addEventListener('mousemove', onMove, { passive: true });
    timer = setTimeout(() => { document.removeEventListener('mousemove', onMove); void show(block); }, DWELL);
  }
  const onKey = e => { if (e.key === 'Escape') hide(); };
  const scrollOpts = { capture: true, passive: true };
  function setHover(value) {
    if (value === enabled) return;
    enabled = value;
    const method = value ? 'addEventListener' : 'removeEventListener';
    document[method]('mouseover', onOver);
    document[method]('keydown', onKey);
    document[method]('scroll', hide, scrollOpts);
    document.documentElement[method]('mouseleave', hide);
    if (!value) hide();
  }

  function autoTranslate() {
    // 子框架只在尺寸夠大且環境支援翻譯時處理，避免廣告／追蹤用的小 iframe。
    if (N.isTinyFrame() || (window !== window.top && !globalThis.Translator)) return;
    // 頁面有標示語言且不是英文就略過；沒標示的交給段落層級的語言判斷
    const lang = document.documentElement.lang.toLowerCase();
    if (lang && !/^en\b/.test(lang)) return;
    return chrome.runtime.sendMessage({ type: 'auto-translate' });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.hoverTranslate) setHover(changes.hoverTranslate.newValue !== false);
  });
  chrome.storage.local.get({ hoverTranslate: true, autoTranslate: false })
    .then(async values => {
      setHover(values.hoverTranslate);
      if (values.autoTranslate) await autoTranslate();
    })
    .catch(error => console.error('[nano] 載入失敗', error));
  window.addEventListener('pagehide', () => { hide(); ctrl?.abort(); });
})();

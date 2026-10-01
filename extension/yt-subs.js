// YouTube 雙語字幕：保留原生字幕，在其下方追加繁體中文譯文。需先在播放器開啟 CC 字幕。
(() => {
  const TARGETS = ['zh-Hant', 'zh'];
  const DEBOUNCE_MS = 350;   // 自動字幕會邊說邊更新，穩定後才翻
  const CACHE_MAX = 500;
  const CAPTION_SEL = '.ytp-caption-window-container';

  const cache = new Map();
  const translators = new Map();
  let overlay = null, mo = null, moTarget = null, ensureTimer = 0, timer = 0, ctrl = null, lastText = '';

  // 只支援 en / ja
  function detect(text) {
    if (/[぀-ヿ]/.test(text)) return 'ja';
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length < 3) return null;
    const latin = text.match(/[A-Za-z]/g) || [];
    return latin.length / letters.length > 0.8 ? 'en' : null;
  }

  function readCaption() {
    return [...document.querySelectorAll(`${CAPTION_SEL} .ytp-caption-segment`)]
      .map((s) => s.textContent).join(' ').replace(/\s+/g, ' ').trim();
  }

  // ---- 譯文浮層 ----
  function createOverlay() {
    const el = document.createElement('div');
    el.className = 'nt-yt';
    el.style.cssText = 'position:absolute;z-index:60;display:none;width:max-content;pointer-events:none;' +
      'transform:translateX(-50%);padding:2px 8px;border-radius:4px;text-align:center;color:#fff;' +
      'background:rgba(8,8,8,.75);font-family:"Microsoft JhengHei",system-ui,sans-serif;line-height:1.4;';
    return el;
  }

  function place() {
    if (!overlay || overlay.style.display === 'none') return;
    const player = overlay.parentElement;
    const wins = document.querySelectorAll(`${CAPTION_SEL} .caption-window`);
    const seg = document.querySelector(`${CAPTION_SEL} .ytp-caption-segment`);
    if (!player || !wins.length || !seg) return;
    const pr = player.getBoundingClientRect();
    const wr = wins[wins.length - 1].getBoundingClientRect();
    overlay.style.fontSize = `${parseFloat(getComputedStyle(seg).fontSize) * 0.9}px`;
    overlay.style.maxWidth = `${pr.width * 0.8}px`;
    overlay.style.left = `${wr.left + wr.width / 2 - pr.left}px`;
    let top = wr.bottom - pr.top + 4;
    if (top + overlay.offsetHeight > pr.height - 4) top = wr.top - pr.top - overlay.offsetHeight - 4; // 下方放不下就放上方
    overlay.style.top = `${Math.max(4, top)}px`;
  }

  const hide = () => { if (overlay) overlay.style.display = 'none'; };
  function show(text) {
    overlay.textContent = text;
    overlay.style.display = 'block';
    place();
  }

  // ---- Translator ----
  function getTranslator(source) {
    if (!translators.has(source)) {
      translators.set(source, (async () => {
        for (const target of TARGETS) {
          const opts = { sourceLanguage: source, targetLanguage: target };
          let avail;
          try { avail = await Translator.availability(opts); } catch { continue; }
          if (avail === 'unavailable') continue;
          if (avail !== 'available' && !navigator.userActivation.isActive) {
            await askDownload(`字幕翻譯需要下載 ${source}→${target} 語言模型`);
          }
          return Translator.create(opts);
        }
        throw new Error(`不支援 ${source} → 繁體中文`);
      })().catch((err) => { translators.delete(source); throw err; }));
    }
    return translators.get(source);
  }

  // 下載語言模型需要使用者手勢：在浮層上放一個按鈕
  function askDownload(label) {
    return new Promise((resolve) => {
      overlay.replaceChildren(label + ' ');
      const btn = document.createElement('button');
      btn.textContent = '下載';
      btn.style.cssText = 'pointer-events:auto;cursor:pointer;';
      btn.onclick = () => { btn.remove(); resolve(); };
      overlay.append(btn);
      overlay.style.display = 'block';
      place();
    });
  }

  // ---- 字幕變動 → 翻譯（以最新字幕為準）----
  async function translate(text) {
    const lang = detect(text);
    if (!lang) return hide();
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      let out = cache.get(text);
      if (out === undefined) {
        const tr = await getTranslator(lang);
        out = await tr.translate(text, { signal: ctrl.signal });
        cache.set(text, out);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      if (text === lastText) show(out);
    } catch (err) {
      if (err.name !== 'AbortError') console.error('[nt-yt]', err);
    }
  }

  function onCaption() {
    const text = readCaption();
    if (text === lastText) return place();
    lastText = text;
    clearTimeout(timer);
    if (!text) { ctrl?.abort(); return hide(); }
    timer = setTimeout(() => translate(text), cache.has(text) ? 0 : DEBOUNCE_MS);
  }

  // YouTube 是 SPA，播放器與字幕容器會被重建，定期確認觀察目標
  function ensure() {
    const player = document.querySelector('.html5-video-player');
    if (!player) return;
    if (overlay.parentElement !== player) player.append(overlay);
    const target = player.querySelector(CAPTION_SEL);
    if (target && target !== moTarget) {
      mo.disconnect();
      mo.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] });
      moTarget = target;
      onCaption();
    }
  }

  function start() {
    if (overlay) return;
    overlay = createOverlay();
    mo = new MutationObserver(onCaption);
    window.addEventListener('resize', place);
    document.addEventListener('fullscreenchange', place);
    ensure();
    ensureTimer = setInterval(ensure, 1000);
  }

  function stop() {
    if (!overlay) return;
    clearInterval(ensureTimer);
    clearTimeout(timer);
    ctrl?.abort();
    mo.disconnect();
    window.removeEventListener('resize', place);
    document.removeEventListener('fullscreenchange', place);
    overlay.remove();
    overlay = mo = moTarget = null;
    lastText = '';
  }

  const apply = (on) => (on ? start() : stop());
  chrome.storage.local.get({ ytSubtitles: false }).then((v) => apply(v.ytSubtitles));
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.ytSubtitles) apply(changes.ytSubtitles.newValue);
  });
})();

// Shared by the page translator and hover translation in the isolated world.
(() => {
  if (globalThis.__nano) return;
  const abortError = () => new DOMException('工作已取消', 'AbortError');
  const check = (signal) => { if (signal.aborted) throw abortError(); };
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function detect(text, element) {
    const hint = element?.closest('[lang]')?.lang?.toLowerCase();
    if (hint && !/^en(-|$)/.test(hint)) return null;
    const letters = text.match(/\p{L}/gu) || [];
    return letters.length >= 3 && (text.match(/[a-z]/gi) || []).length / letters.length > .8 ? 'en' : null;
  }

  // Chinese article text (no kana), used for summaries.
  function isChinese(text) {
    const letters = text.match(/\p{L}/gu) || [];
    return letters.length >= 3 && !/[぀-ヿ]/u.test(text) && (text.match(/\p{Script=Han}/gu) || []).length / letters.length > .5;
  }

  let tools;
  function ui() {
    if (tools) return tools;
    const host = el('div');
    host.dataset.nanoTools = '';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = `
      :host{color-scheme:light dark;--bg:#faf9f5;--ink:#233b33;--muted:#65736b;--line:#dce2da;--accent:#23634d;--soft:#e9efe7}
      *{box-sizing:border-box} [hidden]{display:none!important}
      .card{pointer-events:auto;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 32px #10291e26;font:14px/1.6 'Microsoft JhengHei',sans-serif;padding:14px}
      button{font:inherit;cursor:pointer;background:var(--soft);color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:5px 10px;min-height:32px}
      button:hover{border-color:var(--accent)} button:focus-visible{outline:2px solid var(--accent);outline-offset:3px} button:disabled{opacity:.55;cursor:wait}
      .dock{position:absolute;right:16px;bottom:16px;width:320px;max-width:calc(100vw - 32px);display:grid;gap:8px;max-height:45vh;overflow:auto}
      .actions{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}.label{font-size:11px;letter-spacing:.12em;color:var(--muted);margin-bottom:5px}
      .summary{position:absolute;right:16px;top:16px;width:380px;max-width:calc(100vw - 32px);max-height:calc(55vh - 40px);display:flex;flex-direction:column;padding:0}
      header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line)}
      h2{font:600 16px/1.5 'Microsoft JhengHei',sans-serif;margin:0}.body{padding:12px 18px;overflow:auto;overflow-wrap:anywhere}.body p{margin:0 0 10px}.body ul,.body ol{padding-left:1.3em;margin:0 0 10px}.body ul ul,.body ol ol,.body ul ol,.body ol ul{margin:0}.body h3{font:600 14px/1.6 'Microsoft JhengHei',sans-serif;margin:0 0 6px}.body code{font-family:Consolas,monospace;font-size:.92em}.body li{margin:5px 0}
      footer{padding:10px 16px;border-top:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap}.notice{font-size:12px;color:var(--muted)}
      .pickbox{position:fixed;border:2px solid #e5332a;background:#e5332a14;border-radius:3px;pointer-events:none;box-shadow:0 0 0 1px #ffffff99}
      .pickbar{position:fixed;left:50%;top:12px;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 24px);display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px}
      .tip{position:absolute;max-width:min(420px,calc(100vw - 24px));max-height:40vh;overflow:auto;background:#193d30;color:#fff;padding:10px 14px;border-radius:9px;font:14px/1.6 'Microsoft JhengHei',sans-serif;white-space:pre-wrap;pointer-events:none;overflow-wrap:anywhere}
      @media(prefers-color-scheme:dark){:host{--bg:#202925;--ink:#ebeee7;--muted:#acb8ae;--line:#435048;--accent:#97c8ac;--soft:#303f36}}
      @media(max-width:420px){.dock,.summary{right:8px;max-width:calc(100vw - 16px)}.dock{bottom:8px}.summary{top:8px}}
    `;
    const dock = el('div', '', 'dock');
    const summary = el('section', '', 'card summary');
    summary.hidden = true;
    summary.setAttribute('aria-label', '網頁重點摘要');
    const head = el('header');
    const close = el('button', '關閉');
    const title = el('h2', '網頁重點摘要');
    head.append(title, close);
    const body = el('div', '', 'body');
    const foot = el('footer');
    const copy = el('button', '複製摘要');
    const retry = el('button', '重試');
    const reselect = el('button', '重新選取');
    const notice = el('span', '', 'notice');
    notice.setAttribute('role', 'status');
    foot.append(copy, retry, reselect, notice);
    summary.append(head, body, foot);
    const tip = el('div', '', 'tip');
    tip.hidden = true;
    tip.setAttribute('role', 'tooltip');
    const pickBox = el('div', '', 'pickbox');
    pickBox.hidden = true;
    const pickBar = el('div', '', 'card pickbar');
    pickBar.hidden = true;
    pickBar.setAttribute('role', 'status');
    shadow.append(style, dock, summary, pickBox, pickBar, tip);
    document.documentElement.append(host);
    const cards = new Map();
    const status = (key, text, actions = []) => {
      let card = cards.get(key);
      if (!text) { card?.remove(); cards.delete(key); return; }
      if (!card) { card = el('div', '', 'card'); cards.set(key, card); dock.append(card); }
      const message = el('div', text);
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      card.replaceChildren(el('div', 'NANO · 本機處理', 'label'), message);
      if (actions.length) {
        const row = el('div', '', 'actions');
        for (const [label, action] of actions) { const button = el('button', label); button.addEventListener('click', action); row.append(button); }
        card.append(row);
      }
      return card;
    };
    // Keep tools visible when the player enters fullscreen.
    document.addEventListener('fullscreenchange', () => (document.fullscreenElement || document.documentElement).append(host));
    tools = { host, shadow, status, summary, close, body, copy, retry, reselect, notice, tip, pickBox, pickBar };
    return tools;
  }

  // Every pending model gets its own resolver. Only the first prompt is shown.
  const downloads = [];
  function showDownload() {
    const item = downloads[0];
    if (!item) { ui().status('download', ''); return; }
    if (item.started) return;
    ui().status('download', `${item.label}需要下載或準備模型。首次下載需連線。`, [
      ['下載／準備', () => item.start()], ['取消', () => item.cancel()],
    ]);
  }
  function withAbort(promise, signal, onLate) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(abortError());
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      (async () => {
        try {
          const value = await promise;
          if (signal.aborted) onLate?.(value);
          else resolve(value);
        } catch (error) { reject(error); }
        finally { signal.removeEventListener('abort', abort); }
      })();
    });
  }
  async function availability(kind, options) {
    if (!globalThis[kind]) return 'unsupported';
    try { return await globalThis[kind].availability(options); }
    catch { return 'unavailable'; }
  }
  async function createModel(kind, options, signal, label) {
    check(signal);
    const available = await availability(kind, options);
    check(signal);
    if (available === 'unsupported') throw new Error(`此頁面環境不支援 ${kind === 'Translator' ? '本機翻譯' : '本機摘要'}。`);
    if (available === 'unavailable') throw new Error(`${label}在目前裝置或語言組合不可用。`);
    const downloadController = new AbortController();
    signal = AbortSignal.any([signal, downloadController.signal]);
    const create = (monitor) => globalThis[kind].create({ ...options, signal, monitor });
    if (available === 'available') return withAbort(create(), signal, model => model.destroy());
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', cancel);
        const index = downloads.indexOf(item);
        if (index >= 0) downloads.splice(index, 1);
        showDownload();
      };
      const cancel = () => {
        if (!signal.aborted) { downloadController.abort(); return; }
        finish(); reject(abortError());
      };
      const item = { label, started: false, cancel, start: async () => {
        if (item.started || signal.aborted) return;
        item.started = true;
        try {
          // Deliberately no await before create(): preserve this click's activation.
          const pending = create(m => m.addEventListener('downloadprogress', e => {
            if (!signal.aborted && downloads[0] === item) ui().status('download', `${label}準備中 ${Math.round(e.loaded * 100)}%`, [['取消', cancel]]);
          }));
          ui().status('download', `${label}準備中…`, [['取消', cancel]]);
          resolve(await withAbort(pending, signal, model => model.destroy()));
        } catch (error) { reject(error); }
        finally { finish(); }
      } };
      signal.addEventListener('abort', cancel, { once: true });
      downloads.push(item);
      showDownload();
    });
  }
  function translatorPool(signal) {
    const pending = new Map();
    const models = new Set();
    signal.addEventListener('abort', () => {
      for (const model of models) model.destroy();
      models.clear(); pending.clear();
    }, { once: true });
    const names = { en: '英文', zh: '中文', 'zh-Hant': '繁中' };
    return function get(source, target = 'zh-Hant') {
      check(signal);
      const key = `${source}>${target}`;
      if (!pending.has(key)) {
        pending.set(key, (async () => {
          try {
            const model = await createModel('Translator', { sourceLanguage: source, targetLanguage: target }, signal, `${names[source]} → ${names[target]}`);
            if (signal.aborted) { model.destroy(); throw abortError(); }
            models.add(model);
            return model;
          } catch (error) { pending.delete(key); throw error; }
        })());
      }
      return pending.get(key);
    };
  }
  // ---- DOM helpers shared by page translation and hover translation ----
  const SKIP = 'script,style,noscript,textarea,select,input,svg,math,pre,[translate="no"],[data-nano-tools],.nt-translated,.ytp-caption-window-container,[contenteditable]:not([contenteditable="false"])';
  const SKIP_BLOCK = `${SKIP},code`;
  const isTinyFrame = () => window !== window.top && (innerWidth < 240 || innerHeight < 160);
  function isInline(element, memo) {
    let value = memo?.get(element);
    if (value === undefined) {
      value = /^(inline|contents|ruby)/.test(getComputedStyle(element).display);
      memo?.set(element, value);
    }
    return value;
  }
  // Nearest ancestor (or self) that starts its own text block; falls back to <body>.
  function blockOf(element, memo) {
    while (element && element !== document.body && element !== document.documentElement && isInline(element, memo)) element = element.parentElement;
    return !element || element === document.documentElement ? document.body : element;
  }

  // ---- Translation cache (LRU) and long-text handling ----
  const cache = new Map(), CACHE_MAX = 800;
  const cacheGet = key => {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key);
    cache.delete(key); cache.set(key, value);
    return value;
  };
  const cacheSet = (key, value) => {
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };
  function splitText(text, max) {
    if (text.length <= max) return [text];
    const parts = [];
    let current = '';
    for (const sentence of text.match(/[^.!?。！？]*[.!?。！？]+\s*|[^.!?。！？]+$/g) || [text]) {
      if (current && current.length + sentence.length > max) { parts.push(current); current = ''; }
      if (sentence.length > max) { for (let i = 0; i < sentence.length; i += max) parts.push(sentence.slice(i, i + max)); continue; }
      current += sentence;
    }
    if (current) parts.push(current);
    return parts;
  }
  // Persistent cache: stored in the extension's own IndexedDB, reached through the background worker.
  let persistOn = true;
  try {
    chrome.storage.local.get({ persistCache: true }).then(values => { persistOn = values.persistCache !== false; }, () => {});
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.persistCache) persistOn = changes.persistCache.newValue !== false; });
  } catch { /* not running inside an extension */ }
  function hashText(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761); h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}.${text.length}`;
  }
  async function persist(message) {
    if (!persistOn || !globalThis.chrome?.runtime?.sendMessage) return undefined;
    try { return await chrome.runtime.sendMessage(message); } catch { return undefined; }
  }
  async function translateText(model, lang, text, signal) {
    const key = `${lang}\n${text}`;
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
    const stored = await persist({ type: 'cache-get', key: hashText(key), src: key });
    check(signal);
    if (typeof stored?.out === 'string') { cacheSet(key, stored.out); return stored.out; }
    let output = '';
    for (const part of splitText(text, 1500)) { check(signal); output += await model.translate(part.trim(), { signal }); }
    cacheSet(key, output);
    void persist({ type: 'cache-set', key: hashText(key), src: key, out: output });
    return output;
  }

  // Heuristic detection cannot tell English from other Latin-script languages, so
  // double-check longer English candidates with the on-device LanguageDetector.
  let detectorPromise;
  const languageDetector = () => detectorPromise ??= (async () => {
    if (!globalThis.LanguageDetector) return null;
    try { return await LanguageDetector.availability() === 'available' ? await LanguageDetector.create() : null; }
    catch { return null; }
  })();
  async function confirmLanguage(text, lang, element) {
    if (lang !== 'en' || text.length < 24) return true;
    if (element?.closest?.('[lang]')?.lang?.toLowerCase().startsWith('en')) return true;
    const detector = await languageDetector();
    if (!detector) return true;
    try {
      const [top] = await detector.detect(text.slice(0, 500));
      return !(top && top.detectedLanguage !== 'en' && top.confidence > .7);
    } catch { return true; }
  }

  // ---- Summary helpers ----
  // Greedily pack paragraphs into chunks of at most `budget` characters.
  function packParagraphs(paragraphs, budget) {
    const chunks = [];
    let current = '';
    const flush = () => { if (current) chunks.push(current); current = ''; };
    for (const paragraph of paragraphs) {
      for (const piece of splitText(paragraph, budget)) {
        if (current && current.length + piece.length + 2 > budget) flush();
        current += current ? `\n\n${piece}` : piece;
      }
    }
    flush();
    return chunks;
  }
  function parseInline(text) {
    const parts = [];
    let last = 0;
    for (const match of text.matchAll(/\*\*(.+?)\*\*|`([^`]+)`|\*([^*\s][^*]*?)\*/g)) {
      if (match.index > last) parts.push({ t: 'text', v: text.slice(last, match.index) });
      parts.push(match[1] !== undefined ? { t: 'b', v: match[1] } : match[2] !== undefined ? { t: 'code', v: match[2] } : { t: 'i', v: match[3] });
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push({ t: 'text', v: text.slice(last) });
    return parts;
  }
  // Minimal Markdown (headings, nested lists, bold/italic/code) into a plain data tree.
  function parseMarkdown(text) {
    const blocks = [], stack = [];
    const open = (ordered, indent) => {
      const list = { type: 'list', ordered, items: [] };
      const parent = stack.at(-1);
      if (parent) parent.list.items.at(-1).children.push(list); else blocks.push(list);
      stack.push({ indent, list });
    };
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      const item = raw.match(/^([ \t]*)([-*•]|\d+[.)])\s+(.*)$/);
      if (item) {
        const indent = item[1].replace(/\t/g, '    ').length, ordered = /\d/.test(item[2]);
        while (stack.length && indent < stack.at(-1).indent) stack.pop();
        const top = stack.at(-1);
        if (!top || indent > top.indent) open(ordered, indent);
        else if (top.list.ordered !== ordered) { stack.pop(); open(ordered, indent); }
        stack.at(-1).list.items.push({ inline: parseInline(item[3]), children: [] });
        continue;
      }
      stack.length = 0;
      const heading = raw.trim().match(/^#{1,6}\s+(.*)$/);
      blocks.push({ type: heading ? 'h' : 'p', inline: parseInline(heading ? heading[1] : raw.trim()) });
    }
    return blocks;
  }

  globalThis.__nano = { el, detect, isChinese, check, abortError, ui, availability, createModel, translatorPool, withAbort, hashText, SKIP, SKIP_BLOCK, isTinyFrame, isInline, blockOf, splitText, translateText, confirmLanguage, packParagraphs, parseMarkdown };
})();

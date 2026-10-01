// Shared by the page translator and YouTube captions in the isolated world.
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
    if (hint?.startsWith('zh') && !/[぀-ヿ]/u.test(text)) return null;
    if (/[぀-ヿ]/u.test(text) || (hint?.startsWith('ja') && /[一-鿿]/u.test(text))) return 'ja';
    if (hint && !/^(en|ja)(-|$)/.test(hint)) return null;
    const letters = text.match(/\p{L}/gu) || [];
    return letters.length >= 3 && (text.match(/[a-z]/gi) || []).length / letters.length > .8 ? 'en' : null;
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
      h2{font:600 16px/1.5 'Microsoft JhengHei',sans-serif;margin:0}.body{padding:12px 18px;overflow:auto;overflow-wrap:anywhere}.body p{margin:0 0 10px}.body ul,.body ol{padding-left:1.3em;margin:0 0 10px}.body li{margin:5px 0}
      footer{padding:10px 16px;border-top:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap}.notice{font-size:12px;color:var(--muted)}
      .tip{position:absolute;max-width:min(420px,calc(100vw - 24px));max-height:40vh;overflow:auto;background:#193d30aa;color:#fff;padding:10px 14px;border-radius:9px;font:14px/1.6 'Microsoft JhengHei',sans-serif;white-space:pre-wrap;pointer-events:none;overflow-wrap:anywhere}
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
    const notice = el('span', '', 'notice');
    notice.setAttribute('role', 'status');
    foot.append(copy, retry, notice);
    summary.append(head, body, foot);
    const tip = el('div', '', 'tip');
    tip.hidden = true;
    tip.setAttribute('role', 'tooltip');
    shadow.append(style, dock, summary, tip);
    document.documentElement.append(host);
    const cards = new Map();
    const status = (key, text, actions = []) => {
      let card = cards.get(key);
      if (!text) { card?.remove(); cards.delete(key); return; }
      if (!card) { card = el('div', '', 'card'); cards.set(key, card); dock.append(card); }
      const message = el('div', text);
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      card.replaceChildren(el('div', key === 'captions' ? 'YOUTUBE · 雙語字幕' : 'NANO · 本機處理', 'label'), message);
      if (actions.length) {
        const row = el('div', '', 'actions');
        for (const [label, action] of actions) { const button = el('button', label); button.addEventListener('click', action); row.append(button); }
        card.append(row);
      }
      return card;
    };
    // Keep tools visible when the player enters fullscreen.
    document.addEventListener('fullscreenchange', () => (document.fullscreenElement || document.documentElement).append(host));
    tools = { host, shadow, status, summary, close, body, copy, retry, notice, tip };
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
    return function get(source) {
      check(signal);
      if (!pending.has(source)) {
        pending.set(source, (async () => {
          try {
            const model = await createModel('Translator', { sourceLanguage: source, targetLanguage: 'zh-Hant' }, signal, `${source === 'ja' ? '日文' : '英文'} → 繁中`);
            if (signal.aborted) { model.destroy(); throw abortError(); }
            models.add(model);
            return model;
          } catch (error) { pending.delete(source); throw error; }
        })());
      }
      return pending.get(source);
    };
  }
  globalThis.__nano = { el, detect, check, abortError, ui, availability, createModel, translatorPool, withAbort };
})();

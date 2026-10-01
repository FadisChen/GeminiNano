(() => {
  if (window.__nt) return; // 已初始化；操作由 popup 呼叫 window.__nt 的方法

  const TARGETS = ['zh-Hant', 'zh'];
  // 候選：語意區塊 + 常見的純文字容器（div/span/a/label/button）
  const CANDIDATE_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dd,dt,summary,td,th,div,span,a,label,button';
  // 內含這些元素的容器不直接翻譯，改翻譯它們的內層
  const BLOCKISH = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dd,dt,summary,td,th,div,section,article,aside,header,footer,nav,main,ul,ol,table,tr,form,pre,button,a';
  const SKIP_ANCESTORS = 'pre,code,script,style,noscript,textarea,select,[contenteditable="true"],.nt-ui,.nt-trans';
  const MARK = 'data-nt-state'; // queued | done | skipped
  const CONCURRENCY = 2;

  const state = { on: false, translators: new Map(), queue: [], running: 0, done: 0, total: 0, io: null, mo: null };

  // ---- 設定：是否保留原文 ----
  const applyMode = (keepOriginal) => document.documentElement.classList.toggle('nt-replace', !keepOriginal);
  chrome.storage.local.get({ keepOriginal: true }).then((v) => applyMode(v.keepOriginal));
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.keepOriginal) applyMode(changes.keepOriginal.newValue);
  });

  // ---- UI ----
  const ui = document.createElement('div');
  ui.className = 'nt-ui';
  ui.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1f2937;color:#fff;' +
    'font:13px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 2px 8px #0004;' +
    'display:none;max-width:280px;';
  const uiText = document.createElement('span');
  const uiBtn = document.createElement('button');
  uiBtn.style.cssText = 'margin-left:8px;display:none;cursor:pointer;';
  ui.append(uiText, uiBtn);
  document.documentElement.append(ui);

  const say = (msg) => { ui.style.display = 'block'; uiText.textContent = msg; };
  const progress = () => say(state.done >= state.total && !state.queue.length ? `翻譯完成（${state.done} 段）` : `翻譯中 ${state.done}/${state.total}`);

  // ---- style ----
  const css = document.createElement('style');
  css.textContent = `
    .nt-orig{display:contents}
    .nt-trans{display:block;margin-top:.25em;color:#2563eb;border-left:3px solid #93c5fd;padding-left:.5em;}
    html.nt-replace .nt-orig{display:none}
    html.nt-replace .nt-trans{margin:0;color:inherit;border:0;padding:0}`;
  document.documentElement.append(css);

  // ---- 「只顯示譯文」模式：滑鼠移到譯文上時彈出原文 ----
  const TIP_BG_ALPHA = 0.3; // 背景不透明度 30%
  const tip = document.createElement('div');
  tip.className = 'nt-ui';
  tip.style.cssText = `position:fixed;z-index:2147483647;display:none;max-width:420px;pointer-events:none;` +
    `padding:8px 12px;border-radius:8px;color:#fff;font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap;` +
    `background:rgba(17,24,39,${TIP_BG_ALPHA});backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);` +
    `text-shadow:0 1px 2px rgba(0,0,0,.8);box-shadow:0 2px 12px rgba(0,0,0,.25);`;
  document.documentElement.append(tip);

  const hideTip = () => { tip.style.display = 'none'; tip.dataset.for = ''; };
  function moveTip(e) {
    const pad = 14;
    const x = Math.min(e.clientX + pad, window.innerWidth - tip.offsetWidth - 8);
    const below = e.clientY + pad + tip.offsetHeight < window.innerHeight;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${below ? e.clientY + pad : Math.max(8, e.clientY - pad - tip.offsetHeight)}px`;
  }
  function onTipOver(e) {
    if (!document.documentElement.classList.contains('nt-replace')) return;
    const el = e.target.closest?.(`[${MARK}="done"]`);
    if (!el) return;
    const orig = el.querySelector(':scope > .nt-orig');
    if (!orig) return;
    tip.textContent = orig.textContent.replace(/\s+/g, ' ').trim();
    tip.style.display = 'block';
    moveTip(e);
  }
  function onTipOut(e) {
    const el = e.target.closest?.(`[${MARK}="done"]`);
    if (el && !el.contains(e.relatedTarget)) hideTip();
  }
  const onTipMove = (e) => { if (tip.style.display === 'block') moveTip(e); };

  // ---- 語言判斷（只支援 en / ja）----
  function detect(text) {
    if (/[぀-ヿ]/.test(text)) return 'ja';
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length < 3) return null;
    const latin = text.match(/[A-Za-z]/g) || [];
    return latin.length / letters.length > 0.8 ? 'en' : null;
  }

  // ---- translator ----
  function waitForClick(label) {
    return new Promise((resolve) => {
      uiBtn.textContent = label;
      uiBtn.style.display = 'inline-block';
      uiBtn.onclick = () => { uiBtn.style.display = 'none'; uiBtn.onclick = null; resolve(); };
    });
  }

  function getTranslator(source) {
    if (!state.translators.has(source)) {
      state.translators.set(source, (async () => {
        for (const target of TARGETS) {
          const opts = { sourceLanguage: source, targetLanguage: target };
          let avail;
          try { avail = await Translator.availability(opts); } catch { continue; }
          if (avail === 'unavailable') continue;
          if (avail !== 'available' && !navigator.userActivation.isActive) {
            say(`需要下載 ${source}→${target} 語言模型`);
            await waitForClick('下載');
          }
          say(`準備 ${source}→${target} 模型…`);
          return Translator.create({
            ...opts,
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => say(`下載模型 ${Math.round(e.loaded * 100)}%`));
            },
          });
        }
        throw new Error(`不支援 ${source} → 繁體中文`);
      })());
    }
    return state.translators.get(source);
  }

  // ---- translate pipeline ----
  async function translateEl(el) {
    const text = el.innerText.trim();
    const lang = detect(text);
    if (!lang) { el.setAttribute(MARK, 'skipped'); state.total--; return; }
    const tr = await getTranslator(lang);
    const out = await tr.translate(text);
    if (!state.on) return;
    // 原文搬進 wrapper，才能在「只顯示譯文」模式下隱藏
    const orig = document.createElement('span');
    orig.className = 'nt-orig';
    orig.append(...el.childNodes);
    const node = document.createElement('span');
    node.className = 'nt-trans';
    node.textContent = out;
    el.append(orig, node);
    el.setAttribute(MARK, 'done');
    state.done++;
  }

  async function pump() {
    while (state.on && state.running < CONCURRENCY && state.queue.length) {
      const el = state.queue.shift();
      state.running++;
      translateEl(el)
        .catch((err) => { console.error('[nt]', err); say(`錯誤：${err.message}`); el.setAttribute(MARK, 'skipped'); })
        .finally(() => { state.running--; progress(); pump(); });
    }
  }

  function candidate(el) {
    if (el.hasAttribute(MARK) || el.closest(SKIP_ANCESTORS)) return false;
    if (el.parentElement?.closest(`[${MARK}]`)) return false; // 祖先已處理
    if (el.querySelector(BLOCKISH)) return false;             // 只翻最內層容器
    return (el.innerText || '').trim().length >= 4;
  }

  function observe(root) {
    const els = root.matches?.(CANDIDATE_SELECTOR) ? [root] : [];
    els.push(...root.querySelectorAll(CANDIDATE_SELECTOR));
    for (const el of els) {
      if (!candidate(el)) continue;
      el.setAttribute(MARK, 'queued');
      state.total++;
      state.io.observe(el);
    }
  }

  function start() {
    state.on = true;
    state.done = state.total = 0;
    state.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        state.io.unobserve(e.target);
        state.queue.push(e.target);
      }
      pump();
    }, { rootMargin: '400px 0px' });
    state.mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && !n.closest?.('.nt-ui,.nt-trans,.nt-orig')) observe(n);
    });
    state.mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('mouseover', onTipOver);
    document.addEventListener('mouseout', onTipOut);
    document.addEventListener('mousemove', onTipMove);
    say('翻譯中…');
    observe(document.body);
  }

  function stop() {
    state.on = false;
    state.io?.disconnect();
    state.mo?.disconnect();
    state.queue.length = 0;
    document.removeEventListener('mouseover', onTipOver);
    document.removeEventListener('mouseout', onTipOut);
    document.removeEventListener('mousemove', onTipMove);
    hideTip();
    document.querySelectorAll('.nt-trans').forEach((n) => n.remove());
    document.querySelectorAll('.nt-orig').forEach((n) => n.replaceWith(...n.childNodes));
    document.querySelectorAll(`[${MARK}]`).forEach((n) => n.removeAttribute(MARK));
    ui.style.display = 'none';
  }

  // ---- 網頁重點摘要（結果一律為繁體中文）----
  const sumCss = document.createElement('style');
  sumCss.textContent = `
    .nt-sum{position:fixed;top:16px;right:16px;width:360px;max-width:calc(100vw - 32px);max-height:70vh;display:none;
      flex-direction:column;background:#fff;color:#111827;border-radius:14px;box-shadow:0 10px 32px rgba(0,0,0,.28);
      font:14px/1.6 system-ui,'Microsoft JhengHei',sans-serif;z-index:2147483647;overflow:hidden}
    .nt-sum-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;color:#fff;font-weight:600;
      background:linear-gradient(135deg,#3b82f6,#1d4ed8)}
    .nt-sum-head button{all:unset;cursor:pointer;padding:0 6px;font-size:18px;line-height:1}
    .nt-sum-body{padding:12px 16px;overflow:auto}
    .nt-sum-body ul{margin:0;padding-left:1.2em}
    .nt-sum-body li{margin:.35em 0}
    .nt-sum-body p{margin:.4em 0}
    .nt-sum-status{color:#6b7280}
    .nt-sum-foot{padding:8px 14px;border-top:1px solid #e5e7eb;text-align:right}
    .nt-sum-foot button{all:unset;cursor:pointer;color:#2563eb;font-size:13px}`;
  document.documentElement.append(sumCss);

  const panel = document.createElement('div');
  panel.className = 'nt-ui nt-sum';
  const panelHead = document.createElement('div');
  panelHead.className = 'nt-sum-head';
  const panelTitle = document.createElement('span');
  panelTitle.textContent = '網頁重點摘要';
  const panelClose = document.createElement('button');
  panelClose.textContent = '×';
  panelClose.title = '關閉';
  panelClose.onclick = () => { panel.style.display = 'none'; sumRun++; };
  panelHead.append(panelTitle, panelClose);
  const panelBody = document.createElement('div');
  panelBody.className = 'nt-sum-body';
  const panelFoot = document.createElement('div');
  panelFoot.className = 'nt-sum-foot';
  const panelCopy = document.createElement('button');
  panelCopy.textContent = '複製摘要';
  panelCopy.onclick = async () => {
    await navigator.clipboard.writeText(panelBody.innerText);
    panelCopy.textContent = '已複製 ✓';
    setTimeout(() => { panelCopy.textContent = '複製摘要'; }, 1500);
  };
  panelFoot.append(panelCopy);
  panel.append(panelHead, panelBody, panelFoot);
  document.documentElement.append(panel);

  let sumRun = 0; // 遞增以作廢進行中的舊摘要

  const sumStatus = (msg) => {
    const p = document.createElement('p');
    p.className = 'nt-sum-status';
    p.textContent = msg;
    panelBody.replaceChildren(p);
    panelFoot.style.display = 'none';
    panel.style.display = 'flex';
  };

  // markdown 條列 → DOM（只用 textContent，不用 innerHTML）
  function renderSummary(markdown) {
    const ul = document.createElement('ul');
    const frag = [];
    for (const raw of markdown.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^[*\-•]\s+(.*)$/);
      if (m) {
        const li = document.createElement('li');
        li.textContent = m[1].replace(/\*\*/g, '');
        ul.append(li);
      } else {
        const p = document.createElement('p');
        p.textContent = line.replace(/\*\*/g, '');
        frag.push(p);
      }
    }
    panelBody.replaceChildren(...frag, ...(ul.childElementCount ? [ul] : []));
    panelFoot.style.display = 'block';
  }

  function pageText() {
    const root = document.querySelector('article, main, [role="main"]') || document.body;
    const parts = [];
    for (const el of root.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,td')) {
      if (el.closest('nav,footer,aside,script,style,noscript,.nt-ui') || el.querySelector('p,li,blockquote')) continue;
      const t = (el.querySelector(':scope > .nt-orig') || el).textContent.replace(/\s+/g, ' ').trim();
      if (t.length >= 2) parts.push(t);
    }
    const joined = parts.join('\n');
    return joined.length >= 200 ? joined : root.innerText.trim();
  }

  async function gateDownload(avail, label) {
    if (avail !== 'available' && !navigator.userActivation.isActive) {
      say(`需要下載${label}`);
      await waitForClick('下載');
    }
  }

  async function summarize() {
    const run = ++sumRun;
    const alive = () => run === sumRun;
    try {
      let text = pageText();
      if (text.length < 80) return sumStatus('這個頁面的文字太少，無法產生摘要。');
      if (!('Summarizer' in self)) return sumStatus('這個瀏覽器不支援 Summarizer API。');

      const sample = text.slice(0, 600);
      const srcLang = detect(sample) || (/[一-鿿]/.test(sample) ? 'zh' : 'en');
      const base = { type: 'key-points', format: 'markdown', length: 'medium' };

      // 優先讓模型直接輸出繁體中文；不支援時改用「原文語言摘要 → Translator 翻成繁中」
      let outputLanguage = null;
      for (const t of TARGETS) {
        try {
          if ((await Summarizer.availability({ ...base, outputLanguage: t })) !== 'unavailable') { outputLanguage = t; break; }
        } catch { /* 該語言不支援，試下一個 */ }
      }
      const viaTranslator = !outputLanguage;
      if (viaTranslator) {
        if (srcLang === 'zh') return sumStatus('此環境的 Summarizer 無法輸出中文。');
        outputLanguage = srcLang;
      }

      const opts = { ...base, outputLanguage, sharedContext: document.title };
      await gateDownload(await Summarizer.availability(opts), '摘要模型');
      sumStatus('準備摘要模型…');
      const summarizer = await Summarizer.create({
        ...opts,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => sumStatus(`下載摘要模型 ${Math.round(e.loaded * 100)}%`));
        },
      });
      if (!state.on) ui.style.display = 'none';
      if (!alive()) return;

      while (summarizer.inputQuota && (await summarizer.measureInputUsage(text)) > summarizer.inputQuota && text.length > 200) {
        text = text.slice(0, Math.floor(text.length * 0.8));
      }

      sumStatus('正在閱讀頁面並產生摘要…');
      let acc = '';
      for await (const chunk of summarizer.summarizeStreaming(text, { context: document.title })) {
        if (!alive()) return;
        acc = acc && chunk.startsWith(acc) ? chunk : acc + chunk;
        if (!viaTranslator) renderSummary(acc);
      }

      if (viaTranslator) {
        sumStatus('翻譯成繁體中文…');
        const tr = await getTranslator(srcLang);
        if (!state.on) ui.style.display = 'none'; // 清掉「準備模型」提示（翻譯進行中時由翻譯流程接管）
        const lines = [];
        for (const line of acc.split('\n')) {
          const m = line.trim().match(/^([*\-•]\s+)?(.*)$/);
          lines.push(m[2] ? (m[1] || '') + (await tr.translate(m[2])) : '');
          if (!alive()) return;
        }
        renderSummary(lines.join('\n'));
      }
      summarizer.destroy();
    } catch (err) {
      console.error('[nt] summarize', err);
      sumStatus(`摘要失敗：${err.message}`);
    }
  }

  window.__nt = {
    toggle: () => (state.on ? stop() : start()),
    isOn: () => state.on,
    summarize,
  };
})();

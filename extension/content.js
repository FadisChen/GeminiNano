(() => {
  if (window.__nt) return;
  const N = window.__nano;
  const SKIP = 'script,style,noscript,pre,code,textarea,select,input,svg,math,[translate="no"],[data-nano-tools],.nt-run,.ytp-caption-window-container';
  let current = null, summaryJob = null, keepOriginal = true, settingRevision = 0;
  const owned = new Set();
  const styles = N.el('style');
  styles.textContent = `
    .nt-run{display:inline!important}.nt-original{display:contents!important}
    .nt-translated{color:#23634d!important;background:#e9efe780;border-radius:3px;padding:0 .12em;white-space:pre-wrap}
    .nt-run[data-mode="bilingual"]>.nt-translated::before{content:' / ';color:#7a8d80}
    .nt-run[data-mode="translation"]>.nt-original{display:none!important}
    .nt-run[data-mode="translation"]>.nt-translated{color:inherit!important;background:transparent;padding:0}
    .nt-translated:focus-visible{outline:2px solid #398966;outline-offset:3px}
    @media(prefers-color-scheme:dark){.nt-translated{color:#a7d7b6!important;background:#28413480}}
  `;
  document.documentElement.append(styles);
  const alive = job => !job.ctrl.signal.aborted;
  const applyMode = () => {
    for (const record of owned) record.wrapper.dataset.mode = keepOriginal ? 'bilingual' : 'translation';
    if (keepOriginal) N.ui().tip.hidden = true;
  };
  (async () => {
    const revision = settingRevision;
    try { const values = await chrome.storage.local.get({ keepOriginal: true }); if (revision === settingRevision) { keepOriginal = values.keepOriginal; applyMode(); } }
    catch (error) { console.error('[nano] 設定讀取失敗', error); }
  })();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.keepOriginal) { settingRevision++; keepOriginal = changes.keepOriginal.newValue !== false; applyMode(); }
  });

  function isExcluded(node) {
    return !node.parentElement || node.parentElement.closest(SKIP) || node.parentElement.isContentEditable;
  }
  function restore(record) {
    owned.delete(record);
    // Do not resurrect content the site has removed or replaced.
    if (record.wrapper.isConnected && record.original.parentNode === record.wrapper) {
      record.wrapper.replaceWith(...record.original.childNodes);
    }
  }
  function tooltip(record, anchor) {
    if (keepOriginal) return;
    const tip = N.ui().tip;
    tip.textContent = record.node.data;
    tip.hidden = false;
    const rect = anchor.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - tip.offsetHeight - 8))}px`;
  }
  function attachTranslation(record, out) {
    const wrapper = N.el('span', '', 'nt-run');
    const original = N.el('span', '', 'nt-original');
    const translated = N.el('span', out, 'nt-translated');
    translated.tabIndex = 0;
    translated.lang = 'zh-Hant';
    translated.setAttribute('aria-label', `${out}。原文：${record.text.trim()}`);
    wrapper.dataset.mode = keepOriginal ? 'bilingual' : 'translation';
    record.wrapper = wrapper; record.original = original;
    record.node.replaceWith(wrapper);
    original.append(record.node);
    wrapper.append(original, translated);
    owned.add(record);
    translated.addEventListener('mouseenter', () => tooltip(record, translated));
    translated.addEventListener('focus', () => tooltip(record, translated));
    translated.addEventListener('mouseleave', () => { N.ui().tip.hidden = true; });
    translated.addEventListener('blur', () => { N.ui().tip.hidden = true; });
  }
  function report(job) {
    if (!alive(job)) return;
    const busy = job.running || job.queue.length || job.scanning;
    const failed = job.failed.size;
    const done = [...job.records.values()].filter(r => r.state === 'done').length;
    job.phase = failed ? 'partial' : busy ? 'translating' : 'idle';
    const text = failed ? `部分失敗（${failed} 段）：${job.error}` : busy ? `翻譯中 · 已完成 ${done} 段` : `目前可見內容完成 · ${done} 段（捲動後繼續）`;
    job.message = text;
    const actions = failed ? [['重試失敗段落', () => retry(job)], ['還原此頁', stop]] : [['還原此頁', stop]];
    N.ui().status('translation', text, actions);
  }
  function retry(job) {
    if (!alive(job)) return;
    for (const record of job.failed) { record.state = 'queued'; job.queue.push(record); }
    job.failed.clear(); job.error = '';
    pump(job);
  }
  async function translateRecord(job, record) {
    try {
      if (!record.node.isConnected || record.node.data !== record.text) return;
      const model = await job.getTranslator(record.lang);
      N.check(job.ctrl.signal);
      const output = await model.translate(record.text.trim(), { signal: job.ctrl.signal });
      N.check(job.ctrl.signal);
      if (job.records.get(record.node) !== record || !record.node.isConnected || record.node.data !== record.text || isExcluded(record.node)) return;
      attachTranslation(record, output);
      record.state = 'done';
    } catch (error) {
      if (!alive(job)) return;
      record.state = 'failed'; job.failed.add(record);
      job.error = error.name === 'AbortError' ? '模型準備已取消，可重試。' : error.message;
    } finally {
      job.running--;
      if (alive(job)) { report(job); pump(job); }
    }
  }
  function pump(job) {
    if (!alive(job)) return;
    if (job.failed.size) { report(job); return; }
    while (job.running < 2 && job.queue.length) {
      const record = job.queue.shift();
      if (job.records.get(record.node) !== record) continue;
      record.state = 'running'; job.running++;
      void translateRecord(job, record);
    }
    report(job);
  }
  function scheduleScan(job, root) {
    if (!alive(job) || !root?.isConnected || root.closest?.('[data-nano-tools]')) return;
    // Coalesce descendants under already-scheduled ancestors.
    for (const pending of job.roots) if (pending.contains(root)) return;
    for (const pending of job.roots) if (root.contains(pending)) job.roots.delete(pending);
    job.roots.add(root);
    if (!job.scanning) { job.scanning = true; setTimeout(() => { void scan(job); }, 0); }
  }
  async function scan(job) {
    try {
      let visited = 0;
      while (alive(job) && job.roots.size) {
        const root = job.roots.values().next().value;
        job.roots.delete(root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while (alive(job) && (node = walker.nextNode())) {
          if (++visited % 150 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); if (!alive(job)) return; }
          if (!node.isConnected || isExcluded(node) || job.records.has(node)) continue;
          const text = node.data;
          const lang = N.detect(text, node.parentElement);
          if (!lang || text.trim().length < 3) continue;
          const record = { node, text, lang, state: 'waiting' };
          job.records.set(node, record);
          const parent = node.parentElement;
          if (!job.observed.has(parent)) { job.observed.set(parent, new Set()); job.io.observe(parent); }
          job.observed.get(parent).add(record);
        }
      }
    } finally { job.scanning = false; report(job); }
  }
  function mutations(job, entries) {
    if (!alive(job)) return;
    for (const entry of entries) {
      if (entry.target.parentElement?.closest('[data-nano-tools]') || entry.target.closest?.('[data-nano-tools]')) continue;
      const root = entry.target.nodeType === Node.TEXT_NODE ? entry.target.parentElement : entry.target;
      scheduleScan(job, root);
    }
    // Validate owned records only after page mutations, including SPA removals.
    for (const [node, record] of job.records) {
      const altered = !node.isConnected || node.data !== record.text || (record.wrapper && (!record.wrapper.isConnected || !record.original.contains(node)));
      if (!altered) continue;
      const root = record.wrapper?.parentElement || node.parentElement;
      if (record.wrapper) restore(record);
      job.records.delete(node); job.failed.delete(record);
      scheduleScan(job, root);
    }
  }
  function start() {
    if (current) return;
    const ctrl = new AbortController();
    const job = { ctrl, getTranslator: N.translatorPool(ctrl.signal), records: new Map(), observed: new Map(), failed: new Set(), roots: new Set(), queue: [], running: 0, scanning: false, phase: 'translating', message: '正在準備翻譯…' };
    current = job;
    job.io = new IntersectionObserver(entries => {
      if (!alive(job)) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const records = job.observed.get(entry.target);
        for (const record of records || []) if (record.state === 'waiting') { record.state = 'queued'; job.queue.push(record); }
        job.observed.delete(entry.target); job.io.unobserve(entry.target);
      }
      pump(job);
    }, { rootMargin: '400px 0px' });
    job.mo = new MutationObserver(entries => mutations(job, entries));
    job.mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleScan(job, document.body);
    report(job);
  }
  function stop() {
    const job = current;
    if (!job) return;
    current = null;
    job.mo.disconnect(); job.io.disconnect(); job.ctrl.abort();
    job.queue.length = 0; job.roots.clear();
    for (const record of [...owned]) restore(record);
    N.ui().tip.hidden = true;
    N.ui().status('translation', '');
  }

  // Extract original visible text, never translated output or tool UI.
  function pageParagraphs() {
    const root = document.querySelector('article,main,[role="main"]') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const groups = new Map();
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest('nav,footer,aside,script,style,noscript,pre,code,textarea,select,[data-nano-tools],.nt-translated,.ytp-caption-window-container') || parent.isContentEditable) continue;
      const visible = parent.closest('.nt-run') || parent;
      if (!visible.getClientRects().length || getComputedStyle(visible).visibility === 'hidden') continue;
      const block = parent.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,div,section,article,main') || root;
      groups.set(block, (groups.get(block) || '') + node.data);
    }
    return [...groups.values()].map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  function renderSummary(text) {
    const body = N.ui().body;
    const fragment = document.createDocumentFragment();
    let list = null, kind = '';
    for (const line of text.split('\n').map(s => s.trim()).filter(Boolean)) {
      const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (bullet) {
        const nextKind = /^\d/.test(line) ? 'ol' : 'ul';
        if (!list || kind !== nextKind) { list = N.el(nextKind); kind = nextKind; fragment.append(list); }
        list.append(N.el('li', bullet[1].replace(/\*\*/g, '')));
      } else { list = null; fragment.append(N.el('p', line.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, ''))); }
    }
    body.replaceChildren(fragment);
  }
  function cancelSummary() {
    summaryJob?.ctrl.abort(); summaryJob = null;
    N.ui().summary.hidden = true;
  }
  function summarize() {
    summaryJob?.ctrl.abort();
    const ctrl = new AbortController();
    const job = { ctrl, getTranslator: N.translatorPool(ctrl.signal) };
    summaryJob = job;
    const tools = N.ui();
    tools.summary.hidden = false; tools.copy.disabled = true; tools.retry.hidden = true; tools.notice.textContent = '';
    tools.body.replaceChildren(N.el('p', '正在讀取原文…'));
    tools.close.onclick = cancelSummary;
    tools.retry.onclick = summarize;
    tools.close.focus({ preventScroll: true });
    void runSummary(job);
  }
  async function runSummary(job) {
    const signal = job.ctrl.signal;
    const tools = N.ui();
    let model;
    let destroyed = false;
    const destroy = () => { if (model && !destroyed) { destroyed = true; model.destroy(); } };
    const status = text => { N.check(signal); tools.body.replaceChildren(N.el('p', text)); };
    try {
      const paragraphs = pageParagraphs();
      let text = paragraphs.join('\n\n');
      if (text.length < 80) throw new Error('這個頁面的文字太少，無法產生摘要。');
      const source = N.detect(text.slice(0, 1200)) || (/[一-鿿]/u.test(text) ? 'zh' : null);
      if (!source) throw new Error('目前摘要支援英文及日文文章。');
      // Use a neutral supported context; a localized page title may not be supported.
      const context = 'Summarize the main points of this article.';
      const base = { type: 'key-points', format: 'markdown', length: 'medium', expectedInputLanguages: [source], expectedContextLanguages: ['en'] };
      const direct = { ...base, outputLanguage: 'zh-Hant' };
      const available = await N.availability('Summarizer', direct);
      N.check(signal);
      const viaTranslator = available === 'unavailable';
      if (viaTranslator && source === 'zh') throw new Error('此環境尚不支援中文文章摘要。');
      const options = viaTranslator ? { ...base, outputLanguage: source } : direct;
      status('正在準備摘要模型…');
      model = await N.createModel('Summarizer', options, signal, '文章摘要');
      signal.addEventListener('abort', destroy, { once: true });
      N.check(signal);
      let count = paragraphs.length;
      if (model.inputQuota && model.measureInputUsage) {
        while (await model.measureInputUsage(text, { context }) > model.inputQuota) {
          N.check(signal);
          if (--count === 0) throw new Error('單一段落超過摘要容量，請改用較短的文章。');
          text = paragraphs.slice(0, count).join('\n\n');
        }
      }
      N.check(signal);
      if (count < paragraphs.length) tools.notice.textContent = '僅摘要文章前段（內容超過模型容量）';
      status('正在產生重點摘要…');
      let result = '';
      for await (const chunk of model.summarizeStreaming(text, { context, signal })) {
        N.check(signal);
        result += chunk;
        if (!viaTranslator) renderSummary(result);
      }
      N.check(signal);
      if (viaTranslator) {
        status('正在將摘要翻成繁體中文…');
        const translator = await job.getTranslator(source);
        N.check(signal);
        const lines = [];
        for (const line of result.split('\n')) {
          const match = line.match(/^(\s*(?:[-*•]|\d+[.)])\s+)?(.*)$/);
          const translated = match[2].trim() ? await translator.translate(match[2], { signal }) : '';
          N.check(signal);
          lines.push((match[1] || '') + translated);
        }
        result = lines.join('\n');
      }
      if (!result.trim()) throw new Error('模型沒有產生摘要，請重試。');
      N.check(signal); renderSummary(result); tools.copy.disabled = false;
    } catch (error) {
      if (!signal.aborted) { status(error.name === 'AbortError' ? '模型準備已取消。' : `摘要失敗：${error.message}`); tools.retry.hidden = false; }
    } finally { destroy(); signal.removeEventListener('abort', destroy); job.ctrl.abort(); }
  }
  N.ui().copy.addEventListener('click', async () => {
    const job = summaryJob;
    try {
      await navigator.clipboard.writeText(N.ui().body.innerText);
      if (summaryJob === job) N.ui().notice.textContent = `${N.ui().notice.textContent.includes('僅摘要') ? '僅摘要文章前段 · ' : ''}已複製`;
    } catch { if (summaryJob === job) N.ui().notice.textContent = '無法複製，請選取摘要文字手動複製。'; }
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    N.ui().tip.hidden = true;
    if (!N.ui().summary.hidden) cancelSummary();
  });
  window.addEventListener('pagehide', () => { stop(); cancelSummary(); });
  window.__nt = {
    start, stop, toggle: () => current ? stop() : start(), isOn: () => Boolean(current), summarize,
    getStatus: () => ({ on: Boolean(current), phase: current?.phase || 'off', message: current?.message || '準備好閱讀此頁' }),
    capabilities: async () => ({
      translation: await N.availability('Translator', { sourceLanguage: 'en', targetLanguage: 'zh-Hant' }),
      summary: await N.availability('Summarizer', { type: 'key-points', format: 'markdown', length: 'medium', expectedInputLanguages: ['en'], outputLanguage: 'en' }),
    }),
  };
})();

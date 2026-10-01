(() => {
  if (window.__nt) return;
  const N = window.__nano;
  const MAX_RUNNING = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1));
  const MAX_CHUNKS = 10;
  let current = null, summaryJob = null, keepOriginal = true, settingRevision = 0;
  const owned = new Set();
  const styles = N.el('style');
  styles.textContent = `
    .nt-original{display:contents!important}
    .nt-original[data-mode="translation"]{display:none!important}
    .nt-translated{display:block!important;margin:.2em 0 0;color:#23634d!important;background:#e9efe780;border-radius:3px;padding:0 .12em;font-style:normal;text-decoration:none}
    .nt-translated[data-mode="translation"]{color:inherit!important;background:transparent;padding:0;margin:0}
    .nt-translated:focus-visible{outline:2px solid #398966;outline-offset:3px}
    @media(prefers-color-scheme:dark){.nt-translated{color:#a7d7b6!important;background:#28413480}.nt-translated[data-mode="translation"]{color:inherit!important;background:transparent}}
  `;
  document.documentElement.append(styles);
  const alive = job => !job.ctrl.signal.aborted;
  const mode = () => keepOriginal ? 'bilingual' : 'translation';
  const applyMode = () => {
    for (const record of owned) {
      record.translated.dataset.mode = mode();
      for (const wrapper of record.wrappers) wrapper.dataset.mode = mode();
    }
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

  // A record is one text block: all text directly owned by a block element,
  // including inline children (links, emphasis), translated as a single unit.
  function ownTextNodes(block, memo) {
    const nodes = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT
        : node.matches(N.SKIP) || !N.isInline(node, memo) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP,
    });
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }
  const intact = record => record.block.isConnected
    && record.nodes.every((node, i) => node.isConnected && node.data === record.datas[i])
    && (!record.translated || (record.translated.isConnected && record.wrappers.every(wrapper => wrapper.isConnected)));
  function restore(record) {
    owned.delete(record);
    record.translated?.remove();
    // Do not resurrect content the site has removed or replaced.
    for (const wrapper of record.wrappers) {
      if (wrapper.isConnected && wrapper.childNodes.length === 1 && wrapper.firstChild.nodeType === Node.TEXT_NODE) wrapper.replaceWith(wrapper.firstChild);
    }
    record.translated = null; record.wrappers = [];
  }
  function drop(job, record) {
    if (job.byBlock.get(record.block) === record) job.byBlock.delete(record.block);
    for (const node of record.nodes) if (job.byNode.get(node) === record) job.byNode.delete(node);
    job.records.delete(record); job.failed.delete(record);
    if (record.state === 'done') job.done--;
    job.io.unobserve(record.block);
    restore(record);
    record.state = 'dropped';
  }
  function tooltip(record, anchor) {
    if (keepOriginal) return;
    const tip = N.ui().tip;
    tip.textContent = record.text;
    tip.hidden = false;
    const rect = anchor.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - tip.offsetHeight - 8))}px`;
  }
  function attach(job, record, output) {
    // Settle pending page mutations first; our own edits below are then discarded from the queue.
    const pending = job.mo.takeRecords();
    if (pending.length) mutations(job, pending);
    if (job.byBlock.get(record.block) !== record || !intact(record)) return false;
    const translated = N.el('span', output, 'nt-translated');
    translated.tabIndex = 0;
    translated.lang = 'zh-Hant';
    translated.dataset.mode = mode();
    translated.setAttribute('aria-label', `${output}。原文：${record.text}`);
    for (const node of record.nodes) {
      if (!node.data.trim()) continue;
      const wrapper = N.el('span', '', 'nt-original');
      wrapper.dataset.mode = mode();
      node.replaceWith(wrapper);
      wrapper.append(node);
      record.wrappers.push(wrapper);
    }
    const last = record.wrappers.at(-1);
    const parent = last.parentNode;
    // Text split across several inline elements: place the translation at block level.
    let anchor = last;
    if (!record.wrappers.every(wrapper => wrapper.parentNode === parent)) while (anchor.parentNode !== record.block) anchor = anchor.parentNode;
    anchor.after(translated);
    record.translated = translated;
    owned.add(record);
    translated.addEventListener('mouseenter', () => tooltip(record, translated));
    translated.addEventListener('focus', () => tooltip(record, translated));
    translated.addEventListener('mouseleave', () => { N.ui().tip.hidden = true; });
    translated.addEventListener('blur', () => { N.ui().tip.hidden = true; });
    job.mo.takeRecords();
    return true;
  }
  function report(job) {
    if (!alive(job)) return;
    const busy = job.running || job.queue.length || job.scanning;
    const failed = job.failed.size;
    job.phase = failed ? 'partial' : busy ? 'translating' : 'idle';
    const text = failed ? `部分失敗（${failed} 段）：${job.error}` : busy ? `翻譯中 · 已完成 ${job.done} 段` : `目前可見內容完成 · ${job.done} 段（捲動後繼續）`;
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
      if (!intact(record)) { drop(job, record); scheduleScan(job, record.block); return; }
      if (!await N.confirmLanguage(record.text, record.lang, record.block)) { record.state = 'skipped'; return; }
      const model = await job.getTranslator(record.lang);
      N.check(job.ctrl.signal);
      const output = await N.translateText(model, record.lang, record.text, job.ctrl.signal);
      N.check(job.ctrl.signal);
      if (record.state === 'dropped' || !attach(job, record, output)) return;
      record.state = 'done'; job.done++;
    } catch (error) {
      if (!alive(job) || record.state === 'dropped') return;
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
    while (job.running < MAX_RUNNING && job.queue.length) {
      const record = job.queue.shift();
      if (record.state !== 'queued') continue;
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
  function addRecord(job, block, memo) {
    if (block.closest(N.SKIP_BLOCK)) return;
    const nodes = ownTextNodes(block, memo);
    const plain = nodes.filter(node => !node.parentElement.closest('code')).map(node => node.data).join('').replace(/\s+/g, ' ').trim();
    if (plain.length < 3) return;
    const lang = N.detect(plain, block);
    if (!lang) return;
    const record = {
      block, nodes, datas: nodes.map(node => node.data), lang, state: 'waiting', wrappers: [], translated: null,
      text: nodes.map(node => node.data).join('').replace(/\s+/g, ' ').trim(),
    };
    job.records.add(record); job.byBlock.set(block, record);
    for (const node of nodes) job.byNode.set(node, record);
    job.io.observe(block);
  }
  async function scan(job) {
    try {
      let visited = 0;
      while (alive(job) && job.roots.size) {
        const root = job.roots.values().next().value;
        job.roots.delete(root);
        if (!root.isConnected) continue;
        const memo = new Map(), blocks = new Set();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while (alive(job) && (node = walker.nextNode())) {
          if (++visited % 150 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); if (!alive(job)) return; }
          if (!node.isConnected || !node.data.trim() || job.byNode.has(node) || !node.parentElement) continue;
          blocks.add(N.blockOf(node.parentElement, memo));
        }
        for (const block of blocks) if (alive(job) && block.isConnected && !job.byBlock.has(block)) addRecord(job, block, memo);
      }
    } finally { job.scanning = false; report(job); }
  }
  function sweep(job) {
    if (!alive(job)) return;
    for (const record of [...job.records]) {
      if (intact(record)) continue;
      const root = record.block.isConnected ? record.block : null;
      drop(job, record);
      scheduleScan(job, root);
    }
  }
  function mutations(job, entries) {
    if (!alive(job)) return;
    let removed = false;
    for (const entry of entries) {
      const target = entry.target.nodeType === Node.TEXT_NODE ? entry.target.parentElement : entry.target;
      if (!target || target.closest('[data-nano-tools],.nt-translated')) continue;
      if (entry.removedNodes.length) removed = true;
      let node = target, record;
      while (node && node !== document.documentElement && !(record = job.byBlock.get(node))) node = node.parentElement;
      if (record) {
        // Only the touched block is invalidated, instead of re-validating every record.
        const block = record.block;
        drop(job, record);
        scheduleScan(job, block);
        continue;
      }
      // 整個 <body> 被換掉（Turbo、view transitions 等）時，改掃新的 body；<head> 不翻譯。
      const root = target === document.documentElement ? document.body : target;
      if (root && document.body?.contains(root)) scheduleScan(job, root);
    }
    // Removed subtrees cannot be traced back to a record cheaply; sweep once, debounced.
    if (removed && !job.sweeping) { job.sweeping = true; setTimeout(() => { job.sweeping = false; sweep(job); }, 300); }
  }
  function start() {
    if (current || N.isTinyFrame() || (window !== window.top && !globalThis.Translator)) return;
    const ctrl = new AbortController();
    const job = {
      ctrl, getTranslator: N.translatorPool(ctrl.signal),
      records: new Set(), byBlock: new Map(), byNode: new Map(), failed: new Set(), roots: new Set(), queue: [],
      running: 0, done: 0, scanning: false, sweeping: false, phase: 'translating', message: '正在準備翻譯…',
    };
    current = job;
    job.io = new IntersectionObserver(entries => {
      if (!alive(job)) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const record = job.byBlock.get(entry.target);
        if (record?.state === 'waiting') { record.state = 'queued'; job.queue.push(record); }
        job.io.unobserve(entry.target);
      }
      pump(job);
    }, { rootMargin: '400px 0px' });
    job.mo = new MutationObserver(entries => mutations(job, entries));
    job.mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
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
      if (!parent.getClientRects().length || getComputedStyle(parent).visibility === 'hidden') continue;
      const block = parent.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,div,section,article,main') || root;
      groups.set(block, (groups.get(block) || '') + node.data);
    }
    return [...groups.values()].map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  function renderInline(parent, parts) {
    const tags = { b: 'strong', i: 'em', code: 'code' };
    for (const part of parts) parent.append(tags[part.t] ? N.el(tags[part.t], part.v) : document.createTextNode(part.v));
  }
  function renderList(block) {
    const list = N.el(block.ordered ? 'ol' : 'ul');
    for (const item of block.items) {
      const li = N.el('li');
      renderInline(li, item.inline);
      for (const child of item.children) li.append(renderList(child));
      list.append(li);
    }
    return list;
  }
  function renderSummary(text) {
    const fragment = document.createDocumentFragment();
    for (const block of N.parseMarkdown(text)) {
      if (block.type === 'list') { fragment.append(renderList(block)); continue; }
      const node = N.el(block.type === 'h' ? 'h3' : 'p');
      renderInline(node, block.inline);
      fragment.append(node);
    }
    N.ui().body.replaceChildren(fragment);
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
      const text = paragraphs.join('\n\n');
      if (text.length < 80) throw new Error('這個頁面的文字太少，無法產生摘要。');
      const source = 'en';
      if (!N.detect(text.slice(0, 1200))) throw new Error('目前摘要僅支援英文文章。');
      // Use a neutral supported context; a localized page title may not be supported.
      const context = 'Summarize the main points of this article.';
      const base = { type: 'key-points', format: 'markdown', length: 'medium', expectedInputLanguages: [source], expectedContextLanguages: ['en'] };
      const direct = { ...base, outputLanguage: 'zh-Hant' };
      const available = await N.availability('Summarizer', direct);
      N.check(signal);
      const viaTranslator = available === 'unavailable';
      const options = viaTranslator ? { ...base, outputLanguage: source } : direct;
      status('正在準備摘要模型…');
      model = await N.createModel('Summarizer', options, signal, '文章摘要');
      signal.addEventListener('abort', destroy, { once: true });
      N.check(signal);

      const quota = model.inputQuota || Infinity;
      const usage = async input => model.measureInputUsage ? model.measureInputUsage(input, { context }) : input.length / 2;
      const stream = async input => {
        let result = '';
        for await (const chunk of model.summarizeStreaming(input, { context, signal })) {
          N.check(signal);
          result += chunk;
          if (!viaTranslator) renderSummary(result);
        }
        N.check(signal);
        return result;
      };
      // Content above the model quota is summarized in chunks, then the partial summaries are merged.
      const total = await usage(text);
      N.check(signal);
      let chunks = [text];
      if (total > quota) {
        chunks = N.packParagraphs(paragraphs, Math.floor(text.length * quota / total * .8));
        if (chunks.length > MAX_CHUNKS) { chunks.length = MAX_CHUNKS; tools.notice.textContent = '內容過長，僅摘要文章前段'; }
      }
      let result;
      if (chunks.length === 1) {
        status('正在產生重點摘要…');
        result = await stream(chunks[0]);
      } else {
        const partials = [];
        for (const [index, chunk] of chunks.entries()) {
          status(`正在摘要第 ${index + 1} / ${chunks.length} 段…`);
          partials.push((await model.summarize(chunk, { context, signal })).trim());
        }
        N.check(signal);
        const combined = partials.join('\n');
        if (await usage(combined) <= quota) { status('正在整合各段重點…'); result = await stream(combined); }
        else result = combined;
      }
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
    const partial = N.ui().notice.textContent.includes('僅摘要');
    try {
      await navigator.clipboard.writeText(N.ui().body.innerText);
      if (summaryJob === job) N.ui().notice.textContent = `${partial ? '僅摘要文章前段 · ' : ''}已複製`;
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

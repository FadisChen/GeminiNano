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
  styles.textContent += 'html.nt-picking,html.nt-picking *{cursor:crosshair!important}';
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

  // Extract original visible text under `root`, never translated output or tool UI.
  const ALWAYS_SKIP = 'script,style,noscript,textarea,select,[data-nano-tools],.nt-translated,.ytp-caption-window-container';
  const STRUCTURAL_SKIP = 'nav,footer,aside,pre,code';
  const defaultRoot = () => document.querySelector('article,main,[role="main"]') || document.body;
  function paragraphsOf(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const groups = new Map();
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest(ALWAYS_SKIP) || parent.isContentEditable) continue;
      // Structural exclusions only apply below the root, so picking e.g. an <aside> still works.
      const structural = parent.closest(STRUCTURAL_SKIP);
      if (structural && structural !== root && root.contains(structural)) continue;
      // display:contents wrappers (our own .nt-original) have no box; judge visibility by the nearest real box.
      let visible = parent;
      while (visible.parentElement && getComputedStyle(visible).display === 'contents') visible = visible.parentElement;
      if (!visible.getClientRects().length || getComputedStyle(visible).visibility === 'hidden') continue;
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
  // ---- Red-box highlight (also stays around the chosen block while its summary is open) ----
  let boxElement = null;
  function placeBox() {
    const rect = boxElement.getBoundingClientRect(), box = N.ui().pickBox;
    Object.assign(box.style, { left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px` });
  }
  function showBox(element) { boxElement = element; N.ui().pickBox.hidden = false; placeBox(); }
  function hideBox() { boxElement = null; N.ui().pickBox.hidden = true; }
  const refreshBox = () => { if (!boxElement) return; if (boxElement.isConnected) placeBox(); else hideBox(); };
  window.addEventListener('scroll', refreshBox, { capture: true, passive: true });
  window.addEventListener('resize', refreshBox);

  // ---- Pick a block with the mouse, then summarize only that block ----
  let picker = null;
  const POINTER_EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'auxclick'];
  function pickSummary() {
    picker?.cancel();
    cancelSummary();
    const tools = N.ui();
    let target = null, parents = [], lock = null, lastMouse = { x: 0, y: 0 };
    const fromUi = e => e.composedPath().includes(tools.host);
    // 用 ↑↓ 調整範圍後，滑鼠小幅晃動不會把選取範圍重設。
    const adjust = (event, element) => { event.preventDefault(); lock = lastMouse; set(element); };
    const set = element => { target = element; showBox(element); };
    const finish = keepBox => {
      picker = null;
      document.documentElement.classList.remove('nt-picking');
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('keydown', onKey, true);
      for (const type of POINTER_EVENTS) document.removeEventListener(type, onPointer, true);
      tools.pickBar.hidden = true;
      if (!keepBox) hideBox();
    };
    function onMove(e) {
      if (fromUi(e)) return;
      lastMouse = { x: e.clientX, y: e.clientY };
      if (lock && Math.hypot(lastMouse.x - lock.x, lastMouse.y - lock.y) < 24) return;
      lock = null;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (!hit || hit === document.documentElement) return;
      const block = N.blockOf(hit);
      if (block !== target) { parents = []; set(block); }
    }
    function onPointer(e) {
      if (fromUi(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.type === 'click' && target) { const element = target; finish(true); startSummary({ kind: 'element', element, paragraphs: () => paragraphsOf(element) }); }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
      if (e.key === 'ArrowUp' && target?.parentElement && target.parentElement !== document.documentElement) { parents.push(target); adjust(e, target.parentElement); }
      else if (e.key === 'ArrowDown' && parents.length) adjust(e, parents.pop());
    }
    const whole = N.el('button', '摘要整頁');
    const cancel = N.el('button', '取消');
    whole.onclick = () => { finish(false); startSummary({ kind: 'page', paragraphs: () => paragraphsOf(defaultRoot()) }); };
    cancel.onclick = () => finish(false);
    tools.pickBar.replaceChildren(N.el('span', '點選要摘要的區塊（↑ 放大範圍、↓ 縮小、Esc 取消）'), whole, cancel);
    tools.pickBar.hidden = false;
    document.documentElement.classList.add('nt-picking');
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('keydown', onKey, true);
    for (const type of POINTER_EVENTS) document.addEventListener(type, onPointer, true);
    picker = { cancel: () => finish(false) };
  }
  function summarizeSelection(text) {
    picker?.cancel();
    const value = text || String(getSelection() || '');
    startSummary({ kind: 'selection', paragraphs: () => value.split(/\n+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean) });
  }
  function cancelSummary() {
    summaryJob?.ctrl.abort(); summaryJob = null;
    N.ui().summary.hidden = true;
    hideBox();
  }
  function startSummary(source) {
    summaryJob?.ctrl.abort();
    const ctrl = new AbortController();
    const job = { ctrl, source, getTranslator: N.translatorPool(ctrl.signal) };
    summaryJob = job;
    const tools = N.ui();
    tools.summary.hidden = false; tools.copy.disabled = true; tools.retry.hidden = true; tools.notice.textContent = '';
    tools.reselect.hidden = source.kind === 'selection';
    if (source.kind !== 'element') hideBox();
    tools.body.replaceChildren(N.el('p', '正在讀取原文…'));
    tools.close.onclick = cancelSummary;
    tools.retry.onclick = () => startSummary(source);
    tools.reselect.onclick = pickSummary;
    tools.close.focus({ preventScroll: true });
    void runSummary(job);
  }

  // ---- Translate selected text (context menu / shortcut) ----
  let selectionCtrl = null;
  async function translateSelection(text) {
    const value = String(text || getSelection() || '').replace(/\s+/g, ' ').trim();
    const tools = N.ui();
    selectionCtrl?.abort();
    const ctrl = selectionCtrl = new AbortController();
    const close = () => { ctrl.abort(); tools.status('selection', ''); };
    if (!value) { tools.status('selection', '請先選取要翻譯的英文文字。', [['關閉', close]]); return; }
    if (!N.detect(value)) { tools.status('selection', '選取內容不是英文，目前僅支援英文 → 繁中。', [['關閉', close]]); return; }
    tools.status('selection', '翻譯中…', [['取消', close]]);
    try {
      const model = await N.translatorPool(ctrl.signal)('en');
      const output = await N.translateText(model, 'en', value, ctrl.signal);
      N.check(ctrl.signal);
      tools.status('selection', output, [['複製', () => navigator.clipboard.writeText(output).catch(() => {})], ['關閉', close]]);
    } catch (error) {
      if (!ctrl.signal.aborted) tools.status('selection', `翻譯失敗：${error.message}`, [['關閉', close]]);
    }
  }
  async function runSummary(job) {
    const signal = job.ctrl.signal;
    const tools = N.ui();
    let model;
    let destroyed = false;
    const destroy = () => { if (model && !destroyed) { destroyed = true; model.destroy(); } };
    const status = text => { N.check(signal); tools.body.replaceChildren(N.el('p', text)); };
    try {
      const paragraphs = job.source.paragraphs();
      const text = paragraphs.join('\n\n');
      if (text.length < 80) throw new Error(job.source.kind === 'page' ? '這個頁面的文字太少，無法產生摘要。' : '選取範圍的文字太少（至少約 80 字），請重新選取較大的區塊。');
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
    start, stop, toggle: () => current ? stop() : start(), isOn: () => Boolean(current), isPicking: () => Boolean(picker),
    // Long-running; return immediately so callers (executeScript) do not wait for a model download prompt.
    pickSummary, summarizeSelection, translateSelection: text => { void translateSelection(text); },
    getStatus: () => ({ on: Boolean(current), phase: current?.phase || 'off', message: current?.message || '準備好閱讀此頁' }),
    capabilities: async () => ({
      translation: await N.availability('Translator', { sourceLanguage: 'en', targetLanguage: 'zh-Hant' }),
      summary: await N.availability('Summarizer', { type: 'key-points', format: 'markdown', length: 'medium', expectedInputLanguages: ['en'], outputLanguage: 'en' }),
    }),
  };
})();

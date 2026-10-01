// Native CC is the source of truth; only the current caption may render.
(() => {
  if (window.__nanoCaptions) return;
  window.__nanoCaptions = true;
  const N = window.__nano;
  const CAPTIONS = '.ytp-caption-window-container';
  let session = null, settingRevision = 0;
  const active = job => session === job && !job.ctrl.signal.aborted;
  function place(job) {
    if (!active(job) || job.overlay.hidden) return;
    const segment = job.target?.querySelector('.ytp-caption-segment');
    const windows = job.target?.querySelectorAll('.caption-window');
    if (!segment || !windows?.length) return;
    const player = job.player.getBoundingClientRect();
    const caption = windows[windows.length - 1].getBoundingClientRect();
    job.overlay.style.fontSize = `${Math.max(12, parseFloat(getComputedStyle(segment).fontSize) * .9)}px`;
    job.overlay.style.maxWidth = `${player.width * .86}px`;
    const width = job.overlay.offsetWidth;
    job.overlay.style.left = `${Math.max(4, Math.min(caption.left - player.left + caption.width / 2 - width / 2, player.width - width - 4))}px`;
    let top = caption.bottom - player.top + 4;
    if (top + job.overlay.offsetHeight > player.height - 4) top = caption.top - player.top - job.overlay.offsetHeight - 4;
    job.overlay.style.top = `${Math.max(4, top)}px`;
  }
  function clearCaption(job) {
    clearTimeout(job.timer); job.request?.abort(); job.request = null;
    job.overlay.hidden = true; job.overlay.textContent = '';
  }
  async function translate(job, text) {
    const lang = N.detect(text);
    if (!lang) return;
    const request = new AbortController();
    job.request?.abort(); job.request = request;
    const signal = AbortSignal.any([request.signal, job.ctrl.signal]);
    const valid = () => active(job) && !signal.aborted && job.lastText === text;
    try {
      let output = job.cache.get(text);
      if (output === undefined) {
        const model = await job.getTranslator(lang);
        if (!valid()) return;
        output = await model.translate(text, { signal });
        if (!valid()) return;
        job.cache.set(text, output);
        if (job.cache.size > 500) job.cache.delete(job.cache.keys().next().value);
      }
      if (!valid()) return;
      job.overlay.textContent = output; job.overlay.hidden = false; place(job);
      N.ui().status('captions', '');
    } catch (error) {
      if (!valid()) return;
      N.ui().status('captions', error.name === 'AbortError' ? '字幕模型準備已取消。' : `字幕翻譯失敗：${error.message}`, [
        ['重試', () => { if (active(job)) { const latest = read(job); job.lastText = latest; if (latest) void translate(job, latest); } }],
      ]);
    }
  }
  const read = job => [...(job.target?.querySelectorAll('.ytp-caption-segment') || [])].map(node => node.textContent).join(' ').replace(/\s+/g, ' ').trim();
  function onCaption(job) {
    if (!active(job)) return;
    const text = read(job);
    if (text === job.lastText) { place(job); return; }
    clearCaption(job); job.lastText = text;
    if (text) job.timer = setTimeout(() => { if (active(job)) void translate(job, text); }, job.cache.has(text) ? 0 : 350);
  }
  function ensure(job) {
    if (!active(job)) return;
    const player = document.querySelector('.html5-video-player');
    const target = player?.querySelector(CAPTIONS) || null;
    const video = player?.querySelector('video');
    const identity = `${location.pathname}${location.search}|${video?.currentSrc || ''}`;
    if (player !== job.player || target !== job.target || video !== job.video || identity !== job.identity) {
      clearCaption(job); job.lastText = ''; job.cache.clear();
      job.mo.disconnect(); job.resize.disconnect(); job.overlay.remove();
      job.player = player; job.target = target; job.video = video; job.identity = identity;
      if (player) { player.append(job.overlay); job.resize.observe(player); }
      if (target) job.mo.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] });
      onCaption(job);
    }
  }
  function start() {
    if (session) return;
    const ctrl = new AbortController();
    const overlay = N.el('div', '', 'nt-yt');
    overlay.lang = 'zh-Hant'; overlay.hidden = true;
    overlay.style.cssText = 'position:absolute;z-index:60;width:max-content;pointer-events:none;padding:3px 10px;border-radius:5px;text-align:center;color:#fff;background:rgba(18,35,27,.93);font-family:"Microsoft JhengHei",sans-serif;line-height:1.5;overflow-wrap:anywhere;';
    const job = { ctrl, overlay, getTranslator: N.translatorPool(ctrl.signal), cache: new Map(), lastText: '', player: null, target: null };
    session = job;
    job.mo = new MutationObserver(() => onCaption(job));
    job.resize = new ResizeObserver(() => place(job));
    job.ensure = () => ensure(job); job.place = () => place(job);
    window.addEventListener('resize', job.place);
    document.addEventListener('fullscreenchange', job.place);
    document.addEventListener('yt-navigate-finish', job.ensure);
    ensure(job); job.interval = setInterval(job.ensure, 1000);
    N.ui().status('captions', '雙語字幕已開啟；請先在播放器開啟 CC。', [['知道了', () => N.ui().status('captions', '')]]);
  }
  function stop() {
    const job = session;
    if (!job) return;
    session = null; clearCaption(job); job.ctrl.abort();
    clearInterval(job.interval); job.mo.disconnect(); job.resize.disconnect();
    window.removeEventListener('resize', job.place);
    document.removeEventListener('fullscreenchange', job.place);
    document.removeEventListener('yt-navigate-finish', job.ensure);
    job.overlay.remove(); N.ui().status('captions', '');
  }
  (async () => {
    const revision = settingRevision;
    try { const value = await chrome.storage.local.get({ ytSubtitles: false }); if (revision === settingRevision && value.ytSubtitles) start(); }
    catch (error) { console.error('[nano] 字幕設定讀取失敗', error); }
  })();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ytSubtitles) { settingRevision++; changes.ytSubtitles.newValue ? start() : stop(); }
  });
  window.addEventListener('pagehide', stop);
})();

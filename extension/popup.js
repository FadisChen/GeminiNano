const toggleBtn = document.getElementById('toggle');
const summaryBtn = document.getElementById('summary');
const keep = document.getElementById('keep');
const auto = document.getElementById('auto');
const hover = document.getElementById('hover');
const persist = document.getElementById('persist');
const viewerUrl = chrome.runtime.getURL('viewer.html');
const isPdf = url => { try { return /^(https?|file|ftp):/.test(url) && /\.pdf$/i.test(new URL(url).pathname); } catch { return false; } };
const msg = document.getElementById('msg');
let tabId, tabUrl = '', mode = 'page', ready = false, submitting = false, capabilities;
const showError = text => { msg.textContent = text; msg.hidden = false; };
const hint = () => { document.getElementById('keepHint').textContent = keep.checked ? '原文與譯文一起閱讀' : '滑鼠移入或以 Tab 聚焦譯文，可查看原文'; };
const available = state => !['unsupported', 'unavailable'].includes(state);
function buttons() {
  const pdf = mode === 'pdf';
  toggleBtn.disabled = !ready || submitting || (!pdf && !toggleBtn.dataset.on && !available(capabilities?.translation));
  summaryBtn.disabled = !ready || submitting || (!pdf && !available(capabilities?.summary));
}
// all=true 會對所有 frame 執行（全頁翻譯涵蓋 iframe）；回傳主框架的結果。
async function call(command, all = false) {
  if (mode === 'viewer') return chrome.tabs.sendMessage(tabId, { type: 'nt-command', command });
  const target = all ? { tabId, allFrames: true } : { tabId, frameIds: [0] };
  const results = await chrome.scripting.executeScript({ target, func: cmd => window.__nt?.[cmd]?.(), args: [command] });
  return (results.find(result => result.frameId === 0) || results[0])?.result;
}
async function inject() {
  const files = ['runtime.js', 'content.js'];
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files }); }
  catch { await chrome.scripting.executeScript({ target: { tabId }, files }); }
}
const refreshCache = async () => {
  try { const { count } = await chrome.runtime.sendMessage({ type: 'cache-stats' }); document.getElementById('cacheCount').textContent = `已儲存 ${count ?? 0} 筆`; }
  catch { document.getElementById('cacheCount').textContent = '無法讀取'; }
};
document.getElementById('clearCache').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'cache-clear' }); } catch { showError('清除快取失敗。'); }
  void refreshCache();
});
async function init() {
  try {
    const settings = await chrome.storage.local.get({ keepOriginal: true, autoTranslate: false, hoverTranslate: true });
    keep.checked = settings.keepOriginal;
    document.querySelector('[value="translation"]').checked = !settings.keepOriginal;
    const { persistCache } = await chrome.storage.local.get({ persistCache: true });
    persist.checked = persistCache; persist.disabled = false; void refreshCache();
    auto.checked = settings.autoTranslate; hover.checked = settings.hoverTranslate;
    hint(); document.getElementById('modeField').disabled = false; auto.disabled = hover.disabled = false;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('找不到目前分頁。');
    tabId = tab.id; tabUrl = tab.url || '';
    if (!tab.url) {
      // 擴充功能自己的頁面沒有 url；能回應訊息就是 PDF 閱讀器。
      mode = await chrome.tabs.sendMessage(tabId, { type: 'nt-command', command: 'getStatus' }).then(() => 'viewer', () => 'page');
    } else if (tabUrl.startsWith(viewerUrl)) mode = 'viewer';
    else if (isPdf(tabUrl)) mode = 'pdf';
    if (tabUrl.startsWith('file:') && !await chrome.extension.isAllowedFileSchemeAccess()) {
      showError('要翻譯本機檔案，請在 chrome://extensions 開啟此擴充功能的「允許存取檔案網址」。');
    }
    if (mode === 'pdf') {
      document.getElementById('pdfNote').hidden = false;
      document.getElementById('toggleLabel').textContent = '用 PDF 閱讀器開啟';
      document.getElementById('pageStatus').textContent = '此頁為 PDF 文件';
      document.getElementById('translationState').textContent = '翻譯 · 於閱讀器使用';
      document.getElementById('summaryState').textContent = '摘要 · 於閱讀器使用';
      ready = true; buttons();
      return;
    }
    if (mode === 'page') await inject();
    const state = await call('getStatus');
    document.getElementById('toggleLabel').textContent = state.on ? '還原此頁' : '翻譯此頁';
    toggleBtn.dataset.on = state.on ? 'true' : '';
    document.getElementById('pageStatus').textContent = state.message;
    capabilities = await call('capabilities');
    const labels = { available: '可用', downloadable: '需準備模型', downloading: '模型下載中', unavailable: '目前不可用', unsupported: '此環境不支援' };
    document.getElementById('translationState').textContent = `翻譯 · ${labels[capabilities.translation] || '未知狀態'}`;
    document.getElementById('summaryState').textContent = `摘要 · ${labels[capabilities.summary] || '未知狀態'}`;
    ready = true; buttons();
  } catch (error) {
    document.getElementById('pageStatus').textContent = '此頁暫時無法使用';
    document.getElementById('translationState').textContent = '翻譯 · 無法檢查';
    document.getElementById('summaryState').textContent = '摘要 · 無法檢查';
    showError(`無法啟動。Chrome 設定頁、商店及部分受限制頁面不支援；一般頁面可重新整理後再試。${error.message}`);
  }
}
for (const radio of document.querySelectorAll('[name="mode"]')) radio.addEventListener('change', async () => {
  try { await chrome.storage.local.set({ keepOriginal: keep.checked }); hint(); }
  catch { showError('閱讀方式儲存失敗，請重試。'); }
});
for (const [control, key] of [[hover, 'hoverTranslate'], [auto, 'autoTranslate']]) control.addEventListener('change', async () => {
  control.disabled = true;
  try { await chrome.storage.local.set({ [key]: control.checked }); }
  catch { control.checked = !control.checked; showError('設定儲存失敗，請重試。'); }
  finally { control.disabled = false; }
});
persist.addEventListener('change', async () => {
  try { await chrome.storage.local.set({ persistCache: persist.checked }); }
  catch { persist.checked = !persist.checked; showError('設定儲存失敗，請重試。'); }
});
for (const [button, command] of [[toggleBtn, 'toggle'], [summaryBtn, 'pickSummary']]) button.addEventListener('click', async () => {
  if (!ready || submitting) return;
  submitting = true; buttons();
  try {
    if (mode === 'pdf') await chrome.tabs.create({ url: `${viewerUrl}?src=${encodeURIComponent(tabUrl)}` });
    else if (command === 'toggle') await call(toggleBtn.dataset.on ? 'stop' : 'start', true);
    else await call(command);
    window.close();
  }
  catch (error) { showError(`執行失敗：${error.message}`); }
  finally { submitting = false; buttons(); }
});
void init();

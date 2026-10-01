const toggleBtn = document.getElementById('toggle');
const summaryBtn = document.getElementById('summary');
const keep = document.getElementById('keep');
const auto = document.getElementById('auto');
const hover = document.getElementById('hover');
const msg = document.getElementById('msg');
let tabId, ready = false, submitting = false, capabilities;
const showError = text => { msg.textContent = text; msg.hidden = false; };
const hint = () => { document.getElementById('keepHint').textContent = keep.checked ? '原文與譯文一起閱讀' : '滑鼠移入或以 Tab 聚焦譯文，可查看原文'; };
const available = state => !['unsupported', 'unavailable'].includes(state);
function buttons() {
  toggleBtn.disabled = !ready || submitting || (!toggleBtn.dataset.on && !available(capabilities?.translation));
  summaryBtn.disabled = !ready || submitting || !available(capabilities?.summary);
}
async function call(command) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: cmd => window.__nt[cmd](), args: [command] });
  return results[0].result;
}
async function init() {
  try {
    const settings = await chrome.storage.local.get({ keepOriginal: true, autoTranslate: false, hoverTranslate: true });
    keep.checked = settings.keepOriginal;
    document.querySelector('[value="translation"]').checked = !settings.keepOriginal;
    auto.checked = settings.autoTranslate; hover.checked = settings.hoverTranslate;
    hint(); document.getElementById('modeField').disabled = false; auto.disabled = hover.disabled = false;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('找不到目前分頁。');
    tabId = tab.id;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['runtime.js', 'content.js'] });
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
for (const [button, command] of [[toggleBtn, 'toggle'], [summaryBtn, 'summarize']]) button.addEventListener('click', async () => {
  if (!ready || submitting) return;
  submitting = true; buttons();
  try { await call(command); window.close(); }
  catch (error) { showError(`執行失敗：${error.message}`); }
  finally { submitting = false; buttons(); }
});
void init();

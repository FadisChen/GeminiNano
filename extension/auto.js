// 每個頁面載入時執行的輕量載入器：只讀設定，需要時才請 background 注入翻譯程式
(async () => {
  const { autoTranslate } = await chrome.storage.local.get({ autoTranslate: false });
  if (!autoTranslate) return;

  // 頁面有標示語言且不是英文/日文就略過；沒標示的交給段落層級的語言判斷
  const lang = document.documentElement.lang.toLowerCase();
  if (lang && !/^(en|ja)\b/.test(lang)) return;

  await chrome.runtime.sendMessage({ type: 'auto-translate' });
})().catch(err => console.error('[nano] 自動翻譯啟動失敗', err));

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'auto-translate' || !sender.tab?.id) return;
  (async () => {
    const target = { tabId: sender.tab.id };
    try {
      await chrome.scripting.executeScript({ target, files: ['runtime.js', 'content.js'] });
      await chrome.scripting.executeScript({
        target,
        func: () => window.__nt.start(),
      });
    } catch (err) {
      console.error('自動翻譯失敗：', err);
    }
  })();
});

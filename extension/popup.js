const toggleBtn = document.getElementById('toggle');
const toggleLabel = document.getElementById('toggleLabel');
const summaryBtn = document.getElementById('summary');
const keep = document.getElementById('keep');
const auto = document.getElementById('auto');
const keepHint = document.getElementById('keepHint');
const msg = document.getElementById('msg');

const showError = (text) => { msg.textContent = text; msg.hidden = false; };
const updateHint = () => { keepHint.textContent = keep.checked ? '雙語對照顯示' : '只顯示譯文，滑鼠移上去看原文'; };

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.id;
}

// content.js 只負責初始化 window.__nt（可重複注入），實際動作再用 func 呼叫
async function runCommand(command) {
  const target = { tabId: await activeTabId() };
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
  await chrome.scripting.executeScript({ target, func: (cmd) => window.__nt[cmd](), args: [command] });
}

async function init() {
  const { keepOriginal, autoTranslate } = await chrome.storage.local.get({ keepOriginal: true, autoTranslate: false });
  keep.checked = keepOriginal;
  auto.checked = autoTranslate;
  updateHint();
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: await activeTabId() },
      func: () => Boolean(window.__nt?.isOn()),
    });
    toggleLabel.textContent = result ? '還原此頁' : '翻譯此頁';
  } catch {
    toggleBtn.disabled = true;
    summaryBtn.disabled = true;
    showError('此頁面無法使用（例如 chrome:// 或商店頁面）。');
  }
}

keep.addEventListener('change', () => {
  updateHint();
  chrome.storage.local.set({ keepOriginal: keep.checked });
});

auto.addEventListener('change', () => chrome.storage.local.set({ autoTranslate: auto.checked }));

for (const [btn, command] of [[toggleBtn, 'toggle'], [summaryBtn, 'summarize']]) {
  btn.addEventListener('click', async () => {
    try {
      await runCommand(command);
      window.close();
    } catch (err) {
      showError(`執行失敗：${err.message}`);
    }
  });
}

init();

const FILES = ['runtime.js', 'content.js'];
const VIEWER = chrome.runtime.getURL('viewer.html');
const isPdf = url => { try { return /^(https?|file|ftp):/.test(url) && /\.pdf$/i.test(new URL(url).pathname); } catch { return false; } };
const openViewer = src => chrome.tabs.create({ url: src ? `${VIEWER}?src=${encodeURIComponent(src)}` : VIEWER });

// ---- 翻譯結果持久快取（擴充功能自己的 IndexedDB，所有網站共用） ----
const DB_MAX = 20000, DAY = 86400000;
let dbPromise, writes = 0;
const wrap = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const db = () => dbPromise ??= new Promise((resolve, reject) => {
  const request = indexedDB.open('nano-cache', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('t', { keyPath: 'key' }).createIndex('used', 'used');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => { dbPromise = undefined; reject(request.error); };
});
const store = async mode => (await db()).transaction('t', mode).objectStore('t');
async function cacheGet({ key, src }) {
  const t = await store('readwrite');
  const row = await wrap(t.get(key));
  if (!row || row.src !== src) return {};
  if (Date.now() - row.used > DAY) t.put({ ...row, used: Date.now() });
  return { out: row.out };
}
async function trim() {
  const t = await store('readwrite');
  let extra = await wrap(t.count()) - Math.floor(DB_MAX * .9);
  if (extra <= 0) return;
  // 依最近使用時間由舊到新刪除，直到剩下上限的 90%。
  t.index('used').openCursor().onsuccess = event => {
    const cursor = event.target.result;
    if (cursor && extra-- > 0) { cursor.delete(); cursor.continue(); }
  };
}
async function cacheSet({ key, src, out }) {
  await wrap((await store('readwrite')).put({ key, src, out, used: Date.now() }));
  if (++writes % 50 === 0 && await wrap((await store('readonly')).count()) > DB_MAX) await trim();
}
const cacheCount = async () => ({ count: await wrap((await store('readonly')).count()) });
const cacheClear = async () => { await wrap((await store('readwrite')).clear()); return { count: 0 }; };

// ---- 注入與指令 ----
async function inject(tabId, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  try { await chrome.scripting.executeScript({ target, files: FILES }); }
  catch { await chrome.scripting.executeScript({ target: { tabId, frameIds: frameIds || [0] }, files: FILES }); }
}
const call = (tabId, frameIds, command, text) => chrome.scripting.executeScript({
  target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
  func: (name, arg) => window.__nt?.[name]?.(arg), args: [command, text ?? null],
});
async function run(tab, command, { frameId = 0, text } = {}) {
  if (!tab?.id) return;
  try {
    // 擴充功能自己的頁面（閱讀器）沒有 url 且不能注入，改用訊息控制；其他受限頁面會因無接收端而略過。
    if (!tab.url || tab.url.startsWith(VIEWER)) { await chrome.tabs.sendMessage(tab.id, { type: 'nt-command', command, text }).catch(() => {}); return; }
    // Chrome 內建 PDF 檢視器無法注入，改用擴充功能的閱讀器開啟。
    if (isPdf(tab.url) && ['toggle', 'pickSummary'].includes(command)) { await openViewer(tab.url); return; }
    if (command === 'toggle') {
      // 以主框架目前狀態決定開或關，讓所有 iframe 一致。
      await inject(tab.id);
      const [state] = await call(tab.id, [0], 'getStatus');
      await call(tab.id, undefined, state?.result?.on ? 'stop' : 'start');
      return;
    }
    await inject(tab.id, [frameId]);
    await call(tab.id, [frameId], command, text);
  } catch (error) { console.error(`[nano] 指令 ${command} 失敗`, error); }
}

chrome.commands.onCommand.addListener(async command => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const name = { 'toggle-translate': 'toggle', 'pick-summary': 'pickSummary', 'translate-selection': 'translateSelection' }[command];
  if (name) await run(tab, name);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const items = [
      ['toggle', '翻譯／還原此頁', ['page']],
      ['pickSummary', '選取區塊並摘要', ['page']],
      ['translateSelection', '翻譯選取文字', ['selection']],
      ['summarizeSelection', '摘要選取文字', ['selection']],
    ];
    for (const [id, title, contexts] of items) chrome.contextMenus.create({ id, title: `Nano：${title}`, contexts });
    chrome.contextMenus.create({
      id: 'openPdf', title: 'Nano：以閱讀器開啟 PDF', contexts: ['link'],
      targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', 'file:///*.pdf'],
    });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'openPdf') { void openViewer(info.linkUrl); return; }
  void run(tab, info.menuItemId, { frameId: info.frameId, text: info.selectionText });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = { 'cache-get': cacheGet, 'cache-set': cacheSet, 'cache-stats': cacheCount, 'cache-clear': cacheClear };
  if (handlers[message?.type]) {
    handlers[message.type](message).then(sendResponse, () => sendResponse({}));
    return true;
  }
  if (message?.type !== 'auto-translate' || !sender.tab?.id) return;
  // 只注入送出訊息的那個 frame（含 iframe）。
  const target = { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
  (async () => {
    try {
      await chrome.scripting.executeScript({ target, files: FILES });
      await chrome.scripting.executeScript({ target, func: () => window.__nt.start() });
    } catch (err) {
      console.error('自動翻譯失敗：', err);
    }
  })();
});

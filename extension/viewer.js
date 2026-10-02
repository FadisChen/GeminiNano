import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const { buildParagraphs } = globalThis.__pdfText;
const $ = id => document.getElementById(id);
const doc = $('doc'), status = $('status'), translate = $('translate'), summary = $('summary');
let loading = 0;

const setStatus = text => { status.textContent = text; };
const showEmpty = text => doc.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty', textContent: text }));
const label = () => { translate.textContent = window.__nt.isOn() ? '還原' : '翻譯'; };

async function load(source, name) {
  const mine = ++loading;
  window.__nt.stop();
  translate.disabled = summary.disabled = true;
  $('file').textContent = name;
  document.title = `${name} · Nano PDF 閱讀器`;
  doc.replaceChildren();
  setStatus('載入中…');
  try {
    let data = source;
    if (typeof source === 'string') {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`下載失敗（HTTP ${response.status}）`);
      data = await response.arrayBuffer();
    }
    const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    let found = 0;
    for (let number = 1; number <= pdf.numPages && mine === loading; number++) {
      const page = await pdf.getPage(number);
      const paragraphs = buildParagraphs((await page.getTextContent()).items);
      if (mine !== loading) return;
      const section = document.createElement('section');
      section.className = 'page';
      const heading = document.createElement('h2');
      heading.className = 'pageno'; heading.translate = false; heading.textContent = `第 ${number} 頁`;
      section.append(heading);
      for (const paragraph of paragraphs) {
        const node = document.createElement(paragraph.heading ? 'h3' : 'p');
        node.textContent = paragraph.text;
        section.append(node);
      }
      doc.append(section);
      found += paragraphs.length;
      setStatus(`已載入 ${number} / ${pdf.numPages} 頁`);
      if (number === 1) translate.disabled = summary.disabled = false;
    }
    if (mine !== loading) return;
    if (!found) showEmpty('這份 PDF 沒有可擷取的文字（可能是掃描影像），目前無法翻譯或摘要。');
    setStatus(found ? `共 ${pdf.numPages} 頁` : '');
    const { autoTranslate } = await chrome.storage.local.get({ autoTranslate: false });
    if (found && autoTranslate && mine === loading) { window.__nt.start(); label(); }
  } catch (error) {
    if (mine !== loading) return;
    const hint = /^file:/.test(String(source)) ? '本機檔案需在 chrome://extensions 開啟此擴充功能的「允許存取檔案網址」。' : '';
    showEmpty(`無法載入 PDF：${error.message || error}。${hint}`);
    setStatus('');
  }
}

$('open').addEventListener('click', () => $('picker').click());
$('picker').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) void load(await file.arrayBuffer(), file.name);
});
translate.addEventListener('click', () => { window.__nt.toggle(); label(); });
summary.addEventListener('click', () => window.__nt.pickSummary());
for (const type of ['dragenter', 'dragover']) document.addEventListener(type, e => { e.preventDefault(); document.body.classList.add('drag'); });
for (const type of ['dragleave', 'drop']) document.addEventListener(type, () => document.body.classList.remove('drag'));
document.addEventListener('drop', async e => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) void load(await file.arrayBuffer(), file.name);
});

// 快捷鍵、右鍵選單與工具列彈出視窗透過訊息控制此頁面。
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== 'nt-command') return;
  const nt = window.__nt;
  const name = message.command === 'toggle' ? (nt.isOn() ? 'stop' : 'start') : message.command;
  Promise.resolve(nt[name]?.(message.text)).then(result => { label(); respond(result ?? null); }, () => respond(null));
  return true;
});

const src = new URLSearchParams(location.search).get('src');
if (src) {
  let name = src;
  try { name = decodeURIComponent(new URL(src).pathname.split('/').pop()) || src; } catch { /* keep raw url */ }
  void load(src, name);
}

# Nano翻譯官

使用 Chrome 內建的 Translator / Summarizer / LanguageDetector API（Gemini Nano，全程在本機執行），閱讀英文網頁並翻成繁體中文。僅針對 Windows 版 Chrome 設計。

## 功能
- **翻譯此頁**：以「文字區塊」為單位（連結、粗體等行內元素合併成同一句）做雙語對照或只看譯文；捲動到才翻譯，支援動態頁面與 iframe。
- **滑鼠停留翻譯**：未翻譯整頁時，指向文字區塊即彈出譯文。
- **自動翻譯新頁面**：載入英文頁面時自動啟動。
- **選取區塊並摘要**：按下後在網頁上以紅框點選要摘要的區塊（↑ 放大範圍、↓ 縮小、Esc 取消，也可選「摘要整頁」）；支援英文與繁／簡中文文章（模型不支援中文時會先轉英文再摘要，最後翻回繁中）；長文會分段摘要後再整合，可複製結果。
- **快捷鍵與右鍵選單**：`Alt+T` 翻譯／還原、`Alt+S` 選取區塊摘要、`Alt+Shift+T` 翻譯選取文字（可至 `chrome://extensions/shortcuts` 修改）。網頁右鍵選單提供翻譯此頁、選取區塊摘要、翻譯／摘要選取文字、以閱讀器開啟 PDF 連結。
- **持久翻譯快取**：翻譯結果存在擴充功能自己的 IndexedDB（上限約 2 萬筆，依最近使用淘汰），重訪頁面直接使用；資料只留在本機，可在彈出視窗關閉或清除。
- **PDF 閱讀器**：Chrome 內建 PDF 檢視器無法被擴充功能注入，因此提供 `viewer.html`（內含 pdf.js）把 PDF 文字還原成段落，之後即可使用翻譯與摘要。PDF 分頁按工具列圖示、`Alt+T` 或 `Alt+S` 會自動開啟；也可拖曳／選取本機 PDF。掃描影像型 PDF 沒有文字，無法處理。
- **本機 HTML**：開啟 `file://` 頁面前，需在 `chrome://extensions` 對本擴充功能啟用「允許存取檔案網址」（彈出視窗會提醒）。

## 安裝
1. 開啟 `chrome://extensions`，啟用「開發人員模式」。
2. 「載入未封裝項目」，選擇本專案的 `extension/` 資料夾。
3. 首次使用需連線下載語言模型（`chrome://on-device-internals` 可檢視模型狀態）。

## 結構
| 檔案 | 說明 |
|---|---|
| `runtime.js` | 共用邏輯：語言偵測、模型池、翻譯快取（LRU）、浮動 UI、Markdown 解析 |
| `content.js` | 全頁翻譯（區塊掃描、MutationObserver、IntersectionObserver）與摘要 |
| `loader.js` | 每頁載入器：滑鼠停留翻譯、依設定觸發自動翻譯 |
| `background.js` | 快捷鍵、右鍵選單、自動翻譯注入，以及持久快取（IndexedDB） |
| `viewer.*`、`pdftext.js`、`vendor/pdfjs/` | PDF 閱讀器（pdf.js，Apache-2.0）與文字段落還原 |
| `popup.*` | 工具列彈出視窗 |

## 開發
```
npm test
```
測試涵蓋語言偵測、長文切分、記憶體／持久快取、Markdown 解析、PDF 段落還原與 manifest 檔案檢查；沒有建置步驟，直接載入 `extension/` 即可。

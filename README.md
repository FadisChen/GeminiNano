# Nano翻譯官

使用 Chrome 內建的 Translator / Summarizer / LanguageDetector API（Gemini Nano，全程在本機執行），閱讀英文網頁並翻成繁體中文。僅針對 Windows 版 Chrome 設計。

## 功能
- **翻譯此頁**：以「文字區塊」為單位（連結、粗體等行內元素合併成同一句）做雙語對照或只看譯文；捲動到才翻譯，支援動態頁面與 iframe。
- **滑鼠停留翻譯**：未翻譯整頁時，指向文字區塊即彈出譯文。
- **自動翻譯新頁面**：載入英文頁面時自動啟動。
- **重點摘要**：長文會分段摘要後再整合；可複製結果。

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
| `background.js` | 接收自動翻譯請求並注入對應 frame |
| `popup.*` | 工具列彈出視窗 |

## 開發
```
npm test
```
測試涵蓋語言偵測、長文切分、快取、Markdown 解析與 manifest 檔案檢查；沒有建置步驟，直接載入 `extension/` 即可。

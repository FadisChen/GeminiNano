// 把 pdf.js 的文字項目（getTextContent().items）還原成段落。純函式，瀏覽器與 Node 測試共用。
(() => {
  const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[sorted.length >> 1] || 0; };

  function toLines(items) {
    const lines = [];
    let line = null, last = null;
    for (const item of items) {
      if (!item.str && !item.hasEOL) continue;
      const x = item.transform[4], y = item.transform[5], h = item.height || Math.abs(item.transform[3]) || 10;
      if (!line || Math.abs(y - line.y) > Math.max(h, line.h) * .5) {
        line = { text: '', x, y, h, end: x };
        lines.push(line);
      } else if (last && item.str && !/\s$/.test(line.text) && !/^\s/.test(item.str) && x - (last.x + last.width) > h * .15) line.text += ' ';
      line.text += item.str;
      line.h = Math.max(line.h, h);
      line.end = Math.max(line.end, x + (item.width || 0));
      last = { x, width: item.width || 0 };
      if (item.hasEOL) { line = null; last = null; }
    }
    return lines.map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter(l => l.text);
  }

  // Returns [{ text, heading }] in reading order.
  function buildParagraphs(items) {
    const lines = toLines(items);
    if (!lines.length) return [];
    const bodyHeight = median(lines.map(l => l.h));
    const maxWidth = Math.max(...lines.map(l => l.end - l.x));
    const paragraphs = [];
    let current = null, previous = null;
    for (const line of lines) {
      const heading = line.h > bodyHeight * 1.25 && line.text.length < 120;
      const gap = previous ? previous.y - line.y : 0;
      const newBlock = !current || heading || current.heading
        || gap < 0 || gap > Math.max(previous.h, line.h) * 1.7
        || (previous.end - previous.x < maxWidth * .6 && /[.!?:]["')\]]?$/.test(previous.text));
      if (newBlock) { current = { text: line.text, heading }; paragraphs.push(current); }
      else if (/[A-Za-z]-$/.test(current.text) && /^[a-z]/.test(line.text)) current.text = current.text.slice(0, -1) + line.text;
      else current.text += ` ${line.text}`;
      previous = line;
    }
    return paragraphs;
  }

  const api = { buildParagraphs };
  if (typeof module !== 'undefined') module.exports = api; else globalThis.__pdfText = api;
})();

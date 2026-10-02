const test = require('node:test');
const assert = require('node:assert/strict');
const { buildParagraphs } = require('../extension/pdftext.js');

const item = (str, x, y, { h = 10, width = str.length * 5, hasEOL = false } = {}) => ({ str, transform: [h, 0, 0, h, x, y], height: h, width, hasEOL });

test('joins wrapped lines into paragraphs and splits on large gaps', () => {
  const paragraphs = buildParagraphs([
    item('This is the first line of a', 50, 700, { width: 300 }), item('', 0, 0, { hasEOL: true }),
    item('paragraph that continues here.', 50, 688, { width: 160 }), item('', 0, 0, { hasEOL: true }),
    item('A second paragraph starts after a gap.', 50, 650, { width: 250 }),
  ]);
  assert.deepEqual(paragraphs.map(p => p.text), ['This is the first line of a paragraph that continues here.', 'A second paragraph starts after a gap.']);
});

test('detects large text as heading and merges hyphenated words', () => {
  const paragraphs = buildParagraphs([
    item('Big Title', 50, 760, { h: 20, width: 90 }),
    item('An infor-', 50, 720, { width: 300 }),
    item('mation sentence continues on.', 50, 708, { width: 300 }),
  ]);
  assert.deepEqual(paragraphs, [{ text: 'Big Title', heading: true }, { text: 'An information sentence continues on.', heading: false }]);
});

test('inserts spaces between items on the same line only when there is a gap', () => {
  const [paragraph] = buildParagraphs([item('Hello', 50, 700, { width: 25 }), item('world', 85, 700, { width: 25 }), item('!', 110, 700, { width: 5 })]);
  assert.equal(paragraph.text, 'Hello world!');
  assert.deepEqual(buildParagraphs([]), []);
});

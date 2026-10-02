const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../extension/runtime.js'), 'utf8'));
const N = globalThis.__nano;

test('detect: English, Japanese and Chinese', () => {
  assert.equal(N.detect('Hello world, this is a test.'), 'en');
  assert.equal(N.detect('これは日本語の文章です'), null);
  assert.equal(N.detect('這是一段繁體中文'), null);
  assert.equal(N.detect('12345 !!!'), null);
});

test('detect: honours lang hints', () => {
  const el = lang => ({ closest: () => ({ lang }) });
  assert.equal(N.detect('Bonjour le monde', el('fr')), null);
  assert.equal(N.detect('Hello world', el('ja')), null);
  assert.equal(N.detect('Hello world', el('zh-TW')), null);
});

test('confirmLanguage: rejects other Latin-script languages via LanguageDetector', async () => {
  const text = 'Bonjour tout le monde, ceci est une phrase en français.';
  assert.equal(await N.confirmLanguage(text, 'zh'), true);
  assert.equal(await N.confirmLanguage('Short text', 'en'), true);
  globalThis.LanguageDetector = {
    availability: async () => 'available',
    create: async () => ({ detect: async () => [{ detectedLanguage: 'fr', confidence: .95 }] }),
  };
  assert.equal(await N.confirmLanguage(text, 'en'), false);
  assert.equal(await N.confirmLanguage(text, 'en', { closest: () => ({ lang: 'en-US' }) }), true);
});

test('splitText keeps all content and respects the limit', () => {
  const text = 'One sentence here. Another sentence follows! ' + 'x'.repeat(50) + ' 最後です。';
  const parts = N.splitText(text, 40);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => part.length <= 40));
  assert.deepEqual(N.splitText('short', 40), ['short']);
});

test('translateText caches results and chunks long input', async () => {
  const calls = [];
  const model = { translate: async text => { calls.push(text); return `譯:${text.length}`; } };
  const signal = new AbortController().signal;
  assert.equal(await N.translateText(model, 'en', 'Hello there.', signal), '譯:12');
  assert.equal(await N.translateText(model, 'en', 'Hello there.', signal), '譯:12');
  assert.equal(calls.length, 1);
  await N.translateText(model, 'en', 'Sentence one. '.repeat(300), signal);
  assert.ok(calls.length > 2);
  assert.ok(calls.slice(1).every(call => call.length <= 1500));
});

test('packParagraphs packs by budget', () => {
  const chunks = N.packParagraphs(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)], 100);
  assert.deepEqual(chunks.map(c => c.length), [82, 40]);
  assert.ok(N.packParagraphs(['z'.repeat(250)], 100).every(c => c.length <= 100));
});

test('parseMarkdown: headings, nested lists and inline marks', () => {
  const [heading, list, tail] = N.parseMarkdown('# 標題\n* **重點** 一\n  - 子項 `code`\n* 二\n結尾 *斜體*');
  assert.equal(heading.type, 'h');
  assert.equal(list.type, 'list');
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[0].inline[0], { t: 'b', v: '重點' });
  assert.equal(list.items[0].children[0].items[0].inline[1].t, 'code');
  assert.equal(tail.type, 'p');
  assert.deepEqual(tail.inline[1], { t: 'i', v: '斜體' });
});

test('parseMarkdown: ordered list after bullet list starts a new list', () => {
  const blocks = N.parseMarkdown('- a\n1. b\n2) c');
  assert.deepEqual(blocks.map(b => [b.type, b.ordered, b.items.length]), [['list', false, 1], ['list', true, 2]]);
});

test('translateText uses and fills the persistent cache', async () => {
  const sent = [];
  globalThis.chrome = { runtime: { sendMessage: async message => {
    sent.push(message);
    return message.type === 'cache-get' && message.src.includes('stored text') ? { out: '已儲存' } : {};
  } } };
  const model = { translate: async () => '新譯文' };
  const signal = new AbortController().signal;
  assert.equal(await N.translateText(model, 'en', 'stored text for cache', signal), '已儲存');
  assert.equal(await N.translateText(model, 'en', 'fresh text for cache', signal), '新譯文');
  assert.deepEqual(sent.map(m => m.type), ['cache-get', 'cache-get', 'cache-set']);
  assert.equal(sent[2].out, '新譯文');
  assert.match(N.hashText('abc'), /^[a-z0-9]+\.3$/);
  delete globalThis.chrome;
});

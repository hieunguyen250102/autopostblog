#!/usr/bin/env node
/**
 * Chạy thật JavaScript bên trong các node Code của workflow AutoPost với dữ liệu
 * giả, để chắc chắn từng bước xử lý đúng các tình huống.
 *
 *   node tools/test-logic.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', 'autopost.json'), 'utf8'));

// vm tạo realm riêng nên object trả về khác prototype => so sánh sau khi JSON hoá.
const plain = (v) => JSON.parse(JSON.stringify(v));

const codeOf = (nodeName) => {
  const n = wf.nodes.find((x) => x.name === nodeName);
  assert.ok(n, `không thấy node "${nodeName}"`);
  assert.equal(n.type, 'n8n-nodes-base.code');
  return n.parameters.jsCode;
};

/**
 * Giả lập môi trường Code node của n8n.
 * nodes: { 'Tên node': [ {json}, ... ] } — output của các node trước.
 * Trả về mảng item đã JSON hoá.
 */
function runNode(nodeName, { input = [], nodes = {} } = {}) {
  const wrap = (items) => ({ all: () => items, first: () => items[0] });
  const sandbox = {
    $input: wrap(input),
    $json: input.length ? input[0].json : {},
    $: (name) => {
      if (!(name in nodes)) throw new Error(`No node named "${name}"`);
      return wrap(nodes[name]);
    },
    Intl,
    console: { log() {} },
  };
  const script = new vm.Script(`(function () {\n${codeOf(nodeName)}\n})()`);
  return plain(script.runInNewContext(sandbox, { timeout: 5000 })).map((i) => i.json);
}

const configNode = wf.nodes.find((n) => n.name === 'Config');
const CONFIG = Object.fromEntries(configNode.parameters.assignments.assignments.map((a) => [a.name, a.value]));
const cfg = (over = {}) => [{ json: { ...CONFIG, ...over } }];
const items = (rows) => rows.map((json) => ({ json }));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------- cấu trúc */

test('một workflow, 3 lịch chạy, không còn webhook / Drive', () => {
  const types = wf.nodes.map((n) => n.type);
  assert.equal(types.filter((t) => t === 'n8n-nodes-base.scheduleTrigger').length, 3);
  assert.ok(!types.includes('n8n-nodes-base.webhook'));
  assert.ok(!JSON.stringify(wf).includes('googleDriveOAuth2Api'));
});

test('Chọn việc: mỗi lịch đi đúng một nhánh', () => {
  const route = wf.connections['Chọn việc'].main.map((out) => out[0].node);
  assert.deepEqual(route, ['Sheets: Đọc Posts (thu)', 'Sheets: Đọc Prompt', 'Sheets: Đọc Posts (đăng)']);
  const keys = wf.nodes.find((n) => n.name === 'Chọn việc').parameters.rules.values.map((v) => v.conditions.conditions[0].rightValue);
  assert.deepEqual(keys, ['collect', 'translate', 'publish']);
});

/* ------------------------------------------------------------- 1. thu bài */

const SOURCES = [
  { json: { source_name: 'Page A', page: 'https://www.facebook.com/a', max_posts: 5 } },
  { json: { source_name: 'Page B', page: 'https://www.facebook.com/b', max_posts: 5 } },
];

test('Sources: chỉ lấy dòng active có link, max_posts tối đa 10', () => {
  const r = runNode('Lọc nguồn đang bật', {
    input: items([
      { source_name: 'A', page_url: 'https://www.facebook.com/a', active: true, max_posts: 50 },
      { source_name: 'B', page_url: 'https://www.facebook.com/b', active: false },
      { source_name: 'C', page_url: '', active: 'TRUE' },
      { page_id_or_url: 'https://www.facebook.com/d', active: 'x' },
    ]),
    nodes: { Config: cfg() },
  });
  assert.deepEqual(r.map((x) => [x.source_name, x.page, x.max_posts]), [
    ['A', 'https://www.facebook.com/a', 10],
    ['https://www.facebook.com/d', 'https://www.facebook.com/d', 5],
  ]);
});

test('Sources: không có page nào bật => báo lỗi rõ', () => {
  assert.throws(() => runNode('Lọc nguồn đang bật', { input: items([{ active: false }]), nodes: { Config: cfg() } }), /chưa có page nào bật/);
});

const normCrawler = (responses, over = {}) =>
  runNode('Chuẩn hoá bài crawler', { input: items(responses), nodes: { Config: cfg(over), 'Lọc nguồn đang bật': SOURCES } });
const cpost = (id, extra = {}) => ({ source_post_id: id, source_post_url: `https://fb/${id}`, text: `Bài ${id}\n\nđoạn 2`, images: ['https://x/1.jpg'], ...extra });

test('crawler: gán đúng tên page, giữ xuống dòng, ảnh tối đa 10', () => {
  const many = Array.from({ length: 12 }, (_, i) => `https://x/${i}.jpg`);
  const r = normCrawler([{ ok: true, posts: [cpost('1')] }, { ok: true, posts: [cpost('2', { images: many })] }]);
  assert.deepEqual(r.map((x) => x.source_page), ['Page A', 'Page B']);
  assert.equal(r[0].source_text, 'Bài 1\n\nđoạn 2');
  assert.equal(r[0].title, 'Bài 1 đoạn 2');
  assert.equal(r[1].source_images.length, 10);
});

test('crawler: bỏ reel/video không ảnh (tắt được bằng skip_video_posts)', () => {
  const resp = [{ ok: true, posts: [cpost('v', { images: [], has_video: true }), cpost('p')] }, { ok: true, posts: [cpost('q')] }];
  assert.deepEqual(normCrawler(resp).map((x) => x.source_post_id), ['p', 'q']);
  assert.equal(normCrawler(resp, { skip_video_posts: false }).length, 3);
});

test('crawler: bài chia sẻ có nhãn; 1 page lỗi / 0 bài không chặn page khác', () => {
  const r = normCrawler([{ ok: false, error: 'checkpoint' }, { ok: true, posts: [cpost('s', { is_shared: true })] }]);
  assert.equal(r.length, 1);
  assert.match(r[0].title, /^\[Chia sẻ\]/);
  assert.equal(normCrawler([{ ok: true, posts: [] }, { ok: true, posts: [cpost('t')] }]).length, 1);
});

test('crawler: mọi page lỗi hoặc 0 bài => báo lỗi đỏ', () => {
  assert.throws(() => normCrawler([{ error: { message: 'connect ECONNREFUSED' } }, { ok: true, posts: [] }]), /tất cả page.*ECONNREFUSED.*không lấy được bài nào/);
});

const dedupe = (posts, known = { existing_keys: ['cu'], max_post_number: 7 }) =>
  runNode('Bỏ trùng + tạo post_id', { input: items(posts), nodes: { Config: cfg(), 'Gom bài đã có': [{ json: known }] } });

test('bỏ trùng + post_id nối tiếp; có chữ => NEED_TRANSLATE, ảnh mỗi dòng 1 link', () => {
  const r = dedupe([
    { source_post_id: 'p1', source_text: 'Xin chào', source_images: ['https://x/a.jpg', 'https://x/b.jpg'] },
    { source_post_id: 'p1', source_text: 'trùng trong cùng lần' },
    { source_post_id: 'cu', source_text: 'đã có trong sheet' },
    { source_post_id: 'p2', source_text: '' },
  ]);
  assert.deepEqual(r.map((x) => [x.post_id, x.status]), [['AP-0008', 'NEED_TRANSLATE'], ['AP-0009', 'NEED_CONTENT']]);
  assert.equal(r[0].source_images, 'https://x/a.jpg\nhttps://x/b.jpg');
  assert.equal(r[0].images_count, 2);
  assert.equal(r[0].publish_now, false);
});

test('Gom bài đã có: lấy khoá chống trùng + số post_id lớn nhất', () => {
  const [r] = runNode('Gom bài đã có', { input: items([{ post_id: 'AP-0012', source_post_id: 'x' }, { post_id: 'AP-0003', source_post_url: 'u' }, {}]) });
  assert.equal(r.max_post_number, 12);
  assert.deepEqual(r.existing_keys, ['x', 'u']);
});

/* ---------------------------------------------------------------- 2. dịch */

test('lấy prompt từ tab Prompt, thiếu tab thì dùng mặc định', () => {
  const [fromSheet] = runNode('Lấy prompt', { input: items([{ 'Prompt dịch — sửa thoải mái': 'Dịch nhé:\n{{NOI_DUNG}}' }]) });
  assert.equal(fromSheet.prompt, 'Dịch nhé:\n{{NOI_DUNG}}');
  const [fallback] = runNode('Lấy prompt', { input: items([{ error: 'Sheet not found' }]) });
  assert.equal(fallback.from_sheet, false);
  assert.match(fallback.prompt, /\{\{NOI_DUNG\}\}/);
});

const pickT = (rows, limit = 3) =>
  runNode('Chọn bài cần dịch', {
    input: items(rows),
    nodes: { Config: cfg({ translate_per_run: limit }), 'Lấy prompt': [{ json: { prompt: 'P: {{NOI_DUNG}} $& end' } }] },
  });

test('chỉ dịch dòng NEED_TRANSLATE có source_text và chưa có en_text', () => {
  const r = pickT([
    { row_number: 2, post_id: 'AP-1', status: 'NEED_TRANSLATE', source_text: 'Xin chào $1' },
    { row_number: 3, post_id: 'AP-2', status: 'NEED_TRANSLATE', source_text: 'x', en_text: 'đã có' },
    { row_number: 4, post_id: 'AP-3', status: 'REVIEW', source_text: 'x' },
    { row_number: 5, post_id: 'AP-4', status: 'NEED_TRANSLATE', source_text: '' },
  ]);
  assert.deepEqual(r.map((x) => x.post_id), ['AP-1']);
  assert.equal(r[0].request_body.contents[0].parts[0].text, 'P: Xin chào $1 $& end', 'chèn nguyên văn, $ không bị hiểu là mẫu thay thế');
});

test('giới hạn số bài dịch mỗi lần', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ row_number: i + 2, post_id: `AP-${i}`, status: 'NEED_TRANSLATE', source_text: 'x' }));
  assert.equal(pickT(rows, 2).length, 2);
});

const applyT = (responses) =>
  runNode('Gắn bản dịch', {
    input: items(responses),
    nodes: { Config: cfg(), 'Chọn bài cần dịch': responses.map((_, i) => ({ json: { row_number: 10 + i, post_id: `AP-${i}` } })) },
  });
const gem = (text, finishReason = 'STOP') => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });

test('Gemini dịch xong => en_text + REVIEW, bỏ code block AI tự thêm', () => {
  const [r] = applyT([gem('```\nHello world 🌏\n\n\n\n#travel\n```')]);
  assert.equal(r.row_number, 10);
  assert.equal(r.status, 'REVIEW');
  assert.equal(r.en_text, 'Hello world 🌏\n\n#travel');
});

test('Gemini: bỏ phần "thought", cảnh báo khi bị cắt MAX_TOKENS', () => {
  const [r] = applyT([{ candidates: [{ content: { parts: [{ text: 'nghĩ...', thought: true }, { text: 'Final' }] }, finishReason: 'MAX_TOKENS' }] }]);
  assert.equal(r.en_text, 'Final');
  assert.match(r.check_note, /MAX_TOKENS/);
});

test('hết quota / quá tải / sai key => giữ NEED_TRANSLATE để tự thử lại', () => {
  for (const msg of ['429 RESOURCE_EXHAUSTED', 'The service is currently unavailable (503)', 'API key not valid. Please pass a valid API key.']) {
    const [r] = applyT([{ error: { message: msg } }]);
    assert.equal(r.status, undefined, msg);
    assert.equal(r.en_text, undefined);
    assert.match(r.check_note, /tự thử lại/);
  }
});

test('bị chặn nội dung / lỗi khác => ERROR, gợi ý dịch tay', () => {
  const [blocked] = applyT([{ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }]);
  assert.equal(blocked.status, 'ERROR');
  assert.match(blocked.check_note, /SAFETY/);
  const [bad] = applyT([{ error: { message: '400 model not found' } }]);
  assert.equal(bad.status, 'ERROR');
  assert.match(bad.check_note, /menu 🌐/);
});

/* ---------------------------------------------------------------- 3. đăng */

const due = (rows) => runNode('Chọn bài đến hạn', { input: items(rows), nodes: { Config: cfg() } });

test('tick publish_now => được chọn, kèm dữ liệu dòng', () => {
  const [r] = due([{ row_number: 4, post_id: 'AP-1', status: 'REVIEW', publish_now: true, en_text: 'x' }]);
  assert.equal(r.post_id, 'AP-1');
  assert.equal(r.row_number, 4);
  assert.equal(r.en_text, 'x');
  assert.equal(r.reason, 'tick publish_now');
  assert.equal(r.sort, undefined);
});

test('checkbox dạng chữ "TRUE"/"x" cũng hiểu, "FALSE" thì không', () => {
  assert.equal(due([{ post_id: 'AP-1', publish_now: 'TRUE' }]).length, 1);
  assert.equal(due([{ post_id: 'AP-2', publish_now: 'x' }]).length, 1);
  assert.equal(due([{ post_id: 'AP-3', publish_now: 'FALSE' }]).length, 0);
});

test('bỏ qua POSTED / POSTING / SKIP dù có tick', () => {
  for (const status of ['POSTED', 'POSTING', 'SKIP']) assert.equal(due([{ post_id: 'AP-1', status, publish_now: true }]).length, 0, status);
});

test('mỗi lượt chỉ đăng 1 bài: tick tay trước, rồi bài hẹn giờ sớm nhất', () => {
  const r = due([
    { post_id: 'H2', scheduled_at: '2000-01-02 08:00' },
    { post_id: 'H1', scheduled_at: '2000-01-01 08:00' },
    { post_id: 'T', publish_now: true },
  ]);
  assert.deepEqual(r.map((x) => x.post_id), ['T']);
  assert.deepEqual(due([{ post_id: 'H2', scheduled_at: '2000-01-02 08:00' }, { post_id: 'H1', scheduled_at: '2000-01-01 08:00' }]).map((x) => x.post_id), ['H1']);
});

test('hẹn giờ: quá khứ => đăng, tương lai / không đọc được => chưa', () => {
  assert.equal(due([{ post_id: 'A', scheduled_at: '2000-01-01T08:00:00' }]).length, 1);
  assert.equal(due([{ post_id: 'B', scheduled_at: '31/01/2000 08:00:00' }]).length, 1, 'dd/mm/yyyy');
  assert.equal(due([{ post_id: 'C', scheduled_at: 36526.5 }]).length, 1, 'ô ngày (serial) của Sheet');
  assert.equal(due([{ post_id: 'D', scheduled_at: '2999-01-01 08:00' }]).length, 0);
  assert.equal(due([{ post_id: 'E', scheduled_at: 'sáng mai' }]).length, 0);
});

test('bài hẹn giờ đã ERROR không bị thử lại vô hạn (tick tay vẫn được)', () => {
  assert.equal(due([{ post_id: 'A', status: 'ERROR', scheduled_at: '2000-01-01 08:00' }]).length, 0);
  assert.equal(due([{ post_id: 'A', status: 'ERROR', scheduled_at: '2000-01-01 08:00', publish_now: true }]).length, 1);
});

test('dòng trống / thiếu post_id bị bỏ qua', () => {
  assert.equal(due([{}, { post_id: '', publish_now: true }]).length, 0);
});

const EN = 'This is the English translation of the original post, long enough to pass.';
const URL1 = 'https://scontent.xx.fbcdn.net/v/1.jpg?oe=A';
const URL2 = 'https://scontent.xx.fbcdn.net/v/2.jpg?oe=B';
const check = (row, over = {}) => runNode('Kiểm tra bài', { input: items([{ row_number: 7, post_id: 'AP-7', reason: 'tick', ...row }]), nodes: { Config: cfg(over) } })[0];

test('kiểm tra: đủ bản dịch + ảnh => ok, ảnh giữ thứ tự, bỏ rác', () => {
  const r = check({ en_text: `﻿${EN}\r\n\n\n\nHết.`, source_images: `${URL1}\n  ${URL2}\nrác` });
  assert.equal(r.ok, true, r.errors.join('|'));
  assert.equal(r.message, `${EN}\n\nHết.`);
  assert.deepEqual(r.images.map((i) => i.url), [URL1, URL2]);
  assert.equal(r.row_number, 7);
});

test('kiểm tra: chưa dịch / quá ngắn / quá dài => lỗi rõ', () => {
  assert.match(check({ source_text: 'gốc', source_images: URL1 }).errors[0], /chờ Gemini/);
  assert.match(check({ en_text: 'Hi', source_images: URL1 }).errors[0], /quá ngắn/);
  assert.match(check({ en_text: 'A'.repeat(60001), source_images: URL1 }).errors[0], /quá dài/);
});

test('kiểm tra: thiếu ảnh / quá 10 ảnh; min_images = 0 cho bài chỉ chữ', () => {
  assert.match(check({ en_text: EN }).errors[0], /Thiếu ảnh/);
  const many = Array.from({ length: 11 }, (_, i) => `${URL1}&n=${i}`).join('\n');
  assert.match(check({ en_text: EN, source_images: many }).errors[0], /Quá nhiều ảnh/);
  assert.equal(check({ en_text: EN }, { min_images: 0 }).ok, true);
});

const payload = (checkOut, nodes = {}) =>
  runNode('Soạn payload bài đăng', { input: [{ json: {} }], nodes: { 'Kiểm tra bài': [{ json: checkOut }], ...nodes } })[0];
const CHECKED = { row_number: 7, message: EN, images_count: 2, content_chars: EN.length };

test('payload gắn đúng media_fbid theo thứ tự', () => {
  const r = payload(CHECKED, { 'Tải ảnh gốc': items([{}, {}]), 'FB: Upload ảnh (chưa publish)': items([{ id: '111' }, { id: '222' }]) });
  assert.equal(r.upload_ok, true);
  assert.deepEqual(r.payload, { message: EN, attached_media: [{ media_fbid: '111' }, { media_fbid: '222' }] });
});

test('tải ảnh gốc lỗi => huỷ đăng, báo link hết hạn', () => {
  const r = payload(CHECKED, {
    'Tải ảnh gốc': items([{}, { error: { message: '403 Forbidden' } }]),
    'FB: Upload ảnh (chưa publish)': items([{ id: '111' }, { error: { message: 'no binary' } }]),
  });
  assert.equal(r.upload_ok, false);
  assert.match(r.error.message, /1\/2/);
  assert.match(r.error.message, /tải ảnh 2 lỗi: 403 Forbidden.*vài ngày/);
});

test('Facebook từ chối upload => có lý do từng ảnh', () => {
  const r = payload({ ...CHECKED, images_count: 1 }, { 'Tải ảnh gốc': items([{}]), 'FB: Upload ảnh (chưa publish)': items([{ error: { message: 'Invalid image' } }]) });
  assert.equal(r.upload_ok, false);
  assert.match(r.error.message, /upload ảnh 1 lỗi: Invalid image/);
});

test('bài không ảnh => chỉ có message, không đọc dữ liệu ảnh cũ', () => {
  const r = payload({ ...CHECKED, images_count: 0 }, { 'FB: Upload ảnh (chưa publish)': items([{ id: 'cu-tu-lan-truoc' }]) });
  assert.equal(r.upload_ok, true);
  assert.deepEqual(r.payload, { message: EN });
});

const stuck = (rows) => runNode('Tìm bài kẹt POSTING', { input: items(rows), nodes: { Config: cfg() } });

test('POSTING quá 15 phút => ERROR, không tự đăng lại', () => {
  const [r] = stuck([{ row_number: 4, status: 'POSTING', last_action_at: '2000-01-01 08:00:00' }]);
  assert.equal(r.row_number, 4);
  assert.equal(r.status, 'ERROR');
  assert.equal(r.publish_now, false);
  assert.match(r.check_note, /kiểm tra Page/);
});

test('POSTING vừa xong / giờ lạ / trạng thái khác => để yên', () => {
  assert.equal(stuck([{ status: 'POSTING', last_action_at: '2999-01-01 08:00:00' }]).length, 0);
  assert.equal(stuck([{ status: 'POSTING', last_action_at: '' }]).length, 0);
  assert.equal(stuck([{ status: 'ERROR', last_action_at: '2000-01-01 08:00:00' }]).length, 0);
});

/* ------------------------------------- khớp cột giữa n8n và Apps Script */

test('mọi cột n8n ghi vào Posts đều có trong POSTS_HEADERS của Apps Script', () => {
  const gs = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), gs);
  const headers = new Set([...gs.POSTS_HEADERS, 'row_number']); // row_number: cột ảo để update
  const written = [
    ...dedupe([{ source_post_id: 'k', source_text: 'x', source_images: [] }]),
    ...applyT([gem('Hello')]),
    ...applyT([{ error: { message: '400' } }]),
    ...stuck([{ status: 'POSTING', last_action_at: '2000-01-01 00:00:00' }]),
    ...runNode('Soạn ghi chú lỗi', { input: [{ json: { row_number: 2, errors: ['x'], images_count: 0 } }] }),
    ...runNode('Soạn trạng thái POSTING', { input: [{ json: { row_number: 2, images_count: 0, reason: 'x' } }] }),
    ...runNode('Soạn trạng thái POSTED', { input: [{ json: {} }], nodes: { 'Kiểm tra bài': [{ json: CHECKED }], 'FB: Tạo bài trên Page': [{ json: { id: '1_2' } }] } }),
    ...runNode('Soạn lỗi Facebook', { input: [{ json: { error: { message: 'x' } } }], nodes: { 'Kiểm tra bài': [{ json: CHECKED }] } }),
  ];
  const unknown = [...new Set(written.flatMap((r) => Object.keys(r)))].filter((k) => !headers.has(k));
  assert.deepEqual(unknown, [], 'n8n ghi cột không có trong sheet: ' + unknown.join(', '));
  assert.equal(gs.SOURCES_HEADERS.includes('page_url'), true);
});

test('prompt mặc định giống nhau ở n8n và Sheet, có yêu cầu hashtag', () => {
  const gs = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), gs);
  const [fallback] = runNode('Lấy prompt', { input: items([{}]) });
  assert.equal(fallback.prompt, gs.DEFAULT_PROMPT);
  assert.match(gs.DEFAULT_PROMPT, /3–5 hashtag tiếng Anh/);
  assert.equal(gs.DEFAULT_PROMPT.split('{{NOI_DUNG}}').length, 2);
});

test('menu ① nâng cấp prompt cũ chưa sửa, giữ nguyên prompt bạn đã sửa', () => {
  const gs = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), gs);
  const setup = (a2) => {
    const values = { 1: 'tiêu đề', 2: a2 };
    const cellAt = (row) => {
      const cell = {
        getValue: () => values[row],
        setValue(v) { values[row] = v; return cell; },
        isBlank: () => !values[row],
        setFontWeight: () => cell, setBackground: () => cell, setFontColor: () => cell,
        setWrap: () => cell, setVerticalAlignment: () => cell,
      };
      return cell;
    };
    const sh = { getRange: (row) => cellAt(row), setColumnWidth() {}, setFrozenRows() {} };
    gs.setupPromptSheet_({ getSheetByName: () => sh, insertSheet: () => sh });
    return values[2];
  };
  assert.equal(setup(''), gs.DEFAULT_PROMPT);
  assert.equal(setup(gs.OLD_DEFAULT_PROMPTS[0]), gs.DEFAULT_PROMPT);
  assert.equal(setup('Prompt riêng của tôi {{NOI_DUNG}}'), 'Prompt riêng của tôi {{NOI_DUNG}}');
});

/* ------------------------------------------------------------------- runner */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✖ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} test đạt.`);
process.exit(failed ? 1 : 0);

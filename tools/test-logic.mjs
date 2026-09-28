#!/usr/bin/env node
/**
 * Chạy thật JavaScript bên trong các node Code của workflow 02 với dữ liệu giả,
 * để chắc chắn phần "kiểm tra đủ thành phần" xử lý đúng các tình huống.
 *
 *   node tools/test-logic.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', '02-check-and-publish.json'), 'utf8'));

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
 * nodes: { 'Tên node': [ {json}, ... ] }  — dữ liệu output của các node trước.
 */
function runNode(nodeName, { input = [], nodes = {} } = {}) {
  const wrap = (items) => ({
    all: () => items,
    first: () => items[0],
    get item() {
      if (!items.length) throw new Error('pairedItem không xác định');
      return items[0];
    },
  });

  const sandbox = {
    $input: wrap(input),
    $json: input.length ? input[0].json : {},
    $: (name) => {
      if (!(name in nodes)) throw new Error(`No node named "${name}"`);
      return wrap(nodes[name]);
    },
    Intl,
    Buffer,
    console: { log() {} },
  };

  const script = new vm.Script(`(function () {\n${codeOf(nodeName)}\n})()`);
  return script.runInNewContext(sandbox, { timeout: 5000 });
}

const CONFIG = {
  sheet_id: 'sheet-1',
  page_id: '999',
  webhook_secret: 's3cret',
  graph_version: 'v21.0',
  timezone: 'Asia/Ho_Chi_Minh',
  min_images: 1,
  max_images: 10,
  max_image_mb: 8,
  min_content_chars: 50,
};

const META = {
  action: 'publish',
  post_id: 'AP-0001',
  row_number: 7,
  status_before: 'NEED_CONTENT',
  title: 'Bài thử',
  drive_folder_url: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz123456',
  folder_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz123456',
  timezone: CONFIG.timezone,
  ok: true,
  errors: [],
};

const img = (name, size = 500000) => ({ id: `img-${name}`, name, mimeType: 'image/jpeg', size: String(size) });
const GDOC = { id: 'doc-1', name: 'content', mimeType: 'application/vnd.google-apps.document' };
const MD = { id: 'md-1', name: 'content.md', mimeType: 'text/markdown', size: '2000' };

const validate = (files, cfgOverride = {}) =>
  runNode('Kiểm tra đủ thành phần', {
    input: [{ json: files === null ? { error: { message: 'File not found' } } : { files } }],
    nodes: { Config: [{ json: { ...CONFIG, ...cfgOverride } }], 'Tìm dòng bài viết': [{ json: META }] },
  })[0].json;

/* ------------------------------------------------------------------- tests */

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('đủ nội dung + ảnh => ok', () => {
  const r = validate([MD, img('02-b.jpg'), img('01-a.jpg')]);
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.errors), []);
  assert.equal(r.images_count, 2);
  // ảnh phải được sắp theo tên file
  assert.deepEqual(plain(r.images).map((i) => i.name), ['01-a.jpg', '02-b.jpg']);
  assert.match(r.content_download_url, /files\/md-1\?alt=media/);
});

test('sắp ảnh hiểu số: 2.jpg trước 10.jpg', () => {
  const r = validate([MD, img('10.jpg'), img('2.jpg'), img('1.jpg')]);
  assert.deepEqual(plain(r.images).map((i) => i.name), ['1.jpg', '2.jpg', '10.jpg']);
});

test('Google Docs => dùng URL export text/plain', () => {
  const r = validate([GDOC, img('a.png')]);
  assert.equal(r.ok, true);
  assert.match(r.content_download_url, /files\/doc-1\/export\?mimeType=text%2Fplain/);
});

test('thiếu file nội dung => lỗi', () => {
  const r = validate([img('a.jpg')]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Thiếu file nội dung')), r.errors.join('|'));
});

test('không có ảnh => lỗi', () => {
  const r = validate([MD]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Thiếu ảnh')), r.errors.join('|'));
});

test('min_images = 0 cho phép bài không ảnh', () => {
  const r = validate([MD], { min_images: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.images_count, 0);
});

test('quá 10 ảnh => lỗi', () => {
  const files = [MD, ...Array.from({ length: 11 }, (_, i) => img(`${i}.jpg`))];
  const r = validate(files);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Quá nhiều ảnh')), r.errors.join('|'));
});

test('ảnh quá dung lượng => lỗi có tên file', () => {
  const r = validate([MD, img('to-bu.jpg', 9 * 1024 * 1024)]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('to-bu.jpg')), r.errors.join('|'));
});

test('bỏ qua file lạ (pdf, docx, heic)', () => {
  const r = validate([
    MD,
    img('a.jpg'),
    { id: 'x', name: 'goc.pdf', mimeType: 'application/pdf', size: '1000' },
    { id: 'y', name: 'anh.heic', mimeType: 'image/heic', size: '1000' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.images_count, 1, 'heic không được tính là ảnh hợp lệ');
});

test('folder rỗng => lỗi có gợi ý quyền', () => {
  const r = validate([]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('rỗng')), r.errors.join('|'));
});

test('Drive trả lỗi => báo lỗi quyền', () => {
  const r = validate(null);
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('Không đọc được folder Drive'), r.errors.join('|'));
});

test('nhiều file nội dung => cảnh báo, vẫn chạy', () => {
  const r = validate([MD, { id: 'md-2', name: 'zz.txt', mimeType: 'text/plain', size: '10' }, img('a.jpg')]);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.content_file.id, 'md-1');
});

/* --- Tìm dòng bài viết ---------------------------------------------------- */

const findRow = (body, rows) =>
  runNode('Tìm dòng bài viết', {
    input: rows.map((json) => ({ json })),
    nodes: { Config: [{ json: CONFIG }], 'Webhook: Đăng bài': [{ json: { body } }] },
  })[0].json;

const ROW = {
  row_number: 5,
  post_id: 'AP-0002',
  status: 'NEED_CONTENT',
  title: 'T',
  drive_folder_url: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz123456',
};

test('tìm theo post_id và bóc được folder id', () => {
  const r = findRow({ post_id: 'AP-0002', action: 'publish' }, [{ ...ROW, post_id: 'AP-0001' }, ROW]);
  assert.equal(r.ok, true);
  assert.equal(r.row_number, 5);
  assert.equal(r.folder_id, '1AbCdEfGhIjKlMnOpQrStUvWxYz123456');
  assert.equal(r.action, 'publish');
});

test('row_number suy ra từ vị trí khi sheet không trả về', () => {
  const rows = [{ post_id: 'AP-0001' }, { ...ROW, row_number: undefined }];
  const r = findRow({ post_id: 'AP-0002' }, rows);
  assert.equal(r.row_number, 3, 'dòng thứ 2 của dữ liệu = dòng 3 của sheet');
});

test('bài đã POSTED thì chặn', () => {
  const r = findRow({ post_id: 'AP-0002' }, [{ ...ROW, status: 'POSTED', posted_at: '2026-01-01 10:00' }]);
  assert.equal(r.ok, false);
  assert.equal(r.http_code, 409);
  assert.equal(r.status_write, 'POSTED');
});

test('force = true thì vẫn cho đăng lại', () => {
  const r = findRow({ post_id: 'AP-0002', force: true }, [{ ...ROW, status: 'POSTED' }]);
  assert.equal(r.ok, true);
  assert.equal(r.force, true);
});

test('đang POSTING thì chặn', () => {
  const r = findRow({ post_id: 'AP-0002' }, [{ ...ROW, status: 'POSTING' }]);
  assert.equal(r.ok, false);
  assert.equal(r.http_code, 409);
});

test('SKIP thì chặn', () => {
  const r = findRow({ post_id: 'AP-0002' }, [{ ...ROW, status: 'SKIP' }]);
  assert.equal(r.ok, false);
});

test('thiếu link folder => NEED_CONTENT', () => {
  const r = findRow({ post_id: 'AP-0002' }, [{ ...ROW, drive_folder_url: '' }]);
  assert.equal(r.ok, false);
  assert.equal(r.http_code, 400);
  assert.equal(r.status_write, 'NEED_CONTENT');
});

test('action lạ được coi là publish, "check" giữ nguyên', () => {
  assert.equal(findRow({ post_id: 'AP-0002', action: 'CHECK' }, [ROW]).action, 'check');
  assert.equal(findRow({ post_id: 'AP-0002', action: 'gì đó' }, [ROW]).action, 'publish');
});

test('không thấy bài => throw', () => {
  assert.throws(() => findRow({ post_id: 'AP-9999' }, [ROW]), /Không tìm thấy bài/);
});

/* --- Chuẩn hoá nội dung --------------------------------------------------- */

const parse = (text, cfgOverride = {}) =>
  runNode('Chuẩn hoá nội dung', {
    input: [{ json: { content_text: text } }],
    nodes: {
      Config: [{ json: { ...CONFIG, ...cfgOverride } }],
      'Kiểm tra đủ thành phần': [{ json: { ...META, images_count: 1, warnings: [] } }],
    },
  })[0].json;

const LONG = 'A'.repeat(60);

test('bỏ BOM, gộp dòng trống, giữ emoji và hashtag', () => {
  const r = parse(`﻿Hello 🌏 world #tag\n\n\n\n${LONG}\n`);
  assert.equal(r.ok, true);
  assert.equal(r.message, `Hello 🌏 world #tag\n\n${LONG}`);
  assert.equal(r.content_chars, r.message.length);
});

test('bỏ dấu # của tiêu đề markdown nhưng giữ chữ', () => {
  const r = parse(`# Tiêu đề bài\n\n${LONG}`);
  assert.equal(r.message.startsWith('Tiêu đề bài\n\n'), true, r.message);
});

test('nội dung rỗng => lỗi', () => {
  const r = parse('   \n  ');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('rỗng')));
});

test('nội dung quá ngắn => lỗi', () => {
  const r = parse('Hi');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('quá ngắn')));
});

test('nội dung quá dài => lỗi', () => {
  const r = parse('A'.repeat(60001));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('quá dài')));
});

/* --- Soạn payload bài đăng ------------------------------------------------ */

const buildPayload = (imagesCount, uploaded) =>
  runNode('Soạn payload bài đăng', {
    input: uploaded.map((id) => ({ json: { id } })),
    nodes: {
      Config: [{ json: CONFIG }],
      'Chuẩn hoá nội dung': [{ json: { ...META, message: 'Nội dung tiếng Anh', images_count: imagesCount } }],
      'FB: Upload ảnh (chưa publish)': uploaded.map((id) => ({ json: { id } })),
    },
  })[0].json;

test('payload gắn đúng media_fbid theo thứ tự', () => {
  const r = buildPayload(2, ['111', '222']);
  assert.equal(r.upload_ok, true);
  assert.deepEqual(plain(r.payload), {
    message: 'Nội dung tiếng Anh',
    attached_media: [{ media_fbid: '111' }, { media_fbid: '222' }],
  });
});

test('upload thiếu ảnh => upload_ok = false, không đăng', () => {
  const r = buildPayload(3, ['111']);
  assert.equal(r.upload_ok, false);
  assert.ok(r.error.message.includes('1/3'), r.error.message);
});

test('bài không ảnh => payload chỉ có message', () => {
  const r = runNode('Soạn payload bài đăng', {
    input: [{ json: {} }],
    nodes: {
      Config: [{ json: CONFIG }],
      'Chuẩn hoá nội dung': [{ json: { ...META, message: 'Chỉ chữ', images_count: 0 } }],
    },
  })[0].json;
  assert.equal(r.upload_ok, true);
  assert.deepEqual(plain(r.payload), { message: 'Chỉ chữ' });
});

/* --- Chọn bài đến hạn (workflow 03) -------------------------------------- */

const wf3 = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', '03-publish-queue.json'), 'utf8'));
const dueCode = wf3.nodes.find((n) => n.name === 'Chọn bài đến hạn').parameters.jsCode;

function runDue(rows, cfg = {}) {
  const config = { sheet_id: 's', publish_url: 'https://n8n/webhook/autopost-publish', webhook_secret: 's3cret', timezone: 'Asia/Ho_Chi_Minh', max_per_run: 3, ...cfg };
  const wrap = (items) => ({ all: () => items, first: () => items[0], get item() { return items[0]; } });
  const sandbox = {
    $input: wrap(rows.map((json) => ({ json }))),
    $json: {},
    $: (name) => (name === 'Config' ? wrap([{ json: config }]) : (() => { throw new Error(name); })()),
    Intl,
    console: { log() {} },
  };
  return new vm.Script(`(function(){\n${dueCode}\n})()`).runInNewContext(sandbox).map((i) => i.json);
}

test('tick publish_now => được chọn', () => {
  const r = runDue([{ post_id: 'AP-1', status: 'READY', publish_now: true }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].post_id, 'AP-1');
  assert.equal(r[0].secret, 's3cret');
});

test('checkbox dạng chữ "TRUE"/"x" cũng hiểu', () => {
  assert.equal(runDue([{ post_id: 'AP-1', status: 'READY', publish_now: 'TRUE' }]).length, 1);
  assert.equal(runDue([{ post_id: 'AP-2', status: 'READY', publish_now: 'x' }]).length, 1);
  assert.equal(runDue([{ post_id: 'AP-3', status: 'READY', publish_now: 'FALSE' }]).length, 0);
});

test('bỏ qua POSTED / POSTING / SKIP dù có tick', () => {
  for (const status of ['POSTED', 'POSTING', 'SKIP']) {
    assert.equal(runDue([{ post_id: 'AP-1', status, publish_now: true }]).length, 0, status);
  }
});

test('hẹn giờ quá khứ => chọn, tương lai => chưa', () => {
  assert.equal(runDue([{ post_id: 'AP-1', status: 'READY', scheduled_at: '2000-01-01 08:00' }]).length, 1);
  assert.equal(runDue([{ post_id: 'AP-2', status: 'READY', scheduled_at: '2999-01-01 08:00' }]).length, 0);
});

test('chấp nhận cả dạng ISO có chữ T', () => {
  assert.equal(runDue([{ post_id: 'AP-1', status: 'READY', scheduled_at: '2000-01-01T08:00:00' }]).length, 1);
});

test('giới hạn max_per_run', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ post_id: `AP-${i}`, status: 'READY', publish_now: true }));
  assert.equal(runDue(rows).length, 3);
  assert.equal(runDue(rows, { max_per_run: 5 }).length, 5);
});

test('dòng trống / thiếu post_id bị bỏ qua', () => {
  assert.equal(runDue([{}, { post_id: '', publish_now: true }]).length, 0);
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

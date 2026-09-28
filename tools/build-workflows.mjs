#!/usr/bin/env node
/**
 * Sinh các file JSON workflow cho n8n (import được trực tiếp vào n8n).
 *
 *   node tools/build-workflows.mjs
 *
 * Vì các node Code của n8n chứa nhiều JavaScript, viết JSON bằng tay rất dễ sai
 * escape. File này là "nguồn sự thật": sửa ở đây rồi build lại.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'n8n', 'workflows');

/* ------------------------------------------------------------------ helpers */

const GRAPH_VERSION = 'v21.0';

function workflow(name) {
  return { __cursor: 0, name, nodes: [], connections: {}, settings: { executionOrder: 'v1' }, pinData: {} };
}

/**
 * Thêm node vào workflow. `col`/`row` chỉ dùng để trải node trên canvas.
 */
function node(wf, def) {
  const { name, type, typeVersion, parameters = {}, col, row = 0, ...rest } = def;
  wf.nodes.push({
    parameters,
    id: idFor(wf.name, name),
    name,
    type,
    typeVersion,
    position: [260 + (col ?? wf.__cursor++) * 240, 300 + row * 190],
    ...rest,
  });
  return name;
}

/** id ổn định (không random) để build lại không tạo diff vô nghĩa. */
function idFor(wfName, nodeName) {
  const src = `${wfName}::${nodeName}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < src.length; i += 1) {
    h1 = (h1 ^ src.charCodeAt(i)) * 16777619 >>> 0;
    h2 = (h2 + src.charCodeAt(i) * (i + 7)) >>> 0;
  }
  const hex = (h1.toString(16) + h2.toString(16) + h1.toString(16) + h2.toString(16)).padEnd(32, '0').slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

function connect(wf, from, to, { fromOutput = 0, toInput = 0 } = {}) {
  const entry = (wf.connections[from] ??= { main: [] });
  while (entry.main.length <= fromOutput) entry.main.push([]);
  entry.main[fromOutput].push({ node: to, type: 'main', index: toInput });
}

/** Nối chuỗi node theo thứ tự: chain(wf, a, b, c) => a→b→c */
function chain(wf, ...names) {
  for (let i = 0; i < names.length - 1; i += 1) connect(wf, names[i], names[i + 1]);
  return names[names.length - 1];
}

const sheetsDoc = () => ({ __rl: true, value: "={{ $('Config').first().json.sheet_id }}", mode: 'id' });
const sheetsTab = (tab) => ({ __rl: true, value: tab, mode: 'name' });

const CRED_SHEETS = 'Cần chọn credential: Google Sheets OAuth2 (hoặc Service Account).';
const CRED_DRIVE = 'Cần chọn credential: Google Drive OAuth2 (Predefined Credential Type).';
const CRED_FB = 'Cần chọn credential: Facebook Graph API — dán PAGE ACCESS TOKEN dài hạn.';

function sheetsRead(wf, name, tab, opts = {}) {
  return node(wf, {
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    notes: CRED_SHEETS,
    alwaysOutputData: true,
    parameters: { documentId: sheetsDoc(), sheetName: sheetsTab(tab), options: {} },
    ...opts,
  });
}

function sheetsWrite(wf, name, tab, operation, matchingColumns, opts = {}) {
  return node(wf, {
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    notes: CRED_SHEETS,
    parameters: {
      operation,
      documentId: sheetsDoc(),
      sheetName: sheetsTab(tab),
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns, schema: [] },
      options: {},
    },
    ...opts,
  });
}

function code(wf, name, jsCode, opts = {}) {
  const { mode, ...rest } = opts;
  return node(wf, {
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: mode ? { mode, jsCode } : { jsCode },
    ...rest,
  });
}

function ifNode(wf, name, conditions, opts = {}) {
  return node(wf, {
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: conditions.map((c, i) => ({ id: `c${i}`, ...c })),
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    },
    ...opts,
  });
}

const eq = (left, right) => ({ leftValue: left, rightValue: right, operator: { type: 'string', operation: 'equals' } });
const gt = (left, right) => ({ leftValue: left, rightValue: right, operator: { type: 'number', operation: 'gt' } });
const isTrue = (left) => ({ leftValue: left, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } });

function respond(wf, name, body, code_ = 200, opts = {}) {
  return node(wf, {
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    parameters: { respondWith: 'json', responseBody: body, options: { responseCode: code_ } },
    ...opts,
  });
}

function http(wf, name, parameters, opts = {}) {
  return node(wf, { name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters, ...opts });
}

function driveAuth() {
  return { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api' };
}

function fbAuth() {
  return { authentication: 'predefinedCredentialType', nodeCredentialType: 'facebookGraphApi' };
}

/** Đoạn JS dùng lại trong nhiều node Code. */
const SHARED_JS = `
const TRUTHY = ['true', 'yes', 'y', 'x', '1', 'co', 'có', 'on', 'checked'];
const isTruthy = (v) => TRUTHY.includes(String(v ?? '').trim().toLowerCase());
const nowIso = (tz) => {
  const d = new Date();
  try {
    const p = new Intl.DateTimeFormat('sv-SE', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
    const g = (t) => p.find((x) => x.type === t).value;
    return g('year') + '-' + g('month') + '-' + g('day') + ' ' + g('hour') + ':' + g('minute') + ':' + g('second');
  } catch (e) {
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
};
const rowNumberOf = (row, index) => Number(row.row_number ?? row.rowNumber ?? index + 2);
`.trim();

/* ------------------------------------------------- workflow 01: thu bài viết */

function buildCollect() {
  const wf = workflow('AutoPost 01 - Thu bai tu page nguon');

  const schedule = node(wf, {
    name: 'Mỗi 2 giờ',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    col: 0,
    row: -1,
    parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 2 }] } },
  });

  const manual = node(wf, {
    name: 'Chạy thử thủ công',
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    col: 0,
    row: 0,
    parameters: {},
  });

  const hook = node(wf, {
    name: 'Webhook: Thu bài',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    col: 0,
    row: 1,
    webhookId: idFor(wf.name, 'webhook-collect'),
    parameters: { httpMethod: 'POST', path: 'autopost-collect', responseMode: 'onReceived', responseData: 'noData', options: {} },
  });

  const config = node(wf, {
    name: 'Config',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    col: 1,
    notes: 'SỬA Ở ĐÂY: sheet_id + múi giờ',
    notesInFlow: true,
    parameters: {
      assignments: {
        assignments: [
          { id: 'a1', name: 'sheet_id', value: 'DAN_GOOGLE_SHEET_ID_VAO_DAY', type: 'string' },
          { id: 'a2', name: 'graph_version', value: GRAPH_VERSION, type: 'string' },
          { id: 'a3', name: 'timezone', value: 'Asia/Ho_Chi_Minh', type: 'string' },
          { id: 'a4', name: 'default_max_posts', value: 5, type: 'number' },
          { id: 'a5', name: 'post_id_prefix', value: 'AP', type: 'string' },
        ],
      },
      options: {},
    },
  });

  const readPosts = sheetsRead(wf, 'Sheets: Đọc Posts', 'Posts', { col: 2 });

  // Gom về ĐÚNG 1 item: node Google Sheets chạy một lần cho mỗi item đầu vào,
  // nếu để nguyên 500 dòng Posts thì node đọc Sources sẽ bị gọi 500 lần.
  const summarizePosts = code(wf, 'Gom bài đã có', `
${SHARED_JS}
const cfg = $('Config').first().json;
const rows = $input.all().map((i) => i.json).filter((r) => r && Object.keys(r).length);
const keys = [];
let maxNum = 0;
for (const r of rows) {
  for (const k of ['source_post_id', 'source_post_url']) {
    const v = String(r[k] ?? '').trim();
    if (v) keys.push(v);
  }
  const m = String(r.post_id ?? '').trim().match(/(\\d+)\\s*$/);
  if (m) maxNum = Math.max(maxNum, Number(m[1]));
}
return [{ json: { ...cfg, existing_keys: keys, max_post_number: maxNum, existing_rows: rows.length } }];
`, { col: 3 });

  const readSources = sheetsRead(wf, 'Sheets: Đọc Sources', 'Sources', { col: 4 });

  const filterSources = code(wf, 'Lọc nguồn đang bật', `
${SHARED_JS}
const cfg = $('Config').first().json;
const out = [];
$input.all().forEach((item, index) => {
  const r = item.json || {};
  if (!isTruthy(r.active)) return;
  const ref = String(r.page_id_or_url ?? '').trim();
  const mode = String(r.mode ?? 'graph').trim().toLowerCase() || 'graph';
  const feedUrl = String(r.feed_url ?? '').trim();
  if (mode === 'rss' && !feedUrl) return;
  if (mode !== 'rss' && !ref) return;
  // Chấp nhận dán cả URL page: lấy phần cuối làm id/username.
  let pageRef = ref;
  const m = ref.match(/facebook\\.com\\/(?:profile\\.php\\?id=)?([^/?#]+)/i);
  if (m) pageRef = m[1];
  pageRef = pageRef.replace(/^@/, '');
  const max = Number(r.max_posts) > 0 ? Number(r.max_posts) : Number(cfg.default_max_posts) || 5;
  out.push({
    json: {
      row_number: rowNumberOf(r, index),
      source_name: String(r.source_name ?? pageRef).trim() || pageRef,
      page_ref: pageRef,
      mode,
      feed_url: feedUrl,
      max_posts: Math.min(max, 25),
    },
  });
});
if (!out.length) throw new Error('Sheet "Sources" chưa có nguồn nào bật active = TRUE');
return out;
`, { col: 5 });

  const isRss = ifNode(wf, 'Nguồn là RSS?', [eq('={{ $json.mode }}', 'rss')], { col: 6 });

  const rss = node(wf, {
    name: 'Đọc RSS',
    type: 'n8n-nodes-base.rssFeedRead',
    typeVersion: 1.1,
    col: 7,
    row: -1,
    onError: 'continueRegularOutput',
    parameters: { url: '={{ $json.feed_url }}', options: {} },
  });

  const graph = http(wf, 'Graph: Lấy bài của page', {
    url: "=https://graph.facebook.com/{{ $('Config').first().json.graph_version }}/{{ $json.page_ref }}/posts",
    ...fbAuth(),
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'fields', value: 'id,message,story,created_time,permalink_url,full_picture,attachments{media_type,url}' },
        { name: 'limit', value: '={{ $json.max_posts }}' },
      ],
    },
    options: {},
  }, { col: 7, row: 1, notes: CRED_FB, onError: 'continueRegularOutput' });

  const normRss = code(wf, 'Chuẩn hoá bài RSS', `
${SHARED_JS}
// Ưu tiên item pairing; nếu node RSS không truyền pairedItem thì suy ra nguồn rss.
let src;
try {
  src = $('Lọc nguồn đang bật').item.json;
} catch (e) {
  src = null;
}
if (!src || src.mode !== 'rss') {
  const rssSources = $('Lọc nguồn đang bật').all().map((i) => i.json).filter((x) => x.mode === 'rss');
  src = rssSources.length === 1 ? rssSources[0] : { source_name: src ? src.source_name : 'RSS' };
}
const r = $json;
const link = String(r.link ?? r.guid ?? '').trim();
if (!link) return { json: { __skip: true } };
return {
  json: {
    source_page: src.source_name,
    source_post_url: link,
    source_post_id: link,
    title: String(r.title ?? '').trim().slice(0, 300),
    summary: String(r.contentSnippet ?? r.content ?? '').replace(/\\s+/g, ' ').trim().slice(0, 500),
    created_time: r.isoDate || r.pubDate || '',
  },
};
`, { col: 8, row: -1, mode: 'runOnceForEachItem' });

  const normGraph = code(wf, 'Chuẩn hoá bài Graph', `
${SHARED_JS}
// Node Graph chỉ nhận nhánh false của IF, nên phải lọc lại đúng danh sách đó
// để index khớp (nếu lấy cả nguồn rss sẽ gán sai tên page).
const sources = $('Lọc nguồn đang bật').all().map((i) => i.json).filter((s) => s.mode !== 'rss');
const out = [];
const failures = [];
$input.all().forEach((item, index) => {
  const src = sources[index] || sources[0] || { source_name: '?' };
  const body = item.json || {};
  if (body.error) {
    failures.push(src.source_name + ': ' + (body.error.message || JSON.stringify(body.error)));
    return;
  }
  const posts = Array.isArray(body.data) ? body.data : [];
  for (const p of posts) {
    const text = String(p.message ?? p.story ?? '').replace(/\\s+/g, ' ').trim();
    out.push({
      json: {
        source_page: src.source_name,
        source_post_url: p.permalink_url || ('https://www.facebook.com/' + String(p.id || '').replace('_', '/posts/')),
        source_post_id: String(p.id ?? ''),
        title: text.slice(0, 120),
        summary: text.slice(0, 500),
        created_time: p.created_time || '',
      },
    });
  }
});
// Một nguồn lỗi không nên chặn các nguồn còn lại; chỉ báo lỗi khi không thu được gì.
if (!out.length && failures.length) {
  throw new Error('Graph API lỗi với tất cả nguồn — ' + failures.join(' | '));
}
return out;
`, { col: 8, row: 1 });

  const dedupe = code(wf, 'Bỏ trùng + tạo post_id', `
${SHARED_JS}
const cfg = $('Config').first().json;
const known = $('Gom bài đã có').first().json;
const seen = new Set(known.existing_keys || []);
const prefix = String(cfg.post_id_prefix || 'AP');
let maxNum = Number(known.max_post_number || 0);
const stamp = nowIso(cfg.timezone);
const rows = [];
for (const item of $input.all()) {
  const p = item.json || {};
  if (p.__skip) continue;
  const key = String(p.source_post_id || p.source_post_url || '').trim();
  if (!key || seen.has(key)) continue;
  seen.add(key);
  maxNum += 1;
  rows.push({
    json: {
      post_id: prefix + '-' + String(maxNum).padStart(4, '0'),
      source_page: p.source_page || '',
      source_post_url: p.source_post_url || '',
      source_post_id: p.source_post_id || '',
      collected_at: stamp,
      title: p.title || '',
      summary: p.summary || '',
      drive_folder_url: '',
      status: 'NEED_CONTENT',
      images_count: '',
      content_chars: '',
      check_note: 'Chờ dán link folder Drive (nội dung tiếng Anh + ảnh)',
      scheduled_at: '',
      posted_at: '',
      fb_post_id: '',
      fb_permalink: '',
      publish_now: false,
      last_action_at: stamp,
    },
  });
}
return rows;
`, { col: 9 });

  const append = sheetsWrite(wf, 'Sheets: Thêm bài mới', 'Posts', 'append', [], { col: 10 });

  connect(wf, schedule, config);
  connect(wf, manual, config);
  connect(wf, hook, config);
  chain(wf, config, readPosts, summarizePosts, readSources, filterSources, isRss);
  connect(wf, isRss, rss, { fromOutput: 0 });
  connect(wf, isRss, graph, { fromOutput: 1 });
  chain(wf, rss, normRss, dedupe);
  chain(wf, graph, normGraph, dedupe);
  connect(wf, dedupe, append);

  return wf;
}

/* ----------------------------------------- workflow 02: kiểm tra + đăng bài */

function buildPublish() {
  const wf = workflow('AutoPost 02 - Kiem tra va dang bai');

  const hook = node(wf, {
    name: 'Webhook: Đăng bài',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    col: 0,
    webhookId: idFor(wf.name, 'webhook-publish'),
    parameters: { httpMethod: 'POST', path: 'autopost-publish', responseMode: 'responseNode', options: {} },
  });

  const config = node(wf, {
    name: 'Config',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    col: 1,
    notes: 'SỬA Ở ĐÂY: sheet_id, page_id, webhook_secret, số ảnh min/max',
    notesInFlow: true,
    parameters: {
      assignments: {
        assignments: [
          { id: 'a1', name: 'sheet_id', value: 'DAN_GOOGLE_SHEET_ID_VAO_DAY', type: 'string' },
          { id: 'a2', name: 'page_id', value: 'DAN_FACEBOOK_PAGE_ID_VAO_DAY', type: 'string' },
          { id: 'a3', name: 'webhook_secret', value: 'DOI_THANH_CHUOI_BI_MAT_RIENG', type: 'string' },
          { id: 'a4', name: 'graph_version', value: GRAPH_VERSION, type: 'string' },
          { id: 'a5', name: 'timezone', value: 'Asia/Ho_Chi_Minh', type: 'string' },
          { id: 'a6', name: 'min_images', value: 1, type: 'number' },
          { id: 'a7', name: 'max_images', value: 10, type: 'number' },
          { id: 'a8', name: 'max_image_mb', value: 8, type: 'number' },
          { id: 'a9', name: 'min_content_chars', value: 50, type: 'number' },
        ],
      },
      options: {},
    },
  });

  const auth = ifNode(wf, 'Đúng secret?', [
    eq("={{ $('Webhook: Đăng bài').first().json.body.secret }}", "={{ $('Config').first().json.webhook_secret }}"),
  ], { col: 2 });

  const resp401 = respond(wf, 'Trả 401', '={{ { ok: false, error: "Sai webhook secret" } }}', 401, { col: 3, row: -2 });

  const readPosts = sheetsRead(wf, 'Sheets: Đọc Posts', 'Posts', { col: 3 });

  const findRow = code(wf, 'Tìm dòng bài viết', `
${SHARED_JS}
const cfg = $('Config').first().json;
const body = $('Webhook: Đăng bài').first().json.body || {};
const wantedId = String(body.post_id ?? '').trim();
const wantedRow = Number(body.row_number ?? 0);
const action = String(body.action ?? 'publish').trim().toLowerCase() === 'check' ? 'check' : 'publish';
const force = isTruthy(body.force);

const rows = $input.all().map((i) => i.json).filter((r) => r && Object.keys(r).length);
let found = null;
rows.forEach((r, index) => {
  if (found) return;
  const rn = rowNumberOf(r, index);
  if (wantedId && String(r.post_id ?? '').trim() === wantedId) found = { r, rn };
  else if (!wantedId && wantedRow && rn === wantedRow) found = { r, rn };
});
if (!found) throw new Error('Không tìm thấy bài "' + (wantedId || ('dòng ' + wantedRow)) + '" trong sheet Posts');

const row = found.r;
const status = String(row.status ?? '').trim().toUpperCase();
const folderUrl = String(row.drive_folder_url ?? '').trim();
const folderMatch = folderUrl.match(/[-\\w]{25,}/);

const base = {
  action,
  force,
  post_id: String(row.post_id ?? '').trim(),
  row_number: found.rn,
  status_before: status,
  title: String(row.title ?? '').trim(),
  drive_folder_url: folderUrl,
  folder_id: folderMatch ? folderMatch[0] : '',
  timezone: cfg.timezone,
};

if (status === 'POSTED' && !force) {
  return [{ json: { ...base, ok: false, http_code: 409, status_write: 'POSTED', note: 'Bài đã đăng lúc ' + (row.posted_at || '?') + ' — bỏ qua. Muốn đăng lại thì gửi force = true.' } }];
}
if (status === 'POSTING' && !force) {
  return [{ json: { ...base, ok: false, http_code: 409, status_write: 'POSTING', note: 'Bài đang trong tiến trình đăng, chờ hoàn tất.' } }];
}
if (status === 'SKIP' && !force) {
  return [{ json: { ...base, ok: false, http_code: 409, status_write: 'SKIP', note: 'Bài được đánh dấu SKIP.' } }];
}
if (!base.folder_id) {
  return [{ json: { ...base, ok: false, http_code: 400, status_write: 'NEED_CONTENT', note: 'Thiếu / sai link folder Drive ở cột drive_folder_url.' } }];
}
return [{ json: { ...base, ok: true } }];
`, { col: 4 });

  const guard = ifNode(wf, 'Được phép chạy?', [isTrue('={{ $json.ok }}')], { col: 5 });

  const guardWrite = code(wf, 'Soạn ghi chú từ chối', `
${SHARED_JS}
const d = $json;
return [{ json: {
  row_number: d.row_number,
  post_id: d.post_id,
  status: d.status_write,
  check_note: d.note,
  publish_now: false,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 6, row: -2 });

  const guardSheet = sheetsWrite(wf, 'Sheets: Ghi lý do từ chối', 'Posts', 'update', ['row_number'], { col: 7, row: -2 });
  const respGuard = respond(
    wf,
    'Trả: bỏ qua',
    '={{ { ok: false, post_id: $(\'Soạn ghi chú từ chối\').first().json.post_id, status: $(\'Soạn ghi chú từ chối\').first().json.status, message: $(\'Soạn ghi chú từ chối\').first().json.check_note } }}',
    200,
    { col: 8, row: -2 },
  );

  const listFiles = http(wf, 'Drive: Liệt kê file trong folder', {
    url: 'https://www.googleapis.com/drive/v3/files',
    ...driveAuth(),
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'q', value: "={{ \"'\" + $json.folder_id + \"' in parents and trashed = false\" }}" },
        { name: 'fields', value: 'files(id,name,mimeType,size,webViewLink,modifiedTime)' },
        { name: 'pageSize', value: '200' },
        { name: 'orderBy', value: 'name_natural' },
        { name: 'supportsAllDrives', value: 'true' },
        { name: 'includeItemsFromAllDrives', value: 'true' },
      ],
    },
    options: {},
  }, { col: 6, notes: CRED_DRIVE, alwaysOutputData: true, onError: 'continueRegularOutput' });

  const validate = code(wf, 'Kiểm tra đủ thành phần', `
${SHARED_JS}
const cfg = $('Config').first().json;
const meta = $('Tìm dòng bài viết').first().json;
const body = $input.first() ? $input.first().json : {};

const minImages = Number(cfg.min_images ?? 1);
const maxImages = Math.min(Number(cfg.max_images ?? 10), 10);
const maxBytes = Number(cfg.max_image_mb ?? 8) * 1024 * 1024;

const errors = [];
const warnings = [];

if (body && body.error) {
  errors.push('Không đọc được folder Drive: ' + (body.error.message || JSON.stringify(body.error)) + ' (kiểm tra quyền chia sẻ folder cho credential Google của n8n)');
}
const files = Array.isArray(body.files) ? body.files : [];

const GDOC = 'application/vnd.google-apps.document';
const isImage = (f) => /^image\\/(jpe?g|png|gif|webp)$/i.test(String(f.mimeType || ''));
const isTextContent = (f) => /\\.(txt|md|markdown)$/i.test(String(f.name || '')) || /^text\\//i.test(String(f.mimeType || ''));

const contentFiles = files.filter((f) => f.mimeType === GDOC || isTextContent(f));
const images = files
  .filter(isImage)
  .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { numeric: true, sensitivity: 'base' }));

if (!errors.length && !files.length) {
  errors.push('Folder Drive rỗng (hoặc n8n chưa được chia sẻ quyền xem folder này).');
}
if (!contentFiles.length) {
  errors.push('Thiếu file nội dung: cần 1 file .txt / .md hoặc Google Docs chứa bài đã dịch sang tiếng Anh.');
}
if (images.length < minImages) {
  errors.push('Thiếu ảnh: cần tối thiểu ' + minImages + ' ảnh, hiện có ' + images.length + '.');
}
if (images.length > maxImages) {
  errors.push('Quá nhiều ảnh: Facebook cho tối đa ' + maxImages + ' ảnh/bài, hiện có ' + images.length + '.');
}
const tooBig = images.filter((f) => Number(f.size || 0) > maxBytes);
if (tooBig.length) {
  errors.push('Ảnh vượt ' + cfg.max_image_mb + 'MB: ' + tooBig.map((f) => f.name).join(', '));
}
if (contentFiles.length > 1) {
  warnings.push('Có ' + contentFiles.length + ' file nội dung, dùng file "' + contentFiles[0].name + '".');
}

const content = contentFiles[0] || null;
const downloadUrl = content
  ? (content.mimeType === GDOC
      ? 'https://www.googleapis.com/drive/v3/files/' + content.id + '/export?mimeType=text%2Fplain'
      : 'https://www.googleapis.com/drive/v3/files/' + content.id + '?alt=media&supportsAllDrives=true')
  : '';

return [{ json: {
  ...meta,
  ok: errors.length === 0,
  errors,
  warnings,
  content_file: content ? { id: content.id, name: content.name, mimeType: content.mimeType } : null,
  content_download_url: downloadUrl,
  images: images.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: Number(f.size || 0) })),
  images_count: images.length,
} }];
`, { col: 7 });

  const valid = ifNode(wf, 'Đủ thành phần?', [isTrue('={{ $json.ok }}')], { col: 8 });

  const invalidWrite = code(wf, 'Soạn ghi chú lỗi', `
${SHARED_JS}
const d = $json;
return [{ json: {
  row_number: d.row_number,
  post_id: d.post_id,
  status: 'ERROR',
  images_count: d.images_count,
  check_note: '❌ ' + d.errors.join(' | '),
  publish_now: false,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 9, row: 2 });

  const invalidSheet = sheetsWrite(wf, 'Sheets: Ghi lỗi kiểm tra', 'Posts', 'update', ['row_number'], { col: 10, row: 2 });
  const respInvalid = respond(
    wf,
    'Trả: thiếu thành phần',
    '={{ { ok: false, post_id: $(\'Soạn ghi chú lỗi\').first().json.post_id, status: "ERROR", message: $(\'Soạn ghi chú lỗi\').first().json.check_note } }}',
    422,
    { col: 11, row: 2 },
  );

  const downloadContent = http(wf, 'Drive: Tải file nội dung', {
    url: '={{ $json.content_download_url }}',
    ...driveAuth(),
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, { col: 9, notes: CRED_DRIVE });

  const extract = node(wf, {
    name: 'Đọc text từ file',
    type: 'n8n-nodes-base.extractFromFile',
    typeVersion: 1,
    col: 10,
    parameters: { operation: 'text', binaryPropertyName: 'data', destinationKey: 'content_text', options: {} },
  });

  const parse = code(wf, 'Chuẩn hoá nội dung', `
${SHARED_JS}
const cfg = $('Config').first().json;
const meta = $('Kiểm tra đủ thành phần').first().json;
let text = String($json.content_text ?? '');

text = text.replace(/^\\uFEFF/, '').replace(/\\r\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
// Bỏ dòng tiêu đề markdown ở đầu nếu nó trùng tiêu đề trong sheet.
const lines = text.split('\\n');
if (lines.length > 1 && /^#{1,3}\\s+/.test(lines[0])) {
  const h = lines[0].replace(/^#{1,3}\\s+/, '').trim();
  text = (h ? h + '\\n\\n' : '') + lines.slice(1).join('\\n').trim();
}

const minChars = Number(cfg.min_content_chars ?? 50);
const errors = [];
if (!text) errors.push('File nội dung rỗng.');
else if (text.length < minChars) errors.push('Nội dung quá ngắn (' + text.length + ' ký tự, cần ≥ ' + minChars + ').');
if (text.length > 60000) errors.push('Nội dung quá dài (' + text.length + ' ký tự, Facebook giới hạn ~63.206).');

return [{ json: {
  ...meta,
  ok: errors.length === 0,
  errors: [...meta.errors, ...errors],
  message: text,
  content_chars: text.length,
} }];
`, { col: 11 });

  const contentOk = ifNode(wf, 'Nội dung hợp lệ?', [isTrue('={{ $json.ok }}')], { col: 12 });

  const isPublish = ifNode(wf, 'Hành động = đăng?', [eq('={{ $json.action }}', 'publish')], { col: 13 });

  const readyWrite = code(wf, 'Soạn ghi chú READY', `
${SHARED_JS}
const d = $json;
const warn = d.warnings && d.warnings.length ? ' ⚠️ ' + d.warnings.join(' | ') : '';
return [{ json: {
  row_number: d.row_number,
  post_id: d.post_id,
  status: 'READY',
  images_count: d.images_count,
  content_chars: d.content_chars,
  check_note: '✅ Đủ thành phần: ' + d.content_chars + ' ký tự nội dung + ' + d.images_count + ' ảnh.' + warn,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 14, row: -2 });

  const readySheet = sheetsWrite(wf, 'Sheets: Ghi READY', 'Posts', 'update', ['row_number'], { col: 15, row: -2 });
  const respReady = respond(
    wf,
    'Trả: đủ điều kiện',
    '={{ { ok: true, action: "check", post_id: $(\'Soạn ghi chú READY\').first().json.post_id, status: "READY", images: $(\'Soạn ghi chú READY\').first().json.images_count, content_chars: $(\'Soạn ghi chú READY\').first().json.content_chars, message: $(\'Soạn ghi chú READY\').first().json.check_note } }}',
    200,
    { col: 16, row: -2 },
  );

  const postingWrite = code(wf, 'Soạn trạng thái POSTING', `
${SHARED_JS}
const d = $('Chuẩn hoá nội dung').first().json;
return [{ json: {
  row_number: d.row_number,
  post_id: d.post_id,
  status: 'POSTING',
  images_count: d.images_count,
  content_chars: d.content_chars,
  check_note: '⏳ Đang đăng lên Facebook...',
  publish_now: false,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 14 });

  const postingSheet = sheetsWrite(wf, 'Sheets: Ghi POSTING', 'Posts', 'update', ['row_number'], { col: 15 });

  const hasImages = ifNode(wf, 'Có ảnh?', [gt("={{ $('Chuẩn hoá nội dung').first().json.images_count }}", 0)], { col: 16 });

  const splitImages = code(wf, 'Tách từng ảnh', `
const d = $('Chuẩn hoá nội dung').first().json;
return d.images.map((img, i) => ({ json: { ...img, order: i + 1 } }));
`, { col: 17 });

  const downloadImage = http(wf, 'Drive: Tải ảnh', {
    url: '=https://www.googleapis.com/drive/v3/files/{{ $json.id }}?alt=media&supportsAllDrives=true',
    ...driveAuth(),
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, { col: 18, notes: CRED_DRIVE });

  const uploadPhoto = http(wf, 'FB: Upload ảnh (chưa publish)', {
    method: 'POST',
    url: "=https://graph.facebook.com/{{ $('Config').first().json.graph_version }}/{{ $('Config').first().json.page_id }}/photos",
    ...fbAuth(),
    sendBody: true,
    contentType: 'multipart-form-data',
    bodyParameters: {
      parameters: [
        { name: 'published', value: 'false' },
        { parameterType: 'formBinaryData', name: 'source', inputDataFieldName: 'data' },
      ],
    },
    options: {},
  }, { col: 19, notes: CRED_FB, onError: 'continueErrorOutput' });

  const buildPayload = code(wf, 'Soạn payload bài đăng', `
const cfg = $('Config').first().json;
const d = $('Chuẩn hoá nội dung').first().json;
let media = [];
try {
  media = $('FB: Upload ảnh (chưa publish)').all()
    .map((i) => i.json && i.json.id)
    .filter(Boolean);
} catch (e) {
  media = [];
}
const payload = { message: d.message };
if (media.length) payload.attached_media = media.map((id) => ({ media_fbid: String(id) }));
const enough = media.length === Number(d.images_count);
return [{ json: {
  ...d,
  media_ids: media,
  payload,
  upload_ok: enough,
  error: enough ? undefined : { message: 'Chỉ upload được ' + media.length + '/' + d.images_count + ' ảnh lên Facebook, huỷ đăng để tránh bài thiếu ảnh.' },
} }];
`, { col: 20 });

  const uploadOk = ifNode(wf, 'Upload đủ ảnh?', [isTrue('={{ $json.upload_ok }}')], { col: 20, row: 1 });

  const createPost = http(wf, 'FB: Tạo bài trên Page', {
    method: 'POST',
    url: "=https://graph.facebook.com/{{ $('Config').first().json.graph_version }}/{{ $('Config').first().json.page_id }}/feed",
    ...fbAuth(),
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.payload) }}',
    options: {},
  }, { col: 21, notes: CRED_FB, onError: 'continueErrorOutput' });

  const permalink = http(wf, 'FB: Lấy permalink', {
    url: "=https://graph.facebook.com/{{ $('Config').first().json.graph_version }}/{{ $json.id }}",
    ...fbAuth(),
    sendQuery: true,
    queryParameters: { parameters: [{ name: 'fields', value: 'permalink_url,created_time' }] },
    options: {},
  }, { col: 22, notes: CRED_FB, onError: 'continueRegularOutput' });

  const postedWrite = code(wf, 'Soạn trạng thái POSTED', `
${SHARED_JS}
const d = $('Soạn payload bài đăng').first().json;
const created = $('FB: Tạo bài trên Page').first().json || {};
const info = $json || {};
const fbId = String(created.id || info.id || '');
const permalink = info.permalink_url || (fbId ? 'https://www.facebook.com/' + fbId.replace('_', '/posts/') : '');
return [{ json: {
  row_number: d.row_number,
  post_id: d.post_id,
  status: 'POSTED',
  images_count: d.images_count,
  content_chars: d.content_chars,
  check_note: '✅ Đã đăng ' + d.images_count + ' ảnh + ' + d.content_chars + ' ký tự.',
  posted_at: nowIso(d.timezone),
  fb_post_id: fbId,
  fb_permalink: permalink,
  publish_now: false,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 23 });

  const postedSheet = sheetsWrite(wf, 'Sheets: Ghi POSTED', 'Posts', 'update', ['row_number'], { col: 24 });
  const respPosted = respond(
    wf,
    'Trả: đã đăng',
    '={{ { ok: true, action: "publish", post_id: $(\'Soạn trạng thái POSTED\').first().json.post_id, status: "POSTED", fb_post_id: $(\'Soạn trạng thái POSTED\').first().json.fb_post_id, permalink: $(\'Soạn trạng thái POSTED\').first().json.fb_permalink } }}',
  );
  wf.nodes.find((n) => n.name === respPosted).position = [260 + 25 * 240, 300];

  const fbErrWrite = code(wf, 'Soạn lỗi Facebook', `
${SHARED_JS}
const d = $('Chuẩn hoá nội dung').first().json;
const err = $json || {};
const detail = (err.error && (err.error.message || err.error.error_user_msg))
  || err.message
  || (typeof err === 'string' ? err : JSON.stringify(err).slice(0, 400));
return [{ json: {
  row_number: d.row_number,
  post_id: d.post_id,
  status: 'ERROR',
  images_count: d.images_count,
  content_chars: d.content_chars,
  check_note: '❌ Facebook từ chối: ' + detail,
  publish_now: false,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 21, row: 3 });

  const fbErrSheet = sheetsWrite(wf, 'Sheets: Ghi lỗi Facebook', 'Posts', 'update', ['row_number'], { col: 22, row: 3 });
  const respFbErr = respond(
    wf,
    'Trả: lỗi Facebook',
    '={{ { ok: false, action: "publish", post_id: $(\'Soạn lỗi Facebook\').first().json.post_id, status: "ERROR", message: $(\'Soạn lỗi Facebook\').first().json.check_note } }}',
    502,
    { col: 23, row: 3 },
  );

  connect(wf, hook, config);
  connect(wf, config, auth);
  connect(wf, auth, readPosts, { fromOutput: 0 });
  connect(wf, auth, resp401, { fromOutput: 1 });
  chain(wf, readPosts, findRow, guard);
  connect(wf, guard, listFiles, { fromOutput: 0 });
  connect(wf, guard, guardWrite, { fromOutput: 1 });
  chain(wf, guardWrite, guardSheet, respGuard);
  chain(wf, listFiles, validate, valid);
  connect(wf, valid, downloadContent, { fromOutput: 0 });
  connect(wf, valid, invalidWrite, { fromOutput: 1 });
  chain(wf, invalidWrite, invalidSheet, respInvalid);
  chain(wf, downloadContent, extract, parse, contentOk);
  connect(wf, contentOk, isPublish, { fromOutput: 0 });
  connect(wf, contentOk, invalidWrite, { fromOutput: 1 });
  connect(wf, isPublish, postingWrite, { fromOutput: 0 });
  connect(wf, isPublish, readyWrite, { fromOutput: 1 });
  chain(wf, readyWrite, readySheet, respReady);
  chain(wf, postingWrite, postingSheet, hasImages);
  connect(wf, hasImages, splitImages, { fromOutput: 0 });
  connect(wf, hasImages, buildPayload, { fromOutput: 1 });
  chain(wf, splitImages, downloadImage, uploadPhoto);
  connect(wf, uploadPhoto, buildPayload, { fromOutput: 0 });
  connect(wf, uploadPhoto, fbErrWrite, { fromOutput: 1 });
  chain(wf, buildPayload, uploadOk);
  connect(wf, uploadOk, createPost, { fromOutput: 0 });
  connect(wf, uploadOk, fbErrWrite, { fromOutput: 1 });
  connect(wf, createPost, permalink, { fromOutput: 0 });
  connect(wf, createPost, fbErrWrite, { fromOutput: 1 });
  chain(wf, permalink, postedWrite, postedSheet, respPosted);
  chain(wf, fbErrWrite, fbErrSheet, respFbErr);

  return wf;
}

/* ------------------------- workflow 03: hàng đợi tick ô "Đăng" + đặt lịch */

function buildScheduler() {
  const wf = workflow('AutoPost 03 - Hang doi dang bai');

  const trigger = node(wf, {
    name: 'Mỗi 5 phút',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    col: 0,
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } },
  });

  const config = node(wf, {
    name: 'Config',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    col: 1,
    notes: 'SỬA Ở ĐÂY: sheet_id, publish_url (webhook của workflow 02), webhook_secret',
    notesInFlow: true,
    parameters: {
      assignments: {
        assignments: [
          { id: 'a1', name: 'sheet_id', value: 'DAN_GOOGLE_SHEET_ID_VAO_DAY', type: 'string' },
          { id: 'a2', name: 'publish_url', value: 'https://N8N_CUA_BAN/webhook/autopost-publish', type: 'string' },
          { id: 'a3', name: 'webhook_secret', value: 'DOI_THANH_CHUOI_BI_MAT_RIENG', type: 'string' },
          { id: 'a4', name: 'timezone', value: 'Asia/Ho_Chi_Minh', type: 'string' },
          { id: 'a5', name: 'max_per_run', value: 3, type: 'number' },
        ],
      },
      options: {},
    },
  });

  const readPosts = sheetsRead(wf, 'Sheets: Đọc Posts', 'Posts', { col: 2 });

  const due = code(wf, 'Chọn bài đến hạn', `
${SHARED_JS}
const cfg = $('Config').first().json;
const limit = Number(cfg.max_per_run ?? 3);
const tz = cfg.timezone;
const now = nowIso(tz);

const picked = [];
$input.all().forEach((item, index) => {
  const r = item.json || {};
  if (!Object.keys(r).length) return;
  const postId = String(r.post_id ?? '').trim();
  if (!postId) return;
  const status = String(r.status ?? '').trim().toUpperCase();
  if (['POSTED', 'POSTING', 'SKIP'].includes(status)) return;

  const manual = isTruthy(r.publish_now);
  const scheduledRaw = String(r.scheduled_at ?? '').trim();
  let scheduledDue = false;
  if (scheduledRaw) {
    // Hỗ trợ "2026-01-31 08:30" hoặc ISO; so sánh dạng chuỗi theo cùng múi giờ.
    const norm = scheduledRaw.replace('T', ' ').slice(0, 19);
    scheduledDue = norm <= now;
  }
  if (!manual && !scheduledDue) return;

  picked.push({ json: {
    post_id: postId,
    row_number: rowNumberOf(r, index),
    reason: manual ? 'tick ô publish_now' : 'đến hạn ' + scheduledRaw,
    secret: cfg.webhook_secret,
    action: 'publish',
    publish_url: cfg.publish_url,
  } });
});
return picked.slice(0, limit);
`, { col: 3 });

  const call = http(wf, 'Gọi webhook đăng bài', {
    method: 'POST',
    url: '={{ $json.publish_url }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ post_id: $json.post_id, row_number: $json.row_number, action: "publish", secret: $json.secret }) }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 4000 } }, timeout: 180000 },
  }, { col: 4, onError: 'continueRegularOutput' });

  chain(wf, trigger, config, readPosts, due, call);
  return wf;
}

/* -------------------------------------------------------------------- build */

const files = [
  ['01-collect-source-posts.json', buildCollect()],
  ['02-check-and-publish.json', buildPublish()],
  ['03-publish-queue.json', buildScheduler()],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [file, wf] of files) {
  delete wf.__cursor;
  writeFileSync(join(OUT_DIR, file), `${JSON.stringify(wf, null, 2)}\n`, 'utf8');
  console.log(`✔ ${file} — ${wf.nodes.length} node`);
}

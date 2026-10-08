#!/usr/bin/env node
/**
 * Sinh workflow n8n duy nhất: n8n/workflows/autopost.json (import thẳng vào n8n).
 *
 *   node tools/build-workflows.mjs
 *
 * Một workflow, ba việc chạy theo lịch, dùng chung một node Config:
 *   - Mỗi 4 giờ:  thu bài mới từ các page nguồn (service fb-crawler) → Sheet, NEED_TRANSLATE
 *   - Mỗi 5 phút: dịch bài NEED_TRANSLATE bằng Gemini API → en_text, REVIEW
 *   - Mỗi 2 phút: đăng 1 bài đã tick publish_now / đến giờ scheduled_at; gỡ bài kẹt POSTING
 *
 * Các node Code chứa nhiều JavaScript, viết JSON bằng tay rất dễ sai escape. File
 * này là "nguồn sự thật": sửa ở đây rồi build lại.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'n8n', 'workflows');
// Bản đã điền sheet id / page id / token từ .env — thư mục này nằm trong .gitignore.
const LOCAL_DIR = join(ROOT, 'n8n', 'local');
const OUT_FILE = 'autopost.json';

/**
 * Giá trị riêng KHÔNG được nằm trong file có trong git. n8n/workflows/ luôn giữ
 * placeholder; nếu .env có giá trị thì sinh thêm bản đã điền sẵn ở n8n/local/.
 */
const PLACEHOLDERS = {
  sheet_id: 'DAN_GOOGLE_SHEET_ID_VAO_DAY',
  page_id: 'DAN_FACEBOOK_PAGE_ID_VAO_DAY',
  crawler_token: 'DOI_THANH_CRAWLER_TOKEN',
};

function readEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return {};
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/* ------------------------------------------------------------------ helpers */

const GRAPH_VERSION = 'v21.0';
// Ô Google Sheet chứa tối đa 50.000 ký tự.
const MAX_CELL_CHARS = 45000;

function workflow(name) {
  return { name, nodes: [], connections: {}, settings: { executionOrder: 'v1' }, pinData: {} };
}

/** Thêm node. `col`/`row` chỉ để trải node trên canvas. */
function node(wf, def) {
  const { name, type, typeVersion, parameters = {}, col = 0, row = 0, ...rest } = def;
  if (wf.nodes.some((n) => n.name === name)) throw new Error(`Trùng tên node: ${name}`);
  wf.nodes.push({
    parameters,
    id: idFor(wf.name, name),
    name,
    type,
    typeVersion,
    position: [260 + col * 240, 300 + row * 190],
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

/** chain(wf, a, b, c) => a→b→c */
function chain(wf, ...names) {
  for (let i = 0; i < names.length - 1; i += 1) connect(wf, names[i], names[i + 1]);
  return names[names.length - 1];
}

const sheetsDoc = () => ({ __rl: true, value: "={{ $('Config').first().json.sheet_id }}", mode: 'id' });
const sheetsTab = (tab) => ({ __rl: true, value: tab, mode: 'name' });

const CRED_SHEETS = 'Cần chọn credential: Google Sheets OAuth2.';
const CRED_FB = 'Cần chọn credential: Facebook Graph API — dán PAGE ACCESS TOKEN dài hạn.';
const CRED_GEMINI = 'Cần chọn credential: Header Auth — Name: x-goog-api-key, Value: API key từ aistudio.google.com';

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
      // RAW: Sheets không tự đổi "2026-01-31 08:30" sang ngày theo locale, và không coi
      // nội dung bắt đầu bằng "=" / "+" (vd. số điện thoại) là công thức.
      options: { cellFormat: 'RAW' },
    },
    ...opts,
  });
}

function code(wf, name, jsCode, opts = {}) {
  return node(wf, { name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode }, ...opts });
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

const gt = (left, right) => ({ leftValue: left, rightValue: right, operator: { type: 'number', operation: 'gt' } });
const isTrue = (left) => ({ leftValue: left, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } });

function http(wf, name, parameters, opts = {}) {
  return node(wf, { name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters, ...opts });
}

const fbAuth = () => ({ authentication: 'predefinedCredentialType', nodeCredentialType: 'facebookGraphApi' });
const cfgExpr = (key) => `$('Config').first().json.${key}`;

/** Đoạn JS dùng lại trong nhiều node Code. */
const SHARED_JS = `
const TRUTHY = ['true', 'yes', 'y', 'x', '1', 'co', 'có', 'on', 'checked'];
const isTruthy = (v) => TRUTHY.includes(String(v ?? '').trim().toLowerCase());
const nowIso = (tz, d = new Date()) => {
  try {
    const p = new Intl.DateTimeFormat('sv-SE', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
    const g = (t) => p.find((x) => x.type === t).value;
    return g('year') + '-' + g('month') + '-' + g('day') + ' ' + g('hour') + ':' + g('minute') + ':' + g('second');
  } catch (e) {
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
};
const rowNumberOf = (row, index) => Number(row.row_number ?? row.rowNumber ?? index + 2);
// Đưa ngày giờ đọc từ Sheet về dạng "YYYY-MM-DD HH:mm:ss" để so sánh chuỗi.
// Sheet có thể trả: chuỗi ISO, "31/01/2026 08:30" (locale Việt Nam) hoặc số serial.
// Không hiểu được => '' (người gọi coi như không có giá trị).
const toSortable = (v) => {
  if (v === null || v === undefined || v === '') return '';
  const pad = (x) => String(x ?? 0).padStart(2, '0');
  const fmt = (y, mo, d, h, mi, s) => y + '-' + pad(mo) + '-' + pad(d) + ' ' + pad(h) + ':' + pad(mi) + ':' + pad(s);
  if (typeof v === 'number' && isFinite(v)) {
    // Serial của Google Sheets là giờ địa phương => đọc như UTC để giữ nguyên giờ.
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 19).replace('T', ' ');
  }
  const s = String(v).trim();
  let m = s.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?/);
  if (m) return fmt(m[1], m[2], m[3], m[4], m[5], m[6]);
  m = s.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})(?:,?\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?/);
  if (m) return fmt(m[3], m[2], m[1], m[4], m[5], m[6]);
  return '';
};
const errMsg = (e) => {
  if (!e) return 'không rõ lỗi';
  if (typeof e === 'string') return e;
  return String(e.message || e.description || e.error_user_msg || JSON.stringify(e)).slice(0, 300);
};
`.trim();

const DEFAULT_PROMPT = [
  'Bạn là biên dịch viên nội dung mạng xã hội. Dịch bài đăng Facebook tiếng Việt dưới đây sang tiếng Anh tự nhiên, dễ đọc với người đọc quốc tế.',
  '',
  'Yêu cầu:',
  '- Giữ nguyên ý, giọng văn, cách xuống dòng và emoji của bài gốc.',
  '- Bỏ số điện thoại, link, lời kêu gọi inbox/comment và mọi chỗ nhắc tên/thương hiệu của page gốc.',
  '- Kết thúc bài bằng 1 dòng hashtag riêng (cách nội dung 1 dòng trống): 3–5 hashtag tiếng Anh sát với nội dung, viết liền kiểu CamelCase (vd. #VietnamTravel, #StreetFood), ưu tiên hashtag người đọc quốc tế hay tìm.',
  '- Hashtag có sẵn trong bài gốc: dịch sang tiếng Anh nếu có nghĩa và gộp vào dòng hashtag cuối, không lặp lại; bỏ hashtag mang tên page gốc và hashtag chung chung như #viral, #fyp, #trending.',
  '- Không thêm lời giải thích, không đặt tiêu đề, không bọc trong dấu ngoặc kép hay code block.',
  '- Chỉ trả về bài tiếng Anh hoàn chỉnh (nội dung + dòng hashtag).',
  '',
  'Bài gốc:',
  '"""',
  '{{NOI_DUNG}}',
  '"""',
].join('\n');

/* ---------------------------------------------------------------- workflow */

function buildAutopost(v) {
  const wf = workflow('AutoPost');

  /* ---- 3 lịch chạy → gắn tên việc → Config chung → rẽ nhánh theo việc ---- */

  const SECTIONS = [
    { key: 'collect', trigger: 'Mỗi 4 giờ: thu bài', tag: 'Việc: thu bài', rule: { field: 'hours', hoursInterval: 4 } },
    { key: 'translate', trigger: 'Mỗi 5 phút: dịch', tag: 'Việc: dịch', rule: { field: 'minutes', minutesInterval: 5 } },
    { key: 'publish', trigger: 'Mỗi 2 phút: đăng', tag: 'Việc: đăng', rule: { field: 'minutes', minutesInterval: 2 } },
  ];
  const ROW = { collect: -3, translate: 0, publish: 3 };

  const config = node(wf, {
    name: 'Config',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    col: 2,
    row: 0,
    notes: 'SỬA Ở ĐÂY — chỗ duy nhất cần điền: sheet_id, page_id, crawler_token (build từ .env thì đã điền sẵn)',
    notesInFlow: true,
    parameters: {
      assignments: {
        assignments: [
          { id: 'c00', name: 'section', value: '={{ $json.section }}', type: 'string' },
          { id: 'c01', name: 'sheet_id', value: v.sheet_id, type: 'string' },
          { id: 'c02', name: 'page_id', value: v.page_id, type: 'string' },
          { id: 'c03', name: 'crawler_url', value: 'http://fb-crawler:8000/crawl', type: 'string' },
          { id: 'c04', name: 'crawler_token', value: v.crawler_token, type: 'string' },
          { id: 'c05', name: 'default_max_posts', value: 5, type: 'number' },
          { id: 'c06', name: 'skip_video_posts', value: true, type: 'boolean' },
          { id: 'c07', name: 'post_id_prefix', value: 'AP', type: 'string' },
          { id: 'c08', name: 'gemini_model', value: 'gemini-3.5-flash-lite', type: 'string' },
          { id: 'c09', name: 'translate_per_run', value: 3, type: 'number' },
          { id: 'c10', name: 'min_images', value: 1, type: 'number' },
          { id: 'c11', name: 'max_images', value: 10, type: 'number' },
          { id: 'c12', name: 'min_content_chars', value: 50, type: 'number' },
          { id: 'c13', name: 'stuck_posting_minutes', value: 15, type: 'number' },
          { id: 'c14', name: 'graph_version', value: GRAPH_VERSION, type: 'string' },
          { id: 'c15', name: 'timezone', value: 'Asia/Ho_Chi_Minh', type: 'string' },
        ],
      },
      options: {},
    },
  });

  for (const s of SECTIONS) {
    node(wf, {
      name: s.trigger,
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      col: 0,
      row: ROW[s.key],
      parameters: { rule: { interval: [s.rule] } },
    });
    node(wf, {
      name: s.tag,
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      col: 1,
      row: ROW[s.key],
      parameters: {
        assignments: { assignments: [{ id: 's1', name: 'section', value: s.key, type: 'string' }] },
        options: {},
      },
    });
    chain(wf, s.trigger, s.tag, config);
  }

  const route = node(wf, {
    name: 'Chọn việc',
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    col: 3,
    row: 0,
    parameters: {
      rules: {
        values: SECTIONS.map((s) => ({
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{
              id: `r-${s.key}`,
              leftValue: '={{ $json.section }}',
              rightValue: s.key,
              operator: { type: 'string', operation: 'equals' },
            }],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: s.tag.replace('Việc: ', ''),
        })),
      },
      options: {},
    },
  });
  connect(wf, config, route);

  /* ------------------------------------------------ 1. Thu bài (mỗi 4 giờ) */

  const r1 = ROW.collect;
  const readPostsC = sheetsRead(wf, 'Sheets: Đọc Posts (thu)', 'Posts', { col: 4, row: r1 });

  // Gom về ĐÚNG 1 item: node Google Sheets chạy một lần cho mỗi item đầu vào,
  // để nguyên 500 dòng Posts thì node đọc Sources sẽ bị gọi 500 lần.
  const known = code(wf, 'Gom bài đã có', `
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
return [{ json: { existing_keys: keys, max_post_number: maxNum } }];
`, { col: 5, row: r1 });

  const readSources = sheetsRead(wf, 'Sheets: Đọc Sources', 'Sources', { col: 6, row: r1 });

  const sources = code(wf, 'Lọc nguồn đang bật', `
${SHARED_JS}
const cfg = $('Config').first().json;
const out = [];
for (const item of $input.all()) {
  const r = item.json || {};
  if (!isTruthy(r.active)) continue;
  const ref = String(r.page_url ?? r.page_id_or_url ?? '').trim();
  if (!ref) continue;
  const max = Number(r.max_posts) > 0 ? Number(r.max_posts) : Number(cfg.default_max_posts) || 5;
  out.push({ json: {
    source_name: String(r.source_name ?? '').trim() || ref,
    page: ref,
    max_posts: Math.min(max, 10),
  } });
}
if (!out.length) throw new Error('Tab "Sources" chưa có page nào bật active');
return out;
`, { col: 7, row: r1 });

  // Gọi lần lượt từng page, nghỉ 20 giây giữa các page.
  const crawler = http(wf, 'Crawler: Lấy bài của page', {
    method: 'POST',
    url: `={{ ${cfgExpr('crawler_url')} }}`,
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'X-Crawler-Token', value: `={{ ${cfgExpr('crawler_token')} }}` }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ page: $json.page, max_posts: $json.max_posts }) }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 20000 } }, timeout: 240000 },
  }, { col: 8, row: r1, onError: 'continueRegularOutput', notes: 'Gọi service fb-crawler (docker compose).' });

  const normCrawler = code(wf, 'Chuẩn hoá bài crawler', `
${SHARED_JS}
const cfg = $('Config').first().json;
const sources = $('Lọc nguồn đang bật').all().map((i) => i.json);
const skipVideo = String(cfg.skip_video_posts).toLowerCase() !== 'false';
const out = [];
const failures = [];
$input.all().forEach((item, index) => {
  const src = sources[index] || { source_name: '?' };
  const body = item.json || {};
  if (body.error || body.ok === false) {
    failures.push(src.source_name + ': ' + errMsg(body.error || body));
    return;
  }
  // Crawler luôn trả các bài mới nhất (kể cả bài đã thu) => 0 bài là có vấn đề thật.
  if (!Array.isArray(body.posts) || !body.posts.length) {
    failures.push(src.source_name + ': không lấy được bài nào (link page sai, page bị ẩn/giới hạn tuổi, hoặc Facebook chặn tạm thời)');
    return;
  }
  for (const p of body.posts) {
    const images = Array.isArray(p.images) ? p.images.slice(0, 10) : [];
    // Reel/video không reup bằng ảnh được.
    if (skipVideo && p.has_video && !images.length) continue;
    const text = String(p.text || '').replace(/\\r\\n/g, '\\n').trim();
    out.push({ json: {
      source_page: src.source_name,
      source_post_url: p.source_post_url || '',
      source_post_id: String(p.source_post_id || ''),
      title: (p.is_shared ? '[Chia sẻ] ' : '') + text.replace(/\\s+/g, ' ').slice(0, 120),
      source_text: text.slice(0, ${MAX_CELL_CHARS}),
      source_images: images,
    } });
  }
});
// Một page lỗi không chặn page khác; tất cả đều lỗi thì báo đỏ trong n8n Executions.
if (failures.length === sources.length) {
  throw new Error('Crawler lỗi với tất cả page — ' + failures.join(' | '));
}
return out;
`, { col: 9, row: r1 });

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
  const key = String(p.source_post_id || p.source_post_url || '').trim();
  if (!key || seen.has(key)) continue;
  seen.add(key);
  maxNum += 1;
  const hasText = String(p.source_text || '').trim().length > 0;
  const images = Array.isArray(p.source_images) ? p.source_images : [];
  rows.push({ json: {
    post_id: prefix + '-' + String(maxNum).padStart(4, '0'),
    status: hasText ? 'NEED_TRANSLATE' : 'NEED_CONTENT',
    publish_now: false,
    scheduled_at: '',
    title: p.title || '',
    en_text: '',
    source_images: images.join('\\n'),
    check_note: hasText
      ? '⏳ Chờ Gemini dịch (tối đa 5 phút)'
      : 'Bài gốc không có chữ — tự viết nội dung tiếng Anh vào en_text',
    source_text: p.source_text || '',
    source_page: p.source_page || '',
    source_post_url: p.source_post_url || '',
    source_post_id: p.source_post_id || '',
    collected_at: stamp,
    posted_at: '',
    fb_post_id: '',
    fb_permalink: '',
    images_count: images.length,
    last_action_at: stamp,
  } });
}
return rows;
`, { col: 10, row: r1 });

  const append = sheetsWrite(wf, 'Sheets: Thêm bài mới', 'Posts', 'append', [], { col: 11, row: r1 });

  connect(wf, route, readPostsC, { fromOutput: 0 });
  chain(wf, readPostsC, known, readSources, sources, crawler, normCrawler, dedupe, append);

  /* ----------------------------------------------- 2. Dịch (mỗi 5 phút) */

  const r2 = ROW.translate;
  // Prompt dùng chung với hộp thoại dịch trong Sheet (tab Prompt, ô A2).
  const readPrompt = sheetsRead(wf, 'Sheets: Đọc Prompt', 'Prompt', { col: 4, row: r2, onError: 'continueRegularOutput' });

  const pickPrompt = code(wf, 'Lấy prompt', `
const DEFAULT_PROMPT = ${JSON.stringify(DEFAULT_PROMPT)};
let prompt = '';
for (const item of $input.all()) {
  const values = Object.values(item.json || {}).filter((x) => typeof x === 'string' && x.trim());
  prompt = values.find((x) => x.includes('{{NOI_DUNG}}')) || values.find((x) => x.length > 80) || '';
  if (prompt) break;
}
return [{ json: { prompt: prompt || DEFAULT_PROMPT, from_sheet: Boolean(prompt) } }];
`, { col: 5, row: r2 });

  const readPostsT = sheetsRead(wf, 'Sheets: Đọc Posts (dịch)', 'Posts', { col: 6, row: r2 });

  const pickT = code(wf, 'Chọn bài cần dịch', `
${SHARED_JS}
const cfg = $('Config').first().json;
const template = $('Lấy prompt').first().json.prompt;
const limit = Number(cfg.translate_per_run ?? 3);
const out = [];
$input.all().forEach((item, index) => {
  const r = item.json || {};
  if (String(r.status ?? '').trim().toUpperCase() !== 'NEED_TRANSLATE') return;
  const source = String(r.source_text ?? '').trim();
  if (!source || String(r.en_text ?? '').trim()) return;
  // split/join thay vì replace: bài gốc có "$&", "$1"... không bị hiểu là mẫu thay thế.
  const prompt = template.includes('{{NOI_DUNG}}')
    ? template.split('{{NOI_DUNG}}').join(source)
    : template + '\\n\\n' + source;
  out.push({ json: {
    row_number: rowNumberOf(r, index),
    post_id: String(r.post_id ?? '').trim(),
    request_body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
  } });
});
return out.slice(0, limit);
`, { col: 7, row: r2 });

  // Nghỉ 6 giây giữa các bài để không vượt giới hạn/phút của gói free.
  const gemini = http(wf, 'Gemini: Dịch', {
    method: 'POST',
    url: `=https://generativelanguage.googleapis.com/v1beta/models/{{ ${cfgExpr('gemini_model')} }}:generateContent`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.request_body) }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 6000 } }, timeout: 120000 },
  }, { col: 8, row: r2, onError: 'continueRegularOutput', notes: CRED_GEMINI });

  const applyT = code(wf, 'Gắn bản dịch', `
${SHARED_JS}
const cfg = $('Config').first().json;
const asked = $('Chọn bài cần dịch').all();
const stamp = nowIso(cfg.timezone);

const clean = (t) => {
  let s = String(t || '').replace(/\\r\\n/g, '\\n').trim();
  s = s.replace(/^\\\`\\\`\\\`[a-zA-Z]*\\n([\\s\\S]*?)\\n\\\`\\\`\\\`$/, '$1').trim();
  s = s.replace(/^"""\\n?([\\s\\S]*?)\\n?"""$/, '$1').trim();
  if (/^"[\\s\\S]*"$/.test(s) && s.indexOf('"', 1) === s.length - 1) s = s.slice(1, -1).trim();
  return s.replace(/\\n{3,}/g, '\\n\\n');
};

return $input.all().map((item, i) => {
  const req = (asked[i] || asked[0]).json;
  const res = item.json || {};
  const base = { row_number: req.row_number, post_id: req.post_id, last_action_at: stamp };

  if (res.error) {
    const msg = errMsg(res.error);
    // Hết quota / quá tải / mạng / sai API key: để nguyên NEED_TRANSLATE, lần sau tự thử lại.
    if (/429|RESOURCE_EXHAUSTED|quota|50[0-9]|UNAVAILABLE|timeout|ETIMEDOUT|ECONNRESET|API.?key|PERMISSION_DENIED|401|403/i.test(msg)) {
      return { json: { ...base, check_note: '⏳ Gemini tạm lỗi, sẽ tự thử lại: ' + msg } };
    }
    return { json: { ...base, status: 'ERROR', check_note: '❌ Gemini không dịch được: ' + msg + ' — dịch tay bằng menu 🌐 Dịch bằng AI (web).' } };
  }

  const cand = (res.candidates || [])[0] || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = clean(parts.filter((p) => !p.thought).map((p) => p.text || '').join(''));
  const blocked = (res.promptFeedback && res.promptFeedback.blockReason)
    || (/SAFETY|RECITATION|PROHIBITED|BLOCKLIST/.test(cand.finishReason || '') ? cand.finishReason : '');
  if (!text || blocked) {
    return { json: { ...base, status: 'ERROR', check_note: '❌ Gemini không trả bản dịch' + (blocked ? ' (bị chặn: ' + blocked + ')' : '') + ' — dịch tay bằng menu 🌐 Dịch bằng AI (web).' } };
  }
  const warn = cand.finishReason === 'MAX_TOKENS' ? ' ⚠️ Có thể bị cắt cụt (MAX_TOKENS) — đọc kỹ đoạn cuối.' : '';
  return { json: {
    ...base,
    en_text: text.slice(0, ${MAX_CELL_CHARS}),
    status: 'REVIEW',
    check_note: '🤖 Gemini đã dịch ' + text.length + ' ký tự — đọc lại en_text rồi tick publish_now.' + warn,
  } };
});
`, { col: 9, row: r2 });

  const writeT = sheetsWrite(wf, 'Sheets: Ghi bản dịch', 'Posts', 'update', ['row_number'], { col: 10, row: r2 });

  connect(wf, route, readPrompt, { fromOutput: 1 });
  chain(wf, readPrompt, pickPrompt, readPostsT, pickT, gemini, applyT, writeT);

  /* ------------------------------------------------ 3. Đăng (mỗi 2 phút) */

  const r3 = ROW.publish;
  const readPostsP = sheetsRead(wf, 'Sheets: Đọc Posts (đăng)', 'Posts', { col: 4, row: r3 });

  // Workflow chết giữa chừng (mất mạng, n8n restart...) có thể để dòng ở POSTING mãi.
  // KHÔNG tự đăng lại vì bài có thể đã lên Page — chỉ chuyển ERROR để bạn kiểm tra.
  const stuck = code(wf, 'Tìm bài kẹt POSTING', `
${SHARED_JS}
const cfg = $('Config').first().json;
const minutes = Number(cfg.stuck_posting_minutes ?? 15);
const cutoff = nowIso(cfg.timezone, new Date(Date.now() - minutes * 60000));
const stamp = nowIso(cfg.timezone);
const out = [];
$input.all().forEach((item, index) => {
  const r = item.json || {};
  if (String(r.status ?? '').trim().toUpperCase() !== 'POSTING') return;
  const last = toSortable(r.last_action_at);
  if (!last || last > cutoff) return; // không đọc được giờ => để yên, an toàn hơn
  out.push({ json: {
    row_number: rowNumberOf(r, index),
    status: 'ERROR',
    check_note: '⚠️ Kẹt ở POSTING quá ' + minutes + ' phút (lần cuối ' + last + '). Bài CÓ THỂ đã lên Page — kiểm tra Page trước khi đăng lại.',
    publish_now: false,
    last_action_at: stamp,
  } });
});
return out;
`, { col: 5, row: r3 + 1.5 });
  const stuckSheet = sheetsWrite(wf, 'Sheets: Gỡ kẹt POSTING', 'Posts', 'update', ['row_number'], { col: 6, row: r3 + 1.5 });

  // Mỗi lượt đăng đúng 1 bài: đơn giản, và giãn cách giữa các bài để tránh bị Facebook chặn.
  const due = code(wf, 'Chọn bài đến hạn', `
${SHARED_JS}
const cfg = $('Config').first().json;
const now = nowIso(cfg.timezone);
const candidates = [];
$input.all().forEach((item, index) => {
  const r = item.json || {};
  const postId = String(r.post_id ?? '').trim();
  if (!postId) return;
  const status = String(r.status ?? '').trim().toUpperCase();
  if (['POSTED', 'POSTING', 'SKIP'].includes(status)) return;
  const manual = isTruthy(r.publish_now);
  // Bài hẹn giờ đã ERROR thì chỉ đăng lại khi bạn tick tay (tránh thử lại vô hạn).
  const scheduled = toSortable(r.scheduled_at);
  const scheduledDue = status !== 'ERROR' && scheduled !== '' && scheduled <= now;
  if (!manual && !scheduledDue) return;
  candidates.push({ ...r, row_number: rowNumberOf(r, index), reason: manual ? 'tick publish_now' : 'đến giờ ' + scheduled, sort: manual ? '0' : scheduled });
});
candidates.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
return candidates.slice(0, 1).map(({ sort, ...r }) => ({ json: r }));
`, { col: 5, row: r3 });

  const check = code(wf, 'Kiểm tra bài', `
${SHARED_JS}
const cfg = $('Config').first().json;
const r = $json;
const minImages = Number(cfg.min_images ?? 1);
const maxImages = Math.min(Number(cfg.max_images ?? 10), 10);
const minChars = Number(cfg.min_content_chars ?? 50);

const message = String(r.en_text ?? '')
  .replace(/^\\uFEFF/, '')
  .replace(/\\r\\n/g, '\\n')
  .replace(/\\n{3,}/g, '\\n\\n')
  .trim();
const urls = String(r.source_images ?? '')
  .split(/\\s+/)
  .map((s) => s.trim())
  .filter((s) => /^https?:\\/\\//i.test(s));

const errors = [];
if (!message) {
  errors.push(String(r.source_text ?? '').trim()
    ? 'Chưa có bản dịch ở en_text (chờ Gemini, hoặc menu 🌐 Dịch bằng AI).'
    : 'Chưa có nội dung ở en_text.');
} else if (message.length < minChars) {
  errors.push('Nội dung quá ngắn (' + message.length + ' ký tự, cần ≥ ' + minChars + ').');
} else if (message.length > 60000) {
  errors.push('Nội dung quá dài (' + message.length + ' ký tự, Facebook giới hạn ~63.206).');
}
if (urls.length < minImages) errors.push('Thiếu ảnh: cần tối thiểu ' + minImages + ' link ở source_images, hiện có ' + urls.length + '.');
if (urls.length > maxImages) errors.push('Quá nhiều ảnh: Facebook cho tối đa ' + maxImages + ' ảnh/bài, hiện có ' + urls.length + '.');

return [{ json: {
  ok: errors.length === 0,
  errors,
  post_id: String(r.post_id ?? '').trim(),
  row_number: r.row_number,
  reason: r.reason,
  message,
  content_chars: message.length,
  images: urls.map((url, i) => ({ url, order: i + 1 })),
  images_count: urls.length,
  timezone: cfg.timezone,
} }];
`, { col: 6, row: r3 });

  const okIf = ifNode(wf, 'Đủ điều kiện đăng?', [isTrue('={{ $json.ok }}')], { col: 7, row: r3 });

  const invalidWrite = code(wf, 'Soạn ghi chú lỗi', `
${SHARED_JS}
const d = $json;
return [{ json: {
  row_number: d.row_number,
  status: 'ERROR',
  images_count: d.images_count,
  check_note: '❌ ' + d.errors.join(' | '),
  publish_now: false,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 8, row: r3 + 1 });
  const invalidSheet = sheetsWrite(wf, 'Sheets: Ghi lỗi kiểm tra', 'Posts', 'update', ['row_number'], { col: 9, row: r3 + 1 });

  const postingWrite = code(wf, 'Soạn trạng thái POSTING', `
${SHARED_JS}
const d = $json;
return [{ json: {
  row_number: d.row_number,
  status: 'POSTING',
  images_count: d.images_count,
  check_note: '⏳ Đang đăng lên Facebook (' + d.reason + ')...',
  publish_now: false,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 8, row: r3 });
  const postingSheet = sheetsWrite(wf, 'Sheets: Ghi POSTING', 'Posts', 'update', ['row_number'], { col: 9, row: r3 });

  const hasImages = ifNode(wf, 'Có ảnh?', [gt("={{ $('Kiểm tra bài').first().json.images_count }}", 0)], { col: 10, row: r3 });

  const split = code(wf, 'Tách từng ảnh', `
return $('Kiểm tra bài').first().json.images.map((img) => ({ json: img }));
`, { col: 11, row: r3 - 0.7 });

  // Lỗi tải ảnh không được làm workflow dừng giữa chừng (sẽ kẹt POSTING):
  // cho đi tiếp, "Soạn payload bài đăng" đếm thiếu ảnh và huỷ đăng.
  const download = http(wf, 'Tải ảnh gốc', {
    url: '={{ $json.url }}',
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } }, timeout: 60000 },
  }, { col: 12, row: r3 - 0.7, onError: 'continueRegularOutput' });

  const upload = http(wf, 'FB: Upload ảnh (chưa publish)', {
    method: 'POST',
    url: `=https://graph.facebook.com/{{ ${cfgExpr('graph_version')} }}/{{ ${cfgExpr('page_id')} }}/photos`,
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
  }, { col: 13, row: r3 - 0.7, notes: CRED_FB, onError: 'continueRegularOutput' });

  // Lỗi upload đi theo output thường để chỉ có MỘT chỗ quyết định huỷ đăng.
  const payload = code(wf, 'Soạn payload bài đăng', `
${SHARED_JS}
const d = $('Kiểm tra bài').first().json;
const safeAll = (name) => {
  if (!d.images_count) return []; // bài không ảnh: không đọc dữ liệu node ảnh
  try {
    return $(name).all();
  } catch (e) {
    return [];
  }
};
const uploads = safeAll('FB: Upload ảnh (chưa publish)').map((i) => i.json || {});
const media = uploads.map((r) => r.id).filter(Boolean);

const problems = [];
safeAll('Tải ảnh gốc').forEach((it, i) => {
  const e = it.json && it.json.error;
  if (e) problems.push('tải ảnh ' + (i + 1) + ' lỗi: ' + errMsg(e) + ' (link ảnh Facebook chỉ sống vài ngày — lấy lại link mới)');
});
if (!problems.length) {
  uploads.forEach((r, i) => {
    if (!r.id) problems.push('upload ảnh ' + (i + 1) + ' lỗi: ' + errMsg(r.error));
  });
}

const payload = { message: d.message };
if (media.length) payload.attached_media = media.map((id) => ({ media_fbid: String(id) }));
const enough = media.length === Number(d.images_count);
return [{ json: {
  ...d,
  media_ids: media,
  payload,
  upload_ok: enough,
  error: enough ? undefined : {
    message: 'Chỉ upload được ' + media.length + '/' + d.images_count + ' ảnh lên Facebook, huỷ đăng để tránh bài thiếu ảnh.'
      + (problems.length ? ' ' + problems.slice(0, 3).join(' | ') : ''),
  },
} }];
`, { col: 14, row: r3 });

  const uploadOk = ifNode(wf, 'Upload đủ ảnh?', [isTrue('={{ $json.upload_ok }}')], { col: 15, row: r3 });

  const createPost = http(wf, 'FB: Tạo bài trên Page', {
    method: 'POST',
    url: `=https://graph.facebook.com/{{ ${cfgExpr('graph_version')} }}/{{ ${cfgExpr('page_id')} }}/feed`,
    ...fbAuth(),
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.payload) }}',
    options: {},
  }, { col: 16, row: r3, notes: CRED_FB, onError: 'continueErrorOutput' });

  const permalink = http(wf, 'FB: Lấy permalink', {
    url: `=https://graph.facebook.com/{{ ${cfgExpr('graph_version')} }}/{{ $json.id }}`,
    ...fbAuth(),
    sendQuery: true,
    queryParameters: { parameters: [{ name: 'fields', value: 'permalink_url' }] },
    options: {},
  }, { col: 17, row: r3, notes: CRED_FB, onError: 'continueRegularOutput' });

  const postedWrite = code(wf, 'Soạn trạng thái POSTED', `
${SHARED_JS}
const d = $('Kiểm tra bài').first().json;
const created = $('FB: Tạo bài trên Page').first().json || {};
const info = $json || {};
const fbId = String(created.id || info.id || '');
const link = info.permalink_url || (fbId ? 'https://www.facebook.com/' + fbId.replace('_', '/posts/') : '');
return [{ json: {
  row_number: d.row_number,
  status: 'POSTED',
  images_count: d.images_count,
  check_note: '✅ Đã đăng ' + d.images_count + ' ảnh + ' + d.content_chars + ' ký tự.',
  posted_at: nowIso(d.timezone),
  fb_post_id: fbId,
  fb_permalink: link,
  publish_now: false,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 18, row: r3 });
  const postedSheet = sheetsWrite(wf, 'Sheets: Ghi POSTED', 'Posts', 'update', ['row_number'], { col: 19, row: r3 });

  const fbErr = code(wf, 'Soạn lỗi Facebook', `
${SHARED_JS}
const d = $('Kiểm tra bài').first().json;
const err = $json || {};
const detail = (err.error && (err.error.message || err.error.error_user_msg))
  || err.message
  || (typeof err === 'string' ? err : JSON.stringify(err).slice(0, 400));
return [{ json: {
  row_number: d.row_number,
  status: 'ERROR',
  images_count: d.images_count,
  check_note: '❌ Facebook từ chối: ' + detail,
  publish_now: false,
  last_action_at: nowIso(d.timezone),
} }];
`, { col: 17, row: r3 + 1.5 });
  const fbErrSheet = sheetsWrite(wf, 'Sheets: Ghi lỗi Facebook', 'Posts', 'update', ['row_number'], { col: 18, row: r3 + 1.5 });

  connect(wf, route, readPostsP, { fromOutput: 2 });
  chain(wf, readPostsP, stuck, stuckSheet);
  chain(wf, readPostsP, due, check, okIf);
  connect(wf, okIf, postingWrite, { fromOutput: 0 });
  connect(wf, okIf, invalidWrite, { fromOutput: 1 });
  chain(wf, invalidWrite, invalidSheet);
  chain(wf, postingWrite, postingSheet, hasImages);
  connect(wf, hasImages, split, { fromOutput: 0 });
  connect(wf, hasImages, payload, { fromOutput: 1 });
  chain(wf, split, download, upload, payload, uploadOk);
  connect(wf, uploadOk, createPost, { fromOutput: 0 });
  connect(wf, uploadOk, fbErr, { fromOutput: 1 });
  connect(wf, createPost, permalink, { fromOutput: 0 });
  connect(wf, createPost, fbErr, { fromOutput: 1 });
  chain(wf, permalink, postedWrite, postedSheet);
  chain(wf, fbErr, fbErrSheet);

  return wf;
}

/* -------------------------------------------------------------------- build */

function write(dir, values) {
  const wf = buildAutopost(values);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, OUT_FILE), `${JSON.stringify(wf, null, 2)}\n`, 'utf8');
  console.log(`✔ ${join(dir.slice(ROOT.length + 1), OUT_FILE)} — ${wf.nodes.length} node`);
}

write(OUT_DIR, PLACEHOLDERS);

const env = readEnv();
const local = {
  sheet_id: env.N8N_SHEET_ID || PLACEHOLDERS.sheet_id,
  page_id: env.FB_PAGE_ID || PLACEHOLDERS.page_id,
  crawler_token: env.CRAWLER_TOKEN || PLACEHOLDERS.crawler_token,
};
const missing = Object.keys(local).filter((k) => local[k] === PLACEHOLDERS[k]);
if (missing.length < Object.keys(local).length) {
  write(LOCAL_DIR, local);
  console.log(`  → import n8n/local/${OUT_FILE} (đã điền từ .env, không commit).`);
  if (missing.length) console.log(`  ⚠ .env còn thiếu: ${missing.join(', ')} — các ô này vẫn là placeholder.`);
}

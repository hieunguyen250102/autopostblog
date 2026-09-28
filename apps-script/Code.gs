/**
 * AutoPost Blog — Apps Script gắn vào Google Sheet điều khiển.
 *
 * Nhiệm vụ của file này:
 *   1. Tạo sẵn 3 sheet Posts / Sources / Log đúng schema mà n8n mong đợi.
 *   2. Thêm menu "🚀 Auto Post" để bấm Kiểm tra / Đăng ngay / Thu bài từ nguồn.
 *   3. Tick ô publish_now => gọi webhook n8n đăng bài ngay (cần cài trigger).
 *
 * Cài đặt: xem docs/03-google-sheet-apps-script.md
 */

/* ============================================================== SCHEMA ==== */

var SHEET_POSTS = 'Posts';
var SHEET_SOURCES = 'Sources';
var SHEET_LOG = 'Log';

// Thứ tự cột PHẢI trùng với key mà workflow n8n đọc/ghi.
var POSTS_HEADERS = [
  'post_id',
  'source_page',
  'source_post_url',
  'source_post_id',
  'collected_at',
  'title',
  'summary',
  'drive_folder_url',
  'status',
  'images_count',
  'content_chars',
  'check_note',
  'scheduled_at',
  'posted_at',
  'fb_post_id',
  'fb_permalink',
  'publish_now',
  'last_action_at'
];

var POSTS_NOTES = {
  post_id: 'Mã bài, n8n tự sinh (AP-0001). Đừng sửa tay.',
  source_page: 'Tên page nguồn (lấy từ sheet Sources).',
  source_post_url: 'Link bài gốc — bạn mở link này để dịch + lấy ảnh.',
  source_post_id: 'ID bài gốc, dùng để chống trùng khi thu bài.',
  collected_at: 'Thời điểm n8n thu được bài.',
  title: 'Tiêu đề để bạn nhận biết bài (không đăng lên Facebook).',
  summary: 'Tóm tắt nội dung gốc.',
  drive_folder_url: 'DÁN LINK FOLDER DRIVE vào đây. Folder gồm 1 file nội dung (.txt/.md/Google Docs, tiếng Anh) + các file ảnh.',
  status: 'NEED_CONTENT → READY → POSTED. ERROR = thiếu thành phần, xem check_note.',
  images_count: 'Số ảnh n8n tìm thấy trong folder.',
  content_chars: 'Số ký tự nội dung n8n đọc được.',
  check_note: 'Kết quả kiểm tra / lý do lỗi gần nhất.',
  scheduled_at: 'Muốn hẹn giờ: ghi "2026-01-31 08:30" (giờ Việt Nam). Workflow 03 sẽ tự đăng khi đến hạn.',
  posted_at: 'Thời điểm đăng thành công.',
  fb_post_id: 'ID bài trên Facebook.',
  fb_permalink: 'Link bài đã đăng.',
  publish_now: 'TICK Ô NÀY để đăng ngay. n8n sẽ tự bỏ tick sau khi xử lý.',
  last_action_at: 'Lần cuối n8n tác động vào dòng này.'
};

var SOURCES_HEADERS = ['source_name', 'page_id_or_url', 'mode', 'feed_url', 'active', 'max_posts', 'note'];

var SOURCES_NOTES = {
  source_name: 'Tên gợi nhớ của page nguồn.',
  page_id_or_url: 'Page ID (khuyến nghị) hoặc link page. Dùng cho mode = graph.',
  mode: 'graph = gọi Facebook Graph API; rss = đọc feed_url.',
  feed_url: 'Chỉ dùng khi mode = rss (RSS/Atom của nguồn).',
  active: 'TICK để bật thu bài từ nguồn này.',
  max_posts: 'Số bài mới nhất lấy mỗi lần chạy (mặc định 5).',
  note: 'Ghi chú tự do.'
};

var LOG_HEADERS = ['time', 'post_id', 'action', 'http_code', 'message'];

var STATUSES = ['NEED_CONTENT', 'READY', 'POSTING', 'POSTED', 'ERROR', 'SKIP'];

var STATUS_COLORS = {
  NEED_CONTENT: '#fff2cc',
  READY: '#d9ead3',
  POSTING: '#cfe2f3',
  POSTED: '#b6d7a8',
  ERROR: '#f4cccc',
  SKIP: '#efefef'
};

/* =============================================================== MENU ===== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🚀 Auto Post')
    .addItem('① Khởi tạo / sửa lại cấu trúc sheet', 'setupSheet')
    .addItem('② Nhập cấu hình n8n (URL + secret)', 'configure')
    .addItem('③ Bật tự động khi tick ô publish_now', 'installTrigger')
    .addSeparator()
    .addItem('🔍 Kiểm tra bài đang chọn', 'checkSelected')
    .addItem('📤 Đăng bài đang chọn', 'publishSelected')
    .addSeparator()
    .addItem('⬇️ Thu bài mới từ các page nguồn', 'collectNow')
    .addItem('ℹ️ Xem cấu hình hiện tại', 'showConfig')
    .addToUi();
}

/* ====================================================== KHỞI TẠO SHEET ==== */

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  setupPostsSheet_(ss);
  setupSourcesSheet_(ss);
  setupLogSheet_(ss);
  ss.toast('Đã khởi tạo Posts / Sources / Log.', 'Auto Post', 5);
}

function setupPostsSheet_(ss) {
  var sh = ss.getSheetByName(SHEET_POSTS) || ss.insertSheet(SHEET_POSTS);
  writeHeaders_(sh, POSTS_HEADERS, POSTS_NOTES);

  var lastRow = Math.max(sh.getMaxRows(), 500);
  if (sh.getMaxRows() < lastRow) sh.insertRowsAfter(sh.getMaxRows(), lastRow - sh.getMaxRows());

  var statusCol = indexOf_(POSTS_HEADERS, 'status');
  var publishCol = indexOf_(POSTS_HEADERS, 'publish_now');

  var statusRange = sh.getRange(2, statusCol, lastRow - 1, 1);
  statusRange.setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build()
  );

  sh.getRange(2, publishCol, lastRow - 1, 1).insertCheckboxes();

  // Tô màu theo trạng thái.
  var rules = [];
  var allRange = sh.getRange(2, 1, lastRow - 1, POSTS_HEADERS.length);
  var statusLetter = columnLetter_(statusCol);
  Object.keys(STATUS_COLORS).forEach(function (st) {
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$' + statusLetter + '2="' + st + '"')
        .setBackground(STATUS_COLORS[st])
        .setRanges([allRange])
        .build()
    );
  });
  sh.setConditionalFormatRules(rules);

  sh.setFrozenRows(1);
  sh.setColumnWidth(indexOf_(POSTS_HEADERS, 'title'), 260);
  sh.setColumnWidth(indexOf_(POSTS_HEADERS, 'summary'), 320);
  sh.setColumnWidth(indexOf_(POSTS_HEADERS, 'drive_folder_url'), 260);
  sh.setColumnWidth(indexOf_(POSTS_HEADERS, 'check_note'), 340);
  // scheduled_at là text để n8n so sánh chuỗi "YYYY-MM-DD HH:mm" cho chắc.
  sh.getRange(2, indexOf_(POSTS_HEADERS, 'scheduled_at'), lastRow - 1, 1).setNumberFormat('@');
}

function setupSourcesSheet_(ss) {
  var sh = ss.getSheetByName(SHEET_SOURCES) || ss.insertSheet(SHEET_SOURCES);
  writeHeaders_(sh, SOURCES_HEADERS, SOURCES_NOTES);

  var rows = Math.max(sh.getMaxRows(), 100);
  var modeCol = indexOf_(SOURCES_HEADERS, 'mode');
  sh.getRange(2, modeCol, rows - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['graph', 'rss'], true).setAllowInvalid(false).build()
  );
  sh.getRange(2, indexOf_(SOURCES_HEADERS, 'active'), rows - 1, 1).insertCheckboxes();
  sh.setFrozenRows(1);
  sh.setColumnWidth(indexOf_(SOURCES_HEADERS, 'page_id_or_url'), 240);
  sh.setColumnWidth(indexOf_(SOURCES_HEADERS, 'feed_url'), 240);

  if (sh.getRange(2, 1).isBlank()) {
    sh.getRange(2, 1, 1, SOURCES_HEADERS.length).setValues([
      ['Ví dụ - đổi lại', '1234567890', 'graph', '', false, 5, 'Bật active khi đã điền Page ID thật']
    ]);
  }
}

function setupLogSheet_(ss) {
  var sh = ss.getSheetByName(SHEET_LOG) || ss.insertSheet(SHEET_LOG);
  writeHeaders_(sh, LOG_HEADERS, {});
  sh.setFrozenRows(1);
  sh.setColumnWidth(indexOf_(LOG_HEADERS, 'message'), 480);
}

function writeHeaders_(sh, headers, notes) {
  var range = sh.getRange(1, 1, 1, headers.length);
  range.setValues([headers]);
  range.setFontWeight('bold').setBackground('#434343').setFontColor('#ffffff').setVerticalAlignment('middle');
  headers.forEach(function (h, i) {
    if (notes[h]) sh.getRange(1, i + 1).setNote(notes[h]);
  });
  sh.setRowHeight(1, 34);
}

/* ============================================================= CẤU HÌNH == */

function configure() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getDocumentProperties();

  var urlAnswer = ui.prompt(
    'Cấu hình n8n (1/2)',
    'Dán BASE URL webhook của n8n, ví dụ:\nhttps://abc.app.n8n.cloud\n\n(Không cần /webhook ở cuối)',
    ui.ButtonSet.OK_CANCEL
  );
  if (urlAnswer.getSelectedButton() !== ui.Button.OK) return;
  var base = String(urlAnswer.getResponseText() || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    ui.alert('URL không hợp lệ (phải bắt đầu bằng http:// hoặc https://).');
    return;
  }

  var secretAnswer = ui.prompt(
    'Cấu hình n8n (2/2)',
    'Dán WEBHOOK SECRET — phải trùng ô webhook_secret trong node Config của workflow 02.',
    ui.ButtonSet.OK_CANCEL
  );
  if (secretAnswer.getSelectedButton() !== ui.Button.OK) return;
  var secret = String(secretAnswer.getResponseText() || '').trim();
  if (!secret) {
    ui.alert('Secret không được để trống.');
    return;
  }

  props.setProperties({ N8N_BASE_URL: base, WEBHOOK_SECRET: secret });
  ui.alert('Đã lưu cấu hình.\n\nĐăng bài: ' + base + '/webhook/autopost-publish\nThu bài:  ' + base + '/webhook/autopost-collect');
}

function showConfig() {
  var cfg = getConfig_(false);
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'onEditHandler';
  });
  SpreadsheetApp.getUi().alert(
    'Base URL: ' + (cfg.base || '(chưa cấu hình)') + '\n' +
    'Secret:   ' + (cfg.secret ? '••••' + cfg.secret.slice(-4) : '(chưa cấu hình)') + '\n' +
    'Trigger tick ô publish_now: ' + (triggers.length ? 'ĐANG BẬT' : 'chưa bật')
  );
}

function getConfig_(required) {
  var props = PropertiesService.getDocumentProperties();
  var cfg = {
    base: props.getProperty('N8N_BASE_URL') || '',
    secret: props.getProperty('WEBHOOK_SECRET') || ''
  };
  if (required && (!cfg.base || !cfg.secret)) {
    throw new Error('Chưa cấu hình n8n. Vào menu 🚀 Auto Post → ② Nhập cấu hình n8n.');
  }
  return cfg;
}

function installTrigger() {
  var ui = SpreadsheetApp.getUi();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onEditHandler') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditHandler')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  ui.alert('Đã bật: tick ô publish_now là bài sẽ được đăng ngay.');
}

/* ====================================================== HÀNH ĐỘNG CHÍNH == */

function checkSelected() {
  runOnSelection_('check');
}

function publishSelected() {
  runOnSelection_('publish');
}

function runOnSelection_(action) {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEET_POSTS) {
    ui.alert('Hãy chọn dòng trong sheet "' + SHEET_POSTS + '" trước.');
    return;
  }

  var rows = selectedDataRows_(sh);
  if (!rows.length) {
    ui.alert('Chưa chọn dòng nào có dữ liệu.');
    return;
  }
  if (action === 'publish') {
    var confirm = ui.alert(
      'Đăng ' + rows.length + ' bài lên Facebook?',
      rows.map(function (r) { return '• ' + r.post_id + ' — ' + (r.title || '(không tiêu đề)'); }).join('\n'),
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;
  }

  var results = rows.map(function (r) { return sendAction_(action, r); });
  var okCount = results.filter(function (r) { return r.ok; }).length;
  ui.alert(
    (action === 'check' ? 'Kiểm tra' : 'Đăng bài') + ': ' + okCount + '/' + results.length + ' thành công.\n\n' +
    results.map(function (r) { return '• ' + r.post_id + ': ' + r.message; }).join('\n')
  );
}

function collectNow() {
  var cfg = getConfig_(true);
  var res = fetch_(cfg.base + '/webhook/autopost-collect', { secret: cfg.secret, action: 'collect' });
  log_('', 'collect', res.code, res.text);
  SpreadsheetApp.getUi().alert(
    res.code >= 200 && res.code < 300
      ? 'Đã yêu cầu n8n thu bài. Vài giây nữa bấm F5 để thấy bài mới ở sheet Posts.'
      : 'n8n trả lỗi ' + res.code + ':\n' + res.text.slice(0, 500)
  );
}

/**
 * Gửi 1 dòng sang n8n. Trả về { ok, post_id, message }.
 */
function sendAction_(action, row) {
  var cfg = getConfig_(true);
  var res = fetch_(cfg.base + '/webhook/autopost-publish', {
    secret: cfg.secret,
    action: action,
    post_id: row.post_id,
    row_number: row.row_number
  });

  var message;
  var ok = false;
  if (res.timedOut) {
    message = 'n8n nhận việc nhưng phản hồi chậm — theo dõi cột status.';
  } else {
    var body = {};
    try { body = JSON.parse(res.text); } catch (e) { body = {}; }
    ok = res.code >= 200 && res.code < 300 && body.ok !== false;
    message = body.message || body.error || (body.errors ? [].concat(body.errors).join(' | ') : '') || ('HTTP ' + res.code + ' ' + res.text.slice(0, 200));
  }
  log_(row.post_id, action, res.code, message);
  return { ok: ok, post_id: row.post_id, message: message };
}

/* ============================================ TRIGGER tick publish_now === */

function onEditHandler(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== SHEET_POSTS) return;

  var publishCol = indexOf_(POSTS_HEADERS, 'publish_now');
  if (e.range.getColumn() !== publishCol || e.range.getNumRows() !== 1) return;
  if (e.range.getRow() < 2) return;
  if (e.range.getValue() !== true) return;

  var row = readRow_(sh, e.range.getRow());
  if (!row.post_id) {
    sh.getRange(e.range.getRow(), publishCol).setValue(false);
    return;
  }
  var status = String(row.status || '').toUpperCase();
  if (status === 'POSTED' || status === 'POSTING') {
    sh.getRange(e.range.getRow(), publishCol).setValue(false);
    SpreadsheetApp.getActiveSpreadsheet().toast(row.post_id + ' đang/đã đăng — bỏ qua.', 'Auto Post', 5);
    return;
  }

  SpreadsheetApp.getActiveSpreadsheet().toast('Đang gửi ' + row.post_id + ' sang n8n...', 'Auto Post', 5);
  var res = sendAction_('publish', row);
  SpreadsheetApp.getActiveSpreadsheet().toast(row.post_id + ': ' + res.message, 'Auto Post', 8);
}

/* ============================================================== HELPERS == */

function selectedDataRows_(sh) {
  var out = [];
  var seen = {};
  sh.getActiveRangeList().getRanges().forEach(function (range) {
    for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r += 1) {
      if (r < 2 || seen[r]) continue;
      seen[r] = true;
      var row = readRow_(sh, r);
      if (row.post_id) out.push(row);
    }
  });
  return out;
}

function readRow_(sh, rowNumber) {
  var values = sh.getRange(rowNumber, 1, 1, POSTS_HEADERS.length).getValues()[0];
  var row = { row_number: rowNumber };
  POSTS_HEADERS.forEach(function (h, i) {
    row[h] = values[i];
  });
  row.post_id = String(row.post_id || '').trim();
  return row;
}

function fetch_(url, payload) {
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true
    });
    return { code: res.getResponseCode(), text: res.getContentText(), timedOut: false };
  } catch (err) {
    // UrlFetchApp cắt kết nối sau ~60s; n8n vẫn chạy tiếp ở phía server.
    return { code: 0, text: String(err), timedOut: true };
  }
}

function log_(postId, action, code, message) {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
    if (!sh) return;
    sh.appendRow([new Date(), postId, action, code, String(message).slice(0, 900)]);
  } catch (e) {
    // không chặn hành động chính chỉ vì ghi log lỗi
  }
}

function indexOf_(headers, name) {
  return headers.indexOf(name) + 1;
}

function columnLetter_(col) {
  var s = '';
  while (col > 0) {
    var m = (col - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    col = (col - 1 - m) / 26;
  }
  return s;
}

/**
 * AutoPost Blog — Apps Script gắn vào Google Sheet điều khiển.
 *
 * Sheet chỉ là nơi lưu bài, duyệt bản dịch và bật đăng; mọi việc chạy trong n8n.
 * File này chỉ:
 *   1. Tạo các tab Posts / Sources / Prompt đúng cấu trúc n8n đọc/ghi.
 *   2. Hộp thoại dịch dự phòng qua AI trên web (khi Gemini báo lỗi).
 *   3. Hộp thoại thêm bài thủ công (khi muốn reup một bài cụ thể).
 *
 * Cài đặt: xem docs/02-google-sheet.md
 */

/* ============================================================== SCHEMA ==== */

var SHEET_POSTS = 'Posts';
var SHEET_SOURCES = 'Sources';
var SHEET_PROMPT = 'Prompt';

// Tên cột PHẢI trùng với key mà workflow n8n đọc/ghi. Cột hay dùng để duyệt nằm bên trái.
var POSTS_HEADERS = [
  'post_id',
  'status',
  'publish_now',
  'scheduled_at',
  'title',
  'en_text',
  'source_images',
  'check_note',
  'source_text',
  'source_page',
  'source_post_url',
  'source_post_id',
  'collected_at',
  'posted_at',
  'fb_post_id',
  'fb_permalink',
  'images_count',
  'last_action_at'
];

var POSTS_NOTES = {
  post_id: 'Mã bài, n8n tự sinh (AP-0001). Đừng sửa.',
  status: 'NEED_TRANSLATE → REVIEW → POSTING → POSTED. ERROR = xem check_note. Đặt SKIP để bỏ bài.',
  publish_now: 'TICK để đăng (n8n quét mỗi 2 phút, mỗi lượt 1 bài). n8n tự bỏ tick sau khi xử lý.',
  scheduled_at: 'Hẹn giờ: ghi "2026-01-31 08:30" (giờ Việt Nam). Không cần tick publish_now.',
  title: 'Nhãn để nhận biết bài (không đăng lên Facebook).',
  en_text: 'Bản tiếng Anh SẼ ĐƯỢC ĐĂNG. Gemini tự điền; đọc lại, sửa trực tiếp ở đây trước khi tick.',
  source_images: 'Link ảnh gốc, mỗi dòng 1 link (tối đa 10), đăng theo đúng thứ tự. Xoá dòng nào là bỏ ảnh đó. Link Facebook chỉ sống vài ngày.',
  check_note: 'Kết quả / lý do lỗi gần nhất.',
  source_text: 'Nội dung gốc tiếng Việt.',
  source_page: 'Tên page nguồn (tab Sources).',
  source_post_url: 'Link bài gốc.',
  source_post_id: 'ID bài gốc, dùng để chống thu trùng.',
  collected_at: 'Thời điểm thu bài.',
  posted_at: 'Thời điểm đăng thành công.',
  fb_post_id: 'ID bài trên Page của bạn.',
  fb_permalink: 'Link bài đã đăng.',
  images_count: 'Số ảnh.',
  last_action_at: 'Lần cuối n8n tác động vào dòng này.'
};

var SOURCES_HEADERS = ['source_name', 'page_url', 'active', 'max_posts', 'note'];

var SOURCES_NOTES = {
  source_name: 'Tên gợi nhớ của page nguồn.',
  page_url: 'Link page, ví dụ https://www.facebook.com/tenpage',
  active: 'TICK để bật thu bài từ page này.',
  max_posts: 'Số bài mới nhất lấy mỗi lần (mặc định 5, tối đa 10). Không đăng nhập thì Facebook chỉ cho xem ~3 bài.',
  note: 'Ghi chú tự do.'
};

var STATUSES = ['NEED_CONTENT', 'NEED_TRANSLATE', 'REVIEW', 'POSTING', 'POSTED', 'ERROR', 'SKIP'];

var STATUS_COLORS = {
  NEED_CONTENT: '#fff2cc',
  NEED_TRANSLATE: '#fce5cd',
  REVIEW: '#d9d2e9',
  POSTING: '#cfe2f3',
  POSTED: '#b6d7a8',
  ERROR: '#f4cccc',
  SKIP: '#efefef'
};

var DEFAULT_PROMPT = [
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
  '"""'
].join('\n');

// Prompt mặc định của các phiên bản trước: ô A2 còn y nguyên bản cũ (chưa sửa tay)
// thì menu ① tự nâng cấp lên DEFAULT_PROMPT mới.
var OLD_DEFAULT_PROMPTS = [
  [
    'Bạn là biên dịch viên nội dung mạng xã hội. Dịch bài đăng Facebook tiếng Việt dưới đây sang tiếng Anh tự nhiên, dễ đọc với người đọc quốc tế.',
    '',
    'Yêu cầu:',
    '- Giữ nguyên ý, giọng văn, cách xuống dòng và emoji của bài gốc.',
    '- Hashtag: dịch sang tiếng Anh nếu có nghĩa; giữ nguyên tên riêng, thương hiệu.',
    '- Bỏ số điện thoại, link, lời kêu gọi inbox/comment dành riêng cho page gốc.',
    '- Không thêm lời giải thích, không đặt tiêu đề, không bọc trong dấu ngoặc kép hay code block.',
    '- Chỉ trả về đúng bản dịch tiếng Anh.',
    '',
    'Bài gốc:',
    '"""',
    '{{NOI_DUNG}}',
    '"""'
  ].join('\n')
];

/* =============================================================== MENU ===== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🚀 Auto Post')
    .addItem('① Khởi tạo / sửa lại cấu trúc sheet', 'setupSheet')
    .addSeparator()
    .addItem('🌐 Dịch bằng AI (web) bài đang chọn', 'translateSelected')
    .addItem('➕ Thêm bài thủ công', 'addManualPost')
    .addToUi();
}

/* ====================================================== KHỞI TẠO SHEET ==== */

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var moved = [];
  setupPostsSheet_(ss, moved);
  setupSourcesSheet_(ss, moved);
  setupPromptSheet_(ss);
  var msg = 'Đã khởi tạo Posts / Sources / Prompt.';
  if (moved.length) {
    msg += '\n\nTab cũ khác cấu trúc nên đã được đổi tên (KHÔNG xoá dữ liệu):\n• ' + moved.join('\n• ') +
      '\n\nCopy dữ liệu cần giữ sang tab mới rồi xoá tab cũ.';
  }
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Lấy tab theo tên; nếu dòng tiêu đề khác cấu trúc hiện tại thì đổi tên tab cũ
 * (giữ nguyên dữ liệu) và tạo tab mới — tránh cột bị lệch so với n8n.
 */
function sheetWithHeaders_(ss, name, headers, moved) {
  var sh = ss.getSheetByName(name);
  if (sh && sh.getLastColumn() > 0) {
    var current = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), headers.length)).getValues()[0];
    var same = headers.every(function (h, i) { return String(current[i]) === h; });
    var blank = sh.getLastRow() <= 1 && current.every(function (v) { return v === ''; });
    if (!same && !blank) {
      var backup = name + '_cu_' + Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyyMMdd_HHmm');
      sh.setName(backup);
      moved.push(name + ' → ' + backup);
      sh = null;
    }
  }
  if (!sh) sh = ss.insertSheet(name);
  var range = sh.getRange(1, 1, 1, headers.length);
  range.setValues([headers]);
  range.setFontWeight('bold').setBackground('#434343').setFontColor('#ffffff').setVerticalAlignment('middle');
  sh.setRowHeight(1, 34);
  sh.setFrozenRows(1);
  return sh;
}

function setupPostsSheet_(ss, moved) {
  var sh = sheetWithHeaders_(ss, SHEET_POSTS, POSTS_HEADERS, moved);
  POSTS_HEADERS.forEach(function (h, i) { sh.getRange(1, i + 1).setNote(POSTS_NOTES[h] || ''); });

  var lastRow = Math.max(sh.getMaxRows(), 500);
  if (sh.getMaxRows() < lastRow) sh.insertRowsAfter(sh.getMaxRows(), lastRow - sh.getMaxRows());
  var n = lastRow - 1;

  sh.getRange(2, col_('status'), n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(true).build()
  );
  // KHÔNG dùng insertCheckboxes(): nó ghi FALSE vào mọi ô, Sheets coi đó là dữ liệu
  // nên n8n "append" sẽ thêm bài mới xuống dưới dòng 500. Chỉ đặt kiểu checkbox.
  sh.getRange(2, col_('publish_now'), n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build()
  );
  // scheduled_at là text để n8n so sánh chuỗi "YYYY-MM-DD HH:mm" cho chắc.
  sh.getRange(2, col_('scheduled_at'), n, 1).setNumberFormat('@');

  var allRange = sh.getRange(2, 1, n, POSTS_HEADERS.length);
  var statusLetter = columnLetter_(col_('status'));
  sh.setConditionalFormatRules(Object.keys(STATUS_COLORS).map(function (st) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + statusLetter + '2="' + st + '"')
      .setBackground(STATUS_COLORS[st])
      .setRanges([allRange])
      .build();
  }));

  var widths = { title: 240, en_text: 380, source_images: 220, check_note: 320, source_text: 320, source_post_url: 200 };
  Object.keys(widths).forEach(function (h) { sh.setColumnWidth(col_(h), widths[h]); });
  // Ô văn bản dài: cắt hiển thị để dòng không cao cả màn hình (bấm vào ô để đọc đủ).
  ['en_text', 'source_images', 'source_text', 'check_note'].forEach(function (h) {
    sh.getRange(2, col_(h), n, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  });
}

function setupSourcesSheet_(ss, moved) {
  var sh = sheetWithHeaders_(ss, SHEET_SOURCES, SOURCES_HEADERS, moved);
  SOURCES_HEADERS.forEach(function (h, i) { sh.getRange(1, i + 1).setNote(SOURCES_NOTES[h] || ''); });
  var rows = Math.max(sh.getMaxRows(), 100);
  sh.getRange(2, SOURCES_HEADERS.indexOf('active') + 1, rows - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build()
  );
  sh.setColumnWidth(SOURCES_HEADERS.indexOf('page_url') + 1, 320);
  if (sh.getRange(2, 1).isBlank()) {
    sh.getRange(2, 1, 1, SOURCES_HEADERS.length).setValues([
      ['Ví dụ - đổi lại', 'https://www.facebook.com/tenpage', false, 5, 'Điền link page thật rồi tick active']
    ]);
  }
}

function setupPromptSheet_(ss) {
  var sh = ss.getSheetByName(SHEET_PROMPT) || ss.insertSheet(SHEET_PROMPT);
  sh.getRange(1, 1).setValue('Prompt dịch — sửa thoải mái, giữ nguyên {{NOI_DUNG}} (chỗ chèn bài gốc)')
    .setFontWeight('bold').setBackground('#434343').setFontColor('#ffffff');
  var current = String(sh.getRange(2, 1).getValue() || '').trim();
  if (!current || OLD_DEFAULT_PROMPTS.indexOf(current) >= 0) sh.getRange(2, 1).setValue(DEFAULT_PROMPT);
  sh.getRange(2, 1).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(1, 900);
  sh.setFrozenRows(1);
}

/* ============================================== DỊCH BẰNG AI QUA WEB ===== */

function translateSelected() {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEET_POSTS) {
    ui.alert('Hãy chọn 1 dòng trong sheet "' + SHEET_POSTS + '" trước.');
    return;
  }
  var r = sh.getActiveRange().getRow();
  if (r < 2) {
    ui.alert('Hãy chọn 1 dòng bài viết (không phải dòng tiêu đề).');
    return;
  }
  openTranslateDialog(r);
}

/** Public để hộp thoại "Thêm bài thủ công" gọi được sau khi lưu. */
function openTranslateDialog(rowNumber) {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_POSTS);
  var row = readRow_(sh, Number(rowNumber));
  if (!row.post_id) {
    ui.alert('Dòng ' + rowNumber + ' chưa có post_id.');
    return;
  }
  var source = String(row.source_text || '').trim();
  if (!source) {
    ui.alert(row.post_id + ' chưa có nội dung gốc.\n\nDán bài tiếng Việt vào cột source_text rồi chạy lại.');
    return;
  }
  var template = getPromptTemplate_();
  var prompt = template.indexOf('{{NOI_DUNG}}') >= 0
    ? template.split('{{NOI_DUNG}}').join(source)
    : template + '\n\n' + source;

  var data = {
    row_number: Number(rowNumber),
    post_id: row.post_id,
    prompt: prompt,
    en_text: String(row.en_text || '')
  };
  var html = HtmlService.createHtmlOutput(translateDialogHtml_(data)).setWidth(780).setHeight(660);
  ui.showModalDialog(html, '🌐 Dịch ' + row.post_id + ' bằng AI');
}

/** Gọi từ hộp thoại: ghi bản dịch vào en_text, chuyển REVIEW để bạn duyệt. */
function saveTranslation(rowNumber, postId, text) {
  var clean = cleanAiOutput_(text);
  if (!clean) throw new Error('Bản dịch đang trống.');
  if (clean.length > 45000) throw new Error('Bản dịch quá dài (' + clean.length + ' ký tự, tối đa 45.000).');

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_POSTS);
  var rn = Number(rowNumber);
  // Dòng có thể đã bị chèn/xoá trong lúc mở hộp thoại => tìm lại theo post_id.
  if (readRow_(sh, rn).post_id !== postId) rn = findRowByPostId_(sh, postId);
  if (!rn) throw new Error('Không còn thấy ' + postId + ' trong sheet Posts.');

  var status = String(readRow_(sh, rn).status || '').toUpperCase();
  setCells_(sh, rn, { en_text: clean, last_action_at: nowText_() });
  if (status === 'POSTED' || status === 'POSTING') {
    return 'Đã lưu bản dịch (' + clean.length + ' ký tự). Bài đang/đã đăng nên không đổi trạng thái.';
  }
  setCells_(sh, rn, {
    status: 'REVIEW',
    check_note: '📝 Có bản dịch ' + clean.length + ' ký tự — đọc lại cột en_text rồi tick publish_now để đăng.'
  });
  return 'Đã lưu ' + clean.length + ' ký tự vào en_text. Trạng thái: REVIEW.';
}

function getPromptTemplate_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PROMPT);
  var t = sh ? String(sh.getRange(2, 1).getValue() || '').trim() : '';
  return t || DEFAULT_PROMPT;
}

/** Bỏ code block / ngoặc kép bao ngoài mà AI hay thêm. */
function cleanAiOutput_(text) {
  var t = String(text || '').replace(/\r\n/g, '\n').trim();
  t = t.replace(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/, '$1').trim();
  t = t.replace(/^"""\n?([\s\S]*?)\n?"""$/, '$1').trim();
  if (/^"[\s\S]*"$/.test(t) && t.indexOf('"', 1) === t.length - 1) t = t.slice(1, -1).trim();
  return t.replace(/\n{3,}/g, '\n\n');
}

function translateDialogHtml_(data) {
  // Chặn chuỗi "</script>" trong bài gốc phá vỡ thẻ script.
  var json = JSON.stringify(data).replace(/</g, '\\u003c');
  return [
    '<style>',
    'body{font-family:Arial,sans-serif;font-size:13px;margin:0;color:#202124}',
    'textarea{width:100%;box-sizing:border-box;font:13px/1.45 Arial,sans-serif;padding:6px}',
    '.row{display:flex;gap:10px;align-items:center;margin:6px 0 14px}',
    'button{padding:6px 14px;cursor:pointer;border:1px solid #dadce0;border-radius:4px;background:#fff}',
    '.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}',
    '.muted{color:#5f6368}',
    '</style>',
    '<b>Bước 1.</b> Copy prompt, mở một AI bên dưới, dán vào và gửi.',
    '<textarea id="prompt" rows="11" readonly></textarea>',
    '<div class="row">',
    '<button class="primary" onclick="copyPrompt()">📋 Copy prompt</button>',
    '<a href="https://chatgpt.com/" target="_blank">ChatGPT</a>',
    '<a href="https://claude.ai/new" target="_blank">Claude</a>',
    '<a href="https://gemini.google.com/app" target="_blank">Gemini</a>',
    '<span id="copied" class="muted"></span>',
    '</div>',
    '<b>Bước 2.</b> Copy kết quả của AI, dán vào đây (sửa thêm nếu muốn).',
    '<textarea id="result" rows="11" placeholder="Dán bản dịch tiếng Anh..."></textarea>',
    '<div class="row">',
    '<button class="primary" id="save" onclick="save()">💾 Lưu vào en_text</button>',
    '<button onclick="google.script.host.close()">Đóng</button>',
    '<span id="msg" class="muted"></span>',
    '</div>',
    '<script>',
    'var DATA = ' + json + ';',
    'document.getElementById("prompt").value = DATA.prompt;',
    'document.getElementById("result").value = DATA.en_text;',
    'function copyPrompt() {',
    '  var t = document.getElementById("prompt"); t.focus(); t.select();',
    '  var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}',
    '  document.getElementById("copied").textContent = ok ? "Đã copy ✓" : "Chưa copy được: bấm vào ô, Ctrl+A rồi Ctrl+C";',
    '}',
    'function save() {',
    '  var btn = document.getElementById("save"), msg = document.getElementById("msg");',
    '  btn.disabled = true; msg.textContent = "Đang lưu...";',
    '  google.script.run',
    '    .withSuccessHandler(function (m) { msg.textContent = "✓ " + m; setTimeout(function () { google.script.host.close(); }, 1500); })',
    '    .withFailureHandler(function (e) { btn.disabled = false; msg.textContent = "✗ " + e.message; })',
    '    .saveTranslation(DATA.row_number, DATA.post_id, document.getElementById("result").value);',
    '}',
    '</script>'
  ].join('\n');
}

/* ================================================= THÊM BÀI THỦ CÔNG ===== */

function addManualPost() {
  var html = HtmlService.createHtmlOutput(manualDialogHtml_()).setWidth(720).setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(html, '➕ Thêm bài thủ công');
}

/** Gọi từ hộp thoại. Trả về { row_number, post_id, message }. */
function saveManualPost(form) {
  var url = String(form.source_post_url || '').trim();
  var text = String(form.source_text || '').replace(/\r\n/g, '\n').trim();
  var links = String(form.source_images || '').split(/\s+/).filter(function (s) { return /^https?:\/\//i.test(s); });
  if (!url && !text) throw new Error('Cần ít nhất link bài gốc hoặc nội dung gốc.');
  if (text.length > 45000) throw new Error('Nội dung gốc quá dài (tối đa 45.000 ký tự).');
  if (links.length > 10) throw new Error('Facebook cho tối đa 10 ảnh/bài, bạn đang dán ' + links.length + ' link.');

  // Khoá để 2 lần bấm liên tiếp không sinh trùng post_id.
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_POSTS);
    if (!sh) throw new Error('Chưa có sheet Posts — chạy menu ① trước.');
    var last = lastPostRow_(sh);
    var maxNum = 0;
    if (last >= 2) {
      var ids = sh.getRange(2, col_('post_id'), last - 1, 1).getValues();
      var urls = sh.getRange(2, col_('source_post_url'), last - 1, 1).getValues();
      for (var i = 0; i < ids.length; i += 1) {
        var m = String(ids[i][0]).match(/(\d+)\s*$/);
        if (m) maxNum = Math.max(maxNum, Number(m[1]));
        if (url && String(urls[i][0]).trim() === url) {
          throw new Error('Link này đã có ở dòng ' + (i + 2) + ' (' + ids[i][0] + ').');
        }
      }
    }
    var postId = 'AP-' + ('000' + (maxNum + 1)).slice(-4);
    var rn = last + 1;
    var now = nowText_();
    setCells_(sh, rn, {
      post_id: postId,
      // Có nội dung gốc => n8n (Gemini) tự dịch trong ≤ 5 phút.
      status: text ? 'NEED_TRANSLATE' : 'NEED_CONTENT',
      publish_now: false,
      title: text.replace(/\s+/g, ' ').slice(0, 120),
      source_images: links.join('\n'),
      check_note: text ? '⏳ Chờ Gemini dịch (tối đa 5 phút)' : 'Chưa có nội dung — viết tiếng Anh vào en_text',
      source_text: text,
      source_page: String(form.source_page || '').trim() || 'Thủ công',
      source_post_url: url,
      source_post_id: url,
      collected_at: now,
      images_count: links.length,
      last_action_at: now
    });
    return { row_number: rn, post_id: postId, message: 'Đã thêm ' + postId + ' ở dòng ' + rn + '.' };
  } finally {
    lock.releaseLock();
  }
}

function manualDialogHtml_() {
  return [
    '<style>',
    'body{font-family:Arial,sans-serif;font-size:13px;margin:0;color:#202124}',
    'label{display:block;font-weight:bold;margin:10px 0 4px}',
    'input,textarea{width:100%;box-sizing:border-box;font:13px/1.45 Arial,sans-serif;padding:6px}',
    '.hint{color:#5f6368;font-weight:normal}',
    '.row{display:flex;gap:10px;align-items:center;margin-top:12px}',
    'button{padding:6px 14px;cursor:pointer;border:1px solid #dadce0;border-radius:4px;background:#fff}',
    '.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}',
    '</style>',
    '<label>Link bài gốc</label><input id="source_post_url" placeholder="https://www.facebook.com/...">',
    '<label>Tên page nguồn <span class="hint">(tuỳ chọn)</span></label><input id="source_page">',
    '<label>Nội dung gốc tiếng Việt <span class="hint">— Gemini sẽ tự dịch</span></label><textarea id="source_text" rows="9"></textarea>',
    '<label>Link ảnh, mỗi dòng 1 link <span class="hint">— mở ảnh trên Facebook → chuột phải → Sao chép địa chỉ hình ảnh.</span></label>',
    '<textarea id="source_images" rows="5"></textarea>',
    '<div class="row">',
    '<button class="primary" onclick="save()">Lưu</button>',
    '<button onclick="google.script.host.close()">Đóng</button>',
    '<span id="msg" class="hint"></span>',
    '</div>',
    '<script>',
    'function val(id) { return document.getElementById(id).value; }',
    'function save() {',
    '  var msg = document.getElementById("msg"); msg.textContent = "Đang lưu...";',
    '  google.script.run',
    '    .withSuccessHandler(function (r) { msg.textContent = "✓ " + r.message; setTimeout(function () { google.script.host.close(); }, 1500); })',
    '    .withFailureHandler(function (e) { msg.textContent = "✗ " + e.message; })',
    '    .saveManualPost({ source_post_url: val("source_post_url"), source_page: val("source_page"), source_text: val("source_text"), source_images: val("source_images") });',
    '}',
    '</script>'
  ].join('\n');
}

/* ============================================================== HELPERS == */

function col_(name) {
  return POSTS_HEADERS.indexOf(name) + 1;
}

/** Dòng cuối cùng có post_id (1 nếu chưa có bài nào). */
function lastPostRow_(sh) {
  var max = sh.getLastRow();
  if (max < 2) return 1;
  var ids = sh.getRange(2, col_('post_id'), max - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i -= 1) {
    if (String(ids[i][0]).trim()) return i + 2;
  }
  return 1;
}

function findRowByPostId_(sh, postId) {
  var last = lastPostRow_(sh);
  if (last < 2) return 0;
  var ids = sh.getRange(2, col_('post_id'), last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i += 1) {
    if (String(ids[i][0]).trim() === postId) return i + 2;
  }
  return 0;
}

function readRow_(sh, rowNumber) {
  var values = sh.getRange(rowNumber, 1, 1, POSTS_HEADERS.length).getValues()[0];
  var row = { row_number: rowNumber };
  POSTS_HEADERS.forEach(function (h, i) { row[h] = values[i]; });
  row.post_id = String(row.post_id || '').trim();
  return row;
}

/** Ghi các ô theo tên cột. Chuỗi ghi dạng text để Sheets không tự đổi sang ngày/số. */
function setCells_(sh, rowNumber, values) {
  Object.keys(values).forEach(function (h) {
    var c = col_(h);
    if (!c) return;
    var cell = sh.getRange(rowNumber, c);
    var v = values[h];
    if (typeof v === 'string') cell.setNumberFormat('@');
    cell.setValue(v);
  });
}

function nowText_() {
  return Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd HH:mm:ss');
}

function columnLetter_(c) {
  var s = '';
  while (c > 0) {
    var m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = (c - 1 - m) / 26;
  }
  return s;
}

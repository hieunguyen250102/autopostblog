#!/usr/bin/env node
/**
 * Kiểm tra Page Access Token trước khi cắm vào n8n.
 *
 *   FB_PAGE_TOKEN=xxx FB_PAGE_ID=123 node tools/check-facebook.mjs
 *   node tools/check-facebook.mjs --post   # đăng thử 1 bài CHỈ MÌNH TÔI thấy
 *
 * Đọc biến môi trường (hoặc file .env cùng thư mục gốc):
 *   FB_PAGE_TOKEN  - Page Access Token (không phải User Token)
 *   FB_PAGE_ID     - ID của Page sẽ đăng
 *   FB_APP_ID      - (tuỳ chọn) để debug_token chính xác hơn
 *   FB_APP_SECRET  - (tuỳ chọn)
 *   FB_GRAPH_VERSION - mặc định v21.0
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

loadDotEnv(join(ROOT, '.env'));

const V = process.env.FB_GRAPH_VERSION || 'v21.0';
const TOKEN = process.env.FB_PAGE_TOKEN || '';
const PAGE_ID = process.env.FB_PAGE_ID || '';
const APP_ID = process.env.FB_APP_ID || '';
const APP_SECRET = process.env.FB_APP_SECRET || '';
const DO_POST = process.argv.includes('--post');

// Quyền tối thiểu để đăng bài + ảnh lên Page.
const REQUIRED = ['pages_manage_posts', 'pages_read_engagement'];

let problems = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => {
  problems += 1;
  console.log(`  ✖ ${m}`);
};
const info = (m) => console.log(`    ${m}`);

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

async function graph(path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${V}/${path}`.replace(/\/+$/, ''));
  for (const [k, v] of Object.entries({ access_token: TOKEN, ...params })) url.searchParams.set(k, v);
  const res = await fetch(url, { method: 'GET' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  if (!TOKEN) {
    console.error('Thiếu FB_PAGE_TOKEN. Xem .env.example.');
    process.exit(2);
  }

  console.log(`\nGraph API ${V}\n`);

  console.log('1) Token thuộc về ai?');
  const me = await graph('me', { fields: 'id,name' });
  if (me.status !== 200) {
    bad(`GET /me lỗi: ${JSON.stringify(me.body.error || me.body)}`);
    console.log('\nToken sai hoặc đã hết hạn — lấy lại ở Graph API Explorer.');
    process.exit(1);
  }
  ok(`${me.body.name} (id ${me.body.id})`);
  if (PAGE_ID && me.body.id !== PAGE_ID) {
    bad(`Token này KHÔNG phải của Page ${PAGE_ID} — đây là token của "${me.body.name}".`);
    info('Nếu /me trả về tên người dùng => bạn đang dùng User Token. Cần đổi sang Page Access Token.');
  } else if (PAGE_ID) {
    ok('Token đúng là Page Access Token của page cần đăng.');
  }

  console.log('\n2) Quyền và thời hạn của token');
  if (APP_ID && APP_SECRET) {
    const dbg = await graph('debug_token', { input_token: TOKEN, access_token: `${APP_ID}|${APP_SECRET}` });
    const d = dbg.body.data || {};
    if (d.type) ok(`type = ${d.type}`);
    if (d.expires_at === 0 || d.expires_at === undefined) ok('không hết hạn (long-lived)');
    else info(`hết hạn lúc: ${new Date(d.expires_at * 1000).toISOString()}`);
    const scopes = d.scopes || [];
    info(`scopes: ${scopes.join(', ') || '(trống)'}`);
    for (const need of REQUIRED) {
      if (scopes.includes(need)) ok(`có ${need}`);
      else bad(`thiếu quyền ${need}`);
    }
  } else {
    info('Bỏ qua debug_token (chưa có FB_APP_ID / FB_APP_SECRET).');
    const perms = await graph(`${PAGE_ID || 'me'}`, { fields: 'id,name,tasks' });
    if (perms.body.tasks) info(`tasks trên page: ${perms.body.tasks.join(', ')}`);
  }

  if (PAGE_ID) {
    console.log('\n3) Đọc được feed của page?');
    const feed = await graph(`${PAGE_ID}/feed`, { limit: 1, fields: 'id,created_time' });
    if (feed.status === 200) ok(`đọc feed OK (${(feed.body.data || []).length} bài gần nhất)`);
    else bad(`không đọc được feed: ${JSON.stringify(feed.body.error || feed.body)}`);
  }

  if (DO_POST) {
    if (!PAGE_ID) {
      bad('Cần FB_PAGE_ID để đăng thử.');
    } else {
      console.log('\n4) Đăng thử một bài (chế độ SELF — chỉ admin page thấy)');
      const url = new URL(`https://graph.facebook.com/${V}/${PAGE_ID}/feed`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: `AutoPost test ${new Date().toISOString()}`,
          privacy: { value: 'SELF' },
          access_token: TOKEN,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.id) {
        ok(`đăng được: ${body.id}`);
        info('Vào page, xoá bài test này sau khi kiểm tra xong.');
      } else {
        bad(`không đăng được: ${JSON.stringify(body.error || body)}`);
      }
    }
  }

  console.log(
    problems === 0
      ? '\nTất cả ổn — dán token này vào credential "Facebook Graph API" của n8n.\n'
      : `\n${problems} vấn đề cần xử lý trước khi chạy workflow.\n`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

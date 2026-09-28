#!/usr/bin/env node
/**
 * Kiểm tra nhanh các file workflow trước khi import vào n8n:
 *  - JSON hợp lệ, tên node không trùng
 *  - connections trỏ tới node tồn tại
 *  - mọi node (trừ trigger) đều nhận được dữ liệu từ đâu đó
 *  - biểu thức $('Tên node') chỉ trỏ tới node có thật
 *  - JavaScript trong node Code parse được
 *
 *   node tools/validate-workflows.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'n8n', 'workflows');
const TRIGGERS = /(^n8n-nodes-base\.(scheduleTrigger|manualTrigger|webhook|cron|errorTrigger|executeWorkflowTrigger)$)/;

let errors = 0;
const fail = (file, msg) => {
  errors += 1;
  console.error(`  ✖ ${file}: ${msg}`);
};

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  let wf;
  try {
    wf = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  } catch (e) {
    fail(file, `JSON không parse được — ${e.message}`);
    continue;
  }

  const names = wf.nodes.map((n) => n.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) fail(file, `tên node trùng: ${[...new Set(dupes)].join(', ')}`);

  const nameSet = new Set(names);
  const targets = new Set();

  for (const [from, conn] of Object.entries(wf.connections)) {
    if (!nameSet.has(from)) fail(file, `connections có node nguồn lạ "${from}"`);
    for (const output of conn.main || []) {
      for (const link of output || []) {
        if (!nameSet.has(link.node)) fail(file, `"${from}" nối tới node không tồn tại "${link.node}"`);
        targets.add(link.node);
      }
    }
  }

  for (const n of wf.nodes) {
    if (!n.type?.startsWith('n8n-nodes-base.')) fail(file, `node "${n.name}" có type lạ: ${n.type}`);
    if (typeof n.typeVersion !== 'number') fail(file, `node "${n.name}" thiếu typeVersion`);
    const isTrigger = TRIGGERS.test(n.type);
    if (!isTrigger && !targets.has(n.name)) fail(file, `node "${n.name}" không có input nào`);
    if (isTrigger && !wf.connections[n.name]) fail(file, `trigger "${n.name}" không nối đi đâu`);
  }

  // Biểu thức $('...') phải trỏ tới node có thật.
  const blob = JSON.stringify(wf);
  for (const m of blob.matchAll(/\$\(\\?'([^']+?)\\?'\)/g)) {
    const ref = m[1].replace(/\\\\/g, '');
    if (!nameSet.has(ref)) fail(file, `biểu thức tham chiếu node không tồn tại: $('${ref}')`);
  }

  // JS trong node Code phải parse được.
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    try {
      new vm.Script(`(async () => {\n${n.parameters.jsCode}\n})`);
    } catch (e) {
      fail(file, `node Code "${n.name}" lỗi cú pháp: ${e.message}`);
    }
  }

  console.log(`✔ ${file} — ${wf.nodes.length} node, ${Object.keys(wf.connections).length} nhánh kết nối`);
}

if (errors) {
  console.error(`\n${errors} lỗi.`);
  process.exit(1);
}
console.log('\nTất cả workflow hợp lệ về mặt cấu trúc.');

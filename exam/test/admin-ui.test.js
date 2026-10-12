import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readPublic = (name) => fs.readFileSync(path.join(root, "public", name), "utf8");

test("admin login requests a username and password", () => {
  const html = readPublic("admin.html");
  const script = readPublic("admin.js");
  assert.match(html, /admin\.css/);
  assert.match(script, /id="adminUsername"/);
  assert.match(script, /id="adminPassword"/);
  assert.match(script, /username:\s*\$\('#adminUsername'\)\.value/);
});

test("admin workspace includes account management and restrained styling", () => {
  const script = readPublic("admin.js");
  const css = readPublic("admin.css");
  assert.match(script, /管理员账号/);
  assert.match(script, /\/api\/admin\/users/);
  assert.match(script, /新建管理员/);
  assert.match(script, /考官/);
  assert.match(script, /财务/);
  assert.match(script, /题库管理/);
  assert.match(script, /\/api\/admin\/question-bank/);
  assert.match(script, /查看答卷/);
  assert.match(script, /id="addOption"/);
  assert.match(script, /class="remove-option"/);
  assert.match(script, /name="correctOption"/);
  assert.match(script, /question-editor-row/);
  assert.match(script, /scrollIntoView/);
  assert.doesNotMatch(script, /每行格式：A\|选项内容/);
  assert.match(script, /id="gradingCriteria"/);
  assert.match(script, /打分原因/);
  assert.match(script, /答题码/);
  assert.match(script, /id="answerCodeCountRevenue"/);
  assert.match(script, /近 7 天业务趋势/);
  assert.match(script, /收款渠道构成/);
  assert.match(css, /\.trend-chart\s*\{/);
  assert.match(css, /\.donut\s*\{/);
  assert.match(css, /\.admin-sidebar\s*\{/);
  assert.match(css, /background:\s*#f4f5f7/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/);
});

test("admin settings expose a configurable exam time limit", () => {
  const script = readPublic("admin.js");
  assert.match(script, /id="configExamMinutes"/);
  assert.match(script, /examMinutes: Number\(\$\('#configExamMinutes'\)\.value\)/);
  assert.match(script, /仅对新创建的考试生效/);
});

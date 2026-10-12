import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readPublic = (name) => fs.readFileSync(path.join(root, "public", name), "utf8");

test("standalone pages keep the final H5 written-exam layout", () => {
  const index = readPublic("index.html");
  const exam = readPublic("exam.html");
  const result = readPublic("result.html");
  const certificate = readPublic("certificate.html");

  assert.match(index, /<body class="written-exam-page">/);
  assert.match(index, /class="exam-intro"/);
  assert.match(index, /class="registration-section"/);
  assert.match(exam, /class="question-sheet"/);
  assert.match(result, /class="result-sheet"/);
  assert.match(certificate, /class="certificate-shell"/);
});

test("club palette is bundled locally for the written-exam pages", () => {
  const css = readPublic("app.css");
  const theme = readPublic("theme.css");

  assert.match(css, /\.written-exam-page\s*\{/);
  assert.match(css, /@import url\('\/theme\.css/);
  assert.match(theme, /--primary:\s*#b83e68/);
  assert.match(theme, /--page:\s*#fff8f6/);
  assert.match(css, /\.exam-intro\s*\{/);
  assert.match(css, /\.certificate-document\s*\{/);
});

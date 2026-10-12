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

test("final H5 editorial palette is bundled locally", () => {
  const css = readPublic("app.css");

  assert.match(css, /\.written-exam-page\s*\{/);
  assert.match(css, /background:\s*#f1f0eb/);
  assert.match(css, /\.exam-intro\s*\{/);
  assert.match(css, /\.certificate-document\s*\{/);
});

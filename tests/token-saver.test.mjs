import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compact, handleClaudePostToolUse, DEFAULTS } from "../guard/token-saver.mjs";

const big = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("\n");

test("small output passes through untouched", () => {
  const r = compact("hello\nworld", "ls", DEFAULTS);
  assert.equal(r.changed, false);
  assert.equal(r.text, "hello\nworld");
});

test("large test output keeps failures, head and tail, drops passing noise", () => {
  const out = big(2000, (i) => (i === 1234 ? "FAIL src/refund.test.ts > rejects over-refund\n  Expected: 400\n  Received: 200" : `PASS src/test${i}.test.ts`)) + "\nTests: 1 failed, 1999 passed";
  const r = compact(out, "npx vitest run", DEFAULTS, ".cloud-guard/token-saver/logs/x.log");
  assert.ok(r.changed);
  assert.ok(r.after < r.before / 10, `${r.after} vs ${r.before}`);
  assert.match(r.text, /FAIL src\/refund\.test\.ts/);
  assert.match(r.text, /Expected: 400/);
  assert.match(r.text, /Tests: 1 failed/);
  assert.match(r.text, /Full output \(secrets redacted\): \.cloud-guard\/token-saver\/logs\/x\.log/);
});

test("repeated lines are collapsed", () => {
  const out = big(3000, () => "retrying connection to db:5432") + "\nERROR: gave up";
  const r = compact(out, "node app.js", DEFAULTS);
  assert.match(r.text, /\[x3000\]/);
  assert.match(r.text, /ERROR: gave up/);
});

test("verbatim commands get a much higher threshold", () => {
  const out = big(300, (i) => `line ${i} of the source file with some content`);
  assert.equal(compact(out, "cat src/app.ts", DEFAULTS).changed, false);
  assert.equal(compact(out, "npm run build", DEFAULTS).changed, true);
});

test("Claude PostToolUse adapter mirrors the tool_response shape and saves a redacted log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-"));
  fs.mkdirSync(path.join(dir, ".git"));
  const stdout = big(1500, (i) => `Downloading package-${i}.tgz`) + "\nnpm ERR! code E401\nnpm ERR! token ghp_" + "a".repeat(36);
  const res = handleClaudePostToolUse({ tool_name: "Bash", cwd: dir, tool_input: { command: "npm install" }, tool_response: { stdout, stderr: "", interrupted: false } });
  const upd = res.hookSpecificOutput.updatedToolOutput;
  assert.equal(res.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(upd.interrupted, false);
  assert.match(upd.stdout, /npm ERR! code E401/);
  assert.ok(upd.stdout.length < 3000);
  const logs = fs.readdirSync(path.join(dir, ".cloud-guard/token-saver/logs"));
  assert.equal(logs.length, 1);
  const saved = fs.readFileSync(path.join(dir, ".cloud-guard/token-saver/logs", logs[0]), "utf8");
  assert.ok(!saved.includes("ghp_aaaa"), "secret must be redacted in the saved log");
  assert.ok(fs.existsSync(path.join(dir, ".cloud-guard/token-saver/stats.jsonl")));
});

test("adapter ignores small outputs, other tools and opt-out marker", () => {
  assert.equal(handleClaudePostToolUse({ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a\nb" } }), null);
  assert.equal(handleClaudePostToolUse({ tool_name: "Read", tool_input: {}, tool_response: "x".repeat(99999) }), null);
  assert.equal(handleClaudePostToolUse({ tool_name: "Bash", tool_input: { command: "npm test # no-compact" }, tool_response: { stdout: "x\n".repeat(99999) } }), null);
});

test("policy can disable it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts2-"));
  fs.mkdirSync(path.join(dir, ".cloud-guard"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".cloud-guard/policy.json"), JSON.stringify({ tokenSaver: { enabled: false } }));
  assert.equal(handleClaudePostToolUse({ tool_name: "Bash", cwd: dir, tool_input: { command: "npm test" }, tool_response: { stdout: "x\n".repeat(99999) } }), null);
});

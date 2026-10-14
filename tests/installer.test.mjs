import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "acs-"));
  fs.mkdirSync(path.join(d, ".git"));
  return d;
}

test("install all agents, then uninstall restores the repo", () => {
  const d = repo();
  fs.mkdirSync(path.join(d, ".claude"));
  fs.writeFileSync(path.join(d, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  fs.writeFileSync(path.join(d, "AGENTS.md"), "# Mine\n");
  const r = run(d, "install", "--yes");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(d, ".claude/skills/cloud-guardrails/SKILL.md")));
  assert.ok(fs.existsSync(path.join(d, ".agents/skills/aws-iam/SKILL.md")));
  assert.ok(fs.existsSync(path.join(d, ".cloud-guard/bin/cloud-guard.mjs")));
  const settings = JSON.parse(fs.readFileSync(path.join(d, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["Bash(ls:*)"]);
  assert.match(JSON.stringify(settings.hooks.PreToolUse), /cloud-guard\.mjs/);
  assert.match(JSON.stringify(settings.hooks.PostToolUse), /token-saver\.mjs/);
  assert.ok(fs.existsSync(path.join(d, ".cloud-guard/bin/token-saver.mjs")));
  for (const n of ["git-workflow", "python", "postgresql", "ai-token-cost-control", "engineering-guardrails"]) assert.ok(fs.existsSync(path.join(d, ".claude/skills", n, "SKILL.md")), n);
  assert.match(fs.readFileSync(path.join(d, "AGENTS.md"), "utf8"), /^# Mine[\s\S]*ai-cloud-skills:begin/);
  // idempotent
  assert.equal(run(d, "install", "--yes").status, 0);
  const s2 = JSON.parse(fs.readFileSync(path.join(d, ".claude/settings.json"), "utf8"));
  assert.equal(s2.hooks.PreToolUse.length, 1);
  assert.equal(s2.hooks.PostToolUse.length, 1);
  assert.equal((fs.readFileSync(path.join(d, "AGENTS.md"), "utf8").match(/ai-cloud-skills:begin/g) || []).length, 1);
  // doctor
  assert.equal(run(d, "doctor").status, 0);
  // uninstall
  assert.equal(run(d, "uninstall").status, 0);
  assert.ok(!fs.existsSync(path.join(d, ".cloud-guard")));
  assert.ok(!fs.existsSync(path.join(d, ".agents")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, ".claude/settings.json"), "utf8")), { permissions: { allow: ["Bash(ls:*)"] } });
  assert.equal(fs.readFileSync(path.join(d, "AGENTS.md"), "utf8").trim(), "# Mine");
});

test("selective install: packs", () => {
  const d = repo();
  const r = run(d, "install", "--agents", "codex", "--packs", "git,db", "--no-token-saver");
  assert.equal(r.status, 0, r.stderr);
  const names = fs.readdirSync(path.join(d, ".agents/skills"));
  assert.ok(names.includes("git-recovery") && names.includes("db-guardrails") && names.includes("engineering-guardrails"));
  assert.ok(!names.some((n) => n.startsWith("aws-") || n === "python"));
  assert.match(fs.readFileSync(path.join(d, "AGENTS.md"), "utf8"), /engineering-guardrails/);
});

test("selective install: one agent, one cloud", () => {
  const d = repo();
  const r = run(d, "install", "--agents", "cursor", "--clouds", "gcp");
  assert.equal(r.status, 0, r.stderr);
  const names = fs.readdirSync(path.join(d, ".agents/skills"));
  assert.ok(names.includes("gcp-gke") && names.includes("cloud-guardrails"));
  assert.ok(!names.some((n) => n.startsWith("aws-") || n.startsWith("azure-")));
  assert.ok(!fs.existsSync(path.join(d, ".claude")));
  assert.ok(fs.existsSync(path.join(d, ".cursor/hooks.json")));
  assert.ok(fs.existsSync(path.join(d, ".cursor/rules/cloud-guardrails.mdc")));
});

test("refuses to clobber invalid JSON settings", () => {
  const d = repo();
  fs.mkdirSync(path.join(d, ".claude"));
  fs.writeFileSync(path.join(d, ".claude", "settings.json"), "{ not json");
  const r = run(d, "install", "--agents", "claude", "--clouds", "aws");
  assert.match(r.stdout, /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(d, ".claude", "settings.json"), "utf8"), "{ not json");
});

test("not a git repo without --force fails", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "acs-nogit-"));
  assert.equal(run(d, "install", "--yes").status, 1);
});

test("list prints all skills", () => {
  const r = run(os.tmpdir(), "list");
  assert.match(r.stdout, /\d{2,} skills\./);
});

test("report summarises guard and token-saver data", async () => {
  const { buildReport, renderText, renderHtml, categorise } = await import("../guard/report.mjs");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "acs-rep-"));
  fs.mkdirSync(path.join(d, ".cloud-guard", "token-saver"), { recursive: true });
  const ts = new Date().toISOString();
  const lines = [
    { ts, agent: "claude", d: "allow", kind: "git" },
    { ts, agent: "claude", d: "deny", rule: "GIT-FORCE-PROTECTED", kind: "git" },
    { ts, agent: "claude", d: "deny", rule: "ENV-MUTATE", tier: "prod", kind: "aws" },
    { ts, agent: "cursor", d: "ask", rule: "PKG-PUBLISH", kind: "npm" },
  ];
  fs.writeFileSync(path.join(d, ".cloud-guard/stats.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(d, ".cloud-guard/token-saver/stats.jsonl"), JSON.stringify({ ts, cmd: "npm test", before: 40000, after: 4000 }) + "\n");
  const r = buildReport({ dirs: [d], days: 7, price: 3 });
  assert.equal(r.guard.checks, 4);
  assert.equal(r.guard.decisions.deny, 2);
  assert.equal(r.guard.prodBlocked, 1);
  assert.equal(r.tokens.tokensSaved, 9000);
  assert.equal(categorise("ENV-MUTATE", "prod"), "prod");
  assert.equal(categorise("ENV-MUTATE", "nonprod"), "changes");
  assert.equal(categorise("SECRET-ENV-DUMP"), "secrets");
  assert.match(renderText(r), /4 agent actions checked/);
  assert.match(renderHtml(r), /Guardrails Report/);
});

test("guard writes per-check stats without command text", () => {
  const d = repo();
  assert.equal(run(d, "install", "--yes", "--agents", "claude").status, 0);
  const r = spawnSync(process.execPath, [path.join(d, ".cloud-guard/bin/cloud-guard.mjs"), "--format", "claude"], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push -f origin main" }, cwd: d }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  assert.match(r.stdout, /deny/);
  const stats = fs.readFileSync(path.join(d, ".cloud-guard/stats.jsonl"), "utf8");
  assert.match(stats, /GIT-FORCE-PROTECTED/);
  assert.ok(!stats.includes("origin main"), "stats must not contain command text");
  assert.ok(fs.existsSync(path.join(d, ".cloud-guard/bin/report.mjs")));
});

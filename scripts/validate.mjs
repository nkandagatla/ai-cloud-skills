#!/usr/bin/env node
// Repository safety and consistency checks (run in CI):
//   1. No secrets anywhere in shipped content (skills, templates, docs, site).
//   2. Every cloud skill defers to cloud-guardrails and has a "Never" section.
//   3. Every backticked skill reference points to a real skill.
//   4. Example commands inside skills that the guard would DENY must be inside a "Never"/forbidden
//      context or explicitly marked, so skills never teach an agent to run a blocked command.
//   5. Skill size limits (keep SKILL.md focused).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanPath, evaluateCommand, DEFAULT_POLICY } from "../guard/cloud-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
let evaluated = 0;
const warn = [];

// 1. secrets
for (const dir of ["skills", "templates", "docs", "site", "README.md", "AGENTS.md", "CLAUDE.md", "SECURITY.md"]) {
  const p = path.join(ROOT, dir);
  if (fs.existsSync(p)) for (const f of scanPath(p)) problems.push(`secret-like content: ${path.relative(ROOT, f.file)}:${f.line} (${f.rule})`);
}

// collect skills
const skills = new Map();
for (const g of ["core", "aws", "azure", "gcp", "git", "lang", "db", "ai"]) {
  const gd = path.join(ROOT, "skills", g);
  if (!fs.existsSync(gd)) continue;
  for (const n of fs.readdirSync(gd)) {
    const f = path.join(gd, n, "SKILL.md");
    if (fs.existsSync(f)) skills.set(n, { group: g, file: f, text: fs.readFileSync(f, "utf8") });
  }
}

const policy = { ...DEFAULT_POLICY, detectActiveContext: false, audit: false, __root: ROOT };
const SKILL_REF = /`((?:aws|azure|gcp|cloud|iac|terraform|policy|secrets|cicd|kubernetes|finops|container|well|genai|setup|ask|git|db|sql|ai|llm|token|engineering|write)-[a-z0-9-]+)`/g;
const EXTRA_REFS = new Set(["cloud-guard", "cloud-guard.mjs", "aws-auth", "cloud-platform", "cloud-iac-checks", "aws-vault", "cloud-guard-scan", "secrets-store-csi", "aws-actions", "azure-login", "well-architected", "kubernetes-namespace", "kubernetes-service-account", "aws-cdk-lib", "token-saver.mjs", "git-filter-repo", "sql-server", "db-migrations", "ai-cloud-skills", "db-sg"]);

for (const [name, s] of skills) {
  const rel = path.relative(ROOT, s.file);
  // 2.
  const GUARD_SKILLS = ["cloud-guardrails", "engineering-guardrails", "db-guardrails"];
  if (!GUARD_SKILLS.includes(name) && !GUARD_SKILLS.some((g) => s.text.includes(g))) problems.push(`${rel}: must reference a guardrails skill (${GUARD_SKILLS.join(" / ")})`);
  if (s.group !== "core" && !/^## Never/m.test(s.text)) problems.push(`${rel}: pack skills need a "## Never" section`);
  // Skills are instructions for the agent: flag text written for a human reader.
  const humanFacing = [
    [/\b(?:ask|tell) (?:the|your) agent\b/i, "addresses a human ('ask the agent')"],
    [/\byour agent\b/i, "addresses a human ('your agent')"],
    [/\bthe human\b/i, "say 'the user'"],
    [/\bteach the team\b|\bhabits? (?:that|to) (?:save|teach)\b/i, "team coaching, not agent instructions"],
    [/\bpress (?:esc|enter|ctrl|cmd)\b|\(esc\)/i, "keyboard instructions for a human"],
  ];
  for (const [re, why] of humanFacing) {
    const m = s.text.match(re);
    if (m) problems.push(`${rel}: written for a human reader (${why}): "${m[0]}"`);
  }
  // 3.
  for (const m of s.text.matchAll(SKILL_REF)) {
    const ref = m[1];
    if (skills.has(ref) || EXTRA_REFS.has(ref) || /^(aws|azure|gcp)-(cli|sdk|region|account|profile|actions)/.test(ref)) continue;
    if (/^(aws|azure|gcp)-[a-z0-9-]+$/.test(ref) && !ref.includes("<")) {
      // tolerate placeholders like `<cloud>-foundations` and identifiers that are not skills
      if (["aws-auth", "aws-node"].includes(ref)) continue;
      warn.push(`${rel}: \`${ref}\` looks like a skill reference but no such skill exists`);
    } else if (/^(cloud|iac|terraform|policy|secrets|cicd|kubernetes|finops|container|well|genai|setup|ask|git|db|sql|ai|llm|token|engineering|write)-/.test(ref)) {
      warn.push(`${rel}: \`${ref}\` looks like a skill reference but no such skill exists`);
    }
  }
  // 4. commands in fenced bash blocks that the guard denies
  const fences = [...s.text.matchAll(/```(?:bash|sh|shell|powershell|pwsh)?\n([\s\S]*?)```/g)];
  for (const f of fences) {
    for (const raw of f[1].split("\n")) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      if (!/^(aws|az|gcloud|gsutil|bq|kubectl|helm|terraform|tofu|terragrunt|pulumi|cdk|sam|eksctl|npx cdk|git|gh|psql|mysql|sqlcmd|mongosh|redis-cli|npm|pnpm|mvn|\.\/mvnw|\.\/gradlew|dotnet|go|uv|pip|rm|chmod|docker)\b/.test(line)) continue;
      evaluated++;
      const r = evaluateCommand(line, { policy, env: {}, cwd: ROOT, noAudit: true });
      if (r.decision === "deny" && !/^ENV-/.test(r.rule)) {
        const ctx = s.text.slice(Math.max(0, f.index - 600), f.index);
        const allowedContext = /platform team|human|the user|user runs|IaC|break-glass|guard blocks|guard-blocked|Never|human runs|run by|\(change|change;|changes|is a change/i.test(ctx + raw);
        (allowedContext ? warn : problems).push(`${rel}: example command is blocked by the guard [${r.rule}]: ${line.slice(0, 120)}`);
      }
    }
  }
  // 5.
  const lines = s.text.split("\n").length;
  if (lines > 400) problems.push(`${rel}: ${lines} lines; split detail into reference files (limit 400)`);
}

if (warn.length) console.log("Warnings:\n  " + warn.join("\n  "));
if (problems.length) {
  console.error("\nProblems:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`\nValidated ${skills.size} skills (${evaluated} example commands checked against the guard): no secrets, guardrail references present, examples consistent with the guard.`);

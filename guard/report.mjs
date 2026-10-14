#!/usr/bin/env node
// ai-cloud-skills report: how much the agents were guarded and how many tokens were saved.
//
//   node .cloud-guard/bin/report.mjs                      # this repo, last 30 days, text
//   node .cloud-guard/bin/report.mjs --days 7 --price 3   # $ estimate at $3 per million input tokens
//   node .cloud-guard/bin/report.mjs --html report.html   # self-contained dashboard
//   node .cloud-guard/bin/report.mjs --json               # for central dashboards
//   node .cloud-guard/bin/report.mjs --dirs ../app,../infra   # several repos, one team view
//
// Reads only local files written by cloud-guard and token-saver:
//   .cloud-guard/stats.jsonl            one line per check (no command text)
//   .cloud-guard/audit.jsonl            details of ask/deny decisions (secrets redacted)
//   .cloud-guard/token-saver/stats.jsonl  sizes before/after trimming
// No network calls. Numbers are estimates (tokens ≈ characters ÷ 4).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_RULES, PROTECTED_PATHS } from "./rules.mjs";

const RULES = Object.fromEntries([...HARD_RULES, ...PROTECTED_PATHS].map((r) => [r.id, r]));

export const CATEGORIES = [
  { key: "prod", label: "Production changes redirected to PR / pipeline", re: /^ENV-/, tier: "prod" },
  { key: "secrets", label: "Secret or credential exposure prevented", re: /^(SECRET-|PATH-|GIT-ADD-SECRET|DB-PASSWORD|AWS-SECRET|AZ-SECRET|GCP-SECRET|K8S-SECRET|AWS-TOKEN|IAC-SECRET)/ },
  { key: "public", label: "Public data / open network exposure prevented", re: /(PUBLIC|NET-OPEN)/ },
  { key: "privilege", label: "Privilege escalation prevented", re: /(ESCALATE|PRIV-|IAM-|RBAC|GH-ADMIN)/ },
  { key: "controls", label: "Security / audit controls kept on", re: /(AUDIT|GOVERNANCE|ORG-POLICY|PROTECTION-OFF|ORG-DESTRUCT|TENANT|HIERARCHY|ACCOUNT-CLOSE)/ },
  { key: "unreviewed", label: "Unreviewed infrastructure applies stopped", re: /^IAC-UNREVIEWED/ },
  { key: "destructive", label: "Destructive or irreversible actions stopped or confirmed", re: /(DESTROY|DESTRUCT|DROP|UNBOUNDED|DELETE|RM-|FORCE|HISTORY|DISCARD|FLUSH|REDIS|BACKUP|KMS|STATE|MASS|RESTORE|DDL|UNPUBLISH|DEPLOY-COMPLETE|S3-RECURSIVE)/ },
  { key: "changes", label: "Non-production changes approved by a human", re: /^ENV-/ },
  { key: "release", label: "Releases / publishing kept in CI", re: /^PKG-/ },
  { key: "tamper", label: "Guard tamper attempts blocked", re: /^GUARD-TAMPER/ },
  { key: "other", label: "Other approvals and blocks", re: /./ },
];

export function categorise(rule, tier) {
  if (!rule) return null;
  for (const c of CATEGORIES) {
    if (c.tier && tier !== c.tier) continue;
    if (c.re.test(rule)) return c.key;
  }
  return "other";
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const a = { days: 30, price: 3, dirs: null, html: null, json: false, md: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--days") (a.days = Number(v)), i++;
    else if (k === "--price") (a.price = Number(v)), i++;
    else if (k === "--dirs") (a.dirs = v.split(",")), i++;
    else if (k === "--html") (a.html = v || "cloud-skills-report.html"), i++;
    else if (k === "--json") a.json = true;
    else if (k === "--md") a.md = true;
    else if (k === "--scope" && v === "user") (a.dirs = [os.homedir()]), i++;
  }
  return a;
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".cloud-guard"))) return dir;
    const p = path.dirname(dir);
    if (p === dir) break;
    dir = p;
  }
  return path.resolve(start);
}

export function buildReport({ dirs, days = 30, price = 3, now = Date.now() }) {
  const since = now - days * 86400000;
  const inWindow = (r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= since && t <= now + 60000;
  };
  const checks = [];
  const audit = [];
  const saver = [];
  const repos = [];
  let sample = false;
  for (const d of dirs) {
    const root = findRoot(d);
    const g = path.join(root, ".cloud-guard");
    if (!fs.existsSync(g)) continue;
    repos.push(path.basename(root));
    if (fs.existsSync(path.join(g, "SAMPLE"))) sample = true;
    checks.push(...readJsonl(path.join(g, "stats.jsonl.1")), ...readJsonl(path.join(g, "stats.jsonl")));
    audit.push(...readJsonl(path.join(g, "audit.jsonl")));
    saver.push(...readJsonl(path.join(g, "token-saver", "stats.jsonl")));
  }
  const C = checks.filter(inWindow);
  const A = audit.filter(inWindow);
  const S = saver.filter(inWindow);

  const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  const decisions = { allow: 0, ask: 0, deny: 0, ...count(C, (x) => x.d) };
  // If stats.jsonl is missing (older install), fall back to audit entries for ask/deny.
  if (!C.length && A.length) Object.assign(decisions, count(A, (x) => x.decision));

  const events = C.length ? C.filter((x) => x.d !== "allow").map((x) => ({ rule: x.rule, tier: x.tier, d: x.d, agent: x.agent, ts: x.ts })) : A.map((x) => ({ rule: x.rule, tier: x.tier, d: x.decision, agent: x.agent, ts: x.ts }));
  const byCategory = {};
  for (const e of events) {
    const k = categorise(e.rule, e.tier);
    if (!k) continue;
    byCategory[k] ??= { deny: 0, ask: 0 };
    byCategory[k][e.d] = (byCategory[k][e.d] || 0) + 1;
  }
  const ruleCounts = Object.entries(count(events.filter((e) => e.d === "deny"), (e) => e.rule))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, n]) => ({ rule, n, reason: RULES[rule]?.reason || (rule?.startsWith("ENV-") ? "Change against a protected environment" : "") }));
  const askCounts = Object.entries(count(events.filter((e) => e.d === "ask"), (e) => e.rule))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([rule, n]) => ({ rule, n, reason: RULES[rule]?.reason || (rule?.startsWith("ENV-") ? "Change against a non-production environment" : "") }));

  const before = S.reduce((s, x) => s + (x.before || 0), 0);
  const after = S.reduce((s, x) => s + (x.after || 0), 0);
  const tokensSaved = Math.round((before - after) / 4);
  const byCmd = {};
  for (const x of S) {
    const k = x.cmd || "?";
    byCmd[k] ??= { n: 0, saved: 0 };
    byCmd[k].n++;
    byCmd[k].saved += Math.round(((x.before || 0) - (x.after || 0)) / 4);
  }

  // daily series
  const dayKey = (ts) => String(ts).slice(0, 10);
  const series = {};
  for (let t = since; t <= now; t += 86400000) series[new Date(t).toISOString().slice(0, 10)] = { checks: 0, blocked: 0, asked: 0, tokens: 0 };
  for (const x of C) {
    const s = (series[dayKey(x.ts)] ??= { checks: 0, blocked: 0, asked: 0, tokens: 0 });
    s.checks++;
    if (x.d === "deny") s.blocked++;
    if (x.d === "ask") s.asked++;
  }
  for (const x of S) (series[dayKey(x.ts)] ??= { checks: 0, blocked: 0, asked: 0, tokens: 0 }).tokens += Math.round(((x.before || 0) - (x.after || 0)) / 4);

  return {
    generatedAt: new Date(now).toISOString(),
    sample,
    days,
    repos,
    guard: {
      checks: C.length || decisions.ask + decisions.deny,
      decisions,
      byAgent: count(C, (x) => x.agent || "?"),
      byKind: Object.fromEntries(Object.entries(count(C, (x) => x.kind || "?")).sort((a, b) => b[1] - a[1]).slice(0, 10)),
      prodBlocked: events.filter((e) => e.d === "deny" && e.tier === "prod").length,
      byCategory,
      topBlocked: ruleCounts,
      topAsked: askCounts,
    },
    tokens: {
      outputsCompacted: S.length,
      tokensBefore: Math.round(before / 4),
      tokensAfter: Math.round(after / 4),
      tokensSaved,
      percent: before ? Math.round((100 * (before - after)) / before) : 0,
      pricePerMTok: price,
      dollarsSaved: Math.round((tokensSaved / 1e6) * price * 100) / 100,
      topCommands: Object.entries(byCmd).sort((a, b) => b[1].saved - a[1].saved).slice(0, 8).map(([cmd, v]) => ({ cmd, ...v })),
    },
    series: Object.entries(series).sort().map(([day, v]) => ({ day, ...v })),
  };
}

const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const label = (k) => CATEGORIES.find((c) => c.key === k)?.label || k;

export function renderText(r) {
  const g = r.guard;
  const t = r.tokens;
  const spark = (vals) => {
    const max = Math.max(1, ...vals);
    return vals.map((v) => " ▁▂▃▄▅▆▇█"[Math.round((v / max) * 8)]).join("");
  };
  const lines = [];
  lines.push(`ai-cloud-skills report · last ${r.days} days · ${r.repos.join(", ") || "no data"}${r.sample ? " · SAMPLE DATA (not real usage)" : ""}`);
  lines.push("");
  lines.push("GUARDED");
  lines.push(`  ${fmt(g.checks)} agent actions checked · ${fmt(g.decisions.allow)} allowed · ${fmt(g.decisions.ask)} needed approval · ${fmt(g.decisions.deny)} blocked`);
  if (g.prodBlocked) lines.push(`  ${fmt(g.prodBlocked)} direct production changes redirected to PR/pipeline`);
  for (const [k, v] of Object.entries(g.byCategory).sort((a, b) => b[1].deny + b[1].ask - (a[1].deny + a[1].ask))) lines.push(`  ${String(v.deny || 0).padStart(5)} blocked ${String(v.ask || 0).padStart(5)} approved/asked  ${label(k)}`);
  if (g.topBlocked.length) {
    lines.push("");
    lines.push("  Top blocked rules");
    for (const x of g.topBlocked) lines.push(`  ${String(x.n).padStart(5)}  ${x.rule.padEnd(24)} ${x.reason.slice(0, 80)}`);
  }
  lines.push("");
  lines.push("TOKENS SAVED (token-saver)");
  lines.push(`  ${fmt(t.outputsCompacted)} large outputs trimmed · ~${fmt(t.tokensSaved)} tokens saved (${t.percent}% of ~${fmt(t.tokensBefore)})`);
  lines.push(`  ≈ $${t.dollarsSaved.toFixed(2)} at $${t.pricePerMTok} per million input tokens, counting each output once (real savings are higher: tool results are re-sent on later turns)`);
  for (const c of t.topCommands) lines.push(`  ${String(c.n).padStart(5)}x  ${c.cmd.padEnd(26)} ~${fmt(c.saved)} tokens`);
  lines.push("");
  lines.push(`Daily checks  ${spark(r.series.map((s) => s.checks))}`);
  lines.push(`Daily blocks  ${spark(r.series.map((s) => s.blocked))}`);
  lines.push(`Tokens saved  ${spark(r.series.map((s) => s.tokens))}`);
  return lines.join("\n");
}

export function renderMarkdown(r) {
  const g = r.guard;
  const t = r.tokens;
  return [
    `## AI agent guardrails and token savings (last ${r.days} days)${r.sample ? " (SAMPLE DATA)" : ""}`,
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Agent actions checked | ${fmt(g.checks)} |`,
    `| Allowed / needed approval / blocked | ${fmt(g.decisions.allow)} / ${fmt(g.decisions.ask)} / ${fmt(g.decisions.deny)} |`,
    `| Production changes redirected to PR | ${fmt(g.prodBlocked)} |`,
    `| Large outputs trimmed | ${fmt(t.outputsCompacted)} |`,
    `| Tokens saved (est.) | ~${fmt(t.tokensSaved)} (${t.percent}%) |`,
    `| Cost avoided (est.) | ~$${t.dollarsSaved.toFixed(2)} at $${t.pricePerMTok}/M tokens |`,
    "",
    "| Protection | Blocked | Asked |",
    "| --- | --- | --- |",
    ...Object.entries(g.byCategory).map(([k, v]) => `| ${label(k)} | ${v.deny || 0} | ${v.ask || 0} |`),
  ].join("\n");
}

export function renderHtml(r) {
  const g = r.guard;
  const t = r.tokens;
  const data = JSON.stringify(r).replace(/</g, "\\u003c");
  const cats = Object.entries(g.byCategory).sort((a, b) => b[1].deny + b[1].ask - (a[1].deny + a[1].ask));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guardrails Report</title>
<style>
:root{--bg:#eef1f4;--panel:#fff;--ink:#15202b;--muted:#55657a;--line:#cfd7e1;--accent:#d9530f;--allow:#1d7f4e;--ask:#a86a00;--deny:#c0262d;--bar:#d9530f33}
@media (prefers-color-scheme:dark){:root{--bg:#0e141a;--panel:#151e27;--ink:#e4ebf2;--muted:#93a3b6;--line:#2a3746;--accent:#ff7a33;--allow:#4fd08f;--ask:#f2b53c;--deny:#ff6b6b;--bar:#ff7a3333;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 16px 48px}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:22px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;min-width:0}
.big{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums}.k{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}@media(max-width:760px){.two{grid-template-columns:minmax(0,1fr)}}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:7px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.deny{color:var(--deny);font-weight:600}.ask{color:var(--ask);font-weight:600}.allow{color:var(--allow);font-weight:600}
.bars{display:flex;align-items:flex-end;gap:2px;height:120px;border-bottom:1px solid var(--line)}.bars div{flex:1;background:var(--accent);min-height:1px;border-radius:2px 2px 0 0}
.legend{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:4px}code{font-family:ui-monospace,Consolas,monospace;font-size:13px}
</style></head><body><div class="wrap">
<h1>Guardrails Report</h1>${r.sample ? '<div class="card" style="margin:10px 0;border-color:var(--ask)"><strong class="ask">Sample data.</strong> These numbers were generated by <code>scripts/demo-data.mjs</code> to show what the report looks like. They are not real usage.</div>' : ""}
<div class="muted">Last ${r.days} days · ${esc(r.repos.join(", ") || "no data")} · generated ${esc(r.generatedAt.slice(0, 16).replace("T", " "))} UTC · estimates</div>
<div class="grid">
<div class="card"><div class="k">Actions checked</div><div class="big">${fmt(g.checks)}</div><div class="muted"><span class="allow">${fmt(g.decisions.allow)}</span> allowed</div></div>
<div class="card"><div class="k">Blocked</div><div class="big deny">${fmt(g.decisions.deny)}</div><div class="muted">${fmt(g.prodBlocked)} were direct prod changes</div></div>
<div class="card"><div class="k">Needed approval</div><div class="big ask">${fmt(g.decisions.ask)}</div><div class="muted">human in the loop</div></div>
<div class="card"><div class="k">Tokens saved</div><div class="big">~${fmt(t.tokensSaved)}</div><div class="muted">${t.percent}% of trimmed output · ≈ $${t.dollarsSaved.toFixed(2)} at $${t.pricePerMTok}/M</div></div>
</div>
<div class="two">
<div class="card"><h2>What the guard prevented</h2><table><tr><th>Protection</th><th class="n">Blocked</th><th class="n">Asked</th></tr>
${cats.map(([k, v]) => `<tr><td>${esc(label(k))}</td><td class="n deny">${v.deny || 0}</td><td class="n ask">${v.ask || 0}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No blocked or approval-required actions yet.</td></tr>`}
</table></div>
<div class="card"><h2>Top blocked rules</h2><table><tr><th>Rule</th><th>Why</th><th class="n">Count</th></tr>
${g.topBlocked.map((x) => `<tr><td><code>${esc(x.rule)}</code></td><td class="muted">${esc(x.reason.length > 110 ? x.reason.slice(0, 107) + "…" : x.reason)}</td><td class="n">${x.n}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Nothing blocked.</td></tr>`}
</table></div>
</div>
<div class="two" style="margin-top:12px">
<div class="card"><h2>Tokens saved per day</h2><div class="bars" id="tok"></div><div class="legend"><span>${esc(r.series[0]?.day || "")}</span><span>${esc(r.series.at(-1)?.day || "")}</span></div></div>
<div class="card"><h2>Biggest output savings</h2><table><tr><th>Command</th><th class="n">Runs</th><th class="n">Tokens saved</th></tr>
${t.topCommands.map((c) => `<tr><td><code>${esc(c.cmd)}</code></td><td class="n">${c.n}</td><td class="n">~${fmt(c.saved)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No large outputs trimmed yet.</td></tr>`}
</table></div>
</div>
<div class="card" style="margin-top:12px"><h2>Checks per day</h2><div class="bars" id="chk"></div><div class="legend"><span>${esc(r.series[0]?.day || "")}</span><span>${esc(r.series.at(-1)?.day || "")}</span></div>
<p class="muted">By agent: ${Object.entries(g.byAgent).map(([a, n]) => `${esc(a)} ${fmt(n)}`).join(" · ") || "n/a"}. By tool: ${Object.entries(g.byKind).map(([a, n]) => `${esc(a)} ${fmt(n)}`).join(" · ") || "n/a"}.</p>
<p class="muted">Token estimates use characters ÷ 4 and count each trimmed output once. In a long session every tool result is re-sent on later turns (mostly as cheaper cache reads), so real savings are higher.</p></div>
</div>
<script>
const R=${data};
function bars(id,key){const el=document.getElementById(id);const m=Math.max(1,...R.series.map(s=>s[key]));el.innerHTML=R.series.map(s=>'<div title="'+s.day+': '+s[key]+'" style="height:'+(100*s[key]/m)+'%"></div>').join("");}
bars("tok","tokens");bars("chk","checks");
</script></body></html>`;
}

async function main(argv) {
  const a = parseArgs(argv);
  const dirs = a.dirs || [process.cwd()];
  const r = buildReport({ dirs, days: a.days, price: a.price });
  if (a.json) return void process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  if (a.md) return void process.stdout.write(renderMarkdown(r) + "\n");
  if (a.html) {
    fs.writeFileSync(a.html, renderHtml(r));
    process.stdout.write(`Wrote ${a.html}\n`);
    return;
  }
  process.stdout.write(renderText(r) + "\n");
}

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1] || "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));

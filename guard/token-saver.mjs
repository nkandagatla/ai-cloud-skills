#!/usr/bin/env node
// token-saver: shrink verbose command output before it reaches the model, without
// changing the command, the permission flow, or the conversation history.
//
// How it works
//   - Claude Code: a PostToolUse hook on Bash. The command runs exactly as written
//     (cloud-guard and your permission rules see the real command). Afterwards, if the
//     output is large, the hook returns a compacted version as the tool result and saves
//     the full output (secrets redacted) to .cloud-guard/token-saver/logs/, with the path
//     included so the agent can read the rest on demand.
//   - Any agent: `node .cloud-guard/bin/token-saver.mjs run -- <command>` runs the
//     command and prints compacted output with the same full-log fallback.
//
// No dependencies. Node 18+. Inspired by the idea behind tools like RTK (Rust Token
// Killer); this is an independent implementation that ships with the repo.
//
//   node token-saver.mjs --format claude      # PostToolUse hook (reads hook JSON on stdin)
//   node token-saver.mjs run -- npm test       # wrapper for any agent / human
//   node token-saver.mjs compact < big.log     # filter stdin
//   node token-saver.mjs gain                  # savings report

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SECRET_CONTENT } from "./rules.mjs";

export const DEFAULTS = {
  enabled: true,
  maxChars: 6000, // outputs at or below this size pass through untouched
  headLines: 30,
  tailLines: 50,
  maxSignalLines: 80, // error/warning/failure lines kept from the middle
  // Commands whose output the agent asked for verbatim (reading files, diffs, JSON).
  // They are only trimmed above `verbatimMaxChars`.
  verbatim: ["cat", "head", "tail", "sed", "awk", "jq", "yq", "less", "more", "bat", "type", "get-content", "git diff", "git show", "diff", "nl", "xxd", "base64"],
  verbatimMaxChars: 40000,
  keepLogs: 50,
  stats: true,
};

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r(?!\n)/g;
const SIGNAL = /\b(?:error|err!|exception|fatal|fail(?:ed|ure|ing)?|panic|traceback|denied|refused|cannot|can't|unable|not found|undefined|segmentation|timeout|timed out|warn(?:ing)?|deprecated|vulnerab|critical|assert(?:ion)?|expected|received|✗|✘|×)\b|^\s*(?:E\s|FAIL|ERROR|WARN|\[ERROR\]|\[WARNING\]|npm ERR|at\s+\S+\s+\(|File ".+", line \d+|\s+-->\s|---\s+FAIL)/i;
const NOISE = /^\s*(?:Downloading|Downloaded|Download(?:ing)? from|Progress|Collecting|Requirement already satisfied|Using cached|Resolving|Fetching|Unpacking|Preparing|Building wheel|Installing collected|\[INFO\] Download|\[INFO\] (?:-+|Building|BUILD SUCCESS)\s*$|#\d+ (?:sha256|extracting|resolve|DONE|CACHED)|\s*\d+(?:\.\d+)?\s*%\s*$|[⠁-⣿]|[\\|/-]\s*$|added \d+ packages|up to date, audited|found 0 vulnerabilities|PASS\s|✓|√|ok\s+\S+\s+\d)/i;

function redact(text) {
  let out = text;
  for (const r of SECRET_CONTENT) out = out.replace(new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g"), "[REDACTED]");
  return out;
}

function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".cloud-guard"))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const p = path.dirname(dir);
    if (p === dir) break;
    dir = p;
  }
  return path.resolve(start || process.cwd());
}

export function loadConfig(root) {
  try {
    const pol = JSON.parse(fs.readFileSync(path.join(root, ".cloud-guard", "policy.json"), "utf8"));
    return { ...DEFAULTS, ...(pol.tokenSaver || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function isVerbatim(cmd, cfg) {
  const c = String(cmd || "").trim().toLowerCase().replace(/^(?:[\w]+=\S+\s+)*/, "");
  return cfg.verbatim.some((v) => c === v || c.startsWith(v + " "));
}

// Collapse runs of identical lines ("x3") and blank lines.
function dedupe(lines) {
  const out = [];
  let prev = null;
  let count = 0;
  const flush = () => {
    if (prev === null) return;
    out.push(count > 1 ? `${prev}  [x${count}]` : prev);
  };
  for (const l of lines) {
    const norm = l.replace(/\d{2}:\d{2}:\d{2}(?:\.\d+)?/g, "").trim();
    const prevNorm = prev === null ? null : prev.replace(/\d{2}:\d{2}:\d{2}(?:\.\d+)?/g, "").trim();
    if (prev !== null && norm === prevNorm) {
      count++;
      continue;
    }
    flush();
    prev = l;
    count = 1;
  }
  flush();
  return out.filter((l, i, a) => !(l.trim() === "" && (a[i - 1] ?? "").trim() === ""));
}

/**
 * Compact command output. Returns { text, changed, before, after }.
 * Strategy: strip ANSI/progress noise, dedupe repeats, then keep head + tail plus every
 * signal line (errors, warnings, failures, stack frames) from the middle with line numbers.
 */
export function compact(raw, cmd = "", cfg = DEFAULTS, logPath = null) {
  const input = String(raw ?? "");
  const before = input.length;
  const limit = isVerbatim(cmd, cfg) ? cfg.verbatimMaxChars : cfg.maxChars;
  if (before <= limit) return { text: input, changed: false, before, after: before };

  let lines = input.replace(ANSI, "").split(/\r?\n/);
  const total = lines.length;
  lines = lines.filter((l) => !NOISE.test(l) || SIGNAL.test(l));
  lines = dedupe(lines);

  const head = cfg.headLines;
  const tail = cfg.tailLines;
  let body;
  if (lines.length <= head + tail + 10) {
    body = lines;
  } else {
    const middle = lines.slice(head, lines.length - tail);
    const signals = [];
    middle.forEach((l, i) => {
      if (SIGNAL.test(l) && signals.length < cfg.maxSignalLines) signals.push(`${String(head + i + 1).padStart(6)}| ${l}`);
    });
    const omitted = middle.length - signals.length;
    body = [
      ...lines.slice(0, head),
      `… [token-saver: ${omitted} lines omitted${signals.length ? `; ${signals.length} error/warning lines kept below` : ""}] …`,
      ...signals,
      ...(signals.length ? ["… [end of kept lines] …"] : []),
      ...lines.slice(lines.length - tail),
    ];
  }
  // Hard cap per line and overall, so a single minified line cannot blow the budget.
  body = body.map((l) => (l.length > 400 ? l.slice(0, 380) + ` … [+${l.length - 380} chars]` : l));
  let text = body.join("\n");
  const cap = Math.max(limit, 2000);
  if (text.length > cap) text = text.slice(0, Math.floor(cap * 0.4)) + `\n… [token-saver: truncated] …\n` + text.slice(text.length - Math.floor(cap * 0.55));
  const tail_ = `${logPath ? ` Full output (secrets redacted): ${logPath}` : ""} Read it, or re-run with a narrower command, if you need the omitted part.`;
  const shown = text.length + tail_.length + 60;
  text += `\n[token-saver] ${total} lines / ${before} chars shown as ~${shown} chars.${tail_}`;
  return { text, changed: true, before, after: text.length };
}

function saveLog(root, cmd, full, cfg) {
  try {
    const dir = path.join(root, ".cloud-guard", "token-saver", "logs");
    fs.mkdirSync(dir, { recursive: true });
    const slug = String(cmd || "output").replace(/[^a-z0-9]+/gi, "_").slice(0, 40).replace(/^_|_$/g, "") || "output";
    const file = path.join(dir, `${Date.now()}_${slug}.log`);
    fs.writeFileSync(file, `$ ${redact(String(cmd || ""))}\n\n${redact(full)}`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - cfg.keepLogs))) fs.rmSync(path.join(dir, f), { force: true });
    return path.relative(root, file).split(path.sep).join("/");
  } catch {
    return null;
  }
}

function recordStats(root, cmd, before, after, cfg) {
  if (!cfg.stats) return;
  try {
    const dir = path.join(root, ".cloud-guard", "token-saver");
    fs.mkdirSync(dir, { recursive: true });
    const first = String(cmd || "").trim().split(/\s+/).slice(0, 2).join(" ");
    fs.appendFileSync(path.join(dir, "stats.jsonl"), JSON.stringify({ ts: new Date().toISOString(), cmd: redact(first), before, after }) + "\n");
  } catch {}
}

// ── Claude Code PostToolUse adapter ──
export function handleClaudePostToolUse(payload) {
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || payload.cwd);
  const cfg = loadConfig(root);
  if (!cfg.enabled) return null;
  if (String(payload.tool_name || "").toLowerCase() !== "bash") return null;
  const cmd = payload.tool_input?.command || "";
  if (/(?:^|\s)#\s*no-compact\b/.test(cmd)) return null;
  const resp = payload.tool_response;
  const isObj = resp && typeof resp === "object";
  const stdout = isObj ? String(resp.stdout ?? resp.output ?? "") : String(resp ?? "");
  const stderr = isObj ? String(resp.stderr ?? "") : "";
  const full = stderr ? `${stdout}\n${stderr}` : stdout;
  const limit = isVerbatim(cmd, cfg) ? cfg.verbatimMaxChars : cfg.maxChars;
  if (full.length <= limit) return null;
  const logPath = saveLog(root, cmd, full, cfg);
  const out = compact(stdout, cmd, cfg, logPath);
  const err = stderr ? compact(stderr, cmd, { ...cfg, maxChars: Math.max(2000, Math.floor(cfg.maxChars / 3)) }, null) : null;
  recordStats(root, cmd, full.length, out.after + (err ? err.after : 0), cfg);
  // Mirror the shape Claude Code gave us so the replacement is accepted as a Bash result.
  const updated = isObj ? { ...resp, stdout: out.text, ...(err ? { stderr: err.text } : {}) } : out.text;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: updated } };
}

// ── wrapper for agents without output hooks ──
function runWrapped(cmdArgs) {
  const cmd = cmdArgs.join(" ");
  const root = findRoot(process.cwd());
  const cfg = loadConfig(root);
  const child = spawn(cmd, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => {
    if (!cfg.enabled || out.length <= (isVerbatim(cmd, cfg) ? cfg.verbatimMaxChars : cfg.maxChars)) {
      process.stdout.write(out);
    } else {
      const logPath = saveLog(root, cmd, out, cfg);
      const r = compact(out, cmd, cfg, logPath);
      recordStats(root, cmd, r.before, r.after, cfg);
      process.stdout.write(r.text + "\n");
    }
    process.exit(code ?? 1);
  });
}

function gain() {
  const root = findRoot(process.cwd());
  const f = path.join(root, ".cloud-guard", "token-saver", "stats.jsonl");
  if (!fs.existsSync(f)) {
    console.log("No token-saver stats yet.");
    return;
  }
  const rows = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const by = {};
  let b = 0,
    a = 0;
  for (const r of rows) {
    b += r.before;
    a += r.after;
    const k = r.cmd || "?";
    by[k] ??= { n: 0, saved: 0 };
    by[k].n++;
    by[k].saved += r.before - r.after;
  }
  const tok = (c) => Math.round(c / 4).toLocaleString();
  console.log(`token-saver: ${rows.length} outputs compacted, ~${tok(b - a)} tokens saved (${Math.round((100 * (b - a)) / Math.max(1, b))}% of ~${tok(b)}).`);
  console.log("Top commands:");
  for (const [k, v] of Object.entries(by).sort((x, y) => y[1].saved - x[1].saved).slice(0, 10)) console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(5)}x  ~${tok(v.saved)} tokens`);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv) {
  if (argv[0] === "run") {
    const dd = argv.indexOf("--");
    return runWrapped(dd >= 0 ? argv.slice(dd + 1) : argv.slice(1));
  }
  if (argv[0] === "gain") return gain();
  if (argv[0] === "compact") {
    const raw = await readStdin();
    const cfg = loadConfig(findRoot(process.cwd()));
    process.stdout.write(compact(raw, argv.slice(1).join(" "), cfg).text + "\n");
    return;
  }
  // hook mode (Claude Code PostToolUse)
  try {
    const raw = await readStdin();
    const payload = raw ? JSON.parse(raw) : {};
    const out = handleClaudePostToolUse(payload);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    // Never break the session because of the optimiser: on any error, output nothing
    // and the original tool result is used unchanged.
  }
  process.exit(0);
}

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1] || "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));

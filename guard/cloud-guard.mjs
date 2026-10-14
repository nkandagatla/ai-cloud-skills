#!/usr/bin/env node
// cloud-guard: a pre-execution guard for AI coding agents working on cloud
// infrastructure (AWS, Azure, Google Cloud, Kubernetes, Terraform/OpenTofu,
// Pulumi, CDK, Bicep).
//
// It runs as a hook before the agent executes a shell command or touches a
// file, and returns allow / ask / deny. No dependencies, Node 18+.
//
// Usage as a hook (reads the hook JSON on stdin):
//   node cloud-guard.mjs --format claude    # Claude Code PreToolUse
//   node cloud-guard.mjs --format cursor    # Cursor beforeShellExecution / beforeReadFile
//   node cloud-guard.mjs --format gemini    # Gemini CLI BeforeTool
//
// Usage as a CLI (for humans, CI, or agents without hook support):
//   node cloud-guard.mjs check -- aws s3 rb s3://x --force
//   node cloud-guard.mjs scan path/to/file-or-dir     # secret scan
//   node cloud-guard.mjs explain                      # print the active policy
//
// Exit codes in CLI mode: 0 allow, 1 ask, 2 deny.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_RULES, PROTECTED_PATHS, GUARD_PATHS, SECRET_CONTENT } from "./rules.mjs";

export const VERSION = "1.0.0";
const RANK = { allow: 0, ask: 1, deny: 2 };
const worst = (a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a);

// ────────────────────────────────────────────────────────────────────────────
// Policy
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_POLICY = {
  // standard: reads allowed, non-prod changes ask, prod changes denied.
  // strict:   like standard, but sandbox changes also ask.
  // readonly: every change is denied; the agent can only read and plan.
  mode: "standard",
  // What an agent may do to production. "deny" (default) means the agent
  // prepares IaC / a PR / a runbook and a human or pipeline applies it.
  prodMutations: "deny",
  // How to treat a command whose target environment cannot be determined.
  unknownEnvironmentAs: "nonprod",
  // Explicit identifiers per tier. Match AWS profile names or account ids,
  // Azure subscription names or ids, GCP project ids, kube contexts,
  // Terraform workspaces / directories / var files, Pulumi stacks.
  environments: { prod: [], nonprod: [], sandbox: [] },
  // Token patterns used when an identifier is not listed explicitly.
  // Identifiers are split on non-alphanumerics and each token is compared.
  tierPatterns: {
    prod: ["prod", "prd", "production", "live", "pr", "p"],
    sandbox: ["sandbox", "sbx", "playground", "scratch", "lab", "localhost", "local", "127", "devbox", "docker"],
    nonprod: ["dev", "develop", "development", "test", "tst", "qa", "uat", "stage", "stg", "staging", "nonprod", "np", "perf", "int", "preprod"],
  },
  // Regions/locations the agent may target. Empty = any.
  allowedRegions: [],
  // Downgrade or upgrade a specific hard rule: { "AWS-S3-RECURSIVE-RM": "deny" }.
  // Downgrading a "deny" rule requires a justification string:
  //   { "IAC-STATE-SURGERY": { "level": "allow", "justification": "..." } }
  overrides: {},
  // Extra organisation rules, same shape as HARD_RULES but `re` is a string.
  customRules: [],
  // Read the active cloud context from local CLI config files (no secrets are
  // read: only azureProfile.json, gcloud active config and kubeconfig's
  // current-context line).
  detectActiveContext: true,
  // Gemini CLI hooks cannot "ask". Map ask to deny (safe default) or allow
  // (rely on Gemini's own confirmation prompt, never use with --yolo).
  geminiAskAs: "deny",
  // Append every non-allow decision to .cloud-guard/audit.jsonl.
  audit: true,
  // Block agents from writing secret material into files.
  secretWriteGuard: true,
};

function findProjectRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".cloud-guard", "policy.json"))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start || process.cwd());
}

export function loadPolicy(root) {
  const file = path.join(root, ".cloud-guard", "policy.json");
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      // A broken policy must not silently weaken the guard.
      user = { mode: "readonly", __error: `Could not parse ${file}: ${e.message}. Falling back to readonly.` };
    }
  }
  const p = {
    ...DEFAULT_POLICY,
    ...user,
    environments: { ...DEFAULT_POLICY.environments, ...(user.environments || {}) },
    tierPatterns: { ...DEFAULT_POLICY.tierPatterns, ...(user.tierPatterns || {}) },
    overrides: { ...(user.overrides || {}) },
  };
  if (!["standard", "strict", "readonly"].includes(p.mode)) p.mode = "standard";
  if (!["deny", "ask"].includes(p.prodMutations)) p.prodMutations = "deny";
  p.__root = root;
  p.__file = file;
  return p;
}

// ────────────────────────────────────────────────────────────────────────────
// Command parsing
// ────────────────────────────────────────────────────────────────────────────

export function normalise(cmd) {
  return String(cmd || "")
    .replace(/\\\r?\n/g, " ") // line continuations
    .replace(/`\r?\n/g, " ") // PowerShell continuations
    .replace(/["']/g, "")
    .replace(/[ \t]+/g, " ")
    .toLowerCase()
    .trim();
}

// Split a command line into simple segments on shell control operators.
// Over-splitting is safe (each piece is checked), so this is deliberately
// simple and also splits inside $( ... ) and backticks.
export function segments(cmd) {
  return normalise(cmd)
    .split(/\r?\n|&&|\|\||;|\||\$\(|\)|`|\s&\s/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const CLIS = ["aws", "az", "gcloud", "gsutil", "bq", "kubectl", "oc", "helm", "terraform", "tofu", "terragrunt", "pulumi", "cdk", "cdktf", "eksctl", "sam", "copilot", "azd", "func", "serverless", "sls", "psql", "mysql", "mariadb", "sqlcmd", "sqlplus", "cqlsh", "mongosh", "mongo", "redis-cli"];
const DB_CLIS = new Set(["psql", "mysql", "mariadb", "sqlcmd", "sqlplus", "cqlsh", "mongosh", "mongo"]);
const CLI_RE = new RegExp(String.raw`(?:^|[\s(=])(?:[\w./\\-]*[\\/])?(${CLIS.map((c) => c.replace("-", "\\-")).join("|")})(?:\.exe|\.cmd)?(?=\s|$)`, "g");

// Global flags that take a value, per CLI, so the value is not mistaken for
// a sub-command.
const VALUE_FLAGS = {
  aws: ["--profile", "--region", "--output", "--endpoint-url", "--query", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--color", "--cli-binary-format"],
  gcloud: ["--project", "--account", "--configuration", "--format", "--verbosity", "--impersonate-service-account", "--billing-project", "--flags-file", "--flatten", "--filter", "--limit", "--page-size", "--sort-by", "--trace-token", "--region", "--zone", "--location"],
  kubectl: ["-n", "--namespace", "--context", "--cluster", "--kubeconfig", "--user", "-s", "--server", "--token", "-l", "--selector", "-o", "--output", "-f", "--filename", "-c", "--container", "--as", "--as-group"],
  helm: ["-n", "--namespace", "--kube-context", "--kubeconfig", "-f", "--values", "--version", "--set", "--set-string", "-o", "--output", "--repo"],
  pulumi: ["-s", "--stack", "-C", "--cwd"],
  terragrunt: ["--terragrunt-working-dir", "--working-dir"],
};
VALUE_FLAGS.oc = VALUE_FLAGS.kubectl;
VALUE_FLAGS["redis-cli"] = ["-h", "-p", "-a", "-n", "-u", "-s", "--user", "--pass", "--tls-cert", "--tls-key", "--cacert", "-r", "-i", "--eval"];

function tokensAfter(segment, start) {
  return segment.slice(start).trim().split(/\s+/).filter(Boolean);
}

function positionals(cli, toks) {
  const vf = new Set(VALUE_FLAGS[cli] || []);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith("-")) {
      // az never takes positional arguments after the first flag.
      if (cli === "az") break;
      if (!t.includes("=") && vf.has(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

function flagValue(toks, names) {
  for (let i = 0; i < toks.length; i++) {
    for (const n of names) {
      if (toks[i] === n && toks[i + 1]) return toks[i + 1];
      if (toks[i].startsWith(n + "=")) return toks[i].slice(n.length + 1);
    }
  }
  return null;
}

// Classify one CLI invocation as read | mutate | destructive | unknown.
const READ_WORDS = /^(?:list|ls|show|describe|get|read|tail|logs?|info|version|help|explain|exists|check-name|check|what-if|validate|wait|search|query|top|history|status|lint|template|diff|plan|preview|synth|cat|du|stat|head|whoami|current-context|get-contexts|get-clusters|view|can-i|api-resources|api-versions|cluster-info|fmt|init|providers|graph|output|login|account|config|auth|completion|estimate|preview|test-[\w-]+|simulate-[\w-]+|filter-log-events|start-query|get-query-results|lookup-events|batch-get-[\w-]+|list-[\w-]+|get-[\w-]+|describe-[\w-]+|show-[\w-]+|search-[\w-]+|print-settings|find|metadata|dry-run|bicep|build|doctor|whoami)$/;
const DESTRUCTIVE_WORDS = /^(?:delete|delete-[\w-]+|destroy|terminate|terminate-[\w-]+|purge|purge-[\w-]+|remove|remove-[\w-]+|rm|rb|uninstall|drain|deallocate|deregister-[\w-]+|disable|disable-[\w-]+|cancel|cancel-[\w-]+|reset|reset-[\w-]+|revoke|revoke-[\w-]+|detach-[\w-]+|disassociate-[\w-]+|stop|stop-[\w-]+|reimage|failover|force-[\w-]+|rotate|restore|restore-[\w-]+|replace|replace-[\w-]+|undeploy|scale-in|shrink|truncate|wipe|reboot|reboot-[\w-]+|rollback|unlink|leave|leave-[\w-]+|close|close-[\w-]+|cordon)$/;
const KNOWN_GCLOUD_VERBS = /^(?:list|describe|create|delete|update|patch|deploy|set-[\w-]+|add-[\w-]+|remove-[\w-]+|get-[\w-]+|ssh|scp|start|stop|reset|resize|restart|enable|disable|import|export|run|submit|cancel|restore|clone|failover|promote-replica|rollback|connect|execute|call|read|print-[\w-]+|activate|login|revoke|apply|destroy|attach|detach|move|rename|undelete|sign-[\w-]+|upgrade|ls|cat|cp|mv|rm|rsync|du|tail|logs|search|versions|access|disable-enforce|allow|deny|test-iam-permissions|analyze-iam-policy|update-[\w-]+|create-[\w-]+|delete-[\w-]+|set|unset|get|info|version|help|config|auth|wait|explain|setup|reauth)$/;

export function classifyInvocation(cli, toks) {
  const pos = positionals(cli, toks);
  const low = pos.map((p) => p.toLowerCase());
  let verb = null;
  let kind = "unknown";

  switch (cli) {
    case "aws": {
      const svc = low[0];
      const op = low[1];
      verb = op || svc || "";
      if (!svc || svc === "help" || toks.includes("help")) return { kind: "read", verb: "help" };
      if (svc === "configure") {
        kind = ["list", "get", "list-profiles", "sso", "sso-session", "export-credentials"].includes(op) ? "read" : "mutate";
        break;
      }
      if (svc === "sso" || svc === "login") return { kind: "read", verb: svc };
      if (svc === "s3") {
        if (["ls", "presign"].includes(op)) kind = "read";
        else if (["cp", "sync"].includes(op)) {
          const dest = low[low.length - 1] || "";
          kind = dest.startsWith("s3://") ? "mutate" : "read";
          if (op === "sync" && toks.includes("--delete")) kind = "destructive";
        } else if (["rm", "rb"].includes(op)) kind = "destructive";
        else kind = "mutate";
        break;
      }
      if (!op) return { kind: "unknown", verb: svc };
      if (/^(?:wait|help)$/.test(op) || /^(?:describe|list|get|head|batch-get|search|lookup|estimate|validate|simulate|test|check|preview|filter|select|scan|query|detect|discover|generate-(?:credential-report|service-last-accessed-details|organizations-access-report)|view|download|tail|start-query|stop-query|export|decode-authorization-message)(?:-|$)/.test(op)) kind = "read";
      else if (DESTRUCTIVE_WORDS.test(op)) kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "az": {
      // az has no positional resource names, so the verb is the last
      // positional token before the first flag.
      verb = low[low.length - 1] || "";
      const group = low[0] || "";
      if (!group || verb === "help" || toks.includes("--help") || toks.includes("-h")) return { kind: "read", verb: "help" };
      if (["login", "logout", "version", "upgrade", "find", "interactive", "init", "config", "configure", "cloud", "extension", "bicep"].includes(group)) return { kind: "read", verb: group };
      if (group === "account" && ["set", "show", "list", "list-locations", "tenant"].includes(low[1])) return { kind: "read", verb: low[1] };
      if (toks.includes("what-if") || low.includes("what-if") || toks.includes("--what-if")) return { kind: "read", verb: "what-if" };
      if (/^(?:show|list|list-[\w-]+|show-[\w-]+|get-[\w-]+|exists|check-name|check-[\w-]+|wait|validate|what-if|query|download|tail|browse|logs?|log|status|history|download-[\w-]+|get|search|summarize|count|test-connection)$/.test(verb)) kind = "read";
      else if (DESTRUCTIVE_WORDS.test(verb)) kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "gcloud": {
      const idx = low.findIndex((t) => KNOWN_GCLOUD_VERBS.test(t) && !["config", "auth"].includes(t));
      const group = low[0] || "";
      if (!group || toks.includes("--help") || group === "help") return { kind: "read", verb: "help" };
      if (group === "config" || group === "info" || group === "version" || group === "components" || group === "init" || group === "topic" || group === "cheat-sheet") return { kind: "read", verb: group };
      if (group === "auth") {
        verb = low[1] || "";
        return { kind: ["list", "login", "revoke", "application-default", "configure-docker"].includes(verb) ? "read" : "mutate", verb };
      }
      verb = idx >= 0 ? low[idx] : low[low.length - 1] || "";
      if (/^(?:list|describe|get-[\w-]+|read|ls|cat|du|tail|logs|search|print-settings|test-iam-permissions|analyze-iam-policy|info|version|help|explain|wait|versions)$/.test(verb) || (verb === "access" && false)) kind = "read";
      else if (DESTRUCTIVE_WORDS.test(verb)) kind = "destructive";
      else if (verb === "rm") kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "gsutil": {
      verb = low[0] || "";
      if (/^(?:ls|cat|du|stat|hash|version|help|signurl|ver)$/.test(verb)) kind = "read";
      else if (verb === "cp" || verb === "rsync") {
        const dest = low[low.length - 1] || "";
        kind = dest.startsWith("gs://") ? "mutate" : "read";
        if (verb === "rsync" && toks.includes("-d")) kind = "destructive";
      } else if (/^(?:rm|rb)$/.test(verb)) kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "bq": {
      verb = low[0] || "";
      if (/^(?:ls|show|head|query|version|help|wait|get-iam-policy)$/.test(verb)) kind = "read";
      else if (verb === "rm") kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "kubectl":
    case "oc": {
      verb = low[0] || "";
      if (verb === "config") {
        const sub = low[1] || "";
        kind = ["view", "get-contexts", "current-context", "get-clusters", "get-users", "use-context", "use"].includes(sub) ? "read" : "mutate";
        break;
      }
      if (verb === "rollout") {
        const sub = low[1] || "";
        kind = ["status", "history"].includes(sub) ? "read" : sub === "undo" ? "destructive" : "mutate";
        break;
      }
      if (verb === "auth") return { kind: "read", verb: "auth" };
      if (/^(?:get|describe|logs|top|explain|api-resources|api-versions|version|cluster-info|diff|events|wait|whoami|plugin|completion|kustomize|help)$/.test(verb)) kind = "read";
      else if (/^(?:delete|drain|cordon|taint|replace)$/.test(verb)) kind = "destructive";
      else if (verb === "apply" && toks.includes("--dry-run=server")) kind = "read";
      else if (verb === "apply" && toks.some((t) => t.startsWith("--dry-run"))) kind = "read";
      else kind = "mutate";
      break;
    }
    case "helm": {
      verb = low[0] || "";
      if (verb === "repo" || verb === "plugin" || verb === "registry" || verb === "dependency" || verb === "dep") return { kind: "read", verb };
      if (/^(?:list|ls|status|history|get|template|lint|show|inspect|search|diff|version|env|help|verify|pull|fetch|package|create|completion)$/.test(verb)) kind = "read";
      else if (/^(?:install|upgrade)$/.test(verb) && toks.includes("--dry-run")) kind = "read";
      else if (/^(?:uninstall|delete|del|rollback)$/.test(verb)) kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "terraform":
    case "tofu":
    case "terragrunt": {
      let p = low.filter((t) => !/^-chdir=/.test(t));
      if (cli === "terragrunt" && (p[0] === "run-all" || p[0] === "run")) p = p.slice(1);
      verb = p[0] || "";
      if (verb === "state") {
        const sub = p[1] || "";
        kind = ["list", "show", "pull"].includes(sub) ? "read" : sub === "rm" ? "destructive" : "mutate";
        verb = `state ${sub}`;
        break;
      }
      if (verb === "workspace") {
        const sub = p[1] || "";
        kind = ["list", "show", "select"].includes(sub) ? "read" : sub === "delete" ? "destructive" : "mutate";
        break;
      }
      if (/^(?:init|validate|fmt|plan|show|output|providers|graph|version|console|get|login|logout|metadata|modules|test|hclfmt|render-json|output-module-groups|validate-inputs|graph-dependencies|info|find|list|hcl)$/.test(verb)) kind = "read";
      else if (verb === "destroy") kind = "destructive";
      else kind = "mutate"; // apply, import, taint, untaint, refresh, force-unlock
      break;
    }
    case "pulumi": {
      verb = low[0] || "";
      if (verb === "stack" && ["ls", "select", "output", "history", "graph", "export", "tag", undefined].includes(low[1])) return { kind: "read", verb: "stack" };
      if (verb === "config" && (!low[1] || low[1] === "get")) return { kind: "read", verb: "config" };
      if (/^(?:preview|whoami|version|about|logs|login|logout|plugin|help|new|convert|schema)$/.test(verb)) kind = "read";
      else if (verb === "destroy" || (verb === "stack" && low[1] === "rm")) kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "cdk":
    case "cdktf": {
      verb = low[0] || "";
      if (/^(?:synth|synthesize|diff|ls|list|doctor|docs|version|context|notices|init|acknowledge|get|metadata|help)$/.test(verb)) kind = "read";
      else if (verb === "destroy") kind = "destructive";
      else kind = "mutate"; // deploy, bootstrap, import, watch, migrate
      break;
    }
    case "eksctl": {
      verb = low[0] || "";
      if (/^(?:get|info|version|help|utils|completion)$/.test(verb)) kind = "read";
      else if (/^(?:delete|drain)$/.test(verb)) kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "sam": {
      verb = low[0] || "";
      if (/^(?:build|validate|local|logs|list|init|package|traces|pipeline|remote)$/.test(verb) && verb !== "remote") kind = "read";
      else if (verb === "delete") kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "azd": {
      verb = low[0] || "";
      if (/^(?:show|env|config|auth|version|template|init|package|monitor|restore|hooks|help|login)$/.test(verb) && !(verb === "env" && ["set", "new"].includes(low[1]))) kind = "read";
      else if (verb === "down") kind = "destructive";
      else kind = "mutate"; // up, provision, deploy
      break;
    }
    case "func": {
      verb = low[0] || "";
      kind = verb === "azure" ? (low.includes("publish") ? "mutate" : "read") : "read";
      break;
    }
    case "serverless":
    case "sls": {
      verb = low[0] || "";
      if (/^(?:print|info|logs|invoke|package|help|plugin|metrics)$/.test(verb) && !low.includes("local") === false) kind = "read";
      else if (/^(?:print|info|logs|package|help|metrics)$/.test(verb)) kind = "read";
      else if (verb === "remove") kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "copilot": {
      // AWS Copilot CLI (ECS). GitHub's `copilot` CLI is not a cloud CLI; treat
      // it as read unless an AWS Copilot sub-command is used.
      verb = low[0] || "";
      if (!["app", "env", "svc", "job", "pipeline", "deploy", "init", "storage", "run", "task"].includes(verb)) return { kind: "read", verb };
      const sub = low[1] || "";
      if (["ls", "show", "status", "logs", "package"].includes(sub)) kind = "read";
      else if (sub === "delete") kind = "destructive";
      else kind = "mutate";
      break;
    }
    case "redis-cli": {
      verb = low[0] || "";
      if (!verb) return { kind: "unknown", verb: "session" };
      if (/^(?:get|mget|exists|ttl|pttl|type|strlen|hget|hgetall|hmget|hkeys|hvals|hlen|hexists|lrange|llen|lindex|smembers|scard|sismember|srandmember|zrange|zrangebyscore|zscore|zcard|zcount|zrank|scan|hscan|sscan|zscan|keys|info|ping|dbsize|memory|slowlog|xlen|xrange|xrevrange|xinfo|pubsub|object|dump|lastsave|time|echo|role|latency|cluster|--bigkeys|--memkeys|--stat|--latency)$/.test(verb)) kind = "read";
      else if (verb === "config" || verb === "client" || verb === "acl") kind = ["get", "list", "info", "whoami", "users", "cat", "getname"].includes(low[1]) ? "read" : "mutate";
      else if (/^(?:del|unlink|flushall|flushdb|hdel|srem|zrem|zremrangebyscore|zremrangebyrank|lrem|ltrim|xdel|xtrim|getdel|spop|lpop|rpop|blpop|brpop|rename|renamenx|shutdown|swapdb)$/.test(verb)) kind = "destructive";
      else kind = "mutate";
      break;
    }
    default:
      if (DB_CLIS.has(cli)) return classifyDb(cli, toks);
      kind = "unknown";
  }
  return { kind, verb };
}

const SQL_FLAGS = ["-c", "--command", "-e", "--execute", "-q", "--query", "--eval", "-x"];
export function sqlOf(toks) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    for (const f of SQL_FLAGS) {
      if (t === f) return toks.slice(i + 1).join(" ");
      if (f.startsWith("--") && t.startsWith(f + "=")) return [t.slice(f.length + 1), ...toks.slice(i + 1)].join(" ");
    }
  }
  return null;
}

export function classifySql(sql) {
  const q = ` ${sql.toLowerCase()} `;
  if (/\b(?:drop|truncate|delete|deletemany|deleteone|remove|findoneanddelete|dropindex|dropindexes)\b/.test(q)) return "destructive";
  if (/\b(?:insert|update|upsert|merge|create|alter|grant|revoke|rename|comment\s+on|copy\b[^;]*\bfrom|call|exec|execute|vacuum|reindex|cluster|refresh|lock|set\s+global|set\s+persist|insertone|insertmany|updateone|updatemany|replaceone|bulkwrite|createindex|createcollection|findoneandupdate|findoneandreplace|kill|shutdown)\b/.test(q)) return "mutate";
  if (/\bselect\b[^;]*\binto\b(?![^;]*\bfrom\b[^;]*\binto\b)/.test(q) && !/\binto\s+@/.test(q)) return "mutate";
  if (/\b(?:select|show|explain|describe|desc|with|values|table|pragma|find|findone|countdocuments|estimateddocumentcount|aggregate|distinct|getcollectionnames|getindexes|stats|serverstatus|version|ismaster|hello|ping|listdatabases|listcollections|use)\b|\\[a-z?]/.test(q)) {
    if (/\$(?:out|merge)\b/.test(q)) return "mutate";
    return "read";
  }
  return "unknown";
}

function classifyDb(cli, toks) {
  const sql = sqlOf(toks);
  if (sql) return { kind: classifySql(sql), verb: (sql.trim().split(/\s+/)[0] || "sql").slice(0, 24) };
  if (toks.some((t) => /^(?:-f|--file|-i|--input-file|@\S+|<)$/.test(t) || /^--file=/.test(t) || /\.(?:sql|js)$/.test(t))) return { kind: "mutate", verb: "script" };
  if (toks.some((t) => /^(?:--version|-v|--help|-\?|-l|--list)$/.test(t))) return { kind: "read", verb: "info" };
  return { kind: "unknown", verb: "session" };
}

// ────────────────────────────────────────────────────────────────────────────
// Environment (tier) detection
// ────────────────────────────────────────────────────────────────────────────

function readJsonLoose(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function activeAzureSubscription() {
  const dir = process.env.AZURE_CONFIG_DIR || path.join(os.homedir(), ".azure");
  const prof = readJsonLoose(path.join(dir, "azureProfile.json"));
  const sub = prof?.subscriptions?.find((s) => s.isDefault);
  return sub ? [sub.id, sub.name] : [];
}

function activeGcloudProject() {
  const base = process.env.CLOUDSDK_CONFIG || (process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "gcloud") : path.join(os.homedir(), ".config", "gcloud"));
  try {
    const active = (process.env.CLOUDSDK_ACTIVE_CONFIG_NAME || fs.readFileSync(path.join(base, "active_config"), "utf8")).trim() || "default";
    const ini = fs.readFileSync(path.join(base, "configurations", `config_${active}`), "utf8");
    const m = ini.match(/^\s*project\s*=\s*(\S+)/m);
    return m ? [m[1], active] : [active];
  } catch {
    return [];
  }
}

function activeKubeContext() {
  const file = (process.env.KUBECONFIG || path.join(os.homedir(), ".kube", "config")).split(path.delimiter)[0];
  try {
    // Read only the current-context line; never parse or keep credentials.
    const txt = fs.readFileSync(file, "utf8");
    const m = txt.match(/^current-context:\s*["']?([^"'\r\n]+)/m);
    return m ? [m[1].trim()] : [];
  } catch {
    return [];
  }
}

function terraformContext(cwd, toks) {
  const ids = [];
  const chdir = toks.find((t) => t.startsWith("-chdir="));
  const dir = chdir ? path.resolve(cwd, chdir.slice(7)) : cwd;
  ids.push(...dir.split(/[\\/]/).slice(-3));
  if (process.env.TF_WORKSPACE) ids.push(process.env.TF_WORKSPACE);
  try {
    ids.push(fs.readFileSync(path.join(dir, ".terraform", "environment"), "utf8").trim());
  } catch {}
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith("-var-file=")) ids.push(path.basename(t.slice(10)));
    if (t === "-var-file" && toks[i + 1]) ids.push(path.basename(toks[i + 1]));
    if (t.startsWith("--terragrunt-working-dir") || t.startsWith("--working-dir")) ids.push(...(t.split("=")[1] || toks[i + 1] || "").split(/[\\/]/));
  }
  return ids.filter(Boolean);
}

function inlineEnv(segment, name) {
  const m = segment.match(new RegExp(String.raw`(?:^|\s)(?:\$env:)?${name}\s*=\s*([^\s;]+)`, "i"));
  return m ? m[1] : null;
}

export function targetIdentifiers(cli, toks, segment, ctx) {
  const ids = [];
  const env = ctx.env || process.env;
  const detect = ctx.policy.detectActiveContext;
  const push = (v) => v && ids.push(String(v));
  switch (cli) {
    case "aws":
    case "sam":
    case "cdk":
    case "eksctl":
    case "copilot":
      push(flagValue(toks, ["--profile"]));
      push(inlineEnv(segment, "aws_profile"));
      if (!ids.length) push(env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE);
      push(env.AWS_ACCOUNT_ID);
      break;
    case "az":
    case "azd":
    case "func":
      push(flagValue(toks, ["--subscription"]));
      push(inlineEnv(segment, "azure_subscription_id"));
      if (!ids.length) push(env.AZURE_SUBSCRIPTION_ID || env.ARM_SUBSCRIPTION_ID);
      if (!ids.length && detect) ids.push(...activeAzureSubscription());
      push(flagValue(toks, ["--resource-group", "-g"]));
      break;
    case "gcloud":
    case "gsutil":
    case "bq":
      push(flagValue(toks, ["--project", "--project_id"]));
      push(inlineEnv(segment, "cloudsdk_core_project"));
      if (!ids.length) push(env.CLOUDSDK_CORE_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT);
      if (!ids.length && detect) ids.push(...activeGcloudProject());
      // bucket names often encode the environment
      for (const t of toks) if (/^gs:\/\//.test(t)) push(t.slice(5).split("/")[0]);
      break;
    case "kubectl":
    case "oc":
    case "helm":
      push(flagValue(toks, ["--context", "--kube-context"]));
      if (!ids.length && detect) ids.push(...activeKubeContext());
      push(flagValue(toks, ["-n", "--namespace"]));
      break;
    case "terraform":
    case "tofu":
    case "terragrunt":
    case "cdktf":
      ids.push(...terraformContext(ctx.cwd, toks));
      break;
    case "pulumi":
      push(flagValue(toks, ["-s", "--stack"]));
      push(env.PULUMI_STACK);
      break;
    case "psql":
    case "mysql":
    case "mariadb":
    case "sqlcmd":
    case "sqlplus":
    case "cqlsh":
    case "mongosh":
    case "mongo":
    case "redis-cli": {
      push(flagValue(toks, ["-h", "--host", "-s", "--server", "--hostname"]));
      push(flagValue(toks, ["-d", "--dbname", "-d", "--database", "-n"]));
      for (const t of toks) {
        const uri = t.match(/^[a-z+]+:\/\/(?:[^@/\s]+@)?([^/:?\s,]+)[^/\s]*(?:\/([^?\s]+))?/);
        if (uri) { push(uri[1]); push(uri[2]); }
        const kv = t.match(/^(?:host|hostname|server|dbname|database|data\s?source)=(.+)$/);
        if (kv) push(kv[1]);
        const tns = cli === "sqlplus" && t.match(/@([\w.-]+)/);
        if (tns) push(tns[1]);
      }
      push(env.PGHOST || env.MYSQL_HOST || env.REDISCLI_HOST);
      push(env.PGDATABASE);
      if (!ids.length) push("localhost");
      break;
    }
  }
  if (cli === "aws") for (const t of toks) if (/^s3:\/\//.test(t)) push(t.slice(5).split("/")[0]);
  return ids;
}

export function tierOf(ids, policy) {
  if (!ids.length) return { tier: "unknown", by: null };
  const lists = policy.environments || {};
  // Explicit lists win, most sensitive first.
  for (const tier of ["prod", "nonprod", "sandbox"]) {
    const list = (lists[tier] || []).map((s) => String(s).toLowerCase());
    for (const id of ids) if (list.includes(String(id).toLowerCase())) return { tier, by: id };
  }
  const tokensOf = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tier of ["prod", "nonprod", "sandbox"]) {
    const pats = new Set((policy.tierPatterns[tier] || []).map((s) => s.toLowerCase()));
    for (const id of ids) {
      const toks = tokensOf(id);
      // Single-letter tokens ("p") only count at the start or end of an
      // identifier, e.g. "app-p" or "p-core", never in the middle.
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (!pats.has(t)) continue;
        if (t.length <= 2 && i !== 0 && i !== toks.length - 1) continue;
        return { tier, by: id };
      }
    }
  }
  return { tier: "unknown", by: null };
}

function regionsIn(toks) {
  const v = flagValue(toks, ["--region", "--location", "-l", "--zone"]);
  return v ? [v] : [];
}

// ────────────────────────────────────────────────────────────────────────────
// Evaluation
// ────────────────────────────────────────────────────────────────────────────

function applyOverride(rule, policy) {
  const o = policy.overrides?.[rule.id];
  if (!o) return rule.level;
  const level = typeof o === "string" ? o : o.level;
  if (!["allow", "ask", "deny"].includes(level)) return rule.level;
  // Weakening a rule requires a written justification in the policy file.
  if (RANK[level] < RANK[rule.level] && !(typeof o === "object" && o.justification && String(o.justification).length >= 20)) return rule.level;
  return level;
}

function customRules(policy) {
  return (policy.customRules || [])
    .map((c) => {
      try {
        return { ...c, re: new RegExp(c.re, "i"), level: c.level === "deny" ? "deny" : c.level === "allow" ? "allow" : "ask" };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function evaluateCommand(command, ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const policy = ctx.policy || loadPolicy(findProjectRoot(cwd));
  const c = { ...ctx, cwd, policy };
  const norm = normalise(command);
  let result = { decision: "allow", rule: null, reason: "Read-only or non-cloud command.", fix: null, tier: null };

  if (policy.__error) result = worst(result, { decision: "ask", rule: "POLICY-ERROR", reason: policy.__error, fix: "Ask a human to fix .cloud-guard/policy.json." });

  // 1. Hard rules (and organisation custom rules) on the whole command and on
  //    each segment, so a rule cannot be dodged by chaining.
  const pieces = [norm, ...segments(command)];
  const rules = [...customRules(policy), ...HARD_RULES];
  const customAllow = new Set();
  for (const rule of rules) {
    for (const piece of pieces) {
      if (!rule.re.test(piece)) continue;
      const level = rule.level === "allow" ? "allow" : applyOverride(rule, policy);
      if (rule.level === "allow") {
        customAllow.add(piece);
        break;
      }
      if (level === "allow") break;
      result = worst(result, { decision: level, rule: rule.id, reason: rule.reason, fix: rule.fix || null });
      break;
    }
  }
  if (result.decision === "deny") return finish(result, command, c);

  // 2. Classify each cloud CLI invocation and apply the environment matrix.
  for (const seg of segments(command)) {
    if (customAllow.has(seg)) continue;
    CLI_RE.lastIndex = 0;
    let m;
    while ((m = CLI_RE.exec(seg))) {
      const cli = m[1];
      const toks = tokensAfter(seg, m.index + m[0].length);
      const { kind, verb } = classifyInvocation(cli, toks);
      if (kind === "read") continue;
      const ids = targetIdentifiers(cli, toks, seg, c);
      let { tier, by } = tierOf(ids, policy);
      if (tier === "unknown") tier = policy.unknownEnvironmentAs === "prod" ? "prod" : "unknown";
      const pos = positionals(cli, toks);
      const label =
        cli === "aws" ? `aws ${pos.slice(0, 2).join(" ")}`
        : cli === "az" ? `az ${pos.join(" ")}`
        : cli === "gcloud" ? `gcloud ${pos.slice(0, Math.max(1, pos.indexOf(verb) + 1)).join(" ")}`
        : DB_CLIS.has(cli) ? `${cli} ${verb}`.trim()
        : `${cli} ${verb || ""}`.trim();
      const where = by ? ` (target "${by}" is ${tier})` : tier === "unknown" ? " (target environment could not be determined)" : ` (${tier})`;

      let decision;
      if (policy.mode === "readonly") decision = "deny";
      else if (tier === "prod") decision = policy.prodMutations === "ask" ? "ask" : "deny";
      else if (tier === "sandbox" && policy.mode === "standard" && kind === "mutate") decision = "allow";
      else decision = "ask";

      // Region allow-list
      const regions = regionsIn(toks);
      if (policy.allowedRegions?.length && regions.some((rg) => !policy.allowedRegions.map((x) => x.toLowerCase()).includes(rg.toLowerCase()))) {
        result = worst(result, { decision: "deny", rule: "REGION-NOT-ALLOWED", reason: `Region ${regions.join(", ")} is not in allowedRegions (${policy.allowedRegions.join(", ")}).`, fix: "Use an approved region or ask the platform owner to extend allowedRegions.", tier });
        continue;
      }

      const reason =
        decision === "deny"
          ? policy.mode === "readonly"
            ? `Guard is in readonly mode; "${label}" changes infrastructure.`
            : `"${label}" is a ${kind} operation against production${where}. Agents do not change production directly.`
          : `"${label}" is a ${kind} operation${where}.`;
      const fix =
        decision === "deny"
          ? "Write the change as IaC and open a pull request, or produce a runbook for a human / the deployment pipeline to execute."
          : "Show the human the exact command, target account/subscription/project, expected effect and rollback before running it.";
      result = worst(result, { decision, rule: `ENV-${kind.toUpperCase()}`, reason, fix, tier });
    }
  }
  return finish(result, command, c);
}

export function evaluateFileAccess({ filePath, content, op }, ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const policy = ctx.policy || loadPolicy(findProjectRoot(cwd));
  const fp = String(filePath || "");
  let result = { decision: "allow", rule: null, reason: "File access allowed.", fix: null };
  const isExample = /(?:\.example|\.sample|\.template|\.dist)$|(?:^|[\\/])(?:examples?|fixtures?|testdata)[\\/]/i.test(fp);

  for (const p of PROTECTED_PATHS) {
    if (p.re.test(fp) && !(p.id === "PATH-KEYS" && /\.pub$/.test(fp) && op === "read")) {
      // Public keys and *.example files may be read.
      if (isExample && op === "read") continue;
      result = worst(result, { decision: "deny", rule: p.id, reason: `${p.reason} Agents may not ${op} ${path.basename(fp)}.`, fix: "Reference the credential by name / ARN / resource id instead of opening it." });
    }
  }
  if (op !== "read" && GUARD_PATHS.test(fp)) {
    result = worst(result, { decision: "deny", rule: "GUARD-TAMPER", reason: "The guard policy and agent hook settings can only be changed by a human.", fix: "Describe the change you need and ask the human to make it." });
  }
  if (op !== "read" && policy.secretWriteGuard && content && !isExample) {
    for (const s of SECRET_CONTENT) {
      if (s.re.test(String(content))) {
        result = worst(result, { decision: "deny", rule: s.id, reason: `Content contains what looks like a secret (${s.reason}). Secrets never go into files an agent writes.`, fix: "Reference a secret manager (AWS Secrets Manager / SSM, Azure Key Vault, GCP Secret Manager) or an environment variable injected at runtime." });
        break;
      }
    }
  }
  return finish(result, `${op} ${fp}`, { ...ctx, cwd, policy });
}

function redact(s) {
  let out = String(s);
  for (const r of SECRET_CONTENT) out = out.replace(new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g"), "[REDACTED]");
  return out.slice(0, 2000);
}

function finish(result, subject, ctx) {
  const policy = ctx.policy;
  if (policy?.audit && result.decision !== "allow" && !ctx.noAudit) {
    try {
      const dir = path.join(policy.__root, ".cloud-guard");
      if (fs.existsSync(dir)) {
        fs.appendFileSync(
          path.join(dir, "audit.jsonl"),
          JSON.stringify({ ts: new Date().toISOString(), agent: ctx.agent || "cli", decision: result.decision, rule: result.rule, tier: result.tier || null, subject: redact(subject) }) + "\n",
        );
      }
    } catch {}
  }
  // Lightweight counters for `report`: one line per check, no command text.
  if (policy && policy.stats !== false && !ctx.noAudit) {
    try {
      const dir = path.join(policy.__root, ".cloud-guard");
      if (fs.existsSync(dir)) {
        const f = path.join(dir, "stats.jsonl");
        try {
          if (fs.statSync(f).size > 5_000_000) fs.renameSync(f, f + ".1");
        } catch {}
        const kind = /^(?:read|write) /.test(String(subject)) ? "file" : (String(subject).match(CLI_RE_ONE) || [])[1] || "shell";
        fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), agent: ctx.agent || "cli", d: result.decision, rule: result.rule || null, tier: result.tier || null, kind }) + "\n");
      }
    } catch {}
  }
  return result;
}
const CLI_RE_ONE = new RegExp(String.raw`(?:^|[\s(=;&|])(?:[\w./\\-]*[\\/])?(aws|az|gcloud|gsutil|bq|kubectl|helm|terraform|tofu|terragrunt|pulumi|cdk|git|gh|psql|mysql|sqlcmd|sqlplus|mongosh|redis-cli|npm|pnpm|yarn|mvn|gradle|dotnet|docker|python|pip|uv|go)(?=\s|$)`, "i");

// ────────────────────────────────────────────────────────────────────────────
// Hook adapters
// ────────────────────────────────────────────────────────────────────────────

function message(r) {
  const head = r.decision === "deny" ? "cloud-guard BLOCKED" : "cloud-guard needs human approval";
  return `${head} [${r.rule}]: ${r.reason}${r.fix ? ` Safer path: ${r.fix}` : ""}`;
}

const SHELL_TOOLS = new Set(["bash", "shell", "run_shell_command", "powershell", "terminal", "run_terminal_cmd", "execute_command"]);
const READ_TOOLS = new Set(["read", "read_file", "read_many_files", "view", "notebookread"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "write_file", "replace", "create_file", "str_replace", "apply_patch"]);

export function evaluateHookPayload(payload, format, cwdHint) {
  const cwd = payload.cwd || cwdHint || process.env.CLAUDE_PROJECT_DIR || payload.workspace_roots?.[0] || process.cwd();
  const root = findProjectRoot(process.env.CLAUDE_PROJECT_DIR || payload.workspace_roots?.[0] || cwd);
  const policy = loadPolicy(root);
  const ctx = { cwd, policy, agent: format };

  // Cursor sends the command / file at top level.
  if (format === "cursor") {
    if (typeof payload.command === "string") return evaluateCommand(payload.command, ctx);
    if (payload.file_path) return evaluateFileAccess({ filePath: payload.file_path, content: null, op: "read" }, ctx);
    return { decision: "allow" };
  }

  const tool = String(payload.tool_name || "").toLowerCase();
  const input = payload.tool_input || {};
  if (SHELL_TOOLS.has(tool) || typeof input.command === "string") return evaluateCommand(input.command || "", ctx);
  if (READ_TOOLS.has(tool)) {
    const fp = input.file_path || input.absolute_path || input.path || "";
    if (Array.isArray(input.paths)) return input.paths.map((p) => evaluateFileAccess({ filePath: p, op: "read" }, ctx)).reduce(worst, { decision: "allow" });
    return evaluateFileAccess({ filePath: fp, op: "read" }, ctx);
  }
  if (WRITE_TOOLS.has(tool)) {
    const fp = input.file_path || input.absolute_path || input.path || "";
    const content = [input.content, input.new_string, input.new_str, ...(Array.isArray(input.edits) ? input.edits.map((e) => e.new_string) : []), input.patch, input.input].filter(Boolean).join("\n");
    return evaluateFileAccess({ filePath: fp, content, op: "write" }, ctx);
  }
  return { decision: "allow" };
}

export function renderHookResponse(r, format, policy) {
  switch (format) {
    case "claude":
      // Allow → no output, so Claude Code's normal permission rules still apply.
      if (r.decision === "allow") return { stdout: "", code: 0 };
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: r.decision, permissionDecisionReason: message(r) } }),
        code: 0,
      };
    case "cursor":
      if (r.decision === "allow") return { stdout: JSON.stringify({ permission: "allow" }), code: 0 };
      return { stdout: JSON.stringify({ permission: r.decision, user_message: message(r), agent_message: message(r) }), code: 0 };
    case "gemini": {
      let d = r.decision;
      if (d === "ask") d = (policy?.geminiAskAs || "deny") === "allow" ? "allow" : "deny";
      if (d === "allow") return { stdout: JSON.stringify({ decision: "allow" }), code: 0 };
      return { stdout: JSON.stringify({ decision: "deny", reason: message(r) + (r.decision === "ask" ? " (Gemini hooks cannot ask: show the command to the human and let them run it.)" : "") }), code: 0 };
    }
    default:
      return { stdout: JSON.stringify(r, null, 2), code: RANK[r.decision] };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Secret scanner (CLI `scan`) used by the validator and as a pre-commit hook
// ────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".terraform", "dist", "build", ".venv", "venv", "__pycache__", "cdk.out", ".next"]);
export function scanPath(target) {
  const findings = [];
  const walk = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p))) return;
      for (const f of fs.readdirSync(p)) walk(path.join(p, f));
      return;
    }
    if (st.size > 2_000_000) return;
    let txt;
    try {
      txt = fs.readFileSync(p, "utf8");
    } catch {
      return;
    }
    if (txt.includes("\u0000")) return;
    for (const s of SECRET_CONTENT) {
      const m = txt.match(s.re);
      if (m) {
        const line = txt.slice(0, m.index).split("\n").length;
        findings.push({ file: p, line, rule: s.id, reason: s.reason });
      }
    }
  };
  walk(target);
  return findings;
}

// ────────────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────────────

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv) {
  const fmtIdx = argv.indexOf("--format");
  const format = fmtIdx >= 0 ? argv[fmtIdx + 1] : null;

  if (argv[0] === "check") {
    const dd = argv.indexOf("--");
    const cmd = (dd >= 0 ? argv.slice(dd + 1) : argv.slice(1)).join(" ");
    const r = evaluateCommand(cmd, { noAudit: true });
    const out = renderHookResponse(r, "generic");
    process.stdout.write(out.stdout + "\n");
    process.exit(out.code);
  }
  if (argv[0] === "scan") {
    const targets = argv.slice(1).filter((a) => !a.startsWith("--"));
    const findings = (targets.length ? targets : ["."]).flatMap(scanPath);
    for (const f of findings) process.stdout.write(`${f.file}:${f.line}  ${f.rule}  ${f.reason}\n`);
    process.stdout.write(findings.length ? `\n${findings.length} potential secret(s) found.\n` : "No secrets found.\n");
    process.exit(findings.length ? 2 : 0);
  }
  if (argv[0] === "explain") {
    const p = loadPolicy(findProjectRoot(process.cwd()));
    const { __root, __file, ...rest } = p;
    process.stdout.write(JSON.stringify({ version: VERSION, policyFile: __file, policy: rest, hardRules: HARD_RULES.map((r) => ({ id: r.id, level: r.level, reason: r.reason })) }, null, 2) + "\n");
    return;
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    process.stdout.write(VERSION + "\n");
    return;
  }

  // Hook mode
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    // Unparseable input: fail towards asking a human, never towards allowing.
    const out = renderHookResponse({ decision: "ask", rule: "GUARD-INPUT", reason: "cloud-guard could not parse the hook input.", fix: null }, format || "generic");
    process.stdout.write(out.stdout);
    process.exit(out.code);
  }
  const fmt = format || (payload.hook_event_name === "beforeShellExecution" || payload.cursor_version ? "cursor" : payload.hook_event_name === "BeforeTool" ? "gemini" : "claude");
  let r;
  try {
    r = evaluateHookPayload(payload, fmt);
  } catch (e) {
    r = { decision: "ask", rule: "GUARD-ERROR", reason: `cloud-guard internal error: ${e.message}`, fix: null };
  }
  const policy = loadPolicy(findProjectRoot(process.env.CLAUDE_PROJECT_DIR || payload.workspace_roots?.[0] || payload.cwd || process.cwd()));
  const out = renderHookResponse(r, fmt, policy);
  if (out.stdout) process.stdout.write(out.stdout);
  process.exit(out.code);
}

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1] || "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));

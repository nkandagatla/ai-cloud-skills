#!/usr/bin/env node
// Writes SAMPLE guard/token-saver data into <dir>/.cloud-guard so `report` can be demoed.
// The numbers are synthetic and clearly marked; never mix them with real data.
import fs from "node:fs";
import path from "node:path";
const dir = path.resolve(process.argv[2] || "demo-repo");
const g = path.join(dir, ".cloud-guard");
fs.mkdirSync(path.join(g, "token-saver"), { recursive: true });
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const now = Date.now();
const stats = [], audit = [], saver = [];
const denies = [["GIT-FORCE-PROTECTED", null, "git"], ["SECRET-CRED-FILE-READ", null, "shell"], ["PATH-DOTENV", null, "file"], ["AWS-S3-PUBLIC", null, "aws"], ["DB-UNBOUNDED-WRITE", null, "psql"], ["ENV-MUTATE", "prod", "aws"], ["ENV-MUTATE", "prod", "kubectl"], ["IAC-UNREVIEWED-APPLY", null, "terraform"], ["AZ-SECRET-READ", null, "az"], ["GIT-ADD-SECRET", null, "git"], ["AWS-NET-OPEN-ADMIN", null, "aws"], ["DB-PASSWORD-LITERAL", null, "psql"]];
const asks = [["ENV-MUTATE", "nonprod", "aws"], ["GIT-DISCARD-WORK", null, "git"], ["ENV-DESTRUCTIVE", "nonprod", "kubectl"], ["PKG-PUBLISH", null, "npm"], ["DB-DESTRUCTIVE-DDL", null, "psql"], ["GIT-FORCE-PUSH", null, "git"]];
const kinds = ["git", "git", "git", "npm", "file", "file", "file", "shell", "aws", "kubectl", "terraform", "psql", "python", "mvn", "az", "gcloud"];
const cmds = [["npm test", 42000], ["./mvnw -B test", 65000], ["pytest -q", 30000], ["npm install", 25000], ["kubectl logs", 38000], ["terraform plan", 22000], ["docker build", 28000], ["go test", 18000]];
for (let day = 29; day >= 0; day--) {
  const weekend = new Date(now - day * 864e5).getUTCDay() % 6 === 0;
  const n = weekend ? 40 : 260 + Math.floor(rnd() * 140);
  for (let i = 0; i < n; i++) {
    const ts = new Date(now - day * 864e5 - Math.floor(rnd() * 8 * 3600e3)).toISOString();
    const agent = pick(["claude", "claude", "claude", "cursor", "gemini"]);
    const x = rnd();
    if (x < 0.012) { const [rule, tier, kind] = pick(denies); stats.push({ ts, agent, d: "deny", rule, tier, kind }); audit.push({ ts, agent, decision: "deny", rule, tier, subject: "[sample]" }); }
    else if (x < 0.05) { const [rule, tier, kind] = pick(asks); stats.push({ ts, agent, d: "ask", rule, tier, kind }); audit.push({ ts, agent, decision: "ask", rule, tier, subject: "[sample]" }); }
    else stats.push({ ts, agent, d: "allow", rule: null, tier: null, kind: pick(kinds) });
  }
  const m = weekend ? 2 : 14 + Math.floor(rnd() * 10);
  for (let i = 0; i < m; i++) { const [cmd, size] = pick(cmds); const before = Math.floor(size * (0.6 + rnd())); saver.push({ ts: new Date(now - day * 864e5 - Math.floor(rnd() * 8 * 3600e3)).toISOString(), cmd, before, after: 2600 + Math.floor(rnd() * 1800) }); }
}
fs.writeFileSync(path.join(g, "SAMPLE"), "Synthetic data from scripts/demo-data.mjs. Delete this folder before real use.\n");
const w = (f, rows) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
w(path.join(g, "stats.jsonl"), stats); w(path.join(g, "audit.jsonl"), audit); w(path.join(g, "token-saver", "stats.jsonl"), saver);
console.log(`SAMPLE data written to ${g} (${stats.length} checks, ${saver.length} trimmed outputs).`);

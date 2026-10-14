---
name: shell-scripting
description: Company standard for Bash and PowerShell scripts - strict mode, quoting, argument parsing, dry-run flags, idempotency, error handling and traps, logging, portability (Linux/macOS/Windows), ShellCheck and PSScriptAnalyzer, safe file operations, secrets handling, and when to switch to Python. Use when writing, reviewing or debugging shell scripts, CI steps, Makefiles or PowerShell automation.
---

# Shell Scripting (Bash and PowerShell)

Load `engineering-guardrails` and `code-fundamentals` first. If a script grows beyond ~150 lines, needs data structures, JSON manipulation beyond `jq` one-liners, or real error recovery, write it in Python instead.

## 1. Bash template

```bash
#!/usr/bin/env bash
# purpose: rotate application logs older than N days in a target directory
set -Eeuo pipefail
IFS=$'\n\t'
trap 'echo "error: line $LINENO: $BASH_COMMAND" >&2' ERR

usage() { echo "usage: $0 --dir DIR [--days N] [--dry-run]" >&2; exit 2; }
DIR="" DAYS=14 DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="${2:?}"; shift 2 ;;
    --days) DAYS="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
[[ -n "$DIR" && -d "$DIR" ]] || { echo "dir not found: $DIR" >&2; exit 1; }
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "days must be a number" >&2; exit 1; }

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
run() { if (( DRY_RUN )); then log "DRY-RUN: $*"; else "$@"; fi; }

while IFS= read -r -d '' f; do
  run rm -- "$f"
done < <(find "$DIR" -type f -name '*.log' -mtime +"$DAYS" -print0)
log "done"
```

Rules:

- `set -Eeuo pipefail`; quote every expansion (`"$var"`, `"${arr[@]}"`); use `[[ ]]` and `(( ))`.
- `--` before file arguments (`rm -- "$f"`); never `rm -rf "$DIR/"` where `DIR` might be empty (use `${DIR:?}`); no `rm -rf /`-style broad paths (guard-blocked).
- `--dry-run` for any script that changes or deletes things; print what would happen.
- Idempotent: safe to run twice (`mkdir -p`, check-before-create, `ln -sfn`).
- `mktemp` for temp files + `trap 'rm -f "$tmp"' EXIT`.
- Use `printf` over `echo` for data; `read -r`; handle filenames with spaces/newlines (`-print0`, `-d ''`).
- `command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }` for dependencies.
- Exit codes: 0 success, 1 failure, 2 usage error.
- Secrets: read from env or a secret manager CLI at runtime; never echo them, never pass them as arguments (visible in `ps`), disable tracing around them (`set +x`).
- Portability: GNU vs BSD differences (`sed -i`, `date`, `readlink -f`); target Bash 4+ or POSIX `sh` explicitly.
- Lint: `shellcheck -S warning script.sh`; format: `shfmt -i 2 -ci -w`.

## 2. PowerShell template

```powershell
#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][ValidateScript({ Test-Path $_ -PathType Container })][string]$Dir,
  [ValidateRange(1, 3650)][int]$Days = 14
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Get-ChildItem -LiteralPath $Dir -Filter *.log -File |
  Where-Object LastWriteTime -lt (Get-Date).AddDays(-$Days) |
  ForEach-Object {
    if ($PSCmdlet.ShouldProcess($_.FullName, 'Remove')) { Remove-Item -LiteralPath $_.FullName }
  }
```

- `SupportsShouldProcess` gives `-WhatIf` / `-Confirm` for free: always use it for changes.
- `$ErrorActionPreference = 'Stop'`, `Set-StrictMode`, `try/catch/finally`.
- `-LiteralPath` for user-supplied paths; parameter validation attributes.
- Secrets: `Get-Secret` (SecretManagement module) or platform identity; never plain-text passwords in scripts or `ConvertTo-SecureString -AsPlainText` with literals.
- Lint: `Invoke-ScriptAnalyzer -Path . -Recurse -Severity Warning`.
- Do not use `Invoke-Expression` with input, `-EncodedCommand`, or download-and-execute (`iwr | iex`) (guard-blocked/asked).

## 3. CI steps and Makefiles

- Keep CI shell steps short; move logic to versioned scripts with tests (`bats-core` for Bash, Pester for PowerShell).
- `make` targets as the stable interface (`make test`, `make lint`); `.PHONY`; fail on errors (`SHELL := bash` + `.SHELLFLAGS := -eu -o pipefail -c`).

## 4. Token-friendly commands for agents

Prefer narrow, quiet commands: `rg -n --max-count 20 pattern path/`, `head -n 50`, `wc -l`, `ls -1 | head`, `find . -name '*.tf' -not -path '*/.terraform/*' | head -50`. Avoid `cat` on large files and `find /` scans. The `token-saver` hook trims large outputs automatically and keeps the full log on disk.

## Definition of done

Follow `code-fundamentals`. For scripts:

```bash
shfmt -d . && shellcheck scripts/*.sh
bats test/                                   # one test file per script with logic
```

- PowerShell: `Invoke-ScriptAnalyzer -Path . -Recurse -Severity Warning,Error` and Pester tests (`Invoke-Pester -CI`).
- Test argument parsing, the dry-run path and failure exits (non-zero code and a clear message on stderr).
- Error handling is in the templates above: `set -Eeuo pipefail`, `trap` for cleanup, explicit `if ! cmd; then` for expected failures; PowerShell `$ErrorActionPreference = 'Stop'` with `try/catch/finally`.

## Never

- `curl | sh`, `iwr | iex`, `eval` of external input, `-EncodedCommand` (guard-blocked or asked).
- `sudo` in scripts without a documented reason, `chmod 777`, `rm -rf` on unvalidated variables or broad paths.
- Secrets in arguments, scripts, or command history; `set -x` around secrets.
- Unquoted variables or parsing `ls` output.
- Add logic without a unit test that covers its error path, skip or weaken a failing test to get green, or swallow errors (see `code-fundamentals`).

"""`acc` command line."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from importlib import resources
from pathlib import Path

from . import checks as checks_mod
from . import grading, ops
from .backends import BackendError, get_backend
from .checks import CheckError
from .config import ConfigError, home_relative
from .gate import format_result, run_claude_hook, run_omp_gate
from .git import GitError
from .grading import GradeError

EXIT = {"pass": 0, "warn": 1, "block": 2}
EXIT_ERROR = 3
MIN_HOOK_VERSION = (2, 1, 295)  # `args`, `if` and `onFailure` hook fields


def _err(msg: str) -> int:
    print(f"acc: {msg}", file=sys.stderr)
    return EXIT_ERROR


def _acc_path() -> str:
    found = shutil.which("acc")
    return str(Path(found).resolve()) if found else str(Path(sys.argv[0]).resolve())


# ── commands ─────────────────────────────────────────────────────────────────


def cmd_gate(a: argparse.Namespace) -> int:
    if a.agent == "claude":
        out = run_claude_hook(sys.stdin.read())
        if out:
            print(out)
        return 0
    if a.agent == "omp":
        if a.command is None:
            return _err("gate --agent omp needs --command (and --cwd)")
        print(run_omp_gate(a.command, a.cwd or os.getcwd()))
        return 0
    return _err(f"no gate for agent {a.agent!r}; use claude or omp")


def cmd_run(a: argparse.Namespace) -> int:
    root, cfg = ops.project(Path.cwd())
    res = ops.run(cfg, Path.cwd(), a.agent, a.check or None, a.range, a.include_proposed,
                  backend_name=a.backend)
    if a.json:
        print(json.dumps(res.to_dict(), indent=2, default=str))
    elif not res.commits:
        print(f"acc: no commits to review in {a.range}.")
    elif res.verdict == "pass":
        names = sorted({e.check_id for e in res.entries})
        print(f"acc: pass ({len(res.commits)} commits, checks: {', '.join(names) or 'none matched'}).")
    else:
        print(format_result(res))
    return EXIT[res.verdict]


def cmd_list(a: argparse.Namespace) -> int:
    _, cfg = ops.project(Path.cwd())
    rows = ops.list_checks(cfg, a.status)
    if a.json:
        print(json.dumps(rows, indent=2))
        return 0
    if not rows:
        print("No checks. Add TOML files under .acc/checks/ or run `acc init`.")
    for r in rows:
        if r.get("invalid"):
            print(f"{r['id']:<32} INVALID  {'; '.join(r['errors'])}")
            continue
        flag = "" if r["enabled"] else " (disabled)"
        print(f"{r['id']:<32} {r['status']:<9} {r['type']:<6} {r['scope']:<10} "
              f"{r['author']:<5} grade={r['grade']}{flag}")
    return 0


def cmd_validate(a: argparse.Namespace) -> int:
    if a.file:
        paths = [Path(a.file)]
    else:
        _, cfg = ops.project(Path.cwd())
        paths = sorted(cfg.checks_dir.glob("*.toml"))
    bad = 0
    for p in paths:
        try:
            checks_mod.load_file(p)
            print(f"ok       {p}")
        except CheckError as e:
            bad += 1
            print(f"invalid  {p}")
            for msg in e.errors:
                print(f"  - {msg}")
        except OSError as e:
            bad += 1
            print(f"invalid  {p}: {e}")
    return 2 if bad else 0


def cmd_grade(a: argparse.Namespace) -> int:
    root, cfg = ops.project(Path.cwd())
    check = ops.get_check(cfg, a.id)
    g = grading.grade(cfg, root, check, get_backend(cfg, a.agent, a.backend), a.sample,
                      commits=a.commits, rev_range=a.range)
    m = g.metrics
    sel = g.record["selection"]
    chosen = {"commits": "chosen commits", "range": f"range {sel.get('range')}"}.get(sel["mode"], "history")
    print(f"acc: grade for {a.id} on {chosen}: {g.result.upper()}")
    print(f"  sample {m['sample_size']} of {m['pool_size']} eligible, block rate {m['block_rate']:.0%} "
          f"({m['blocked']} blocked), errors {m['errors']}, unstable {m['unstable']}, calls {m['calls']}"
          + (f", catch rate {m['catch_rate']:.0%}" if m["catch_rate"] is not None else ""))
    for s in g.record["sample"]:
        if s["verdict"] in ("block", "warn") or s.get("error"):
            print(f"  {s['verdict']:<5} {s['sha'][:7]} ({s['reason']}): {s.get('error') or s['summary']}")
    for x in g.record["excluded"]:
        print(f"  skip  {x['sha'][:7]}: {x['reason']}")
    print(f"  wrote {g.path}")
    return 0 if g.result == "pass" else 1


def cmd_promote(a: argparse.Namespace) -> int:
    _, cfg = ops.project(Path.cwd())
    r = ops.promote(cfg, a.id, a.to, force=a.force)
    print(f"{r['path']}: {r['old_line'] or '(no status line)'} -> {r['new_line']}")
    return 0


def _snippets(acc: str) -> str:
    hook = {
        "hooks": {
            "PreToolUse": [{
                "matcher": "Bash",
                "hooks": [{
                    "type": "command",
                    "if": "Bash(git push*)",
                    "command": acc,
                    "args": ["gate", "--agent", "claude"],
                    "timeout": 180,
                    "statusMessage": "Running push checks",
                    "onFailure": "block",
                }],
            }]
        }
    }
    mcp = {"mcpServers": {"acc": {"command": acc, "args": ["mcp", "--agent", "claude"]}}}
    return (
        "Claude Code hook: merge into ~/.claude/settings.json (all projects) or\n"
        ".claude/settings.local.json (this project, not committed):\n\n"
        + json.dumps(hook, indent=2)
        + "\n\nMCP server: add to .mcp.json in the project root (or run\n"
        f"`claude mcp add --scope project acc -- {acc} mcp --agent claude`):\n\n"
        + json.dumps(mcp, indent=2)
        + "\n"
    )


def cmd_init(a: argparse.Namespace) -> int:
    root, _ = ops.project(Path.cwd())
    acc_dir = root / ".acc"
    tpl = resources.files("acc") / "templates"
    claude = shutil.which("claude")
    created = []
    (acc_dir / "checks").mkdir(parents=True, exist_ok=True)
    (acc_dir / "grades").mkdir(parents=True, exist_ok=True)
    keep = acc_dir / "grades" / ".gitkeep"
    if not keep.exists():
        keep.touch()
    cfg_path = acc_dir / "config.toml"
    if not cfg_path.exists():
        text = (tpl / "config.toml").read_text()
        # Keep the launcher path: resolving symlinks would pin a versioned binary that auto-update removes.
        # Write it relative to ~ so the committed config names no username.
        command = home_relative(str(Path(claude).absolute())) if claude else "claude"
        cfg_path.write_text(text.replace("__CLAUDE__", command))
        created.append(cfg_path)
    for name in ("no-debug-leftovers.toml", "commit-message-matches-diff.toml"):
        dest = acc_dir / "checks" / name
        if not dest.exists():
            dest.write_text((tpl / "checks" / name).read_text())
            created.append(dest)
    for p in created:
        print(f"created {p.relative_to(root)}")
    if not created:
        print(".acc/ already set up; nothing created.")
    if not claude:
        print("warning: `claude` not found on PATH; set backends.claude.command to its absolute path.")
    print()
    print(_snippets(_acc_path()))
    return 0


def _version_tuple(text: str) -> tuple[int, ...]:
    import re

    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text)
    return tuple(int(x) for x in m.groups()) if m else ()


def cmd_doctor(a: argparse.Namespace) -> int:
    ok = True

    def report(good: bool, msg: str, warn_only: bool = False) -> None:
        nonlocal ok
        tag = "ok  " if good else ("warn" if warn_only else "FAIL")
        if not good and not warn_only:
            ok = False
        print(f"[{tag}] {msg}")

    try:
        root, cfg = ops.project(Path.cwd())
    except (ops.OpError, ConfigError) as e:
        report(False, str(e))
        return 1
    report(cfg.acc_dir.is_dir(), f".acc/ directory in {root}" + ("" if cfg.acc_dir.is_dir() else " (run `acc init`)"))
    report(True, "config.toml parses")

    loaded, errors = checks_mod.load_all(cfg.checks_dir)
    report(not errors, f"{len(loaded)} valid check file(s)" + (f", invalid: {', '.join(errors)}" if errors else ""))

    name = cfg.backend_for(a.agent)
    report(True, f"agent {a.agent!r} uses backend {name!r}")
    if name == "claude":
        cmd = cfg.backend_settings("claude").get("command", "claude")
        report(os.path.isabs(cmd), f"backends.claude.command is absolute: {cmd}", warn_only=True)
        path = cmd if os.path.isabs(cmd) else shutil.which(cmd)
        exists = bool(path) and os.access(path, os.X_OK)
        report(exists, f"claude binary is executable: {path or cmd}")
        if exists:
            ver = subprocess.run([path, "--version"], capture_output=True, text=True).stdout.strip()
            v = _version_tuple(ver)
            report(bool(v) and v >= MIN_HOOK_VERSION,
                   f"Claude Code {ver or '?'}; hook `args`/`if`/`onFailure` need "
                   f"{'.'.join(map(str, MIN_HOOK_VERSION))}+", warn_only=True)

    if not a.offline:
        try:
            backend = get_backend(cfg, a.agent)
            schema = {"type": "object", "properties": {"checks": {"type": "object"}}, "required": ["checks"]}
            backend.ask("Reply with the requested JSON only.", 'Return {"checks": {}}.', "", schema,
                        float(cfg.run["timeout_seconds"]))
            report(True, f"test call to {backend.name} ({backend.model}) succeeded")
        except BackendError as e:
            report(False, f"test call failed: {e}")

    settings = [Path.home() / ".claude" / "settings.json", root / ".claude" / "settings.local.json",
                root / ".claude" / "settings.json"]
    hooked = [str(p) for p in settings if p.exists() and "gate" in p.read_text() and "acc" in p.read_text()]
    report(bool(hooked), "PreToolUse hook found in " + (", ".join(hooked) if hooked else
                                                        "no Claude Code settings file (see `acc init`)"),
           warn_only=True)
    return 0 if ok else 1


def cmd_mcp(a: argparse.Namespace) -> int:
    try:
        from .mcp_server import serve
    except ImportError:
        return _err("the MCP server needs the optional extra: install `agent-commit-checks[mcp]`")
    serve(a.agent)
    return 0


# ── parser ───────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="acc", description="Model-backed checks on commits before an agent pushes.")
    sub = p.add_subparsers(dest="cmd", required=True)

    def agent_arg(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--agent", default="claude", help="agent whose backend to use (default: claude)")

    sp = sub.add_parser("gate", help="decide on an agent's push (claude: hook JSON on stdin; omp: --command)")
    agent_arg(sp)
    sp.add_argument("--command", help="omp: the bash command about to run")
    sp.add_argument("--cwd", help="omp: the directory it runs in (default: current directory)")
    sp.set_defaults(fn=cmd_gate)

    sp = sub.add_parser("run", help="run checks on demand")
    agent_arg(sp)
    sp.add_argument("--check", action="append", help="check id (repeatable); default: non-proposed checks")
    sp.add_argument("--range", default="unpushed", help="'unpushed' (default) or a rev range like main..HEAD")
    sp.add_argument("--include-proposed", action="store_true")
    sp.add_argument("--backend", help="override the backend (e.g. fake)")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(fn=cmd_run)

    sp = sub.add_parser("grade", help="grade a check against prior commits")
    agent_arg(sp)
    sp.add_argument("id")
    sp.add_argument("--sample", type=int, help="target sample size (default from config)")
    sp.add_argument("--backend", help="override the backend")
    pick = sp.add_mutually_exclusive_group()
    pick.add_argument("--commits", nargs="+", metavar="REV", help="grade exactly these commits")
    pick.add_argument("--range", metavar="A..B", help="draw the sample from this range instead of history")
    sp.set_defaults(fn=cmd_grade)

    sp = sub.add_parser("list", help="list checks")
    sp.add_argument("--status", choices=checks_mod.STATUSES)
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(fn=cmd_list)

    sp = sub.add_parser("validate", help="schema-check one or all check files")
    sp.add_argument("file", nargs="?")
    sp.set_defaults(fn=cmd_validate)

    sp = sub.add_parser("promote", help="change a check's status")
    sp.add_argument("id")
    sp.add_argument("--to", choices=["advisory", "active"], default="active")
    sp.add_argument("--force", action="store_true", help="promote to active without a passing grade")
    sp.set_defaults(fn=cmd_promote)

    sp = sub.add_parser("init", help="create .acc/ and print setup snippets")
    sp.set_defaults(fn=cmd_init)

    sp = sub.add_parser("doctor", help="verify backend, auth, config and check files")
    agent_arg(sp)
    sp.add_argument("--offline", action="store_true", help="skip the test model call")
    sp.set_defaults(fn=cmd_doctor)

    sp = sub.add_parser("mcp", help="serve the MCP tools over stdio")
    agent_arg(sp)
    sp.set_defaults(fn=cmd_mcp)
    return p


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    try:
        return a.fn(a)
    except (ops.OpError, ConfigError, CheckError, BackendError, GitError, GradeError) as e:
        return _err(str(e))
    except KeyboardInterrupt:
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())

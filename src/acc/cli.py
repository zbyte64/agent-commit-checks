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
from . import grading, omp_setup, ops
from .backends import BackendError, get_backend
from .checks import CheckError
from .config import ConfigError, home_relative, load_config
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
        print(f"{r['id']:<32} {r['status']:<9} {r['type']:<6} {r['author']:<5} grade={r['grade']}{flag}")
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
                      commits=a.commits, ranges=a.range)
    m = g.metrics
    sel = g.record["selection"]
    chosen = {"commits": "chosen commits", "ranges": f"ranges {', '.join(sel.get('ranges', []))}"
              }.get(sel["mode"], "history")
    print(f"acc: grade for {a.id} on {chosen}: {g.result.upper()}")
    print(f"  sample {m['sample_size']} of {m['pool_size']} eligible ranges, block rate {m['block_rate']:.0%} "
          f"({m['blocked']} blocked, {m['low_confidence']} low-confidence blocks warned), errors {m['errors']}, "
          f"unstable {m['unstable']}, calls {m['calls']}"
          + (f", catch rate {m['catch_rate']:.0%}" if m["catch_rate"] is not None else ""))
    for s in g.record["sample"]:
        if s["verdict"] in ("block", "warn") or s.get("error"):
            print(f"  {s['verdict']:<5} {grading.short_range(s['range'])} ({s['reason']}): "
                  f"{s.get('error') or s['summary']}")
    for x in g.record["excluded"]:
        print(f"  skip  {grading.short_range(x['range'])}: {x['reason']}")
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
    omp = shutil.which("omp")
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
        def launcher(found: str | None, name: str) -> str:
            return home_relative(str(Path(found).absolute())) if found else name

        cfg_path.write_text(text.replace("__CLAUDE__", launcher(claude, "claude"))
                            .replace("__OMP__", launcher(omp, "omp")))
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
    if a.omp:
        return _init_omp(root)
    if not claude:
        print("warning: `claude` not found on PATH; set backends.claude.command to its absolute path.")
    print()
    print(_snippets(_acc_path()))
    print("For oh-my-pi, run `acc init --omp`.")
    return 0


def _init_omp(root: Path) -> int:
    acc = _acc_path()
    cfg = load_config(root)
    settings = cfg.backend_settings("omp")
    omp, model = settings["command"], settings["model"]
    if not (os.path.isabs(omp) or shutil.which(omp)):
        print("warning: `omp` not found on PATH; set backends.omp.command to its absolute path.")
    dest, status = omp_setup.install_extension(acc)
    print(f"{status} omp extension {dest} (calls {acc})")
    print()
    if model.startswith("@"):
        role = model[1:]
        roles = omp_setup.config_get(omp, "modelRoles", root)
        if isinstance(roles, dict) and roles.get(role):
            print(f"omp role {model} -> {roles[role]}")
        else:
            print(f"omp role {model} is not set. Add it to ~/.omp/agent/config.yml (or a project "
                  f".omp/config.yml), or pick it in omp's /model Roles view:\n\n"
                  f"modelRoles:\n  {role}: anthropic/claude-haiku-5-5\n")
    budget = omp_setup.gate_budget_ms(float(cfg.run["timeout_seconds"]))
    current = omp_setup.config_get(omp, "extensionHandlers.toolCallTimeoutMs", root)
    if not isinstance(current, (int, float)) or current < budget:
        print(f"omp stops tool_call handlers after {current or 30000} ms and then blocks the push. "
              f"Give the gate {budget} ms:\n\n  {omp} config set extensionHandlers.toolCallTimeoutMs {budget}\n")
    mcp = {"mcpServers": {"acc": {"command": acc, "args": ["mcp", "--agent", "omp"]}}}
    print("MCP server: add to .omp/mcp.json in the project root (or ~/.omp/agent/mcp.json for all "
          "projects):\n\n" + json.dumps(mcp, indent=2) + "\n")
    print("Restart omp to load the extension, then run `acc doctor --agent omp`.")
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

    def binary(backend: str) -> str | None:
        cmd = cfg.backend_settings(backend).get("command", backend)
        report(os.path.isabs(cmd), f"backends.{backend}.command is absolute: {cmd}", warn_only=True)
        path = cmd if os.path.isabs(cmd) else shutil.which(cmd)
        exists = bool(path) and os.access(path, os.X_OK)
        report(exists, f"{backend} binary is executable: {path or cmd}")
        return path if exists else None

    if name == "claude":
        path = binary("claude")
        if path:
            ver = subprocess.run([path, "--version"], capture_output=True, text=True).stdout.strip()
            v = _version_tuple(ver)
            report(bool(v) and v >= MIN_HOOK_VERSION,
                   f"Claude Code {ver or '?'}; hook `args`/`if`/`onFailure` need "
                   f"{'.'.join(map(str, MIN_HOOK_VERSION))}+", warn_only=True)
    elif name == "omp":
        path = binary("omp")
        model = cfg.backend_settings("omp")["model"]
        if path and model.startswith("@"):
            roles = omp_setup.config_get(path, "modelRoles", root)
            target = roles.get(model[1:]) if isinstance(roles, dict) else None
            report(bool(target), f"omp role {model} -> {target}" if target else
                   f"omp role {model} is not set: add modelRoles.{model[1:]} to ~/.omp/agent/config.yml "
                   "(see `acc init --omp`)", warn_only=True)

    if not a.offline:
        try:
            backend = get_backend(cfg, a.agent)
            schema = {"type": "object", "properties": {"checks": {"type": "object"}}, "required": ["checks"]}
            backend.ask("Reply with the requested JSON only.", 'Return {"checks": {}}.', "", schema,
                        float(cfg.run["timeout_seconds"]))
            report(True, f"test call to {backend.name} ({backend.model}) succeeded")
        except BackendError as e:
            report(False, f"test call failed: {e}")

    if a.agent == "claude":
        settings = [Path.home() / ".claude" / "settings.json", root / ".claude" / "settings.local.json",
                    root / ".claude" / "settings.json"]
        hooked = [str(p) for p in settings if p.exists() and "gate" in p.read_text() and "acc" in p.read_text()]
        report(bool(hooked), "PreToolUse hook found in " + (", ".join(hooked) if hooked else
                                                            "no Claude Code settings file (see `acc init`)"),
               warn_only=True)
    elif a.agent == "omp":
        _doctor_omp_extension(cfg, root, report)
    return 0 if ok else 1


def _doctor_omp_extension(cfg, root: Path, report) -> None:
    found = [p for p in omp_setup.extension_paths(root) if p.exists()]
    if not found:
        report(False, "omp extension not installed (run `acc init --omp`)", warn_only=True)
        return
    for p in found:
        acc = omp_setup.extension_acc_path(p.read_text())
        good = bool(acc) and os.path.isabs(acc) and os.access(acc, os.X_OK)
        # A broken acc path blocks every push, so this one is a failure.
        report(good, f"omp extension {p} calls an executable acc: {acc or 'no ACC path found'}")
    omp = cfg.backend_settings("omp")["command"]
    budget = omp_setup.gate_budget_ms(float(cfg.run["timeout_seconds"]))
    current = omp_setup.config_get(omp, "extensionHandlers.toolCallTimeoutMs", root)
    enough = isinstance(current, (int, float)) and current >= budget
    report(enough, f"omp extensionHandlers.toolCallTimeoutMs is {current}; the gate can need {budget}"
           + ("" if enough else f" (`omp config set extensionHandlers.toolCallTimeoutMs {budget}`)"),
           warn_only=True)


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
    pick.add_argument("--commits", nargs="+", metavar="REV", help="grade each of these commits on its own")
    pick.add_argument("--range", action="append", metavar="A..B",
                      help="grade this range as one unit, like a push of its commits (repeatable)")
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
    sp.add_argument("--omp", action="store_true",
                    help="set up omp instead of Claude Code: install the extension in "
                         "~/.omp/agent/extensions and print the omp setup")
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

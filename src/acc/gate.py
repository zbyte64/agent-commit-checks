"""`acc gate`: decide on an agent's push command and emit the agent's hook format."""

from __future__ import annotations

import json
import traceback
from dataclasses import dataclass
from pathlib import Path

from . import checks as checks_mod
from . import git as g
from . import log
from .backends import get_backend
from .config import ConfigError, is_enabled, load_config
from .gitcmd import parse_command
from .pushrange import resolve_fallback, resolve_push
from .runner import RunResult, review

FIX_HINT = ("Fix these with a new commit, or by amending or rebasing the unpushed commits, "
            "then run the push again as its own command.")


@dataclass
class Decision:
    verdict: str  # pass | warn | block
    reason: str = ""  # agent-facing text for warn/block
    user_message: str = ""  # short line for the user


def _finding_text(f: dict) -> str:
    loc = f.get("file", "")
    if loc and f.get("line"):
        loc += f":{f['line']}"
    return f"{f['message']} ({loc})" if loc else f["message"]


def format_result(res: RunResult) -> str:
    """Agent-facing feedback: each check's answer about the pushed commits as a whole."""
    lines: list[str] = []
    if res.secret_blocked:
        lines.append("acc: push blocked by the local secret scan (no model was called).")
        for h in res.secret_hits:
            lines.append(f"- {g.short(h.commit or '')} {h.file}:{h.line}: possible {h.pattern}")
        lines.append("Remove the secret from every unpushed commit that adds it (amend or rebase; a new "
                     "commit that deletes it is not enough, because history still contains it), "
                     "then push again. Rotate the credential if it is real.")
        return "\n".join(lines)

    blocks = [e for e in res.entries if e.verdict == "block"]
    warns = [e for e in res.entries if e.verdict == "warn"]
    n = len(res.commits)
    reviewed = f"{n} commit{'s' if n != 1 else ''} reviewed together"
    if blocks:
        lines.append(f"acc: push blocked ({reviewed}).")
    elif warns:
        lines.append(f"acc: push allowed with warnings ({reviewed}).")

    def emit(e, label):
        head = f"- [{label}] {e.check_id}"
        if e.error:
            lines.append(f"{head}: check could not run ({e.error})")
            return
        lines.append(f"{head} (answer: {e.answer_text}): {e.summary}".rstrip(": "))
        for f in e.findings:
            lines.append(f"    {_finding_text(f)}")

    for e in blocks:
        emit(e, "block")
    for e in warns:
        emit(e, "warn" if e.raw_verdict == e.verdict else f"warn, {e.status} check")
    for note in res.notes:
        lines.append(f"Note: {note}")
    if blocks:
        lines.append(FIX_HINT)
    return "\n".join(lines)


def decide(command: str, cwd: Path, agent: str) -> Decision:
    parsed = parse_command(command)
    if parsed.kind == "none":
        return Decision("pass")
    if parsed.pushes and parsed.pushes[0].cwd:
        cwd = (cwd / parsed.pushes[0].cwd).resolve()
    try:
        root = g.repo_root(cwd)
    except g.GitError:
        return Decision("pass")  # not a git repo: nothing to review
    if not is_enabled(root):
        return Decision("pass")
    if parsed.kind == "commit_and_push":
        return Decision(
            "block",
            "acc: this command creates a commit and pushes in one step, so the new commit cannot be "
            "reviewed before the push. Run the commit first, then run `git push` as its own command.",
            "acc: asked the agent to push in a separate command",
        )

    cfg = load_config(root)
    if parsed.kind == "unknown":
        push = resolve_fallback(cwd, parsed.reason)
    else:
        push = resolve_push(cwd, parsed.pushes)
    if push.empty:
        return Decision("pass")

    all_checks, errors = checks_mod.load_all(cfg.checks_dir)
    gate_checks = [c for c in all_checks if c.runs_in_gate]
    backend = get_backend(cfg, agent)
    res = review(cfg, cwd, push, gate_checks, backend)
    if errors:
        res.notes.append(f"Invalid check files were skipped: {', '.join(sorted(errors))} (run `acc validate`).")

    log.write({
        "repo": root.name, "agent": agent, "backend": res.backend, "model": res.model,
        "command": command, "range": res.range, "commits": len(res.commits),
        "diff_sha256": res.diff_sha256, "diff_chars": res.diff_chars, "truncated": res.truncated,
        "calls": res.calls,
        "checks": [{"id": e.check_id, "answer": e.answer, "verdict": e.verdict,
                    **({"error": e.error} if e.error else {})} for e in res.entries],
        "secret_hits": len([h for h in res.secret_hits if h.severity == "block"]),
        "verdict": res.verdict, "latency_ms": res.latency_ms,
    })

    if res.verdict == "pass":
        return Decision("pass")
    text = format_result(res)
    counts = f"{sum(e.verdict == 'block' for e in res.entries)} blocking, " \
             f"{sum(e.verdict == 'warn' for e in res.entries)} warning"
    summary = "acc: push blocked" if res.verdict == "block" else "acc: push checks warned"
    if res.secret_blocked:
        counts = "secret scan"
    return Decision(res.verdict, text, f"{summary} ({counts})")


def claude_output(d: Decision) -> dict | None:
    """Claude Code PreToolUse hook JSON. `pass` prints nothing so the normal permission flow runs."""
    if d.verdict == "pass":
        return None
    if d.verdict == "warn":
        return {
            "systemMessage": d.user_message,
            "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": d.reason},
        }
    return {
        "systemMessage": d.user_message,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": d.reason,
        },
    }


def omp_output(d: Decision) -> dict:
    """`{verdict, reason, context, message}` for the omp extension: `reason` blocks the tool
    call, `context` is passed to the model beside the result, `message` is for the user."""
    out: dict = {"verdict": d.verdict}
    if d.verdict == "block":
        out["reason"] = d.reason
    elif d.verdict == "warn":
        out["context"] = d.reason
    if d.user_message:
        out["message"] = d.user_message
    return out


def safe_decide(command: str, cwd: Path, agent: str) -> Decision:
    """`decide`, but every failure becomes a block with the error as the reason."""
    try:
        return decide(command, cwd, agent)
    except ConfigError as e:
        return Decision("block", f"acc gate: invalid .acc/config.toml: {e}", "acc: gate failed")
    except Exception as e:  # noqa: BLE001 - the gate must answer, not crash
        detail = "".join(traceback.format_exception_only(type(e), e)).strip()
        return Decision("block", f"acc gate failed before reviewing the push: {detail}. "
                        "Report this to the user; do not try to bypass the check.",
                        "acc: gate error")


def run_claude_hook(stdin_text: str) -> str:
    """Entry point for `acc gate --agent claude`. Always returns hook JSON (or empty), never raises."""
    try:
        payload = json.loads(stdin_text)
    except json.JSONDecodeError as e:
        return json.dumps(claude_output(Decision("block", f"acc gate: invalid hook input: {e}",
                                                 "acc: gate failed")))
    if payload.get("tool_name") != "Bash":
        return ""
    command = (payload.get("tool_input") or {}).get("command") or ""
    cwd = Path(payload.get("cwd") or ".")
    out = claude_output(safe_decide(command, cwd, "claude"))
    return json.dumps(out) if out else ""


def run_omp_gate(command: str, cwd: str) -> str:
    """Entry point for `acc gate --agent omp`. Always returns the extension's JSON, never raises."""
    return json.dumps(omp_output(safe_decide(command, Path(cwd), "omp")))

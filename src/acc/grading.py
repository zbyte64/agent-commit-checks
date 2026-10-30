"""Grade a check against the project's own history before it may block pushes."""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import diffs
from . import git as g
from . import globs, prompt
from .backends import Backend
from .checks import Check
from .config import Config
from .runner import execute

RECORD_SEP = "\x1e"
FIELD_SEP = "\x1f"


@dataclass
class Unit:
    sha: str
    context: diffs.Context
    score: int = 0
    reason: str = ""  # top-score | random | expect_fail


@dataclass
class Grade:
    check_id: str
    result: str  # pass | fail | insufficient
    metrics: dict
    record: dict = field(default_factory=dict)
    path: Path | None = None


def default_branch(cwd: Path) -> str:
    out = g.git_ok(cwd, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    if out:
        return out.strip()
    for name in ("main", "master"):
        if g.rev_parse(cwd, f"refs/heads/{name}"):
            return f"refs/heads/{name}"
    return "HEAD"


def _history(cwd: Path, check: Check, branch: str, max_history: int) -> list[tuple[str, str, str]]:
    """(sha, message, diff) per unit: non-merge commits, or first-parent steps for range checks."""
    walk = ["--no-merges"] if check.scope == "per_commit" else ["--first-parent", "--diff-merges=first-parent"]
    out = g.git(cwd, "log", branch, "-n", str(max_history), *walk, "-p", "--no-color", "--no-ext-diff",
                "--find-renames", f"--format={RECORD_SEP}%H{FIELD_SEP}%B{FIELD_SEP}")
    units = []
    for rec in out.split(RECORD_SEP)[1:]:
        parts = rec.split(FIELD_SEP, 2)
        if len(parts) == 3:
            units.append((parts[0].strip(), parts[1].strip(), parts[2]))
    return units


def _added_lines(diff: str) -> str:
    return "\n".join(ln[1:] for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))


def _check_added_in(cwd: Path, check: Check) -> str | None:
    if check.path is None:
        return None
    rel = check.path.resolve().relative_to(g.repo_root(cwd).resolve())
    out = g.git_ok(cwd, "log", "--diff-filter=A", "--format=%H", "--", str(rel))
    return out.split()[-1] if out and out.split() else None


def select_sample(cfg: Config, cwd: Path, check: Check) -> tuple[list[Unit], int]:
    """Pick ~sample_size units relevant to the check. Returns (units, eligible pool size)."""
    gr = cfg.grading
    excludes = cfg.run["exclude_globs"]
    added_in = _check_added_in(cwd, check)
    expect_fail = {e.lower() for e in check.grading.get("expect_fail", [])}
    terms = check.grading.get("terms", [])

    pool: list[Unit] = []
    for sha, message, raw in _history(cwd, check, default_branch(cwd), gr["max_history"]):
        if sha == added_in or any(sha.startswith(e) for e in expect_fail):
            continue
        ctx = diffs.build_context(cwd, g.short(sha), raw, message, excludes, sha)
        if not ctx.diff.strip() or any(h.severity == "block" for h in ctx.secret_hits):
            continue
        matching = [f for f in ctx.files if globs.match_any(f, check.applies_to)]
        if not matching:
            continue
        text = _added_lines(ctx.diff) + "\n" + message
        score = len(matching) + 3 * sum(text.count(t) for t in terms)
        pool.append(Unit(sha, ctx, score))

    size = gr["sample_size"]
    if len(pool) <= size:
        chosen = pool
        for u in chosen:
            u.reason = "all"
    else:
        top_n = size // 2
        ranked = sorted(pool, key=lambda u: -u.score)  # stable: newest first among ties
        top = ranked[:top_n]
        for u in top:
            u.reason = "top-score"
        rest = ranked[top_n:]
        head = g.rev_parse(cwd, "HEAD") or ""
        rng = random.Random(f"{check.id}:{head}")
        rand = rng.sample(rest, size - top_n)
        for u in rand:
            u.reason = "random"
        chosen = top + rand

    for e in check.grading.get("expect_fail", []):
        sha = g.rev_parse(cwd, e)
        if not sha:
            continue
        ctx = diffs.commit_context(cwd, sha, excludes)
        chosen.append(Unit(sha, ctx, reason="expect_fail"))
    return chosen, len(pool)


def grade(cfg: Config, cwd: Path, check: Check, backend: Backend, sample_size: int | None = None) -> Grade:
    if sample_size:
        cfg.grading["sample_size"] = sample_size
    gr = cfg.grading
    units, pool_size = select_sample(cfg, cwd, check)
    # Grade the check as if active so would-be blocks are visible.
    graded = Check(**{**check.__dict__, "status": "active"})

    entries = [prompt.Entry(f"{check.id}@{u.context.label}", graded, u.context) for u in units]
    results, calls = execute(entries, backend, cfg)
    by_key = {r.key: r for r in results}

    rerun_entries = [e for e in entries if by_key[e.key].verdict in ("warn", "block") and not by_key[e.key].error]
    rerun, rcalls = execute(rerun_entries, backend, cfg)
    calls += rcalls
    rerun_by_key = {r.key: r for r in rerun}

    history = [u for u in units if u.reason != "expect_fail"]
    known = [u for u in units if u.reason == "expect_fail"]
    n = len(history)

    def key(u: Unit) -> str:
        return f"{check.id}@{u.context.label}"

    blocked = [u for u in history if by_key[key(u)].verdict == "block"]
    errored = [u for u in units if by_key[key(u)].error]
    unstable = [u for u in units if key(u) in rerun_by_key
                and rerun_by_key[key(u)].verdict != by_key[key(u)].verdict]
    caught = [u for u in known if by_key[key(u)].verdict == "block"]

    metrics = {
        "sample_size": n,
        "pool_size": pool_size,
        "block_rate": round(len(blocked) / n, 3) if n else 0.0,
        "blocked": len(blocked),
        "error_rate": round(len(errored) / len(units), 3) if units else 0.0,
        "errors": len(errored),
        "unstable": len(unstable),
        "catch_rate": round(len(caught) / len(known), 3) if known else None,
        "calls": calls,
    }
    if n < gr["min_sample"]:
        result = "insufficient"
    elif (metrics["block_rate"] <= gr["max_block_rate"] and not errored
          and len(unstable) <= gr["max_unstable"] and (not known or len(caught) == len(known))):
        result = "pass"
    else:
        result = "fail"

    record = {
        "check_id": check.id,
        "check_sha256": check.content_hash,
        "graded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "head": g.rev_parse(cwd, "HEAD"),
        "backend": backend.name,
        "model": backend.model,
        "bars": {k: gr[k] for k in ("min_sample", "max_block_rate", "max_unstable", "sample_size")},
        "metrics": metrics,
        "result": result,
        "sample": [
            {
                "sha": u.sha,
                "reason": u.reason,
                "score": u.score,
                "answer": by_key[key(u)].answer,
                "verdict": by_key[key(u)].verdict,
                "rerun_verdict": rerun_by_key[key(u)].verdict if key(u) in rerun_by_key else None,
                "summary": by_key[key(u)].summary,
                "findings": by_key[key(u)].findings,
                **({"error": by_key[key(u)].error} if by_key[key(u)].error else {}),
            }
            for u in units
        ],
    }
    path = cfg.grades_dir / f"{check.id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2) + "\n")
    return Grade(check.id, result, metrics, record, path)


def load_grade(cfg: Config, check_id: str) -> dict | None:
    path = cfg.grades_dir / f"{check_id}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def grade_status(cfg: Config, check: Check) -> str:
    """none | pass | fail | insufficient | stale (graded, but the check changed since)."""
    rec = load_grade(cfg, check.id)
    if rec is None:
        return "none"
    if rec.get("check_sha256") != check.content_hash:
        return "stale"
    return rec.get("result", "none")


def clear_grade(cfg: Config, check_id: str) -> None:
    (cfg.grades_dir / f"{check_id}.json").unlink(missing_ok=True)

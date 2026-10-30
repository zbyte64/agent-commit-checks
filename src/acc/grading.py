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
from .pushrange import resolve_rev_range
from .runner import execute

RECORD_SEP = "\x1e"
FIELD_SEP = "\x1f"


@dataclass
class Unit:
    """One graded range of commits, reviewed as a whole like a push."""

    base: str  # sha, or the empty tree for a root commit
    tip: str
    commits: list[str]  # oldest first
    context: diffs.Context
    score: int = 0
    reason: str = ""  # top-score | random | all | selected | expect_fail

    @property
    def range(self) -> str:
        return f"{self.base}..{self.tip}"


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


class GradeError(ValueError):
    pass


def _label(base: str, tip: str) -> str:
    return f"{g.short(base)}..{g.short(tip)}"


def short_range(rng: str) -> str:
    """`<sha>..<sha>` with both ends shortened, for display."""
    return _label(*rng.split("..", 1))


# A candidate unit before filtering: (base, tip, commits, raw diff, messages).
Candidate = tuple[str, str, list[str], str, str]


def _history(cwd: Path, branch: str, max_history: int) -> list[Candidate]:
    """One single-step range per first-parent commit of `branch`, newest first.

    A merge's step carries the diff it brought in against its first parent.
    """
    out = g.git(cwd, "log", branch, "-n", str(max_history), "--first-parent", "--diff-merges=first-parent",
                "-p", "--no-color", "--no-ext-diff", "--find-renames",
                f"--format={RECORD_SEP}%H{FIELD_SEP}%P{FIELD_SEP}%B{FIELD_SEP}")
    units = []
    for rec in out.split(RECORD_SEP)[1:]:
        parts = rec.split(FIELD_SEP, 3)
        if len(parts) == 4:
            sha, parents = parts[0].strip(), parts[1].split()
            base = parents[0] if parents else g.EMPTY_TREE
            units.append((base, sha, [sha], parts[3], f"{g.short(sha)}: {parts[2].strip()}"))
    return units


def _added_lines(diff: str) -> str:
    return "\n".join(ln[1:] for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))


def _check_added_in(cwd: Path, check: Check) -> str | None:
    if check.path is None:
        return None
    rel = check.path.resolve().relative_to(g.repo_root(cwd).resolve())
    out = g.git_ok(cwd, "log", "--diff-filter=A", "--format=%H", "--", str(rel))
    return out.split()[-1] if out and out.split() else None


def _commit_candidate(cwd: Path, rev: str) -> Candidate:
    """A single commit as a one-commit range."""
    sha = g.rev_parse(cwd, rev)
    if not sha:
        raise GradeError(f"unknown commit {rev!r}")
    base = g.first_parent(cwd, sha)
    return base, sha, [sha], diffs.raw_diff(cwd, base, sha), diffs.range_messages(cwd, [sha])


def _range_candidate(cwd: Path, rev_range: str) -> Candidate:
    """`A..B` as one unit: the diff from merge-base(A, B) to B, with every commit's message."""
    if ".." not in rev_range:
        raise GradeError(f"range must look like A..B, got {rev_range!r}")
    try:
        push = resolve_rev_range(cwd, rev_range)
    except g.GitError as e:
        raise GradeError(str(e)) from e
    if not push.refs:
        tip = g.rev_parse(cwd, rev_range.split("..", 1)[1] or "HEAD") or ""
        return tip, tip, [], "", ""
    ref = push.refs[0]
    return (ref.base, ref.tip, push.commits, diffs.raw_diff(cwd, ref.base, ref.tip),
            diffs.range_messages(cwd, push.commits))


def _candidate(cwd: Path, rev: str) -> Candidate:
    return _range_candidate(cwd, rev) if ".." in rev else _commit_candidate(cwd, rev)


def select_sample(cfg: Config, cwd: Path, check: Check, commits: list[str] | None = None,
                  ranges: list[str] | None = None) -> tuple[list[Unit], int, list[dict]]:
    """Pick the ranges to grade the check on.

    By default, ~sample_size single-commit steps relevant to the check are sampled from the
    default branch's first-parent history. `commits` grades each listed commit as a
    one-commit range; `ranges` grades each `A..B` as one unit, like a push of those commits.
    Returns (units, eligible pool size, excluded [{range, commits, reason}] for explicit selections).
    """
    if commits and ranges:
        raise GradeError("pass either commits or ranges, not both")
    gr = cfg.grading
    excludes = cfg.run["exclude_globs"]
    added_in = _check_added_in(cwd, check)
    expect_fail = list(check.grading.get("expect_fail", []))
    known_bad = {e.lower() for e in expect_fail if ".." not in e}
    terms = check.grading.get("terms", [])

    if commits:
        candidates = [_commit_candidate(cwd, c) for c in commits]
    elif ranges:
        candidates = [_range_candidate(cwd, r) for r in ranges]
    else:
        candidates = _history(cwd, default_branch(cwd), gr["max_history"])

    pool: list[Unit] = []
    excluded: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for base, tip, shas, raw, messages in candidates:
        if (base, tip) in seen:
            continue
        seen.add((base, tip))
        ctx = diffs.build_context(cwd, _label(base, tip), raw, messages, excludes,
                                  shas[0] if len(shas) == 1 else None)
        matching = [f for f in ctx.files if globs.match_any(f, check.applies_to)]
        if not shas:
            reason = "no commits in range"
        elif any(s.startswith(e) for s in shas for e in known_bad):
            reason = "holds an expect_fail commit (graded separately)"
        elif added_in in shas:
            reason = "holds the commit that added the check file"
        elif not ctx.diff.strip():
            reason = "empty diff after excludes"
        elif any(h.severity == "block" for h in ctx.secret_hits):
            reason = "secret scan hit (never sent to a model)"
        elif not matching:
            reason = "no changed path matches applies_to"
        else:
            reason = ""
        if reason:
            excluded.append({"range": f"{base}..{tip}", "commits": shas, "reason": reason})
            continue
        text = _added_lines(ctx.diff) + "\n" + messages
        score = len(matching) + 3 * sum(text.count(t) for t in terms)
        pool.append(Unit(base, tip, shas, ctx, score))

    size = gr["sample_size"]
    if commits or ranges:
        chosen = pool
        for u in chosen:
            u.reason = "selected"
    elif len(pool) <= size:
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

    for e in expect_fail:
        try:
            base, tip, shas, raw, messages = _candidate(cwd, e)
        except GradeError:
            continue
        if not shas or (base, tip) in {(u.base, u.tip) for u in chosen}:
            continue
        ctx = diffs.build_context(cwd, _label(base, tip), raw, messages, excludes)
        chosen.append(Unit(base, tip, shas, ctx, reason="expect_fail"))
    return chosen, len(pool), excluded if (commits or ranges) else []


def grade(cfg: Config, cwd: Path, check: Check, backend: Backend, sample_size: int | None = None,
          commits: list[str] | None = None, ranges: list[str] | None = None) -> Grade:
    if sample_size:
        cfg.grading["sample_size"] = sample_size
    gr = cfg.grading
    units, pool_size, excluded = select_sample(cfg, cwd, check, commits, ranges)
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
        "selection": selection_record(commits, ranges),
        "excluded": excluded,
        "bars": {k: gr[k] for k in ("min_sample", "max_block_rate", "max_unstable", "sample_size")},
        "metrics": metrics,
        "result": result,
        "sample": [
            {
                "range": u.range,
                "commits": u.commits,
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


def selection_record(commits: list[str] | None, ranges: list[str] | None) -> dict:
    if commits:
        return {"mode": "commits", "commits": list(commits)}
    if ranges:
        return {"mode": "ranges", "ranges": list(ranges)}
    return {"mode": "auto"}


def is_hand_picked(record: dict) -> bool:
    """Grades on chosen commits or ranges; older records without the field were automatic."""
    return record.get("selection", {}).get("mode", "auto") != "auto"


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

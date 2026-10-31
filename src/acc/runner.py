"""The review pipeline shared by `acc gate`, `acc run`, grading and the MCP server."""

from __future__ import annotations

import hashlib
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import diffs
from . import globs, prompt
from .backends import Backend, BackendError
from .checks import AnswerError, Check, describe_answer, validate_entry, worst
from .config import Config
from .pushrange import PushRange
from .secrets import SecretHit


@dataclass
class EntryResult:
    check_id: str
    key: str
    status: str  # check status at run time
    raw_verdict: str  # what the verdict table says
    verdict: str  # after advisory demotion and error handling
    answer: object = None
    answer_text: str = ""
    confidence: float | None = None
    low_confidence: bool = False  # a block below run.min_block_confidence, reported as a warning
    findings: list[dict] = field(default_factory=list)
    summary: str = ""
    error: str = ""
    truncated: bool = False


@dataclass
class RunResult:
    verdict: str = "pass"
    entries: list[EntryResult] = field(default_factory=list)
    secret_hits: list[SecretHit] = field(default_factory=list)
    secret_blocked: bool = False  # block-severity hits stopped the run before any model call
    notes: list[str] = field(default_factory=list)
    range: str = ""
    commits: list[str] = field(default_factory=list)
    calls: int = 0
    truncated: bool = False
    diff_sha256: str = ""
    diff_chars: int = 0
    skipped_files: list[str] = field(default_factory=list)
    checks_skipped: list[str] = field(default_factory=list)  # no matching paths
    backend: str = ""
    model: str = ""
    latency_ms: int = 0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["secret_hits"] = [asdict(h) for h in self.secret_hits]
        return d


def demote(check: Check, verdict: str) -> str:
    """Only `active` checks can block; others report a would-be block as a warning."""
    return "warn" if verdict == "block" and not check.can_block else verdict


def is_unsure(verdict: str, confidence: float, cfg: Config) -> bool:
    """A block the model is not confident about is reported as a warning instead."""
    return verdict == "block" and confidence < cfg.run["min_block_confidence"]


# ── executing entries ────────────────────────────────────────────────────────


def _batches(entries: list[prompt.Entry], size: int) -> list[list[prompt.Entry]]:
    """Group entries into calls of up to `size` checks, never mixing data blocks.

    Several ranges in one prompt make each answer depend on its neighbours: the same
    commit was judged differently depending on which commits shared the call. Checks
    about the same range still share a call.
    """
    by_block: dict[str, list[prompt.Entry]] = {}
    for e in sorted(entries, key=lambda e: (e.context.label, e.check.id)):
        by_block.setdefault(e.context.label, []).append(e)
    step = max(1, size)
    return [group[i: i + step] for group in by_block.values() for i in range(0, len(group), step)]


def _ask(backend: Backend, batch: list[prompt.Entry], cfg: Config) -> tuple[dict | None, str, bool, dict]:
    text, stdin, schema, truncated = prompt.build(batch, cfg.run["max_diff_chars"])
    timeout = float(cfg.run["timeout_seconds"])
    try:
        if hasattr(backend, "decide"):  # a classifier: it reads the checks, not the JSON prompt
            out = backend.decide(batch, stdin, timeout)
        else:
            out = backend.ask(prompt.SYSTEM, text, stdin, schema, timeout)
        return out.get("checks", {}), "", False, truncated
    except BackendError as e:
        return None, str(e), e.retryable, truncated


def execute(entries: list[prompt.Entry], backend: Backend, cfg: Config) -> tuple[list[EntryResult], int]:
    """Run entries in batched, parallel calls. Missing or invalid entries are retried alone once."""
    if not entries:
        return [], 0
    on_error = cfg.run["on_backend_error"]
    results: dict[str, EntryResult] = {}
    calls = 0

    def settle(e: prompt.Entry, raw: object, err: str, truncated: bool) -> EntryResult | None:
        c = e.check
        base = dict(check_id=c.id, key=e.key, status=c.status, truncated=truncated)
        if err:
            return EntryResult(raw_verdict=on_error, verdict=demote(c, on_error), error=err, **base)
        if raw is None:
            return None
        try:
            verdict, findings, summary, confidence = validate_entry(c, raw)
        except AnswerError as ex:
            return EntryResult(raw_verdict=on_error, verdict=demote(c, on_error),
                               error=f"invalid answer: {ex}", **base)
        answer = raw.get("answer")
        unsure = is_unsure(verdict, confidence, cfg)
        return EntryResult(raw_verdict=verdict, verdict=demote(c, "warn" if unsure else verdict),
                           answer=answer, answer_text=describe_answer(c, answer), confidence=confidence,
                           low_confidence=unsure, findings=findings, summary=summary, **base)

    def run_batch(batch: list[prompt.Entry]) -> tuple[list[EntryResult], list[prompt.Entry]]:
        answers, err, retryable, truncated = _ask(backend, batch, cfg)
        done, retry = [], []
        for e in batch:
            tr = truncated.get(e.context.label, False)
            if answers is None:
                if retryable:
                    retry.append(e)
                else:
                    done.append(settle(e, None, err, tr))
                continue
            r = settle(e, answers.get(e.key), "", tr)
            if r is None or r.error:
                retry.append(e)
            else:
                done.append(r)
        return done, retry

    def run_alone(e: prompt.Entry) -> EntryResult:
        answers, err, _, truncated = _ask(backend, [e], cfg)
        tr = truncated.get(e.context.label, False)
        if answers is None:
            return settle(e, None, err, tr)
        r = settle(e, answers.get(e.key), "", tr)
        return r or settle(e, None, "no answer for this check after retry", tr)

    batches = _batches(entries, cfg.run["max_checks_per_call"])
    with ThreadPoolExecutor(max_workers=max(1, cfg.run["parallel"])) as pool:
        retries: list[prompt.Entry] = []
        for done, retry in pool.map(run_batch, batches):
            calls += 1
            for r in done:
                results[r.key] = r
            retries.extend(retry)
        for r in pool.map(run_alone, retries):
            calls += 1
            results[r.key] = r
    return [results[e.key] for e in entries], calls


# ── the review pipeline ──────────────────────────────────────────────────────


def select_checks(checks: list[Check], ids: list[str] | None, gate: bool,
                  include_proposed: bool = False) -> list[Check]:
    if ids:
        by_id = {c.id: c for c in checks}
        missing = [i for i in ids if i not in by_id]
        if missing:
            raise KeyError(f"unknown check id(s): {', '.join(missing)}")
        return [by_id[i] for i in ids]
    if gate:
        return [c for c in checks if c.runs_in_gate]
    return [c for c in checks if c.enabled and (include_proposed or c.status != "proposed")]


def _matches(check: Check, files: list[str]) -> bool:
    return any(globs.match_any(f, check.applies_to) for f in files)


def review(cfg: Config, cwd: Path, push: PushRange, checks: list[Check], backend: Backend) -> RunResult:
    started = time.monotonic()
    res = RunResult(range=push.description, commits=list(push.commits),
                    backend=backend.name, model=backend.model)
    if push.note:
        res.notes.append(push.note)
    if push.empty:
        res.latency_ms = int((time.monotonic() - started) * 1000)
        return res

    excludes = cfg.run["exclude_globs"]
    scan = bool(cfg.run["secret_scan"])
    # Secrets are scanned per commit: one added and then removed is still in the pushed history.
    commit_ctx = {sha: diffs.commit_context(cwd, sha, excludes, scan) for sha in push.commits}
    range_ctx = diffs.range_context(cwd, [(r.name, r.base, r.tip) for r in push.refs], push.commits,
                                    excludes, scan)

    hits = [h for ctx in commit_ctx.values() for h in ctx.secret_hits if h.severity == "block"]
    if hits:
        res.secret_hits = hits
        res.secret_blocked = True
        res.verdict = "block"
        res.notes.append("The local secret scan found likely secrets; nothing was sent to a model.")
        res.latency_ms = int((time.monotonic() - started) * 1000)
        return res
    warn_hits = [h for ctx in commit_ctx.values() for h in ctx.secret_hits]
    if warn_hits:
        res.secret_hits = warn_hits
        res.notes.append("Lines matching a secret pattern were redacted before review.")

    res.diff_sha256 = hashlib.sha256(range_ctx.diff.encode()).hexdigest()
    res.diff_chars = len(range_ctx.diff)
    res.skipped_files = range_ctx.skipped

    # Each check sees the whole push at once: the combined diff and every commit message.
    entries: list[prompt.Entry] = []
    for c in checks:
        if _matches(c, range_ctx.files):
            entries.append(prompt.Entry(c.id, c, range_ctx))
        else:
            res.checks_skipped.append(c.id)

    res.entries, res.calls = execute(entries, backend, cfg)
    res.truncated = any(e.truncated for e in res.entries)
    if res.truncated:
        res.notes.append(f"Some diffs were truncated to {cfg.run['max_diff_chars']} characters.")
    res.verdict = worst([e.verdict for e in res.entries])
    res.latency_ms = int((time.monotonic() - started) * 1000)
    return res


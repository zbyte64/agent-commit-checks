"""Benchmark decision models on labeled cases built from this repo's own history.

Each case is one check on one commit from `--rev` (default HEAD), first parent only:

- commit-message-matches-diff: the commit as is (should pass), and its diff with the
  message of the commit 17 places further back (should be caught).
- src-changes-have-tests: a commit that changes src/ and tests/ as is (should pass), and
  its diff with the tests/ files removed (should be caught).
- no-debug-leftovers: a Python commit as is (should pass), and its diff with
  `print("DEBUG >>>", locals())  # TODO remove` added after the first added .py line
  (should be caught).

That is 26 real cases and 26 altered ones, each run as its own model call through the
same runner as the gate, plus one call with all three checks on one commit. "Caught"
means any verdict other than pass. The real commits were reviewed by hand when they
landed, but a check may still have a fair point about one of them.

usage (from the repo root, with the `tiny` extra for tiny):
  uv run python bench/decision_models.py KIND MODEL --rev 6befd26 --out bench/results/NAME.json
  KIND is claude (MODEL e.g. haiku), cpu or gpu (llama-server, MODEL a GGUF repo:quant),
  or tiny (MODEL is repo:file of an ONNX model).
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from acc import checks, prompt
from acc import git as g
from acc.config import load_config
from acc.diffs import Context, commit_context, split_files
from acc.runner import execute

ROOT = Path(__file__).resolve().parent.parent
CHECKS = ("commit-message-matches-diff", "no-debug-leftovers", "src-changes-have-tests")


def _ctx(base: Context, label: str, diff: str | None = None, message: str | None = None) -> Context:
    d = base.diff if diff is None else diff
    return Context(label=label, commit=None, diff=d, message=base.message if message is None else message,
                   files=[p for p, _ in split_files(d)])


def build_cases(cfg, rev: str) -> tuple[list[dict], Context]:
    """[{check, expect, label, commit, ctx}] and the context for the batched call."""
    shas = g.git(ROOT, "rev-list", "--first-parent", "--no-merges", rev, "--max-count", "60").split()
    ctxs = [commit_context(ROOT, s, cfg.run["exclude_globs"], scan=False) for s in shas]
    ctxs = [c for c in ctxs if c.diff and len(c.diff) < 30000]
    cases = []

    def add(check, expect, label, base, **alter):
        cases.append({"check": check, "expect": expect, "label": label, "commit": base.commit[:7],
                      "ctx": _ctx(base, label, **alter)})

    for i, c in enumerate(ctxs[:10]):
        add("commit-message-matches-diff", "pass", f"m{i}", c)
        add("commit-message-matches-diff", "fail", f"mx{i}", c, message=ctxs[(i + 17) % len(ctxs)].message)
    both = [c for c in ctxs if any(f.startswith("src/") and f.endswith(".py") for f in c.files)
            and any(f.startswith("tests/") for f in c.files)][:8]
    for i, c in enumerate(both):
        add("src-changes-have-tests", "pass", f"t{i}", c)
        add("src-changes-have-tests", "fail", f"tx{i}", c,
            diff="".join(ch for p, ch in split_files(c.diff) if not p.startswith("tests/")))
    for i, c in enumerate([c for c in ctxs if any(f.endswith(".py") for f in c.files)][:8]):
        add("no-debug-leftovers", "pass", f"d{i}", c)
        lines = c.diff.splitlines(keepends=True)
        at = next(k for k, ln in enumerate(lines) if ln.startswith("+") and not ln.startswith("+++")
                  and ".py" in "".join(lines[:k]))
        indent = lines[at][1:len(lines[at]) - len(lines[at][1:].lstrip())]
        lines.insert(at + 1, f'+{indent}print("DEBUG >>>", locals())  # TODO remove\n')
        add("no-debug-leftovers", "fail", f"dx{i}", c, diff="".join(lines))
    return cases, ctxs[0]


def machine() -> str:
    for line in Path("/proc/cpuinfo").read_text().splitlines() if Path("/proc/cpuinfo").exists() else []:
        if line.startswith("model name"):
            return line.split(":", 1)[1].strip()
    return platform.machine()


def make_backend(kind: str, model: str, port: int, server: str):
    if kind == "claude":
        from acc.backends.claude import ClaudeBackend

        return ClaudeBackend({"command": os.path.expanduser("~/.local/bin/claude"), "model": model})
    if kind == "tiny":
        from acc.backends.tiny import TinyBackend

        repo, file = model.split(":", 1)
        return TinyBackend({"model": repo, "file": file})
    from acc.backends.local import LocalBackend

    return LocalBackend({"url": f"http://127.0.0.1:{port}", "model": model, "device": kind,
                         "server": os.path.expanduser(server), "startup_seconds": 900})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["claude", "cpu", "gpu", "tiny"])
    ap.add_argument("model")
    ap.add_argument("--rev", default="HEAD")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--server", default="~/.local/bin/llama-server")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    cfg = load_config(ROOT)
    cfg.run["parallel"] = 1
    cfg.run["timeout_seconds"] = 120
    found = {c: checks.load_file(ROOT / f".acc/checks/{c}.toml") for c in CHECKS}
    cases, batch_ctx = build_cases(cfg, a.rev)
    backend = make_backend(a.kind, a.model, a.port, a.server)
    t0 = time.monotonic()
    if a.kind == "tiny":
        backend.load()
    elif a.kind in ("cpu", "gpu"):
        backend.ensure_server()
    startup = time.monotonic() - t0
    rows = []
    try:
        for case in cases:
            t = time.monotonic()
            [r], calls = execute([prompt.Entry(case["check"], found[case["check"]], case["ctx"])], backend, cfg)
            rows.append({k: case[k] for k in ("check", "expect", "label", "commit")}
                        | {"verdict": r.raw_verdict, "answer": r.answer, "confidence": r.confidence,
                           "error": r.error, "calls": calls, "seconds": round(time.monotonic() - t, 2),
                           "chars": len(case["ctx"].diff)})
            print(json.dumps(rows[-1]), flush=True)
        t = time.monotonic()
        res, calls = execute([prompt.Entry(k, v, batch_ctx) for k, v in found.items()], backend, cfg)
        batched = {"seconds": round(time.monotonic() - t, 2), "calls": calls,
                   "results": [(r.key, r.raw_verdict, r.error) for r in res]}
    finally:
        if a.kind in ("cpu", "gpu"):
            subprocess.run(["pkill", "-f", "--", f"llama-server.*--port {a.port}"])
    Path(a.out).write_text(json.dumps({
        "kind": a.kind, "model": a.model, "rev": g.git(ROOT, "rev-parse", "--short", a.rev).strip(),
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "machine": machine(),
        "startup_seconds": round(startup, 1), "rows": rows, "batched": batched}, indent=1) + "\n")


if __name__ == "__main__":
    main()

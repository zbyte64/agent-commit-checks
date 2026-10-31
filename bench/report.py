"""Summarise bench/results/*.json as markdown tables.

usage: uv run python bench/report.py [bench/results]
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

CHECKS = ("commit-message-matches-diff", "src-changes-have-tests", "no-debug-leftovers")
KIND_ORDER = {"claude": 0, "gpu": 1, "cpu": 2, "tiny": 3}


def caught(r: dict) -> bool:
    return r["verdict"] != "pass"


def score(rows: list[dict]) -> str:
    real = [r for r in rows if r["expect"] == "pass"]
    bad = [r for r in rows if r["expect"] == "fail"]
    return f"{sum(not caught(r) for r in real)}/{len(real)} · {sum(caught(r) for r in bad)}/{len(bad)}"


def confidence(rows: list[dict]) -> str:
    """Mean confidence of right and wrong verdicts: a useful confidence is lower when wrong."""
    def mean(xs):
        xs = [r["confidence"] for r in xs if r["confidence"] is not None]
        return f"{statistics.mean(xs):.2f}" if xs else "–"
    right = [r for r in rows if not r["error"] and caught(r) == (r["expect"] == "fail")]
    wrong = [r for r in rows if not r["error"] and r not in right]
    return f"{mean(right)} / {mean(wrong)}"


def main() -> None:
    results = [json.loads(p.read_text()) for p in sorted(Path(sys.argv[1] if len(sys.argv) > 1 else
                                                              Path(__file__).parent / "results").glob("*.json"))]
    results.sort(key=lambda d: (KIND_ORDER.get(d["kind"], 9), d["model"]))
    print("Real commits passed · altered commits caught (26 each, 52 calls per model).\n")
    print("| Kind | Model | All | Messages | Tests | Debug | Errors | Confidence right / wrong | "
          "Median s | Max s | Load s |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for d in results:
        rows = d["rows"]
        per = [score([r for r in rows if r["check"] == c]) for c in CHECKS]
        secs = [r["seconds"] for r in rows]
        print(f"| {d['kind']} | {d['model']} | {score(rows)} | {' | '.join(per)} | "
              f"{sum(bool(r['error']) for r in rows)} | {confidence(rows)} | {statistics.median(secs):.1f} | "
              f"{max(secs):.0f} | {d['startup_seconds']:.0f} |")
    revs = sorted({d["rev"] for d in results})
    machines = sorted({d["machine"] for d in results})
    print(f"\nCases from rev {', '.join(revs)}; run on {', '.join(machines)}.")


if __name__ == "__main__":
    main()

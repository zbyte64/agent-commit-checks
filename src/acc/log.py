"""JSONL decision log (shape after dev-decisions). Never stores diff text or secret matches."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def log_dir() -> Path:
    if override := os.environ.get("ACC_LOG_DIR"):
        return Path(override)
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(Path.home(), ".local", "share")
    return Path(base) / "acc" / "logs"


def write(row: dict) -> Path | None:
    now = datetime.now(timezone.utc)
    row = {"ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"), **row}
    path = log_dir() / now.strftime("%Y/%m/%d") / "events.jsonl"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as f:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
        return path
    except OSError as e:  # logging must never break the gate
        print(f"acc: could not write log: {e}", file=sys.stderr)
        return None

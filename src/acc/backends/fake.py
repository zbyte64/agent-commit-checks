"""Fake backend: canned answers from a JSON fixture, for tests without network or login.

The fixture maps a check key (`id@sha7`), a check id, or `*` to either an answer
object, the string "omit" (leave the entry out), "error" (fail the whole call), or
"retryable" (fail the call with a retryable error, e.g. invalid output). An answer
object without `confidence` is returned with confidence 1.
`ACC_FAKE_ANSWERS` overrides `[backends.fake] answers`.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from . import BackendError


class FakeBackend:
    name = "fake"
    model = "fake"

    def __init__(self, settings: dict, root: Path):
        path = os.environ.get("ACC_FAKE_ANSWERS") or settings.get("answers", "")
        self.answers: dict = {}
        if path:
            p = Path(path)
            self.answers = json.loads((p if p.is_absolute() else root / p).read_text())

    def ask(self, system: str, prompt: str, stdin: str, schema: dict, timeout: float) -> dict:
        out = {}
        for key in schema["properties"]["checks"]["required"]:
            check_id = key.split("@", 1)[0]
            ans = self.answers.get(key, self.answers.get(check_id, self.answers.get("*")))
            if ans in ("error", "retryable"):
                raise BackendError(f"fake backend error for {key}", retryable=ans == "retryable")
            if ans is None or ans == "omit":
                continue
            out[key] = {"confidence": 1.0, **ans} if isinstance(ans, dict) else ans
        return {"checks": out}

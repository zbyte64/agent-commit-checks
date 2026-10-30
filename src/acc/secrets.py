"""Local secret scan on added diff lines.

Patterns and `scan_text` are ported from dev-decisions
(https://github.com/adelvillar1/dev-decisions, scripts/devdec/gitops.py at
039cea1), Copyright the dev-decisions authors, licensed under the Apache
License 2.0. Changes: PII heuristics dropped, hits carry no matched text so
secrets never reach logs or agent feedback, and scanning works per diff file.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Order: most-specific first to reduce false positives.
_SECRET_PATTERNS = [
    (re.compile(r"(?:AKIA|ASIA)[0-9A-Z]{16}"), "AWS access key ID", "block"),
    (
        re.compile(
            r"(?:api[_-]?key|apikey|secret|token|password|passwd|private[_-]?key)\s*[=:]\s*['\"]?([A-Za-z0-9_\-]{32,})['\"]?",
            re.I,
        ),
        "named secret value",
        "block",
    ),
    (re.compile(r"[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"), "JWT token", "block"),
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"), "PEM private key", "block"),
    (re.compile(r"^[A-Z][A-Z0-9_]{2,}=.+$", re.M), "env-var dump", "warn"),
    (re.compile(r"gh[psu]_[A-Za-z0-9_]{36,}"), "GitHub PAT", "block"),
    (re.compile(r"xox[baprs]-[0-9a-zA-Z-]+"), "Slack token", "block"),
    (re.compile(r"AIza[0-9A-Za-z\-_]{35}"), "Google API key", "block"),
    (re.compile(r"(?:password|passwd)\s*[=:]\s*\S+", re.I), "password assignment", "warn"),
]


@dataclass(frozen=True)
class SecretHit:
    pattern: str
    severity: str  # block | warn
    file: str
    line: int  # line number in the new file
    commit: str | None = None


def scan_text(text: str) -> list[tuple[int, str, str]]:
    """Return (lineno, pattern label, severity) for each hit in `text`."""
    hits = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for pattern, label, severity in _SECRET_PATTERNS:
            if pattern.search(line):
                hits.append((lineno, label, severity))
    return hits


def line_hits(line: str) -> list[tuple[str, str]]:
    return [(label, sev) for pattern, label, sev in _SECRET_PATTERNS if pattern.search(line)]


def scan_diff(diff: str, commit: str | None = None) -> list[SecretHit]:
    """Scan only added lines of a unified diff, tracking file and new-file line numbers."""
    hits: list[SecretHit] = []
    path = ""
    new_line = 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            target = raw[4:]
            path = target[2:] if target.startswith("b/") else target
            continue
        if raw.startswith("@@"):
            m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", raw)
            new_line = int(m.group(1)) if m else 0
            continue
        if raw.startswith("+"):
            for label, sev in line_hits(raw[1:]):
                hits.append(SecretHit(label, sev, path, new_line, commit))
            new_line += 1
        elif raw.startswith(" "):
            new_line += 1
    return hits


def redact_diff(diff: str) -> str:
    """Replace added lines that match a `warn` pattern so they are never sent to a model."""
    out = []
    for raw in diff.splitlines(keepends=True):
        if raw.startswith("+") and not raw.startswith("+++ ") and line_hits(raw[1:]):
            out.append("+[acc: line redacted by secret scan]\n")
        else:
            out.append(raw)
    return "".join(out)

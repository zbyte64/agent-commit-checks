"""Check files: load, validate, verdict mapping, serialization."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import tomllib

ID_RE = re.compile(r"^[a-z0-9-]+$")
STATUSES = ("proposed", "advisory", "active")
INPUTS = ("diff", "message", "file_list")
TYPES = ("bool", "choice", "score")
VERDICTS = ("pass", "warn", "block")
SEVERITY = {"pass": 0, "warn": 1, "block": 2}
STATUS_LINE_RE = re.compile(r'^(status\s*=\s*)"[^"]*"(.*)$', re.M)


class CheckError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


class AnswerError(ValueError):
    pass


@dataclass
class Check:
    id: str
    title: str
    question_type: str
    instructions: str
    verdict: dict
    status: str = "proposed"
    enabled: bool = True
    author: str = "user"
    applies_to: list[str] = field(default_factory=lambda: ["**/*"])
    inputs: list[str] = field(default_factory=lambda: ["diff"])
    labels: dict[str, str] = field(default_factory=dict)
    levels: list[str] = field(default_factory=list)
    grading: dict = field(default_factory=dict)
    path: Path | None = None
    text: str = ""

    @property
    def runs_in_gate(self) -> bool:
        return self.enabled and self.status in ("advisory", "active")

    @property
    def can_block(self) -> bool:
        return self.status == "active"

    @property
    def content_hash(self) -> str:
        return content_hash(self.text)

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "id": self.id,
            "title": self.title,
            "enabled": self.enabled,
            "status": self.status,
            "author": self.author,
            "applies_to": self.applies_to,
            "inputs": self.inputs,
            "question": {"type": self.question_type, "instructions": self.instructions},
            "verdict": self.verdict,
        }
        if self.labels:
            d["question"]["labels"] = self.labels
        if self.levels:
            d["question"]["levels"] = self.levels
        if self.grading:
            d["grading"] = self.grading
        return d


def content_hash(text: str) -> str:
    """SHA-256 of a check file, ignoring the status line so promotion keeps the grade valid."""
    normalized = STATUS_LINE_RE.sub(r'\1""\2', text)
    return hashlib.sha256(normalized.encode()).hexdigest()


def _is_str_list(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def validate_dict(d: dict, expected_id: str | None = None) -> list[str]:
    errs: list[str] = []
    cid = d.get("id")
    if not isinstance(cid, str) or not ID_RE.match(cid):
        errs.append("id must be a string matching [a-z0-9-]+")
    elif expected_id is not None and cid != expected_id:
        errs.append(f"id {cid!r} must equal the file name {expected_id!r}")
    if not isinstance(d.get("title"), str) or not d.get("title"):
        errs.append("title is required")
    if not isinstance(d.get("enabled", True), bool):
        errs.append("enabled must be true or false")
    if d.get("status", "proposed") not in STATUSES:
        errs.append(f"status must be one of {', '.join(STATUSES)}")
    if d.get("author", "user") not in ("user", "agent"):
        errs.append("author must be 'user' or 'agent'")
    if "scope" in d:
        errs.append("scope was removed: every check reviews the whole range of pushed commits; "
                    "delete the scope line")
    applies = d.get("applies_to", ["**/*"])
    if not _is_str_list(applies) or not applies:
        errs.append("applies_to must be a non-empty list of globs")
    inputs = d.get("inputs", ["diff"])
    if not _is_str_list(inputs) or not inputs or any(i not in INPUTS for i in inputs):
        errs.append(f"inputs must be a non-empty list drawn from {', '.join(INPUTS)}")

    q = d.get("question")
    v = d.get("verdict")
    if not isinstance(q, dict):
        errs.append("[question] table is required")
        return errs
    if not isinstance(v, dict):
        errs.append("[verdict] table is required")
        return errs
    qtype = q.get("type")
    if qtype not in TYPES:
        errs.append(f"question.type must be one of {', '.join(TYPES)}")
        return errs
    if not isinstance(q.get("instructions"), str) or not q["instructions"].strip():
        errs.append("question.instructions is required")

    if qtype == "bool":
        for k in ("block_at", "warn_at"):
            if k in v and not (isinstance(v[k], (int, float)) and 0 <= v[k] <= 1):
                errs.append(f"verdict.{k} must be a probability between 0 and 1")
        if "block_at" not in v and "warn_at" not in v:
            errs.append("bool checks need verdict.block_at and/or verdict.warn_at")
        if isinstance(v.get("block_at"), (int, float)) and isinstance(v.get("warn_at"), (int, float)):
            if v["warn_at"] > v["block_at"]:
                errs.append("verdict.warn_at must not exceed verdict.block_at")
        extra = set(v) - {"block_at", "warn_at"}
        if extra:
            errs.append(f"unknown verdict keys for bool: {', '.join(sorted(extra))}")
    elif qtype == "choice":
        labels = q.get("labels")
        if not isinstance(labels, dict) or len(labels) < 2 or not all(
            isinstance(x, str) for x in labels.values()
        ):
            errs.append("choice checks need question.labels with 2+ label = description entries")
        else:
            missing = [lbl for lbl in labels if lbl not in v]
            if missing:
                errs.append(f"verdict is missing labels: {', '.join(missing)}")
            unknown = [k for k in v if k not in labels]
            if unknown:
                errs.append(f"verdict names unknown labels: {', '.join(unknown)}")
            bad = [k for k, x in v.items() if x not in VERDICTS]
            if bad:
                errs.append(f"verdict values must be pass, warn or block (bad: {', '.join(bad)})")
    elif qtype == "score":
        levels = q.get("levels")
        if not _is_str_list(levels) or len(levels) < 2:
            errs.append("score checks need question.levels with 2+ ordered entries")
        else:
            for k in ("block_at", "warn_at"):
                if k in v and not (isinstance(v[k], int) and 0 <= v[k] < len(levels)):
                    errs.append(f"verdict.{k} must be a level index 0..{len(levels) - 1}")
            if "block_at" not in v and "warn_at" not in v:
                errs.append("score checks need verdict.block_at and/or verdict.warn_at")
            if isinstance(v.get("block_at"), int) and isinstance(v.get("warn_at"), int):
                if v["warn_at"] > v["block_at"]:
                    errs.append("verdict.warn_at must not exceed verdict.block_at")
    if qtype != "choice" and "labels" in q:
        errs.append("question.labels is only valid for choice checks")
    if qtype != "score" and "levels" in q:
        errs.append("question.levels is only valid for score checks")

    g = d.get("grading", {})
    if not isinstance(g, dict):
        errs.append("[grading] must be a table")
    else:
        if "terms" in g and not _is_str_list(g["terms"]):
            errs.append("grading.terms must be a list of strings")
        if "expect_fail" in g and not _is_str_list(g["expect_fail"]):
            errs.append("grading.expect_fail must be a list of commit SHAs or A..B ranges")
    known = {"id", "title", "enabled", "status", "author", "applies_to", "inputs",
             "question", "verdict", "grading"}
    unknown = set(d) - known
    if unknown:
        errs.append(f"unknown top-level keys: {', '.join(sorted(unknown))}")
    return errs


def from_dict(d: dict, path: Path | None = None, text: str = "") -> Check:
    q = d["question"]
    return Check(
        id=d["id"],
        title=d["title"],
        question_type=q["type"],
        instructions=q["instructions"].strip(),
        verdict=dict(d["verdict"]),
        status=d.get("status", "proposed"),
        enabled=d.get("enabled", True),
        author=d.get("author", "user"),
        applies_to=list(d.get("applies_to", ["**/*"])),
        inputs=list(d.get("inputs", ["diff"])),
        labels=dict(q.get("labels", {})),
        levels=list(q.get("levels", [])),
        grading=dict(d.get("grading", {})),
        path=path,
        text=text,
    )


def parse_text(text: str, expected_id: str | None = None, path: Path | None = None) -> Check:
    try:
        d = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise CheckError([f"invalid TOML: {e}"]) from e
    errs = validate_dict(d, expected_id)
    if errs:
        raise CheckError(errs)
    return from_dict(d, path, text)


def load_file(path: Path) -> Check:
    return parse_text(path.read_text(), expected_id=path.stem, path=path)


def load_all(checks_dir: Path) -> tuple[list[Check], dict[str, list[str]]]:
    """Load every check file. Returns (valid checks, {file name: errors})."""
    checks: list[Check] = []
    errors: dict[str, list[str]] = {}
    if not checks_dir.is_dir():
        return checks, errors
    for path in sorted(checks_dir.glob("*.toml")):
        try:
            checks.append(load_file(path))
        except CheckError as e:
            errors[path.name] = e.errors
    return checks, errors


# ── answers and verdicts ─────────────────────────────────────────────────────


def answer_schema(check: Check) -> dict:
    if check.question_type == "bool":
        answer: dict = {"type": "number", "minimum": 0, "maximum": 1}
    elif check.question_type == "choice":
        answer = {"type": "string", "enum": list(check.labels)}
    else:
        answer = {"type": "integer", "minimum": 0, "maximum": len(check.levels) - 1}
    return {
        "type": "object",
        "properties": {
            "answer": answer,
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "file": {"type": "string"},
                        "line": {"type": "integer"},
                        "message": {"type": "string"},
                    },
                    "required": ["message"],
                },
            },
            "summary": {"type": "string"},
        },
        "required": ["answer", "confidence", "findings", "summary"],
    }


def map_verdict(check: Check, answer: Any) -> str:
    """Turn a model answer into pass/warn/block. Raises AnswerError if the answer is invalid."""
    v = check.verdict
    if check.question_type == "bool":
        if isinstance(answer, bool) or not isinstance(answer, (int, float)) or not 0 <= answer <= 1:
            raise AnswerError(f"expected a probability 0-1, got {answer!r}")
        if "block_at" in v and answer >= v["block_at"]:
            return "block"
        if "warn_at" in v and answer >= v["warn_at"]:
            return "warn"
        return "pass"
    if check.question_type == "choice":
        if answer not in check.labels:
            raise AnswerError(f"expected one of {list(check.labels)}, got {answer!r}")
        return v[answer]
    if isinstance(answer, bool) or not isinstance(answer, int) or not 0 <= answer < len(check.levels):
        raise AnswerError(f"expected a level index 0..{len(check.levels) - 1}, got {answer!r}")
    if "block_at" in v and answer >= v["block_at"]:
        return "block"
    if "warn_at" in v and answer >= v["warn_at"]:
        return "warn"
    return "pass"


def validate_entry(check: Check, entry: Any) -> tuple[str, list[dict], str, float]:
    """Validate one model answer object. Returns (verdict, findings, summary, confidence)."""
    if not isinstance(entry, dict):
        raise AnswerError("answer entry is not an object")
    verdict = map_verdict(check, entry.get("answer"))
    confidence = entry.get("confidence")
    if entry.get("answer_probs"):
        # Measured by the backend: the probability the model gave to answers with this verdict.
        confidence = verdict_probability(check, entry["answer_probs"], verdict)
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise AnswerError(f"expected a confidence 0-1, got {confidence!r}")
    findings = entry.get("findings", [])
    if not isinstance(findings, list):
        raise AnswerError("findings is not a list")
    clean = []
    for f in findings:
        if isinstance(f, dict) and isinstance(f.get("message"), str):
            clean.append({k: f[k] for k in ("file", "line", "message") if k in f})
    summary = entry.get("summary", "")
    return verdict, clean, summary if isinstance(summary, str) else "", float(confidence)


def verdict_probability(check: Check, answer_probs: list, verdict: str) -> float:
    total = 0.0
    for value, p in answer_probs:
        try:
            same = map_verdict(check, value) == verdict
        except AnswerError:
            same = False
        total += p if same else 0.0
    return min(1.0, total)


def worst(verdicts: list[str]) -> str:
    return max(verdicts, key=SEVERITY.__getitem__, default="pass")


def describe_answer(check: Check, answer: Any) -> str:
    if check.question_type == "score" and isinstance(answer, int) and 0 <= answer < len(check.levels):
        return f"{answer}: {check.levels[answer]}"
    return json.dumps(answer) if not isinstance(answer, str) else answer


# ── writing ──────────────────────────────────────────────────────────────────


def _toml_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{ " + ", ".join(f"{_toml_key(k)} = {_toml_value(x)}" for k, x in v.items()) + " }"
    raise TypeError(f"cannot serialize {type(v).__name__} to TOML")


def _toml_key(k: str) -> str:
    return k if re.match(r"^[A-Za-z0-9_-]+$", k) else json.dumps(k)


def dump_check(d: dict) -> str:
    """Serialize a check dict in the canonical file layout."""
    lines = []
    for key in ("id", "title", "enabled", "status", "author", "applies_to", "inputs"):
        if key in d:
            lines.append(f"{key} = {_toml_value(d[key])}")
    for table in ("question", "verdict", "grading"):
        if table not in d:
            continue
        lines.append("")
        lines.append(f"[{table}]")
        for k, v in d[table].items():
            lines.append(f"{_toml_key(k)} = {_toml_value(v)}")
    return "\n".join(lines) + "\n"


def set_status(path: Path, status: str) -> tuple[str, str]:
    """Rewrite only the status line. Returns (old line, new line)."""
    if status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}")
    text = path.read_text()
    m = STATUS_LINE_RE.search(text)
    new_line = f'status = "{status}"'
    if m:
        old_line = m.group(0)
        new_line = f'{m.group(1)}"{status}"{m.group(2)}'
        text = text[: m.start()] + new_line + text[m.end():]
    else:
        old_line = ""
        # Insert after the title line (top-level keys must precede tables).
        text = re.sub(r"^(title\s*=.*)$", lambda mm: mm.group(1) + "\n" + new_line, text, count=1, flags=re.M)
    path.write_text(text)
    return old_line, new_line

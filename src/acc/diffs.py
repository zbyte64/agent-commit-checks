"""Build the range inputs that checks see, and the per-commit inputs the secret scan reads."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import git as g
from . import globs, secrets

FILE_HEADER = re.compile(r"^diff --git a/(.*?) b/(.*)$")


@dataclass
class Context:
    """One unit of input: a single commit (for the secret scan), or the combined diff of a range."""

    label: str  # data block id: "range", a short sha, or "<base7>..<tip7>" in grading
    commit: str | None  # full sha for single-commit contexts
    diff: str  # filtered and redacted, before truncation
    message: str
    files: list[str]
    skipped: list[str] = field(default_factory=list)  # "path (reason)"
    secret_hits: list[secrets.SecretHit] = field(default_factory=list)

    def clipped_diff(self, max_chars: int) -> tuple[str, bool]:
        """Fit the diff in `max_chars`, sharing the budget fairly across files.

        Cutting from the front would hide later files entirely (e.g. tests/ after src/),
        so small files are kept whole and large ones are clipped with a marker.
        """
        if len(self.diff) <= max_chars:
            return self.diff, False
        chunks = [chunk for _, chunk in split_files(self.diff)] or [self.diff]
        alloc = [0] * len(chunks)
        remaining = max_chars
        order = sorted(range(len(chunks)), key=lambda i: len(chunks[i]))
        for k, i in enumerate(order):
            alloc[i] = min(len(chunks[i]), remaining // (len(chunks) - k))
            remaining -= alloc[i]
        out = []
        for chunk, budget in zip(chunks, alloc):
            if budget >= len(chunk):
                out.append(chunk)
                continue
            cut = chunk[:budget]
            nl = cut.rfind("\n")
            cut = cut[: nl + 1] if nl > 0 else cut
            out.append(cut + f"[acc: {len(chunk) - len(cut)} more characters of this file not shown]\n")
        return "".join(out), True


def split_files(diff: str) -> list[tuple[str, str]]:
    """Split a unified diff into (path, chunk) per file."""
    chunks: list[tuple[str, str]] = []
    path, buf = None, []
    for line in diff.splitlines(keepends=True):
        m = FILE_HEADER.match(line.rstrip("\n"))
        if m:
            if path is not None:
                chunks.append((path, "".join(buf)))
            path, buf = m.group(2), [line]
        elif path is not None:
            buf.append(line)
    if path is not None:
        chunks.append((path, "".join(buf)))
    return chunks


def _is_binary(chunk: str) -> bool:
    return "\nGIT binary patch\n" in chunk or bool(re.search(r"^Binary files .* differ$", chunk, re.M))


def raw_diff(cwd: Path, base: str, tip: str) -> str:
    return g.git(cwd, "diff", "--no-color", "--no-ext-diff", "--find-renames", base, tip)


def build_context(cwd: Path, label: str, raw: str, message: str, exclude_globs: list[str],
                  commit: str | None = None, scan: bool = True) -> Context:
    kept, files, skipped = [], [], []
    for path, chunk in split_files(raw):
        if globs.match_any(path, exclude_globs):
            skipped.append(f"{path} (excluded)")
        elif _is_binary(chunk):
            skipped.append(f"{path} (binary)")
        else:
            kept.append(chunk)
            files.append(path)
    diff = "".join(kept)
    hits = secrets.scan_diff(diff, commit) if scan else []
    if any(h.severity == "warn" for h in hits):
        diff = secrets.redact_diff(diff)
    return Context(label=label, commit=commit, diff=diff, message=message, files=files,
                   skipped=skipped, secret_hits=hits)


def commit_message(cwd: Path, sha: str) -> str:
    return g.git(cwd, "log", "-1", "--format=%B", sha).strip()


def commit_context(cwd: Path, sha: str, exclude_globs: list[str], scan: bool = True) -> Context:
    raw = raw_diff(cwd, g.first_parent(cwd, sha), sha)
    return build_context(cwd, g.short(sha), raw, commit_message(cwd, sha), exclude_globs, sha, scan)


def range_messages(cwd: Path, commits: list[str]) -> str:
    return "\n\n".join(f"{g.short(c)}: {commit_message(cwd, c)}" for c in commits)


def range_context(cwd: Path, refs: list[tuple[str, str, str]], commits: list[str],
                  exclude_globs: list[str], scan: bool = True, label: str = "range") -> Context:
    """Combined diff over pushed refs [(name, base, tip)] with every pushed commit's message."""
    raw = "".join(raw_diff(cwd, base, tip) for _, base, tip in refs)
    return build_context(cwd, label, raw, range_messages(cwd, commits), exclude_globs, None, scan)

"""Thin wrapper around the git binary."""

from __future__ import annotations

import subprocess
from pathlib import Path

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


class GitError(RuntimeError):
    pass


def git(cwd: str | Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        errors="replace",
    )
    if check and proc.returncode != 0:
        raise GitError(f"git {' '.join(args)}: {proc.stderr.strip()}")
    return proc.stdout


def git_ok(cwd: str | Path, *args: str) -> str | None:
    """Run git and return stdout, or None if it failed."""
    proc = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, errors="replace"
    )
    return proc.stdout if proc.returncode == 0 else None


def repo_root(cwd: str | Path) -> Path:
    return Path(git(cwd, "rev-parse", "--show-toplevel").strip())


def rev_parse(cwd: str | Path, rev: str) -> str | None:
    out = git_ok(cwd, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    return out.strip() if out else None


def config_get(cwd: str | Path, key: str) -> str | None:
    out = git_ok(cwd, "config", "--get", key)
    return out.strip() if out else None


def config_get_all(cwd: str | Path, key: str) -> list[str]:
    out = git_ok(cwd, "config", "--get-all", key)
    return out.split("\n")[:-1] if out else []


def remotes(cwd: str | Path) -> list[str]:
    return git(cwd, "remote").split()


def current_branch(cwd: str | Path) -> str | None:
    out = git_ok(cwd, "symbolic-ref", "--quiet", "--short", "HEAD")
    return out.strip() if out else None


def first_parent(cwd: str | Path, sha: str) -> str:
    """The first parent of a commit, or the empty tree for a root commit."""
    return rev_parse(cwd, f"{sha}^1") or EMPTY_TREE


def short(sha: str) -> str:
    return sha[:7]

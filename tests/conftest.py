from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from acc.config import load_config

FIXTURES = Path(__file__).parent / "fixtures"
# Built at runtime so the source never contains a key-shaped literal that the
# secret scan (rightly) refuses to push.
FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP"


def sh(cwd: Path, *args: str) -> str:
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class Repo:
    """A throwaway repo with a local bare remote named origin."""

    def __init__(self, root: Path):
        self.remote = root / "remote.git"
        self.path = root / "work"
        sh(root, "git", "init", "-q", "--bare", "-b", "main", str(self.remote))
        sh(root, "git", "init", "-q", "-b", "main", str(self.path))
        for k, v in (("user.name", "Test"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            self.git("config", k, v)
        self.git("remote", "add", "origin", str(self.remote))
        self.n = 0

    def git(self, *args: str) -> str:
        return sh(self.path, "git", *args)

    def commit(self, files: dict[str, str] | None = None, msg: str | None = None) -> str:
        self.n += 1
        files = files or {f"file{self.n}.txt": f"content {self.n}\n"}
        for name, content in files.items():
            p = self.path / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            self.git("add", name)
        self.git("commit", "-q", "-m", msg or f"commit {self.n}")
        return self.git("rev-parse", "HEAD")

    def push(self, *args: str) -> None:
        self.git("push", "-q", *args)

    def enable(self, config: str = "", checks: dict[str, str] | None = None, answers: dict | None = None) -> None:
        acc = self.path / ".acc"
        (acc / "checks").mkdir(parents=True, exist_ok=True)
        base = ('[agents.claude]\nbackend = "fake"\n\n[agents.omp]\nbackend = "fake"\n\n'
                '[backends.fake]\nanswers = "answers.json"\n')
        (acc / "config.toml").write_text(base + config)
        for cid, text in (checks or {}).items():
            (acc / "checks" / f"{cid}.toml").write_text(text)
        (self.path / "answers.json").write_text(json.dumps(answers or {}))

    def config(self):
        return load_config(self.path)


@pytest.fixture
def repo(tmp_path, monkeypatch) -> Repo:
    monkeypatch.setenv("ACC_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.delenv("ACC_FAKE_ANSWERS", raising=False)
    r = Repo(tmp_path)
    r.commit({"README.md": "hello\n"}, "initial")
    r.push("-u", "origin", "main")
    return r


def ans(a, summary="s", findings=()):
    return {"answer": a, "findings": list(findings), "summary": summary}


@pytest.fixture
def enabled(repo):
    """A repo with acc enabled (one active check, fake backend) and nothing unpushed."""
    repo.enable(checks={"a": check_toml("a")}, answers={"*": ans(0.1)})
    repo.git("add", ".acc", "answers.json")
    repo.git("commit", "-q", "-m", "add acc")
    repo.push()
    return repo


def set_answers(repo, answers):
    (repo.path / "answers.json").write_text(json.dumps(answers))


def log_rows(tmp_path):
    rows = []
    for p in (tmp_path / "logs").rglob("events.jsonl"):
        rows += [json.loads(line) for line in p.read_text().splitlines()]
    return rows


def check_toml(cid: str, *, qtype: str = "bool", status: str = "active", scope: str = "range",
               applies_to: str = '["**/*"]', inputs: str = '["diff"]', extra: str = "") -> str:
    if qtype == "bool":
        q = 'type = "bool"\ninstructions = "Is there a problem?"'
        v = "block_at = 0.8\nwarn_at = 0.5"
    elif qtype == "choice":
        q = 'type = "choice"\ninstructions = "Pick one."\nlabels = { good = "Fine", meh = "So-so", bad = "Broken" }'
        v = 'good = "pass"\nmeh = "warn"\nbad = "block"'
    else:
        q = 'type = "score"\ninstructions = "Rate it."\nlevels = ["fine", "minor", "major"]'
        v = "warn_at = 1\nblock_at = 2"
    return (f'id = "{cid}"\ntitle = "Check {cid}"\nstatus = "{status}"\nscope = "{scope}"\n'
            f"applies_to = {applies_to}\ninputs = {inputs}\n\n[question]\n{q}\n\n[verdict]\n{v}\n{extra}")

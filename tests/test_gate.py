"""Pipe recorded-shape PreToolUse payloads into `acc gate --agent claude`."""

import json
import os
import subprocess
import sys

import pytest

from tests.conftest import FAKE_AWS_KEY, check_toml


def gate(repo, command, tool="Bash", cwd=None, raw=None):
    payload = raw if raw is not None else json.dumps({
        "session_id": "s", "transcript_path": "/tmp/t.jsonl", "cwd": str(cwd or repo.path),
        "permission_mode": "default", "hook_event_name": "PreToolUse", "tool_name": tool,
        "tool_input": {"command": command, "description": "Push"}, "tool_use_id": "toolu_1",
    })
    proc = subprocess.run([sys.executable, "-m", "acc.cli", "gate", "--agent", "claude"], input=payload,
                          capture_output=True, text=True, env=os.environ.copy())
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def ans(a, summary="s", findings=()):
    return {"answer": a, "findings": list(findings), "summary": summary}


@pytest.fixture
def enabled(repo):
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


def test_not_a_push(enabled):
    assert gate(enabled, "ls") is None


def test_other_tool(enabled):
    assert gate(enabled, "git push", tool="Edit") is None


def test_pass_prints_nothing(enabled, tmp_path):
    enabled.commit()
    assert gate(enabled, "git push") is None
    row = log_rows(tmp_path)[-1]
    assert row["verdict"] == "pass" and row["commits"] == 1 and row["agent"] == "claude"
    assert row["calls"] == 1 and "diff" not in row


def test_block_denies_with_findings(enabled, tmp_path):
    sha = enabled.commit()
    set_answers(enabled, {"a": ans(0.95, "Leaves a debug print", [{"file": "x.py", "line": 3, "message": "print"}])})
    out = gate(enabled, "git push origin main")
    hso = out["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["permissionDecision"] == "deny"
    reason = hso["permissionDecisionReason"]
    assert "acc: push blocked" in reason and "Leaves a debug print" in reason
    assert "print (x.py:3)" in reason and "push again" in reason
    assert log_rows(tmp_path)[-1]["verdict"] == "block"
    assert sha  # commit exists


def test_per_commit_block_names_commit(enabled):
    enabled.commit()
    sha = enabled.commit()
    (enabled.path / ".acc/checks/pc.toml").write_text(check_toml("pc", scope="per_commit"))
    set_answers(enabled, {"a": ans(0.1), f"pc@{sha[:7]}": ans(0.9, "bad"), "pc": ans(0.1)})
    # check file is untracked, the gate reads the working tree
    reason = gate(enabled, "git push")["hookSpecificOutput"]["permissionDecisionReason"]
    assert "1 of 2 commits failed" in reason
    assert f"{sha[:7]} pc" in reason


def test_warn_adds_context(enabled):
    enabled.commit()
    set_answers(enabled, {"a": ans(0.6, "Maybe a debug print")})
    out = gate(enabled, "git push")
    assert "permissionDecision" not in out["hookSpecificOutput"]
    assert "Maybe a debug print" in out["hookSpecificOutput"]["additionalContext"]
    assert out["systemMessage"].startswith("acc:")


def test_commit_and_push_denied_without_model(enabled, tmp_path):
    set_answers(enabled, {"*": "error"})
    out = gate(enabled, "git commit -am 'x' && git push")
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "as its own command" in out["hookSpecificOutput"]["permissionDecisionReason"]
    assert log_rows(tmp_path) == []


def test_nothing_to_push(enabled):
    set_answers(enabled, {"*": "error"})
    assert gate(enabled, "git push") is None


def test_delete_and_tags_allowed(enabled):
    enabled.commit()
    set_answers(enabled, {"*": "error"})
    assert gate(enabled, "git push origin --delete old") is None
    assert gate(enabled, "git push --tags") is None


def test_backend_error_blocks_with_reason(enabled):
    enabled.commit()
    set_answers(enabled, {"*": "error"})
    reason = gate(enabled, "git push")["hookSpecificOutput"]["permissionDecisionReason"]
    assert "could not run" in reason and "fake backend error" in reason


def test_unknown_command_reviews_upstream_range(enabled):
    enabled.commit()
    set_answers(enabled, {"a": ans(0.95)})
    reason = gate(enabled, "git push origin $(git branch --show-current)")["hookSpecificOutput"][
        "permissionDecisionReason"]
    assert "could not tell exactly" in reason


def test_cd_into_repo(enabled, tmp_path):
    enabled.commit()
    set_answers(enabled, {"a": ans(0.95)})
    out = gate(enabled, f"cd {enabled.path} && git push", cwd=tmp_path)
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_secret_block(enabled, tmp_path):
    enabled.commit({"k.py": f'K = "{FAKE_AWS_KEY}"\n'})
    reason = gate(enabled, "git push")["hookSpecificOutput"]["permissionDecisionReason"]
    assert "secret scan" in reason and "k.py:1" in reason
    assert FAKE_AWS_KEY not in reason
    row = log_rows(tmp_path)[-1]
    assert row["calls"] == 0 and FAKE_AWS_KEY not in json.dumps(row)


def test_repo_without_acc_is_ignored(repo):
    repo.commit()
    assert gate(repo, "git push") is None


def test_outside_git_repo(tmp_path, repo):
    assert gate(repo, "git push", cwd=tmp_path) is None


def test_invalid_payload_blocks(repo):
    out = gate(repo, "", raw="not json")
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_invalid_config_blocks(enabled):
    enabled.commit()
    (enabled.path / ".acc/config.toml").write_text("[run\n")
    out = gate(enabled, "git push")
    assert "config.toml" in out["hookSpecificOutput"]["permissionDecisionReason"]


def test_proposed_checks_skip_gate(enabled):
    enabled.commit()
    (enabled.path / ".acc/checks/a.toml").write_text(check_toml("a", status="proposed"))
    set_answers(enabled, {"*": "error"})
    assert gate(enabled, "git push") is None

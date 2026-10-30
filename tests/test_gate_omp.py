"""`acc gate --agent omp`: the JSON the omp extension turns into block / additionalContext."""

import json
import os
import subprocess
import sys

from tests.conftest import ans, check_toml, log_rows, set_answers


def gate(cwd, command):
    proc = subprocess.run([sys.executable, "-m", "acc.cli", "gate", "--agent", "omp", "--cwd", str(cwd),
                           "--command", command], capture_output=True, text=True, env=os.environ.copy())
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_not_a_push_passes(enabled):
    assert gate(enabled.path, "ls") == {"verdict": "pass"}


def test_pass_logs_omp_agent(enabled, tmp_path):
    enabled.commit()
    assert gate(enabled.path, "git push") == {"verdict": "pass"}
    row = log_rows(tmp_path)[-1]
    assert row["agent"] == "omp" and row["verdict"] == "pass" and row["calls"] == 1


def test_block_carries_reason(enabled):
    enabled.commit()
    set_answers(enabled, {"a": ans(0.95, "Leaves a debug print", [{"file": "x.py", "line": 3, "message": "print"}])})
    out = gate(enabled.path, "git push origin main")
    assert out["verdict"] == "block" and "context" not in out
    assert "acc: push blocked" in out["reason"] and "print (x.py:3)" in out["reason"]
    assert out["message"].startswith("acc: push blocked")


def test_warn_carries_context(enabled):
    enabled.commit()
    set_answers(enabled, {"a": ans(0.6, "Maybe a debug print")})
    out = gate(enabled.path, "git push")
    assert out["verdict"] == "warn" and "reason" not in out
    assert "Maybe a debug print" in out["context"]


def test_commit_and_push_blocked_without_model(enabled, tmp_path):
    set_answers(enabled, {"*": "error"})
    out = gate(enabled.path, "git commit -am x && git push")
    assert out["verdict"] == "block" and "as its own command" in out["reason"]
    assert log_rows(tmp_path) == []


def test_cwd_is_where_the_push_runs(enabled, tmp_path):
    enabled.commit()
    set_answers(enabled, {"a": ans(0.95)})
    assert gate(tmp_path, "git push") == {"verdict": "pass"}  # not a repo
    assert gate(enabled.path, "git push")["verdict"] == "block"


def test_backend_error_blocks(enabled):
    enabled.commit()
    set_answers(enabled, {"*": "error"})
    out = gate(enabled.path, "git push")
    assert out["verdict"] == "block" and "fake backend error" in out["reason"]


def test_advisory_block_is_a_warning(enabled):
    enabled.commit()
    (enabled.path / ".acc/checks/a.toml").write_text(check_toml("a", status="advisory"))
    set_answers(enabled, {"a": ans(0.95, "Would block")})
    assert gate(enabled.path, "git push")["verdict"] == "warn"


def test_invalid_config_blocks(enabled):
    enabled.commit()
    (enabled.path / ".acc/config.toml").write_text("[run\n")
    out = gate(enabled.path, "git push")
    assert out["verdict"] == "block" and "config.toml" in out["reason"]


def test_missing_command_is_a_usage_error():
    proc = subprocess.run([sys.executable, "-m", "acc.cli", "gate", "--agent", "omp"],
                          capture_output=True, text=True)
    assert proc.returncode == 3 and "--command" in proc.stderr

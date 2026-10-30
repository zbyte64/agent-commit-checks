"""Load the omp extension (adapters/omp/acc.ts) under bun and drive its tool_call handler
against a real `acc gate --agent omp` on a throwaway repo."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from acc.omp_setup import extension_source
from tests.conftest import ans, set_answers

BUN = shutil.which("bun")
HARNESS = Path(__file__).parent / "omp_harness.ts"
pytestmark = pytest.mark.skipif(BUN is None, reason="bun is needed to load the omp extension")


def install(tmp_path, acc: str) -> Path:
    ext = tmp_path / "ext" / "acc.ts"
    ext.parent.mkdir(exist_ok=True)
    ext.write_text(extension_source(acc))
    return ext


@pytest.fixture
def acc_bin(tmp_path):
    """An `acc` launcher for this checkout's interpreter."""
    path = tmp_path / "bin" / "acc"
    path.parent.mkdir()
    path.write_text(f'#!/bin/sh\nexec "{sys.executable}" -m acc.cli "$@"\n')
    path.chmod(0o755)
    return str(path)


def fire(ext: Path, session_cwd: Path, command: str, tool: str = "bash", **bash_input):
    event = {"type": "tool_call", "toolName": tool, "toolCallId": "t1", "input": {"command": command, **bash_input}}
    proc = subprocess.run([BUN, str(HARNESS), str(ext), json.dumps(event), str(session_cwd)],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_block_returns_reason(enabled, tmp_path, acc_bin):
    enabled.commit()
    set_answers(enabled, {"a": ans(0.95, "Leaves a debug print")})
    out = fire(install(tmp_path, acc_bin), enabled.path, "git push")
    assert out["block"] is True
    assert "acc: push blocked" in out["reason"] and "Leaves a debug print" in out["reason"]


def test_warn_returns_additional_context(enabled, tmp_path, acc_bin):
    enabled.commit()
    set_answers(enabled, {"a": ans(0.6, "Maybe a debug print")})
    out = fire(install(tmp_path, acc_bin), enabled.path, "git push")
    assert "block" not in out and "Maybe a debug print" in out["additionalContext"]


def test_pass_and_non_push_return_nothing(enabled, tmp_path, acc_bin):
    ext = install(tmp_path, acc_bin)
    enabled.commit()
    assert fire(ext, enabled.path, "git push") is None
    set_answers(enabled, {"*": "error"})
    assert fire(ext, enabled.path, "git status") is None
    assert fire(ext, enabled.path, "git push", tool="python") is None


def test_bash_cwd_is_resolved_against_session_cwd(enabled, tmp_path, acc_bin):
    enabled.commit()
    set_answers(enabled, {"a": ans(0.95)})
    ext = install(tmp_path, acc_bin)
    # The session sits outside the repo; the bash call names the repo through its cwd input.
    assert fire(ext, tmp_path, "git push") is None
    rel = enabled.path.relative_to(tmp_path)
    assert fire(ext, tmp_path, "git push", cwd=str(rel))["block"] is True


def test_invalid_gate_output_blocks(enabled, tmp_path):
    broken = tmp_path / "broken-acc"
    broken.write_text("#!/bin/sh\necho 'Traceback: boom' >&2\nexit 1\n")
    broken.chmod(0o755)
    out = fire(install(tmp_path, str(broken)), enabled.path, "git push")
    assert out["block"] is True and "acc gate failed" in out["reason"] and "boom" in out["reason"]


def test_missing_acc_blocks(enabled, tmp_path):
    out = fire(install(tmp_path, str(tmp_path / "missing" / "acc")), enabled.path, "git push")
    assert out["block"] is True and "could not run" in out["reason"]

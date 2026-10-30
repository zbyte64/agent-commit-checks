"""`acc init --omp` and `acc doctor --agent omp` against a stand-in omp CLI and agent dir."""

import json
import os
from types import SimpleNamespace

import pytest

from acc.cli import main
from acc.omp_setup import extension_acc_path
from tests.conftest import check_toml


@pytest.fixture
def omp_env(tmp_path, monkeypatch):
    """A fake `omp` and `acc` on PATH, and an isolated omp agent dir. Returns a setter for omp's config."""
    home = tmp_path / "home"
    bindir = home / ".local" / "bin"
    bindir.mkdir(parents=True)
    acc = bindir / "acc"
    acc.write_text("#!/bin/sh\n")
    acc.chmod(0o755)
    agent_dir = home / ".omp" / "agent"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(agent_dir))
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")

    def configure(roles: dict, timeout_ms: int = 30000):
        # `omp config get <key> --json` prints {"key", "value", ...}.
        values = {"modelRoles": roles, "extensionHandlers.toolCallTimeoutMs": timeout_ms}
        cases = "".join(f"  {key}) echo '{json.dumps({'key': key, 'value': v})}' ;;\n" for key, v in values.items())
        omp = bindir / "omp"
        omp.write_text(f'#!/bin/sh\ncase "$3" in\n{cases}  *) exit 1 ;;\nesac\n')
        omp.chmod(0o755)

    configure({})
    return SimpleNamespace(acc=str(acc), agent_dir=agent_dir, configure=configure)


def test_init_omp_installs_extension_and_explains_setup(repo, omp_env, monkeypatch, capsys):
    monkeypatch.chdir(repo.path)
    assert main(["init", "--omp"]) == 0
    out = capsys.readouterr().out
    ext = omp_env.agent_dir / "extensions" / "acc.ts"
    assert f"installed omp extension {ext}" in out
    assert extension_acc_path(ext.read_text()) == omp_env.acc
    config = (repo.path / ".acc/config.toml").read_text()
    assert 'command = "~/.local/bin/omp"' in config and 'model = "@decision"' in config
    # Unset role and the 30s default handler timeout are both explained; MCP uses the omp agent.
    assert "modelRoles:\n  decision:" in out
    assert "extensionHandlers.toolCallTimeoutMs 180000" in out
    assert '"mcp",\n        "--agent",\n        "omp"' in out
    assert "PreToolUse" not in out

    omp_env.configure({"decision": "anthropic/claude-haiku-5-5"}, 180000)
    assert main(["init", "--omp"]) == 0
    out = capsys.readouterr().out
    assert f"unchanged omp extension {ext}" in out
    assert "omp role @decision -> anthropic/claude-haiku-5-5" in out
    assert "toolCallTimeoutMs" not in out


def test_doctor_omp(repo, omp_env, monkeypatch, capsys):
    monkeypatch.chdir(repo.path)
    repo.enable(checks={"a": check_toml("a")})
    assert main(["doctor", "--agent", "omp", "--offline"]) == 0
    out = capsys.readouterr().out
    assert "[warn] omp extension not installed" in out

    omp_env.configure({"decision": "anthropic/claude-haiku-5-5"}, 180000)
    assert main(["init", "--omp"]) == 0
    capsys.readouterr()
    assert main(["doctor", "--agent", "omp", "--offline"]) == 0
    out = capsys.readouterr().out
    assert f"[ok  ] omp extension {omp_env.agent_dir / 'extensions' / 'acc.ts'} calls an executable acc" in out
    assert "[ok  ] omp extensionHandlers.toolCallTimeoutMs is 180000" in out

    # A stale acc path in the extension would block every push.
    os.remove(omp_env.acc)
    assert main(["doctor", "--agent", "omp", "--offline"]) == 1
    assert "[FAIL] omp extension" in capsys.readouterr().out


def test_doctor_omp_backend_reports_unset_role(repo, omp_env, monkeypatch, capsys):
    monkeypatch.chdir(repo.path)
    (repo.path / ".acc").mkdir()
    (repo.path / ".acc/config.toml").write_text('[backends.omp]\ncommand = "~/.local/bin/omp"\n')
    main(["doctor", "--agent", "omp", "--offline"])
    out = capsys.readouterr().out
    assert "[ok  ] omp binary is executable" in out
    assert "[warn] omp role @decision is not set" in out
    omp_env.configure({"decision": "anthropic/claude-haiku-5-5"})
    main(["doctor", "--agent", "omp", "--offline"])
    assert "[ok  ] omp role @decision -> anthropic/claude-haiku-5-5" in capsys.readouterr().out

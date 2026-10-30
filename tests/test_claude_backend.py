"""Parser contracts against recorded `claude -p --output-format json` results."""

import json

import pytest

from acc.backends import BackendError
from acc.backends.claude import ClaudeBackend, parse_output
from tests.conftest import FIXTURES


def fixture(name):
    return (FIXTURES / name).read_text()


def test_success_object():
    out = parse_output(fixture("claude_success_object.json"))
    assert out["checks"]["dbg"]["answer"] == 0.95


def test_verbose_array_falls_back_to_structured_tool_call():
    # Recorded with --max-turns 1: the run ends with error_max_turns after the
    # StructuredOutput call, so the answer is recovered from the tool input.
    out = parse_output(fixture("claude_max_turns_array.json"))
    assert out["checks"]["dbg"]["answer"] == 0.99


def test_auth_error():
    with pytest.raises(BackendError, match="login") as e:
        parse_output(fixture("claude_auth_error.json"))
    assert not e.value.retryable


def test_not_json():
    with pytest.raises(BackendError, match="without JSON"):
        parse_output("", "Error: not logged in", 1)


def test_missing_checks_key_is_retryable():
    with pytest.raises(BackendError) as e:
        parse_output('{"type": "result", "is_error": false, "structured_output": {"other": 1}}')
    assert e.value.retryable


def test_argv_flags():
    argv = ClaudeBackend({"command": "/x/claude", "model": "haiku"}).argv("sys", "prompt", {"type": "object"})
    assert argv[0] == "/x/claude"
    assert "--bare" not in argv
    settings = json.loads(argv[argv.index("--settings") + 1])
    assert settings["disableAllHooks"] is True and settings["alwaysThinkingEnabled"] is False
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--max-turns") + 1] == "4"
    assert argv[-1] == "prompt"


def test_missing_binary():
    with pytest.raises(BackendError, match="not found"):
        ClaudeBackend({"command": "/nonexistent/claude"}).ask("s", "p", "", {"type": "object"}, 5)


def test_thinking_forced_off_even_if_agent_env_enables_it(monkeypatch):
    import subprocess

    monkeypatch.setenv("MAX_THINKING_TOKENS", "8000")
    seen = {}

    def fake_run(argv, **kw):
        seen["env"] = kw["env"]
        return subprocess.CompletedProcess(argv, 0, fixture("claude_success_object.json"), "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    ClaudeBackend({}).ask("s", "p", "", {"type": "object"}, 5)
    assert seen["env"]["MAX_THINKING_TOKENS"] == "0"

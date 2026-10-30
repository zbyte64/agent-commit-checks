"""Parser contracts against recorded `omp -p --mode json` event streams."""

import json
import subprocess

import pytest

from acc.backends import BackendError
from acc.backends.omp import OmpBackend, parse_output
from tests.conftest import FIXTURES


def fixture(name):
    return (FIXTURES / name).read_text()


def assistant_stream(text=None, **message):
    """A minimal event stream ending in one assistant message_end."""
    msg = {"role": "assistant", "content": [{"type": "text", "text": text}] if text is not None else [],
           "stopReason": "stop", **message}
    return "\n".join(json.dumps(e) for e in (
        {"type": "session", "version": 3},
        {"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "q"}]}},
        {"type": "message_end", "message": msg},
        {"type": "agent_end", "messages": []},
    )) + "\n"


def test_recorded_success():
    out = parse_output(fixture("omp_success.jsonl"))
    assert out["checks"]["no-debug-leftovers"]["answer"] == 0.95


def test_recorded_provider_error_is_not_retryable():
    # Recorded: a 402 billing error ends the run with stopReason "error" and exit 1.
    with pytest.raises(BackendError, match="Insufficient Balance") as e:
        parse_output(fixture("omp_provider_error.jsonl"), "", 1)
    assert not e.value.retryable


@pytest.mark.parametrize("status,retryable", [(429, True), (529, True), (401, False), (None, False)])
def test_provider_error_retryability(status, retryable):
    with pytest.raises(BackendError) as e:
        parse_output(assistant_stream(stopReason="error", errorStatus=status, errorMessage="boom\ndetail"))
    assert e.value.retryable is retryable
    assert str(e.value).endswith("boom")


def test_fenced_answer_is_accepted():
    out = parse_output(assistant_stream('Here you go:\n```json\n{"checks": {"a": {"answer": 1}}}\n```'))
    assert out["checks"]["a"]["answer"] == 1


@pytest.mark.parametrize("text,stop,match", [
    ("I think the answer is yes.", "stop", "not a JSON object"),
    ('{"checks": {"a": ', "length", "cut off"),
    ('{"result": {}}', "stop", "no `checks` object"),
])
def test_invalid_answers_are_retryable(text, stop, match):
    with pytest.raises(BackendError, match=match) as e:
        parse_output(assistant_stream(text, stopReason=stop))
    assert e.value.retryable


def test_unset_role_names_the_fix():
    # Recorded: `omp -p --model @decision` with no modelRoles.decision prints this on stderr and exits 1.
    stderr = 'Model "@decision" not found\n\nRun `omp models find <pattern>` to search, or `omp models` to list all.\n'
    with pytest.raises(BackendError, match="modelRoles") as e:
        parse_output("", stderr, 1, "@decision")
    assert 'Model "@decision" not found' in str(e.value)
    assert not e.value.retryable


def test_argv_flags():
    argv = OmpBackend({"command": "/x/omp", "model": "@decision"}).argv("sys", "prompt", {"type": "object"})
    assert argv[:2] == ["/x/omp", "-p"]
    assert argv[argv.index("--model") + 1] == "@decision"
    assert argv[argv.index("--mode") + 1] == "json"
    assert argv[argv.index("--thinking") + 1] == "off"
    assert argv[argv.index("--system-prompt") + 1] == "sys"
    # No tools, no session and no extensions: one text answer, and the gate cannot recurse.
    assert {"--no-tools", "--no-session", "--no-extensions"} <= set(argv)
    assert argv[-1].startswith("prompt") and '{"type":"object"}' in argv[-1]


def test_runs_in_project_dir_with_stdin(monkeypatch, tmp_path):
    seen = {}

    def fake_run(argv, **kw):
        seen.update(kw)
        return subprocess.CompletedProcess(argv, 0, fixture("omp_success.jsonl"), "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    OmpBackend({}, tmp_path).ask("s", "p", "DATA", {"type": "object"}, 5)
    assert seen["cwd"] == tmp_path and seen["input"] == "DATA"


def test_missing_binary():
    with pytest.raises(BackendError, match="not found"):
        OmpBackend({"command": "/nonexistent/omp"}).ask("s", "p", "", {"type": "object"}, 5)

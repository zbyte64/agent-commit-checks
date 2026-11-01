"""The judge backend against a stand-in llama-server that returns token probabilities."""

import json
import math
import textwrap

import pytest

from acc import checks, prompt
from acc.backends import BackendError, get_backend
from acc.backends.judge import JudgeBackend, criteria, p_yes
from acc.cli import enable_local
from acc.config import load_config
from tests.test_local_backend import Server


def tok(text, p=1.0, **alts):
    return {"token": text, "logprob": math.log(p),
            "top_logprobs": [{"token": t, "logprob": math.log(q)} for t, q in alts.items()]}


def completion(tokens):
    return json.dumps({"choices": [{"message": {"content": "".join(t["token"] for t in tokens)},
                                    "finish_reason": "stop", "logprobs": {"content": tokens}}]})


def guardian_says(p):
    """Guardian's no-think output with P(yes) = p; "Yes" counts as yes, other tokens are ignored."""
    return completion([tok("<think>\n</think>\n"), tok("<score>"),
                       tok(" yes", p * 0.8, **{"Yes": p * 0.2, " no": 1 - p - 0.01, "maybe": 0.01}),
                       tok("</score>")])


def check(qtype, body):
    return checks.parse_text(textwrap.dedent(f"""
        id = "c"
        title = "t"
        [question]
        type = "{qtype}"
        instructions = "q"
    """) + textwrap.dedent(body), "c")


BOOL = check("bool", "[verdict]\nblock_at = 0.85\nwarn_at = 0.5\n")
CHOICE = check("choice", """
    labels = { accurate = "a", incomplete = "i", wrong = "w" }
    [verdict]
    accurate = "pass"
    incomplete = "block"
    wrong = "block"
""")


@pytest.fixture
def server():
    s = Server()
    yield s
    s.httpd.shutdown()


def decide(server, c, fmt="guardian"):
    backend = JudgeBackend({"url": server.url, "model": "m", "format": fmt})
    entry = prompt.Entry("c", c, None)
    return backend.decide([entry], "DATA", 5)["checks"]["c"]


def test_p_yes_reads_the_token_after_the_marker():
    p, reason = p_yes(guardian_says(0.9), "<score>")
    assert p == pytest.approx(0.9 / 0.99)  # "maybe" is not a judgement
    assert reason == ""


def test_selene_reasoning_becomes_the_summary(server):
    server.replies.append((200, completion([tok("**Reasoning:** The diff adds a print call.\n\n**Result:**"),
                                            tok(" Yes", 0.7, **{" No": 0.3})])))
    entry = decide(server, BOOL, "selene")
    assert entry["answer"] == pytest.approx(0.7)
    assert entry["summary"] == "The diff adds a print call."
    content = server.requests[0]["messages"][0]["content"]
    assert content.index("DATA") < content.index("Score Rubrics")  # data first, for the prompt cache


def test_guardian_bool(server):
    server.replies.append((200, guardian_says(0.9)))
    entry = decide(server, BOOL)
    assert entry["answer"] == pytest.approx(0.9091, abs=1e-3)
    assert checks.validate_entry(BOOL, entry)[0] == "block"
    req = server.requests[0]
    assert [m["role"] for m in req["messages"]] == ["user", "assistant", "user"]
    assert req["messages"][1]["content"] == "DATA"
    assert "### Criteria: Question about the commits: q" in req["messages"][2]["content"]
    assert req["logprobs"] and req["temperature"] == 0


def test_guardian_choice_asks_each_label(server):
    for p in (0.2, 0.6, 0.2):
        server.replies.append((200, guardian_says(p)))
    entry = decide(server, CHOICE)
    assert len(server.requests) == 3
    assert ['"accurate"' in r["messages"][2]["content"] for r in server.requests] == [True, False, False]
    assert entry["answer"] == "incomplete"
    verdict, _, _, confidence = checks.validate_entry(CHOICE, entry)
    assert verdict == "block"
    assert confidence == pytest.approx(0.8, abs=1e-3)  # incomplete and wrong both block


def test_no_judgement_is_retryable(server):
    server.replies.append((200, completion([tok("I cannot judge this.")])))
    with pytest.raises(BackendError, match="no '<score>'") as e:
        decide(server, BOOL)
    assert e.value.retryable


def test_criteria_per_question_type():
    assert criteria(BOOL)[0][1].endswith("the correct answer to the question is yes.")
    assert [v for v, _ in criteria(CHOICE)] == ["accurate", "incomplete", "wrong"]


def test_unknown_format():
    with pytest.raises(BackendError, match="format must be one of guardian, selene"):
        JudgeBackend({"format": "gpt"})


def test_judge_preset(tmp_path):
    (tmp_path / ".acc").mkdir()
    (tmp_path / ".acc/config.toml").write_text(enable_local("", "judge", "llama-server"))
    cfg = load_config(tmp_path)
    backend = get_backend(cfg, "claude")
    assert (backend.name, backend.format, backend.device) == ("judge", "guardian", "gpu")
    assert "granite-guardian" in backend.model

"""The tiny backend's decisions, with a stub model in place of onnxruntime."""

import math
import textwrap

import pytest

from acc import checks, prompt
from acc.backends import BackendError, tiny
from acc.backends.tiny import TinyBackend
from acc.config import load_config
from acc.diffs import Context
from acc.runner import execute


class StubModel:
    """Answer tokens are single ids; every other text encodes to filler ids. Logits come from `probs`."""

    context = 64

    def __init__(self, probs):
        self.vocab = {text: i for i, text in enumerate(["yes", "Yes", "no", "No", *map(str, range(10))])}
        self.probs = probs
        self.seen = []

    def encode(self, text):
        return [self.vocab[text]] if text in self.vocab else [100] * (len(text.split()) + 1)

    def last_logits(self, ids):
        self.seen.append(ids)
        return {i: math.log(self.probs.get(text, 1e-9)) for text, i in self.vocab.items()}


def check(qtype, body):
    return checks.parse_text(textwrap.dedent(f"""
        id = "c"
        title = "t"
        [question]
        type = "{qtype}"
        instructions = "q"
    """) + textwrap.dedent(body), "c")


BOOL = check("bool", """
    [verdict]
    block_at = 0.85
    warn_at = 0.5
""")
CHOICE = check("choice", """
    labels = { accurate = "a", incomplete = "i", wrong = "w" }
    [verdict]
    accurate = "pass"
    incomplete = "block"
    wrong = "block"
""")


def decide(monkeypatch, c, probs):
    model = StubModel(probs)
    monkeypatch.setattr(tiny, "_load", lambda repo, file: model)
    ctx = Context(label="range", commit=None, diff="diff --git a/x b/x\n+x\n", message="m", files=["x"])
    return TinyBackend({}).decide([prompt.Entry("c", c, ctx)], "data", 5)["checks"]["c"], model


def test_bool_answer_is_p_yes(monkeypatch):
    entry, _ = decide(monkeypatch, BOOL, {"yes": 0.4, "Yes": 0.4, "no": 0.1, "No": 0.1})
    assert entry["answer"] == pytest.approx(0.8)  # both spellings of yes, against both of no
    assert checks.validate_entry(BOOL, entry)[0] == "warn"


def test_choice_reads_option_numbers(monkeypatch):
    # Options are numbered from 1 in label order: 1 accurate, 2 incomplete, 3 wrong.
    entry, _ = decide(monkeypatch, CHOICE, {"1": 0.2, "2": 0.45, "3": 0.35})
    assert entry["answer"] == "incomplete"
    verdict, _, summary, confidence = checks.validate_entry(CHOICE, entry)
    assert verdict == "block"
    assert confidence == pytest.approx(0.8)  # incomplete and wrong both block
    assert summary.startswith("accurate 0.20, incomplete 0.45, wrong 0.35")


def test_long_data_is_clipped_to_the_context(monkeypatch):
    model = StubModel({"yes": 1})
    monkeypatch.setattr(tiny, "_load", lambda repo, file: model)
    ctx = Context(label="range", commit=None, diff="", message="m", files=[])
    TinyBackend({}).decide([prompt.Entry("c", BOOL, ctx)], "word " * 500, 5)
    assert len(model.seen[0]) == model.context


def test_multi_token_answers_are_refused(monkeypatch):
    model = StubModel({})
    model.vocab.pop("yes")
    monkeypatch.setattr(tiny, "_load", lambda repo, file: model)
    with pytest.raises(BackendError, match="not one token"):
        TinyBackend({}).decide([prompt.Entry("c", BOOL, None)], "data", 5)


def test_runner_sends_checks_to_decide(tmp_path, monkeypatch):
    (tmp_path / ".acc").mkdir()
    cfg = load_config(tmp_path)
    monkeypatch.setattr(tiny, "_load", lambda repo, file: StubModel({"1": 0.9, "2": 0.05, "3": 0.05}))
    ctx = Context(label="range", commit=None, diff="diff --git a/x b/x\n+x\n", message="m", files=["x"])
    [result], calls = execute([prompt.Entry("c", CHOICE, ctx)], TinyBackend({}), cfg)
    assert (result.verdict, result.answer, calls) == ("pass", "accurate", 1)
    assert result.confidence == pytest.approx(0.9)

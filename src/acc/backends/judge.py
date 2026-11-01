"""Judge backend: a model trained to judge a criterion with yes or no, served by llama-server.

`format` picks the model family and its trained prompt:

- "guardian": IBM Granite Guardian 4.1, with a bring-your-own criterion in no-think mode.
  It answers `<score>yes</score>` or `<score>no</score>` straight away.
- "selene": Atla Selene 1 Mini, with its binary classification template. It writes
  `**Reasoning:** ...` and then `**Result:** Yes` or `No`; the reasoning becomes the summary.

Like the tiny backend it is a classifier. A bool check is one criterion, "the answer to the
question is yes", and its P(yes) is the answer. A choice or score check is one criterion per
option, and the options' P(yes), normalised, become `answer_probs`, so confidence is the
probability of the verdict. P(yes) is read from the token probabilities at the judgement.
The data comes first in each prompt, so llama-server reuses it from its prompt cache for
every option of a check. The server is started and checked as for the local backend.
"""

from __future__ import annotations

import json
import math
import re

from .. import prompt
from . import BackendError
from .local import LocalBackend

RECOMMENDED_MODELS = {"guardian": "ibm-granite/granite-guardian-4.1-8b-GGUF:Q4_K_M",
                      "selene": "AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF"}
FORMATS = tuple(RECOMMENDED_MODELS)
TOP_LOGPROBS = 20

# From the Granite Guardian 4.1 model card.
GUARDIAN_NOTHINK = (
    "<no-think>As a judge agent, assess whether the provided text meets the given "
    "judging criteria using all available information, including conversations, "
    "documents, and tools. Provide your score immediately without explanation. "
    "Output empty <think>\\n</think> tags followed by your score in <score></score> tags."
)
# The commits go in as the assistant's response: Guardian is mostly trained to judge responses,
# and on a sample of the bench cases it judged them better this way than as the user's text.
GUARDIAN_SCHEMA = "If the last assistant's text meets the criteria, return 'yes'; otherwise, return 'no'."
DATA_INTRO = ("Make git commits for your change. Reviewers will see the combined diff and each commit's "
              "message.")

# Atla's binary classification training template (github.com/atla-ai/selene-mini).
SELENE_TEMPLATE = """You are tasked with evaluating a response based on a given user input and binary scoring \
rubric that serves as the evaluation standard. Provide comprehensive feedback on the response quality strictly \
adhering to the scoring rubric, followed by a binary Yes/No judgment. Avoid generating any additional opening, \
closing, or explanations.

Here are some rules of the evaluation:
(1) You should prioritize evaluating whether the response satisfies the provided rubric. The basis of your score \
should depend exactly on the rubric. However, the response does not need to explicitly address points raised in \
the rubric. Rather, evaluate the response based on the criteria outlined in the rubric.

Your reply must strictly follow this format:
**Reasoning:** <Your feedback>

**Result:** <Yes or No>

Here is the data:

Instruction:
```
{user_input}
```

Response:
```
{assistant_response}
```

Score Rubrics:
[{rubric_objective}]
Yes: The statement is true of these commits.
No: The statement is false of these commits."""

FORMAT = {
    # (text after which the judgement token comes, tokens to generate)
    "guardian": ("<score>", 32),
    "selene": ("**Result:**", 1024),
}


def criteria(check) -> list[tuple[object, str]]:
    """[(answer value, criterion)]: one criterion for a bool check, one per option otherwise."""
    q = f"Question about the commits: {check.instructions}\nCriterion: the correct answer to the question is"
    if check.question_type == "bool":
        return [(None, f"{q} yes.")]
    if check.question_type == "choice":
        return [(label, f'{q} "{label}" ({desc}).') for label, desc in check.labels.items()]
    return [(i, f"{q} level {i} ({desc}).") for i, desc in enumerate(check.levels)]


def p_yes(raw: str, marker: str) -> tuple[float, str]:
    """P(yes) at the first word after `marker`, from the token probabilities, and the text before it."""
    try:
        tokens = json.loads(raw)["choices"][0]["logprobs"]["content"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        raise BackendError("judge server returned no token probabilities", retryable=True) from None
    text = ""
    for i, tok in enumerate(tokens):
        if marker in text and tok["token"].strip():
            yes = no = 0.0
            seen = set()
            for alt in [tok, *tok.get("top_logprobs", [])]:
                word = alt["token"].strip().lower()
                if alt["token"] in seen:
                    continue
                seen.add(alt["token"])
                if word == "yes":
                    yes += math.exp(alt["logprob"])
                elif word == "no":
                    no += math.exp(alt["logprob"])
            if yes + no == 0:
                break
            return yes / (yes + no), reasoning(text[:text.index(marker)])
        text += tok["token"]
    why = "no yes/no judgement" if marker in text else f"no {marker!r} in the answer"
    raise BackendError(f"judge model gave {why}", retryable=True)


def reasoning(text: str) -> str:
    """The judge's reasoning before its judgement, without think tags or Selene's label."""
    text = re.sub(r"</?think>|</?score>", "", text).replace("**Reasoning:**", "")
    return " ".join(text.split())


class JudgeBackend(LocalBackend):
    name = "judge"

    def __init__(self, settings: dict):
        self.format = settings.get("format", "guardian")
        if self.format not in FORMATS:
            raise BackendError(f"backends.judge.format must be one of {', '.join(FORMATS)}, not {self.format!r}")
        super().__init__({"device": "gpu", "model": RECOMMENDED_MODELS[self.format], **settings})

    def ask(self, system: str, prompt: str, stdin: str, schema: dict, timeout: float) -> dict:
        """Only an empty request (acc doctor's test call) comes here; checks go through `decide`."""
        if schema["properties"]["checks"].get("properties"):
            raise BackendError("the judge backend answers checks through decide(), not a JSON prompt")
        self.ensure_server()
        p_yes(self.post(self.request_for("data", "The data is not empty."), timeout), FORMAT[self.format][0])
        return {"checks": {}}

    def messages(self, stdin: str, criterion: str) -> list[dict]:
        if self.format == "guardian":
            block = f"{GUARDIAN_NOTHINK}\n\n### Criteria: {criterion}\n\n### Scoring Schema: {GUARDIAN_SCHEMA}"
            return [{"role": "user", "content": DATA_INTRO}, {"role": "assistant", "content": stdin},
                    {"role": "user", "content": block}]
        return [{"role": "user", "content": SELENE_TEMPLATE.format(
            user_input=DATA_INTRO, assistant_response=stdin, rubric_objective=criterion)}]

    def request_for(self, stdin: str, criterion: str) -> dict:
        return {"model": self.model, "messages": self.messages(stdin, criterion), "temperature": 0,
                "max_tokens": FORMAT[self.format][1], "logprobs": True, "top_logprobs": TOP_LOGPROBS}

    def decide(self, entries: list[prompt.Entry], stdin: str, timeout: float) -> dict:
        self.ensure_server()
        marker = FORMAT[self.format][0]
        out = {}
        for e in entries:
            c = e.check
            judged = [(value, *p_yes(self.post(self.request_for(stdin, crit), timeout), marker))
                      for value, crit in criteria(c)]
            reasons = [r for _, _, r in judged if r]
            if c.question_type == "bool":
                p, reason = judged[0][1], (reasons[0] if reasons else "")
                out[e.key] = {"answer": round(p, 4), "confidence": round(max(p, 1 - p), 4), "findings": [],
                              "summary": reason or f"P(yes) = {p:.2f} ({self.model})"}
                continue
            total = sum(p for _, p, _ in judged) or 1.0
            probs = {v: p / total for v, p, _ in judged}
            best = max(probs, key=probs.get)
            listed = ", ".join(f"{v} {p:.2f}" for v, p in probs.items())
            best_reason = next((r for (v, _, r) in judged if v == best and r), "")
            out[e.key] = {"answer": best, "confidence": round(probs[best], 4), "findings": [],
                          "answer_probs": [[v, round(p, 4)] for v, p in probs.items()],
                          "summary": f"{listed} ({self.model})" + (
                              f": {best_reason}" if best_reason else "")}
        return {"checks": out}

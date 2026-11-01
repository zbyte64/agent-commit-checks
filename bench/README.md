# Decision model benchmark

How well each model behind acc's backends answers this repo's own checks. The cases come from
this repo's history, so they look like the pushes acc reviews. [decision_models.py](decision_models.py)
builds them and runs every model through the same runner as the gate:

- **Messages** (`commit-message-matches-diff`): 10 commits as they are, and the same 10 diffs with
  the message of an unrelated commit.
- **Tests** (`src-changes-have-tests`): 8 commits that change `src/` and `tests/`, and the same 8
  with their `tests/` files removed.
- **Debug** (`no-debug-leftovers`): 8 Python commits, and the same 8 with
  `print("DEBUG >>>", locals())  # TODO remove` added.

Each cell is *real commits passed · altered commits caught*. Higher is better on both sides; a
model that always answers the same way scores well on one side only. "Caught" is any verdict
other than pass. Every case is reviewed on its own (one model call, or one per option for a
`judge` model), with `run.timeout_seconds = 120` and no batching.
Confidence is the mean over right and wrong verdicts. It is useful when it is lower on wrong ones,
because then `run.min_block_confidence` turns those blocks into warnings. Load is the time to the
first call, including the model download for a new local model. Each file in
[results/](results) has every case's commit, verdict, answer, confidence and time.

## Results (2026-10-31)

Real commits passed · altered commits caught (26 each, 52 cases per model).

| Kind | Model | All | Messages | Tests | Debug | Errors | Confidence right / wrong | Median s | Max s | Load s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | haiku | 25/26 · 25/26 | 10/10 · 9/10 | 7/8 · 8/8 | 8/8 · 8/8 | 1 | 0.95 / 0.72 | 8.1 | 26 | 0 |
| judge | AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF (selene) | 18/26 · 16/26 | 5/10 · 6/10 | 5/8 · 4/8 | 8/8 · 6/8 | 0 | 0.82 / 0.80 | 26.0 | 43 | 670 |
| judge | ibm-granite/granite-guardian-4.1-8b-GGUF:Q4_K_M (guardian) | 23/26 · 15/26 | 8/10 · 0/10 | 8/8 · 7/8 | 7/8 · 8/8 | 0 | 0.80 / 0.66 | 14.9 | 22 | 0 |
| gpu | Qwen/Qwen3-1.7B-GGUF:Q8_0 | 18/26 · 7/26 | 10/10 · 0/10 | 7/8 · 0/8 | 1/8 · 7/8 | 1 | 0.95 / 0.95 | 4.8 | 155 | 205 |
| gpu | Qwen/Qwen3-4B-GGUF:Q8_0 | 24/26 · 9/26 | 10/10 · 0/10 | 6/8 · 8/8 | 8/8 · 1/8 | 0 | 1.00 / 0.97 | 11.6 | 18 | 477 |
| cpu | LiquidAI/LFM2-350M-GGUF:Q8_0 | 17/26 · 11/26 | 6/10 · 5/10 | 8/8 · 1/8 | 3/8 · 5/8 | 9 | 0.80 / 0.76 | 6.4 | 110 | 36 |
| cpu | LiquidAI/LFM2-700M-GGUF:Q8_0 | 20/26 · 6/26 | 9/10 · 2/10 | 8/8 · 0/8 | 3/8 · 4/8 | 2 | 0.84 / 0.82 | 10.6 | 103 | 2 |
| cpu | Qwen/Qwen3-0.6B-GGUF:Q8_0 | 20/26 · 5/26 | 7/10 · 1/10 | 8/8 · 0/8 | 5/8 · 4/8 | 0 | 0.90 / 0.84 | 12.3 | 21 | 0 |
| cpu | Qwen/Qwen3-1.7B-GGUF:Q8_0 | 19/26 · 7/26 | 10/10 · 0/10 | 8/8 · 0/8 | 1/8 · 7/8 | 0 | 0.97 / 0.96 | 22.9 | 32 | 4 |
| cpu | unsloth/gemma-3-270m-it-GGUF:Q8_0 | 14/26 · 11/26 | 1/10 · 8/10 | 7/8 · 1/8 | 6/8 · 2/8 | 2 | 0.95 / 0.90 | 3.2 | 39 | 1 |
| tiny | HuggingFaceTB/SmolLM2-135M-Instruct:onnx/model_int8.onnx | 19/26 · 8/26 | 10/10 · 0/10 | 8/8 · 0/8 | 1/8 · 8/8 | 0 | 0.77 / 0.79 | 2.1 | 4 | 20 |
| tiny | HuggingFaceTB/SmolLM2-360M-Instruct:onnx/model_int8.onnx | 22/26 · 2/26 | 10/10 · 0/10 | 8/8 · 0/8 | 4/8 · 2/8 | 0 | 0.83 / 0.81 | 4.1 | 9 | 1 |
| tiny | onnx-community/Qwen2.5-0.5B-Instruct:onnx/model_int8.onnx | 16/26 · 7/26 | 6/10 · 2/10 | 8/8 · 0/8 | 2/8 · 5/8 | 0 | 0.75 / 0.73 | 5.7 | 9 | 57 |

Cases from rev 6befd26; run on AMD Ryzen 9 7940HS w/ Radeon 780M Graphics.

The local runs used llama.cpp b12017 (`gpu`: the Vulkan build on the Radeon 780M, with 30 GB of
shared memory; `cpu`: `--device none`; `judge`: Q4_K_M builds on the Vulkan build) and onnxruntime
1.31 (`tiny`, int8 exports). Haiku ran through `claude -p` with acc's usual flags. The Guardian
run's load time is 0 because its server was already up from tuning its prompt.

`judge` models are trained to judge one criterion with yes or no, unlike the chat models above.
Granite Guardian answers at once; Selene writes its reasoning first. Each choice check costs one
call per label. Guardian's prompt (commits as the assistant's response, criterion "the correct
answer to the question is X") was picked from three variants on 8 of the 52 cases.

## Findings

- **Only Haiku is a reliable reviewer.** It passed 25 of 26 real commits and caught 25 of 26
  altered ones. Its one miss (a swapped message on `993d83e`) had confidence 0.72, and its one
  real-commit block was a backend error (`no structured_output`), not a verdict.
- **Granite Guardian 4.1 8B is the best local model, by a wide margin.** On the tests and debug
  checks it passed 15 of 16 real commits and caught 15 of 16 altered ones, close to Haiku. It is
  also the only local model whose confidence separates right from wrong (0.80 against 0.66): both
  of its blocks on real commits had confidence below 0.7, so with the default
  `run.min_block_confidence` it would have blocked no real commit, while still blocking 8 altered
  ones outright and warning on 7 more. It takes about 15 s a check.
- **No local model can tell a swapped commit message from the real one.** Guardian caught none of
  the 10. The rest flagged real messages about as often as swapped ones (Selene: 5 and 6 of 10;
  Gemma 270M: 9 and 8; LFM2 350M: 4 and 5), and Qwen3-1.7B and Qwen3-4B answered `accurate` for
  all 10 swapped messages.
- **Selene 1 Mini, the other judge, is no better than the chat models.** Its reasoning first
  makes it the slowest local model (26 s a check), and it was at chance on messages and tests.
- **Among chat models, Qwen3-4B on the GPU is best.** It caught every commit with its tests
  removed and passed every real commit for the debug check, but it missed 7 of 8 added debug
  prints. It takes about 12 s a call.
- **The smaller models mostly answer the same way whatever the diff.** SmolLM2-135M said yes to
  debug code on 15 of 16 cases and passed every message; SmolLM2-360M passed nearly everything.
- **Confidence does not save the other local models.** Measured from token probabilities (see
  the README), it is about as high on their wrong verdicts as on their right ones. Haiku's
  self-reported confidence separates the two (0.95 against 0.72).
- **Speed:** tiny models answer in 2–6 s, CPU llama-server in 3–23 s, GPU Qwen3-4B in 12 s,
  Guardian in 15 s, Selene in 26 s, and Haiku in 8 s.

So only Haiku can gate every check. Granite Guardian (the `judge` preset) is good enough to gate
checks like the tests and debug ones where the diff must stay on the machine, but not commit
messages. The other local options are for advisory checks. The presets use Granite Guardian for
`judge`, Qwen3-4B for `gpu`, Qwen3-0.6B for `cpu` and SmolLM2-360M for `tiny`.
On the CPU, Qwen3-1.7B was no better than Qwen3-0.6B (it said yes to debug code on 14 of 16
cases) and took twice as long, so the `cpu` preset takes the smaller model. Qwen3-4B was not run
on the CPU: at about four times Qwen3-1.7B's 23 s a call, it would not fit the default 90 s
timeout. For `tiny`, SmolLM2-360M blocks the fewest real commits.

## Re-running

```sh
uv run python bench/decision_models.py claude haiku --rev 6befd26 --out bench/results/claude-haiku.json
uv run python bench/decision_models.py gpu Qwen/Qwen3-4B-GGUF:Q8_0 --rev 6befd26 \
    --server ~/.local/opt/llama.cpp/vulkan/llama-b12017/llama-server --out bench/results/gpu-qwen3-4b-gguf.json
uv run python bench/decision_models.py judge ibm-granite/granite-guardian-4.1-8b-GGUF:Q4_K_M --format guardian \
    --rev 6befd26 --out bench/results/judge-granite-guardian-4.1-8b.json
uv sync --extra tiny
uv run python bench/decision_models.py tiny HuggingFaceTB/SmolLM2-360M-Instruct:onnx/model_int8.onnx \
    --rev 6befd26 --out bench/results/tiny-smollm2-360m-instruct.json
uv run python bench/report.py
```

`--rev 6befd26` rebuilds the same 52 cases. A later rev gives cases from newer history.

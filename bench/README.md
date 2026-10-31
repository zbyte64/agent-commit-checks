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
other than pass. Every case is its own call, with `run.timeout_seconds = 120` and no batching.
Confidence is the mean over right and wrong verdicts. It is useful when it is lower on wrong ones,
because then `run.min_block_confidence` turns those blocks into warnings. Load is the time to the
first call, including the model download for a new local model. Each file in
[results/](results) has every case's commit, verdict, answer, confidence and time.

## Results (2026-10-31)

Real commits passed · altered commits caught (26 each, 52 calls per model).

| Kind | Model | All | Messages | Tests | Debug | Errors | Confidence right / wrong | Median s | Max s | Load s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | haiku | 25/26 · 25/26 | 10/10 · 9/10 | 7/8 · 8/8 | 8/8 · 8/8 | 1 | 0.95 / 0.72 | 8.1 | 26 | 0 |
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
shared memory; `cpu`: `--device none`) and onnxruntime 1.31 (`tiny`, int8 exports). Haiku ran
through `claude -p` with acc's usual flags.

## Findings

- **Only Haiku is a reliable reviewer.** It passed 25 of 26 real commits and caught 25 of 26
  altered ones. Its one miss (a swapped message on `993d83e`) had confidence 0.72, and its one
  real-commit block was a backend error (`no structured_output`), not a verdict.
- **No local model can tell a swapped commit message from the real one.** Each flagged real
  messages about as often as swapped ones (Gemma 270M: 9 and 8 of 10; LFM2 350M: 4 and 5), and
  Qwen3-1.7B and Qwen3-4B answered `accurate` for all 10 swapped messages.
- **Qwen3-4B on the GPU is the best local model.** It caught every commit with its tests removed
  and passed every real commit for the debug check, but it missed 7 of 8 added debug prints.
  It takes about 12 s a call.
- **The smaller models mostly answer the same way whatever the diff.** SmolLM2-135M said yes to
  debug code on 15 of 16 cases and passed every message; SmolLM2-360M passed nearly everything.
- **Confidence does not save the local models.** Measured from token probabilities (see the
  README), it is about as high on their wrong verdicts as on their right ones. Haiku's
  self-reported confidence separates the two (0.95 against 0.72).
- **Speed:** tiny models answer in 2–6 s, CPU llama-server in 3–23 s, GPU Qwen3-4B in 12 s,
  and Haiku in 8 s.

So the local options are for privacy or offline use, as advisory checks, and not as a gate that
blocks.

## Re-running

```sh
uv run python bench/decision_models.py claude haiku --rev 6befd26 --out bench/results/claude-haiku.json
uv run python bench/decision_models.py gpu Qwen/Qwen3-4B-GGUF:Q8_0 --rev 6befd26 \
    --server ~/.local/opt/llama.cpp/vulkan/llama-b12017/llama-server --out bench/results/gpu-qwen3-4b-gguf.json
uv sync --extra tiny
uv run python bench/decision_models.py tiny HuggingFaceTB/SmolLM2-360M-Instruct:onnx/model_int8.onnx \
    --rev 6befd26 --out bench/results/tiny-smollm2-360m-instruct.json
uv run python bench/report.py
```

`--rev 6befd26` rebuilds the same 52 cases. A later rev gives cases from newer history.

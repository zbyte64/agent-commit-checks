# agent-commit-checks (`acc`)

Model-backed checks on the commits a coding agent is about to push. The gate sits on the
agent's `git push`. Blocked pushes return findings to the agent as the tool error.
Checks are TOML files in the project, run on a cheap model through the agent's own login,
and are also exposed to the agent as tools.

Three agents are supported, all with the same runner and check tools:

| Agent | Gate | Check tools | Backend (model calls) |
| --- | --- | --- | --- |
| Claude Code | `acc gate` as a `PreToolUse` hook | `acc mcp` (MCP server) | `claude -p` |
| oh-my-pi (omp) | the acc extension, on the `bash` tool | registered by the extension | `omp -p` |
| [pi](https://pi.dev) | the acc extension, on the `bash` tool | registered by the extension | `pi -p` |

acc is TypeScript. One package is the `acc` CLI, the omp extension and the pi extension.

## Install

For omp or pi, install the extension; nothing else is needed:

```sh
omp install git:github.com/zbyte64/agent-commit-checks
pi install git:github.com/zbyte64/agent-commit-checks
```

For Claude Code, or to run `acc` in a shell, install the CLI with npm (Node 22 or later) or bun:

```sh
npm install -g github:zbyte64/agent-commit-checks   # or: bun install -g github:zbyte64/agent-commit-checks
acc --help
```

Use the absolute path of the installed `acc` in hook and MCP configs. A process started from
VS Code may not see your shell `PATH`. Inside omp and pi, the `/acc` command runs the same CLI
(`/acc list`, `/acc grade <id>`, `/acc doctor`, ...) in the session's project.

In `.acc/config.toml`, backend `command` paths may use `~` or environment variables such as
`$HOME` (e.g. `command = "~/.local/bin/claude"`). The file is committed, so it doesn't need
to name a user. `acc init` writes paths under your home directory this way.

## Set up a project

A project opts in by having a `.acc/` directory. In repos without one, the gate allows every push.

### Claude Code

```sh
cd my-project
acc init      # creates .acc/ (config + 2 sample checks) and prints the snippets below
acc doctor    # checks the claude binary, auth (one tiny call), config and check files
```

Put the **hook** in `~/.claude/settings.json` (all projects) or `.claude/settings.local.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ {
  "type": "command", "if": "Bash(git push*)",
  "command": "/home/you/.local/bin/acc", "args": ["gate", "--agent", "claude"],
  "timeout": 180, "statusMessage": "Running push checks", "onFailure": "block" } ] } ] } }
```

`args`, `if` and `onFailure` need Claude Code 2.1.295 or later, and `acc doctor` warns on older versions.
`acc gate` re-checks the command itself, so the `if` filter is only an optimisation.

Put the **MCP server** in `.mcp.json`:

```json
{ "mcpServers": { "acc": { "command": "/home/you/.local/bin/acc", "args": ["mcp", "--agent", "claude"] } } }
```

### oh-my-pi (omp)

After `omp install git:github.com/zbyte64/agent-commit-checks`, restart omp and, in the project:

```text
/acc init      # creates .acc/ and prints the omp setup (same as `acc init --omp`)
/acc doctor    # checks the omp binary, the model role, auth (one tiny call) and the extension
```

The extension runs the gate in the omp process before every `bash` tool call that mentions `git`
and `push`. A `block` verdict stops the call and returns the findings to the model as the tool
error. A `warn` verdict lets the push run and adds the findings to the model's context after the
tool result. Any failure inside the gate blocks the push. The check tools (`list_checks`,
`run_checks`, `test_check`, `grade_check`, `add_check`, `update_check`, `promote_check`) are
registered as omp tools, so no MCP server is needed.

The omp backend uses the `@decision` model role. Define it once in `~/.omp/agent/config.yml`,
or per project in `.omp/config.yml`:

```yaml
modelRoles:
  decision: anthropic/claude-haiku-5-5
```

omp stops a `tool_call` handler after `extensionHandlers.toolCallTimeoutMs` (30 s by default)
and then blocks the push. A gate run can take up to two rounds of `run.timeout_seconds`, so in
an acc project the extension raises the setting to that budget (180 s by default) for the omp
session. It leaves the setting alone if you set it yourself.

**Upgrading from the Python version:** it installed `~/.omp/agent/extensions/acc.ts`, which calls
`acc gate --agent omp`. That command is gone, so delete the file; `/acc doctor` reports it. Also
remove an `acc` entry from `.omp/mcp.json`: the extension registers the same tools.

### pi

After `pi install git:github.com/zbyte64/agent-commit-checks`, restart pi (or run `/reload`) and,
in the project:

```text
/acc init      # creates .acc/ and prints the pi setup (same as `acc init --pi`)
/acc doctor    # checks the pi binary, the model, auth (one tiny call) and the extension
```

The extension gates pushes like the omp one. pi's `tool_call` handlers can only block, so a `warn`
verdict is appended to the `bash` tool's result instead. pi has no model roles: the `pi` backend
calls `pi -p --model <backends.pi.model>`, by default `anthropic/claude-haiku-4-5`. Set it to a
`provider/model` pi is logged in to (`pi --list-models`):

```toml
[backends.pi]
command = "~/.local/bin/pi"
model = "anthropic/claude-haiku-4-5"
```

### Local model

Instead of the agent's own model, every check can run on a small decision model on this machine.
It needs no login or network after the first download, and the diff never leaves the machine.
There are four options:

| `acc init --local …` | Runs | Needs |
| --- | --- | --- |
| `tiny` | a small ONNX model in-process, as a classifier | `onnxruntime-node` and `@huggingface/tokenizers` |
| `cpu` (default) | a small chat model in llama.cpp's `llama-server`, on the CPU | `llama-server` (any build) |
| `gpu` | a larger chat model in `llama-server`, on the GPU | a GPU build: Vulkan (AMD, Intel), CUDA or ROCm |
| `judge` | a yes/no judge model (Granite Guardian 4.1 8B) in `llama-server`, on the GPU | a GPU build, ~5 GB of model |

```sh
acc init --local gpu   # sets run.backend and the backend's model in .acc/config.toml
acc doctor             # loads the model (downloading it on first use) and makes a test call
```

`run.backend` overrides the `claude`, `omp` and `pi` backends for every agent. An
`[agents.<name>] backend` entry still wins for that agent. Running `acc init --local` again with
another option switches the project to it.

**cpu and gpu.** The `local` backend needs llama.cpp's `llama-server`
([prebuilt releases](https://github.com/ggml-org/llama.cpp/releases)). A GPU build also serves
`device = "cpu"`. Put it on `PATH` or set `server` to its absolute path:

```toml
[backends.local]
url = "http://127.0.0.1:8763"
model = "Qwen/Qwen3-0.6B-GGUF:Q8_0"   # Hugging Face GGUF repo:quant
device = "cpu"                         # "gpu" offloads every layer; "cpu" turns GPUs off
server = "~/.local/bin/llama-server"   # "" if you run the server yourself
# server_args = ["--ctx-size", "16384", "--parallel", "2"]
# startup_seconds = 300                # the first start downloads the model
```

If nothing answers at `url`, acc starts `llama-server -hf <model>` in the background and leaves it
running for later pushes. Its output goes to `~/.local/share/acc/llama-server.log`. If the running
server holds a different model (for example after switching options), acc refuses to use it and
says how to stop it. `acc doctor` lists the GPUs a `llama-server` build can use. Any server with an
OpenAI-style `/v1/chat/completions` that supports `json_schema` response formats also works, e.g.
Ollama with `url = "http://127.0.0.1:11434"`, an Ollama tag as `model`, and `server = ""`.
Confidence is measured only when the server returns `logprobs`.

**judge.** The `judge` backend runs a model trained to judge one criterion with yes or no, in
`llama-server` like `cpu` and `gpu`. It asks a `bool` check as one criterion ("the correct answer
to the question is yes") and a `choice` or `score` check as one criterion per option. It reads
P(yes) from the token probabilities, so the answer to a `bool` check is a probability and the
confidence of a `choice` is the probability of its verdict. The data comes first in each prompt,
so the server reuses it from its cache for each option.

```toml
[backends.judge]
format = "guardian"   # or "selene" (Atla Selene 1 Mini, which writes its reasoning first)
model = "ibm-granite/granite-guardian-4.1-8b-GGUF:Q4_K_M"
device = "gpu"
url = "http://127.0.0.1:8763"
server = "~/.local/bin/llama-server"
```

**tiny.** The `tiny` backend runs an ONNX export of a ChatML model (SmolLM2, Qwen2.5, Qwen3) with
onnxruntime, in the acc process, with no server. acc does not install its two packages by
default; add them where acc's package can import them, e.g. next to a global acc:
`npm install -g onnxruntime-node @huggingface/tokenizers`. The model files are downloaded from
Hugging Face into `~/.cache/acc/models` on first use.

```toml
[backends.tiny]
model = "HuggingFaceTB/SmolLM2-360M-Instruct"
file = "onnx/model_int8.onnx"
```

The tiny model does not write an answer. For each check it reads the prompt once, and acc reads
its next-token probabilities over the possible answers: `yes` or `no` for a `bool` check, whose
answer is P(yes), and the option numbers for a `choice` or `score` check. Confidence is the
probability of the verdict. It reports no findings, and its summary lists the probabilities.

**How good are they?** On 52 cases from this repo's history ([bench/README.md](bench/README.md)),
Haiku passed 25 of 26 real commits and caught 25 of 26 altered ones (a swapped message, tests
removed, or a debug print added). The `judge` preset (Granite Guardian, 15 s a check) passed 23
and caught 15: on the tests and debug checks it was close to Haiku, and both of its blocks on
real commits had confidence below 0.7, so they would only warn. Like every local model, it could
not tell a swapped commit message from the real one. The chat models did worse: the `gpu`
preset (Qwen3-4B, 12 s) passed 24 and caught 9, and the `cpu` (Qwen3-0.6B, 12 s) and `tiny`
(SmolLM2-360M, 4 s) presets passed 20 and 22 and caught 5 and 2, with confidence as high on
wrong verdicts as on right ones. Use `judge` where the diff must not leave the machine, and keep
checks it cannot judge, like commit messages, `advisory`.

## Check files

`.acc/checks/<id>.toml`. See [examples/.acc/checks](examples/.acc/checks) for one check of each type.

| `question.type` | `answer` from the model | `[verdict]` |
| --- | --- | --- |
| `bool` | probability (0–1) that the answer to the question is **yes** | `block_at`, `warn_at` thresholds |
| `choice` | one label | label → `pass` / `warn` / `block` |
| `score` | index into `levels`, ordered **best to worst** | `block_at`, `warn_at` level indexes |

Phrase `bool` questions so that "yes" means there is a problem.

Every answer also carries a `confidence` from 0 to 1: how sure the model is of its answer. The
backends are chat models acting as decision models, so the answer schema asks for it alongside
the answer. A `block` answered with confidence below `run.min_block_confidence` (default 0.7)
becomes a `warn` that says "low confidence", in the gate and in grades. An answer without a
valid confidence is invalid and is retried alone, like a missing answer.

The `local` and `tiny` backends measure confidence instead of asking for it: a small model writes
1.0 almost every time. They read the model's token probabilities at the answer and add up the
probability of every answer that gives the same verdict. A model that wrote `0.0` for a `bool`
check but put 27% on `0.9` gets confidence 0.73 for its `pass`.

A check answers once for the whole push. The model sees the combined diff of every pushed
commit and each commit's message, prefixed by its short sha. There is no per-commit mode.
Secrets are still scanned in each commit, so one that is added and then deleted in a later
commit still blocks the push.

Statuses: `proposed` checks run only when named, `advisory` checks run in the gate but only
warn, and `active` checks can block. `active` needs a passing grade (`acc grade <id>`) for the
check's current contents. The grade hash ignores the `status` line, so promotion does not
invalidate it.

A grade reviews ranges of commits the way the gate reviews a push: each unit is one model call
on that range's combined diff and messages, and units never share a call. By default a grade
samples about 20 relevant first-parent commits from the default branch, each as a one-commit
range. `--range A..B` grades that range as one unit, and can be repeated to grade several
ranges. `--commits` grades each listed commit as its own one-commit range. `expect_fail` entries
may be commits or `A..B` ranges. Excluded units are listed with a reason (no matching path, empty
diff, secret-scan hit, holds the commit that added the check, no commits in range). The grade
records how its sample was chosen. The `promote_check` tool needs an automatic grade to
reach `active`, so an agent cannot hand-pick easy commits. `acc promote` accepts either kind.
`grading.min_sample` counts ranges, so a grade on fewer ranges is `insufficient`. A
low-confidence block counts as a warning in the block rate. The grade reports how many there
were, and records each unit's confidence.

## Commands

| Command | Purpose |
| --- | --- |
| `acc gate --agent claude` | PreToolUse hook: reads the payload on stdin, prints hook JSON |
| `acc run [--check id] [--range unpushed\|A..B] [--json]` | run checks on demand (exit 0 pass, 1 warn, 2 block, 3 error) |
| `acc grade <id> [--sample N] [--commits REV... \| --range A..B ...]` | grade against history (or chosen commits or ranges), write `.acc/grades/<id>.json` |
| `acc list`, `acc validate [file]` | inspect and schema-check checks |
| `acc promote <id> [--to advisory\|active] [--force]` | change status |
| `acc init [--omp\|--pi] [--local]`, `acc doctor [--agent omp\|pi]`, `acc mcp` | setup (`--local`: run checks on a local model), diagnostics, MCP server |

In omp and pi, `/acc <command>` runs these in the session's project, with `--agent` set to the
agent (`gate` and `mcp` read stdin and only run from a shell).

Logs: `~/.local/share/acc/logs/YYYY/MM/DD/events.jsonl` (override with `ACC_LOG_DIR`). The log
holds hashes and sizes only, never diff text or secrets.

## Notes and deviations from the handoff

- The `claude -p` call uses `--max-turns 4`. Structured output takes a StructuredOutput tool
  call plus a final turn, so `--max-turns 1` always ends in `error_max_turns`. A tool call
  that fails schema validation costs another turn, and `--max-turns 2` failed on about 1 in
  4 grading calls.
- `--tools ""` disables all tools (an open question in the handoff). The call also uses
  `--strict-mcp-config`, `--setting-sources ""` and `--system-prompt`. Together these flags
  cut a call from about 86K input tokens and $0.11 to about 2.4K tokens and $0.006.
- Thinking is always off, so Claude behaves like a decision model and returns the typed
  answer directly (4–6s per call). The call sets `alwaysThinkingEnabled: false` and
  `MAX_THINKING_TOKENS=0`. The second is needed because hooks inherit the agent's
  environment, where `MAX_THINKING_TOKENS` would turn thinking back on.
- The parser accepts both output shapes: a single result object, and the event array
  produced when verbose output is on.
- Secret-scan `warn` patterns (env-var dumps, password assignments) do not block. Matching
  lines are redacted before the diff goes to the model. `block` patterns block with no
  model call.
- `update_check` on an `active` check moves it back to `advisory`, because its grade is cleared.
- Every check reviews the whole pushed range as one unit. The handoff's `per_commit` scope and
  `run.max_commits` are gone, and a check file with a `scope` line fails validation. A push
  makes one call per `max_checks_per_call` checks.
- Separately graded ranges never share a model call. When 8 commits, each to be judged on its
  own, shared a prompt, each answer depended on the others: on this repo's history, Haiku judged
  `ddc489c` one way in 3 of 3 batched runs and the other way in 3 of 3 runs alone. A grade makes
  one call per sampled range, plus one per rerun.
- acc was first written in Python and ported to TypeScript, so one package serves the CLI and
  both extensions. The extensions import the gate and run it in the agent's process; nothing is
  copied or configured with an `acc` path. `package.json` declares both manifests:
  `omp.extensions` (`src/adapters/omp`) and `pi.extensions` (`src/adapters/pi`). omp prefers its
  own key, so each agent loads its own adapter.
- Grades written by the Python version stay valid: the check hash is unchanged. A grade's
  random sample is drawn differently, so re-grading picks other `random` units than before.
- The `omp -p` call adds `--no-extensions`, `--no-skills`, `--no-rules`, `--no-context-files`,
  `--no-lsp`, `--no-title`, `--thinking off` and `--system-prompt` to the handoff's flags.
  `--no-extensions` keeps this extension out of the spawned run, so the gate cannot recurse.
  A gate run with Haiku took 2.0–2.9 s.
- The `omp -p` call also loads a `--config` overlay that sets `memory.backend: off`. With a
  memory backend on, omp stored each review prompt, including the diff. It recalled that
  prompt in the next call from the same repo. In a live run, a push after an amend was blocked
  on the diff from before the amend.
- `omp -p` has no schema flag, so the answer schema goes in the prompt. The parser reads the
  last assistant `message_end` event. It tolerates code fences, and the runner retries missing
  or invalid entries alone.
- `omp -p` puts piped stdin before the prompt, separated by a blank line. If `@decision` is
  not defined, omp exits 1 with `Model "@decision" not found` and does not fall back to another
  model. The backend error tells you which `modelRoles` entry to add.
- The omp extension resolves the `bash` tool's optional `cwd` input against the session
  directory and gates the push there.
- The `pi -p` call uses `--no-session`, `--no-tools`, `--no-extensions`, `--no-skills`,
  `--no-prompt-templates`, `--no-themes`, `--no-context-files`, `--no-mcp`, `--offline` and
  `--thinking off`. Like omp, it has no schema flag and puts piped stdin with the prompt. Provider
  errors arrive as JSON inside the error message; the backend reports the provider's own message.
  A gate run with Gemini 3.1 Flash Lite took 1.2 s.
- Secret patterns are ported from [dev-decisions](https://github.com/adelvillar1/dev-decisions)
  (Apache-2.0); see `src/secrets.ts`.

## Development

```sh
bun install
bun test
bunx tsc -p .
```

The source is TypeScript that runs unbuilt: Bun runs it directly (omp is built on Bun), and
Node loads it through [jiti](https://github.com/unjs/jiti) (pi, and `bin/acc.mjs` under Node).
Tests use `backend = "fake"` (`[agents.claude] backend = "fake"`, answers from a JSON file) and
throwaway repos with a local bare remote. `tests/extensions.test.ts` loads both extensions against
a stand-in host API.

To try a checkout in an agent: `omp install .` links it into omp, and `pi install .` adds it to pi.

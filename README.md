# agent-commit-checks (`acc`)

[![npm](https://img.shields.io/npm/v/agent-commit-checks)](https://www.npmjs.com/package/agent-commit-checks)
[![CI](https://github.com/zbyte64/agent-commit-checks/actions/workflows/ci.yml/badge.svg)](https://github.com/zbyte64/agent-commit-checks/actions/workflows/ci.yml)

Model-backed review of the commits a coding agent is about to push. When the agent runs
`git push`, acc asks a cheap model your project's own questions about the pushed commits ("Is
debugging code left in?", "Does the message describe the diff?", "Do source changes come with
tests?") and blocks the push if the answer is bad. The findings go back to the agent as the
error of its `git push`, so it can fix the commits and push again. This is what an agent got back
for a commit that added `print("debug")`:

```text
acc: push blocked (1 commit reviewed together).
- [block] no-debug-leftovers (answer: 0.9, confidence 0.95): The only added line is a bare print("debug") call, which is clearly leftover debugging code rather than intentional logging.
    Added line `print("debug")` is a temporary debugging print statement left in the code. (app.py:1)
Fix these with a new commit, or by amending or rebasing the unpushed commits, then run the push again as its own command.
```

- Checks are TOML files committed with the project, in `.acc/checks/`.
- Models are called through the agent's own login (no API key), or run on this machine.
- The agent can list, run, write and grade checks itself, through tools.
- A local secret scan blocks pushes that contain likely credentials, before any model sees them.
- Only pushes are gated; the agent commits freely while it works.

Supported agents:

| Agent | Install | Model calls go through |
| --- | --- | --- |
| [pi](https://pi.dev) | `pi install npm:agent-commit-checks` | `pi -p` |
| [oh-my-pi](https://omp.sh) (omp) | `omp install npm:agent-commit-checks` | `omp -p` |
| Claude Code | `npm install -g agent-commit-checks`, then a hook | `claude -p` |

## Quick start

A project opts in by having a `.acc/` directory at its git root. Pushes from repos without one are
never checked.

### pi

```sh
pi install npm:agent-commit-checks
```

Restart pi (or run `/reload`), then in your project:

```text
/acc init      # creates .acc/ with a config and two sample checks
/acc doctor    # checks the setup and makes one tiny model call
```

pi has no model roles, so acc calls `pi -p --model <backends.pi.model>`. The default is
`anthropic/claude-haiku-4-5`. If you are logged in to another provider, set a `provider/model`
from `pi --list-models` in `.acc/config.toml`:

```toml
[backends.pi]
model = "google/gemini-3.1-flash-lite"
```

### oh-my-pi (omp)

```sh
omp install npm:agent-commit-checks
```

Restart omp, then in your project run `/acc init` and `/acc doctor`. acc calls `omp -p --model
@decision`, so define the `decision` role once in `~/.omp/agent/config.yml` (or per project in
`.omp/config.yml`), or pick it in omp's `/model` Roles view:

```yaml
modelRoles:
  decision: anthropic/claude-haiku-5-5
```

### Claude Code

```sh
npm install -g agent-commit-checks   # or: bun install -g agent-commit-checks
cd my-project
acc init      # creates .acc/ and prints the hook and MCP snippets below
acc doctor
```

The `acc` command runs on Bun if it is on `PATH`, else on Node 22 or later. Use its absolute path
(`which acc`) in the configs below: a process started from VS Code may not see your shell `PATH`.

Put the **hook** in `~/.claude/settings.json` (all projects) or `.claude/settings.local.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ {
  "type": "command", "if": "Bash(git push*)",
  "command": "/home/you/.bun/bin/acc", "args": ["gate", "--agent", "claude"],
  "timeout": 180, "statusMessage": "Running push checks", "onFailure": "block" } ] } ] } }
```

`args`, `if` and `onFailure` need Claude Code 2.1.295 or later; `acc doctor` warns on older
versions.

Put the **MCP server** (the check tools) in `.mcp.json`:

```json
{ "mcpServers": { "acc": { "command": "/home/you/.bun/bin/acc", "args": ["mcp", "--agent", "claude"] } } }
```

### Next: make a check able to block

`acc init` adds two checks, `no-debug-leftovers` and `commit-message-matches-diff`, as
**advisory**: they run on every push but only warn. A check blocks only once it is **active**, and
it becomes active only after a passing grade on your project's own history, so a check that would
block good commits never gets there:

```sh
acc grade no-debug-leftovers      # reviews ~20 past commits; passes if few would have been blocked
acc promote no-debug-leftovers    # advisory -> active, refused without a passing grade
```

In omp and pi, run these as `/acc grade …` and `/acc promote …`, or ask the agent to use its
`grade_check` and `promote_check` tools.

## How it works

1. The agent runs a shell command. acc parses it: anything that is not a `git push` passes at
   once. A command that commits and pushes in one step is refused, because the new commit cannot
   be reviewed before it is pushed.
2. acc works out which commits the push sends, from local refs (no fetch).
3. The secret scan reads each of those commits. A likely credential blocks the push with no model
   call; lines that only might be secrets are redacted before review.
4. Each `advisory` and `active` check whose `applies_to` globs match a changed file answers its
   question once about the whole push: the combined diff, every commit message, or the file list.
5. The worst verdict wins. `block` stops the push and returns the findings as the tool error.
   `warn` lets the push run and shows the findings to the agent. A block the model is not sure of
   (confidence below `run.min_block_confidence`) is reported as a warning.

If acc itself fails (no backend, invalid config, a crash), the push is blocked with the error. A
backend error counts as `run.on_backend_error`, by default `block`.

## Check files

Each check is `.acc/checks/<id>.toml`. [examples/.acc/checks](https://github.com/zbyte64/agent-commit-checks/tree/main/examples/.acc/checks) has one of
each question type. This one blocks a push that adds debugging code:

```toml
id = "no-debug-leftovers"
title = "No leftover debugging code"
status = "advisory"            # proposed | advisory | active
applies_to = ["**/*.py", "**/*.ts"]
inputs = ["diff"]              # any of diff, message, file_list

[question]
type = "bool"
instructions = "Do the added lines leave temporary debugging code behind, such as print or console.log calls used for debugging?"

[verdict]
block_at = 0.85                # the model's probability that the answer is yes
warn_at = 0.5

[grading]
terms = ["console.log", "print("]   # past commits with these are sampled first when grading
```

| `question.type` | The model answers | `[verdict]` |
| --- | --- | --- |
| `bool` | the probability (0–1) that the answer is **yes** | `block_at`, `warn_at` thresholds |
| `choice` | one of `question.labels` | each label → `pass`, `warn` or `block` |
| `score` | an index into `question.levels`, ordered best to worst | `block_at`, `warn_at` level indexes |

Phrase `bool` questions so that "yes" means there is a problem. `acc validate` checks every file.

**Statuses.** `proposed` checks run only when named (`acc run --check <id>`). `advisory` checks
run on every push and only warn. `active` checks can block, and need a passing grade for the
check's current contents; editing a check makes its grade stale.

**Grading.** `acc grade <id>` samples about 20 past commits from the default branch that touch the
check's `applies_to` paths, reviews each one as a push, and asks it again where it warned or
blocked. It passes when at most `grading.max_block_rate` (10%) would have been blocked, no call
failed, and at most `grading.max_unstable` answers changed on the second ask. List known-bad
commits or `A..B` ranges in `grading.expect_fail`; the grade then also requires the check to
catch every one. `--commits` and `--range` grade chosen commits instead; such a grade lets you
promote a check with `acc promote`, but not an agent with `promote_check`, so an agent cannot pick
easy commits to pass its own check. Results go to `.acc/grades/<id>.json`; commit them with the
checks.

**Agent-written checks.** The agent drafts a check, tries it with `test_check`, saves it with
`add_check` (as `proposed`), grades it with `grade_check` and promotes it with `promote_check`.
It may edit only checks it wrote, and an edit drops an active check back to advisory.

## Configuration

`.acc/config.toml` (all keys optional; `acc init` writes one with comments):

```toml
[backends.claude]
command = "~/.local/bin/claude"   # `~` and $VARS are expanded, so the file can be committed
model = "haiku"

[backends.omp]
command = "~/.bun/bin/omp"
model = "@decision"

[backends.pi]
command = "~/.local/bin/pi"
model = "anthropic/claude-haiku-4-5"

[run]
# backend = "local"         # use this backend for every agent instead of the agent's own
max_diff_chars = 12000       # diff shown to the model per push; larger diffs are clipped per file
timeout_seconds = 90         # per model call
on_backend_error = "block"   # or "warn"
min_block_confidence = 0.7   # less sure blocks only warn
secret_scan = true
# exclude_globs = ["**/package-lock.json", "**/*.min.js"]   # never shown to the model

[grading]
sample_size = 20
min_sample = 10
max_block_rate = 0.10
max_unstable = 1
```

To route one agent to another backend: `[agents.claude] backend = "local"`.

## Local models

Every check can run on a model on this machine instead: no login, no network after the first
download, and the diff never leaves the machine.

| `acc init --local …` | Runs | Needs |
| --- | --- | --- |
| `judge` | a yes/no judge model (Granite Guardian 4.1 8B) in llama.cpp's `llama-server`, on the GPU | a GPU build of `llama-server`, ~5 GB of model |
| `gpu` | a chat model (Qwen3-4B) in `llama-server`, on the GPU | a GPU build: Vulkan (AMD, Intel), CUDA or ROCm |
| `cpu` (default) | a small chat model (Qwen3-0.6B) in `llama-server`, on the CPU | `llama-server`, any build |
| `tiny` | a small ONNX model (SmolLM2-360M) inside acc, no server | `onnxruntime-node` and `@huggingface/tokenizers`, installed beside acc (`npm install -g …` or `bun install -g …` for a global acc) |

```sh
acc init --local judge   # sets run.backend and the model in .acc/config.toml
acc doctor               # starts the model (downloading it on first use) and makes a test call
```

acc starts `llama-server` itself when nothing answers at `backends.local.url` (or
`backends.judge.url`) and leaves it running for later pushes; its log is
`~/.local/share/acc/llama-server.log`. Get `llama-server` from the
[llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) and put it on `PATH` or set
`server` to its path. Any OpenAI-compatible server with `json_schema` response formats works too,
e.g. Ollama: `url = "http://127.0.0.1:11434"`, an Ollama tag as `model`, and `server = ""`.

**Which to use.** On 52 cases from this repo's history ([bench/README.md](https://github.com/zbyte64/agent-commit-checks/blob/main/bench/README.md)), Haiku
passed 25 of 26 good commits and caught 25 of 26 bad ones. `judge` passed 23 and caught 15: close
to Haiku on debug code and missing tests, but no local model could tell a swapped commit message
from the real one. `gpu`, `cpu` and `tiny` caught 9, 5 and 2. Use `judge` where the diff must not
leave the machine, and keep checks it cannot judge, such as commit messages, `advisory`.

## Commands

| Command | Purpose |
| --- | --- |
| `acc init [--omp\|--pi] [--local PRESET]` | create `.acc/` with sample checks and print the agent's setup |
| `acc doctor [--agent claude\|omp\|pi] [--offline]` | check the backend, auth (one tiny call), config, checks and agent setup |
| `acc run [--check ID] [--range unpushed\|A..B] [--json]` | run checks now; exit 0 pass, 1 warn, 2 block, 3 error |
| `acc grade ID [--sample N] [--commits REV... \| --range A..B ...]` | grade a check on past commits |
| `acc promote ID [--to advisory\|active] [--force]` | change a check's status |
| `acc list`, `acc validate [FILE]` | list checks with their grades; validate check files |
| `acc gate --agent claude` | the Claude Code hook (reads the hook payload on stdin) |
| `acc mcp [--agent claude]` | the check tools as an MCP server on stdio |

In omp and pi, `/acc <command>` runs the same commands in the session's project, for that agent.

Every gated push is logged to `~/.local/share/acc/logs/YYYY/MM/DD/events.jsonl` (or
`$ACC_LOG_DIR`): the range, each check's answer and verdict, and timings. The log never holds diff
text or secrets.

## Troubleshooting

**A push was not reviewed.** Check that `.acc/` is at the repository root, that the checks are
`advisory` or `active` (`acc list`), and that their `applies_to` globs match the changed files
(`acc run` lists the checks that ran). Deletes, tag-only pushes, dry runs and pushes with no new
commits are not reviewed.

**"this command creates a commit and pushes in one step".** The agent ran something like
`git commit … && git push`. Run the commit, then `git push` as its own command.

**"check could not run (…)".** The backend failed; the message says why. Run `acc doctor`. To let
pushes through when the model is unavailable, set `run.on_backend_error = "warn"`.

**omp: `Model "@decision" not found`.** Define `modelRoles.decision` (see the omp quick start), or
set `backends.omp.model` to a model directly.

**pi: `Model "…" is ambiguous across providers`.** Set `backends.pi.model` to `provider/model`,
for a provider you are logged in to.

**omp blocks the push after 30 seconds.** omp stops slow extension handlers after
`extensionHandlers.toolCallTimeoutMs`. acc raises it for the session in acc projects, unless you
set it yourself; then set it to at least `2 × run.timeout_seconds` in milliseconds (180000 by
default). `acc doctor --agent omp` reports the value.

**A large push is clipped.** The model sees at most `run.max_diff_chars` of diff per push, shared
fairly across files, and the gate says when it clipped. Raise the limit, or exclude generated
files with `run.exclude_globs`.

## Development

```sh
bun install
bun test
bunx tsc -p .
```

The source is TypeScript that runs unbuilt: Bun runs it directly, and Node loads it through
[jiti](https://github.com/unjs/jiti). Tests use a fake backend and throwaway git repos. To try a
checkout in an agent, run `omp install .` or `pi install .` in it. See [CHANGELOG.md](CHANGELOG.md)
for changes.

## License

Apache-2.0. The secret-scan patterns are ported from
[dev-decisions](https://github.com/adelvillar1/dev-decisions) (Apache-2.0).

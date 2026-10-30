# agent-commit-checks (`acc`)

Model-backed checks on the commits a coding agent is about to push. The gate sits on the
agent's `git push`. Blocked pushes return findings to the agent as the tool error.
Checks are TOML files in the project, run on a cheap model through the agent's own login,
and are also exposed as MCP tools.

Two agents are supported: Claude Code (`claude` backend, a `PreToolUse` hook) and oh-my-pi
(`omp` backend, an extension on the `bash` tool). Both use the same runner and MCP server.

## Install

```sh
uv tool install 'agent-commit-checks[mcp] @ /path/to/agent-commit-checks'
acc --help
```

Use the absolute path of the installed `acc` in hook and MCP configs. A process started from
VS Code may not see your shell `PATH`.

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

```sh
cd my-project
acc init --omp           # creates .acc/, installs ~/.omp/agent/extensions/acc.ts, prints the omp setup
acc doctor --agent omp   # checks the omp binary, the model role, auth (one tiny call) and the extension
```

The extension runs `acc gate --agent omp --cwd <dir> --command <cmd>` before every `bash` tool
call that mentions `git` and `push`. A `block` verdict stops the call and returns the findings to
the model as the tool error. A `warn` verdict lets the push run and adds the findings to the
model's context after the tool result. If `acc` is missing, crashes or prints invalid JSON, the
push is blocked. `acc init --omp` writes the absolute `acc` path into the extension. Re-run it
after moving `acc`, then restart omp.

The omp backend uses the `@decision` model role. Define it once in `~/.omp/agent/config.yml`,
or per project in `.omp/config.yml`:

```yaml
modelRoles:
  decision: anthropic/claude-haiku-5-5
```

omp stops a `tool_call` handler after `extensionHandlers.toolCallTimeoutMs` (30 s by default)
and then blocks the push. A gate run can take up to two rounds of `run.timeout_seconds`, so
give it 180 s:

```sh
omp config set extensionHandlers.toolCallTimeoutMs 180000
```

Put the **MCP server** in `.omp/mcp.json` (project) or `~/.omp/agent/mcp.json` (all projects):

```json
{ "mcpServers": { "acc": { "command": "/home/you/.local/bin/acc", "args": ["mcp", "--agent", "omp"] } } }
```

## Check files

`.acc/checks/<id>.toml`. See [examples/.acc/checks](examples/.acc/checks) for one check of each type.

| `question.type` | `answer` from the model | `[verdict]` |
| --- | --- | --- |
| `bool` | probability (0–1) that the answer to the question is **yes** | `block_at`, `warn_at` thresholds |
| `choice` | one label | label → `pass` / `warn` / `block` |
| `score` | index into `levels`, ordered **best to worst** | `block_at`, `warn_at` level indexes |

Phrase `bool` questions so that "yes" means there is a problem.

Statuses: `proposed` checks run only when named, `advisory` checks run in the gate but only
warn, and `active` checks can block. `active` needs a passing grade (`acc grade <id>`) for the
check's current contents. The grade hash ignores the `status` line, so promotion does not
invalidate it.

By default a grade samples about 20 relevant commits from the default branch. `--commits`
grades exactly the commits you list, and `--range A..B` draws the sample from that range.
Excluded commits are listed with a reason (no matching path, empty diff, secret-scan hit). The
grade records how its sample was chosen. The MCP `promote_check` tool needs an automatic
grade to reach `active`, so an agent cannot hand-pick easy commits. `acc promote` accepts
either kind.

## Commands

| Command | Purpose |
| --- | --- |
| `acc gate --agent claude` | PreToolUse hook: reads the payload on stdin, prints hook JSON |
| `acc gate --agent omp --cwd DIR --command CMD` | omp extension: prints `{verdict, reason, context, message}` |
| `acc run [--check id] [--range unpushed\|A..B] [--json]` | run checks on demand (exit 0 pass, 1 warn, 2 block, 3 error) |
| `acc grade <id> [--sample N] [--commits REV... \| --range A..B]` | grade against history (or chosen commits or a range), write `.acc/grades/<id>.json` |
| `acc list`, `acc validate [file]` | inspect and schema-check checks |
| `acc promote <id> [--to advisory\|active] [--force]` | change status |
| `acc init [--omp]`, `acc doctor [--agent omp]`, `acc mcp [--agent omp]` | setup, diagnostics, MCP server |

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
- The omp extension ships inside the package (`src/acc/adapters/omp/acc.ts`), not in a
  top-level `adapters/`, so an installed `acc` can copy it.
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
- omp's `pi.exec(command, args, {cwd, timeout, signal})` runs the command without a shell and
  returns `{stdout, stderr, code, killed}`. The extension resolves the `bash` tool's optional
  `cwd` input against the session directory and passes the result to `acc gate --cwd`.
- Secret patterns are ported from [dev-decisions](https://github.com/adelvillar1/dev-decisions)
  (Apache-2.0); see `src/acc/secrets.py`.

## Development

```sh
uv sync
uv run pytest
```

Tests use `backend = "fake"` (`[agents.claude] backend = "fake"`, answers from a JSON file)
and throwaway repos with a local bare remote. `tests/test_omp_extension.py` loads the omp
extension under [bun](https://bun.sh) and is skipped when `bun` is not on `PATH`.

# agent-commit-checks (`acc`)

Model-backed checks on the commits a coding agent is about to push. The gate sits on the
agent's `git push`. Blocked pushes return findings to the agent as the tool error.
Checks are TOML files in the project, run on a cheap model through the agent's own login,
and are also exposed as MCP tools.

This build implements the Claude Code pathway (`claude` backend, `acc gate --agent claude`,
MCP server). The omp backend and extension are developed separately.

## Install

```sh
uv tool install 'agent-commit-checks[mcp] @ /path/to/agent-commit-checks'
acc --help
```

Use the absolute path of the installed `acc` in hook and MCP configs. A process started from
VS Code may not see your shell `PATH`.

## Set up a project

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

A project opts in by having a `.acc/` directory. In repos without one, the gate allows every push.

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

## Commands

| Command | Purpose |
| --- | --- |
| `acc gate --agent claude` | PreToolUse hook: reads the payload on stdin, prints hook JSON |
| `acc run [--check id] [--range unpushed\|A..B] [--json]` | run checks on demand (exit 0 pass, 1 warn, 2 block, 3 error) |
| `acc grade <id> [--sample N]` | grade against history, write `.acc/grades/<id>.json` |
| `acc list`, `acc validate [file]` | inspect and schema-check checks |
| `acc promote <id> [--to advisory\|active] [--force]` | change status |
| `acc init`, `acc doctor`, `acc mcp` | setup, diagnostics, MCP server |

Logs: `~/.local/share/acc/logs/YYYY/MM/DD/events.jsonl` (override with `ACC_LOG_DIR`). The log
holds hashes and sizes only, never diff text or secrets.

## Notes and deviations from the handoff

- The `claude -p` call uses `--max-turns 2`. Structured output takes a StructuredOutput tool
  call plus a final turn, and `--max-turns 1` ends in `error_max_turns`.
- `--tools ""` disables all tools (an open question in the handoff). The call also uses
  `--strict-mcp-config`, `--setting-sources ""`, `--system-prompt`, and
  `alwaysThinkingEnabled: false`. Together these flags cut a call from about 86K input
  tokens and $0.11 to about 2.4K tokens and $0.006, and to 4–6s.
- The parser accepts both output shapes: a single result object, and the event array
  produced when verbose output is on.
- Secret-scan `warn` patterns (env-var dumps, password assignments) do not block. Matching
  lines are redacted before the diff goes to the model. `block` patterns block with no
  model call.
- `update_check` on an `active` check moves it back to `advisory`, because its grade is cleared.
- Secret patterns are ported from [dev-decisions](https://github.com/adelvillar1/dev-decisions)
  (Apache-2.0); see `src/acc/secrets.py`.

## Development

```sh
uv sync
uv run pytest
```

Tests use `backend = "fake"` (`[agents.claude] backend = "fake"`, answers from a JSON file)
and throwaway repos with a local bare remote.

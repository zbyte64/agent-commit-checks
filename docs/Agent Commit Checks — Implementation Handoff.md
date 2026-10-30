# Agent Commit Checks — Implementation Handoff

Oct 30, 2026 · @Claude

## Summary

Build a new repository, working name `agent-commit-checks` (CLI `acc`), that runs model-backed checks on the commits a coding agent is about to push, before the push leaves the machine, and feeds the result back to that agent. The gate sits on `git push`, not `git commit`, so the agent commits freely while it works and the checks review the finished set of commits once. It targets two agents: Claude Code running in VS Code, and oh-my-pi (omp). Checks live as data files in the project, run on a cheap model chosen by the user (Haiku via Claude Code, or a user-defined `decision` role in omp), and are also exposed as MCP tools so the agent can run them on demand and add new ones.

**In scope**

- Pushes made by an agent's shell tool (`git push` run by Claude Code's `Bash` tool or omp's `bash` tool).
- Feedback to the agent: a blocked push returns the findings as the tool error, so the agent can fix them with a new or amended commit and push again.
- Agent-authored checks, written through an MCP tool.
- Auth through each agent's existing login. No `ANTHROPIC_API_KEY`.

**Out of scope**

- Pushes and commits the user makes by hand (terminal or the VS Code Source Control panel). No git hook is installed.
- Gating at `git commit` time. Checks run once per push.
- CI gating.
- Calibration dashboards and classifier providers from dev-decisions.

**Prior art.** [dev-decisions](https://github.com/adelvillar1/dev-decisions) (Apache-2.0) covers similar ground with classifier models and git hooks. It has no Claude or omp provider and defines checks in Python code. This repo starts fresh and ports three pieces with attribution: the secret-scan regexes (`_SECRET_PATTERNS`, `scan_text`), the 0/1/2/3 exit-code convention, and the JSONL decision-log shape.

## Architecture

Both agents reach the same runner through two entry points: `acc gate` for the push check and `acc mcp` for on-demand tools. The runner picks the model backend from the agent that called it, so each agent's own login and model choice are used.

&#91;embedded content: acc architecture · 2 agents, 2 entry points, 1 runner, 2 backends\]

The runner core is the only code that reads check files, builds the diff preview or calls a model; adapters only translate input and output.

**Repository layout**

```
agent-commit-checks/
  src/acc/
    cli.py            # acc subcommands
    checks.py         # load, validate, verdict mapping
    gitcmd.py         # shell-command parser for git push forms
    pushrange.py      # resolves the commits a push will send
    secrets.py        # ported from dev-decisions (Apache-2.0, attributed)
    runner.py         # pipeline, parallel calls, aggregation
    gate.py           # Claude Code and omp output formats
    backends/
      claude.py  omp.py  fake.py
    mcp_server.py
    log.py
  adapters/omp/acc.ts
  examples/.acc/      # config.toml + sample checks
  tests/
```

## Check files and registry

Each check is one TOML file under `.acc/checks/` in the target project, committed with the project. Adding a check never requires code changes. The question types mirror omp's `judge()` types (`bool`, `choice`, `score`) so the same file can later be answered by omp's `judge` role.

**Project layout**

```
.acc/
  config.toml        # backends, models, limits, failure mode
  checks/
    no-debug-leftovers.toml
    commit-message-matches-diff.toml
  grades/            # one grade record per check, committed
```

**Example check**

```toml
id = "commit-message-matches-diff"
title = "Each commit message describes its diff"
enabled = true
status = "active"            # proposed | advisory | active
author = "user"              # user | agent
scope = "per_commit"         # range | per_commit
applies_to = ["**/*"]        # globs over changed paths; check skipped if none match
inputs = ["diff", "message"] # diff, message, file_list

[question]
type = "choice"
instructions = "Does the commit message accurately describe the commit's changes?"
labels = { accurate = "Message matches the changes", partial = "Message omits notable changes", wrong = "Message describes something else" }

[verdict]
accurate = "pass"
partial = "warn"
wrong = "block"
```

**Field rules**

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Must equal the file name without `.toml`; `[a-z0-9-]+` |
| `status` | `proposed`, `advisory`, `active` | `advisory` and `active` run in the push gate; only `active` can block, and reaching it needs a passing grade (see Grading) |
| `scope` | `range` or `per_commit` | `range` (default): one answer for the whole push, from the combined diff. `per_commit`: one answer per pushed commit, from that commit's diff and message |
| `applies_to` | glob list | Matched against changed paths; empty match skips the check. Also filters the grading sample |
| `inputs` | list | Which context the runner sends: diff, commit message(s), changed-file list. With `range`, `message` is every pushed commit's message in order |
| `question.type` | `bool`, `choice`, `score` | `choice` needs 2+ labels; `score` needs 2+ ordered `levels` |
| `verdict` | table | `bool`: `block_at` / `warn_at` probability thresholds; `choice`: label to verdict; `score`: level index thresholds |
| `grading` | table | `terms` (relevance terms for sample selection), optional `expect_fail` commit SHAs |

**Model answer shape.** The runner sends the checks of a batch in one prompt and asks for `{"checks": {"<check id>": …}}`, one entry per check id (keyed `<check id>@<short sha>` for `per_commit` checks), each in this shape:

```json
{
  "answer": "partial",
  "findings": [{ "file": "src/api.ts", "line": 42, "message": "New endpoint not mentioned in message" }],
  "summary": "Message covers the refactor but not the new endpoint."
}
```

`answer` is a number 0–1 for `bool`, one label for `choice`, and a level index for `score`. The runner turns `answer` into `pass`, `warn` or `block` through the check's `verdict` table. The model never decides the verdict directly.

**config.toml**

```toml
[backends.claude]
command = "/Users/you/.local/bin/claude"  # absolute path
model = "haiku"

[backends.omp]
command = "/Users/you/.local/bin/omp"
model = "@decision"                         # omp role alias

[run]
max_diff_chars = 12000
timeout_seconds = 90
parallel = 4
max_checks_per_call = 8
max_commits = 20                            # per_commit checks cover the newest N
on_backend_error = "block"                   # warn | block
secret_scan = true
```

## Runner CLI (`acc`)

The runner is the single place where checks execute; both agent adapters and the MCP server call it. Implementation: Python 3.10+, stdlib-only core, with the MCP server as an optional extra (`acc[mcp]`). Install with `uv tool install` or `pipx` so the binary has a fixed absolute path.

**Commands**

| Command | Purpose |
| --- | --- |
| `acc gate --agent claude` | Read a Claude Code `PreToolUse` JSON payload on stdin, decide, print Claude Code hook JSON on stdout |
| `acc gate --agent omp --cwd <dir> --command <cmd>` | Same decision for omp; prints `{verdict, reason, context}` JSON for the extension |
| `acc run [--check <id>...] [--range unpushed\|<rev-range>] [--json]` | Run checks on demand against the unpushed commits (default) or any rev range; used by the MCP server and by humans |
| `acc grade <id> [--sample 20]` | Grade a check against prior commits and write `.acc/grades/<id>.json` |
| `acc list [--json]` | List checks with id, status, author, type, scope, grade result |
| `acc validate [<file>]` | Schema-check one or all check files |
| `acc promote <id> [--to advisory\|active] [--force]` | Change a check's status; `active` needs a passing grade unless `--force` |
| `acc init` | Create `.acc/` with config and two sample checks; print the Claude Code and omp setup snippets |
| `acc doctor` | Verify backend binaries, auth (one 1-token test call), config, check files |
| `acc mcp` | Serve the MCP tools over stdio |

**Gate pipeline**

1. Parse the shell command. If it does not contain a `git push` invocation, exit allowing with no output.
2. If the same command creates a commit before pushing (`git commit … && git push`), deny without a model call and ask the agent to run the push as its own command. The new commit does not exist yet when the gate runs, so it cannot be reviewed.
3. Resolve what the push will send: the remote, the refspecs, and for each pushed local ref the commits not on any remote-tracking ref of that remote (`git rev-list <ref> --not --remotes=<remote>`). No new commits: allow.
4. Run the local secret scan on the added lines of every commit in the range. A hit blocks immediately and nothing is sent to any model.
5. Select `advisory` and `active` checks whose `applies_to` globs match a path changed in the range.
6. Build inputs: the combined range diff for `range` checks; each commit's own diff and message for `per_commit` checks (newest `run.max_commits` commits). Truncate diffs to `max_diff_chars`, recording that truncation happened.
7. Send the selected checks to the backend in batched calls, up to `run.max_checks_per_call` entries per call and up to `run.parallel` calls at once. Validate the answer JSON per entry and map each answer to a verdict. An entry that is missing or invalid is retried alone once.
8. Aggregate: `block` answers from `advisory` checks become `warn`; the overall verdict is the most severe of all entries (`block` > `warn` > `pass`).
9. Write one JSONL log row, then emit the adapter-specific output. Block feedback names the commit for each finding and tells the agent to fix it with a new commit, or by amending or rebasing the unpushed commits, then push again.

**Exit codes for `acc run`** (from dev-decisions): `0` pass, `1` warn, `2` block, `3` error. `acc gate` always exits `0` and expresses the decision in its JSON, because both agents read structured output.

**Backend failures.** A timeout, auth failure or invalid model JSON counts as an error for that check. `run.on_backend_error` decides whether an errored check counts as `warn` or `block`. The failure reason is always included in the feedback text.

**Log row** (`~/.local/share/acc/logs/YYYY/MM/DD/events.jsonl`)

```json
{"ts": "2026-10-30T18:02:11Z", "repo": "my-app", "agent": "claude", "backend": "claude", "model": "haiku",
 "command": "git push -u origin feature/export", "range": "origin/main..feature/export", "commits": 3,
 "diff_sha256": "…", "diff_chars": 8123, "truncated": false, "calls": 1,
 "checks": [{"id": "commit-message-matches-diff", "commit": "a1b2c3d", "answer": "partial", "verdict": "warn"}],
 "verdict": "warn", "latency_ms": 2380}
```

The log never stores diff text or secret matches, only hashes and sizes.

## Model backends and auth

The runner calls models only through each agent's own CLI, so it reuses the login the user already has and never needs an API key. By default the backend follows the agent that triggered the gate (Claude Code uses `claude`, omp uses `omp`); `[agents.<name>] backend = "..."` in `config.toml` overrides that.

| Backend | Command the runner spawns | Answer extraction | Schema enforcement |
| --- | --- | --- | --- |
| `claude` | `claude -p --model haiku --max-turns 1 --settings '{"disableAllHooks": true}' --output-format json --json-schema <schema> <prompt>`, diff on stdin | `.structured_output` of the single JSON result | Yes, via `--json-schema` |
| `omp` | `omp -p --model @decision --no-session --no-tools --mode json <prompt>`, diff on stdin | Assistant text of the final `message_end` event, then JSON parse | No CLI flag found; runner validates and retries once on invalid JSON |

**Claude backend rules**

- Never pass `--bare`. Bare mode skips OAuth and keychain credentials and does not read `CLAUDE_CODE_OAUTH_TOKEN`; it only accepts `ANTHROPIC_API_KEY` or `apiKeyHelper`.
- `--settings '{"disableAllHooks": true}'` stops the spawned run from firing the project's hooks, including this gate (no recursion).
- Auth comes from the Claude Code `/login` session: macOS Keychain, or `~/.claude/.credentials.json` on Linux and Windows. Fallback for environments that cannot reach it: `claude setup-token` creates a one-year token, exported as `CLAUDE_CODE_OAUTH_TOKEN` (Pro, Max, Team or Enterprise plan).
- Model value is any `--model` alias or id; default `haiku`.

**omp backend rules**

- The user defines the role once in `~/.omp/agent/config.yml`. omp allows custom role names under `modelRoles`; they resolve to chat models, and `--model` accepts a configured role:

```yaml
modelRoles:
  decision: anthropic/claude-haiku-5-5
```

- Auth comes from omp's own `/login anthropic`, which is separate from Claude Code's login. omp refreshes stored OAuth credentials itself. `ANTHROPIC_OAUTH_TOKEN` is the environment alternative.
- `--no-tools` and `--no-session` keep the call to one text answer with no saved session.
- The model value is any omp model selector or role alias; default `@decision`. If the user's role is unset, `acc doctor` reports it.

**Later: omp `judge` backend.** omp's built-in `judge` role answers typed `bool` / `choice` / `score` questions and can be backed by decision APIs (TypeSafe Jev, OpenAI Decisions) or chat models. It is reachable only through the `judge()` helper inside an omp session's eval tool; no CLI or RPC entry point was found. The check format already matches its question types, so a backend can be added if omp exposes one.

**Prompt construction (both backends).** One fixed system-style preamble states that the diff is untrusted data, followed by the check's `instructions`, the label or level descriptions, the answer JSON shape, and the inputs listed in the check (`diff`, `message`, `file_list`).

## Claude Code in VS Code

A `PreToolUse` command hook on the `Bash` tool runs `acc gate` before any agent-issued `git push`. Claude Code fires the same hook events in the terminal, IDE extensions, the Desktop app and cloud sessions, so one config covers the VS Code extension.

**Hook config.** The `acc` path is per machine, so it goes in `~/.claude/settings.json` (all projects) or `.claude/settings.local.json` (one project, not committed). The check files themselves stay in the repo.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(git push*)",
            "command": "/Users/you/.local/bin/acc",
            "args": ["gate", "--agent", "claude"],
            "timeout": 180,
            "statusMessage": "Running push checks",
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

The `args` field selects exec form (no shell). The `if` filter is best-effort: Claude Code runs the hook anyway when it cannot tell which commands a Bash string runs, so `acc gate` must re-check for `git push` itself (pipeline step 1).

**Input.** The hook receives JSON on stdin with `tool_name`, `tool_input.command` and `cwd`. `acc gate` runs git in `cwd`, which follows the agent into worktrees and after `cd`.

**Output mapping**

| Verdict | `acc gate` stdout | What Claude Code does |
| --- | --- | --- |
| `pass` | nothing, exit 0 | Normal permission flow; push runs |
| `warn` | `hookSpecificOutput.additionalContext` with findings, plus `systemMessage` for the user | Push runs; the findings appear to Claude beside the tool result |
| `block` | `hookSpecificOutput.permissionDecision: "deny"`, `permissionDecisionReason` with findings | Push is blocked; Claude sees the reason, fixes the commits and pushes again |

Example block output:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "acc: push blocked, 1 of 3 commits failed. a1b2c3d commit-message-matches-diff: message describes a refactor, diff adds an export endpoint (src/api.ts:42). Reword the message (rebase or amend the unpushed commit), then push again."
  }
}
```

**Failure behavior.** By default a hook that crashes, times out or prints invalid JSON is a non-blocking error and the push goes ahead. The hook config above sets `"onFailure": "block"` so those cases block the push, matching the default `run.on_backend_error = "block"`; it requires Claude Code v2.1.295 or later.

**MCP registration.** Add the server at project scope so the agent gets the check tools (see MCP server section):

```json
{ "mcpServers": { "acc": { "command": "/Users/you/.local/bin/acc", "args": ["mcp", "--agent", "claude"] } } }
```

## omp

A small TypeScript extension listens for omp's `tool_call` event on the `bash` tool and runs `acc gate --agent omp` before any `git push`. omp's `tool_call` handlers run before execution and can block the call with a reason or attach passive `additionalContext`, which covers the same three outcomes as the Claude Code hook.

**Where it lives.** omp loads extensions from `<project>/.omp/extensions` and from `~/.omp/agent/extensions`. The repo ships the extension as `adapters/omp/acc.ts`; `acc init --omp` copies it to the user directory with the absolute `acc` path filled in.

**Extension sketch** (verify `pi.exec`'s exact signature against omp's `ExtensionAPI` types before shipping):

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const ACC = "/Users/you/.local/bin/acc"; // filled in by acc init

export default function (pi: ExtensionAPI) {
  pi.setLabel("acc commit checks");

  pi.on("tool_call", async (event, ctx) => {
    const command = event.input.command;
    if (event.toolName !== "bash" || typeof command !== "string") return;
    if (!/\bgit\b[^;&|]*\bpush\b/.test(command)) return;

    const res = await pi.exec(ACC, ["gate", "--agent", "omp", "--cwd", ctx.cwd, "--command", command]);
    let out: { verdict: string; reason?: string; context?: string };
    try { out = JSON.parse(res.stdout); }
    catch { return { block: true, reason: `acc gate failed: ${res.stderr}` }; }

    if (out.verdict === "block") return { block: true, reason: out.reason };
    if (out.verdict === "warn") return { additionalContext: out.context };
  });
}
```

**Output mapping**

| Verdict | Extension returns | What omp does |
| --- | --- | --- |
| `pass` | nothing | Push runs |
| `warn` | `{ additionalContext }` | Push runs; findings delivered to the model after the tool results |
| `block` | `{ block: true, reason }` | Push is blocked; the reason goes back to the model |

**Model role.** The gate uses the omp backend with `@decision` unless `config.toml` says otherwise. Users set the model once in `~/.omp/agent/config.yml` (`modelRoles.decision`), and can change it from omp's `/model` Roles view or per project with an `.omp/config.yml` overlay. The extension can resolve the same alias with `ctx.models.resolve("@decision")` to show the chosen model in a status line.

**MCP registration.** omp reads MCP servers from `.omp/mcp.json` (project) and `~/.omp/agent/mcp.json` (user), with the same `{ "mcpServers": { "acc": { "command": …, "args": ["mcp", "--agent", "omp"] } } }` shape used for Claude Code.

**Failure behavior.** If `acc` cannot run or prints invalid JSON, the sketch blocks the push and returns the error as the reason, matching the default `run.on_backend_error = "block"`.

## MCP server: checks as tools

`acc mcp` is a stdio MCP server that wraps the runner, so the agent can run checks mid-task and write new ones. It exposes a fixed set of generic tools rather than one tool per check, so a check file added during a session is usable immediately without the server changing its tool list.

Register it once per agent with the agent name, so the server uses the matching backend: `"args": ["mcp", "--agent", "claude"]` in Claude Code, `"args": ["mcp", "--agent", "omp"]` in omp.

| Tool | Input | Returns |
| --- | --- | --- |
| `list_checks` | optional `status` filter | id, title, type, scope, status, author, grade result per check |
| `get_check` | `id` | the check's TOML text |
| `run_checks` | optional `ids`, `range` (`unpushed` by default, or a rev range), `include_proposed` | per-entry answer, verdict, findings; overall verdict |
| `test_check` | a full check spec (not saved), `range` | the same result as `run_checks` for that one spec |
| `grade_check` | `id`, optional `sample_size` | grade record: sampled commits, verdicts, metrics, pass or fail |
| `add_check` | a full check spec | path written; validation errors if rejected |
| `update_check` | `id`, full spec | path written; refused for `author = "user"` checks; clears the grade |
| `promote_check` | `id`, `to` (`advisory` or `active`) | path and the changed `status` line; `active` refused without a passing grade for the current file |

**Agent-defined checks**

1. The agent drafts a spec and calls `test_check` against the current changes to see how it behaves.
2. `add_check` validates the spec (`acc validate` rules) and writes `.acc/checks/<id>.toml` with `author = "agent"` and `status = "proposed"`. It refuses an `id` that already exists.
3. A proposed check runs when called by name through `run_checks`, but not in the push gate.
4. The agent activates it with the `promote_check` MCP tool, or the user with `acc promote <id>`, which sets `status = "active"`.

Promotion changes only the status line in the check's TOML file, so every promotion shows up in the diff of .acc/checks/\*.toml and in the commit that carries it. promote\_check also returns the file path and the changed line so the agent reports it.

Before promoting to `active`, the agent runs `grade_check` and reports the result: block rate, any history commits the check would block, and pass or fail. A check can sit at `advisory` meanwhile, warning in the push gate without blocking.

**Implementation notes**

- Use the official Python MCP SDK (`mcp` package), stdio transport.
- `run_checks` and `test_check` call the same runner function as `acc gate`, so results match.
- Tool results carry both readable text and structured content (verdicts as JSON).

## Grading checks before they can block

A check can only block pushes after it passes a grade: a run against about 20 prior commits from the project's own history, chosen for relevance to that check. History is treated as mostly acceptable work, so a check that would have blocked many past commits is likely to produce false blocks. A passing grade is required to move a check to `active`.

**Check lifecycle**

| Status | Runs in push gate | Can block | How it gets there |
| --- | --- | --- | --- |
| `proposed` | No | No | `add_check` / new file |
| `advisory` | Yes | No; `block` verdicts are reported as `warn` | `promote_check <id> --to advisory`, no grade needed |
| `active` | Yes | Yes | `promote_check <id>` with a passing grade for the current file contents |

**Sample selection (target 20 units, relative to the check)**

1. **Unit.** `per_commit` checks grade on single non-merge commits. `range` checks grade on first-parent steps of the default branch (a merge's diff against its first parent, or a direct commit), which approximates one landed push.
2. **Pool.** The newest `grading.max_history` units (default 500) on the default branch. Exclude empty diffs, units touching only `run.exclude_globs`, the commit that added the check file, and units where the local secret scan hits (never sent to a model).
3. **Filter.** Keep units whose changed paths match the check's `applies_to`.
4. **Score.** Relevance = number of changed paths matching `applies_to`, plus 3 per hit of the check's `grading.terms` in added lines or the commit message. The check author (user or agent) writes `terms` for the patterns the check targets, for example `["console.log", "debugger"]` for a debug-leftovers check.
5. **Pick.** The 10 highest-scoring units (the ones most likely to trigger the check), plus 10 drawn at random from the rest of the filtered pool (the base rate). The random draw is seeded with the check id and the current `HEAD`, so a re-run picks the same sample.
6. **Small pools.** Under 20 eligible units: use all of them. Under `grading.min_sample` (default 10): the grade is `insufficient` and the check cannot reach `active` through the agent.
7. **Known failures (optional).** `grading.expect_fail` lists commit SHAs the check must catch, such as commits later reverted. They are added to the sample on top of the 20.

**Check file additions**

```toml
[grading]
terms = ["console.log", "debugger"]
expect_fail = ["9f3c2e1"]   # optional
```

**What is measured**

| Metric | Definition | Default promotion bar |
| --- | --- | --- |
| Sample size | Graded units, excluding `expect_fail` | at least `min_sample` (10) |
| Block rate | Share of history units the check would block | at most 10% (2 of 20) |
| Error rate | Entries still missing or invalid after the single retry | 0 |
| Stability | Each blocked or warned unit is re-run once; a changed verdict counts as unstable | at most 1 unstable unit |
| Catch rate | Share of `expect_fail` commits the check blocks | 100% when the list is non-empty |

Bars live in `config.toml` under `[grading]` (`max_block_rate`, `max_unstable`, `min_sample`, `sample_size = 20`).

**Grade record.** `acc grade <id>` (and the MCP tool `grade_check`) writes `.acc/grades/<id>.json`, committed alongside the check. It stores the check file's SHA-256, the sampled SHAs with their selection reason (`top-score` or `random`), each answer, verdict and finding, the metrics, and pass or fail. `promote_check` refuses `active` unless a passing grade exists for the check file's current hash, so editing a check invalidates its grade. Blocked history units are listed in the grade output with their findings, because a block on history can also be a real problem the project already shipped. The user can override with `acc promote <id> --force` on the CLI; the agent cannot.

**Cost.** A grade is about 20 entries for one check, sent in batches of `run.max_checks_per_call`, plus re-runs for stability: roughly 3 to 5 model calls.

## Edge cases and risks

The largest correctness risk is that the gate runs before the agent's push command, so the commits it reviews must be exactly the ones the push will send. The runner computes them from local refs and the remote-tracking refs already on disk; it does not fetch. A stale remote-tracking ref can make the range larger than the push (commits already on the remote get reviewed again), never smaller in the normal case.

| Case | Example | Handling |
| --- | --- | --- |
| Commit and push in one command | `git commit -m "…" && git push` | Deny without a model call; the reason asks the agent to push in a separate command |
| Bare push | `git push` | Current branch, its upstream, and `push.default` |
| New branch, no upstream | `git push -u origin feature/x` | Commits on the branch not on any `refs/remotes/origin/*` ref |
| Explicit refspecs | `git push origin a:b`, several refspecs | Resolve each source ref; review the union of their ranges |
| All branches | `--all`, `--mirror` | Union over every pushed local branch |
| Force push | `--force`, `--force-with-lease` | Same range rule; the history rewrite itself is not judged |
| Deletes and tag-only pushes | `git push origin --delete x`, `git push --tags` | No new branch commits: allow without checks |
| Push not via `git push` text | `gh pr create` (can push the branch), scripts, aliases, MCP git tools | Not gated; documented limitation |
| Unparseable command | Subshells, `eval`, variables in the git args | Treat as unknown; review `@{upstream}..HEAD` and say so in the feedback |
| Large pushes | Many commits, lockfiles, generated code, binaries | Exclude binary files and `run.exclude_globs`; `per_commit` checks cover the newest `run.max_commits`; truncate diffs and report what was skipped |

**Other risks**

- **Latency.** Each batch is one CLI start plus one model call. Measure p50/p95 per backend and batch size in milestone 2, and set the default `max_checks_per_call` from those numbers.
- **Subscription usage.** Every gate run spends from the user's Claude or omp-provider plan limits. The log records call counts so usage can be audited.
- **Prompt injection from the diff.** Diff text can contain instructions aimed at the reviewer model. Mitigations: the untrusted-data preamble, no tools in the spawned call, and the verdict table deciding outcomes rather than free text.
- **Recursion.** The spawned `claude -p` has hooks disabled. The spawned `omp -p` runs with `--no-tools`, so its `tool_call` handlers, including this extension, have nothing to intercept.
- **Environment.** Hooks inherit the agent's environment, and a VS Code-launched process may not have the user's shell `PATH`. Every binary path in `config.toml` and the agent configs is absolute; `acc doctor` checks each one.
- **Platform.** macOS and Linux first. Windows is not targeted in v1 (Claude Code's hook shell handling differs there).

## Milestones

1. **Core runner.** Check format, loader, `acc validate`, secret scan port, command parser, unpushed-range resolver, `acc run` with the `claude` backend and batched check calls, JSONL log. Done when every row of the edge-case table has a passing test.
2. **Claude Code gate.** `acc gate --agent claude`, output mapping, `acc init`, `acc doctor`. Done when a Claude Code session in VS Code gets a blocked push, fixes the commits, and pushes. Record p50/p95 latency per check.
3. **omp gate.** `omp` backend, `adapters/omp/acc.ts`, `@decision` role setup in `acc init --omp`. Done when the same scenario passes in omp.
4. **MCP server.** All MCP tools, grading (`acc grade`, `grade_check`, sample selection, grade records), the proposed / advisory / active flow, registration snippets for both agents.
5. **Hardening.** Default `max_checks_per_call` from milestone 2 latency, `on_backend_error` behavior in both adapters, README, three sample checks.

## Testing

- **Unit.** Command parser fixtures (every push form in the edge-case table); range resolver against throwaway repos with a local bare remote; verdict mapping per question type; check validation; grading sample selection on a fixture repo (filter, scoring, reproducible seeded draw, small pools) and grade invalidation after a check edit.
- **Fake backend.** `backend = "fake"` returns canned answers from a fixture file, so gate and MCP tests run without network or login.
- **Parser contracts.** Recorded `claude -p --output-format json` results and `omp -p --mode json` event streams, including error and invalid-JSON cases.
- **Adapter integration.** Pipe recorded `PreToolUse` payloads into `acc gate --agent claude` and assert the output JSON; load the omp extension against a test repo.
- **Live smoke.** `acc doctor` makes one tiny call per configured backend.

## Open questions

- [ ] Default for `run.on_backend_error`: decided, block (errored checks block the push and the error is shown to the agent).
- [ ] Batching: decided, batched calls always; milestone 2 latency numbers set the default `max_checks_per_call`.
- [ ] Is there a `claude -p` flag that disables all tools for the spawned call? (`--max-turns 1` is the current limit.)
- [ ] Does `omp -p` read the prompt and piped stdin together as expected?
- [ ] What does `omp -p --model @decision` do when the role is unset: error, or fall back to default?
- [ ] Exact signature of omp's `pi.exec` (sketch assumes `(cmd, args) → { stdout, stderr }`).
- [ ] Final repository and CLI name.

* [ ] Default grading bars (10% block rate, 1 unstable unit, 10 minimum sample) are first guesses; tune them after grading the sample checks.
* [ ] Should `grading.terms` be proposed by the model from the check's instructions when the author leaves them empty?

## Sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Bare mode skips OAuth (issue #39069)](https://github.com/anthropics/claude-code/issues/39069)
- [oh-my-pi repository](https://github.com/can1357/oh-my-pi): `docs/models.md`, `docs/settings.md`, `docs/cli-reference.md`, `docs/extensions.md`, `docs/mcp-config.md`, `docs/tools/eval.md`
- [dev-decisions](https://github.com/adelvillar1/dev-decisions)

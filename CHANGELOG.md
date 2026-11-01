# Changelog

## [0.1.1] - 2026-11-01

### Changed
- `acc init --omp`, `acc init --pi` and `acc doctor` suggest installing the extension from npm
  (`omp install npm:agent-commit-checks`, `pi install npm:agent-commit-checks`).
- The README starts with a quick start for each agent and an example of a blocked push, and has a
  troubleshooting section.

### Added
- This changelog, which pi shows after an update, and the Apache-2.0 `LICENSE` file.

## [0.1.0] - 2026-11-01

First release on npm.

### Added
- A push gate for three coding agents: Claude Code (a `PreToolUse` hook running `acc gate`),
  oh-my-pi and pi (an extension that runs the gate inside the agent). A blocked push returns the
  findings to the agent as the tool error; a warning lets the push run and shows the findings to
  the agent.
- Checks as TOML files in `.acc/checks/`, with `bool`, `choice` and `score` questions, `proposed`,
  `advisory` and `active` statuses, and grading against the project's own history before a check
  may block.
- Check tools for the agent (`list_checks`, `get_check`, `run_checks`, `test_check`,
  `grade_check`, `add_check`, `update_check`, `promote_check`): native tools in omp and pi, an MCP
  server (`acc mcp`) for Claude Code.
- Backends that use the agent's own login (`claude -p`, `omp -p`, `pi -p`) and local models
  (`llama-server` on the CPU or GPU, a Granite Guardian judge model, or a small in-process ONNX
  model).
- A local secret scan of every pushed commit, which blocks before any model call.
- The `acc` CLI: `init`, `doctor`, `run`, `grade`, `list`, `validate`, `promote`, `gate` and `mcp`,
  also available as `/acc` inside omp and pi.

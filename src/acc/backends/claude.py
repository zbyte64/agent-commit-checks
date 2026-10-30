"""Claude Code backend: one `claude -p` call per batch, using the user's existing login.

Never pass `--bare`: it skips OAuth and keychain credentials.
"""

from __future__ import annotations

import json
import subprocess

from ..prompt import schema_json
from . import BackendError

# Structured output needs a second turn: the model calls the StructuredOutput tool,
# then the run ends. With --max-turns 1 the result is error_max_turns.
MAX_TURNS = "2"
# No hooks in the spawned run (so this gate cannot recurse), and no extended
# thinking: it roughly doubled latency for these short classification answers.
SETTINGS = '{"disableAllHooks": true, "alwaysThinkingEnabled": false}'


class ClaudeBackend:
    name = "claude"

    def __init__(self, settings: dict):
        self.command = settings.get("command", "claude")
        self.model = settings.get("model", "haiku")

    def argv(self, system: str, prompt: str, schema: dict) -> list[str]:
        return [
            self.command, "-p",
            "--model", self.model,
            "--max-turns", MAX_TURNS,
            "--tools", "",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--setting-sources", "",
            "--settings", SETTINGS,
            "--no-session-persistence",
            "--system-prompt", system,
            "--output-format", "json",
            "--json-schema", schema_json(schema),
            prompt,
        ]

    def ask(self, system: str, prompt: str, stdin: str, schema: dict, timeout: float) -> dict:
        try:
            proc = subprocess.run(
                self.argv(system, prompt, schema),
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except FileNotFoundError as e:
            raise BackendError(f"claude CLI not found at {self.command!r}") from e
        except subprocess.TimeoutExpired as e:
            raise BackendError(f"claude -p timed out after {timeout:.0f}s") from e
        return parse_output(proc.stdout, proc.stderr, proc.returncode)


def _result_event(data: object) -> dict | None:
    """`--output-format json` prints one result object, or an event array in verbose mode."""
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        for event in reversed(data):
            if isinstance(event, dict) and event.get("type") == "result":
                return event
    return None


def _structured_tool_input(data: object) -> dict | None:
    if not isinstance(data, list):
        return None
    for event in reversed(data):
        if not isinstance(event, dict) or event.get("type") != "assistant":
            continue
        for block in event.get("message", {}).get("content", []):
            if block.get("type") == "tool_use" and block.get("name") == "StructuredOutput":
                return block.get("input")
    return None


def parse_output(stdout: str, stderr: str = "", returncode: int = 0) -> dict:
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        detail = (stderr or stdout).strip().splitlines()
        raise BackendError(
            f"claude -p exited {returncode} without JSON output: {detail[-1] if detail else 'no output'}"
        ) from None
    result = _result_event(data)
    if result is None:
        raise BackendError("claude -p output has no result event", retryable=True)
    structured = result.get("structured_output")
    if structured is None:
        # Fallback: the StructuredOutput tool call may exist even if the run ended early.
        structured = _structured_tool_input(data)
    if structured is None:
        if result.get("is_error"):
            msg = result.get("result") or ", ".join(result.get("errors", [])) or result.get("subtype", "")
            retryable = result.get("subtype") in ("error_max_turns", "error_max_structured_output_retries")
            raise BackendError(f"claude -p failed: {msg}", retryable=retryable)
        raise BackendError("claude -p returned no structured_output", retryable=True)
    if not isinstance(structured, dict) or not isinstance(structured.get("checks"), dict):
        raise BackendError("claude -p structured_output has no `checks` object", retryable=True)
    return structured

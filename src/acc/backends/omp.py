"""oh-my-pi backend: one `omp -p` call per batch, using omp's own login and model roles.

`omp -p` has no structured-output flag, so the prompt carries the answer schema and
the runner validates each entry (retrying missing or invalid ones alone).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ..prompt import json_object, with_schema
from . import BackendError

# A lean, single-answer call: no tools, no saved session, and no project inputs that
# would bloat the prompt. `--no-extensions` also keeps the acc extension (and any other
# tool_call handler) out of the spawned run, so the gate cannot recurse.
LEAN_FLAGS = (
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-context-files",
    "--no-lsp",
    "--no-title",
)
# Turns omp's memory backend off for the call, so no diff is stored or recalled across calls.
OVERLAY = Path(__file__).with_name("omp_overlay.yml")
# Thinking is off so the model answers like a decision model.
THINKING = "off"
# Provider errors worth one more attempt; auth, billing and bad-request errors are not.
RETRYABLE_STATUS = {408, 409, 429}


class OmpBackend:
    name = "omp"

    def __init__(self, settings: dict, cwd: Path | None = None):
        self.command = settings.get("command", "omp")
        self.model = settings.get("model", "@decision")
        # Run in the project so an `.omp/config.yml` overlay (e.g. a per-project decision role) applies.
        self.cwd = cwd

    def argv(self, system: str, prompt: str, schema: dict) -> list[str]:
        return [
            self.command, "-p",
            "--model", self.model,
            *LEAN_FLAGS,
            "--config", str(OVERLAY),
            "--thinking", THINKING,
            "--system-prompt", system,
            "--mode", "json",
            with_schema(prompt, schema),
        ]

    def ask(self, system: str, prompt: str, stdin: str, schema: dict, timeout: float) -> dict:
        try:
            proc = subprocess.run(
                self.argv(system, prompt, schema),
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=self.cwd,
            )
        except FileNotFoundError as e:
            raise BackendError(f"omp CLI not found at {self.command!r}") from e
        except subprocess.TimeoutExpired as e:
            raise BackendError(f"omp -p timed out after {timeout:.0f}s") from e
        return parse_output(proc.stdout, proc.stderr, proc.returncode, self.model)


def _events(stdout: str) -> list[dict]:
    """`--mode json` prints one JSON event per line."""
    events = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def _final_assistant(events: list[dict]) -> dict | None:
    for event in reversed(events):
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if isinstance(message, dict) and message.get("role") == "assistant":
            return message
    return None


def _no_events_error(stderr: str, stdout: str, returncode: int, model: str) -> BackendError:
    detail = [line for line in (stderr or stdout).strip().splitlines() if line.strip()]
    first = detail[0] if detail else "no output"
    msg = f"omp -p exited {returncode} without JSON events: {first}"
    if model.startswith("@") and "not found" in first:
        role = model[1:]
        msg += (f". Define the role in ~/.omp/agent/config.yml (modelRoles: {{{role}: <provider/model>}}) "
                f"or set backends.omp.model in .acc/config.toml")
    return BackendError(msg)


def parse_output(stdout: str, stderr: str = "", returncode: int = 0, model: str = "") -> dict:
    events = _events(stdout)
    if not events:
        raise _no_events_error(stderr, stdout, returncode, model)
    message = _final_assistant(events)
    if message is None:
        raise BackendError("omp -p output has no assistant message", retryable=True)
    stop = message.get("stopReason")
    if stop == "error":
        status = message.get("errorStatus")
        retryable = isinstance(status, int) and (status in RETRYABLE_STATUS or status >= 500)
        err = (message.get("errorMessage") or "unknown error").strip().splitlines()[0]
        raise BackendError(f"omp -p failed ({message.get('provider', '?')}/{message.get('model', '?')}): {err}",
                           retryable=retryable)
    if stop == "aborted":
        raise BackendError("omp -p was aborted before answering")
    text = "".join(b.get("text", "") for b in message.get("content", [])
                   if isinstance(b, dict) and b.get("type") == "text")
    data = json_object(text)
    if data is None:
        why = "was cut off" if stop == "length" else "is not a JSON object"
        raise BackendError(f"omp -p answer {why}", retryable=True)
    if not isinstance(data.get("checks"), dict):
        raise BackendError("omp -p answer has no `checks` object", retryable=True)
    return data

"""Local backend: a small decision model behind an OpenAI-compatible server on this machine.

The default server is llama.cpp's `llama-server`, which acc starts on first use if
`[backends.local] server` is set and nothing answers at `url`. The server keeps
running for later calls. Any server with `/v1/chat/completions` and `json_schema`
response formats also works (e.g. Ollama at http://127.0.0.1:11434 with `server = ""`).

The answer schema is enforced by the server's grammar-constrained decoding, so even a
tiny model returns well-formed JSON. It also goes in the prompt so the model knows
what each field means.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from .. import log
from ..prompt import json_object, with_schema
from . import BackendError

# Picked by benchmarking on a CPU-only laptop; see the README's "Local model" section.
RECOMMENDED_MODEL = "Qwen/Qwen3-1.7B-GGUF:Q8_0"
DEFAULT_URL = "http://127.0.0.1:8763"
# Room for a 12000-character diff, the prompt and a long answer in each of two slots.
DEFAULT_SERVER_ARGS = ["--ctx-size", "16384", "--parallel", "2"]
MAX_TOKENS = 2048
_start_lock = threading.Lock()


class LocalBackend:
    name = "local"

    def __init__(self, settings: dict):
        self.url = settings.get("url", DEFAULT_URL).rstrip("/")
        self.model = settings.get("model", RECOMMENDED_MODEL)
        self.server = settings.get("server", "")
        self.server_args = settings.get("server_args", DEFAULT_SERVER_ARGS)
        self.startup_seconds = float(settings.get("startup_seconds", 300))

    # ── server ───────────────────────────────────────────────────────────────

    def ready(self, timeout: float = 2) -> bool:
        """True once the server answers `/v1/models`; llama-server returns 503 while loading."""
        try:
            with urllib.request.urlopen(f"{self.url}/v1/models", timeout=timeout) as r:
                return r.status == 200
        except (OSError, ValueError):
            return False

    def server_argv(self) -> list[str]:
        parts = urlsplit(self.url)
        return [self.server, "-hf", self.model, "--alias", self.model,
                "--host", parts.hostname or "127.0.0.1", "--port", str(parts.port or 80),
                *self.server_args]

    def ensure_server(self) -> None:
        """Start the server if it is configured and not answering, then wait until it is ready."""
        if self.ready():
            return
        if not self.server:
            raise BackendError(f"no model server answers at {self.url}; start one, or set "
                               "[backends.local] server so acc starts llama-server itself")
        with _start_lock:
            if self.ready():
                return
            path = self.server if os.path.isabs(self.server) else shutil.which(self.server)
            if not path:
                raise BackendError(f"local model server not found at {self.server!r}; install llama.cpp "
                                   "or set [backends.local] server to llama-server's absolute path")
            out = server_log()
            out.parent.mkdir(parents=True, exist_ok=True)
            with out.open("ab") as f:
                # A new session, so the server outlives this hook and serves later pushes.
                proc = subprocess.Popen([path, *self.server_argv()[1:]], stdin=subprocess.DEVNULL,
                                        stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + self.startup_seconds
            while time.monotonic() < deadline:
                if self.ready():
                    return
                if proc.poll() is not None and not self.ready():
                    raise BackendError(f"llama-server exited {proc.returncode} while starting; see {out}")
                time.sleep(0.5)
            raise BackendError(f"llama-server did not become ready in {self.startup_seconds:.0f}s "
                               f"(the first start downloads the model); see {out}", retryable=True)

    # ── calls ────────────────────────────────────────────────────────────────

    def request(self, system: str, prompt: str, stdin: str, schema: dict) -> dict:
        # The data goes before the instructions, so a small model reads the question last.
        user = f"{stdin}\n{with_schema(prompt, schema)}" if stdin else with_schema(prompt, schema)
        return {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0,
            "max_tokens": MAX_TOKENS,
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": "checks", "strict": True, "schema": schema}},
            # Thinking is off so the model answers like a decision model (Qwen3 templates read this).
            "chat_template_kwargs": {"enable_thinking": False},
        }

    def ask(self, system: str, prompt: str, stdin: str, schema: dict, timeout: float) -> dict:
        self.ensure_server()
        body = json.dumps(self.request(system, prompt, stdin, schema)).encode()
        req = urllib.request.Request(f"{self.url}/v1/chat/completions", data=body,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode()
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace").strip().splitlines()
            raise BackendError(f"local model server returned {e.code}: {detail[0] if detail else e.reason}",
                               retryable=e.code in (408, 429) or e.code >= 500) from None
        except TimeoutError:
            raise BackendError(f"local model timed out after {timeout:.0f}s") from None
        except OSError as e:
            raise BackendError(f"local model server at {self.url} failed: {e}") from None
        return parse_output(raw)


def server_log() -> Path:
    return log.log_dir().parent / "llama-server.log"


def parse_output(raw: str) -> dict:
    try:
        choice = json.loads(raw)["choices"][0]
        text = choice["message"]["content"] or ""
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        raise BackendError("local model server returned no chat completion", retryable=True) from None
    data = json_object(text)
    if data is None:
        why = "was cut off" if choice.get("finish_reason") == "length" else "is not a JSON object"
        raise BackendError(f"local model answer {why}", retryable=True)
    if not isinstance(data.get("checks"), dict):
        raise BackendError("local model answer has no `checks` object", retryable=True)
    return data

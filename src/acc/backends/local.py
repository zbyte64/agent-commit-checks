"""Local backend: a small decision model behind an OpenAI-compatible server on this machine.

The default server is llama.cpp's `llama-server`, which acc starts on first use if
`[backends.local] server` is set and nothing answers at `url`. The server keeps
running for later calls. Any server with `/v1/chat/completions` and `json_schema`
response formats also works (e.g. Ollama at http://127.0.0.1:11434 with `server = ""`).

The answer schema is enforced by the server's grammar-constrained decoding, so even a
tiny model returns well-formed JSON. It also goes in the prompt so the model knows
what each field means.

A small model's self-reported `confidence` is noise (it writes 1.0 almost every time),
so this backend measures it instead. It reads the token probabilities at each answer's
decision tokens and attaches `answer_probs`: the model's probability for each answer it
considered. `checks.validate_entry` turns that into the probability of the same verdict.
"""

from __future__ import annotations

import json
import math
import os
import re
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

# Picked by benchmarking on a laptop (Ryzen 9 7940HS, Radeon 780M); see bench/README.md.
RECOMMENDED_MODELS = {"cpu": "Qwen/Qwen3-0.6B-GGUF:Q8_0", "gpu": "Qwen/Qwen3-4B-GGUF:Q8_0"}
RECOMMENDED_MODEL = RECOMMENDED_MODELS["cpu"]
# `cpu` turns GPU devices off: with -ngl 0 alone, a GPU build still offloads large prompt matmuls.
DEVICE_ARGS = {"cpu": ["--device", "none"], "gpu": ["--n-gpu-layers", "999"]}
DEVICES = tuple(DEVICE_ARGS)
DEFAULT_URL = "http://127.0.0.1:8763"
# Room for a 12000-character diff, the prompt and a long answer in each of two slots.
DEFAULT_SERVER_ARGS = ["--ctx-size", "16384", "--parallel", "2"]
MAX_TOKENS = 2048
# Alternatives read at each answer token. The probabilities are taken before the schema
# constraint, so many alternatives are not valid answers and are dropped.
TOP_LOGPROBS = 20
_start_lock = threading.Lock()


class LocalBackend:
    name = "local"

    def __init__(self, settings: dict):
        self.url = settings.get("url", DEFAULT_URL).rstrip("/")
        self.device = settings.get("device", "cpu")
        if self.device not in DEVICES:
            raise BackendError(f"backends.local.device must be one of {', '.join(DEVICES)}, not {self.device!r}")
        self.model = settings.get("model", RECOMMENDED_MODELS[self.device])
        self.server = settings.get("server", "")
        self.server_args = settings.get("server_args", DEFAULT_SERVER_ARGS)
        self.startup_seconds = float(settings.get("startup_seconds", 300))

    # ── server ───────────────────────────────────────────────────────────────

    def served_models(self, timeout: float = 2) -> list[str] | None:
        """The model ids at `/v1/models`, or None until the server answers (llama-server returns 503
        while loading)."""
        try:
            with urllib.request.urlopen(f"{self.url}/v1/models", timeout=timeout) as r:
                data = json.loads(r.read() or b"{}")
        except (OSError, ValueError):
            return None
        models = data.get("data") if isinstance(data, dict) else None
        return [m.get("id", "") for m in models if isinstance(m, dict)] if isinstance(models, list) else []

    def ready(self, timeout: float = 2) -> bool:
        return self.served_models(timeout) is not None

    def check_model(self) -> None:
        """A server left running with another model (e.g. after switching presets) would answer
        every check with it, so refuse instead."""
        served = self.served_models()
        if served and self.model not in served:
            raise BackendError(f"the server at {self.url} serves {', '.join(served)}, not {self.model}; "
                               f"stop it (pkill -f 'llama-server.*--port {urlsplit(self.url).port}') "
                               "and acc will start the configured model")

    def server_argv(self) -> list[str]:
        parts = urlsplit(self.url)
        return [self.server, "-hf", self.model, "--alias", self.model,
                "--host", parts.hostname or "127.0.0.1", "--port", str(parts.port or 80),
                *DEVICE_ARGS[self.device], *self.server_args]

    def ensure_server(self) -> None:
        """Start the server if it is configured and not answering, then wait until it is ready."""
        if self.ready():
            return self.check_model()
        if not self.server:
            raise BackendError(f"no model server answers at {self.url}; start one, or set "
                               "[backends.local] server so acc starts llama-server itself")
        with _start_lock:
            if self.ready():
                return self.check_model()
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
            "logprobs": True,
            "top_logprobs": TOP_LOGPROBS,
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": "checks", "strict": True, "schema": schema}},
            # Thinking is off so the model answers like a decision model (Qwen3 templates read this).
            "chat_template_kwargs": {"enable_thinking": False},
        }

    def ask(self, system: str, prompt: str, stdin: str, schema: dict, timeout: float) -> dict:
        self.ensure_server()
        return parse_output(self.post(self.request(system, prompt, stdin, schema), timeout), schema)

    def post(self, request: dict, timeout: float) -> str:
        """POST a chat completion request; returns the raw response body."""
        body = json.dumps(request).encode()
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
        return raw


def list_devices(server: str) -> list[str]:
    """The GPUs a llama-server build can use, from `llama-server --list-devices`."""
    try:
        out = subprocess.run([server, "--list-devices"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [m.group(1) for m in re.finditer(r"^\s+\w+\d+: (.+?)(?: \(\d+ MiB.*)?$", out, re.M)]


def server_log() -> Path:
    return log.log_dir().parent / "llama-server.log"


def parse_output(raw: str, schema: dict | None = None) -> dict:
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
    tokens = (choice.get("logprobs") or {}).get("content")
    if schema and tokens:
        add_answer_probs(data, tokens, schema)
    return data


# ── confidence from token probabilities ──────────────────────────────────────

_NUMBER = re.compile(r"-?\d+(?:\.\d*)?")


def _resolve(text: str, answer_schema: dict) -> tuple[object, bool] | None:
    """The answer value a partial answer text stands for, and whether it is final.

    None means the text is not a valid answer, or still matches several. A number that
    has not ended stands for the middle of the range it covers ("0.8" -> 0.85).
    """
    if "enum" in answer_schema:
        core, closed = text.split('"', 1)[0].lower(), '"' in text
        hits = [v for v in answer_schema["enum"] if (v.lower() == core if closed else v.lower().startswith(core))]
        return (hits[0], True) if core and len(hits) == 1 else None
    m = _NUMBER.match(text)
    if not m:
        return None
    core, closed = m.group(), m.end() < len(text)
    if answer_schema.get("type") == "integer":
        return int(core), closed
    lo, hi = answer_schema.get("minimum", 0), answer_schema.get("maximum", 1)
    if closed:
        value = float(core)
    elif "." in core and not core.endswith("."):
        value = float(core) + 0.5 * 10 ** -(len(core) - core.index(".") - 1)
    elif float(core.rstrip(".")) >= hi:
        value = hi
    else:
        return None
    return round(min(max(value, lo), hi), 6), closed


def _alternatives(tokens: list[dict], starts: list[int], pos: int, answer_schema: dict) -> dict:
    """{answer value: probability} along the chosen tokens, from the answer's first character at `pos`."""
    i = max(k for k, s in enumerate(starts) if s <= pos)
    cut, prefix, path_p = pos - starts[i], "", 1.0
    probs: dict = {}
    for k in range(i, len(tokens)):
        tok, c = tokens[k], (cut if k == i else 0)
        for alt in tok.get("top_logprobs", []):
            if alt["token"] == tok["token"]:
                continue
            hit = _resolve(prefix + alt["token"][c:], answer_schema)
            if hit is not None:
                probs[hit[0]] = probs.get(hit[0], 0.0) + path_p * math.exp(alt["logprob"])
        prefix += tok["token"][c:]
        path_p *= math.exp(tok["logprob"])
        hit = _resolve(prefix, answer_schema)
        if hit is not None and hit[1]:
            probs[hit[0]] = probs.get(hit[0], 0.0) + path_p
            return probs
    return {}


def add_answer_probs(data: dict, tokens: list[dict], schema: dict) -> None:
    """Attach `answer_probs` ([[value, probability], ...], summing to 1) to each answer."""
    text, starts = "", []
    for tok in tokens:
        starts.append(len(text))
        text += tok["token"]
    specs = schema["properties"]["checks"].get("properties", {})
    pos = 0
    for key, entry in data["checks"].items():
        spec = specs.get(key, {}).get("properties", {}).get("answer")
        at = text.find(json.dumps(key), pos)
        m = re.compile(r'"answer"\s*:\s*"?').search(text, at) if spec and at >= 0 else None
        if not m or not isinstance(entry, dict):
            continue
        pos = m.end()
        probs = _alternatives(tokens, starts, m.end(), spec)
        total = sum(probs.values())
        if total > 0 and entry.get("answer") in probs:
            entry["answer_probs"] = [[v, round(p / total, 4)] for v, p in probs.items()
                                     if p / total >= 0.001 or v == entry["answer"]]

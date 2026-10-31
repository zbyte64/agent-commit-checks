"""Model backends. Each one turns (system, prompt, stdin, schema) into `{"checks": {...}}`."""

from __future__ import annotations

from typing import Protocol

from ..config import Config


class BackendError(RuntimeError):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class Backend(Protocol):
    name: str
    model: str

    def ask(self, system: str, prompt: str, stdin: str, schema: dict, timeout: float) -> dict: ...


def get_backend(cfg: Config, agent: str, override: str | None = None) -> Backend:
    name = override or cfg.backend_for(agent)
    settings = cfg.backend_settings(name)
    if name == "claude":
        from .claude import ClaudeBackend

        return ClaudeBackend(settings)
    if name == "omp":
        from .omp import OmpBackend

        return OmpBackend(settings, cfg.root)
    if name == "local":
        from .local import LocalBackend

        return LocalBackend(settings)
    if name == "fake":
        from .fake import FakeBackend

        return FakeBackend(settings, cfg.root)
    raise BackendError(f"unknown or unavailable backend {name!r}")

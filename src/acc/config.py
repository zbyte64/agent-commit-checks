"""Load `.acc/config.toml` with defaults."""

from __future__ import annotations

import copy
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib

ACC_DIR = ".acc"

DEFAULTS: dict[str, Any] = {
    "backends": {
        "claude": {"command": "claude", "model": "haiku"},
        "fake": {"answers": ""},
    },
    "agents": {},
    "run": {
        "max_diff_chars": 12000,
        "timeout_seconds": 90,
        "parallel": 4,
        "max_checks_per_call": 8,
        "max_commits": 20,
        "on_backend_error": "block",
        "secret_scan": True,
        "exclude_globs": [
            "**/package-lock.json",
            "**/yarn.lock",
            "**/pnpm-lock.yaml",
            "**/uv.lock",
            "**/poetry.lock",
            "**/Cargo.lock",
            "**/go.sum",
            "**/*.min.js",
            "**/*.min.css",
        ],
    },
    "grading": {
        "sample_size": 20,
        "min_sample": 10,
        "max_block_rate": 0.10,
        "max_unstable": 1,
        "max_history": 500,
    },
}


class ConfigError(ValueError):
    pass


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


@dataclass
class Config:
    root: Path
    data: dict = field(default_factory=lambda: copy.deepcopy(DEFAULTS))

    @property
    def acc_dir(self) -> Path:
        return self.root / ACC_DIR

    @property
    def checks_dir(self) -> Path:
        return self.acc_dir / "checks"

    @property
    def grades_dir(self) -> Path:
        return self.acc_dir / "grades"

    @property
    def run(self) -> dict:
        return self.data["run"]

    @property
    def grading(self) -> dict:
        return self.data["grading"]

    def backend_for(self, agent: str) -> str:
        """Backend name for an agent: `[agents.<name>] backend`, else the agent's own CLI."""
        return self.data.get("agents", {}).get(agent, {}).get("backend", agent)

    def backend_settings(self, name: str) -> dict:
        return self.data.get("backends", {}).get(name, {})


def expand_path(value: str) -> str:
    """Expand `~` and environment variables such as `$HOME`, so a committed config
    can name per-user binaries without hard-coding a username."""
    return os.path.expanduser(os.path.expandvars(value))


def home_relative(path: str) -> str:
    """The inverse for display: `/home/me/.local/bin/x` becomes `~/.local/bin/x`."""
    home = str(Path.home())
    return "~" + path[len(home):] if path == home or path.startswith(home + os.sep) else path


def load_config(root: Path) -> Config:
    path = root / ACC_DIR / "config.toml"
    data: dict = {}
    if path.exists():
        try:
            data = tomllib.loads(path.read_text())
        except tomllib.TOMLDecodeError as e:
            raise ConfigError(f"{path}: {e}") from e
    cfg = Config(root=root, data=_merge(DEFAULTS, data))
    for backend in cfg.data["backends"].values():
        if isinstance(backend.get("command"), str):
            backend["command"] = expand_path(backend["command"])
    if cfg.run["on_backend_error"] not in ("warn", "block"):
        raise ConfigError("run.on_backend_error must be 'warn' or 'block'")
    return cfg


def is_enabled(root: Path) -> bool:
    """A project opts in by having a `.acc/` directory."""
    return (root / ACC_DIR).is_dir()

"""Installing and inspecting the omp side: the extension file and omp's agent directory."""

from __future__ import annotations

import json
import os
from importlib import resources
from pathlib import Path

EXTENSION_NAME = "acc.ts"
ACC_PLACEHOLDER = "__ACC__"


def extension_source(acc: str) -> str:
    """The shipped extension with the absolute `acc` path filled in."""
    text = (resources.files("acc") / "adapters" / "omp" / EXTENSION_NAME).read_text()
    return text.replace(f'"{ACC_PLACEHOLDER}"', json.dumps(acc))


def agent_dir() -> Path:
    """omp's user agent directory (`PI_CODING_AGENT_DIR` overrides the default ~/.omp/agent)."""
    return Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".omp" / "agent")


def user_extension_path() -> Path:
    return agent_dir() / "extensions" / EXTENSION_NAME

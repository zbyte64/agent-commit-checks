"""Installing and inspecting the omp side: the extension file and omp's agent directory."""

from __future__ import annotations

import json
import os
import re
import subprocess
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


def extension_paths(root: Path) -> list[Path]:
    """Where omp would load the extension from: the project, then the user directory."""
    return [root / ".omp" / "extensions" / EXTENSION_NAME, user_extension_path()]


def extension_acc_path(text: str) -> str | None:
    """The `acc` path an installed extension calls, or None if the file is not ours."""
    m = re.search(r"^const ACC = (\".*\");$", text, re.MULTILINE)
    return json.loads(m.group(1)) if m else None


def install_extension(acc: str) -> tuple[Path, str]:
    """Write the extension to omp's user directory. Returns (path, installed|updated|unchanged)."""
    dest = user_extension_path()
    text = extension_source(acc)
    if dest.exists():
        if dest.read_text() == text:
            return dest, "unchanged"
        status = "updated"
    else:
        status = "installed"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text)
    return dest, status


def config_get(omp: str, key: str, cwd: Path) -> object | None:
    """A merged omp setting as seen from `cwd` (so project overlays count), or None if unavailable."""
    try:
        proc = subprocess.run([omp, "config", "get", key, "--json"], cwd=cwd, capture_output=True,
                              text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout).get("value")
    except (json.JSONDecodeError, AttributeError):
        return None


def gate_budget_ms(timeout_seconds: float) -> int:
    """Worst case for one gate run: a round of parallel batches, then a round of single retries."""
    return int(2 * timeout_seconds * 1000)

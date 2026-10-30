"""Operations shared by the CLI and the MCP server."""

from __future__ import annotations

from pathlib import Path

from . import checks as checks_mod
from . import git as g
from . import grading
from .backends import get_backend
from .checks import Check, CheckError
from .config import Config, load_config
from .pushrange import resolve_rev_range
from .runner import RunResult, review, select_checks


class OpError(RuntimeError):
    pass


def project(cwd: Path) -> tuple[Path, Config]:
    try:
        root = g.repo_root(cwd)
    except g.GitError as e:
        raise OpError(f"not inside a git repository: {cwd}") from e
    return root, load_config(root)


def list_checks(cfg: Config, status: str | None = None) -> list[dict]:
    loaded, errors = checks_mod.load_all(cfg.checks_dir)
    rows = []
    for c in loaded:
        if status and c.status != status:
            continue
        rows.append({
            "id": c.id, "title": c.title, "type": c.question_type, "scope": c.scope,
            "status": c.status, "enabled": c.enabled, "author": c.author,
            "grade": grading.grade_status(cfg, c),
        })
    for name, errs in errors.items():
        if not status:
            rows.append({"id": Path(name).stem, "invalid": True, "errors": errs})
    return rows


def get_check(cfg: Config, check_id: str) -> Check:
    path = cfg.checks_dir / f"{check_id}.toml"
    if not path.exists():
        raise OpError(f"no check named {check_id!r}")
    return checks_mod.load_file(path)


def run(cfg: Config, cwd: Path, agent: str, ids: list[str] | None = None, rev_range: str = "unpushed",
        include_proposed: bool = False, extra: list[Check] | None = None,
        backend_name: str | None = None) -> RunResult:
    loaded, _ = checks_mod.load_all(cfg.checks_dir)
    if extra is not None:
        selected = extra
    else:
        try:
            selected = select_checks(loaded, ids, gate=False, include_proposed=include_proposed)
        except KeyError as e:
            raise OpError(str(e.args[0])) from e
    push = resolve_rev_range(cwd, rev_range)
    return review(cfg, cwd, push, selected, get_backend(cfg, agent, backend_name))


def spec_to_check(spec: dict | str, *, author: str | None = None, status: str | None = None) -> Check:
    """Accept a check spec as a dict or TOML text; validate it like `acc validate`."""
    if isinstance(spec, str):
        d = checks_mod.tomllib.loads(spec)
    else:
        d = dict(spec)
    if author:
        d["author"] = author
    if status:
        d["status"] = status
    errs = checks_mod.validate_dict(d)
    if errs:
        raise CheckError(errs)
    text = checks_mod.dump_check(d)
    return checks_mod.parse_text(text, expected_id=d["id"])


def add_check(cfg: Config, spec: dict | str) -> Path:
    check = spec_to_check(spec, author="agent", status="proposed")
    path = cfg.checks_dir / f"{check.id}.toml"
    if path.exists():
        raise OpError(f"a check named {check.id!r} already exists; use update_check")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(checks_mod.dump_check(check.to_dict()))
    return path


def update_check(cfg: Config, check_id: str, spec: dict | str) -> Path:
    current = get_check(cfg, check_id)
    if current.author == "user":
        raise OpError(f"{check_id!r} was written by the user; agents may not update it")
    new = spec_to_check(spec, author="agent", status=current.status)
    if new.id != check_id:
        raise OpError("the spec id must match the check being updated")
    # An edited check can no longer block until it is graded again.
    if new.status == "active":
        new.status = "advisory"
    current.path.write_text(checks_mod.dump_check(new.to_dict()))
    grading.clear_grade(cfg, check_id)
    return current.path


def promote(cfg: Config, check_id: str, to: str, force: bool = False) -> dict:
    if to not in ("advisory", "active"):
        raise OpError("promotion target must be 'advisory' or 'active'")
    check = get_check(cfg, check_id)
    if to == "active" and not force:
        status = grading.grade_status(cfg, check)
        if status != "pass":
            hint = {
                "none": "it has no grade; run grade_check first",
                "stale": "the check changed since it was graded; grade it again",
                "fail": "its grade failed",
                "insufficient": "its grade had too few history commits",
            }.get(status, status)
            raise OpError(f"cannot promote {check_id!r} to active: {hint}")
    old, new = checks_mod.set_status(check.path, to)
    return {"path": str(check.path), "old_line": old, "new_line": new, "status": to}

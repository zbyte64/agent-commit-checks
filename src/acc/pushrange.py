"""Resolve which commits a push will send, from local refs only (no fetch)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from . import git as g
from .gitcmd import PushSpec


@dataclass
class PushedRef:
    name: str  # local ref or rev being pushed
    tip: str  # sha
    base: str  # sha (or empty tree) the branch diff is taken against


@dataclass
class PushRange:
    remote: str | None
    refs: list[PushedRef] = field(default_factory=list)
    commits: list[str] = field(default_factory=list)  # oldest first, union over refs
    description: str = ""
    note: str = ""  # shown to the agent, e.g. "push command not understood"

    @property
    def empty(self) -> bool:
        return not self.commits


def _resolve_remote(cwd: Path, name: str | None) -> str | None:
    """Map a push target (remote name, URL or path) to a configured remote name."""
    configured = g.remotes(cwd)
    if name is None:
        branch = g.current_branch(cwd)
        for key in (f"branch.{branch}.pushRemote" if branch else None, "remote.pushDefault",
                    f"branch.{branch}.remote" if branch else None):
            if key and (val := g.config_get(cwd, key)) and val in configured:
                return val
        if "origin" in configured:
            return "origin"
        return configured[0] if len(configured) == 1 else None
    if name in configured:
        return name
    for r in configured:
        if name in g.config_get_all(cwd, f"remote.{r}.url") + g.config_get_all(cwd, f"remote.{r}.pushurl"):
            return r
    return None


def _not_remote(remote: str | None) -> list[str]:
    return ["--not", f"--remotes={remote}"] if remote else ["--not", "--remotes"]


def _is_tag(cwd: Path, src: str) -> bool:
    if src.startswith("refs/tags/"):
        return True
    full = g.git_ok(cwd, "rev-parse", "--symbolic-full-name", src)
    if full and full.strip().startswith("refs/tags/"):
        return True
    # A name that is a tag but not a branch.
    return bool(g.git_ok(cwd, "show-ref", "--verify", "--quiet", f"refs/tags/{src}") is not None
                and g.git_ok(cwd, "show-ref", "--verify", "--quiet", f"refs/heads/{src}") is None)


def _local_branches(cwd: Path) -> list[str]:
    out = g.git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads/")
    return out.split()


def _expand_glob_refspec(cwd: Path, src: str) -> list[str]:
    prefix = src.split("*", 1)[0]
    out = g.git(cwd, "for-each-ref", "--format=%(refname)", prefix if prefix.endswith("/") else prefix + "*")
    return out.split()


def _default_sources(cwd: Path, remote: str | None) -> list[str]:
    """Refs a bare `git push [<remote>]` sends, per remote.<r>.push and push.default."""
    if remote:
        configured = g.config_get_all(cwd, f"remote.{remote}.push")
        if configured:
            return configured
    mode = g.config_get(cwd, "push.default") or "simple"
    if mode == "nothing":
        return []
    if mode == "matching":
        if not remote:
            return []
        out = g.git(cwd, "for-each-ref", "--format=%(refname:lstrip=3)", f"refs/remotes/{remote}/")
        return [f"refs/heads/{b}" for b in out.split()
                if b != "HEAD" and g.rev_parse(cwd, f"refs/heads/{b}")]
    branch = g.current_branch(cwd)
    return [f"refs/heads/{branch}"] if branch else []


def _source_refs(cwd: Path, spec: PushSpec, remote: str | None) -> list[str]:
    if spec.all_branches or spec.mirror:
        return _local_branches(cwd)
    if not spec.refspecs:
        return [] if spec.tags else _default_sources(cwd, remote)
    sources = []
    for rs in spec.refspecs:
        rs = rs.lstrip("+")
        src = rs.split(":", 1)[0] if ":" in rs else rs
        if not src:  # ":dst" deletes dst
            continue
        if src == "@":
            src = "HEAD"
        if "*" in src:
            sources.extend(r for r in _expand_glob_refspec(cwd, src) if not r.startswith("refs/tags/"))
        elif not _is_tag(cwd, src):
            sources.append(src)
    return sources


def _first_parent_base(cwd: Path, tip: str, remote: str | None) -> str:
    """Parent of the oldest unpushed commit on the tip's first-parent chain."""
    chain = g.git(cwd, "rev-list", "--first-parent", tip, *_not_remote(remote)).split()
    if not chain:
        return tip
    return g.first_parent(cwd, chain[-1])


def _commits_for(cwd: Path, tips: list[str], remote: str | None) -> list[str]:
    if not tips:
        return []
    out = g.git(cwd, "rev-list", "--reverse", "--topo-order", *tips, *_not_remote(remote))
    return out.split()


def resolve_push(cwd: Path, specs: list[PushSpec]) -> PushRange:
    """Union of the ranges of the push invocations in one command, all run in `cwd`."""
    refs: list[PushedRef] = []
    descriptions = []
    commits: list[str] = []
    seen: set[str] = set()
    remotes_seen: set[str | None] = set()
    for spec in specs:
        if spec.delete or spec.dry_run:
            continue
        remote = _resolve_remote(cwd, spec.remote)
        remotes_seen.add(remote)
        for src in _source_refs(cwd, spec, remote):
            sha = g.rev_parse(cwd, src)
            if not sha or any(r.tip == sha for r in refs):
                continue
            new = [c for c in _commits_for(cwd, [sha], remote) if c not in seen]
            if not new:
                continue
            seen.update(new)
            commits.extend(new)
            ref = PushedRef(src.removeprefix("refs/heads/"), sha, _first_parent_base(cwd, sha, remote))
            refs.append(ref)
            descriptions.append(f"{g.short(ref.base)}..{ref.name}")
    remote = next(iter(remotes_seen)) if len(remotes_seen) == 1 else None
    return PushRange(remote=remote, refs=refs, commits=commits, description=", ".join(descriptions))


def resolve_unpushed(cwd: Path) -> PushRange:
    """What a bare `git push` of the current branch would send; used by `acc run`."""
    remote = _resolve_remote(cwd, None)
    upstream = g.git_ok(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    head = g.rev_parse(cwd, "HEAD")
    if not head:
        return PushRange(remote=remote, description="(no commits)")
    base = _first_parent_base(cwd, head, remote)
    name = g.current_branch(cwd) or "HEAD"
    commits = _commits_for(cwd, [head], remote)
    desc = f"{upstream.strip()}..{name}" if upstream else f"{g.short(base)}..{name}"
    refs = [PushedRef(name, head, base)] if base != head else []
    return PushRange(remote=remote, refs=refs, commits=commits, description=desc)


def resolve_fallback(cwd: Path, reason: str) -> PushRange:
    """For commands we cannot parse: review `@{upstream}..HEAD` and say so."""
    r = resolve_unpushed(cwd)
    r.note = (f"acc could not tell exactly what this push sends ({reason}); "
              f"it reviewed {r.description or 'the unpushed commits on HEAD'} instead.")
    return r


def resolve_rev_range(cwd: Path, rev_range: str) -> PushRange:
    """An explicit `A..B` range, or a single rev meaning `<rev>` against remotes."""
    if rev_range == "unpushed":
        return resolve_unpushed(cwd)
    if ".." in rev_range:
        a, b = rev_range.split("..", 1)
        a, b = a or "HEAD", b or "HEAD"
        tip = g.rev_parse(cwd, b)
        if not tip or not g.rev_parse(cwd, a):
            raise g.GitError(f"unknown revision range {rev_range!r}")
        commits = g.git(cwd, "rev-list", "--reverse", "--topo-order", f"{a}..{b}").split()
        base = g.git(cwd, "merge-base", a, b).strip() or g.EMPTY_TREE
        refs = [PushedRef(b, tip, base)] if commits else []
        return PushRange(remote=None, refs=refs, commits=commits, description=rev_range)
    tip = g.rev_parse(cwd, rev_range)
    if not tip:
        raise g.GitError(f"unknown revision {rev_range!r}")
    commits = g.git(cwd, "rev-list", "--reverse", "--topo-order", tip, "--not", "--remotes").split()
    base = _first_parent_base(cwd, tip, None)
    refs = [PushedRef(rev_range, tip, base)] if commits else []
    return PushRange(remote=None, refs=refs, commits=commits, description=f"{g.short(base)}..{rev_range}")

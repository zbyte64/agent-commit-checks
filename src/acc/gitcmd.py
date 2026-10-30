"""Find `git push` invocations in a shell command string.

The parser is deliberately conservative: when it cannot tell what a command
does but the text mentions git and push, it returns kind="unknown" so the gate
reviews `@{upstream}..HEAD` instead of letting the push through unchecked.
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field

SEPARATORS = {"&&", "||", ";", "|", "&", "|&", ";;", "(", ")", "{", "}", "\n"}
WRAPPERS = {"command", "exec", "nohup", "time", "builtin", "sudo"}
KEYWORDS = {"do", "then", "else", "elif", "if", "while", "until", "!"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
# git subcommands that create commits the gate cannot see yet.
COMMIT_CREATING = {"commit", "merge", "cherry-pick", "revert", "am", "rebase", "pull"}
# git global options that take a separate value.
GIT_OPTS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
                       "--config-env", "--super-prefix", "--list-cmds"}
PUSH_OPTS_WITH_VALUE = {"-o", "--push-option", "--repo", "--receive-pack", "--exec",
                        "--recurse-submodules"}
MENTIONS_PUSH = re.compile(r"\bgit\b.*\bpush\b", re.S)
ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


@dataclass
class PushSpec:
    """One `git push` invocation."""

    args: list[str]
    cwd: str | None = None  # relative or absolute dir from `cd` / `git -C`
    remote: str | None = None
    refspecs: list[str] = field(default_factory=list)
    all_branches: bool = False
    mirror: bool = False
    tags: bool = False
    delete: bool = False
    dry_run: bool = False
    force: bool = False

    @property
    def tags_only(self) -> bool:
        return self.tags and not self.refspecs and not self.all_branches and not self.mirror


@dataclass
class ParsedCommand:
    kind: str  # none | push | commit_and_push | unknown
    pushes: list[PushSpec] = field(default_factory=list)
    reason: str = ""


# Redirections such as `2>&1`, `>out.log`, `&>/dev/null`; dropped before tokenizing
# so their targets are not mistaken for push arguments.
# Targets never swallow quote characters, so a `<name@host>` inside a quoted commit
# message cannot eat the closing quote.
REDIRECT = re.compile(r"(?<![\w>-])\d*(?:&>>?|>>?&?|<<<|<<-?|<&?)\s*(?:&?\d+-?(?=[\s;&|)]|$)|[^\s;&|()'\"]+)")


HEREDOC = re.compile(r"(?<!<)<<(-?)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
FEEDS_SHELL = re.compile(r"(?:^|[\s;&|(])(?:ba|z|da|k)?sh(?:\s+-\w+)*\s*$")


def _strip_heredocs(command: str) -> str:
    """Drop heredoc bodies, which are data rather than commands.

    A body fed to a shell (`bash <<EOF`) does run as commands, so it is kept and
    appended as extra command lines.
    """
    lines = command.split("\n")
    out: list[str] = []
    shell_bodies: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        for m in HEREDOC.finditer(line):
            strip_tabs, delim = m.group(1), m.group(3)
            body = []
            while i < len(lines):
                current = lines[i]
                i += 1
                if (current.lstrip("\t") if strip_tabs else current) == delim:
                    break
                body.append(current)
            if FEEDS_SHELL.search(line[: m.start()]):
                shell_bodies.extend(body)
    return "\n".join(out + shell_bodies)


def _tokenize(command: str) -> list[str]:
    lex = shlex.shlex(REDIRECT.sub(" ", command), posix=True, punctuation_chars=";&|()")
    lex.whitespace_split = True
    lex.commenters = "#"
    return list(lex)


def _segments(tokens: list[str]) -> list[list[str]]:
    segs: list[list[str]] = [[]]
    for tok in tokens:
        if tok in SEPARATORS or (tok and set(tok) <= set(";&|()")):
            segs.append([])
        else:
            segs[-1].append(tok)
    return [s for s in segs if s]


def _strip_prefix(argv: list[str]) -> list[str]:
    i = 0
    while i < len(argv):
        tok = argv[i]
        if ENV_ASSIGN.match(tok):
            i += 1
        elif tok == "env":
            i += 1
            while i < len(argv) and (ENV_ASSIGN.match(argv[i]) or argv[i].startswith("-")):
                i += 1
        elif tok in KEYWORDS:
            i += 1
        elif tok in WRAPPERS:
            i += 1
            while i < len(argv) and argv[i].startswith("-"):
                i += 1
        else:
            break
    return argv[i:]


def parse_push_args(args: list[str], cwd: str | None = None) -> PushSpec:
    spec = PushSpec(args=args, cwd=cwd)
    positionals: list[str] = []
    i = 0
    end_of_opts = False
    while i < len(args):
        a = args[i]
        if end_of_opts or not a.startswith("-") or a == "-":
            positionals.append(a)
        elif a == "--":
            end_of_opts = True
        elif a in PUSH_OPTS_WITH_VALUE:
            if a == "--repo" and i + 1 < len(args):
                spec.remote = args[i + 1]
            i += 1
        elif a.startswith("--repo="):
            spec.remote = a.split("=", 1)[1]
        elif a in ("--all", "--branches"):
            spec.all_branches = True
        elif a == "--mirror":
            spec.mirror = True
        elif a == "--tags":
            spec.tags = True
        elif a in ("-d", "--delete"):
            spec.delete = True
        elif a in ("-n", "--dry-run"):
            spec.dry_run = True
        elif a in ("-f", "--force") or a.startswith("--force-with-lease") or a == "--force-if-includes":
            spec.force = True
        elif not a.startswith("--") and len(a) > 2:
            # Combined short flags, e.g. -uf.
            flags = a[1:]
            spec.force |= "f" in flags
            spec.delete |= "d" in flags
            spec.dry_run |= "n" in flags
        i += 1
    if positionals:
        spec.remote = spec.remote or positionals[0]
        spec.refspecs = positionals[1:]
    return spec


def _has_expansion(tokens: list[str]) -> bool:
    return any("$" in t or "`" in t or "*" in t and not t.startswith("refs/") for t in tokens)


def _parse(command: str, depth: int = 0) -> ParsedCommand:
    try:
        tokens = _tokenize(_strip_heredocs(command).replace("\n", " ; "))
    except ValueError as e:
        return ParsedCommand("unknown", reason=f"could not parse the command ({e})")

    pushes: list[PushSpec] = []
    commit_seen = False
    commit_before_push = False
    unknown_reason = ""
    cd: str | None = None

    for argv in _segments(tokens):
        argv = _strip_prefix(argv)
        if not argv:
            continue
        prog = os.path.basename(argv[0])
        if prog == "cd" and len(argv) >= 2:
            target = argv[1]
            cd = target if os.path.isabs(target) or cd is None else os.path.join(cd, target)
            continue
        c_flag = next((j for j, a in enumerate(argv[1:], 1)
                       if a.startswith("-") and not a.startswith("--") and "c" in a), None)
        if prog in SHELLS and c_flag is not None:
            idx = c_flag
            if idx + 1 < len(argv) and depth < 3:
                inner = _parse(argv[idx + 1], depth + 1)
                for p in inner.pushes:
                    p.cwd = _join(cd, p.cwd)
                pushes.extend(inner.pushes)
                if inner.kind == "commit_and_push" or (commit_seen and inner.pushes):
                    commit_before_push = True
                if inner.kind == "unknown":
                    unknown_reason = inner.reason
            continue
        if prog == "eval" and depth < 3:
            inner = _parse(" ".join(argv[1:]), depth + 1)
            pushes.extend(inner.pushes)
            if inner.kind == "unknown" or inner.pushes:
                unknown_reason = unknown_reason or "push runs through eval"
            continue
        if prog != "git":
            continue

        i = 1
        git_cwd = cd
        while i < len(argv) and argv[i].startswith("-"):
            opt = argv[i]
            if opt == "-C" and i + 1 < len(argv):
                git_cwd = _join(git_cwd, argv[i + 1])
            if opt in GIT_OPTS_WITH_VALUE:
                i += 1
            i += 1
        if i >= len(argv):
            continue
        sub, rest = argv[i], argv[i + 1:]
        if sub in COMMIT_CREATING:
            commit_seen = True
        elif sub == "push":
            if commit_seen:
                commit_before_push = True
            if _has_expansion(rest) or (git_cwd and "$" in git_cwd):
                unknown_reason = "the push arguments use shell expansion"
            pushes.append(parse_push_args(rest, git_cwd))

    if commit_before_push:
        return ParsedCommand("commit_and_push", pushes,
                             "the command creates a commit and pushes in one step")
    if unknown_reason:
        return ParsedCommand("unknown", pushes, unknown_reason)
    if pushes:
        return ParsedCommand("push", pushes)
    if MENTIONS_PUSH.search(command) and re.search(r"\$\(|`|\beval\b|\bxargs\b|\bsource\b|^\s*\.", command):
        return ParsedCommand("unknown", reason="git push may run through shell indirection")
    return ParsedCommand("none")


def _join(base: str | None, path: str | None) -> str | None:
    if path is None:
        return base
    if base is None or os.path.isabs(path):
        return path
    return os.path.join(base, path)


def parse_command(command: str) -> ParsedCommand:
    """Classify a shell command: does it push, and can we tell what?"""
    if "push" not in command:
        return ParsedCommand("none")
    return _parse(command)

"""`acc mcp`: stdio MCP server exposing the runner as generic check tools.

The tool list is fixed, so a check file added during a session is usable at once.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult, TextContent

from . import grading, ops
from .backends import BackendError, get_backend
from .checks import CheckError
from .config import ConfigError
from .gate import format_result
from .git import GitError
from .runner import RunResult

INSTRUCTIONS = """\
Checks are model-backed reviews of commits, stored as TOML files in .acc/checks/.
`advisory` and `active` checks run automatically before every `git push`; only `active`
checks can block. To add a check: draft a spec, try it with test_check, save it with
add_check (it starts as `proposed`), then grade_check it against history and report the
result before promote_check moves it to `advisory` or `active`."""

SPEC_HELP = (
    "Check spec as a JSON object or TOML text with the check file fields: id, title, "
    "applies_to (globs), inputs (diff|message|file_list), "
    "question {type: bool|choice|score, instructions, labels | levels}, verdict, and optional "
    "grading {terms, expect_fail}. A check answers once about all the pushed commits together "
    "(their combined diff and every message). For bool checks `answer` is the probability that "
    "the question's answer is yes, so phrase the question so that yes means a problem."
)


def _result(text: str, data: Any) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=text)],
        structured_content=json.loads(json.dumps(data, default=str)),
    )


def _run_payload(res: RunResult) -> dict:
    return {
        "verdict": res.verdict,
        "range": res.range,
        "commits": [c[:7] for c in res.commits],
        "entries": [
            {
                "check": e.check_id, "status": e.status, "answer": e.answer,
                "verdict": e.verdict, "raw_verdict": e.raw_verdict, "summary": e.summary,
                "findings": e.findings, **({"error": e.error} if e.error else {}),
            }
            for e in res.entries
        ],
        "secret_hits": [{"commit": (h.commit or "")[:7], "file": h.file, "line": h.line,
                         "pattern": h.pattern, "severity": h.severity} for h in res.secret_hits],
        "checks_skipped_no_matching_paths": res.checks_skipped,
        "notes": res.notes,
        "calls": res.calls,
    }


def _run_text(res: RunResult) -> str:
    if not res.commits:
        return f"No commits to review in {res.range or 'the range'}."
    if res.verdict == "pass":
        ran = sorted({e.check_id for e in res.entries})
        return f"pass: {len(res.commits)} commit(s), checks run: {', '.join(ran) or 'none matched'}."
    return format_result(res)


def build_server(agent: str, cwd: Path | None = None) -> MCPServer:
    server = MCPServer(name="acc", instructions=INSTRUCTIONS)

    def project() -> tuple[Path, Any]:
        try:
            return ops.project(cwd or Path.cwd())
        except (ops.OpError, ConfigError) as e:
            raise ToolError(str(e)) from e

    def guarded(fn):
        try:
            return fn()
        except (ops.OpError, CheckError, BackendError, GitError, ConfigError, grading.GradeError) as e:
            raise ToolError(str(e)) from e

    @server.tool()
    def list_checks(status: Literal["proposed", "advisory", "active"] | None = None) -> CallToolResult:
        """List checks with id, title, type, status, author and grade result."""
        _, cfg = project()
        rows = ops.list_checks(cfg, status)
        lines = [
            f"{r['id']}: INVALID ({'; '.join(r['errors'])})" if r.get("invalid") else
            f"{r['id']} [{r['status']}, {r['type']}, by {r['author']}, grade {r['grade']}]: {r['title']}"
            for r in rows
        ]
        return _result("\n".join(lines) or "No checks defined.", {"checks": rows})

    @server.tool()
    def get_check(id: str) -> CallToolResult:
        """Return a check's TOML text."""
        _, cfg = project()
        check = guarded(lambda: ops.get_check(cfg, id))
        return _result(check.text, {"id": id, "path": str(check.path), "toml": check.text})

    @server.tool()
    def run_checks(ids: list[str] | None = None, range: str = "unpushed",
                   include_proposed: bool = False) -> CallToolResult:
        """Run checks against the unpushed commits (default) or a rev range like main..HEAD.

        With no ids, runs every enabled advisory and active check (plus proposed ones if
        include_proposed). Proposed checks run when named in ids.
        """
        root, cfg = project()
        res = guarded(lambda: ops.run(cfg, cwd or Path.cwd(), agent, ids, range, include_proposed))
        return _result(_run_text(res), _run_payload(res))

    @server.tool(description=f"Run an unsaved check spec against a range, as if it were active. {SPEC_HELP}")
    def test_check(spec: dict[str, Any] | str, range: str = "unpushed") -> CallToolResult:
        root, cfg = project()

        def go() -> RunResult:
            check = ops.spec_to_check(spec, status="active")
            return ops.run(cfg, cwd or Path.cwd(), agent, rev_range=range, extra=[check])

        res = guarded(go)
        return _result(_run_text(res), _run_payload(res))

    @server.tool()
    def grade_check(id: str, sample_size: int | None = None, commits: list[str] | None = None,
                    ranges: list[str] | None = None) -> CallToolResult:
        """Grade a check against ~20 relevant commits from history and write .acc/grades/<id>.json.

        Each unit is reviewed as a range, like a push. History units are single first-parent
        commits. Optionally grade each of `commits` on its own, or each `ranges` entry (A..B)
        as one unit; not both. Grades on chosen commits or ranges are useful for testing, but
        promote_check only accepts an automatic grade for `active`.
        Report the block rate and any ranges it would block to the user.
        """
        root, cfg = project()

        def go():
            check = ops.get_check(cfg, id)
            return grading.grade(cfg, root, check, get_backend(cfg, agent), sample_size,
                                 commits=commits, ranges=ranges)

        g = guarded(go)
        m = g.metrics
        lines = [f"Grade for {id}: {g.result}",
                 f"sample {m['sample_size']} of {m['pool_size']} eligible ranges; block rate "
                 f"{m['block_rate']:.0%} ({m['blocked']}); errors {m['errors']}; unstable {m['unstable']}"
                 + (f"; catch rate {m['catch_rate']:.0%}" if m["catch_rate"] is not None else "")]
        for s in g.record["sample"]:
            if s["verdict"] == "block":
                lines.append(f"would block {grading.short_range(s['range'])} ({s['reason']}): {s['summary']}")
        for x in g.record["excluded"]:
            lines.append(f"skipped {grading.short_range(x['range'])}: {x['reason']}")
        lines.append(f"wrote {g.path}")
        return _result("\n".join(lines), {**g.record, "path": str(g.path)})

    @server.tool(description=f"Validate and save a new check as author=agent, status=proposed. {SPEC_HELP}")
    def add_check(spec: dict[str, Any] | str) -> CallToolResult:
        _, cfg = project()
        path = guarded(lambda: ops.add_check(cfg, spec))
        return _result(f"wrote {path} (status proposed)", {"path": str(path), "status": "proposed"})

    @server.tool(description=("Replace an agent-authored check with a new full spec. Refused for checks "
                              f"written by the user. Clears the grade; an active check drops to advisory. {SPEC_HELP}"))
    def update_check(id: str, spec: dict[str, Any] | str) -> CallToolResult:
        _, cfg = project()
        path = guarded(lambda: ops.update_check(cfg, id, spec))
        return _result(f"wrote {path}; grade cleared", {"path": str(path)})

    @server.tool()
    def promote_check(id: str, to: Literal["advisory", "active"]) -> CallToolResult:
        """Change a check's status. `active` needs a passing automatic grade (grade_check without
        commits or range) for the check's current contents.

        Report the returned path and changed line to the user.
        """
        _, cfg = project()
        r = guarded(lambda: ops.promote(cfg, id, to, allow_hand_picked=False))
        return _result(f"{r['path']}: {r['old_line'] or '(none)'} -> {r['new_line']}", r)

    return server


def serve(agent: str) -> None:
    build_server(agent).run("stdio")

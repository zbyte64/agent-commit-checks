import asyncio

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from acc.mcp_server import build_server
from tests.conftest import check_toml

SPEC = {
    "id": "no-todo",
    "title": "No new TODO comments",
    "scope": "range",
    "applies_to": ["**/*"],
    "inputs": ["diff"],
    "question": {"type": "bool", "instructions": "Do the added lines add TODO comments?"},
    "verdict": {"block_at": 0.9, "warn_at": 0.5},
}


@pytest.fixture
def server(repo):
    repo.enable(checks={"user-check": check_toml("user-check", status="advisory")},
                answers={"*": {"answer": 0.95, "findings": [], "summary": "found one"}})
    return build_server("claude", cwd=repo.path)


def call(server, name, **args):
    return asyncio.run(server.call_tool(name, args))


def test_list_and_get(server):
    r = call(server, "list_checks")
    assert r.structured_content["checks"][0]["id"] == "user-check"
    assert "user-check" in r.content[0].text
    r = call(server, "get_check", id="user-check")
    assert 'id = "user-check"' in r.structured_content["toml"]


def test_run_checks_text_and_structure(server, repo):
    repo.commit()
    r = call(server, "run_checks")
    assert r.structured_content["verdict"] == "warn"  # advisory: block shown as warn
    assert r.structured_content["entries"][0]["raw_verdict"] == "block"
    assert "found one" in r.content[0].text


def test_test_check_does_not_save(server, repo):
    repo.commit()
    r = call(server, "test_check", spec=SPEC)
    assert r.structured_content["verdict"] == "block"
    assert not (repo.path / ".acc/checks/no-todo.toml").exists()


def test_add_check_flow(server, repo):
    r = call(server, "add_check", spec=SPEC)
    path = repo.path / ".acc/checks/no-todo.toml"
    assert r.structured_content["path"] == str(path)
    text = path.read_text()
    assert 'author = "agent"' in text and 'status = "proposed"' in text
    with pytest.raises(ToolError, match="already exists"):
        call(server, "add_check", spec=SPEC)
    # proposed checks run by name only
    repo.commit()
    ran = {e["check"] for e in call(server, "run_checks").structured_content["entries"]}
    assert ran == {"user-check"}
    ran = {e["check"] for e in call(server, "run_checks", ids=["no-todo"]).structured_content["entries"]}
    assert ran == {"no-todo"}


def test_add_check_accepts_toml_and_reports_validation(server):
    with pytest.raises(ToolError, match="question.type"):
        call(server, "add_check", spec={**SPEC, "question": {"type": "maybe", "instructions": "x"}})
    toml = check_toml("from-toml").replace('status = "active"', 'status = "active"')
    r = call(server, "add_check", spec=toml)
    assert r.structured_content["status"] == "proposed"


def test_update_refused_for_user_checks(server):
    with pytest.raises(ToolError, match="written by the user"):
        call(server, "update_check", id="user-check", spec={**SPEC, "id": "user-check"})


def test_update_agent_check_clears_grade(server, repo):
    call(server, "add_check", spec=SPEC)
    grade = repo.path / ".acc/grades/no-todo.json"
    grade.parent.mkdir(parents=True, exist_ok=True)
    grade.write_text("{}")
    call(server, "update_check", id="no-todo",
         spec={**SPEC, "question": {"type": "bool", "instructions": "Any TODO or FIXME added?"}})
    assert not grade.exists()
    assert "FIXME" in (repo.path / ".acc/checks/no-todo.toml").read_text()


def test_promote_active_refused_without_grade(server):
    call(server, "add_check", spec=SPEC)
    with pytest.raises(ToolError, match="no grade"):
        call(server, "promote_check", id="no-todo", to="active")
    r = call(server, "promote_check", id="no-todo", to="advisory")
    assert r.structured_content["new_line"] == 'status = "advisory"'


def test_grade_check_tool(server, repo):
    for i in range(12):
        repo.commit({f"f{i}.py": "x\n"})
    r = call(server, "grade_check", id="user-check")
    assert r.structured_content["result"] == "fail"  # every unit blocked
    assert "would block" in r.content[0].text

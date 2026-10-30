import json

from acc.cli import main
from tests.conftest import check_toml


def test_init_creates_acc_and_prints_snippets(repo, capsys, monkeypatch):
    monkeypatch.chdir(repo.path)
    assert main(["init"]) == 0
    out = capsys.readouterr().out
    assert (repo.path / ".acc/config.toml").exists()
    assert (repo.path / ".acc/checks/no-debug-leftovers.toml").exists()
    assert (repo.path / ".acc/grades/.gitkeep").exists()
    assert '"PreToolUse"' in out and '"gate"' in out and '"mcpServers"' in out
    assert main(["init"]) == 0
    assert "nothing created" in capsys.readouterr().out
    assert main(["validate"]) == 0


def test_list_validate(repo, capsys, monkeypatch):
    monkeypatch.chdir(repo.path)
    repo.enable(checks={"a": check_toml("a"), "b": "id = 'wrong'\n"})
    assert main(["list", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert rows[0]["id"] == "a" and rows[1]["invalid"]
    assert main(["validate"]) == 2
    assert "invalid" in capsys.readouterr().out


def test_run_exit_codes(repo, capsys, monkeypatch):
    monkeypatch.chdir(repo.path)
    repo.enable(checks={"a": check_toml("a")},
                answers={"*": {"answer": 0.1, "findings": [], "summary": "fine"}})
    assert main(["run"]) == 0  # nothing unpushed... except the untracked files
    repo.commit()
    assert main(["run"]) == 0
    (repo.path / "answers.json").write_text(json.dumps({"*": {"answer": 0.6, "findings": [], "summary": "hm"}}))
    assert main(["run"]) == 1
    (repo.path / "answers.json").write_text(json.dumps({"*": {"answer": 0.9, "findings": [], "summary": "no"}}))
    assert main(["run", "--json"]) == 2
    out = capsys.readouterr().out
    assert json.loads(out[out.index("{"):])["verdict"] == "block"
    assert main(["run", "--check", "missing"]) == 3


def test_promote_force(repo, capsys, monkeypatch):
    monkeypatch.chdir(repo.path)
    repo.enable(checks={"a": check_toml("a", status="proposed")})
    assert main(["promote", "a"]) == 3
    assert main(["promote", "a", "--force"]) == 0
    assert 'status = "active"' in capsys.readouterr().out


def test_doctor_offline(repo, capsys, monkeypatch):
    monkeypatch.chdir(repo.path)
    repo.enable(checks={"a": check_toml("a")})
    assert main(["doctor", "--offline"]) == 0
    out = capsys.readouterr().out
    assert "backend 'fake'" in out

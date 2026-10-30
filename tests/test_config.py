import os

from acc.cli import main
from acc.config import home_relative, load_config


def write_config(root, command):
    (root / ".acc").mkdir(exist_ok=True)
    (root / ".acc/config.toml").write_text(f'[backends.claude]\ncommand = "{command}"\n')


def test_tilde_and_home_expand(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", "/home/someone")
    for command in ("~/.local/bin/claude", "$HOME/.local/bin/claude", "${HOME}/.local/bin/claude"):
        write_config(tmp_path, command)
        assert load_config(tmp_path).backend_settings("claude")["command"] == "/home/someone/.local/bin/claude"


def test_plain_names_untouched(tmp_path):
    write_config(tmp_path, "claude")
    assert load_config(tmp_path).backend_settings("claude")["command"] == "claude"


def test_home_relative(monkeypatch):
    monkeypatch.setenv("HOME", "/home/someone")
    assert home_relative("/home/someone/.local/bin/claude") == "~/.local/bin/claude"
    assert home_relative("/home/someoneelse/bin/claude") == "/home/someoneelse/bin/claude"
    assert home_relative("/usr/bin/claude") == "/usr/bin/claude"


def test_init_writes_home_relative_path(repo, tmp_path, monkeypatch, capsys):
    home = tmp_path / "home"
    bindir = home / ".local/bin"
    bindir.mkdir(parents=True)
    claude = bindir / "claude"
    claude.write_text("#!/bin/sh\necho '9.9.9 (Claude Code)'\n")
    claude.chmod(0o755)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.chdir(repo.path)
    assert main(["init"]) == 0
    text = (repo.path / ".acc/config.toml").read_text()
    assert 'command = "~/.local/bin/claude"' in text
    assert str(home) not in text
    capsys.readouterr()
    assert main(["doctor", "--offline"]) == 0
    out = capsys.readouterr().out
    assert f"[ok  ] backends.claude.command is absolute: {claude}" in out

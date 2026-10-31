"""The local backend against a stand-in OpenAI-compatible server, and its config switch."""

import json
import socket
import subprocess
import sys
import textwrap
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from acc.backends import BackendError, get_backend
from acc.backends.local import LocalBackend, parse_output
from acc.cli import enable_local, main
from acc.config import load_config

SCHEMA = {"type": "object", "properties": {"checks": {"type": "object"}}, "required": ["checks"]}


def completion(content, finish="stop"):
    return json.dumps({"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": finish}]})


class Server:
    """Answers /v1/models and /v1/chat/completions with canned replies; records request bodies."""

    def __init__(self):
        self.replies: list[tuple[int, str]] = []
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body.encode())

            def do_GET(self):
                self.send(200, '{"data": []}')

            def do_POST(self):
                outer.requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send(*outer.replies.pop(0))

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()


@pytest.fixture
def server():
    s = Server()
    yield s
    s.httpd.shutdown()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_answer_and_request_shape(server):
    server.replies.append((200, completion('{"checks": {"a": {"answer": 0.1}}}')))
    out = LocalBackend({"url": server.url, "model": "m"}).ask("sys", "QUESTION", "DATA", SCHEMA, 5)
    assert out == {"checks": {"a": {"answer": 0.1}}}
    req = server.requests[0]
    assert req["model"] == "m" and req["temperature"] == 0
    assert req["response_format"]["json_schema"]["schema"] == SCHEMA
    assert req["chat_template_kwargs"] == {"enable_thinking": False}
    user = req["messages"][1]["content"]
    assert user.index("DATA") < user.index("QUESTION") < user.index("JSON Schema")


@pytest.mark.parametrize("code,retryable", [(503, True), (429, True), (400, False)])
def test_http_errors(server, code, retryable):
    server.replies.append((code, '{"error": "nope"}'))
    with pytest.raises(BackendError, match=f"returned {code}") as e:
        LocalBackend({"url": server.url}).ask("s", "p", "", SCHEMA, 5)
    assert e.value.retryable is retryable


@pytest.mark.parametrize("raw,match", [
    (completion('{"checks": {"a": ', "length"), "cut off"),
    (completion("yes"), "not a JSON object"),
    (completion('{"result": {}}'), "no `checks` object"),
    ('{"error": "x"}', "no chat completion"),
])
def test_invalid_answers_are_retryable(raw, match):
    with pytest.raises(BackendError, match=match) as e:
        parse_output(raw)
    assert e.value.retryable


def test_no_server_and_no_autostart():
    backend = LocalBackend({"url": f"http://127.0.0.1:{free_port()}", "server": ""})
    with pytest.raises(BackendError, match="no model server answers"):
        backend.ask("s", "p", "", SCHEMA, 5)


def test_starts_the_server_when_down(tmp_path, monkeypatch):
    monkeypatch.setenv("ACC_LOG_DIR", str(tmp_path / "logs"))
    # A stand-in llama-server: serves on --port, answers every completion with one fixed answer.
    script = tmp_path / "llama-server"
    script.write_text(f"#!{sys.executable}\n" + textwrap.dedent(f"""
        import json, sys
        from http.server import BaseHTTPRequestHandler, HTTPServer
        open({str(tmp_path / "argv.json")!r}, "w").write(json.dumps(sys.argv[1:]))
        body = {completion('{"checks": {}}')!r}.encode()
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def reply(self):
                if self.command == "POST":
                    self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200); self.end_headers(); self.wfile.write(body)
            do_GET = do_POST = reply
        HTTPServer(("127.0.0.1", int(sys.argv[sys.argv.index("--port") + 1])), H).serve_forever()
    """))
    script.chmod(0o755)
    port = free_port()
    backend = LocalBackend({"url": f"http://127.0.0.1:{port}", "model": "org/repo:Q8_0", "server": str(script),
                            "server_args": ["--ctx-size", "4096"]})
    try:
        assert backend.ask("s", "p", "", SCHEMA, 5) == {"checks": {}}
        argv = json.loads((tmp_path / "argv.json").read_text())
        assert argv == ["-hf", "org/repo:Q8_0", "--alias", "org/repo:Q8_0", "--host", "127.0.0.1",
                        "--port", str(port), "--ctx-size", "4096"]
    finally:
        subprocess.run(["pkill", "-f", str(script)])


def test_enable_local_edits_only_the_run_table():
    text = '[agents.claude]\nbackend = "fake"\n\n[run]\n# backend = "local"   # note\ntimeout_seconds = 90\n'
    out = enable_local(text, "llama-server")
    assert '[agents.claude]\nbackend = "fake"' in out
    assert '[run]\nbackend = "local"\ntimeout_seconds = 90' in out
    assert "[backends.local]" in out
    assert enable_local(out, "llama-server") == out
    assert enable_local("[run]\nparallel = 2\n", "s").startswith('[run]\nbackend = "local"\nparallel = 2')
    assert enable_local("", "s").endswith('[run]\nbackend = "local"\n')


def test_init_local(repo, capsys, monkeypatch):
    monkeypatch.chdir(repo.path)
    assert main(["init", "--local"]) == 0
    cfg = load_config(repo.path)
    assert cfg.backend_for("claude") == cfg.backend_for("omp") == "local"
    assert get_backend(cfg, "omp").name == "local"
    assert "set run.backend" in capsys.readouterr().out


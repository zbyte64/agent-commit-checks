"""The local backend against a stand-in OpenAI-compatible server, and its config switch."""

import json
import math
import socket
import subprocess
import sys
import textwrap
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from acc import checks
from acc.backends import BackendError, get_backend
from acc.backends.local import DEFAULT_URL, DEVICE_ARGS, LocalBackend, parse_output
from acc.cli import enable_local, main, set_keys
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
                        "--port", str(port), "--device", "none", "--ctx-size", "4096"]
    finally:
        subprocess.run(["pkill", "-f", str(script)])


def test_set_keys_edits_only_its_table():
    text = '[agents.claude]\nbackend = "fake"\n\n[run]\n# backend = "local"   # note\ntimeout_seconds = 90\n'
    out = set_keys(text, "run", {"backend": '"local"'})
    assert out == '[agents.claude]\nbackend = "fake"\n\n[run]\nbackend = "local"\ntimeout_seconds = 90\n'
    assert set_keys(out, "run", {"backend": '"local"'}) == out
    assert set_keys("[run]\nparallel = 2\n", "run", {"backend": '"x"'}) == '[run]\nbackend = "x"\nparallel = 2\n'
    assert set_keys("", "run", {"backend": '"x"'}) == '[run]\nbackend = "x"\n'
    # defaults only fill missing keys
    assert set_keys('[t]\nurl = "mine"\n', "t", {}, defaults={"url": '"d"', "server": '"s"'}) == \
        '[t]\nserver = "s"\nurl = "mine"\n'


@pytest.mark.parametrize("preset,backend", [("cpu", "local"), ("gpu", "local")])
def test_enable_local_presets(tmp_path, preset, backend):
    (tmp_path / ".acc").mkdir()
    (tmp_path / ".acc/config.toml").write_text(enable_local('[run]\nparallel = 2\n', preset, "llama-server"))
    cfg = load_config(tmp_path)
    assert cfg.backend_for("claude") == backend
    if backend == "local":
        local = LocalBackend(cfg.backend_settings("local"))
        assert local.device == preset and local.server == "llama-server"
        assert local.server_argv()[-len(DEVICE_ARGS[preset]) - 4:-4] == DEVICE_ARGS[preset]


def test_switching_presets_keeps_url_and_server():
    text = enable_local("", "cpu", "/opt/llama-server").replace(DEFAULT_URL, "http://127.0.0.1:9000")
    out = enable_local(text, "gpu", "llama-server")
    assert 'device = "gpu"' in out and 'url = "http://127.0.0.1:9000"' in out
    assert 'server = "/opt/llama-server"' in out and out.count("[backends.local]") == 1


def test_unknown_device():
    with pytest.raises(BackendError, match="device must be one of cpu, gpu"):
        LocalBackend({"device": "tpu"})


def test_refuses_a_server_with_another_model(server):
    server.httpd.RequestHandlerClass.do_GET = lambda h: h.send(200, '{"data": [{"id": "other/model"}]}')
    with pytest.raises(BackendError, match="serves other/model, not mine/model"):
        LocalBackend({"url": server.url, "model": "mine/model"}).ask("s", "p", "", SCHEMA, 5)


def test_init_local(repo, capsys, monkeypatch):
    monkeypatch.chdir(repo.path)
    assert main(["init", "--local"]) == 0
    cfg = load_config(repo.path)
    assert cfg.backend_for("claude") == cfg.backend_for("omp") == "local"
    assert get_backend(cfg, "omp").name == "local"
    assert "set run.backend" in capsys.readouterr().out


# ── confidence from token probabilities ──────────────────────────────────────


def tok(text, p=1.0, **alts):
    return {"token": text, "logprob": math.log(p),
            "top_logprobs": [{"token": t, "logprob": math.log(q)} for t, q in alts.items()]}


def answer_with(tokens, schema):
    raw = json.dumps({"choices": [{"message": {"content": "".join(t["token"] for t in tokens)},
                                   "finish_reason": "stop", "logprobs": {"content": tokens}}]})
    return parse_output(raw, schema)["checks"]


def check(text):
    return checks.parse_text(textwrap.dedent(text), "c")


CHOICE = check("""
    id = "c"
    title = "t"
    [question]
    type = "choice"
    instructions = "q"
    labels = { accurate = "a", incomplete = "i", wrong = "w" }
    [verdict]
    accurate = "pass"
    incomplete = "block"
    wrong = "block"
""")
BOOL = check("""
    id = "c"
    title = "t"
    [question]
    type = "bool"
    instructions = "q"
    [verdict]
    block_at = 0.85
    warn_at = 0.5
""")


def schema_for(c):
    checks_schema = {"type": "object", "properties": {"c": checks.answer_schema(c)}}
    return {"type": "object", "properties": {"checks": checks_schema}}


def test_choice_probabilities_from_tokens():
    # "In" counts for `incomplete` (case is ignored); "The" is not a label and is dropped.
    tokens = [tok('{"checks": {"c": {"answer": "'), tok("acc", 0.5, In=0.2, inc=0.1, The=0.1, wr=0.05),
              tok("urate"), tok('", "confidence": 1, "findings": [], "summary": "s"}}}')]
    entry = answer_with(tokens, schema_for(CHOICE))["c"]
    assert dict(entry["answer_probs"]) == pytest.approx({"accurate": 0.5 / 0.85, "incomplete": 0.3 / 0.85,
                                                         "wrong": 0.05 / 0.85}, abs=1e-4)
    verdict, _, _, confidence = checks.validate_entry(CHOICE, entry)
    assert verdict == "pass"
    assert confidence == pytest.approx(0.5 / 0.85, abs=1e-3)  # not the self-reported 1


def test_number_probabilities_and_verdict_mass():
    # The model wrote 0.9, with 0.1 on "1", 0.27 on "0.1…" and 0.09 on "0.8…".
    tokens = [tok('{"checks": {"c": {"answer": '), tok("0", 0.9, **{"1": 0.1}), tok("."),
              tok("9", 0.6, **{"1": 0.3, "8": 0.1}), tok(', "confidence": 1, "findings": [], "summary": "s"}}}')]
    entry = answer_with(tokens, schema_for(BOOL))["c"]
    assert dict(entry["answer_probs"]) == pytest.approx({1: 0.1, 0.15: 0.27, 0.85: 0.09, 0.9: 0.54}, abs=1e-4)
    verdict, _, _, confidence = checks.validate_entry(BOOL, entry)
    assert verdict == "block"
    assert confidence == pytest.approx(0.73, abs=1e-3)  # every answer at or above block_at


def test_without_logprobs_self_reported_confidence_stands():
    raw = completion('{"checks": {"c": {"answer": "wrong", "confidence": 0.8, "findings": [], "summary": "s"}}}')
    entry = parse_output(raw, schema_for(CHOICE))["checks"]["c"]
    assert "answer_probs" not in entry
    assert checks.validate_entry(CHOICE, entry)[3] == 0.8

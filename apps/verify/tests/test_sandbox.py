"""The parent and its children, on this machine (P2.1.md C1–C6, C8–C13). Local mode: children run as this user.

The checks that need `runner`, a read-only root and no network run in the real container: `bun run verify:escape`.
"""

import json
import os
import random
import socket
import tempfile
import time
import unittest
from pathlib import Path

import sympy as sp

from gem_verify import compare, contract, options, parsing, sampling, server
from gem_verify import values as V


def run(program: str, **extra: object) -> dict:
    return server.Supervisor().run_sync({"kind": "run", "program": program, **extra})


def value(raw: object) -> dict:
    return V.serialize(raw)


SAMPLING = {
    "intMin": -9,
    "intMax": 9,
    "vectorMin": 3,
    "vectorMax": 5,
    "matrixMin": 2,
    "matrixMax": 3,
    "constraintDraws": 50,
    "targetDraws": 2000,
}


def sample_request(**over: object) -> dict:
    return {
        "kind": "sample_inputs",
        "inputs": [{"name": "x", "kind": "vector", "size": [], "from": "sample", "sourceText": ""}],
        "constraint": "",
        "answerProgram": "",
        "type": "numeric",
        "quotes": [],
        "chunks": [],
        "used": [],
        "usedSource": [],
        "seed": "s1",
        "sampling": SAMPLING,
        **over,
    }


class RunTest(unittest.TestCase):
    def test_c1_value_kinds_with_latex(self) -> None:
        cases = [
            ("result = 6", "integer", "6", "6"),
            ("from fractions import Fraction\nresult = Fraction(3, 4)", "rational", "3/4", r"\frac{3}{4}"),
            ("from sympy import Rational\nresult = Rational(-3, 4)", "rational", "-3/4", r"- \frac{3}{4}"),
            ("result = 2.5", "decimal", "2.5", "2.5"),
            ("import numpy as np\nresult = np.float64(0.25)", "decimal", "0.25", "0.25"),
            ("import numpy as np\nresult = np.int64(7)", "integer", "7", "7"),
            ("result = [1, 2, 3]", "vector", ["1", "2", "3"], r"\begin{bmatrix}1 & 2 & 3\end{bmatrix}^T"),
            ("from sympy import Matrix\nresult = Matrix([1, 2])", "vector", ["1", "2"], None),
            ("import numpy as np\nresult = np.array([1, 2])", "vector", ["1", "2"], None),
            (
                "result = [[1, 2], [3, 4]]",
                "matrix",
                [["1", "2"], ["3", "4"]],
                r"\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}",
            ),
            ("from sympy import sqrt\nresult = sqrt(38)", "expression", "sqrt(38)", r"\sqrt{38}"),
            (
                "from sympy import symbols\nn = symbols('n')\nresult = 2*n - 1",
                "expression",
                "2*n - 1",
                "2 n - 1",
            ),
            ("result = True", "boolean", "True", r"\text{True}"),
            ("from sympy import Integer\nresult = Integer(2) > 1", "boolean", "True", None),
        ]
        for program, kind, text, latex in cases:
            with self.subTest(program=program):
                reply = run(program)
                self.assertEqual(reply["status"], "ok", reply)
                self.assertEqual(reply["value"]["kind"], kind)
                self.assertEqual(reply["value"]["value"], text)
                self.assertTrue(reply["value"]["latex"])
                if latex is not None:
                    self.assertEqual(reply["value"]["latex"], latex)

    def test_c1_q7(self) -> None:
        program = (
            "from sympy import Matrix\nx = Matrix([2, 4, -3]); y = Matrix([5, -2, 1])\nresult = x.dot(y)"
        )
        reply = run(program)
        self.assertEqual(reply["value"]["value"], "-1")
        self.assertEqual(reply["value"]["text"], "-1")
        self.assertTrue(reply["value"]["decimalExact"])

    def test_inputs_are_sympy_values(self) -> None:
        inputs = {"x": value([1, 2, 3]), "a": value(2), "r": value(sp.Rational(1, 3))}
        reply = run("result = a * r * x.dot(x)", inputs=inputs)
        self.assertEqual(reply["value"]["value"], "28/3")

    def test_program_errors_are_classified(self) -> None:
        for program, error_type in [
            ("result = 1/0", "ZeroDivisionError"),
            ("import math\nresult = math.sqrt(-1)", "ValueError"),
            ("result = undefined_name", "NameError"),
            ("x = 1", "NameError"),
            ("def (", "SyntaxError"),
            ("import definitely_not_here", "ModuleNotFoundError"),
            ("result = 'text'", "ResultTypeError"),
            ("result = {'a': 1}", "ResultTypeError"),
            ("result = float('nan')", "ResultTypeError"),
            ("import sys\nsys.exit(0)", "SystemExit"),
        ]:
            with self.subTest(program=program):
                reply = run(program)
                self.assertEqual(reply["status"], "program_error", reply)
                self.assertEqual(reply["errorType"], error_type)
                self.assertNotIn("value", reply)

    def test_print_is_harmless(self) -> None:
        self.assertEqual(run("print('hi')\nresult = 1")["status"], "ok")

    def test_c2_fresh_process(self) -> None:
        supervisor = server.Supervisor()
        one = supervisor.run_sync({"kind": "run", "program": "import os\nresult = os.getpid()"})
        two = supervisor.run_sync({"kind": "run", "program": "import os\nresult = os.getpid()"})
        self.assertNotEqual(one["value"]["value"], two["value"]["value"])

    def test_c2_no_state_between_runs(self) -> None:
        supervisor = server.Supervisor()
        supervisor.run_sync({"kind": "run", "program": "import sympy\nsympy.LEAK = 41\nresult = 0"})
        reply = supervisor.run_sync(
            {"kind": "run", "program": "import sympy\nresult = getattr(sympy, 'LEAK', 0) + 1"}
        )
        self.assertEqual(reply["value"]["value"], "1")

    def test_c2_patch_does_not_reach_the_parent(self) -> None:
        supervisor = server.Supervisor()
        supervisor.run_sync(
            {"kind": "run", "program": "import sympy\nsympy.Matrix.dot = lambda *a, **k: 99\nresult = 0"}
        )
        program = "from sympy import Matrix\nresult = Matrix([1, 2]).dot(Matrix([3, 4]))"
        self.assertEqual(supervisor.run_sync({"kind": "run", "program": program})["value"]["value"], "11")

    def test_c3_environment_and_fds(self) -> None:
        program = (
            "import os\n"
            "fds = []\n"
            "for fd in range(64):\n"
            "    try:\n"
            "        os.fstat(fd)\n"
            "        fds.append(fd)\n"
            "    except OSError:\n"
            "        pass\n"
            "result = [len(os.environ), *fds]"
        )
        os.environ["GEM_TEST_SECRET"] = "x"
        try:
            reply = run(program)
        finally:
            del os.environ["GEM_TEST_SECRET"]
        self.assertEqual(reply["value"]["value"], ["0", "3"])

    def test_c4_process_limit(self) -> None:
        self.assertEqual(run("import os\nos.fork()\nresult = 1")["status"], "sandbox_denial")

    def test_c4_memory_limit(self) -> None:
        reply = run("x = bytearray(2 * 1024 * 1024 * 1024)\nresult = 1")
        self.assertEqual(reply["status"], "sandbox_denial")
        self.assertEqual(reply["errorType"], "MemoryError")

    def test_c4_cpu_limit(self) -> None:
        reply = run("while True:\n    pass")
        self.assertEqual(reply["status"], "timeout")

    def test_c4_wall_clock_kills_a_sleeping_child(self) -> None:
        supervisor = server.Supervisor(wall_clock_s=0.5)
        started = time.monotonic()
        reply = supervisor.run_sync({"kind": "run", "program": "import time\ntime.sleep(60)"})
        self.assertEqual(reply["status"], "timeout")
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(supervisor.recycle)

    def test_c4_wall_clock_kills_the_process_group(self) -> None:
        # A child's NPROC limit stops it forking, so the group kill is tested on a stand-in without that limit.
        with tempfile.TemporaryDirectory() as d:
            marker = Path(d) / "grandchild"
            leader = os.fork()
            if leader == 0:
                os.setpgid(0, 0)
                if os.fork() == 0:
                    time.sleep(0.5)
                    marker.write_text("survived")
                    os._exit(0)
                time.sleep(60)
                os._exit(0)
            os.setpgid(leader, leader) if os.getpgid(leader) != leader else None
            job = server.Job(conn=None, request={}, pid=leader)  # type: ignore[arg-type]
            server.Supervisor().kill(job)
            os.waitpid(leader, 0)
            time.sleep(0.8)
            self.assertFalse(marker.exists())

    def test_c4_result_over_the_cap(self) -> None:
        supervisor = server.Supervisor()
        reply = supervisor.run_sync(
            {"kind": "run", "program": "from sympy import Symbol\nresult = Symbol('x' * 70000)"}
        )
        self.assertEqual(reply["status"], "invalid_output")
        self.assertTrue(supervisor.recycle)

    def test_c7_local_ten_megabyte_and_invalid_json(self) -> None:
        for program in [
            "import os\nos.write(3, b'{' * 10_000_000)",
            "import os\nos.write(3, b'not json')\nos._exit(0)",
            "import os\nos.write(3, b'[' * 60000)\nos._exit(0)",
            'import os\nos.write(3, b\'{"status": "ok", "extra": 1}\')\nos._exit(0)',
            "import os\nos._exit(0)",
        ]:
            with self.subTest(program=program[:40]):
                supervisor = server.Supervisor()
                reply = supervisor.run_sync({"kind": "run", "program": program})
                self.assertEqual(reply["status"], "invalid_output", reply)
                self.assertTrue(supervisor.recycle)

    def test_death_by_signal_is_a_denial(self) -> None:
        reply = run("import os, signal\nos.kill(os.getpid(), signal.SIGSEGV)")
        self.assertEqual(reply["status"], "sandbox_denial")

    def test_c6_a_write_fails(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            program = f"with open({str(Path(d) / 'f')!r}, 'w') as f:\n    f.write('x' * 100)\nresult = 1"
            reply = run(program)
            self.assertEqual(reply["status"], "sandbox_denial", reply)
            self.assertEqual((Path(d) / "f").read_bytes() if (Path(d) / "f").exists() else b"", b"")

    def test_c23_math_errors_are_not_denials(self) -> None:
        for program in ["result = 1/0", "import numpy as np\nresult = np.linalg.inv(np.zeros((2, 2)))"]:
            self.assertEqual(run(program)["status"], "program_error", program)

    def test_reply_carries_version_and_duration(self) -> None:
        reply = run("result = 1")
        self.assertIn("sympy/", reply["sandboxVersion"])
        self.assertGreaterEqual(reply["durationMs"], 0)


class ParentTest(unittest.TestCase):
    def serve(self, supervisor: server.Supervisor, path: str) -> socket.socket:
        srv = server.bind(path)
        supervisor.add_listener(srv)
        return srv

    def ask(self, supervisor: server.Supervisor, path: str, request: bytes) -> dict | None:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as c:
            c.connect(path)
            c.sendall(request)
            c.setblocking(False)
            buf = b""
            for _ in range(5000):
                supervisor.step(0.01)
                try:
                    chunk = c.recv(65536)
                except BlockingIOError:
                    continue
                buf += chunk
                if not chunk or b"\n" in buf:
                    break
            return json.loads(buf) if buf else None

    def test_c5_a_child_cannot_use_the_socket(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = str(Path(d) / "v.sock")
            supervisor = server.Supervisor()
            srv = self.serve(supervisor, path)
            program = (
                "import socket\n"
                "s = socket.socket(socket.AF_UNIX)\n"
                f"s.connect({path!r})\n"
                's.sendall(b\'{"kind": "health"}\\n\')\n'
                "result = len(s.recv(100))"
            )
            reply = self.ask(
                supervisor, path, json.dumps({"kind": "run", "program": program}).encode() + b"\n"
            )
            self.assertEqual(reply["status"], "sandbox_denial", reply)
            self.assertEqual(reply["errorType"], "PeerRefused")
            self.assertTrue(supervisor.recycle)
            srv.close()

    def test_health_while_a_child_runs(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = str(Path(d) / "v.sock")
            supervisor = server.Supervisor(wall_clock_s=1.0)
            srv = self.serve(supervisor, path)
            slow = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            slow.connect(path)
            slow.sendall(
                json.dumps({"kind": "run", "program": "import time\ntime.sleep(0.5)\nresult=1"}).encode()
                + b"\n"
            )
            for _ in range(20):
                supervisor.step(0.01)
            self.assertIsNotNone(supervisor.job)
            health = self.ask(supervisor, path, b'{"kind": "health"}\n')
            self.assertTrue(health["ok"])
            self.assertIsNotNone(supervisor.job)
            while supervisor.job is not None:
                supervisor.step(0.01)
            self.assertEqual(json.loads(slow.makefile().readline())["status"], "ok")
            slow.close()
            srv.close()

    def test_c8_recycles_at_the_budget(self) -> None:
        supervisor = server.Supervisor(recycle_every=2)
        supervisor.run_sync({"kind": "run", "program": "result = 1"})
        self.assertFalse(supervisor.recycle)
        supervisor.run_sync({"kind": "run", "program": "result = 1"})
        self.assertTrue(supervisor.recycle)

    def test_c8_a_request_can_set_the_budget(self) -> None:
        supervisor = server.Supervisor()
        supervisor.run_sync({"kind": "run", "program": "result = 1", "recycleEvery": 1})
        self.assertTrue(supervisor.recycle)

    def test_c8_recycles_after_each_anomaly(self) -> None:
        for program in ["import os\nos.fork()", "x = bytearray(2 << 30)", "import os\nos._exit(0)"]:
            supervisor = server.Supervisor()
            supervisor.run_sync({"kind": "run", "program": program})
            self.assertTrue(supervisor.recycle, program)

    def test_an_ordinary_error_is_not_an_anomaly(self) -> None:
        supervisor = server.Supervisor()
        supervisor.run_sync({"kind": "run", "program": "result = 1/0"})
        self.assertFalse(supervisor.recycle)

    def test_request_limits(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = str(Path(d) / "v.sock")
            supervisor = server.Supervisor()
            srv = self.serve(supervisor, path)
            self.assertEqual(
                self.ask(supervisor, path, b"not json\n"), {"ok": False, "error": "invalid_json"}
            )
            self.assertEqual(
                self.ask(supervisor, path, b'{"kind": "nope"}\n'),
                {"ok": False, "error": "unsupported_request"},
            )
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as c:
                c.connect(path)
                c.setblocking(False)
                sent, big, buf = 0, b"x" * (300 * 1024), b""
                for _ in range(2000):
                    supervisor.step(0.001)
                    try:
                        sent += c.send(big[sent : sent + 65536]) if sent < len(big) else 0
                        buf += c.recv(4096)
                    except (BlockingIOError, BrokenPipeError):
                        continue
                    if b"\n" in buf:
                        break
                self.assertEqual(json.loads(buf), {"ok": False, "error": "request_too_large"})
            srv.close()

    def test_privdrop_is_refused_when_required(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("root can drop")
        with self.assertRaises(SystemExit):
            server.check_privdrop(True)
        reply = server.Supervisor(require_privdrop=True).run_sync({"kind": "run", "program": "result = 1"})
        self.assertEqual(reply, {"ok": False, "error": "privdrop_failed"})


class ParseTest(unittest.TestCase):
    def parsed(self, text: str) -> dict:
        return parsing.parse_options([text])[0]

    def test_c9_values(self) -> None:
        cases = [
            ("6", "6"),
            ("-1", "-1"),
            ("−1", "-1"),
            ("0.5", "0.5"),
            ("1/2", "1/2"),
            ("$-3/4$", "-3/4"),
            (r"$\frac{1}{2}$", "1/2"),
            (r"\frac{1}{2}", "1/2"),
            (r"$-\frac{3}{4}$", "-3/4"),
            (r"$\dfrac{3}{4}$", "3/4"),
            (r"$\sqrt{38}$", "sqrt(38)"),
            (r"$2\sqrt{14}$", "2*sqrt(14)"),
            ("2n - 1", "2*n - 1"),
            ("$2n - 1$", "2*n - 1"),
            ("$2n - 1$ flops", "2*n - 1"),
            ("$n$ flops", "n"),
            ("1 flop", "1"),
            ("$n^2$ flops", "n**2"),
            ("-3e_1 + 8e_2 + e_3", None),
            ("True", "True"),
            ("false", "False"),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                result = self.parsed(text)
                self.assertTrue(result["ok"], result)
                if expected is not None:
                    self.assertEqual(result["value"]["value"], expected)

    def test_c9_vectors_and_matrices(self) -> None:
        cases = [
            (r"$\begin{bmatrix} 3 \\ 2 \\ 3 \end{bmatrix}$", "vector", ["3", "2", "3"]),
            (r"$\begin{bmatrix} 3 & 2 & 3 \end{bmatrix}^T$", "vector", ["3", "2", "3"]),
            (r"$\begin{pmatrix} 3 \\ -2 \end{pmatrix}$", "vector", ["3", "-2"]),
            (r"\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}", "matrix", [["1", "2"], ["3", "4"]]),
            (r"$\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}^T$", "matrix", [["1", "2"], ["3", "4"]]),
            ("[1, 2, 3]", "vector", ["1", "2", "3"]),
            ("[4, 2, 3]^T", "vector", ["4", "2", "3"]),
            ("(1, -2, 2)", "vector", ["1", "-2", "2"]),
            ("[[1, 2], [3, 4]]", "matrix", [["1", "2"], ["3", "4"]]),
            (r"$\begin{bmatrix} \frac{1}{2} \\ \sqrt{2} \end{bmatrix}$", "vector", ["1/2", "sqrt(2)"]),
        ]
        for text, kind, expected in cases:
            with self.subTest(text=text):
                result = self.parsed(text)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["value"]["kind"], kind)
                self.assertEqual(result["value"]["value"], expected)

    def test_c9_malformed_is_per_option(self) -> None:
        results = parsing.parse_options(
            [r"$\frac{$", "3", r"$\begin{bmatrix} 1 & \\ 2 \end{bmatrix}$", "$1/0$"]
        )
        self.assertEqual([r["ok"] for r in results], [False, True, False, False])
        self.assertEqual(results[0]["reason"], "parse_error")

    def test_prose_is_not_a_value(self) -> None:
        for text in [
            "Undefined",
            "Orthogonal",
            "Total portfolio value in dollars",
            "The sum of the squares of its entries, $\\sum_{i=1}^n x_i^2$",
            "$x + y = y + x$ and $x = y$",
        ]:
            with self.subTest(text=text):
                self.assertEqual(self.parsed(text), {"ok": False, "reason": "text"})

    def test_parse_runs_as_a_request(self) -> None:
        reply = server.Supervisor().run_sync({"kind": "parse_options", "texts": ["1/2", r"$\frac{$"]})
        self.assertEqual(reply["status"], "ok")
        self.assertEqual([r["ok"] for r in reply["results"]], [True, False])


class CompareTest(unittest.TestCase):
    def equal(self, a: str, b: str, tolerance: float = 1e-6) -> bool:
        pa, pb = parsing.parse_options([a, b])
        return compare.compare(pa["value"], [pb["value"]], tolerance)[0]["equal"]

    def test_c10(self) -> None:
        self.assertTrue(self.equal("0.5", r"$\frac{1}{2}$"))
        self.assertTrue(self.equal(r"$\sqrt{38}$", "6.164414002968976"))
        self.assertFalse(self.equal("1", "-1"))
        self.assertFalse(self.equal(r"$\sqrt{38}$", "6.2"))
        self.assertTrue(self.equal("2n - 1", "$2n-1$ flops"))
        self.assertTrue(self.equal("[1, 2]", r"$\begin{bmatrix} 1 \\ 2 \end{bmatrix}$"))
        self.assertFalse(self.equal("[1, 2]", "[1, 2, 3]"))
        self.assertTrue(self.equal("True", "true"))
        self.assertFalse(self.equal("True", "1"))

    def test_c10_symbols_compare_by_name(self) -> None:
        reply = server.Supervisor().run_sync(
            {
                "kind": "run",
                "program": "from sympy import symbols\nn = symbols('n', positive=True)\nresult = 2*n",
            }
        )
        got = compare.compare(reply["value"], [parsing.parse_options(["2n"])[0]["value"]], 1e-6)
        self.assertTrue(got[0]["equal"])

    def test_c10_guard_stops_a_pathological_expression(self) -> None:
        heavy = "((" + "+".join(f"x{i}" for i in range(9)) + ")**60)"
        a = {"kind": "expression", "value": f"expand({heavy})", "latex": "", "text": ""}
        b = {"kind": "expression", "value": f"expand({heavy}) + 1", "latex": "", "text": ""}
        started = time.monotonic()
        reply = compare.compare(a, [b], 1e-6)
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(reply, [{"equal": False, "guard": True}])

    def test_compare_as_a_request(self) -> None:
        reply = server.Supervisor().run_sync(
            {
                "kind": "compare",
                "a": value(sp.Rational(1, 2)),
                "candidates": [value(0.5), value(1)],
                "tolerance": 1e-6,
            }
        )
        self.assertEqual([r["equal"] for r in reply["results"]], [True, False])


class SampleTest(unittest.TestCase):
    def test_c11_defaults_over_1000_draws(self) -> None:
        rng = random.Random("defaults")
        decl = {"name": "x", "kind": "vector", "size": [], "from": "sample", "sourceText": ""}
        for _ in range(1000):
            n = rng.randint(3, 5)
            v = list(sampling.sample_value(decl, n, rng, SAMPLING))
            self.assertTrue(3 <= len(v) <= 5)
            self.assertTrue(all(-9 <= x <= 9 for x in v))
            self.assertLess(min(v), 0)
            self.assertLessEqual(v.count(0), 1)
            self.assertGreater(len(set(v)), 1)
            self.assertNotIn(tuple(v), sampling.TEXTBOOK)
            i = sampling.sample_value({**decl, "kind": "integer"}, n, rng, SAMPLING)
            self.assertTrue(-9 <= i <= 9)
            m = sampling.sample_value({**decl, "kind": "matrix"}, n, rng, SAMPLING)
            self.assertTrue(2 <= m.rows <= 3 and 2 <= m.cols <= 3)

    def test_c11_textbook_values_are_refused(self) -> None:
        for v in [[1, 2], [3, 4], [1, 2, 3], [4, 5, 6], [1, 0, 0], [0, 1], [-1, 0], [2, 2, 2], [0, 0, -1]]:
            self.assertFalse(sampling._vector_ok(v), v)
        self.assertTrue(sampling._vector_ok([2, -1, 3]))

    def test_c11_short_vectors_avoid_textbook_values(self) -> None:
        rng = random.Random("short")
        for _ in range(1000):
            self.assertTrue(sampling._vector_ok(sampling.sample_vector(2, rng, SAMPLING)))

    def test_c11_constraint_redraws_then_fails(self) -> None:
        reply = server.Supervisor().run_sync(sample_request(constraint="valid = x.dot(x) != 0"))
        self.assertIn("x", reply["inputs"])
        reply = server.Supervisor().run_sync(sample_request(constraint="valid = False"))
        self.assertEqual(reply["failure"], "constraint_unmet")

    def test_c11_constraint_error_fails(self) -> None:
        reply = server.Supervisor().run_sync(sample_request(constraint="valid = 1/0"))
        self.assertEqual(reply["failure"], "constraint_error")

    def test_c11_true_target_on_orthogonality_within_2000_draws(self) -> None:
        inputs = [
            {"name": "x", "kind": "vector", "size": [3], "from": "sample", "sourceText": ""},
            {"name": "y", "kind": "vector", "size": [3], "from": "sample", "sourceText": ""},
        ]
        hits = 0
        targets = 0
        for i in range(12):
            reply = server.Supervisor().run_sync(
                sample_request(
                    inputs=inputs,
                    type="true_false",
                    answerProgram="result = x.dot(y) == 0",
                    seed=f"orth{i}",
                )
            )
            self.assertEqual(reply["status"], "ok", reply)
            if reply["target"]:
                targets += 1
                hits += reply["hitTarget"]
                self.assertEqual(
                    sum(
                        int(a) * int(b)
                        for a, b in zip(
                            reply["inputs"]["x"]["value"], reply["inputs"]["y"]["value"], strict=True
                        )
                    ),
                    0,
                )
        self.assertGreater(targets, 0)
        self.assertEqual(hits, targets)

    def test_c11_impossible_target_is_reported(self) -> None:
        for i in range(8):
            reply = server.Supervisor().run_sync(
                sample_request(
                    type="true_false",
                    answerProgram="result = False",
                    seed=f"never{i}",
                    sampling={**SAMPLING, "targetDraws": 5},
                )
            )
            if reply["target"]:
                self.assertFalse(reply["hitTarget"])
                return
        self.fail("no True target in 8 seeds")

    def test_c11_same_seed_same_output(self) -> None:
        make = lambda: server.Supervisor().run_sync(sample_request(seed="same"))  # noqa: E731
        self.assertEqual(make()["inputs"], make()["inputs"])
        self.assertNotEqual(
            make()["inputs"], server.Supervisor().run_sync(sample_request(seed="other"))["inputs"]
        )

    def test_used_value_sets_are_skipped(self) -> None:
        first = server.Supervisor().run_sync(sample_request(seed="u"))
        second = server.Supervisor().run_sync(sample_request(seed="u", used=[first["key"]]))
        self.assertNotEqual(first["key"], second["key"])

    def test_source_values_first_once_per_test(self) -> None:
        chunk = "For example, with x = (1, −2, 2) and y = (3, 0, -1), the product is 1."
        reply = server.Supervisor().run_sync(sample_request(chunks=[chunk]))
        self.assertEqual(reply["inputs"]["x"]["value"], ["1", "-2", "2"])
        second = server.Supervisor().run_sync(sample_request(chunks=[chunk], usedSource=reply["sourceUsed"]))
        self.assertEqual(second["inputs"]["x"]["value"], ["3", "0", "-1"])
        third = server.Supervisor().run_sync(
            sample_request(chunks=[chunk], usedSource=reply["sourceUsed"] + second["sourceUsed"])
        )
        self.assertEqual(third["sourceUsed"], [])

    def test_source_matrix_in_a_chunk(self) -> None:
        chunk = r"Take $A = \begin{bmatrix} 1 & -2 \\ 3 & 0 \end{bmatrix}$ as given data."
        inputs = [{"name": "A", "kind": "matrix", "size": [], "from": "sample", "sourceText": ""}]
        reply = server.Supervisor().run_sync(sample_request(inputs=inputs, chunks=[chunk]))
        self.assertEqual(reply["inputs"]["A"]["value"], [["1", "-2"], ["3", "0"]])

    def test_chunk_values_failing_the_constraint_are_sampled_instead(self) -> None:
        reply = server.Supervisor().run_sync(
            sample_request(chunks=["x = (1, 1, 1)"], constraint="valid = x[0] != x[1]")
        )
        self.assertEqual(reply["sourceUsed"], [])
        self.assertNotEqual(reply["inputs"]["x"]["value"], ["1", "1", "1"])

    def test_explicit_source_must_be_quoted(self) -> None:
        inputs = [{"name": "n", "kind": "integer", "size": [], "from": "source", "sourceText": "8"}]
        ok = server.Supervisor().run_sync(sample_request(inputs=inputs, quotes=["A pack of 8 pens."]))
        self.assertEqual(ok["inputs"]["n"]["value"], "8")
        bad = server.Supervisor().run_sync(sample_request(inputs=inputs, quotes=["A pack of pens."]))
        self.assertEqual(bad["failure"], "source_not_in_quote")

    def test_a_denial_inside_a_constraint_is_a_denial(self) -> None:
        reply = server.Supervisor().run_sync(sample_request(constraint="import os\nos.fork()\nvalid = True"))
        self.assertEqual(reply["status"], "sandbox_denial", reply)


class BuildTest(unittest.TestCase):
    def build(self, answer: object, mistakes: list[object], seed: str = "b1", n: int = 3) -> dict:
        request = {
            "kind": "build_options",
            "answer": value(answer),
            "mistakes": [
                {"value": value(m), "whyWrong": f"m{i}", "program": f"p{i}"} for i, m in enumerate(mistakes)
            ],
            "seed": seed,
            "distractorCount": n,
        }
        reply = server.Supervisor().run_sync(request)
        self.assertEqual(reply["status"], "ok", reply)
        return reply

    def test_c12_four_options_by_default(self) -> None:
        for answer in [
            7,
            sp.Rational(3, 4),
            sp.sqrt(38),
            [1, -2, 3],
            [[1, 2], [3, 4]],
            2.5,
            sp.Symbol("n") * 2 - 1,
        ]:
            for seed in ("a", "b", "c", "d"):
                with self.subTest(answer=answer, seed=seed):
                    reply = self.build(answer, [], seed)
                    texts = [o["text"] for o in reply["options"]]
                    self.assertEqual(len(texts), 4)
                    self.assertEqual(len(set(texts)), 4)
                    correct = [o for o in reply["options"] if o["isCorrect"]]
                    self.assertEqual(len(correct), 1)
                    self.assertEqual(correct[0]["text"], reply["correctAnswer"])

    def test_c12_up_to_two_common_at_least_one_random(self) -> None:
        reply = self.build(10, [11, 12, 13, 14])
        sources = sorted(d["source"] for d in reply["distractors"])
        self.assertEqual(sources, ["common", "common", "random"])
        common = [d for d in reply["distractors"] if d["source"] == "common"]
        self.assertEqual(common[0]["program"], "p0")
        self.assertEqual(common[0]["reason"], "m0")

    def test_c12_never_the_answer_among_the_wrong(self) -> None:
        reply = self.build(5, [5, 5.0, sp.Rational(10, 2), 6, 6])
        reasons = [d["reason"] for d in reply["dropped"]]
        self.assertEqual(reasons.count("equals the answer"), 3)
        self.assertEqual(reasons.count("duplicate"), 1)
        wrong = [o["text"] for o in reply["options"] if not o["isCorrect"]]
        self.assertNotIn("5", wrong)

    def test_c12_shape_matches(self) -> None:
        reply = self.build([1, 2, 3], [7, [1, 2], [[1, 2], [3, 4]], [9, 9, 9]])
        self.assertEqual(sum(d["reason"] == "different shape from the answer" for d in reply["dropped"]), 3)
        for o in reply["options"]:
            self.assertIn(r"\begin{bmatrix}", o["text"])
            self.assertEqual(o["text"].count("&"), 2)

    def test_c12_seeded_order(self) -> None:
        self.assertEqual(self.build(7, [8], "s")["options"], self.build(7, [8], "s")["options"])
        orders = {tuple(o["text"] for o in self.build(7, [8], f"s{i}")["options"]) for i in range(6)}
        self.assertGreater(len(orders), 1)

    def test_c12_one_formatter(self) -> None:
        reply = self.build(sp.Rational(1, 2), [sp.Rational(2, 3)], "f")
        self.assertTrue(
            all(
                o["text"].startswith(("$", "-$")) or o["text"].lstrip("-").isdigit() for o in reply["options"]
            )
        )

    def test_c12_float_becomes_exact(self) -> None:
        self.assertEqual(
            self.build(2 * sp.sqrt(14), [7.483314773547883])["dropped"][0]["reason"], "equals the answer"
        )
        reply = self.build(5, [7.483314773547883])
        self.assertIn(r"$2 \sqrt{14}$", [o["text"] for o in reply["options"]])

    def test_c12_float_with_no_exact_form_is_rounded(self) -> None:
        reply = self.build(5, [3.14159265358979])
        self.assertTrue(any(o["text"] in ("3.142", r"$\pi$") for o in reply["options"]), reply["options"])

    def test_distractor_count_is_honoured(self) -> None:
        self.assertEqual(len(self.build(9, [], n=5)["options"]), 6)
        one = self.build(9, [8, 7], n=1)
        self.assertEqual(len(one["options"]), 2)
        self.assertEqual(one["distractors"][0]["source"], "random")


class ContractTest(unittest.TestCase):
    def test_c13_requests_are_validated(self) -> None:
        self.assertTrue(contract.valid_request({"kind": "health"}))
        self.assertTrue(contract.valid_request({"kind": "run", "program": "x"}))
        self.assertFalse(contract.valid_request({"kind": "run"}))
        self.assertFalse(contract.valid_request({"kind": "run", "program": 1}))
        self.assertFalse(contract.valid_request({"kind": "run", "program": "x", "nope": 1}))
        self.assertFalse(contract.valid_request({"kind": "run", "program": "x" * 5000}))
        self.assertFalse(contract.valid_request({"kind": "parse_options", "texts": []}))
        self.assertFalse(
            contract.valid_request({"kind": "compare", "a": {}, "candidates": [], "tolerance": 0})
        )
        self.assertFalse(contract.valid_request("health"))

    def test_c13_replies_are_validated(self) -> None:
        self.assertTrue(contract.valid_reply("run", {"status": "ok", "value": value(1)}))
        self.assertFalse(contract.valid_reply("run", {"status": "nope"}))
        self.assertFalse(contract.valid_reply("run", {"status": "ok", "extra": 1}))
        self.assertFalse(contract.valid_reply("run", {"status": "ok", "value": {"kind": "integer"}}))

    def test_c13_an_unknown_schema_keyword_is_an_error(self) -> None:
        with self.assertRaises(ValueError):
            contract.valid({"oneOfMany": []}, 1)


class SerializeTest(unittest.TestCase):
    def test_round_trip(self) -> None:
        for raw in [
            3,
            sp.Rational(-1, 3),
            0.25,
            [1, 2],
            [[1, 2], [3, 4]],
            sp.sqrt(2),
            sp.Symbol("n") + 1,
            True,
        ]:
            with self.subTest(raw=raw):
                data = V.serialize(raw)
                self.assertEqual(V.serialize(V.deserialize(data))["value"], data["value"])

    def test_decimal_strings(self) -> None:
        self.assertEqual(V.serialize(sp.Rational(1, 4))["decimal"], "0.25")
        self.assertTrue(V.serialize(sp.Rational(1, 4))["decimalExact"])
        self.assertFalse(V.serialize(sp.Rational(1, 3))["decimalExact"])
        self.assertFalse(V.serialize(sp.sqrt(38))["decimalExact"])
        self.assertEqual(V.serialize(sp.sqrt(4))["decimal"], "2")
        self.assertNotIn("decimal", V.serialize(sp.Symbol("n")))

    def test_option_formatter(self) -> None:
        self.assertEqual(V.format_value(sp.Integer(-1)), "-1")
        self.assertEqual(V.format_value(sp.Rational(-3, 4)), r"$-\frac{3}{4}$")
        self.assertEqual(V.format_value(sp.Matrix([1, 2])), r"$\begin{bmatrix}1 & 2\end{bmatrix}^T$")
        self.assertEqual(
            V.format_value(sp.Matrix([[1, 2], [3, 4]])), r"$\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}$"
        )
        self.assertEqual(V.format_value(sp.sqrt(2)), r"$\sqrt{2}$")
        self.assertEqual(V.format_value(sp.true), "True")

    def test_options_module_kinds(self) -> None:
        self.assertEqual(options.kind(sp.Integer(1)), ("int",))
        self.assertEqual(options.kind(sp.sqrt(2)), ("real",))
        self.assertEqual(options.kind(sp.Symbol("n")), ("symbolic",))


if __name__ == "__main__":
    unittest.main()

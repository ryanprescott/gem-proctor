"""Unit tests for the verify skeleton (stdlib unittest): python -m unittest discover -s tests."""

import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from gem_verify import server


class HandleTest(unittest.TestCase):
    def test_health_reports_pinned_versions(self) -> None:
        reply = server.handle({"kind": "health"})
        self.assertEqual(reply["ok"], True)
        self.assertEqual(reply["sympy"], server.sympy.__version__)
        self.assertEqual(reply["numpy"], server.numpy.__version__)

    def test_unknown_requests_get_an_error_code(self) -> None:
        self.assertEqual(server.handle({"kind": "run"}), {"ok": False, "error": "unsupported_request"})
        self.assertEqual(server.handle([1, 2]), {"ok": False, "error": "unsupported_request"})


class SocketTest(unittest.TestCase):
    def test_round_trip_over_unix_socket(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = str(Path(d) / "run" / "v.sock")
            srv = server.bind(path)

            def accept_once() -> None:
                conn, _ = srv.accept()
                server.serve_connection(conn)

            t = threading.Thread(target=accept_once)
            t.start()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as c:
                c.connect(path)
                c.sendall(b'{"kind": "health"}\n')
                data = c.makefile().readline()
            t.join()
            srv.close()
            self.assertTrue(json.loads(data)["ok"])


if __name__ == "__main__":
    unittest.main()

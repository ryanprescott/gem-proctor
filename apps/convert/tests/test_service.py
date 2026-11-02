"""The service end to end over HTTP, with the stub engine (docs/P2.2.md M1 to M5): caps, one at a time, a deadline that
follows the page count, a worker that is replaced after a timeout, a crash and every Nth conversion."""

from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from dataclasses import replace
from http.server import ThreadingHTTPServer
from typing import Any

from gem_convert import contract
from gem_convert.config import Config
from gem_convert.manager import Manager
from gem_convert.server import make_handler


def _running(pid: int) -> bool:
    """Alive and not a zombie (a killed child waits to be reaped by its parent, which is gone)."""
    try:
        with open(f"/proc/{pid}/stat") as fp:
            return fp.read().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def pdf(*flags: str) -> bytes:
    return b"%PDF-1.4\n" + b"".join(f"%STUB:{f}\n".encode() for f in flags)


class Service:
    """A running service on a free port; `close()` stops it."""

    def __init__(self, **overrides: Any) -> None:
        self.work = tempfile.TemporaryDirectory()
        settings: dict[str, Any] = {
            "engine": "stub",
            "port": 0,
            "work_dir": self.work.name,
            "base_seconds": 3,
            "seconds_per_page": 1,
            "inspect_seconds": 5,
            "load_seconds": 30,
            **overrides,
        }
        self.config = replace(Config(), **settings)
        self.manager = Manager(self.config)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.config, self.manager))
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        for _ in range(300):
            if self.health()["models"] == "ready":
                return
            time.sleep(0.05)
        raise AssertionError("the stub never became ready")

    def health(self) -> dict[str, Any]:
        with urllib.request.urlopen(f"{self.url}/health", timeout=10) as r:
            return json.load(r)

    def convert(
        self, body: bytes, options: dict[str, Any] | None = None, timeout: float = 30
    ) -> tuple[int, dict[str, Any]]:
        headers = {"content-type": "application/pdf"}
        if options is not None:
            headers["x-gem-options"] = json.dumps(options)
        request = urllib.request.Request(f"{self.url}/convert", data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as err:
            return err.code, json.load(err)

    def close(self) -> None:
        self.server.shutdown()
        self.manager.stop()
        self.work.cleanup()


class Basics(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.service = Service(max_bytes=10_000, max_pages=5)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.service.close()

    def test_m1_health_and_a_conversion_match_the_contract(self) -> None:
        health = self.service.health()
        self.assertTrue(contract.valid_health(health), health)
        self.assertEqual((health["engine"], health["models"], health["busy"]), ("stub", "ready", False))
        status, reply = self.service.convert(pdf("pages=3"), {"pageRange": "2-3"})
        self.assertEqual(status, 200, reply)
        self.assertTrue(contract.valid_reply(reply), reply)
        self.assertEqual((reply["pageCount"], reply["pagesConverted"]), (3, 2))
        self.assertIn("$x^T y = 0$", reply["markdown"])
        self.assertEqual(reply["strategy"], "rasterize")

    def test_m2_options_are_checked_against_the_contract(self) -> None:
        for bad in ({"pageRange": "five"}, {"strategy": "magic"}, {"extra": 1}):
            status, body = self.service.convert(pdf(), bad)
            self.assertEqual((status, body["code"]), (400, "bad_request"), bad)
            self.assertTrue(contract.valid_error(body))

    def test_m4_caps_and_what_is_not_a_pdf(self) -> None:
        status, body = self.service.convert(b"MZ\x90\x00 not a pdf")
        self.assertEqual((status, body["code"]), (415, "not_pdf"))
        status, body = self.service.convert(pdf() + b"x" * 10_000)
        self.assertEqual((status, body["code"]), (413, "too_large"))
        status, body = self.service.convert(pdf("pages=6"))
        self.assertEqual((status, body["code"]), (422, "too_many_pages"))
        status, body = self.service.convert(pdf("pages=4"), {"pageRange": "3-9"})
        self.assertEqual((status, body["code"]), (422, "bad_range"))
        status, body = self.service.convert(pdf("bad"))
        self.assertEqual((status, body["code"]), (422, "bad_pdf"))
        status, body = self.service.convert(pdf("empty"))
        self.assertEqual((status, body["code"]), (422, "empty"))
        # Each refusal left the service working.
        self.assertEqual(self.service.convert(pdf())[0], 200)
        self.assertEqual(self.service.health()["workerStarts"], 1)

    def test_m4_an_engine_failure_is_failed_and_the_worker_lives(self) -> None:
        status, body = self.service.convert(pdf("raise"))
        self.assertEqual((status, body["code"]), (500, "failed"))
        self.assertEqual(self.service.convert(pdf())[0], 200)
        self.assertEqual(self.service.health()["workerStarts"], 1)

    def test_m4_a_page_range_is_a_page_count(self) -> None:
        status, reply = self.service.convert(pdf("pages=5"), {"pageRange": "1,3-4"})
        self.assertEqual((status, reply["pagesConverted"]), (200, 3))


class OneAtATime(unittest.TestCase):
    def test_m3_a_second_request_waits_and_health_answers_meanwhile(self) -> None:
        service = Service()
        try:
            results: list[tuple[int, dict[str, Any]]] = []
            started = time.monotonic()
            threads = [
                threading.Thread(target=lambda: results.append(service.convert(pdf("sleep=1"))), daemon=True)
                for _ in range(2)
            ]
            for t in threads:
                t.start()
                time.sleep(0.3)
            seen = service.health()
            self.assertTrue(seen["busy"])
            self.assertEqual(seen["queued"], 1)
            for t in threads:
                t.join(30)
            self.assertEqual([r[0] for r in results], [200, 200])
            self.assertGreaterEqual(time.monotonic() - started, 2.0, "the two conversions overlapped")
        finally:
            service.close()

    def test_m3_the_line_is_only_so_long(self) -> None:
        service = Service(queue_max=1)
        try:
            results: list[int] = []
            threads = [
                threading.Thread(target=lambda: results.append(service.convert(pdf("sleep=1.5"))[0]), daemon=True)
                for _ in range(4)
            ]
            for t in threads:
                t.start()
                time.sleep(0.25)
            for t in threads:
                t.join(30)
            self.assertIn(503, results)
            self.assertIn(200, results)
            self.assertEqual(service.convert(pdf())[0], 200)
        finally:
            service.close()


class WorkerLife(unittest.TestCase):
    def test_m5_a_conversion_over_its_time_replaces_the_worker(self) -> None:
        service = Service(base_seconds=1, seconds_per_page=1)
        try:
            self.assertEqual(service.health()["workerStarts"], 1)
            status, body = service.convert(pdf("sleep=30", "pages=1"))
            self.assertEqual((status, body["code"]), (504, "timeout"))
            for _ in range(200):
                if service.health()["models"] == "ready":
                    break
                time.sleep(0.05)
            self.assertEqual(service.health()["workerStarts"], 2)
            status, reply = service.convert(pdf("pages=1"))
            self.assertEqual(status, 200, reply)
        finally:
            service.close()

    def test_m5_a_replaced_worker_takes_its_helper_processes_with_it(self) -> None:
        service = Service(base_seconds=1, seconds_per_page=1)
        try:
            marker = f"{service.work.name}/child.pid"
            status, body = service.convert(pdf("child=" + marker, "sleep=30"))
            self.assertEqual((status, body["code"]), (504, "timeout"))
            with open(marker) as fp:
                child = int(fp.read())
            for _ in range(100):
                if not _running(child):
                    break
                time.sleep(0.05)
            else:
                self.fail("the helper process outlived the worker")
        finally:
            service.close()

    def test_m5_the_time_follows_the_page_count(self) -> None:
        service = Service(base_seconds=1, seconds_per_page=2)
        try:
            # 4 pages are given 1 + 8 seconds: a 2-second conversion is fine, where 1 page (3 seconds) is too.
            self.assertEqual(service.convert(pdf("sleep=2", "pages=4"))[0], 200)
            self.assertEqual(service.convert(pdf("sleep=2", "pages=1"))[0], 200)
            self.assertEqual(service.convert(pdf("sleep=5", "pages=1"))[0], 504)
        finally:
            service.close()

    def test_m5_a_crash_is_failed_and_the_next_conversion_is_right(self) -> None:
        service = Service()
        try:
            status, body = service.convert(pdf("crash"))
            self.assertEqual((status, body["code"]), (500, "failed"))
            status, reply = service.convert(pdf("pages=2"))
            self.assertEqual((status, reply["pageCount"]), (200, 2))
            self.assertEqual(service.health()["workerStarts"], 2)
        finally:
            service.close()

    def test_m5_the_worker_is_replaced_every_nth_conversion(self) -> None:
        service = Service(recycle_every=2)
        try:
            for _ in range(5):
                self.assertEqual(service.convert(pdf())[0], 200)
            health = service.health()
            self.assertEqual(health["workerStarts"], 3)
            self.assertLess(health["conversions"], 2)
        finally:
            service.close()

    def test_m4_a_reply_over_the_cap_is_not_sent(self) -> None:
        service = Service(max_reply_bytes=1000)
        try:
            status, body = service.convert(pdf("big=5000"))
            self.assertEqual((status, body["code"]), (500, "failed"))
            self.assertEqual(service.convert(pdf())[0], 200)
        finally:
            service.close()


if __name__ == "__main__":
    unittest.main()

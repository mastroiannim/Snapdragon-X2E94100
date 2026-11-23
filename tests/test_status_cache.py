"""Test per la cache a TTL con refresh in background (hexagon_control/status_cache)."""
import threading
import time
import unittest

from hexagon_control.status_cache import TtlSnapshot


class TtlSnapshotTests(unittest.TestCase):
    def test_snapshot_is_none_until_first_refresh(self):
        cache = TtlSnapshot(lambda: "valore", ttl=1.0)
        self.assertIsNone(cache.snapshot())
        self.assertIsNone(cache.last_error())

    def test_refresh_now_updates_value(self):
        cache = TtlSnapshot(lambda: (True, 12.0, ["model"]), ttl=1.0)
        cache.refresh_now()
        self.assertEqual(cache.snapshot(), (True, 12.0, ["model"]))
        self.assertIsNone(cache.last_error())

    def test_fetch_error_keeps_previous_value(self):
        state = {"fail": False}

        def fetcher():
            if state["fail"]:
                raise RuntimeError("rete assente")
            return "buono"

        cache = TtlSnapshot(fetcher, ttl=1.0)
        cache.refresh_now()
        state["fail"] = True
        cache.refresh_now()
        self.assertEqual(cache.snapshot(), "buono")
        self.assertIsInstance(cache.last_error(), RuntimeError)

    def test_snapshot_never_blocks_while_fetcher_is_slow(self):
        started = threading.Event()

        def slow_fetcher():
            started.set()
            time.sleep(1.0)
            return "nuovo"

        cache = TtlSnapshot(slow_fetcher, ttl=1.0)
        cache.refresh_now()  # primo aggiornamento riuscito
        self.assertEqual(cache.snapshot(), "nuovo")

        worker = threading.Thread(target=cache.refresh_now, daemon=True)
        begin = time.perf_counter()
        worker.start()
        self.assertTrue(started.wait(timeout=2))
        begin = time.perf_counter()  # il fetch e' in corso: snapshot deve essere istantaneo
        self.assertEqual(cache.snapshot(), "nuovo")
        self.assertLess(time.perf_counter() - begin, 0.2)
        worker.join(timeout=2)

    def test_overlapping_refresh_is_ignored(self):
        calls = []
        gate = threading.Event()

        def slow_fetcher():
            calls.append(1)
            gate.wait(timeout=2)
            return "valore"

        cache = TtlSnapshot(slow_fetcher, ttl=1.0)
        first = threading.Thread(target=cache.refresh_now, daemon=True)
        first.start()
        time.sleep(0.1)  # il primo refresh e' dentro il fetcher
        second = threading.Thread(target=cache.refresh_now, daemon=True)
        second.start()
        gate.set()
        first.join(timeout=2)
        second.join(timeout=2)
        self.assertEqual(len(calls), 1, "refresh sovrapposti: il fetcher e' stato eseguito due volte")

    def test_background_poller_updates_periodically(self):
        counter = {"n": 0}

        def fetcher():
            counter["n"] += 1
            return counter["n"]

        cache = TtlSnapshot(fetcher, ttl=0.1)
        cache.start()
        try:
            deadline = time.monotonic() + 3
            while (cache.snapshot() or 0) < 2 and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertGreaterEqual(cache.snapshot(), 2)
        finally:
            cache.stop()
        self.assertFalse(cache.running)

    def test_ttl_must_be_positive(self):
        with self.assertRaises(ValueError):
            TtlSnapshot(lambda: None, ttl=0)


if __name__ == "__main__":
    unittest.main()

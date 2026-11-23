"""Cache con refresh in background per lo stato del runtime.

I callback di layout (toolbar, dashboard) devono leggere solo una cache:
qualsiasi I/O eseguito durante il render congela la UI a ogni redraw. Il
poller aggiorna il valore in un thread dedicato con cadenza TTL; i lettori
usano ``snapshot()`` che non esegue mai I/O e non solleva eccezioni.
"""
import threading
from typing import Callable, Optional


class TtlSnapshot:
    """Valore aggiornato periodicamente da un fetcher eseguito in background.

    - ``snapshot()``: lettura immediata del valore corrente (mai bloccante);
      ``None`` fino al primo aggiornamento riuscito.
    - ``refresh_now()``: aggiornamento immediato, eseguibile anche dal thread
      del poller; i refresh sovrapposti vengono ignorati.
    - Se il fetcher fallisce, il valore precedente viene conservato e
      l'errore resta consultabile con ``last_error()``.
    """

    def __init__(self, fetcher: Callable[[], object], ttl: float = 3.0):
        if ttl <= 0:
            raise ValueError("Il TTL deve essere positivo")
        self._fetcher = fetcher
        self._ttl = float(ttl)
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._value: object = None
        self._error: Optional[Exception] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="hexagon-status-cache",
                                        daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0):
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout)

    def snapshot(self):
        with self._lock:
            return self._value

    def last_error(self) -> Optional[Exception]:
        with self._lock:
            return self._error

    def refresh_now(self):
        if not self._refresh_lock.acquire(blocking=False):
            return
        try:
            value = self._fetcher()
        except Exception as exc:  # la cache mantiene l'ultimo valore buono
            with self._lock:
                self._error = exc
        else:
            with self._lock:
                self._value = value
                self._error = None
        finally:
            self._refresh_lock.release()

    def _run(self):
        while not self._stop.is_set():
            self.refresh_now()
            self._stop.wait(self._ttl)

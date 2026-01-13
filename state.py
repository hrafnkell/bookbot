import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class DownloadProgress:
    filename: str = ""
    received: int = 0
    total: int = 0


@dataclass
class BotState:
    # Status: disconnected, connected, searching, downloading, lines_ready, idle
    status: str = "disconnected"
    search_term: str | None = None
    download_progress: DownloadProgress = field(default_factory=DownloadProgress)
    extracted_lines: list[str] | None = None
    files: list[str] = field(default_factory=list)
    error: str | None = None
    last_activity: float = field(default_factory=time.time)
    idle_timeout: int = 1200  # Default 20 minutes in seconds

    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _listeners: list[Callable[[], None]] = field(default_factory=list, repr=False)

    def add_listener(self, callback: Callable[[], None]) -> None:
        self._listeners.append(callback)

    def remove_listener(self, callback: Callable[[], None]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    def _notify(self) -> None:
        for listener in self._listeners:
            try:
                listener()
            except Exception:
                pass

    async def set_status(self, status: str) -> None:
        async with self._lock:
            self.status = status
            self._notify()

    async def set_search_term(self, term: str | None) -> None:
        async with self._lock:
            self.search_term = term
            self._notify()

    async def set_download_progress(self, filename: str, received: int, total: int) -> None:
        async with self._lock:
            self.download_progress = DownloadProgress(filename, received, total)
            self._notify()

    async def clear_download_progress(self) -> None:
        async with self._lock:
            self.download_progress = DownloadProgress()
            self._notify()

    async def set_extracted_lines(self, lines: list[str] | None) -> None:
        async with self._lock:
            self.extracted_lines = lines
            self._notify()

    async def add_file(self, filepath: str) -> None:
        async with self._lock:
            self.files.append(filepath)
            self._notify()

    async def set_error(self, error: str | None) -> None:
        async with self._lock:
            self.error = error
            self._notify()

    async def clear_error(self) -> None:
        async with self._lock:
            self.error = None
            self._notify()

    def touch_activity(self) -> None:
        self.last_activity = time.time()

    def is_idle(self) -> bool:
        return (time.time() - self.last_activity) > self.idle_timeout

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "search_term": self.search_term,
            "download_progress": {
                "filename": self.download_progress.filename,
                "received": self.download_progress.received,
                "total": self.download_progress.total,
            },
            "extracted_lines": self.extracted_lines,
            "files": self.files,
            "error": self.error,
            "idle_timeout": self.idle_timeout,
        }


def list_downloaded_files(files_dir: Path) -> list[str]:
    if not files_dir.exists():
        return []
    return sorted([f.name for f in files_dir.iterdir() if f.is_file()])

import asyncio
import http.server
import queue
import shlex
import socket
import struct
import threading
import urllib.parse
import zipfile
from pathlib import Path

from airc.client import DefaultClient
from airc.enums import EventType
from airc.events import Event
from airc.server import (
    DefaultServer,
    _handle_args,
    _handle_command,
    _handle_prefix,
    _handle_tags,
    _regexp_rfc,
)
from airc.utils import LineBuffer


class BotState:
    def __init__(self, server_host: str, server_port: int, nickname: str, channel: str) -> None:
        self.server_host = server_host
        self.server_port = server_port
        self.nickname = nickname
        self.channel = channel
        self.connected = False
        self.connecting = False
        self.last_error = ""
        self.queue: queue.SimpleQueue[tuple[str, str | None]] = queue.SimpleQueue()
        self.temp_dir = Path("temp")
        self.results_dir = Path("results")
        self.verbose = True
        self._pump_task: asyncio.Task | None = None


class StatusHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path != "/":
            self.send_error(404)
            return
        state: BotState = self.server.state
        status = "connected" if state.connected else "connecting" if state.connecting else "disconnected"
        body = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>IRC Bot Status</title>
    <style>
      body {{ font-family: sans-serif; margin: 2rem; }}
      .status {{ font-weight: bold; }}
      form {{ margin: 0.75rem 0; }}
    </style>
  </head>
  <body>
    <h1>IRC Bot Status</h1>
    <p>Status: <span class="status">{status}</span></p>
    <p>Server: {state.server_host}:{state.server_port}</p>
    <p>Nick: {state.nickname}</p>
    <p>Channel: {state.channel}</p>
    <p>Last error: {state.last_error or "-"}</p>
    <form method="post" action="/connect">
      <button type="submit">Connect</button>
    </form>
    <form method="post" action="/disconnect">
      <button type="submit">Disconnect</button>
    </form>
    <form method="post" action="/send">
      <input type="text" name="message" placeholder="Message" size="50">
      <button type="submit">Send to #ebooks</button>
    </form>
  </body>
</html>
"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body.encode("utf-8"))))
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        params = urllib.parse.parse_qs(body)
        state: BotState = self.server.state

        if self.path == "/connect":
            state.queue.put(("connect", None))
        elif self.path == "/disconnect":
            state.queue.put(("disconnect", None))
        elif self.path == "/send":
            message = params.get("message", [""])[0].strip()
            if message:
                state.queue.put(("send", message))
        else:
            self.send_error(404)
            return

        self.send_response(303)
        self.send_header("Location", "/")
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        return


def start_status_server(state: BotState, host: str = "0.0.0.0", port: int = 8080) -> None:
    server = http.server.ThreadingHTTPServer((host, port), StatusHandler)
    server.state = state
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()


def safe_extract(zip_path: Path, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        target_root = target_dir.resolve()
        for member in archive.infolist():
            member_path = (target_dir / member.filename).resolve()
            if not member_path.is_relative_to(target_root):
                raise ValueError(f"Blocked zip path: {member.filename}")
        archive.extractall(target_dir)


def decode_dcc_address(raw: str) -> str:
    if raw.isdigit():
        return socket.inet_ntoa(struct.pack("!I", int(raw)))
    return raw


def parse_dcc_send(message: str) -> tuple[str, str, int, int | None] | None:
    if not (message.startswith("\x01") and message.endswith("\x01")):
        return None
    payload = message[1:-1]
    if not payload.startswith("DCC SEND "):
        return None
    parts = shlex.split(payload)
    if len(parts) < 5:
        return None
    filename = parts[2]
    address = parts[3]
    port = int(parts[4])
    size = int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else None
    return filename, address, port, size


def handle_dcc_receive(
    state: BotState,
    filename: str,
    address: str,
    port: int,
    size: int | None,
    log,
) -> None:
    log(f"Starting DCC receive: {filename} from {address}:{port}")
    temp_dir = state.temp_dir
    results_dir = state.results_dir
    temp_dir.mkdir(parents=True, exist_ok=True)
    results_dir.mkdir(parents=True, exist_ok=True)
    dest = temp_dir / filename
    received = 0
    try:
        with socket.create_connection((address, port), timeout=30) as sock, dest.open("wb") as handle:
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                handle.write(chunk)
                received += len(chunk)
                try:
                    sock.sendall(struct.pack("!I", received))
                except OSError:
                    pass
                if size is not None and received >= size:
                    break
    except OSError as exc:
        state.last_error = f"DCC receive failed: {exc}"
        log(state.last_error)
        return
    if size is not None and received < size:
        state.last_error = "DCC receive incomplete."
        log(state.last_error)
        return
    if zipfile.is_zipfile(dest):
        try:
            safe_extract(dest, results_dir)
        except (ValueError, zipfile.BadZipFile) as exc:
            state.last_error = f"Unzip failed: {exc}"
            log(state.last_error)
            return
        log(f"Unzipped {filename} into {results_dir}.")
    else:
        log(f"Received non-zip file: {dest}")


class LenientLineBuffer(LineBuffer):
    def lines(self):
        lines = self._line_sep.split(self.data)
        self.data = lines.pop()
        for line in lines:
            try:
                yield line.decode("utf-8", "strict")
            except UnicodeDecodeError:
                yield line.decode("latin-1")


class TcpServer(DefaultServer):
    __slots__ = ("reader", "writer")

    def __init__(self, uri, master=None, *, loop=None):
        super().__init__(uri, master, loop=loop)
        self.reader = None
        self.writer = None
        self.buffer = LenientLineBuffer()

    async def connect(self, username, password=""):
        self.username = username
        self.password = password
        host, port = self._uri
        self.reader, self.writer = await asyncio.open_connection(host, port)
        self.connected = True

        if self.password:
            await self.pass_(self.password)
        await self.nick(self.username)
        await self.user(self.username, self.username)

    async def disconnect(self):
        if self.writer is not None:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except (ConnectionResetError, OSError):
                pass
        self.reader = None
        self.writer = None
        self.connected = False

    async def process_data(self):
        if self.reader is None:
            await self.disconnect()
            raise ConnectionError("No connection reader.")
        data = await self.reader.read(4096)
        if not data:
            await self.disconnect()
            raise ConnectionError("Connection closed by server.")
        if chr(data[-1]) != "\n":
            data += b"\n"

        self.buffer.feed(data)

        for line in self.buffer:
            if not line:
                continue
            await self._process_line(line)

        return self

    async def send_raw(self, data):
        if self.writer is None:
            raise ConnectionError("Not connected.")
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not data.endswith(b"\r\n"):
            data += b"\r\n"
        self.writer.write(data)
        await self.writer.drain()

    async def _process_line(self, line):
        event = Event(self, EventType.CLIENT, "all_raw_events", [None, line])
        await self._handle_event(event)

        match = _regexp_rfc.match(line)
        if not match:
            return

        type, command = _handle_command(match.group("command"))
        command = command.lower()

        args = _handle_args(match.group("argument") or "")
        tags = _handle_tags(match.group("tags"))
        prefix = _handle_prefix(match.group("prefix"))

        event = Event(self, type, command, args, prefix, tags)
        await self._handle_event(event)


class BotClient(DefaultClient):
    def __init__(self, state: BotState, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__([(state.server_host, state.server_port)], server_type=TcpServer, loop=loop)
        self.state = state
        self.server = self.connections[0]

    def log(self, message: str) -> None:
        if self.state.verbose:
            print(message)

    async def on_welcome(self, event) -> None:
        self.state.connected = True
        self.state.connecting = False
        self.log("Connected; joining channel.")
        await event.server.join(self.state.channel)

    async def on_privmsg(self, event) -> None:
        if not event.arguments:
            return
        message = event.arguments[0]
        if not self.state.verbose:
            print(f"<{event.prefix.nick}> {message}")
        if message.startswith("\x01") and self.state.verbose:
            self.log(f"CTCP received from {event.prefix.nick}: {message!r}")
        dcc = parse_dcc_send(message)
        if not dcc:
            return
        filename, address, port, size = dcc
        filename = Path(filename).name
        if not (filename.startswith("SearchBot") and filename.endswith(".zip")):
            self.log(f"Ignoring DCC send for {filename}.")
            return
        self.log(f"Accepting DCC send for {filename}.")
        thread = threading.Thread(
            target=handle_dcc_receive,
            args=(
                self.state,
                filename,
                decode_dcc_address(address),
                port,
                size,
                self.log,
            ),
            daemon=True,
        )
        thread.start()

    async def on_notice(self, event) -> None:
        if not event.arguments:
            return
        message = event.arguments[0]
        if message.startswith("\x01") and self.state.verbose:
            self.log(f"CTCP NOTICE from {event.prefix.nick}: {message!r}")
        dcc = parse_dcc_send(message)
        if not dcc:
            return
        filename, address, port, size = dcc
        filename = Path(filename).name
        if not (filename.startswith("SearchBot") and filename.endswith(".zip")):
            self.log(f"Ignoring DCC send for {filename}.")
            return
        self.log(f"Accepting DCC send for {filename}.")
        thread = threading.Thread(
            target=handle_dcc_receive,
            args=(
                self.state,
                filename,
                decode_dcc_address(address),
                port,
                size,
                self.log,
            ),
            daemon=True,
        )
        thread.start()


async def run_bot(state: BotState) -> None:
    loop = asyncio.get_running_loop()
    client = BotClient(state, loop)

    def log(message: str) -> None:
        if state.verbose:
            print(message)

    async def pump() -> None:
        while state.connected or state.connecting:
            try:
                await client.server.process_data()
            except Exception as exc:
                state.connected = False
                state.connecting = False
                state.last_error = f"Disconnected: {exc}"
                log(state.last_error)
                break

    async def connect() -> None:
        if state.connected or state.connecting:
            return
        state.connecting = True
        log(f"Connecting to {state.server_host}:{state.server_port} as {state.nickname}.")
        try:
            await client.server.connect(state.nickname)
        except Exception as exc:
            state.last_error = f"Connection failed: {exc}"
            state.connecting = False
            log(state.last_error)
            return
        state.last_error = ""
        if state._pump_task is None or state._pump_task.done():
            state._pump_task = asyncio.create_task(pump())

    async def disconnect() -> None:
        if not client.server.connected:
            return
        log("Disconnect requested.")
        await client.server.disconnect()
        state.connected = False
        state.connecting = False

    async def send_message(message: str) -> None:
        if not client.server.connected:
            state.last_error = "Cannot send message while disconnected."
            log(state.last_error)
            return
        log(f"Sending message to {state.channel}: {message}")
        await client.server.privmsg(state.channel, message)

    async def handle_actions() -> None:
        while True:
            try:
                action, payload = state.queue.get_nowait()
            except queue.Empty:
                break
            log(f"Handling action: {action}")
            if action == "connect":
                await connect()
            elif action == "disconnect":
                await disconnect()
            elif action == "send" and payload is not None:
                await send_message(payload)

    while True:
        await handle_actions()
        await asyncio.sleep(0.2)


def main() -> None:
    server_host = "irc.irchighway.net"
    server_port = 6667
    nickname = "JohnBoblem"
    channel = "#ebooks"

    state = BotState(server_host, server_port, nickname, channel)
    start_status_server(state)
    asyncio.run(run_bot(state))


if __name__ == "__main__":
    main()

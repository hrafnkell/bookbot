import asyncio
import os
import shlex
import zipfile
from pathlib import Path
import irc3

from state import BotState
from config import IrcConfig, IRC_HOST, IRC_PORT, IRC_TLS, CHANNEL


TEMP_DIR = Path("temp")
RESULTS_DIR = Path("results")
FILES_DIR = Path("files")

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100MB


def setup_dirs() -> None:
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(parents=True, exist_ok=True)


def parse_dcc_send(message: str) -> tuple[str, str, int, int] | None:
    if not (message.startswith("\x01") and message.endswith("\x01")):
        return None
    payload = message[1:-1]
    if not payload.upper().startswith("DCC SEND "):
        return None
    try:
        parts = shlex.split(payload)
    except ValueError:
        return None
    if len(parts) < 5:
        return None
    filename = parts[2]
    address = parts[3]
    port = int(parts[4])
    size = int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else 0
    return filename, address, port, size


def int_to_ip(ip_int: int) -> str:
    return ".".join(str((ip_int >> (8 * i)) & 0xFF) for i in reversed(range(4)))


def safe_extract(zip_path: Path, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        target_root = target_dir.resolve()
        for member in archive.infolist():
            member_path = (target_dir / member.filename).resolve()
            if not member_path.is_relative_to(target_root):
                raise ValueError(f"Blocked zip path: {member.filename}")
        archive.extractall(target_dir)


def first_text_file(root: Path) -> Path | None:
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() == ".txt":
            return path
    return None


def unique_extract_dir(base: Path) -> Path:
    if not base.exists():
        return base
    for i in range(1, 1000):
        candidate = Path(f"{base}_{i}")
        if not candidate.exists():
            return candidate
    raise RuntimeError("Could not allocate extract directory")


async def dcc_receive(
    ip: str,
    port: int,
    size: int,
    out_path: Path,
    state: BotState | None = None,
) -> None:
    if size > MAX_FILE_SIZE:
        raise ValueError(f"File too large: {size} bytes (max {MAX_FILE_SIZE})")

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(ip, port), timeout=30
    )

    received = 0
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        with out_path.open("wb") as f:
            while True:
                if size > 0:
                    remaining = size - received
                    if remaining <= 0:
                        break
                    chunk = await reader.read(min(65536, remaining))
                else:
                    chunk = await reader.read(65536)

                if not chunk:
                    break

                f.write(chunk)
                received += len(chunk)

                if received > MAX_FILE_SIZE:
                    raise ValueError(f"File exceeded max size: {MAX_FILE_SIZE}")

                if state:
                    await state.set_download_progress(out_path.name, received, size)

                ack_value = received & 0xFFFFFFFF
                writer.write(ack_value.to_bytes(4, byteorder="big"))
                await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


@irc3.plugin
class DccReceiverPlugin:
    def __init__(self, bot):
        self.bot = bot
        self.done = asyncio.Event()
        self.last_saved_path: Path | None = None
        self.save_dir = TEMP_DIR
        self.state: BotState | None = bot.config.get("bot_state")

    def _resolve_out_path(self, filename: str) -> Path | None:
        safe_name = os.path.basename(filename.strip('"'))
        out_path = (self.save_dir / safe_name).resolve()
        save_root = self.save_dir.resolve()
        if not out_path.is_relative_to(save_root):
            self.bot.log.warning("Blocked suspicious filename: %r", filename)
            return None
        return out_path

    async def _handle_dcc(self, data: str | None) -> None:
        if not data:
            return

        parsed = parse_dcc_send(data)
        if not parsed:
            return
        filename, address, port, size = parsed
        ip = int_to_ip(int(address)) if address.isdigit() else address

        out_path = self._resolve_out_path(filename)
        if out_path is None:
            return

        self.bot.log.info(
            "Incoming DCC SEND: %s from %s:%d (%d bytes)",
            out_path.name,
            ip,
            port,
            size,
        )

        if self.state:
            await self.state.set_status("downloading")
            await self.state.set_download_progress(out_path.name, 0, size)

        try:
            await dcc_receive(ip, port, size, out_path, self.state)
            self.bot.log.info("Saved DCC file to %s", out_path)
            self.last_saved_path = out_path

            await self._process_downloaded_file(out_path)

        except Exception as e:
            self.bot.log.exception("DCC receive failed: %s", e)
            if self.state:
                await self.state.set_error(str(e))
                await self.state.set_status("connected")
        finally:
            if self.state:
                await self.state.clear_download_progress()
            self.done.set()

    async def _process_downloaded_file(self, file_path: Path) -> None:
        is_txt_zip = file_path.name.lower().endswith(".txt.zip")

        if is_txt_zip and zipfile.is_zipfile(file_path):
            extract_dir = unique_extract_dir(RESULTS_DIR / file_path.stem)
            safe_extract(file_path, extract_dir)
            self.bot.log.info("Unzipped %s to %s", file_path.name, extract_dir)

            txt_path = first_text_file(extract_dir)
            if txt_path:
                text = txt_path.read_text(encoding="utf-8", errors="replace")
                lines = text.splitlines()
                if self.state:
                    await self.state.set_extracted_lines(lines)
                    await self.state.set_status("lines_ready")
            else:
                if self.state:
                    await self.state.set_status("connected")
        else:
            dest = FILES_DIR / file_path.name
            if file_path != dest:
                file_path.replace(dest)
            if self.state:
                await self.state.add_file(dest.name)
                await self.state.set_status("connected")

    @irc3.event(irc3.rfc.PRIVMSG)
    async def on_privmsg(self, mask=None, event=None, target=None, data=None, **kw):
        await self._handle_dcc(data)

    @irc3.event(r"^:(?P<mask>\S+) NOTICE (?P<target>\S+) :(?P<data>.+)")
    async def on_notice(self, mask=None, target=None, data=None, **kw):
        await self._handle_dcc(data)


@irc3.plugin
class JoinMessengerPlugin:
    def __init__(self, bot):
        self.bot = bot
        self.channel = bot.config.get("join_channel")
        self.state: BotState | None = bot.config.get("bot_state")

    @irc3.event(irc3.rfc.CONNECTED)
    async def on_connected(self, **kw):
        self.bot.log.info("Connected.")
        if self.state:
            await self.state.set_status("connected")

    @irc3.event(r":(?P<mask>\S+) 001 (?P<nick>\S+) :(?P<data>.+)")
    def on_welcome(self, **kw):
        self.bot.log.info("Welcome received.")

    @irc3.event(irc3.rfc.JOIN)
    def on_join(self, mask=None, channel=None, **kw):
        if not mask or mask.nick != self.bot.nick or not channel:
            return
        self.bot.log.info("Joined %s", channel.lstrip(":"))

    @irc3.event(irc3.rfc.RPL_ENDOFNAMES)
    def on_endofnames(self, channel=None, **kw):
        pass


class IrcBotWrapper:
    def __init__(self, state: BotState):
        self.state = state
        self.bot: irc3.IrcBot | None = None
        self.channel = CHANNEL
        self.irc_config: IrcConfig | None = None
        self._connected = False

    def create_bot(self, irc_config: IrcConfig) -> irc3.IrcBot:
        setup_dirs()
        self.irc_config = irc_config

        config = dict(
            nick=irc_config.nick,
            username=irc_config.username,
            realname=irc_config.realname,
            host=IRC_HOST,
            port=IRC_PORT,
            ssl=IRC_TLS,
            timeout=600,
            includes=[__name__],
            autojoins=[self.channel],
            join_channel=self.channel,
            bot_state=self.state,
        )

        self.bot = irc3.IrcBot(**config)
        return self.bot

    def connect(self, irc_config: IrcConfig) -> None:
        if self._connected:
            return
        self.create_bot(irc_config)
        self.bot.run(forever=False)
        self._connected = True

    def disconnect(self, reason: str = "goodbye") -> None:
        if self.bot and self._connected:
            self.bot.quit(reason)
            self._connected = False
            self.bot = None

    def is_connected(self) -> bool:
        # Check both our flag and the actual bot connection state
        if not self._connected or not self.bot:
            return False
        # Check if the bot's protocol is connected
        # irc3 bots have a 'protocol' attribute that has a 'transport' when connected
        try:
            return (
                hasattr(self.bot, 'protocol') and 
                self.bot.protocol is not None and
                hasattr(self.bot.protocol, 'transport') and
                self.bot.protocol.transport is not None and
                not self.bot.protocol.transport.is_closing()
            )
        except (AttributeError, RuntimeError):
            # If we can't check the protocol state, fall back to our flag
            return self._connected

    def send_message(self, message: str) -> None:
        if self.bot and self._connected:
            self.bot.privmsg(self.channel, message)

    def get_dcc_plugin(self) -> DccReceiverPlugin | None:
        if self.bot:
            return self.bot.get_plugin(DccReceiverPlugin)
        return None

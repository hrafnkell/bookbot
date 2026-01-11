import argparse
import asyncio
import os
import re
import shlex
import zipfile
from pathlib import Path
import irc3


TEMP_DIR = Path("temp")
TEMP_DIR.mkdir(parents=True, exist_ok=True)
RESULTS_DIR = Path("results")
RESULTS_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR = Path("files")
FILES_DIR.mkdir(parents=True, exist_ok=True)

# --- DCC parsing helpers ---
# Typical CTCP DCC SEND:
#   \x01DCC SEND <filename> <ip_as_int> <port> <size>\x01
def parse_dcc_send(message: str) -> tuple[str, str, int, int] | None:
    # Parse a CTCP DCC SEND message into filename/address/port/size.
    if not (message.startswith("\x01") and message.endswith("\x01")):
        return None
    payload = message[1:-1]
    if not payload.upper().startswith("DCC SEND "):
        return None
    parts = shlex.split(payload)
    if len(parts) < 5:
        return None
    filename = parts[2]
    address = parts[3]
    port = int(parts[4])
    size = int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else 0
    return filename, address, port, size

def int_to_ip(ip_int: int) -> str:
    # Convert 32-bit int to dotted quad.
    return ".".join(str((ip_int >> (8 * i)) & 0xFF) for i in reversed(range(4)))


def safe_extract(zip_path: Path, target_dir: Path) -> None:
    # Extract a zip while blocking path traversal entries.
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        target_root = target_dir.resolve()
        for member in archive.infolist():
            member_path = (target_dir / member.filename).resolve()
            if target_root not in member_path.parents and member_path != target_root:
                raise ValueError(f"Blocked zip path: {member.filename}")
        archive.extractall(target_dir)


def first_text_file(root: Path) -> Path | None:
    # Find the first .txt file under a directory tree.
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() == ".txt":
            return path
    return None


def unique_extract_dir(base: Path) -> Path:
    # Pick a non-existent directory name by suffixing a counter.
    if not base.exists():
        return base
    for i in range(1, 1000):
        candidate = Path(f"{base}_{i}")
        if not candidate.exists():
            return candidate
    raise RuntimeError("Could not allocate extract directory")


async def dcc_receive(ip: str, port: int, size: int, out_path: Path) -> None:
    # Receive a DCC SEND file over TCP and write to disk.
    """
    Minimal DCC SEND receiver:
    - Connects to sender's TCP listener
    - Reads exactly `size` bytes (or until EOF if size is 0/unknown)
    - Writes to file
    Note: Many DCC implementations also send ACKs back; some senders require them.
    This receiver includes simple ACKs based on bytes received.
    """
    reader, writer = await asyncio.open_connection(ip, port)

    received = 0
    out_path.parent.mkdir(parents=True, exist_ok=True)

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

            # DCC ACK: 32-bit unsigned int of total bytes received (big-endian)
            # Some senders require ACKs to continue sending.
            writer.write(received.to_bytes(4, byteorder="big", signed=False))
            await writer.drain()

    writer.close()
    await writer.wait_closed()


@irc3.plugin
class DccReceiverPlugin:
    """
    Generic plugin that watches for CTCP DCC SEND and downloads the file to temp/.
    """

    def __init__(self, bot):
        # Track bot state and the last saved DCC path.
        self.bot = bot
        self.done = asyncio.Event()
        self.last_saved_path: Path | None = None
        self.save_dir = TEMP_DIR

    def _resolve_out_path(self, filename: str) -> Path | None:
        # Ensure the target filename is safe within save_dir.
        safe_name = os.path.basename(filename.strip('"'))
        out_path = (self.save_dir / safe_name).resolve()
        save_root = self.save_dir.resolve()
        if save_root not in out_path.parents and out_path != save_root:
            self.bot.log.warning("Blocked suspicious filename: %r", filename)
            return None
        return out_path

    async def _handle_dcc(self, data: str | None) -> None:
        # Parse and handle a DCC SEND payload from PRIVMSG/NOTICE.
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

        try:
            await dcc_receive(ip, port, size, out_path)
            self.bot.log.info("Saved DCC file to %s", out_path)
            self.last_saved_path = out_path
        except Exception as e:
            self.bot.log.exception("DCC receive failed: %s", e)
        finally:
            self.done.set()

    @irc3.event(irc3.rfc.PRIVMSG)
    async def on_privmsg(self, mask=None, event=None, target=None, data=None, **kw):
        # Listen for CTCP DCC SEND in PRIVMSG.
        await self._handle_dcc(data)

    @irc3.event(r"^:(?P<mask>\S+) NOTICE (?P<target>\S+) :(?P<data>.+)")
    async def on_notice(self, mask=None, target=None, data=None, **kw):
        # Listen for CTCP DCC SEND in NOTICE.
        await self._handle_dcc(data)


@irc3.plugin
class JoinMessengerPlugin:
    def __init__(self, bot):
        # Configure the join channel and message to send once.
        self.bot = bot
        self.sent_message = False
        self.channel = bot.config.get("join_channel")
        self.message = bot.config.get("join_message")

    def maybe_send(self, channel):
        # Send the join message once when entering the configured channel.
        if self.sent_message or not self.channel or channel != self.channel:
            return
        self.sent_message = True
        self.bot.log.info("Joined %s; sending message.", self.channel)
        self.bot.privmsg(self.channel, self.message)
        self.bot.get_plugin(DccReceiverPlugin)

    @irc3.event(irc3.rfc.CONNECTED)
    def on_connected(self, **kw):
        # Log basic connect lifecycle event.
        self.bot.log.info("Connected.")

    @irc3.event(r":(?P<mask>\S+) 001 (?P<nick>\S+) :(?P<data>.+)")
    def on_welcome(self, **kw):
        # Log welcome to confirm server registration completed.
        self.bot.log.info("Welcome received; waiting for join then message.")

    @irc3.event(irc3.rfc.JOIN)
    def on_join(self, mask=None, channel=None, **kw):
        # Trigger the join message when we see our own join.
        if not mask or mask.nick != self.bot.nick or not channel:
            return
        self.maybe_send(channel.lstrip(":"))

    @irc3.event(irc3.rfc.RPL_ENDOFNAMES)
    def on_endofnames(self, channel=None, **kw):
        # Fallback trigger once NAMES list is complete.
        if channel:
            self.maybe_send(channel.lstrip(":"))


def parse_line_selection(raw: str, max_lines: int) -> list[int] | None:
    # Parse comma-separated 1-based line numbers within bounds.
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        return None
    indices = []
    for part in parts:
        if not part.isdigit():
            return None
        idx = int(part)
        if idx < 1 or idx > max_lines:
            return None
        indices.append(idx)
    return indices


async def prompt_line_selection(lines: list[str]) -> list[str] | None:
    # Prompt for line numbers and return selected line contents.
    prompt = "Line numbers to send (comma-separated): "
    try:
        raw = await asyncio.to_thread(input, prompt)
    except EOFError:
        return None
    raw = raw.strip()
    indices = parse_line_selection(raw, len(lines))
    if not indices:
        return None
    return [lines[i - 1] for i in indices]


async def main(message: str, send_delay: float):
    # Connect to IRC, request the file, and optionally send selected lines.
    IRC_HOST = "irc.irchighway.net"
    IRC_PORT = 6669
    IRC_TLS = False

    NICK = "BigBobby"
    USERNAME = "bobby"
    REALNAME = "Big Bob Energy"

    CHANNEL = "#ebooks"
    MESSAGE = message

    # Optional server password (NOT NickServ). If you need NickServ identify, do it after connect.
    SERVER_PASSWORD = None  # e.g. "serverpass"

    config = dict(
        nick=NICK,
        username=USERNAME,
        realname=REALNAME,
        host=IRC_HOST,
        port=IRC_PORT,
        ssl=IRC_TLS,
        #password=SERVER_PASSWORD,
        timeout=600,
        includes=[
            __name__,  # this module
        ],
        autojoins=[CHANNEL],
        join_channel=CHANNEL,
        join_message=MESSAGE,
    )

    bot = irc3.IrcBot(**config)
    plugin = None

    bot.run(forever=False)

    # Wait for DCC or timeout
    # (plugin is created by irc3 on includes load; give it a moment)
    await asyncio.sleep(0.5)
    plugin = plugin or bot.get_plugin(DccReceiverPlugin)

    try:
        await asyncio.wait_for(plugin.done.wait(), timeout=300)
    except asyncio.TimeoutError:
        bot.log.warning("Timed out waiting for DCC.")
    else:
        if plugin.last_saved_path:
            print(f"Saved: {plugin.last_saved_path}")
            is_txt_zip = plugin.last_saved_path.name.lower().endswith(".txt.zip")
            if is_txt_zip and zipfile.is_zipfile(plugin.last_saved_path):
                extract_dir = unique_extract_dir(RESULTS_DIR / plugin.last_saved_path.stem)
                safe_extract(plugin.last_saved_path, extract_dir)
                bot.log.info("Unzipped %s to %s", plugin.last_saved_path.name, extract_dir)
                txt_path = first_text_file(extract_dir)
                if txt_path:
                    text = txt_path.read_text(encoding="utf-8", errors="replace")
                    lines = text.splitlines()
                    for i, line in enumerate(lines, start=1):
                        print(f"{i:4d} {line}")
                    selected = await prompt_line_selection(lines)
                    if selected is not None:
                        plugin.save_dir = FILES_DIR
                        for line in selected:
                            plugin.last_saved_path = None
                            plugin.done.clear()
                            print(f"Sending: {line}")
                            bot.privmsg(CHANNEL, line)
                            try:
                                await asyncio.wait_for(plugin.done.wait(), timeout=300)
                            except asyncio.TimeoutError:
                                bot.log.warning("Timed out waiting for DCC.")
                                break
                            else:
                                if plugin.last_saved_path:
                                    print(f"Saved: {plugin.last_saved_path}")
                            if send_delay > 0:
                                await asyncio.sleep(send_delay)
                        bot.quit("done")
                        await asyncio.sleep(1)
                        return
            else:
                dest = FILES_DIR / plugin.last_saved_path.name
                if plugin.last_saved_path != dest:
                    plugin.last_saved_path.replace(dest)
                print(f"Saved: {dest}")
        else:
            print("No file received.")
    finally:
        bot.quit("done")
        await asyncio.sleep(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("message", help="Message to send after join")
    parser.add_argument("--send-delay", type=float, default=15.0, help="Delay between line sends in seconds")
    args = parser.parse_args()
    asyncio.run(main(args.message, args.send_delay))

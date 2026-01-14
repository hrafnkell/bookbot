import json
from pathlib import Path
from dataclasses import dataclass, asdict


CONFIG_FILE = Path("irc_config.json")

DEFAULT_IRC_SERVER = "irc.irchighway.net"
DEFAULT_IRC_PORT = 6669
DEFAULT_IRC_CHANNEL = "#ebooks"
IRC_TLS = False


@dataclass
class IrcConfig:
    nick: str
    username: str
    realname: str
    server: str = DEFAULT_IRC_SERVER
    port: int = DEFAULT_IRC_PORT
    channel: str = DEFAULT_IRC_CHANNEL
    idle_timeout: int = 20
    search_timeout: int = 60
    auto_connect: bool = True

    def save(self) -> None:
        CONFIG_FILE.write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls) -> "IrcConfig | None":
        if not CONFIG_FILE.exists():
            return None
        try:
            data = json.loads(CONFIG_FILE.read_text())
            return cls(
                nick=data["nick"],
                username=data["username"],
                realname=data["realname"],
                server=data.get("server", DEFAULT_IRC_SERVER),
                port=data.get("port", DEFAULT_IRC_PORT),
                channel=data.get("channel", DEFAULT_IRC_CHANNEL),
                idle_timeout=data.get("idle_timeout", 20),
                search_timeout=data.get("search_timeout", 60),
                auto_connect=data.get("auto_connect", True),
            )
        except (json.JSONDecodeError, KeyError):
            return None

    @classmethod
    def exists(cls) -> bool:
        return CONFIG_FILE.exists() and cls.load() is not None

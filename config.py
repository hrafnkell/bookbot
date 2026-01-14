import json
from pathlib import Path
from dataclasses import dataclass, asdict


CONFIG_FILE = Path("irc_config.json")

# Fixed IRC server settings (not user-configurable)
IRC_HOST = "irc.irchighway.net"
IRC_PORT = 6669
IRC_TLS = False
CHANNEL = "#ebooks"


@dataclass
class IrcConfig:
    nick: str
    username: str
    realname: str
    idle_timeout: int = 20
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
                idle_timeout=data.get("idle_timeout", 20),
                auto_connect=data.get("auto_connect", True),
            )
        except (json.JSONDecodeError, KeyError):
            return None

    @classmethod
    def exists(cls) -> bool:
        return CONFIG_FILE.exists() and cls.load() is not None

import json
from pathlib import Path
from aiohttp import web
import aiohttp_jinja2
import jinja2

from state import BotState, list_downloaded_files
from config import IrcConfig
from database import search_results, get_all_results, get_stats


FILES_DIR = Path("files")
RESULTS_DIR = Path("results")
STATIC_DIR = Path(__file__).parent / "static"


def create_app(state: BotState, irc_wrapper, send_delay: float = 15.0) -> web.Application:
    app = web.Application()
    app["state"] = state
    app["irc_wrapper"] = irc_wrapper
    app["send_delay"] = send_delay

    templates_dir = Path(__file__).parent / "templates"
    aiohttp_jinja2.setup(app, loader=jinja2.FileSystemLoader(str(templates_dir)))

    app.router.add_get("/", index)
    app.router.add_post("/search", search)
    app.router.add_get("/status", status)
    app.router.add_get("/lines", get_lines)
    app.router.add_post("/select", select_lines)
    app.router.add_get("/files", get_files)
    app.router.add_get("/files/download/{filename}", download_file)
    app.router.add_get("/db/search", db_search)
    app.router.add_get("/db/stats", db_stats)
    app.router.add_post("/db/select", db_select_lines)
    app.router.add_get("/config", get_config)
    app.router.add_post("/config", save_config)
    app.router.add_post("/connect", connect)
    app.router.add_post("/disconnect", disconnect)
    app.router.add_static("/static", STATIC_DIR)

    return app


@aiohttp_jinja2.template("index.html")
async def index(request: web.Request) -> dict:
    state: BotState = request.app["state"]
    files = list_downloaded_files(FILES_DIR)
    return {
        "status": state.status,
        "search_term": state.search_term,
        "files": files,
    }


async def ensure_connected(irc_wrapper, state: BotState) -> str | None:
    """Ensure IRC is connected, auto-reconnect if needed. Returns error message or None."""
    if irc_wrapper.is_connected():
        return None

    config = IrcConfig.load()
    if config is None:
        return "Configuration not found. Please configure first."

    try:
        irc_wrapper.connect(config)
        await state.set_status("connected")
        return None
    except Exception as e:
        return f"Failed to reconnect: {e}"


async def search(request: web.Request) -> web.Response:
    state: BotState = request.app["state"]
    irc_wrapper = request.app["irc_wrapper"]

    data = await request.post()
    term = data.get("term", "").strip()

    if not term:
        return web.json_response({"error": "Search term is required"}, status=400)

    if state.status == "downloading":
        return web.json_response({"error": "Download in progress"}, status=409)

    # Auto-reconnect if needed
    error = await ensure_connected(irc_wrapper, state)
    if error:
        return web.json_response({"error": error}, status=400)

    state.touch_activity()
    await state.clear_error()
    await state.set_extracted_lines(None)
    await state.set_search_term(term)
    await state.set_status("searching")

    message = f"@search {term}"
    irc_wrapper.send_message(message)

    return web.json_response({"success": True, "message": message})


async def status(request: web.Request) -> web.Response:
    state: BotState = request.app["state"]
    irc_wrapper = request.app["irc_wrapper"]
    state_dict = state.to_dict()
    state_dict["files"] = list_downloaded_files(FILES_DIR)
    state_dict["config_exists"] = IrcConfig.exists()
    state_dict["is_connected"] = irc_wrapper.is_connected()
    return web.json_response(state_dict)


async def get_lines(request: web.Request) -> web.Response:
    state: BotState = request.app["state"]
    lines = state.extracted_lines
    if lines is None:
        return web.json_response({"lines": None})
    return web.json_response({"lines": lines})


async def select_lines(request: web.Request) -> web.Response:
    state: BotState = request.app["state"]
    irc_wrapper = request.app["irc_wrapper"]
    send_delay = request.app["send_delay"]

    if state.status != "lines_ready":
        return web.json_response({"error": "No lines available for selection"}, status=400)

    # Check if connected (no auto-reconnect for line selection)
    if not irc_wrapper.is_connected():
        return web.json_response({"error": "Not connected to IRC. Please connect first."}, status=400)

    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    indices = data.get("indices", [])
    if not indices:
        return web.json_response({"error": "No lines selected"}, status=400)

    lines = state.extracted_lines
    if lines is None:
        return web.json_response({"error": "No lines available"}, status=400)

    selected = []
    for idx in indices:
        if isinstance(idx, int) and 1 <= idx <= len(lines):
            selected.append(lines[idx - 1])

    if not selected:
        return web.json_response({"error": "Invalid line indices"}, status=400)

    state.touch_activity()
    await state.set_extracted_lines(None)
    await state.set_status("connected")

    import asyncio
    for i, line in enumerate(selected):
        if i > 0:
            await asyncio.sleep(send_delay)
        irc_wrapper.send_message(line)

    return web.json_response({"success": True, "count": len(selected)})


async def get_files(request: web.Request) -> web.Response:
    files = list_downloaded_files(FILES_DIR)
    return web.json_response({"files": files})


async def download_file(request: web.Request) -> web.Response:
    """Download a file from the files directory."""
    filename = request.match_info.get("filename", "")
    if not filename:
        return web.json_response({"error": "Filename required"}, status=400)

    target = _safe_path(FILES_DIR, filename)
    if target is None or not target.exists() or not target.is_file():
        return web.json_response({"error": "File not found"}, status=404)

    return web.FileResponse(
        target,
        headers={
            "Content-Disposition": f'attachment; filename="{target.name}"'
        }
    )


def _safe_path(base: Path, relative: str) -> Path | None:
    """Resolve a path safely within a base directory."""
    try:
        target = (base / relative).resolve()
        if not target.is_relative_to(base.resolve()):
            return None
        return target
    except (ValueError, OSError):
        return None


async def db_search(request: web.Request) -> web.Response:
    """Search the results database."""
    query = request.query.get("q", "").strip()
    try:
        limit = int(request.query.get("limit", "50"))
        offset = int(request.query.get("offset", "0"))
    except ValueError:
        return web.json_response({"error": "Invalid limit or offset"}, status=400)

    limit = min(max(limit, 1), 200)  # Clamp between 1 and 200
    offset = max(offset, 0)

    if query:
        results, total = search_results(query, limit, offset)
    else:
        results, total = get_all_results(limit, offset)

    return web.json_response({
        "results": results,
        "total": total,
        "limit": limit,
        "offset": offset,
        "query": query,
    })


async def db_stats(request: web.Request) -> web.Response:
    """Get database statistics."""
    stats = get_stats()
    return web.json_response(stats)


async def db_select_lines(request: web.Request) -> web.Response:
    """Select lines from database search results and send to IRC."""
    irc_wrapper = request.app["irc_wrapper"]
    send_delay = request.app["send_delay"]
    state: BotState = request.app["state"]

    if state.status == "downloading":
        return web.json_response({"error": "Download in progress"}, status=409)

    if not irc_wrapper.is_connected():
        return web.json_response({"error": "Not connected to IRC. Please connect first."}, status=400)

    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    lines = data.get("lines", [])
    if not lines:
        return web.json_response({"error": "No lines selected"}, status=400)

    # Validate that all lines are strings
    if not all(isinstance(line, str) for line in lines):
        return web.json_response({"error": "Invalid line data"}, status=400)

    state.touch_activity()

    import asyncio
    for i, line in enumerate(lines):
        if i > 0:
            await asyncio.sleep(send_delay)
        irc_wrapper.send_message(line)

    return web.json_response({"success": True, "count": len(lines)})


async def get_config(request: web.Request) -> web.Response:
    """Get current IRC configuration."""
    config = IrcConfig.load()
    if config is None:
        return web.json_response({"exists": False})
    return web.json_response({
        "exists": True,
        "nick": config.nick,
        "username": config.username,
        "realname": config.realname,
        "idle_timeout": config.idle_timeout,
        "auto_connect": config.auto_connect,
    })


async def save_config(request: web.Request) -> web.Response:
    """Save IRC configuration."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    nick = data.get("nick", "").strip()
    username = data.get("username", "").strip()
    realname = data.get("realname", "").strip()
    auto_connect = bool(data.get("auto_connect", True))
    try:
        idle_timeout = int(data.get("idle_timeout", 20))
        if idle_timeout < 1:
            raise ValueError
    except (ValueError, TypeError):
        return web.json_response({"error": "Idle timeout must be a positive integer"}, status=400)

    if not nick or not username or not realname:
        return web.json_response({"error": "All fields are required"}, status=400)

    config = IrcConfig(nick=nick, username=username, realname=realname, idle_timeout=idle_timeout, auto_connect=auto_connect)
    config.save()

    # Update runtime state
    request.app["state"].idle_timeout = idle_timeout * 60

    return web.json_response({"success": True})


async def connect(request: web.Request) -> web.Response:
    """Connect to IRC server."""
    irc_wrapper = request.app["irc_wrapper"]
    state: BotState = request.app["state"]

    if irc_wrapper.is_connected():
        return web.json_response({"error": "Already connected"}, status=400)

    config = IrcConfig.load()
    if config is None:
        return web.json_response({"error": "Configuration not found"}, status=400)

    try:
        irc_wrapper.connect(config)
        await state.set_status("connected")
        return web.json_response({"success": True})
    except Exception as e:
        await state.set_error(str(e))
        return web.json_response({"error": str(e)}, status=500)


async def disconnect(request: web.Request) -> web.Response:
    """Disconnect from IRC server."""
    irc_wrapper = request.app["irc_wrapper"]
    state: BotState = request.app["state"]

    if not irc_wrapper.is_connected():
        return web.json_response({"error": "Not connected"}, status=400)

    irc_wrapper.disconnect("User requested disconnect")
    await state.set_status("disconnected")

    return web.json_response({"success": True})

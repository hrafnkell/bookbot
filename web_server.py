import json
from pathlib import Path
from aiohttp import web
import aiohttp_jinja2
import jinja2

from state import BotState, list_downloaded_files


FILES_DIR = Path("files")
RESULTS_DIR = Path("results")


def create_app(state: BotState, send_message_callback, send_delay: float = 15.0) -> web.Application:
    app = web.Application()
    app["state"] = state
    app["send_message"] = send_message_callback
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
    app.router.add_get("/results", list_results)
    app.router.add_get("/results/read", read_result_file)
    app.router.add_post("/results/select", select_result_lines)

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


async def search(request: web.Request) -> web.Response:
    state: BotState = request.app["state"]
    send_message = request.app["send_message"]

    data = await request.post()
    term = data.get("term", "").strip()

    if not term:
        return web.json_response({"error": "Search term is required"}, status=400)

    if state.status == "downloading":
        return web.json_response({"error": "Download in progress"}, status=409)

    await state.clear_error()
    await state.set_extracted_lines(None)
    await state.set_search_term(term)
    await state.set_status("searching")

    message = f"@search {term}"
    send_message(message)

    return web.json_response({"success": True, "message": message})


async def status(request: web.Request) -> web.Response:
    state: BotState = request.app["state"]
    state_dict = state.to_dict()
    state_dict["files"] = list_downloaded_files(FILES_DIR)
    return web.json_response(state_dict)


async def get_lines(request: web.Request) -> web.Response:
    state: BotState = request.app["state"]
    lines = state.extracted_lines
    if lines is None:
        return web.json_response({"lines": None})
    return web.json_response({"lines": lines})


async def select_lines(request: web.Request) -> web.Response:
    state: BotState = request.app["state"]
    send_message = request.app["send_message"]
    send_delay = request.app["send_delay"]

    if state.status != "lines_ready":
        return web.json_response({"error": "No lines available for selection"}, status=400)

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

    await state.set_extracted_lines(None)
    await state.set_status("connected")

    for i, line in enumerate(selected):
        if i > 0:
            import asyncio
            await asyncio.sleep(send_delay)
        send_message(line)

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


def _list_directory(path: Path) -> list[dict]:
    """List directory contents with type info."""
    if not path.exists() or not path.is_dir():
        return []
    items = []
    for item in sorted(path.iterdir()):
        items.append({
            "name": item.name,
            "type": "dir" if item.is_dir() else "file",
            "is_txt": item.suffix.lower() == ".txt" if item.is_file() else False,
        })
    return items


async def list_results(request: web.Request) -> web.Response:
    """List contents of the results directory or a subdirectory."""
    subpath = request.query.get("path", "")

    if subpath:
        target = _safe_path(RESULTS_DIR, subpath)
        if target is None:
            return web.json_response({"error": "Invalid path"}, status=400)
    else:
        target = RESULTS_DIR

    if not target.exists():
        return web.json_response({"error": "Path not found"}, status=404)

    if target.is_file():
        return web.json_response({"error": "Path is a file, not a directory"}, status=400)

    items = _list_directory(target)
    return web.json_response({
        "path": subpath,
        "items": items,
    })


async def read_result_file(request: web.Request) -> web.Response:
    """Read a txt file from results and return its lines."""
    filepath = request.query.get("path", "")
    if not filepath:
        return web.json_response({"error": "Path is required"}, status=400)

    target = _safe_path(RESULTS_DIR, filepath)
    if target is None:
        return web.json_response({"error": "Invalid path"}, status=400)

    if not target.exists():
        return web.json_response({"error": "File not found"}, status=404)

    if not target.is_file():
        return web.json_response({"error": "Path is not a file"}, status=400)

    if target.suffix.lower() != ".txt":
        return web.json_response({"error": "Only .txt files can be read"}, status=400)

    try:
        text = target.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
    except Exception as e:
        return web.json_response({"error": f"Failed to read file: {e}"}, status=500)

    return web.json_response({
        "path": filepath,
        "lines": lines,
    })


async def select_result_lines(request: web.Request) -> web.Response:
    """Select lines from a results file and send to IRC."""
    send_message = request.app["send_message"]
    send_delay = request.app["send_delay"]
    state: BotState = request.app["state"]

    if state.status == "downloading":
        return web.json_response({"error": "Download in progress"}, status=409)

    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    filepath = data.get("path", "")
    indices = data.get("indices", [])

    if not filepath:
        return web.json_response({"error": "Path is required"}, status=400)

    if not indices:
        return web.json_response({"error": "No lines selected"}, status=400)

    target = _safe_path(RESULTS_DIR, filepath)
    if target is None or not target.exists() or not target.is_file():
        return web.json_response({"error": "Invalid file path"}, status=400)

    try:
        text = target.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
    except Exception as e:
        return web.json_response({"error": f"Failed to read file: {e}"}, status=500)

    selected = []
    for idx in indices:
        if isinstance(idx, int) and 1 <= idx <= len(lines):
            selected.append(lines[idx - 1])

    if not selected:
        return web.json_response({"error": "Invalid line indices"}, status=400)

    import asyncio
    for i, line in enumerate(selected):
        if i > 0:
            await asyncio.sleep(send_delay)
        send_message(line)

    return web.json_response({"success": True, "count": len(selected)})

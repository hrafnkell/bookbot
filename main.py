import asyncio
import logging
import signal
from aiohttp import web

from state import BotState
from bot import IrcBotWrapper
from config import IrcConfig
from web_server import create_app
from database import init_database


# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
# Reduce noise from aiohttp
logging.getLogger("aiohttp").setLevel(logging.WARNING)

WEB_PORT = 8044
SEND_DELAY = 15.0
CHECK_INTERVAL = 5  # Check every 5 seconds for timeouts


async def idle_checker(state: BotState, irc_wrapper: IrcBotWrapper, stop_event: asyncio.Event):
    """Periodically check for idle timeout and search timeout."""
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=CHECK_INTERVAL)
            break  # Stop event was set
        except asyncio.TimeoutError:
            pass  # Continue checking

        # Check for search timeout
        if state.is_search_timed_out():
            print(f"Search timed out after {state.search_timeout} seconds")
            await state.set_error(f"Search timed out after {state.search_timeout} seconds - no results received")
            await state.set_status("connected")

        # Check for idle timeout
        if irc_wrapper.is_connected() and state.is_idle():
            print(f"Idle for {state.idle_timeout // 60} minutes. Disconnecting from IRC...")
            irc_wrapper.disconnect("Idle timeout")
            await state.set_status("disconnected")


async def main():
    # Initialize database
    init_database()

    state = BotState()
    irc_wrapper = IrcBotWrapper(state)

    # Auto-connect if config exists and auto_connect is enabled
    config = IrcConfig.load()
    if config:
        state.idle_timeout = config.idle_timeout * 60
        state.search_timeout = config.search_timeout
        if config.auto_connect:
            print("Configuration found. Connecting to IRC...")
            irc_wrapper.connect(config)
            await asyncio.sleep(0.5)
            print("IRC bot connected.")
            state.touch_activity()
        else:
            print("Configuration found. Auto-connect disabled. Use web interface to connect.")
    else:
        print("No configuration found. Please configure via web interface.")

    stop_event = asyncio.Event()

    app = create_app(state, irc_wrapper, SEND_DELAY, stop_event)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()

    print(f"Web server running at http://localhost:{WEB_PORT}")

    def handle_signal():
        print("\nShutting down...")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_signal)

    # Start idle checker task
    idle_task = asyncio.create_task(idle_checker(state, irc_wrapper, stop_event))

    try:
        await stop_event.wait()
    finally:
        idle_task.cancel()
        try:
            await idle_task
        except asyncio.CancelledError:
            pass
        if irc_wrapper.is_connected():
            irc_wrapper.disconnect("shutdown")
        await runner.cleanup()
        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(main())

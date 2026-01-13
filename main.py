import asyncio
import signal
from aiohttp import web

from state import BotState
from bot import IrcBotWrapper
from config import IrcConfig
from web_server import create_app


WEB_PORT = 8044
SEND_DELAY = 15.0
IDLE_CHECK_INTERVAL = 60  # Check every minute


async def idle_checker(state: BotState, irc_wrapper: IrcBotWrapper, stop_event: asyncio.Event):
    """Periodically check for idle timeout and disconnect if needed."""
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=IDLE_CHECK_INTERVAL)
            break  # Stop event was set
        except asyncio.TimeoutError:
            pass  # Continue checking

        if irc_wrapper.is_connected() and state.is_idle():
            print(f"Idle for {state.idle_timeout // 60} minutes. Disconnecting from IRC...")
            irc_wrapper.disconnect("Idle timeout")
            await state.set_status("disconnected")


async def main():
    state = BotState()
    irc_wrapper = IrcBotWrapper(state)

    # Auto-connect if config exists
    config = IrcConfig.load()
    if config:
        print("Configuration found. Connecting to IRC...")
        state.idle_timeout = config.idle_timeout * 60
        irc_wrapper.connect(config)
        await asyncio.sleep(0.5)
        print("IRC bot connected.")
        state.touch_activity()
    else:
        print("No configuration found. Please configure via web interface.")

    app = create_app(state, irc_wrapper, SEND_DELAY)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()

    print(f"Web server running at http://localhost:{WEB_PORT}")

    stop_event = asyncio.Event()

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

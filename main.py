import asyncio
import signal
from aiohttp import web

from state import BotState
from bot import IrcBotWrapper
from web_server import create_app


WEB_PORT = 8044
SEND_DELAY = 15.0


async def main():
    state = BotState()
    irc_wrapper = IrcBotWrapper(state)

    irc_wrapper.start()
    await asyncio.sleep(0.5)

    app = create_app(state, irc_wrapper.send_message, SEND_DELAY)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()

    print(f"Web server running at http://localhost:{WEB_PORT}")
    print("IRC bot connected. Waiting for commands...")

    stop_event = asyncio.Event()

    def handle_signal():
        print("\nShutting down...")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_signal)

    try:
        await stop_event.wait()
    finally:
        irc_wrapper.quit("shutdown")
        await runner.cleanup()
        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(main())

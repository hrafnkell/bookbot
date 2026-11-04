import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { BotState } from "./state.ts";
import { IrcBotWrapper } from "./irc.ts";
import { loadConfig } from "./config.ts";
import { initDatabase } from "./database.ts";
import { createServer } from "./server.ts";
import { log } from "./log.ts";

const WEB_PORT = Number(process.env.PORT ?? 8044);
const SEND_DELAY = 15; // seconds between queued IRC messages
const CHECK_INTERVAL_MS = 5_000;

// All runtime data (irc_config.json, results.db, files/, results/, temp/) lives in the
// working directory, or in $IRCBOOK_DATA when set, so the compiled binary can live anywhere.
if (process.env.IRCBOOK_DATA) {
  mkdirSync(process.env.IRCBOOK_DATA, { recursive: true });
  process.chdir(process.env.IRCBOOK_DATA);
}

initDatabase();

const state = new BotState();
const irc = new IrcBotWrapper(state);

const config = loadConfig();
if (config) {
  state.idleTimeout = config.idle_timeout * 60;
  state.searchTimeout = config.search_timeout;
  if (config.auto_connect) {
    log.info("Configuration found. Connecting to IRC...");
    void irc.connect(config);
  } else {
    log.info("Configuration found. Auto-connect disabled. Use web interface to connect.");
  }
} else {
  log.info("No configuration found. Please configure via web interface.");
}

let stopping = false;
function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log.info(`Shutting down (${reason})...`);
  clearInterval(checker);
  if (irc.isConnected()) irc.disconnect("shutdown");
  server.stop(true);
  setTimeout(() => process.exit(0), 500);
}

const server = createServer({ state, irc, sendDelay: SEND_DELAY, port: WEB_PORT, onShutdown: () => shutdown("web request") });
const appUrl = `http://localhost:${server.port}`;
log.info(`Web server running at ${appUrl}`);

// The Windows binary is usually started by double-clicking it, so open the UI for the user.
// Running from source (`bun start`) or setting IRCBOOK_NO_BROWSER skips this.
const isCompiledBinary = !/^bun(\.exe)?$/i.test(basename(process.execPath));
if (process.platform === "win32" && isCompiledBinary && !process.env.IRCBOOK_NO_BROWSER) {
  log.info("Opening the web UI in your browser. Close this window to stop the app.");
  try {
    Bun.spawn(["cmd", "/c", "start", "", appUrl], { stdout: "ignore", stderr: "ignore" });
  } catch (err) {
    log.warn("Could not open the browser:", (err as Error).message);
  }
}

const checker = setInterval(() => {
  if (state.isSearchTimedOut()) {
    log.info(`Search timed out after ${state.searchTimeout} seconds`);
    state.setError(`Search timed out after ${state.searchTimeout} seconds - no results received`);
    state.setStatus("connected");
  }
  if (irc.isConnected() && state.isIdle()) {
    log.info(`Idle for ${Math.round(state.idleTimeout / 60)} minutes. Disconnecting from IRC...`);
    irc.disconnect("Idle timeout");
    state.setStatus("disconnected");
  }
}, CHECK_INTERVAL_MS);

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

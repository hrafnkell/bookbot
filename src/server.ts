import { existsSync, unlinkSync, statSync } from "node:fs";
import { basename } from "node:path";
import { assets } from "./assets.js";
import { BotState, listDownloadedFiles } from "./state.ts";
import { IrcBotWrapper, extractNickFromLine } from "./irc.ts";
import { CONFIG_DEFAULTS, configExists, loadConfig, randomIdentity, saveConfig, type IrcConfig } from "./config.ts";
import { clearDatabase, getAllResults, getStats, searchResults } from "./database.ts";
import { safePath } from "./dcc.ts";
import { getLogEntries, log } from "./log.ts";

export interface ServerDeps {
  state: BotState;
  irc: IrcBotWrapper;
  /** Seconds between queued IRC messages. */
  sendDelay: number;
  onShutdown: () => void;
  port: number;
  hostname?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const error = (message: string, status = 400) => json({ error: message }, status);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function filesDir(): string {
  return loadConfig()?.download_path ?? CONFIG_DEFAULTS.download_path;
}

/** Ensure IRC is connected, auto-connecting if needed. Returns an error message or null. */
export async function ensureConnected(irc: IrcBotWrapper, state: BotState, waitForJoin = false): Promise<string | null> {
  if (!irc.isConnected()) {
    const config = loadConfig();
    if (!config) return "Configuration not found. Please configure first.";
    try {
      await irc.connect(config);
      state.idleTimeout = config.idle_timeout * 60;
      state.searchTimeout = config.search_timeout;
      state.touchActivity();
    } catch (err) {
      return `Failed to reconnect: ${(err as Error).message}`;
    }
  }
  if (waitForJoin) return waitForChannel(irc);
  return null;
}

async function waitForChannel(irc: IrcBotWrapper, timeoutMs = 30_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (irc.isJoined()) return null;
    if (irc.lastError) return irc.lastError;
    await sleep(250);
  }
  return "Timed out waiting to join channel";
}

/** Send download commands with a delay between each so the channel bots are not flooded. */
async function sendLines(irc: IrcBotWrapper, lines: string[], delaySeconds: number): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await sleep(delaySeconds * 1000);
    if (irc.sendMessage(lines[i]!)) log.info("Sent download request:", lines[i]);
    else log.warn("Not connected, dropped IRC message:", lines[i]);
  }
}

function missingNicks(irc: IrcBotWrapper, lines: string[]): string[] {
  const missing = new Set<string>();
  for (const line of lines) {
    const nick = extractNickFromLine(line);
    if (nick && !irc.isNickInChannel(nick)) missing.add(nick);
  }
  return [...missing];
}

/**
 * Who is in the channel right now, per nick. Values are null when we are not in
 * the channel, since then we can't tell.
 */
function nickPresence(irc: IrcBotWrapper, nicks: Iterable<string>): { joined: boolean; present: Record<string, boolean | null> } {
  const joined = irc.isJoined();
  const present: Record<string, boolean | null> = {};
  for (const nick of nicks) present[nick] = joined ? irc.isNickInChannel(nick) : null;
  return { joined, present };
}

async function readJson(req: Request): Promise<any | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function positiveInt(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function createServer(deps: ServerDeps) {
  const { state, irc, sendDelay } = deps;
  const suggestedIdentity = randomIdentity();

  const resolveFile = (raw: string): string | null => {
    const name = basename(raw);
    const target = safePath(filesDir(), name);
    if (!target || !existsSync(target) || !statSync(target).isFile()) return null;
    return target;
  };

  const serveAsset = (key: keyof typeof assets) => {
    const asset = assets[key];
    // no-cache: the UI shares URLs with the earlier Python version of this app, and a
    // stale cached app.js would call endpoints that no longer exist.
    return new Response(Bun.file(asset.path), { headers: { "Content-Type": asset.type, "Cache-Control": "no-cache" } });
  };
  const page = () => serveAsset("/");

  const search = async (req: Request): Promise<Response> => {
    const form = await req.formData().catch(() => null);
    const term = String(form?.get("term") ?? "").trim();
    if (!term) return error("Search term is required");
    if (state.status === "downloading") return error("Download in progress", 409);

    // Wait until we are actually in the channel: a message sent before
    // registration completes is silently dropped by the server.
    const err = await ensureConnected(irc, state, true);
    if (err) return error(err);

    state.touchActivity();
    state.clearError();
    state.setExtractedLines(null);
    state.setSearchTerm(term);

    const message = `@search ${term}`;
    if (!irc.sendMessage(message)) {
      state.setStatus("connected");
      return error("IRC connection not ready, please retry", 503);
    }
    state.setStatus("searching");
    log.info("Sent search:", message);
    return json({ success: true, message });
  };

  const server = Bun.serve({
    port: deps.port,
    hostname: deps.hostname ?? "0.0.0.0",
    routes: {
      // The single-page UI is served on every tab path so deep links and reloads work.
      "/": { GET: page },
      // POST /search is kept for clients still running the previous UI build.
      "/search": { GET: page, POST: search },
      "/downloads": { GET: page },
      "/saved": { GET: page },
      "/config": { GET: page },
      "/log": { GET: page },
      "/static/app.js": { GET: () => serveAsset("/static/app.js") },
      "/static/styles.css": { GET: () => serveAsset("/static/styles.css") },
      "/static/favicon.svg": { GET: () => serveAsset("/static/favicon.svg") },

      "/status": {
        GET: () =>
          json({
            ...state.toJSON(),
            files: listDownloadedFiles(filesDir()),
            config_exists: configExists(),
            is_connected: irc.isConnected(),
          }),
      },

      "/api/search": { POST: search },

      // Activity log for the UI. Pass ?after=<id> to fetch only entries newer than one already seen.
      "/api/log": {
        GET: (req) => {
          const after = Number(new URL(req.url).searchParams.get("after") ?? "0");
          const entries = getLogEntries(Number.isFinite(after) && after > 0 ? after : 0);
          return json({ entries, last_id: entries.at(-1)?.id ?? (after > 0 ? after : 0) });
        },
      },

      "/lines": { GET: () => json({ lines: state.extractedLines }) },

      "/select": {
        POST: async (req) => {
          if (state.status !== "lines_ready") return error("No lines available for selection");
          if (!irc.isConnected()) return error("Not connected to IRC. Please connect first.");

          const data = await readJson(req);
          if (!data) return error("Invalid JSON");
          const indices: unknown[] = Array.isArray(data.indices) ? data.indices : [];
          if (indices.length === 0) return error("No lines selected");

          const lines = state.extractedLines;
          if (!lines) return error("No lines available");

          const selected = indices
            .filter((i): i is number => typeof i === "number" && Number.isInteger(i) && i >= 1 && i <= lines.length)
            .map((i) => lines[i - 1]!);
          if (selected.length === 0) return error("Invalid line indices");

          const missing = missingNicks(irc, selected);
          if (missing.length) return error(`Nick(s) not in channel: ${missing.join(", ")}`);

          state.touchActivity();
          state.setExtractedLines(null);
          state.setStatus("connected");
          log.info(`Queued ${selected.length} download request(s) from search results`);
          void sendLines(irc, selected, sendDelay);
          return json({ success: true, count: selected.length });
        },
      },

      "/files": { GET: () => json({ files: listDownloadedFiles(filesDir()) }) },

      "/files/download/:filename": {
        GET: (req) => {
          const target = resolveFile(decodeParam(req.params.filename));
          if (!target) return error("File not found", 404);
          const name = basename(target);
          const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
          return new Response(Bun.file(target), {
            headers: {
              "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            },
          });
        },
      },

      "/files/delete/:filename": {
        DELETE: (req) => {
          const target = resolveFile(decodeParam(req.params.filename));
          if (!target) return error("File not found", 404);
          try {
            unlinkSync(target);
            log.info("Deleted file:", target);
            return json({ success: true, filename: basename(target) });
          } catch (err) {
            return error(`Failed to delete: ${(err as Error).message}`, 500);
          }
        },
      },

      "/db/search": {
        GET: (req) => {
          const url = new URL(req.url);
          const query = (url.searchParams.get("q") ?? "").trim();
          const limitRaw = Number(url.searchParams.get("limit") ?? "50");
          const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
          if (!Number.isInteger(limitRaw) || !Number.isInteger(offsetRaw)) return error("Invalid limit or offset");
          const limit = Math.min(Math.max(limitRaw, 1), 200);
          const offset = Math.max(offsetRaw, 0);
          const { results, total } = query ? searchResults(query, limit, offset) : getAllResults(limit, offset);
          const joined = irc.isJoined();
          const withNicks = results.map((r) => {
            const nick = extractNickFromLine(r.line);
            return { ...r, nick, in_channel: nick && joined ? irc.isNickInChannel(nick) : null };
          });
          return json({ results: withNicks, total, limit, offset, query, joined });
        },
      },

      "/db/stats": { GET: () => json(getStats()) },

      // Refresh nick colours in the UI without re-running the search. Body: { nicks: string[] }.
      "/api/presence": {
        POST: async (req) => {
          const data = await readJson(req);
          const nicks: unknown[] = Array.isArray(data?.nicks) ? data.nicks : [];
          if (!nicks.every((n): n is string => typeof n === "string")) return error("Invalid nick list");
          return json(nickPresence(irc, nicks.slice(0, 500)));
        },
      },

      "/db/select": {
        POST: async (req) => {
          if (state.status === "downloading") return error("Download in progress", 409);
          const err = await ensureConnected(irc, state, true);
          if (err) return error(err);

          const data = await readJson(req);
          if (!data) return error("Invalid JSON");
          const lines: unknown[] = Array.isArray(data.lines) ? data.lines : [];
          if (lines.length === 0) return error("No lines selected");
          if (!lines.every((l): l is string => typeof l === "string")) return error("Invalid line data");

          const missing = missingNicks(irc, lines);
          if (missing.length) return error(`Nick(s) not in channel: ${missing.join(", ")}`);

          state.touchActivity();
          log.info(`Queued ${lines.length} download request(s) from saved results`);
          void sendLines(irc, lines, sendDelay);
          return json({ success: true, count: lines.length });
        },
      },

      "/db/clear": {
        POST: () => {
          const deleted = clearDatabase();
          log.info(`Cleared ${deleted} saved results from the database`);
          return json({ success: true, deleted });
        },
      },

      "/api/config": {
        GET: () => {
          const config = loadConfig();
          // Before the first save, offer a random nick/username (the same one for the whole run).
          return json(config ? { exists: true, ...config } : { exists: false, suggested: suggestedIdentity, ...CONFIG_DEFAULTS });
        },
        POST: async (req) => {
          const data = await readJson(req);
          if (!data) return error("Invalid JSON");

          const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback).trim();
          const nick = str(data.nick);
          const username = str(data.username);
          const realname = str(data.realname);
          const server = str(data.server, CONFIG_DEFAULTS.server);
          const channel = str(data.channel, CONFIG_DEFAULTS.channel);
          const download_path = str(data.download_path, CONFIG_DEFAULTS.download_path) || CONFIG_DEFAULTS.download_path;
          const auto_connect = data.auto_connect === undefined ? true : Boolean(data.auto_connect);

          const idle_timeout = positiveInt(data.idle_timeout, CONFIG_DEFAULTS.idle_timeout);
          if (idle_timeout === null) return error("Idle timeout must be a positive integer");
          const search_timeout = positiveInt(data.search_timeout, CONFIG_DEFAULTS.search_timeout);
          if (search_timeout === null) return error("Search timeout must be a positive integer");
          const port = positiveInt(data.port, CONFIG_DEFAULTS.port);
          if (port === null || port > 65535) return error("Port must be between 1 and 65535");
          const max_file_size_mb = positiveInt(data.max_file_size_mb, CONFIG_DEFAULTS.max_file_size_mb);
          if (max_file_size_mb === null) return error("Max file size must be a positive integer");

          if (!nick || !username || !realname || !server || !channel) return error("All fields are required");

          const config: IrcConfig = {
            nick, username, realname, server, port, channel,
            idle_timeout, search_timeout, download_path, auto_connect, max_file_size_mb,
          };
          saveConfig(config);
          state.idleTimeout = idle_timeout * 60;
          state.searchTimeout = search_timeout;
          log.info("Configuration saved");
          return json({ success: true });
        },
      },

      "/connect": {
        POST: async () => {
          if (irc.isConnected()) return error("Already connected");
          const config = loadConfig();
          if (!config) return error("Configuration not found");
          log.info("Connect requested from web UI");
          try {
            await irc.connect(config);
            state.idleTimeout = config.idle_timeout * 60;
            state.searchTimeout = config.search_timeout;
            state.touchActivity();
            return json({ success: true });
          } catch (err) {
            state.setError((err as Error).message);
            return error((err as Error).message, 500);
          }
        },
      },

      "/disconnect": {
        POST: () => {
          if (!irc.isConnected()) return error("Not connected");
          log.info("Disconnect requested from web UI");
          irc.disconnect("User requested disconnect");
          state.setStatus("disconnected");
          return json({ success: true });
        },
      },

      "/shutdown": {
        POST: () => {
          log.info("Shutdown requested from web UI");
          setTimeout(deps.onShutdown, 50);
          return json({ success: true });
        },
      },
    },
    fetch: () => error("Not found", 404),
    error(err) {
      log.error("Unhandled request error:", err);
      return error("Internal server error", 500);
    },
  });

  return server;
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

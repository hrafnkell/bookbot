import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import IRC from "irc-framework";
import type { Client } from "irc-framework";
import { BotState } from "./state.ts";
import { IRC_TLS, loadConfig, CONFIG_DEFAULTS, type IrcConfig } from "./config.ts";
import { addResults } from "./database.ts";
import {
  dccAddressToHost,
  dccReceive,
  firstTextFile,
  moveFile,
  parseDccSend,
  safeExtract,
  safePath,
  sanitizeFilename,
  uniqueExtractDir,
} from "./dcc.ts";
import { log } from "./log.ts";

export const TEMP_DIR = "temp";
export const RESULTS_DIR = "results";

export function setupDirs(downloadPath: string = CONFIG_DEFAULTS.download_path): void {
  for (const dir of [TEMP_DIR, RESULTS_DIR, downloadPath]) mkdirSync(dir, { recursive: true });
}

/** Extract the nickname from a download command line such as "!nickname book.epub". */
export function extractNickFromLine(line: string): string | null {
  if (!line.startsWith("!")) return null;
  const first = line.split(/\s+/, 1)[0] ?? "";
  return first.length > 1 ? first.slice(1) : null;
}

/**
 * Choose the local address to bind, which is how irc-framework lets us pick the
 * address family. Bun's net.connect() takes the first DNS answer (often IPv6) and
 * does not fall back to IPv4 the way asyncio or Node's happy-eyeballs do, so on a
 * host without IPv6 connectivity the connection dies immediately. Prefer IPv4,
 * which is what the DCC ecosystem uses anyway.
 */
export function pickOutgoingAddr(addresses: { family: number }[]): string | undefined {
  if (addresses.some((a) => a.family === 4)) return "0.0.0.0";
  if (addresses.some((a) => a.family === 6)) return "::";
  return undefined;
}

async function resolveOutgoingAddr(host: string): Promise<string | undefined> {
  const literal = isIP(host);
  if (literal) return pickOutgoingAddr([{ family: literal }]);
  try {
    return pickOutgoingAddr(await lookup(host, { all: true }));
  } catch (err) {
    log.warn(`DNS lookup for ${host} failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** Remove mIRC colour/bold/underline control codes from a message. */
export function stripFormatting(text: string): string {
  return text.replace(/\x03\d{0,2}(?:,\d{1,2})?|[\x02\x1d\x1e\x1f\x11\x16\x0f]/g, "").trim();
}

/** Does a search bot notice mean the search finished without results? */
export function isNoResultsNotice(text: string): boolean {
  return /no matches|no results|returned nothing|not found|0 results/i.test(text);
}

function currentMaxFileSize(fallback: number): number {
  const config = loadConfig();
  return config ? config.max_file_size_mb * 1024 * 1024 : fallback;
}

/**
 * Owns the irc-framework client and everything that touches IRC: connection
 * lifecycle, channel membership tracking and incoming DCC SEND transfers.
 *
 * Auto-reconnect is deliberately disabled. A library-driven reconnect after
 * our own QUIT produces an orphaned second session squatting on the nick.
 */
export class IrcBotWrapper {
  private client: Client | null = null;
  private connecting = false;
  private registered = false;
  private channelUsers = new Set<string>();
  private activeTransfers = new Set<string>();
  private maxFileSize = CONFIG_DEFAULTS.max_file_size_mb * 1024 * 1024;

  channel: string = CONFIG_DEFAULTS.channel;
  nick = "";
  /** Last fatal connection problem (for surfacing to the UI while waiting to join). */
  lastError: string | null = null;

  constructor(private readonly state: BotState) {}

  /** Start connecting. Resolves once the connection attempt is under way, not when registered. */
  async connect(config: IrcConfig): Promise<void> {
    if (this.client || this.connecting) return;
    this.connecting = true;
    try {
      setupDirs(config.download_path);
      this.channel = config.channel;
      this.nick = config.nick;
      this.maxFileSize = config.max_file_size_mb * 1024 * 1024;
      this.registered = false;
      this.lastError = null;
      this.channelUsers.clear();

      const outgoingAddr = await resolveOutgoingAddr(config.server);

      const client = new IRC.Client();
      this.client = client;
      this.bindEvents(client);
      client.connect({
        host: config.server,
        port: config.port,
        nick: config.nick,
        username: config.username,
        gecos: config.realname,
        tls: IRC_TLS,
        encoding: "utf8",
        auto_reconnect: false,
        version: null,
        ping_interval: 60,
        ping_timeout: 600,
        outgoing_addr: outgoingAddr,
      });
      log.info(`Connecting to ${config.server}:${config.port} as ${config.nick}${outgoingAddr === "0.0.0.0" ? " (IPv4)" : ""}...`);
    } finally {
      this.connecting = false;
    }
  }

  disconnect(reason = "goodbye"): void {
    const client = this.client;
    if (!client) return;
    this.client = null;
    this.registered = false;
    this.channelUsers.clear();
    try {
      client.quit(reason);
    } catch (err) {
      log.debug("quit failed:", err);
    }
    client.removeAllListeners();
    log.info(`Disconnected (${reason})`);
  }

  isConnected(): boolean {
    return this.client !== null && this.registered && this.client.connected;
  }

  /** True once the server has sent the channel's NAMES list, i.e. we are really in the channel. */
  isJoined(): boolean {
    return this.isConnected() && this.channelUsers.size > 0;
  }

  /** Send a channel message. Returns false when not connected (the caller decides how to report it). */
  sendMessage(message: string): boolean {
    if (!this.isConnected()) return false;
    this.client!.say(this.channel, message);
    return true;
  }

  isNickInChannel(nick: string): boolean {
    return this.channelUsers.has(nick.toLowerCase());
  }

  private sameChannel(name: string | undefined): boolean {
    return !!name && name.toLowerCase() === this.channel.toLowerCase();
  }

  private bindEvents(client: Client): void {
    // Guard: events from a client we've already discarded must not touch state.
    const live = () => this.client === client;

    client.on("registered", (e: { nick: string }) => {
      if (!live()) return;
      this.nick = e.nick;
      this.registered = true;
      log.info(`Registered as ${e.nick}. Joining ${this.channel}`);
      client.join(this.channel);
      this.state.setStatus("connected");
    });

    client.on("nick in use", (e: { nick: string }) => {
      if (!live() || this.registered) return;
      const next = `${e.nick}_`;
      log.warn(`Nick ${e.nick} in use, trying ${next}`);
      client.changeNick(next);
    });

    client.on("userlist", (e: { channel: string; users: { nick: string }[] }) => {
      if (!live() || !this.sameChannel(e.channel)) return;
      this.channelUsers = new Set(e.users.map((u) => u.nick.toLowerCase()));
      log.info(`Channel ${e.channel} has ${this.channelUsers.size} users`);
    });

    client.on("join", (e: { nick: string; channel: string }) => {
      if (!live() || !this.sameChannel(e.channel)) return;
      if (e.nick === this.nick) log.info(`Joined ${e.channel}`);
      else this.channelUsers.add(e.nick.toLowerCase());
    });

    client.on("part", (e: { nick: string; channel: string }) => {
      if (live() && this.sameChannel(e.channel)) this.channelUsers.delete(e.nick.toLowerCase());
    });
    client.on("kick", (e: { kicked: string; channel: string }) => {
      if (live() && this.sameChannel(e.channel)) this.channelUsers.delete(e.kicked.toLowerCase());
    });
    client.on("quit", (e: { nick: string }) => {
      if (live()) this.channelUsers.delete(e.nick.toLowerCase());
    });
    client.on("nick", (e: { nick: string; new_nick: string }) => {
      if (!live()) return;
      if (e.nick === this.nick) this.nick = e.new_nick;
      if (this.channelUsers.delete(e.nick.toLowerCase())) this.channelUsers.add(e.new_nick.toLowerCase());
    });

    // DCC SEND arrives as a CTCP inside a PRIVMSG ("ctcp request") or occasionally a NOTICE ("ctcp response").
    const onCtcp = (source: string) => (e: { nick: string; type: string | null; message: string }) => {
      if (!live()) return;
      log.info(`[CTCP ${source}] from ${e.nick}: ${JSON.stringify(e.message)}`);
      if ((e.type ?? "").toUpperCase() === "DCC") void this.handleDcc(e.message, `${source} from ${e.nick}`);
    };
    client.on("ctcp request", onCtcp("PRIVMSG"));
    client.on("ctcp response", onCtcp("NOTICE"));

    // The search bot talks to us over NOTICE ("accepted", "no matches", "wait N seconds"...).
    // A no-match reply would otherwise look exactly like a timeout.
    client.on("notice", (e: { nick?: string; target: string; message: string; from_server: boolean }) => {
      if (!live() || e.from_server || e.target.toLowerCase() !== this.nick.toLowerCase()) return;
      const text = stripFormatting(e.message);
      log.info(`[NOTICE] from ${e.nick}: ${text}`);
      if (this.state.status === "searching" && isNoResultsNotice(text)) {
        this.state.setError(text);
        this.state.setStatus("connected");
      }
    });

    client.on("raw", (e: { line: string; from_server: boolean }) => {
      if (e.from_server && (e.line.includes("\x01") || /DCC/i.test(e.line))) log.debug("[RAW DCC]", JSON.stringify(e.line));
    });

    client.on("irc error", (e: { error: string; reason?: string }) => {
      log.warn(`IRC error: ${e.error} ${e.reason ?? ""}`.trim());
    });
    client.on("socket error", (err: Error) => {
      log.error("Socket error:", err.message);
      if (live()) this.lastError = `Connection failed: ${err.message}`;
    });
    client.on("close", () => {
      if (!live()) return;
      // The server dropped us (or the connect failed). No auto-reconnect: the next
      // search or an explicit Connect click brings us back.
      log.warn("Connection closed");
      this.client = null;
      this.registered = false;
      this.channelUsers.clear();
      client.removeAllListeners();
      this.state.setStatus("disconnected");
      if (!this.lastError) this.lastError = "Connection closed by server";
    });
  }

  private async handleDcc(message: string, source: string): Promise<void> {
    const parsed = parseDccSend(message);
    if (!parsed) {
      if (/DCC SEND/i.test(message)) log.warn("Failed to parse DCC message:", JSON.stringify(message));
      return;
    }
    const host = dccAddressToHost(parsed.address);
    const key = `${parsed.filename}|${host}|${parsed.port}|${parsed.size}`;
    if (this.activeTransfers.has(key)) {
      log.debug("Skipping duplicate DCC SEND:", parsed.filename);
      return;
    }
    this.activeTransfers.add(key);

    const safeName = sanitizeFilename(parsed.filename);
    const outPath = safePath(TEMP_DIR, safeName);
    if (!outPath || !safeName) {
      log.warn("Blocked suspicious filename:", JSON.stringify(parsed.filename));
      this.activeTransfers.delete(key);
      return;
    }

    log.info(`Accepting DCC SEND (${source}): ${safeName} from ${host}:${parsed.port} (${parsed.size} bytes)`);
    this.state.setStatus("downloading");
    this.state.setDownloadProgress(safeName, 0, parsed.size);

    try {
      await dccReceive(host, parsed.port, parsed.size, outPath, {
        maxFileSize: currentMaxFileSize(this.maxFileSize),
        onProgress: (received, total) => this.state.setDownloadProgress(safeName, received, total),
      });
      log.info("Saved DCC file to", outPath);
      await this.processDownloadedFile(outPath, safeName);
    } catch (err) {
      log.error("DCC receive failed:", (err as Error).message);
      this.state.setError((err as Error).message);
      this.state.setStatus("connected");
    } finally {
      this.activeTransfers.delete(key);
      this.state.clearDownloadProgress();
    }
  }

  private async processDownloadedFile(filePath: string, name: string): Promise<void> {
    if (name.toLowerCase().endsWith(".txt.zip")) {
      const stem = name.slice(0, -".zip".length);
      const extractDir = uniqueExtractDir(resolve(RESULTS_DIR, stem));
      safeExtract(filePath, extractDir);
      log.info(`Unzipped ${name} to ${extractDir}`);

      const txtPath = firstTextFile(extractDir);
      if (!txtPath) {
        this.state.setStatus("connected");
        return;
      }
      const text = await Bun.file(txtPath).text();
      const lines = text.split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      const inserted = addResults(lines, this.state.searchTerm);
      log.info(`Results: ${lines.length} lines, ${inserted} new saved to database`);
      this.state.setExtractedLines(lines);
      this.state.setStatus("lines_ready");
      return;
    }

    const dir = loadConfig()?.download_path ?? CONFIG_DEFAULTS.download_path;
    const dest = resolve(dir, name);
    moveFile(filePath, dest);
    log.info("Saved file to", dest);
    this.state.addFile(name);
    this.state.setStatus("connected");
  }
}

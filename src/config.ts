import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const CONFIG_FILE = "irc_config.json";

export const DEFAULT_IRC_SERVER = "irc.irchighway.net";
export const DEFAULT_IRC_PORT = 6669;
export const DEFAULT_IRC_CHANNEL = "#ebooks";
export const IRC_TLS = false;

/** Mirrors the JSON layout of the original Python app so irc_config.json is interchangeable. */
export interface IrcConfig {
  nick: string;
  username: string;
  realname: string;
  server: string;
  port: number;
  channel: string;
  /** Minutes of inactivity before auto-disconnect. */
  idle_timeout: number;
  /** Seconds to wait for search results. */
  search_timeout: number;
  download_path: string;
  auto_connect: boolean;
  max_file_size_mb: number;
}

export const CONFIG_DEFAULTS = {
  server: DEFAULT_IRC_SERVER,
  port: DEFAULT_IRC_PORT,
  channel: DEFAULT_IRC_CHANNEL,
  idle_timeout: 20,
  search_timeout: 60,
  download_path: "./files",
  auto_connect: true,
  max_file_size_mb: 50,
} as const;

export function loadConfig(file: string = CONFIG_FILE): IrcConfig | null {
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (typeof data.nick !== "string" || typeof data.username !== "string" || typeof data.realname !== "string") {
      return null;
    }
    return {
      nick: data.nick,
      username: data.username,
      realname: data.realname,
      server: data.server ?? CONFIG_DEFAULTS.server,
      port: data.port ?? CONFIG_DEFAULTS.port,
      channel: data.channel ?? CONFIG_DEFAULTS.channel,
      idle_timeout: data.idle_timeout ?? CONFIG_DEFAULTS.idle_timeout,
      search_timeout: data.search_timeout ?? CONFIG_DEFAULTS.search_timeout,
      download_path: data.download_path ?? CONFIG_DEFAULTS.download_path,
      auto_connect: data.auto_connect ?? CONFIG_DEFAULTS.auto_connect,
      max_file_size_mb: data.max_file_size_mb ?? CONFIG_DEFAULTS.max_file_size_mb,
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: IrcConfig, file: string = CONFIG_FILE): void {
  writeFileSync(file, JSON.stringify(config, null, 2));
}

export function configExists(file: string = CONFIG_FILE): boolean {
  return loadConfig(file) !== null;
}

const NICK_ADJECTIVES = [
  "Quiet", "Curious", "Dusty", "Amber", "Velvet", "Lunar", "Mellow", "Rapid", "Silent", "Clever",
  "Gentle", "Hidden", "Misty", "Nimble", "Rusty", "Sunny", "Witty", "Cosmic", "Brisk", "Candid",
];
const NICK_NOUNS = [
  "Reader", "Owl", "Quill", "Page", "Fable", "Tome", "Scroll", "Lantern", "Raven", "Otter",
  "Badger", "Comet", "Willow", "Folio", "Sparrow", "Ember", "Harbor", "Meadow", "Pixel", "Atlas",
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/**
 * A random IRC identity offered on first run, so two fresh installs don't fight
 * over the same nick. Nicks stay within 16 characters and usernames within 10,
 * which every common IRC network accepts.
 */
export function randomIdentity(): { nick: string; username: string } {
  const noun = pick(NICK_NOUNS);
  const digits = String(Math.floor(Math.random() * 900) + 100);
  const nick = `${pick(NICK_ADJECTIVES)}${noun}${digits}`.slice(0, 16);
  const username = `${noun.toLowerCase().slice(0, 7)}${digits}`;
  return { nick, username };
}

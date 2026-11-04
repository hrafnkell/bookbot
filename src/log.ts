import { inspect } from "node:util";

const DEBUG = !!process.env.DEBUG;
/** How many entries the web UI can look back at. */
const BUFFER_SIZE = 500;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** Monotonic, so clients can ask for "everything after the last one I saw". */
  id: number;
  /** Unix milliseconds. */
  ts: number;
  level: LogLevel;
  message: string;
}

const buffer: LogEntry[] = [];
let nextId = 1;

function stamp(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      return inspect(a, { depth: 3, breakLength: Infinity });
    })
    .join(" ");
}

function emit(level: LogLevel, args: unknown[]): void {
  const now = new Date();
  const message = format(args);
  const entry: LogEntry = { id: nextId++, ts: now.getTime(), level, message };
  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.splice(0, buffer.length - BUFFER_SIZE);

  const line = `${stamp(now)} [${level.toUpperCase()}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (...args: unknown[]) => {
    if (DEBUG) emit("debug", args);
  },
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};

/** Buffered entries with an id greater than `afterId` (all of them when 0). */
export function getLogEntries(afterId = 0): LogEntry[] {
  if (afterId <= 0) return [...buffer];
  // Entries are in id order, so find the first one past afterId.
  let lo = 0;
  let hi = buffer.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (buffer[mid]!.id <= afterId) lo = mid + 1;
    else hi = mid;
  }
  return buffer.slice(lo);
}

/** Test helper. */
export function clearLogBuffer(): void {
  buffer.length = 0;
}

import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, renameSync, copyFileSync, unlinkSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { connect as netConnect } from "node:net";
import { unzipSync } from "fflate";

export interface DccSend {
  filename: string;
  address: string;
  port: number;
  size: number;
}

const isDigits = (s: string) => /^\d+$/.test(s);

/**
 * Parse a CTCP "DCC SEND <file> <address> <port> [size]" payload.
 * Accepts the payload with or without the surrounding \x01 markers.
 * Filenames may be quoted or contain apostrophes (e.g. Carl's) and, unlike
 * a naive split, unquoted filenames with spaces are reassembled.
 */
export function parseDccSend(message: string): DccSend | null {
  let payload = message;
  if (payload.startsWith("\x01") && payload.endsWith("\x01")) payload = payload.slice(1, -1);
  if (!/^DCC SEND /i.test(payload)) return null;

  const tokens = payload.trim().split(/\s+/).slice(2); // drop "DCC" "SEND"
  let filenameTokens: string[];
  let address: string;
  let port: number;
  let size = 0;

  if (tokens.length >= 4 && isDigits(tokens.at(-1)!) && isDigits(tokens.at(-2)!)) {
    size = Number(tokens.at(-1));
    port = Number(tokens.at(-2));
    address = tokens.at(-3)!;
    filenameTokens = tokens.slice(0, -3);
  } else if (tokens.length >= 3 && isDigits(tokens.at(-1)!)) {
    port = Number(tokens.at(-1));
    address = tokens.at(-2)!;
    filenameTokens = tokens.slice(0, -2);
  } else {
    return null;
  }

  let filename = filenameTokens.join(" ");
  if (filename.length >= 2 && filename.startsWith('"') && filename.endsWith('"')) filename = filename.slice(1, -1);
  if (!filename) return null;
  return { filename, address, port, size };
}

export function intToIp(ipInt: bigint | number): string {
  const n = BigInt(ipInt);
  return [24n, 16n, 8n, 0n].map((shift) => ((n >> shift) & 0xffn).toString()).join(".");
}

/** Resolve the address field of a DCC SEND, which is usually a 32-bit integer but may be a literal IP. */
export function dccAddressToHost(address: string): string {
  return isDigits(address) ? intToIp(BigInt(address)) : address;
}

export interface DccReceiveOptions {
  maxFileSize: number;
  connectTimeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
}

/** Receive a DCC SEND transfer into outPath, acknowledging bytes as they arrive. */
export function dccReceive(host: string, port: number, size: number, outPath: string, opts: DccReceiveOptions): Promise<number> {
  if (size > opts.maxFileSize) {
    return Promise.reject(new Error(`File too large: ${size} bytes (max ${opts.maxFileSize})`));
  }

  return new Promise((resolvePromise, reject) => {
    mkdirSync(dirname(outPath), { recursive: true });
    const file = createWriteStream(outPath);
    const socket = netConnect({ host, port });
    let received = 0;
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      socket.destroy();
      file.end(() => (err ? reject(err) : resolvePromise(received)));
    };

    const connectTimer = setTimeout(() => finish(new Error(`Timed out connecting to ${host}:${port}`)), opts.connectTimeoutMs ?? 30_000);
    socket.once("connect", () => clearTimeout(connectTimer));

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (size > 0 && received + chunk.length > size) chunk = chunk.subarray(0, size - received);
      file.write(chunk);
      received += chunk.length;

      if (received > opts.maxFileSize) {
        finish(new Error(`File exceeded max size: ${opts.maxFileSize}`));
        return;
      }
      opts.onProgress?.(received, size);

      // DCC ack: total bytes received as a 32-bit big-endian integer. Ignore write errors;
      // the sender may close the connection as soon as its last byte is out.
      const ack = Buffer.alloc(4);
      ack.writeUInt32BE(received % 0x1_0000_0000);
      try {
        socket.write(ack);
      } catch {
        /* sender gone */
      }

      if (size > 0 && received >= size) finish();
    });

    socket.on("error", (err) => {
      // A reset after the full file arrived is normal for many DCC senders.
      if (size > 0 && received >= size) finish();
      else finish(err);
    });
    socket.on("close", () => {
      if (size > 0 && received < size) finish(new Error(`Connection closed early: got ${received} of ${size} bytes`));
      else finish();
    });
  });
}

/** Resolve `relative` inside `base`, refusing anything that escapes it. */
export function safePath(base: string, relative: string): string | null {
  const root = resolve(base);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/** Extract a zip archive, blocking entries whose paths escape targetDir. */
export function safeExtract(zipPath: string, targetDir: string): void {
  const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
  for (const name of Object.keys(entries)) {
    if (safePath(targetDir, name) === null) throw new Error(`Blocked zip path: ${name}`);
  }
  mkdirSync(targetDir, { recursive: true });
  for (const [name, data] of Object.entries(entries)) {
    const dest = safePath(targetDir, name)!;
    if (name.endsWith("/")) {
      mkdirSync(dest, { recursive: true });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  }
}

export function firstTextFile(root: string): string | null {
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    const st = statSync(full);
    if (st.isFile() && name.toLowerCase().endsWith(".txt")) return full;
    if (st.isDirectory()) {
      const nested = firstTextFile(full);
      if (nested) return nested;
    }
  }
  return null;
}

export function uniqueExtractDir(base: string): string {
  if (!existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Could not allocate extract directory");
}

/** Move a file, falling back to copy+delete across filesystems. */
export function moveFile(from: string, to: string): void {
  if (resolve(from) === resolve(to)) return;
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** Strip any directory components from a filename offered by a remote peer. */
export function sanitizeFilename(filename: string): string {
  return basename(filename.replace(/^"|"$/g, "").replace(/\\/g, "/"));
}

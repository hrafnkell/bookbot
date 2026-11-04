/**
 * End-to-end test against a fake IRC server and a fake DCC sender, all on localhost.
 * Exercises: connect → @search → DCC SEND of a .txt.zip → results extracted and stored →
 * select a line → "!nick file" sent → DCC SEND of a binary → file saved, downloadable, deletable →
 * disconnect without a reconnect.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import net, { type AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";

const dataDir = mkdtempSync(join(tmpdir(), "ircbook-e2e-"));
process.chdir(dataDir);

const { BotState } = await import("../src/state.ts");
const { IrcBotWrapper } = await import("../src/irc.ts");
const { initDatabase } = await import("../src/database.ts");
const { createServer } = await import("../src/server.ts");

// What the search bot puts above the results; it must not reach the UI.
const RESULT_HEADER = [
  "Search results from SearchOok v3.0, for: children of time",
  "Searched 12 lists for \"children of time\" , found 2 matches. Enjoy!",
  "This list includes results from all online lists.",
  "For easier searching, use @find or @locator.",
  "",
  "Results:",
];
const RESULT_LINES = ["!Oatmeal Adrian Tchaikovsky - Children of Time.epub  ::INFO:: 1.1MB", "!peapod Carl's Book.epub  ::INFO:: 2MB"];
const EPUB_BYTES = Buffer.from("PK\x03\x04 fake epub payload ".repeat(2000));

let ircConnections = 0;
const ircLines: string[] = [];
let ircPort = 0;
let dccPort = 0;
let baseUrl = "";
let serverSocket: net.Socket | null = null;
let dccPayload: Buffer = Buffer.alloc(0);
let ircServer: net.Server;
let dccServer: net.Server;
let web: ReturnType<typeof createServer>;
const irc = new IrcBotWrapper(new BotState());
const state = (irc as any).state as InstanceType<typeof BotState>;

function dccSend(filename: string, payload: Buffer) {
  dccPayload = payload;
  // 2130706433 == 127.0.0.1 as a 32-bit integer
  serverSocket!.write(`:Search!s@h PRIVMSG BigBobby :\x01DCC SEND ${filename} 2130706433 ${dccPort} ${payload.length}\x01\r\n`);
}

beforeAll(async () => {
  initDatabase();

  dccServer = net.createServer((sock) => {
    sock.write(dccPayload);
    sock.on("data", () => {}); // acks
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => dccServer.listen(0, "127.0.0.1", r));
  dccPort = (dccServer.address() as AddressInfo).port;

  ircServer = net.createServer((sock) => {
    ircConnections++;
    serverSocket = sock;
    let nick = "";
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        ircLines.push(line);
        if (line.startsWith("NICK ")) {
          nick = line.split(" ")[1]!;
          sock.write(`:srv 001 ${nick} :Welcome\r\n:srv 005 ${nick} NETWORK=fake :are supported\r\n`);
        } else if (line.startsWith("JOIN ")) {
          sock.write(`:${nick}!u@h JOIN :#ebooks\r\n:srv 353 ${nick} = #ebooks :@Search +Oatmeal peapod ${nick}\r\n:srv 366 ${nick} #ebooks :End of NAMES\r\n`);
        } else if (line.startsWith("PRIVMSG #ebooks :@search nothing")) {
          sock.write(`:Search!s@h NOTICE ${nick} :\x031,9<<SearchBot>> Your search for "\x0312,09nothing\x0301,09" has been accepted. Searching...\r\n`);
          setTimeout(() => sock.write(`:Search!s@h NOTICE ${nick} :\x031,9<<SearchBot>> Sorry, your search for "\x0312,09nothing\x0301,09" returned no matches. Search took 1.24 seconds.\r\n`), 100);
        } else if (line.startsWith("PRIVMSG #ebooks :@search headeronly")) {
          const zip = zipSync({ "SearchBot_results_for__headeronly.txt": strToU8(RESULT_HEADER.join("\r\n") + "\r\n") });
          dccSend("SearchBot_results_for__headeronly.txt.zip", Buffer.from(zip));
        } else if (line.startsWith("PRIVMSG #ebooks :@search ")) {
          const zip = zipSync({ "SearchBot_results_for__test.txt": strToU8([...RESULT_HEADER, ...RESULT_LINES].join("\r\n") + "\r\n") });
          dccSend("SearchBot_results_for__test.txt.zip", Buffer.from(zip));
        } else if (line.startsWith("PRIVMSG #ebooks :!peapod ")) {
          dccSend("Carl's_Book.epub", EPUB_BYTES);
        } else if (line.startsWith("PING")) {
          sock.write(`PONG ${line.slice(5)}\r\n`);
        } else if (line.startsWith("QUIT")) {
          sock.end();
        }
      }
    });
  });
  await new Promise<void>((r) => ircServer.listen(0, "127.0.0.1", r));
  ircPort = (ircServer.address() as AddressInfo).port;

  web = createServer({ state, irc, sendDelay: 0.05, port: 0, hostname: "127.0.0.1", onShutdown: () => {} });
  baseUrl = `http://127.0.0.1:${web.port}`;
});

afterAll(() => {
  irc.disconnect("done");
  web.stop(true);
  ircServer.close();
  dccServer.close();
});

async function status() {
  return (await fetch(`${baseUrl}/status`)).json() as Promise<any>;
}

async function waitFor(pred: (s: any) => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await status();
    if (pred(last)) return last;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for state. Last: ${JSON.stringify(last)}`);
}

test("rejects search before configuration exists", async () => {
  const form = new FormData();
  form.append("term", "x");
  const res = await fetch(`${baseUrl}/api/search`, { method: "POST", body: form });
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toMatch(/Configuration not found/);
});

test("before the first save, the config API suggests a random identity that stays stable", async () => {
  const first = (await (await fetch(`${baseUrl}/api/config`)).json()) as any;
  expect(first.exists).toBe(false);
  expect(first.suggested.nick).toMatch(/^[A-Za-z][A-Za-z0-9]+$/);
  expect(first.suggested.username).toMatch(/^[a-z][a-z0-9]+$/);
  expect(first.server).toBe("irc.irchighway.net");
  const again = (await (await fetch(`${baseUrl}/api/config`)).json()) as any;
  expect(again.suggested).toEqual(first.suggested);
});

test("saves configuration via the API", async () => {
  const res = await fetch(`${baseUrl}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nick: "BigBobby", username: "bigbob", realname: "Big Book Energy",
      server: "127.0.0.1", port: String(ircPort), channel: "#ebooks",
      idle_timeout: "20", search_timeout: "5", download_path: "./files", max_file_size_mb: "1", auto_connect: false,
    }),
  });
  expect(res.status).toBe(200);
  const cfg = (await (await fetch(`${baseUrl}/api/config`)).json()) as any;
  expect(cfg).toMatchObject({ exists: true, nick: "BigBobby", port: ircPort, max_file_size_mb: 1 });
  expect(existsSync(join(dataDir, "irc_config.json"))).toBe(true);
});

test("search auto-connects, waits for the join, and receives results over DCC", async () => {
  const form = new FormData();
  form.append("term", "children of time");
  const res = await fetch(`${baseUrl}/api/search`, { method: "POST", body: form });
  expect(res.status).toBe(200);
  expect(ircLines.some((l) => l === "PRIVMSG #ebooks :@search children of time")).toBe(true);
  // The search must have been sent after registration, never before.
  expect(ircLines.findIndex((l) => l.startsWith("JOIN"))).toBeLessThan(ircLines.findIndex((l) => l.includes("@search")));

  const s = await waitFor((s) => s.status === "lines_ready");
  expect(s.is_connected).toBe(true);
  expect(s.extracted_lines).toEqual(RESULT_LINES);
  expect(s.search_term).toBe("children of time");
  expect(existsSync(join(dataDir, "results", "SearchBot_results_for__test.txt", "SearchBot_results_for__test.txt"))).toBe(true);

  const db = (await (await fetch(`${baseUrl}/db/search?q=carl%20epub`)).json()) as any;
  expect(db.total).toBe(1);
  expect(db.results[0].line).toBe(RESULT_LINES[1]);
  expect(db.results[0].search_term).toBe("children of time");
  const stats = (await (await fetch(`${baseUrl}/db/stats`)).json()) as any;
  expect(stats).toEqual({ total_results: 2, unique_search_terms: 1 });
});

test("legacy POST /search still works and assets are not cached", async () => {
  const form = new FormData();
  form.append("term", "legacy client");
  const res = await fetch(`${baseUrl}/search`, { method: "POST", body: form });
  expect(res.status).toBe(200);
  // The message is written asynchronously; the fake server answers it with results.
  await waitFor((s) => s.status === "lines_ready");
  expect(ircLines.some((l) => l === "PRIVMSG #ebooks :@search legacy client")).toBe(true);
  expect((await fetch(`${baseUrl}/static/app.js`)).headers.get("cache-control")).toBe("no-cache");
});

test("a 'no matches' notice from the search bot ends the search with a readable error", async () => {
  const form = new FormData();
  form.append("term", "nothing");
  // Clear the previous results so we can observe the status change
  expect((await fetch(`${baseUrl}/api/search`, { method: "POST", body: form })).status).toBe(200);
  const s = await waitFor((s) => s.status === "connected" && !!s.error);
  expect(s.error).toBe('<<SearchBot>> Sorry, your search for "nothing" returned no matches. Search took 1.24 seconds.');

  // Restore the results state for the following tests
  const again = new FormData();
  again.append("term", "children of time");
  expect((await fetch(`${baseUrl}/api/search`, { method: "POST", body: again })).status).toBe(200);
  await waitFor((s) => s.status === "lines_ready");
});

test("a result file with no download lines ends the search with 'No results found'", async () => {
  const form = new FormData();
  form.append("term", "headeronly");
  expect((await fetch(`${baseUrl}/api/search`, { method: "POST", body: form })).status).toBe(200);
  const s = await waitFor((s) => s.status === "connected" && !!s.error);
  expect(s.error).toBe('No results found for "headeronly"');
  expect(s.extracted_lines).toBeNull();

  // Leave the earlier results in place for the selection tests that follow.
  const again = new FormData();
  again.append("term", "children of time");
  expect((await fetch(`${baseUrl}/api/search`, { method: "POST", body: again })).status).toBe(200);
  await waitFor((s) => s.status === "lines_ready");
});

test("rejects selections whose nick is not in the channel", async () => {
  // Make the first line's nick leave the channel
  serverSocket!.write(`:Oatmeal!u@h PART #ebooks :bye\r\n`);
  await Bun.sleep(100);
  const res = await fetch(`${baseUrl}/select`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indices: [1] }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe("Nick(s) not in channel: Oatmeal");
});

test("saved results report whether each nick is in the channel", async () => {
  // Oatmeal left in the previous test; peapod is still there.
  const db = (await (await fetch(`${baseUrl}/db/search?q=epub`)).json()) as any;
  expect(db.joined).toBe(true);
  const byNick = Object.fromEntries(db.results.map((r: any) => [r.nick, r.in_channel]));
  expect(byNick).toEqual({ Oatmeal: false, peapod: true });

  const res = await fetch(`${baseUrl}/api/presence`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nicks: ["peapod", "Oatmeal", "PEAPOD"] }),
  });
  expect(await res.json()).toEqual({ joined: true, present: { peapod: true, Oatmeal: false, PEAPOD: true } });

  serverSocket!.write(`:Oatmeal!u@h JOIN :#ebooks\r\n`);
  await Bun.sleep(100);
  const back = (await (await fetch(`${baseUrl}/api/presence`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nicks: ["Oatmeal"] }),
  })).json()) as any;
  expect(back.present.Oatmeal).toBe(true);
  serverSocket!.write(`:Oatmeal!u@h PART #ebooks :bye\r\n`);
  await Bun.sleep(100);
});

test("selecting a line sends the command and the resulting file lands in the download folder", async () => {
  const res = await fetch(`${baseUrl}/select`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indices: [2] }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true, count: 1 });

  const s = await waitFor((s) => s.files.includes("Carl's_Book.epub"));
  expect(s.status).toBe("connected");
  expect(existsSync(join(dataDir, "files", "Carl's_Book.epub"))).toBe(true);
  expect(existsSync(join(dataDir, "temp", "Carl's_Book.epub"))).toBe(false);

  const dl = await fetch(`${baseUrl}/files/download/${encodeURIComponent("Carl's_Book.epub")}`);
  expect(dl.status).toBe(200);
  expect(dl.headers.get("content-disposition")).toContain("attachment");
  expect(Buffer.from(await dl.arrayBuffer()).equals(EPUB_BYTES)).toBe(true);

  const del = await fetch(`${baseUrl}/files/delete/${encodeURIComponent("Carl's_Book.epub")}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  expect(existsSync(join(dataDir, "files", "Carl's_Book.epub"))).toBe(false);
  expect((await fetch(`${baseUrl}/files/download/..%2Firc_config.json`)).status).toBe(404);
});

test("oversized transfers are refused", async () => {
  dccSend("huge.epub", Buffer.alloc(2 * 1024 * 1024));
  const s = await waitFor((s) => !!s.error && /too large/i.test(s.error));
  expect(s.status).toBe("connected");
  expect(existsSync(join(dataDir, "files", "huge.epub"))).toBe(false);
});

test("saved-results download auto-connects when needed and checks nicks", async () => {
  const res = await fetch(`${baseUrl}/db/select`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lines: ["!nobody x.epub"] }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe("Nick(s) not in channel: nobody");
});

test("disconnect sends QUIT and does not reconnect", async () => {
  const before = ircConnections;
  const res = await fetch(`${baseUrl}/disconnect`, { method: "POST" });
  expect(res.status).toBe(200);
  await Bun.sleep(1500);
  expect(ircLines.some((l) => l.startsWith("QUIT"))).toBe(true);
  expect(ircConnections).toBe(before);
  expect((await status()).is_connected).toBe(false);
  expect((await fetch(`${baseUrl}/disconnect`, { method: "POST" })).status).toBe(400);

  // Presence is unknown while we're out of the channel.
  const db = (await (await fetch(`${baseUrl}/db/search?q=epub`)).json()) as any;
  expect(db.joined).toBe(false);
  expect(db.results.every((r: any) => r.in_channel === null)).toBe(true);
});

test("explicit connect works and search waits for registration", async () => {
  const res = await fetch(`${baseUrl}/connect`, { method: "POST" });
  expect(res.status).toBe(200);
  await waitFor((s) => s.is_connected);
  expect(irc.isJoined()).toBe(true);
});

test("the activity log is exposed over /api/log with timestamps and incremental fetching", async () => {
  const all = (await (await fetch(`${baseUrl}/api/log`)).json()) as any;
  expect(all.entries.length).toBeGreaterThan(0);
  expect(all.last_id).toBe(all.entries.at(-1).id);
  const messages = all.entries.map((e: any) => e.message).join("\n");
  // Events from the earlier tests should all be visible to the UI.
  expect(messages).toContain("Sent search: @search children of time");
  expect(messages).toMatch(/Sent download request: !peapod/);
  expect(messages).toMatch(/\[NOTICE\] from Search: .*returned no matches/);
  expect(messages).toContain("Disconnect requested from web UI");
  for (const e of all.entries) {
    expect(["debug", "info", "warn", "error"]).toContain(e.level);
    expect(typeof e.ts).toBe("number");
    expect(Math.abs(Date.now() - e.ts)).toBeLessThan(5 * 60_000);
  }

  // Nothing new since last_id...
  const none = (await (await fetch(`${baseUrl}/api/log?after=${all.last_id}`)).json()) as any;
  expect(none.entries).toEqual([]);
  expect(none.last_id).toBe(all.last_id);

  // ...until something happens.
  await fetch(`${baseUrl}/db/clear`, { method: "POST" });
  const fresh = (await (await fetch(`${baseUrl}/api/log?after=${all.last_id}`)).json()) as any;
  expect(fresh.entries.length).toBeGreaterThanOrEqual(1);
  expect(fresh.entries.every((e: any) => e.id > all.last_id)).toBe(true);
  expect(fresh.entries.map((e: any) => e.message).join("\n")).toMatch(/Cleared \d+ saved results/);

  // Garbage is treated as "from the start".
  const junk = (await (await fetch(`${baseUrl}/api/log?after=abc`)).json()) as any;
  expect(junk.entries.length).toBe(all.entries.length + fresh.entries.length);
});

test("serves the single-page app on every tab path", async () => {
  for (const path of ["/", "/search", "/downloads", "/saved", "/config", "/log"]) {
    const res = await fetch(`${baseUrl}${path}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="tab-config"');
    expect(html).toContain('id="tab-log"');
    // Every stylesheet, script and icon the page references must be served.
    const assets = [...html.matchAll(/(?:href|src)="(\/static\/[^"]+)"/g)].map((m) => m[1]!);
    expect(assets.sort()).toEqual(["/static/app.js", "/static/favicon.svg", "/static/styles.css"]);
    for (const asset of assets) {
      const r = await fetch(`${baseUrl}${asset}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).not.toBeNull();
    }
  }
  expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
});

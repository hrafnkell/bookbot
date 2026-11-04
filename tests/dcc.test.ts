import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { parseDccSend, intToIp, safeExtract, safePath, sanitizeFilename, dccAddressToHost } from "../src/dcc.ts";
import { extractNickFromLine, pickOutgoingAddr, stripFormatting, isNoResultsNotice } from "../src/irc.ts";

test("parses a plain DCC SEND with size", () => {
  expect(parseDccSend("\x01DCC SEND SearchBot_results_for__carl.txt.zip 3232235777 51000 3706\x01")).toEqual({
    filename: "SearchBot_results_for__carl.txt.zip",
    address: "3232235777",
    port: 51000,
    size: 3706,
  });
});

test("accepts the payload without CTCP markers (irc-framework strips them)", () => {
  expect(parseDccSend("DCC SEND file.epub 16909060 4000 12")?.filename).toBe("file.epub");
});

test("handles apostrophes and quoted names with spaces", () => {
  expect(parseDccSend("DCC SEND Carl's_book.epub 1 2 3")?.filename).toBe("Carl's_book.epub");
  expect(parseDccSend('DCC SEND "Some Book (retail).epub" 16909060 4000 12')?.filename).toBe("Some Book (retail).epub");
  expect(parseDccSend("DCC SEND Some Book.epub 16909060 4000 12")?.filename).toBe("Some Book.epub");
});

test("size is optional", () => {
  expect(parseDccSend("DCC SEND file.epub 16909060 4000")).toEqual({ filename: "file.epub", address: "16909060", port: 4000, size: 0 });
});

test("rejects non-DCC and malformed messages", () => {
  expect(parseDccSend("\x01VERSION\x01")).toBeNull();
  expect(parseDccSend("DCC CHAT chat 1 2")).toBeNull();
  expect(parseDccSend("DCC SEND onlyname")).toBeNull();
});

test("converts integer addresses to dotted IPs", () => {
  expect(intToIp(3232235777)).toBe("192.168.1.1");
  expect(intToIp(16909060)).toBe("1.2.3.4");
  expect(dccAddressToHost("127.0.0.1")).toBe("127.0.0.1");
});

test("sanitizes remote filenames and confines paths", () => {
  expect(sanitizeFilename('"../../etc/passwd"')).toBe("passwd");
  expect(sanitizeFilename("C:\\x\\y.epub")).toBe("y.epub");
  expect(safePath("/tmp/base", "ok.txt")).toBe("/tmp/base/ok.txt");
  expect(safePath("/tmp/base", "../escape.txt")).toBeNull();
  expect(safePath("/tmp/base", "/abs.txt")).toBeNull();
});

test("safeExtract writes entries and blocks traversal", () => {
  const dir = mkdtempSync(join(tmpdir(), "ircbook-zip-"));
  const good = join(dir, "good.zip");
  writeFileSync(good, zipSync({ "results.txt": strToU8("!bot a.epub\n!bot b.epub\n") }));
  safeExtract(good, join(dir, "out"));
  expect(readFileSync(join(dir, "out", "results.txt"), "utf8")).toContain("!bot b.epub");

  const evil = join(dir, "evil.zip");
  writeFileSync(evil, zipSync({ "../evil.txt": strToU8("x") }));
  expect(() => safeExtract(evil, join(dir, "out2"))).toThrow(/Blocked zip path/);
  expect(existsSync(join(dir, "evil.txt"))).toBe(false);
});

test("extracts nicks from download lines", () => {
  expect(extractNickFromLine("!Oatmeal Some Book.epub  ::INFO:: 1.2MB")).toBe("Oatmeal");
  expect(extractNickFromLine("no bang")).toBeNull();
  expect(extractNickFromLine("!")).toBeNull();
});

test("prefers IPv4 when the server has both address families", () => {
  expect(pickOutgoingAddr([{ family: 6 }, { family: 4 }])).toBe("0.0.0.0");
  expect(pickOutgoingAddr([{ family: 6 }])).toBe("::");
  expect(pickOutgoingAddr([])).toBeUndefined();
});

test("strips IRC formatting and recognises no-result notices", () => {
  expect(stripFormatting('\x031,9<<SearchBot>> Your search for "\x0312,09x\x0301,09" has been accepted.')).toBe('<<SearchBot>> Your search for "x" has been accepted.');
  expect(stripFormatting("\x02bold\x02 \x1funder\x0f")).toBe("bold under");
  expect(isNoResultsNotice("Sorry, your search returned no matches.")).toBe(true);
  expect(isNoResultsNotice("Your search has been accepted. Searching...")).toBe(false);
});

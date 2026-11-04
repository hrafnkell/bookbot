import { test, expect, beforeEach } from "bun:test";
import { clearLogBuffer, getLogEntries, log } from "../src/log.ts";

beforeEach(() => clearLogBuffer());

test("entries are buffered with increasing ids, timestamps and levels", () => {
  const before = Date.now();
  log.info("hello", "world");
  log.warn("careful:", 42);
  log.error(new Error("boom"));
  const entries = getLogEntries();
  expect(entries.map((e) => e.level)).toEqual(["info", "warn", "error"]);
  expect(entries.map((e) => e.message)).toEqual(["hello world", "careful: 42", "boom"]);
  expect(entries[0]!.id).toBeLessThan(entries[1]!.id);
  expect(entries[1]!.id).toBeLessThan(entries[2]!.id);
  for (const e of entries) {
    expect(e.ts).toBeGreaterThanOrEqual(before);
    expect(e.ts).toBeLessThanOrEqual(Date.now());
  }
});

test("after=<id> returns only newer entries", () => {
  log.info("one");
  log.info("two");
  const [first] = getLogEntries();
  log.info("three");
  expect(getLogEntries(first!.id).map((e) => e.message)).toEqual(["two", "three"]);
  const lastId = getLogEntries().at(-1)!.id;
  expect(getLogEntries(lastId)).toEqual([]);
  // An id the buffer has never seen (e.g. a stale client) still works.
  expect(getLogEntries(lastId + 1000)).toEqual([]);
});

test("the buffer is bounded", () => {
  for (let i = 0; i < 700; i++) log.info(`line ${i}`);
  const entries = getLogEntries();
  expect(entries.length).toBe(500);
  expect(entries[0]!.message).toBe("line 200");
  expect(entries.at(-1)!.message).toBe("line 699");
});

test("debug entries are only recorded when DEBUG is set", () => {
  log.debug("hidden");
  expect(getLogEntries().filter((e) => e.level === "debug").length).toBe(process.env.DEBUG ? 1 : 0);
});

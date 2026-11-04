import { test, expect } from "bun:test";
import { randomIdentity } from "../src/config.ts";

test("random identities are valid IRC nicks and usernames", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const { nick, username } = randomIdentity();
    expect(nick).toMatch(/^[A-Za-z][A-Za-z0-9]{2,15}$/);
    expect(username).toMatch(/^[a-z][a-z0-9]{2,9}$/);
    seen.add(nick);
  }
  // Not the same value every time.
  expect(seen.size).toBeGreaterThan(50);
});

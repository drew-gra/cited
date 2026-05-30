import { describe, it, expect } from "vitest";
import { isBlocked } from "./blocklist";

describe("isBlocked — manual L0 blocklist suffix match", () => {
  it("exact match returns true", () => {
    expect(isBlocked("example.com", ["example.com"])).toBe(true);
  });

  it("subdomain of a blocked entry returns true", () => {
    expect(isBlocked("news.example.com", ["example.com"])).toBe(true);
    expect(isBlocked("a.b.c.example.com", ["example.com"])).toBe(true);
  });

  it("unrelated domain returns false", () => {
    expect(isBlocked("example.org", ["example.com"])).toBe(false);
  });

  it("bare prefix is NOT a match (boundary-delimited only)", () => {
    // notexample.com should NOT match example.com — they're different
    // outlets that happen to share a string suffix.
    expect(isBlocked("notexample.com", ["example.com"])).toBe(false);
  });

  it("case-insensitive in both directions", () => {
    expect(isBlocked("News.Example.COM", ["example.com"])).toBe(true);
    expect(isBlocked("news.example.com", ["EXAMPLE.COM"])).toBe(true);
  });

  it("empty blocklist => false", () => {
    expect(isBlocked("example.com", [])).toBe(false);
  });

  it("multiple entries: matches any", () => {
    const list = ["foo.com", "bar.com", "baz.com"];
    expect(isBlocked("news.bar.com", list)).toBe(true);
    expect(isBlocked("qux.com", list)).toBe(false);
  });

  it("empty string entries are skipped, not treated as match-all", () => {
    expect(isBlocked("anything.com", [""])).toBe(false);
  });
});

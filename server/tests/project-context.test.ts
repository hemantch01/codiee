import { describe, it, expect } from "vitest";
import {
  parseIgnoreRules,
  isIgnored,
  findProjectRoot,
} from "../src/lib/project-context.js";

describe("parseIgnoreRules", () => {
  it("ignores comments and blank lines", () => {
    const rules = parseIgnoreRules("# a comment\n\n   \nnode_modules");
    expect(rules).toHaveLength(1);
    expect(rules[0].negate).toBe(false);
    expect(rules[0].dirOnly).toBe(false);
  });

  it("parses negation, dir-only and anchored patterns", () => {
    const rules = parseIgnoreRules(["!keep.txt", "dist/", "/root-only"].join("\n"));
    expect(rules[0].negate).toBe(true);
    expect(rules[1].dirOnly).toBe(true);
    expect(rules[2].re.source.startsWith("^")).toBe(true);
  });
});

describe("isIgnored", () => {
  const rules = parseIgnoreRules(
    ["node_modules", "*.log", "dist/", "!keep.log", "/secrets"].join("\n")
  );

  it("matches bare names at any depth", () => {
    expect(isIgnored("node_modules", true, rules)).toBe(true);
    expect(isIgnored("a/b/node_modules", true, rules)).toBe(true);
  });

  it("matches glob patterns", () => {
    expect(isIgnored("debug.log", false, rules)).toBe(true);
    expect(isIgnored("src/deep/error.log", false, rules)).toBe(true);
    // negation wins (last matching rule)
    expect(isIgnored("keep.log", false, rules)).toBe(false);
  });

  it("directory-only rules also ignore nested paths", () => {
    expect(isIgnored("dist", true, rules)).toBe(true);
    expect(isIgnored("dist/out.js", false, rules)).toBe(true);
    expect(isIgnored("src/dist-thing.js", false, rules)).toBe(false);
  });

  it("anchored patterns only match at root", () => {
    expect(isIgnored("secrets", true, rules)).toBe(true);
    expect(isIgnored("src/secrets", true, rules)).toBe(false);
  });

  it("does not ignore unmatched files", () => {
    expect(isIgnored("src/index.ts", false, rules)).toBe(false);
  });
});

describe("findProjectRoot", () => {
  it("finds the repo root from a nested directory (this project has package.json)", async () => {
    const root = await findProjectRoot(process.cwd());
    expect(root).toBeTruthy();
  });
});

import { describe, it, expect } from "vitest";
import { chunkContent } from "../src/lib/rag-client.js";

const line = (i: number) => `line ${i}: some code content to pad the chunk length`;

describe("chunkContent", () => {
  it("produces chunks within the target size", () => {
    const content = Array.from({ length: 300 }, (_, i) => line(i)).join("\n");
    const chunks = chunkContent(content);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Allow some slack beyond target (single lines can't be split further)
      expect(c.length).toBeLessThanOrEqual(1500 + 200);
    }
  });

  it("creates overlapping chunks for continuity", () => {
    const content = Array.from({ length: 200 }, (_, i) => line(i)).join("\n");
    const chunks = chunkContent(content);

    if (chunks.length > 1) {
      const tailLines = chunks[0].split("\n").slice(-3);
      const headLines = chunks[1].split("\n").slice(0, 3);
      // The overlap tail of chunk N should appear at the start of chunk N+1
      expect(tailLines.some((l) => headLines.includes(l))).toBe(true);
    }
  });

  it("hard-splits pathological single lines", () => {
    const longLine = "x".repeat(5000);
    const chunks = chunkContent(longLine);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500);
  });

  it("filters out blank chunks", () => {
    const chunks = chunkContent("\n\n\n   \n");
    expect(chunks).toHaveLength(0);
  });

  it("returns a single chunk for small files", () => {
    const chunks = chunkContent("const a = 1;\nconst b = 2;");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("const a = 1;");
  });
});

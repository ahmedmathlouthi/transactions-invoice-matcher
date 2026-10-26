import { describe, expect, it } from "vitest";
import { dayDiff, normalizeLabel } from "./matcher";

describe("matcher", () => {
  it("normalizes labels", () => {
    expect(normalizeLabel(" SFR ")).toBe("sfr");
  });

  it("computes the difference in days", () => {
    expect(dayDiff("2026-01-31", "2026-01-01")).toBe(30);
  });
});

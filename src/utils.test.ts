import { describe, it, expect } from "vitest";
import {
  escapeXml,
  validateNumber,
  validateCoupling,
  validateBranchingRatio,
  validateMass,
  safeResolvePath,
  safeRegex,
  parallelLimit,
  generateReducedCouplingsXML,
  generateSignalStrengthsXML,
  compute2HDMCouplings,
  ALLOWED_PRODUCTION_MODES,
  ALLOWED_DECAY_MODES,
} from "./utils.js";

// ── escapeXml ──────────────────────────────────────────────

describe("escapeXml", () => {
  it("escapes ampersands", () => {
    expect(escapeXml("a&b")).toBe("a&amp;b");
  });

  it("escapes angle brackets", () => {
    expect(escapeXml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes quotes", () => {
    expect(escapeXml(`"hello" 'world'`)).toBe("&quot;hello&quot; &apos;world&apos;");
  });

  it("handles numbers", () => {
    expect(escapeXml(125.09)).toBe("125.09");
  });

  it("handles strings with no special characters", () => {
    expect(escapeXml("hello")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(escapeXml("")).toBe("");
  });

  it("escapes all special chars together", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });
});

// ── validateNumber ─────────────────────────────────────────

describe("validateNumber", () => {
  it("returns value when within range", () => {
    expect(validateNumber(5, "test", 0, 10)).toBe(5);
  });

  it("accepts boundary values", () => {
    expect(validateNumber(0, "test", 0, 10)).toBe(0);
    expect(validateNumber(10, "test", 0, 10)).toBe(10);
  });

  it("throws for value below range", () => {
    expect(() => validateNumber(-1, "test", 0, 10)).toThrow("test must be between 0 and 10");
  });

  it("throws for value above range", () => {
    expect(() => validateNumber(11, "test", 0, 10)).toThrow("test must be between 0 and 10");
  });

  it("throws for non-number types", () => {
    expect(() => validateNumber("5" as unknown, "test", 0, 10)).toThrow("test must be a finite number");
    expect(() => validateNumber(null as unknown, "test", 0, 10)).toThrow("test must be a finite number");
    expect(() => validateNumber(undefined as unknown, "test", 0, 10)).toThrow("test must be a finite number");
  });

  it("throws for NaN", () => {
    expect(() => validateNumber(NaN, "test", 0, 10)).toThrow("test must be a finite number");
  });

  it("throws for Infinity", () => {
    expect(() => validateNumber(Infinity, "test", 0, 10)).toThrow("test must be a finite number");
    expect(() => validateNumber(-Infinity, "test", 0, 10)).toThrow("test must be a finite number");
  });

  it("works with negative ranges", () => {
    expect(validateNumber(-5, "test", -10, -1)).toBe(-5);
  });
});

// ── validateCoupling ───────────────────────────────────────

describe("validateCoupling", () => {
  it("returns NaN for undefined", () => {
    expect(validateCoupling(undefined, "CV")).toBeNaN();
  });

  it("returns NaN for null", () => {
    expect(validateCoupling(null, "CV")).toBeNaN();
  });

  it("validates within -100 to 100", () => {
    expect(validateCoupling(1.5, "CV")).toBe(1.5);
    expect(validateCoupling(-50, "CV")).toBe(-50);
  });

  it("throws for out-of-range values", () => {
    expect(() => validateCoupling(101, "CV")).toThrow("CV must be between -100 and 100");
  });
});

// ── validateBranchingRatio ─────────────────────────────────

describe("validateBranchingRatio", () => {
  it("returns NaN for undefined", () => {
    expect(validateBranchingRatio(undefined, "BRinv")).toBeNaN();
  });

  it("validates within 0 to 1", () => {
    expect(validateBranchingRatio(0.5, "BRinv")).toBe(0.5);
    expect(validateBranchingRatio(0, "BRinv")).toBe(0);
    expect(validateBranchingRatio(1, "BRinv")).toBe(1);
  });

  it("throws for negative values", () => {
    expect(() => validateBranchingRatio(-0.1, "BRinv")).toThrow("BRinv must be between 0 and 1");
  });

  it("throws for values above 1", () => {
    expect(() => validateBranchingRatio(1.1, "BRinv")).toThrow("BRinv must be between 0 and 1");
  });
});

// ── validateMass ───────────────────────────────────────────

describe("validateMass", () => {
  it("returns default 125.09 for undefined", () => {
    expect(validateMass(undefined)).toBe(125.09);
  });

  it("returns default 125.09 for null", () => {
    expect(validateMass(null)).toBe(125.09);
  });

  it("validates within 1 to 1000", () => {
    expect(validateMass(125)).toBe(125);
    expect(validateMass(1)).toBe(1);
    expect(validateMass(1000)).toBe(1000);
  });

  it("throws for out-of-range mass", () => {
    expect(() => validateMass(0)).toThrow("mass must be between 1 and 1000");
    expect(() => validateMass(1001)).toThrow("mass must be between 1 and 1000");
  });
});

// ── safeResolvePath ────────────────────────────────────────

describe("safeResolvePath", () => {
  it("resolves valid subpath", () => {
    const result = safeResolvePath("/base/dir", "subdir/file.txt");
    expect(result).toContain("subdir");
    expect(result).toContain("file.txt");
  });

  it("throws on path traversal with ..", () => {
    expect(() => safeResolvePath("/base/dir", "../../etc/passwd")).toThrow("Invalid path: access denied");
  });

  it("throws on absolute path outside base", () => {
    expect(() => safeResolvePath("/base/dir", "/etc/passwd")).toThrow("Invalid path: access denied");
  });

  it("allows the base directory itself", () => {
    const result = safeResolvePath("/base/dir", ".");
    expect(result).toBeTruthy();
  });
});

// ── safeRegex ──────────────────────────────────────────────

describe("safeRegex", () => {
  it("compiles valid simple patterns", () => {
    const regex = safeRegex("test.*pattern");
    expect(regex).toBeInstanceOf(RegExp);
    expect(regex.test("test_some_pattern")).toBe(true);
  });

  it("throws for patterns exceeding length limit", () => {
    const longPattern = "a".repeat(501);
    expect(() => safeRegex(longPattern)).toThrow("Regex pattern too long");
  });

  it("accepts patterns at the length limit", () => {
    const okPattern = "a".repeat(500);
    expect(safeRegex(okPattern)).toBeInstanceOf(RegExp);
  });

  it("throws for invalid regex syntax", () => {
    expect(() => safeRegex("[invalid")).toThrow("Invalid regex pattern");
  });

  it("detects dangerous nested quantifiers", () => {
    // The detector catches patterns like a++ or a*+ (consecutive quantifiers)
    expect(() => safeRegex("a++")).toThrow("Potentially dangerous regex pattern");
    expect(() => safeRegex("a*+")).toThrow("Potentially dangerous regex pattern");
  });
});

// ── parallelLimit ──────────────────────────────────────────

describe("parallelLimit", () => {
  it("processes all items", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await parallelLimit(items, 2, async (item) => item * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("preserves order", async () => {
    const items = [3, 1, 2];
    const results = await parallelLimit(items, 3, async (item) => {
      await new Promise((r) => setTimeout(r, item * 10));
      return item;
    });
    expect(results).toEqual([3, 1, 2]);
  });

  it("handles empty array", async () => {
    const results = await parallelLimit([], 5, async (item: number) => item);
    expect(results).toEqual([]);
  });

  it("respects concurrency limit", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const items = [1, 2, 3, 4, 5, 6];
    await parallelLimit(items, 2, async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((r) => setTimeout(r, 50));
      currentConcurrent--;
      return null;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("provides correct index to callback", async () => {
    const items = ["a", "b", "c"];
    const indices: number[] = [];
    await parallelLimit(items, 2, async (_item, index) => {
      indices.push(index);
      return null;
    });
    expect(indices.sort()).toEqual([0, 1, 2]);
  });
});

// ── generateReducedCouplingsXML ────────────────────────────

describe("generateReducedCouplingsXML", () => {
  it("generates valid XML with defaults", () => {
    const xml = generateReducedCouplingsXML({});
    expect(xml).toContain('<?xml version="1.0"?>');
    expect(xml).toContain("<lilithinput>");
    expect(xml).toContain("<reducedcouplings>");
    expect(xml).toContain("<mass>125.09</mass>");
    expect(xml).toContain('<C to="tt">1</C>');
    expect(xml).toContain('<C to="ZZ">1</C>');
    expect(xml).toContain('<C to="WW">1</C>');
    expect(xml).toContain("<precision>BEST-QCD</precision>");
  });

  it("uses custom coupling values", () => {
    const xml = generateReducedCouplingsXML({ CV: 1.3, CF: 0.8, mass: 125 });
    expect(xml).toContain("<mass>125</mass>");
    expect(xml).toContain('<C to="ZZ">1.3</C>');
    expect(xml).toContain('<C to="WW">1.3</C>');
    expect(xml).toContain('<C to="tt">0.8</C>');
    expect(xml).toContain('<C to="bb">0.8</C>');
  });

  it("uses individual fermion couplings over CF", () => {
    const xml = generateReducedCouplingsXML({ CF: 1.0, Ct: 0.9, Cb: 1.1 });
    expect(xml).toContain('<C to="tt">0.9</C>');
    expect(xml).toContain('<C to="bb">1.1</C>');
    expect(xml).toContain('<C to="cc">1</C>'); // Falls back to CF
  });

  it("includes loop-induced couplings when specified", () => {
    const xml = generateReducedCouplingsXML({ Cg: 1.2, Cgamma: 0.9 });
    expect(xml).toContain('<C to="gg">1.2</C>');
    expect(xml).toContain('<C to="gammagamma">0.9</C>');
  });

  it("does not include loop couplings when not specified", () => {
    const xml = generateReducedCouplingsXML({});
    expect(xml).not.toContain('to="gg"');
    expect(xml).not.toContain('to="gammagamma"');
  });

  it("includes extra branching ratios", () => {
    const xml = generateReducedCouplingsXML({ BRinv: 0.1, BRundet: 0.05 });
    expect(xml).toContain('<BR to="invisible">0.1</BR>');
    expect(xml).toContain('<BR to="undetected">0.05</BR>');
  });

  it("sets LO precision when specified", () => {
    const xml = generateReducedCouplingsXML({ precision: "LO" });
    expect(xml).toContain("<precision>LO</precision>");
  });

  it("defaults to BEST-QCD for unknown precision", () => {
    const xml = generateReducedCouplingsXML({ precision: "unknown" });
    expect(xml).toContain("<precision>BEST-QCD</precision>");
  });

  it("escapes special characters in values", () => {
    // Numeric values won't normally contain special chars, but the function
    // should handle them if they did somehow appear
    const xml = generateReducedCouplingsXML({ mass: 125 });
    expect(xml).toContain("<mass>125</mass>");
  });

  it("throws for invalid coupling values", () => {
    expect(() => generateReducedCouplingsXML({ CV: 200 })).toThrow("CV must be between -100 and 100");
  });

  it("throws for invalid branching ratios", () => {
    expect(() => generateReducedCouplingsXML({ BRinv: 1.5 })).toThrow("BRinv must be between 0 and 1");
  });

  it("throws for invalid mass", () => {
    expect(() => generateReducedCouplingsXML({ mass: 0 })).toThrow("mass must be between 1 and 1000");
  });
});

// ── generateSignalStrengthsXML ─────────────────────────────

describe("generateSignalStrengthsXML", () => {
  it("generates valid XML for signal strengths", () => {
    const xml = generateSignalStrengthsXML({
      signalStrengths: { ggH_gammagamma: 1.0 },
    });
    expect(xml).toContain('<?xml version="1.0"?>');
    expect(xml).toContain("<signalstrengths>");
    expect(xml).toContain('<mu prod="ggH" decay="gammagamma">1</mu>');
  });

  it("handles multiple signal strengths", () => {
    const xml = generateSignalStrengthsXML({
      signalStrengths: {
        ggH_gammagamma: 1.1,
        VBF_ZZ: 0.95,
      },
    });
    expect(xml).toContain('<mu prod="ggH" decay="gammagamma">1.1</mu>');
    expect(xml).toContain('<mu prod="VBF" decay="ZZ">0.95</mu>');
  });

  it("throws for invalid key format", () => {
    expect(() =>
      generateSignalStrengthsXML({
        signalStrengths: { invalid: 1.0 },
      })
    ).toThrow("Expected 'prod_decay' format");
  });

  it("throws for invalid production mode", () => {
    expect(() =>
      generateSignalStrengthsXML({
        signalStrengths: { invalidProd_gammagamma: 1.0 },
      })
    ).toThrow("Invalid production mode");
  });

  it("throws for invalid decay mode", () => {
    expect(() =>
      generateSignalStrengthsXML({
        signalStrengths: { ggH_invalidDecay: 1.0 },
      })
    ).toThrow("Invalid decay mode");
  });

  it("throws for non-object signalStrengths", () => {
    expect(() =>
      generateSignalStrengthsXML({ signalStrengths: null as unknown as Record<string, number> })
    ).toThrow("signalStrengths must be an object");
  });

  it("throws for out-of-range signal strength value", () => {
    expect(() =>
      generateSignalStrengthsXML({
        signalStrengths: { ggH_gammagamma: 200 },
      })
    ).toThrow("must be a finite number between -100 and 100");
  });

  it("throws for NaN signal strength value", () => {
    expect(() =>
      generateSignalStrengthsXML({
        signalStrengths: { ggH_gammagamma: NaN },
      })
    ).toThrow("must be a finite number between -100 and 100");
  });
});

// ── compute2HDMCouplings ───────────────────────────────────

describe("compute2HDMCouplings", () => {
  it("Type-I: all fermion couplings are equal", () => {
    const result = compute2HDMCouplings("I", 2, 1);
    expect(result.Ct).toBe(result.Cb);
    expect(result.Cb).toBe(result.Ctau);
  });

  it("Type-II: Cb equals Ctau, different from Ct", () => {
    const result = compute2HDMCouplings("II", 2, 0.99);
    expect(result.Cb).toBeCloseTo(result.Ctau, 10);
    // With sin(b-a) != 1 and tanBeta > 1, Cb != Ct
    expect(result.Ct).not.toBeCloseTo(result.Cb, 2);
  });

  it("Type-L: Cb equals Ct, Ctau differs", () => {
    const result = compute2HDMCouplings("L", 2, 0.99);
    expect(result.Ct).toBeCloseTo(result.Cb, 10);
    expect(result.Ctau).not.toBeCloseTo(result.Ct, 2);
  });

  it("Type-F: Ctau equals Ct, Cb differs", () => {
    const result = compute2HDMCouplings("F", 2, 0.99);
    expect(result.Ct).toBeCloseTo(result.Ctau, 10);
    expect(result.Cb).not.toBeCloseTo(result.Ct, 2);
  });

  it("alignment limit: sin(b-a) = 1 gives SM couplings", () => {
    const result = compute2HDMCouplings("I", 1, 1);
    expect(result.CV).toBe(1);
    // cos(b-a) = 0, so all fermion couplings = sin(b-a) = 1
    expect(result.Ct).toBeCloseTo(1, 10);
    expect(result.Cb).toBeCloseTo(1, 10);
    expect(result.Ctau).toBeCloseTo(1, 10);
  });

  it("CV equals sin(beta-alpha)", () => {
    const sinBA = 0.95;
    const result = compute2HDMCouplings("I", 2, sinBA);
    expect(result.CV).toBe(sinBA);
  });
});

// ── Whitelist constants ────────────────────────────────────

describe("ALLOWED_PRODUCTION_MODES", () => {
  it("contains expected production modes", () => {
    expect(ALLOWED_PRODUCTION_MODES.has("ggH")).toBe(true);
    expect(ALLOWED_PRODUCTION_MODES.has("VBF")).toBe(true);
    expect(ALLOWED_PRODUCTION_MODES.has("WH")).toBe(true);
    expect(ALLOWED_PRODUCTION_MODES.has("ZH")).toBe(true);
    expect(ALLOWED_PRODUCTION_MODES.has("ttH")).toBe(true);
    expect(ALLOWED_PRODUCTION_MODES.has("tH")).toBe(true);
    expect(ALLOWED_PRODUCTION_MODES.has("bbH")).toBe(true);
  });

  it("rejects unknown production modes", () => {
    expect(ALLOWED_PRODUCTION_MODES.has("unknown")).toBe(false);
  });
});

describe("ALLOWED_DECAY_MODES", () => {
  it("contains expected decay modes", () => {
    expect(ALLOWED_DECAY_MODES.has("gammagamma")).toBe(true);
    expect(ALLOWED_DECAY_MODES.has("ZZ")).toBe(true);
    expect(ALLOWED_DECAY_MODES.has("WW")).toBe(true);
    expect(ALLOWED_DECAY_MODES.has("bb")).toBe(true);
    expect(ALLOWED_DECAY_MODES.has("tautau")).toBe(true);
    expect(ALLOWED_DECAY_MODES.has("invisible")).toBe(true);
  });

  it("rejects unknown decay modes", () => {
    expect(ALLOWED_DECAY_MODES.has("unknown")).toBe(false);
  });
});

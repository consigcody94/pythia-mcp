import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  parseExpMu,
  buildExpMu1D,
  buildExpMu2D,
  validateExpMu,
  extractMeasurementsFromHEPDataTable,
  summarizeHEPDataRecord,
  summarizeInspireHits,
  classifyResponse,
  type HEPDataTable,
} from "./ingest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "lilith", "data");

function walkXml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkXml(full));
    else if (entry.name.endsWith(".xml")) out.push(full);
  }
  return out;
}

describe("parseExpMu — round-trip over the real Lilith database", () => {
  const files = fs.existsSync(DATA_DIR) ? walkXml(DATA_DIR) : [];

  it("finds the bundled experimental files", () => {
    expect(files.length).toBeGreaterThan(80);
  });

  it("parses every real file without throwing and extracts core metadata", () => {
    const failures: string[] = [];
    const typeCounts: Record<string, number> = {};
    for (const f of files) {
      const xml = fs.readFileSync(f, "utf-8");
      try {
        const p = parseExpMu(xml);
        const key = `dim${p.dim}_${p.type}`;
        typeCounts[key] = (typeCounts[key] ?? 0) + 1;
        // decay is optional on <expmu>, but every file must identify its channel(s)
        // either via the decay attr or via per-eff decay tags.
        if (!p.decay && p.decays.length === 0) failures.push(`${f}: no decay anywhere`);
        if (!p.dim) failures.push(`${f}: no dim`);
        if (!p.type) failures.push(`${f}: no type`);
        if (!p.experiment) failures.push(`${f}: no experiment`);
        if (!p.source) failures.push(`${f}: no source`);
        if (p.mass === undefined) failures.push(`${f}: no mass`);
        if (p.effs.length === 0) failures.push(`${f}: no effs`);
      } catch (e) {
        failures.push(`${f}: threw ${e instanceof Error ? e.message : e}`);
      }
    }
    expect(failures).toEqual([]);
    // sanity: the database has multiple variant types
    expect(Object.keys(typeCounts).length).toBeGreaterThan(3);
  });

  it("fully models 1D type=n best-fit + asymmetric uncertainties", () => {
    const f = path.join(DATA_DIR, "ATLAS", "Run1", "HIGG-2013-08_ttH_gammagamma_s.xml");
    const p = parseExpMu(fs.readFileSync(f, "utf-8"));
    expect(p.decay).toBe("gammagamma");
    expect(p.dim).toBe(1);
    expect(p.type).toBe("n");
    expect(p.experiment).toBe("ATLAS");
    expect(p.bestfit1d).toBeCloseTo(1.6, 5);
    expect(p.uncLeft).toBeCloseTo(-1.8, 5);
    expect(p.uncRight).toBeCloseTo(2.7, 5);
    expect(p.effs).toEqual([{ prod: "ttH", axis: undefined, decay: undefined, value: 1 }]);
  });

  it("fully models 2D type=n best-fit + (a,b,c)", () => {
    const f = path.join(DATA_DIR, "ATLAS", "Run1", "HIGG-2014-06_ggH-VVH_ZZ_n68.xml");
    const p = parseExpMu(fs.readFileSync(f, "utf-8"));
    expect(p.dim).toBe(2);
    expect(p.bestfit2d).toEqual({ x: 1.638, y: 0.891 });
    expect(p.abc).toEqual({ a: 4.422, b: 0.863, c: 0.692 });
    expect(p.effs.map((e) => e.prod)).toEqual(["ggH", "VBF"]);
  });
});

describe("buildExpMu — generate valid Lilith files", () => {
  it("builds a 1D file that parses back to the same numbers", () => {
    const xml = buildExpMu1D({
      decay: "gammagamma", prod: "ggH", experiment: "ATLAS", source: "TEST-2024-01",
      sqrts: "13", mass: 125.09, mu: 1.05, uncLeft: -0.12, uncRight: 0.14,
    });
    const p = parseExpMu(xml);
    expect(p.decay).toBe("gammagamma");
    expect(p.dim).toBe(1);
    expect(p.type).toBe("n");
    expect(p.bestfit1d).toBeCloseTo(1.05, 6);
    expect(p.uncLeft).toBeCloseTo(-0.12, 6);
    expect(p.uncRight).toBeCloseTo(0.14, 6);
    expect(validateExpMu(p)).toEqual([]);
  });

  it("builds a 2D file that parses back to the same numbers", () => {
    const xml = buildExpMu2D({
      decay: "ZZ", prodX: "ggH", prodY: "VBF", experiment: "CMS", source: "TEST-2024-02",
      bestfit: { x: 1.2, y: 0.9 }, abc: { a: 3.1, b: 0.4, c: 2.2 },
    });
    const p = parseExpMu(xml);
    expect(p.bestfit2d).toEqual({ x: 1.2, y: 0.9 });
    expect(p.abc).toEqual({ a: 3.1, b: 0.4, c: 2.2 });
    expect(validateExpMu(p)).toEqual([]);
  });

  it("rejects unknown production/decay modes and non-finite numbers", () => {
    expect(() => buildExpMu1D({ decay: "gammagamma", prod: "WRONG", experiment: "A", source: "S", mu: 1, uncLeft: -1, uncRight: 1 })).toThrow();
    expect(() => buildExpMu1D({ decay: "WRONG", prod: "ggH", experiment: "A", source: "S", mu: 1, uncLeft: -1, uncRight: 1 })).toThrow();
    expect(() => buildExpMu1D({ decay: "ZZ", prod: "ggH", experiment: "A", source: "S", mu: NaN, uncLeft: -1, uncRight: 1 })).toThrow();
  });

  it("escapes XML in source/experiment to prevent injection", () => {
    const xml = buildExpMu1D({ decay: "ZZ", prod: "ggH", experiment: 'A<b>"&', source: "S", mu: 1, uncLeft: -1, uncRight: 1 });
    expect(xml).not.toContain("<b>");
    expect(xml).toContain("&lt;b&gt;");
  });
});

describe("extractMeasurementsFromHEPDataTable", () => {
  it("extracts a signal strength with asymmetric errors and qualifier-based prod/decay", () => {
    const table: HEPDataTable = {
      independent_variables: [],
      dependent_variables: [
        {
          header: { name: "Signal strength mu" },
          qualifiers: [
            { name: "Production", value: "ggH" },
            { name: "Decay", value: "gamma gamma" },
          ],
          values: [
            { value: 1.1, errors: [{ asymerror: { plus: 0.2, minus: -0.18 } }] },
          ],
        },
      ],
    };
    const { measurements, unmapped } = extractMeasurementsFromHEPDataTable(table);
    expect(measurements).toHaveLength(1);
    expect(measurements[0].prod).toBe("ggH");
    expect(measurements[0].decay).toBe("gammagamma");
    expect(measurements[0].mu).toBeCloseTo(1.1, 6);
    expect(measurements[0].uncRight).toBeCloseTo(0.2, 6);
    expect(measurements[0].uncLeft).toBeCloseTo(-0.18, 6);
    expect(unmapped).toEqual([]);
  });

  it("combines multiple symmetric error sources in quadrature", () => {
    const table: HEPDataTable = {
      dependent_variables: [
        {
          header: { name: "mu" },
          qualifiers: [{ name: "Production", value: "VBF" }, { name: "Decay", value: "ZZ" }],
          values: [{ value: 1.0, errors: [{ symerror: 0.3 }, { symerror: 0.4 }] }],
        },
      ],
    };
    const { measurements } = extractMeasurementsFromHEPDataTable(table);
    expect(measurements[0].uncRight).toBeCloseTo(0.5, 6); // sqrt(0.3^2 + 0.4^2)
    expect(measurements[0].uncLeft).toBeCloseTo(-0.5, 6);
  });

  it("flags columns that are not signal strengths and rows missing prod/decay", () => {
    const table: HEPDataTable = {
      dependent_variables: [
        { header: { name: "Cross section [pb]" }, values: [{ value: 50 }] },
        { header: { name: "signal strength" }, values: [{ value: 1.0, errors: [{ symerror: 0.1 }] }] },
      ],
    };
    const { measurements, unmapped } = extractMeasurementsFromHEPDataTable(table);
    expect(measurements).toHaveLength(1); // only the signal-strength column
    expect(unmapped.some((u) => /Cross section/.test(u))).toBe(true);
    expect(unmapped.some((u) => /missing/.test(u))).toBe(true); // no prod/decay qualifiers
  });
});

describe("summarizers & response classification", () => {
  it("summarizes a HEPData record into compact form and flags signal-strength tables", () => {
    const rec = {
      recid: 123,
      record: { inspire_id: "1753720", arxiv_id: "1909.02845", title: "Combined Higgs", collaborations: ["ATLAS"] },
      data_tables: [
        { name: "Table 1", description: "Signal strength measurements", data: { json: "/download/table/x/Table 1/json" } },
        { name: "Table 2", description: "Detector efficiencies", data: { json: "/download/table/x/Table 2/json" } },
      ],
    };
    const s = summarizeHEPDataRecord(rec);
    expect(s.inspireId).toBe("1753720");
    expect(s.tables).toHaveLength(2);
    expect(s.tables[0].looksLikeSignalStrength).toBe(true);
    expect(s.tables[1].looksLikeSignalStrength).toBe(false);
  });

  it("summarizes INSPIRE hits", () => {
    const json = { hits: { hits: [{ id: 1, metadata: { control_number: 42, titles: [{ title: "H couplings" }], arxiv_eprints: [{ value: "1234.5678" }], collaborations: [{ value: "CMS" }] } }] } };
    const hits = summarizeInspireHits(json);
    expect(hits[0].inspireId).toBe("42");
    expect(hits[0].arxiv).toBe("1234.5678");
    expect(hits[0].collaborations).toEqual(["CMS"]);
  });

  it("classifies a Cloudflare challenge vs real JSON", () => {
    expect(classifyResponse(403, "text/html; charset=UTF-8", "<!DOCTYPE html><html>cf-ray attention required</html>")).toBe("cloudflare-challenge");
    expect(classifyResponse(200, "application/json", '{"ok":true}')).toBe("json");
    expect(classifyResponse(200, "text/html", "<html><body>hi</body></html>")).toBe("html");
    expect(classifyResponse(200, "application/json", "")).toBe("empty");
  });
});

// The conversion users actually depend on: HEPData table -> measurement ->
// <expmu> -> parsed back. The two halves are tested in isolation above; this
// pins the composition the ingest_hepdata_record handler runs.
describe("extract -> build -> parse round-trip (handler composition)", () => {
  it("a ggH/gammagamma signal-strength row survives to an <expmu> with the same mu and asymmetric uncertainties", () => {
    const table: HEPDataTable = {
      dependent_variables: [{
        header: { name: "Signal strength mu" },
        qualifiers: [{ name: "Production", value: "ggH" }, { name: "Decay", value: "gamma gamma" }],
        values: [{ value: 1.1, errors: [{ asymerror: { plus: 0.2, minus: -0.18 } }] }],
      }],
    };
    const { measurements } = extractMeasurementsFromHEPDataTable(table);
    const m = measurements.find(
      (x) => x.prod && x.decay && x.uncLeft !== undefined && x.uncRight !== undefined && Number.isFinite(x.mu)
    );
    expect(m).toBeDefined();
    const xml = buildExpMu1D({
      decay: m!.decay!, prod: m!.prod!, experiment: "ATLAS", source: "ROUNDTRIP",
      mu: m!.mu, uncLeft: m!.uncLeft!, uncRight: m!.uncRight!,
    });
    const p = parseExpMu(xml);
    expect(p.decay).toBe("gammagamma");
    expect(p.bestfit1d).toBeCloseTo(1.1, 6);
    expect(p.uncLeft).toBeCloseTo(-0.18, 6);
    expect(p.uncRight).toBeCloseTo(0.2, 6);
  });

  it("a measurement with prod/decay but no uncertainties does not qualify for building (must not become a NaN file)", () => {
    const table: HEPDataTable = {
      dependent_variables: [{
        header: { name: "mu" },
        qualifiers: [{ name: "Production", value: "ggH" }, { name: "Decay", value: "ZZ" }],
        values: [{ value: 1.0 }], // no errors
      }],
    };
    const { measurements } = extractMeasurementsFromHEPDataTable(table);
    expect(measurements).toHaveLength(1);
    const m = measurements[0];
    expect(m.uncLeft).toBeUndefined();
    expect(m.uncRight).toBeUndefined();
    // mirror the handler guard in ingest_hepdata_record
    const qualifies = !!(m.prod && m.decay && m.uncLeft !== undefined && m.uncRight !== undefined && Number.isFinite(m.mu));
    expect(qualifies).toBe(false);
  });
});

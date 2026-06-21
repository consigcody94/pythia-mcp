// Generate docs/data.json for the Higgs Explorer dashboard by parsing the real
// Lilith experimental database with the project's own tested parseExpMu.
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { parseExpMu } from "../dist/ingest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "lilith", "data");
const OUT = path.join(ROOT, "docs", "data.json");

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".xml")) out.push(full);
  }
  return out;
}

const files = walk(DATA_DIR);
const catalog = [];
const measurements1D = [];
const points2D = [];

for (const f of files) {
  const rel = path.relative(DATA_DIR, f).replace(/\\/g, "/");
  const seg = rel.split("/");
  const experiment = seg[0];
  const run = seg.find((s) => /^Run\d/.test(s)) || (experiment === "Tevatron" ? "Tevatron" : "—");
  const lumi = seg.find((s) => /fb-1$/.test(s)) || "";
  let p;
  try {
    p = parseExpMu(fs.readFileSync(f, "utf-8"));
  } catch (e) {
    continue;
  }
  const prods = [...new Set(p.effs.map((e) => e.prod).filter(Boolean))];
  const entry = {
    file: rel, experiment, run, lumi,
    decay: p.decay || p.decays.join("+"),
    decays: p.decays,
    dim: p.dim, type: p.type,
    source: p.source, sourceType: p.sourceType,
    sqrts: p.sqrts, mass: p.mass,
    prods, nEff: p.effs.length,
  };
  catalog.push(entry);

  if (p.type === "n" && p.dim === 1 && p.bestfit1d !== undefined && p.uncLeft !== undefined && p.uncRight !== undefined) {
    measurements1D.push({
      experiment, run, lumi,
      decay: p.decay || p.decays.join("+"),
      prod: prods.join("+") || "comb",
      source: p.source, sqrts: p.sqrts, mass: p.mass,
      mu: p.bestfit1d, lo: p.uncLeft, hi: p.uncRight,
    });
  }
  if (p.type === "n" && p.dim === 2 && p.bestfit2d) {
    points2D.push({
      experiment, run, decay: p.decay || p.decays.join("+"),
      prodX: p.effs.find((e) => e.axis === "x")?.prod, prodY: p.effs.find((e) => e.axis === "y")?.prod,
      x: p.bestfit2d.x, y: p.bestfit2d.y, source: p.source,
    });
  }
}

function tally(key) {
  const m = {};
  for (const c of catalog) {
    const k = c[key] || "—";
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

const data = {
  generated: "static",
  totals: {
    files: catalog.length,
    measurements1D: measurements1D.length,
    points2D: points2D.length,
  },
  byExperiment: tally("experiment"),
  byRun: tally("run"),
  byDecay: tally("decay"),
  byType: tally("type"),
  measurements1D: measurements1D.sort((a, b) => a.mu - b.mu),
  points2D,
  catalog: catalog.sort((a, b) => (a.experiment + a.run + a.decay).localeCompare(b.experiment + b.run + b.decay)),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
console.log(`wrote ${OUT}`);
console.log("totals:", data.totals);
console.log("byExperiment:", data.byExperiment);
console.log("byType:", data.byType);
console.log("byDecay:", data.byDecay);

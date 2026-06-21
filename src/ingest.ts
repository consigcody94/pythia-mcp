/**
 * Data ingestion for Pythia MCP.
 *
 * Turns external Higgs measurement data (HEPData tables) into the Lilith
 * experimental `<expmu>` XML format that the likelihood engine actually
 * consumes, and parses the existing Lilith database back into structured form.
 *
 * Design note: parsing/building/extraction here are PURE functions with no
 * network access, so they are fully unit-testable and remain usable even when
 * the live HEPData/CERN endpoints are unreachable (e.g. behind a Cloudflare
 * challenge). Fetching lives in index.ts and feeds JSON into these functions.
 */
import { escapeXml } from "./utils.js";

// Production / decay modes that may appear in EXPERIMENTAL data (broader than
// the model-input whitelist in utils.ts — experimental files use VH/VVH combos).
export const EXP_PRODUCTION_MODES = new Set([
  "ggH", "VBF", "WH", "ZH", "VH", "VVH", "ttH", "tH", "bbH", "ggH-VVH", "ggH-VBF",
]);
export const EXP_DECAY_MODES = new Set([
  "gammagamma", "ZZ", "WW", "bb", "tautau", "mumu", "cc", "Zgamma", "gg", "invisible",
]);

export type ExpMuType = "n" | "p" | "f" | "vn" | "vn1" | string;

export interface ExpEff {
  prod: string;
  axis?: string;
  decay?: string;
  value: number;
}

export interface ParsedExpMu {
  /** decay attribute on <expmu>; optional — multi-decay files carry decay per <eff> */
  decay: string;
  /** distinct decay channels gathered from <eff> elements (and the decay attr) */
  decays: string[];
  dim: number;
  type: ExpMuType;
  experiment?: string;
  source?: string;
  sourceType?: string;
  sqrts?: string;
  mass?: number;
  CL?: string;
  effs: ExpEff[];
  /** 1D type="n": central best-fit signal strength */
  bestfit1d?: number;
  /** 1D type="n": asymmetric uncertainties (left is typically negative) */
  uncLeft?: number;
  uncRight?: number;
  /** 2D type="n": (x, y) best-fit */
  bestfit2d?: { x: number; y: number };
  /** 2D type="n": Gaussian parametrization a*dx^2 + c*dy^2 - 2*b*dx*dy */
  abc?: { a: number; b: number; c: number };
  /** Higher-dimensional / grid / Poisson payloads are flagged, not fully modeled */
  hasGrid?: boolean;
  hasCorrelation?: boolean;
}

// --- tiny dependency-free XML helpers (the Lilith files are simple & regular) ---

function firstTagBody(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : null;
}
function firstOpenTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*?/?>`, "i"));
  return m ? m[0] : null;
}
function attrOf(tagStr: string, name: string): string | undefined {
  const m = tagStr.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : undefined;
}
function allElements(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>|<${tag}\\b[^>]*/>`, "gi");
  return xml.match(re) || [];
}
function num(s: string | null | undefined): number | undefined {
  if (s === null || s === undefined) return undefined;
  const v = Number(String(s).trim());
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Parse a Lilith `<expmu>` experimental file into structured form.
 * Captures core metadata for every variant; fully models the common
 * type="n" (1D/2D Gaussian) payloads and flags grid/correlation payloads.
 */
export function parseExpMu(xml: string): ParsedExpMu {
  const open = firstOpenTag(xml, "expmu");
  if (!open) throw new Error("No <expmu> element found");

  const decay = attrOf(open, "decay") ?? "";
  const dim = num(attrOf(open, "dim")) ?? 0;
  const type = (attrOf(open, "type") ?? "") as ExpMuType;
  // decay is optional: multi-decay measurements omit it and tag each <eff> instead.
  if (!dim) throw new Error("<expmu> missing/invalid dim attribute");
  if (!type) throw new Error("<expmu> missing type attribute");

  const experiment = firstTagBody(xml, "experiment")?.trim();
  const sourceTag = firstOpenTag(xml, "source");
  const source = firstTagBody(xml, "source")?.trim();
  const sourceType = sourceTag ? attrOf(sourceTag, "type") : undefined;
  const sqrts = firstTagBody(xml, "sqrts")?.trim();
  const mass = num(firstTagBody(xml, "mass"));
  const CL = firstTagBody(xml, "CL")?.trim();

  const effs: ExpEff[] = allElements(xml, "eff").map((el) => {
    const bodyMatch = el.match(/>([\s\S]*?)<\/eff>/i);
    return {
      prod: attrOf(el, "prod") ?? "",
      axis: attrOf(el, "axis"),
      decay: attrOf(el, "decay"),
      value: num(bodyMatch ? bodyMatch[1] : "1") ?? 1,
    };
  });

  // Gather distinct decay channels from the decay attr and per-eff decay tags.
  const decaySet = new Set<string>();
  if (decay) decaySet.add(decay);
  for (const e of effs) if (e.decay) decaySet.add(e.decay);
  const decays = [...decaySet];
  // If no top-level decay but exactly one channel across effs, surface it as `decay`.
  const effectiveDecay = decay || (decays.length === 1 ? decays[0] : "");

  const parsed: ParsedExpMu = {
    decay: effectiveDecay, decays, dim, type, experiment, source, sourceType, sqrts, mass, CL, effs,
  };

  const bestfitBody = firstTagBody(xml, "bestfit");
  if (bestfitBody && /<x>/i.test(bestfitBody)) {
    parsed.bestfit2d = {
      x: num(firstTagBody(bestfitBody, "x")) ?? NaN,
      y: num(firstTagBody(bestfitBody, "y")) ?? NaN,
    };
  } else if (bestfitBody && num(bestfitBody) !== undefined) {
    parsed.bestfit1d = num(bestfitBody);
  }

  const paramBody = firstTagBody(xml, "param");
  if (paramBody) {
    const a = num(firstTagBody(paramBody, "a"));
    const b = num(firstTagBody(paramBody, "b"));
    const c = num(firstTagBody(paramBody, "c"));
    if (a !== undefined && b !== undefined && c !== undefined) {
      parsed.abc = { a, b, c };
    }
    const uncs = allElements(paramBody, "uncertainty");
    for (const u of uncs) {
      const side = attrOf(u, "side");
      const body = u.match(/>([\s\S]*?)<\/uncertainty>/i);
      const v = num(body ? body[1] : "");
      if (side === "left") parsed.uncLeft = v;
      else if (side === "right") parsed.uncRight = v;
    }
  }

  parsed.hasGrid = /<grid\b/i.test(xml);
  parsed.hasCorrelation = /<correlation\b|<covariance\b/i.test(xml);

  return parsed;
}

export interface Measurement1D {
  decay: string;
  prod: string;
  experiment: string;
  source: string;
  sourceType?: "published" | "preliminary";
  sqrts?: string;
  mass?: number;
  mu: number;
  uncLeft: number; // typically negative
  uncRight: number; // typically positive
}

export interface Measurement2D {
  decay: string;
  prodX: string;
  prodY: string;
  experiment: string;
  source: string;
  sourceType?: "published" | "preliminary";
  sqrts?: string;
  mass?: number;
  bestfit: { x: number; y: number };
  abc: { a: number; b: number; c: number };
}

function assertProd(prod: string): void {
  if (!EXP_PRODUCTION_MODES.has(prod)) {
    throw new Error(`Unknown production mode "${prod}" (allowed: ${[...EXP_PRODUCTION_MODES].join(", ")})`);
  }
}
function assertDecay(decay: string): void {
  if (!EXP_DECAY_MODES.has(decay)) {
    throw new Error(`Unknown decay mode "${decay}" (allowed: ${[...EXP_DECAY_MODES].join(", ")})`);
  }
}
function assertFinite(v: number, name: string): void {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a finite number`);
}

/** Build a 1D type="n" Lilith experimental file from a single signal-strength measurement. */
export function buildExpMu1D(m: Measurement1D): string {
  assertDecay(m.decay);
  assertProd(m.prod);
  assertFinite(m.mu, "mu");
  assertFinite(m.uncLeft, "uncLeft");
  assertFinite(m.uncRight, "uncRight");
  const mass = m.mass ?? 125.09;
  const sqrts = m.sqrts ?? "13";
  const sourceType = m.sourceType ?? "published";
  return `<?xml version="1.0"?>
<!-- Auto-generated by pythia-mcp ingest from ${escapeXml(m.experiment)} ${escapeXml(m.source)} -->
<expmu decay="${escapeXml(m.decay)}" dim="1" type="n">
  <experiment>${escapeXml(m.experiment)}</experiment>
  <source type="${escapeXml(sourceType)}">${escapeXml(m.source)}</source>
  <sqrts>${escapeXml(sqrts)}</sqrts>
  <mass>${escapeXml(mass)}</mass>

  <eff prod="${escapeXml(m.prod)}">1</eff>

  <bestfit>${escapeXml(m.mu)}</bestfit>

  <param>
    <uncertainty side="left">${escapeXml(m.uncLeft)}</uncertainty>
    <uncertainty side="right">${escapeXml(m.uncRight)}</uncertainty>
  </param>
</expmu>
`;
}

/** Build a 2D type="n" Lilith experimental file from a Gaussian (a,b,c) parametrization. */
export function buildExpMu2D(m: Measurement2D): string {
  assertDecay(m.decay);
  assertProd(m.prodX);
  assertProd(m.prodY);
  assertFinite(m.bestfit.x, "bestfit.x");
  assertFinite(m.bestfit.y, "bestfit.y");
  for (const k of ["a", "b", "c"] as const) assertFinite(m.abc[k], `abc.${k}`);
  const mass = m.mass ?? 125.09;
  const sqrts = m.sqrts ?? "13";
  const sourceType = m.sourceType ?? "published";
  return `<?xml version="1.0"?>
<!-- Auto-generated by pythia-mcp ingest from ${escapeXml(m.experiment)} ${escapeXml(m.source)} -->
<expmu decay="${escapeXml(m.decay)}" dim="2" type="n">
  <experiment>${escapeXml(m.experiment)}</experiment>
  <source type="${escapeXml(sourceType)}">${escapeXml(m.source)}</source>
  <sqrts>${escapeXml(sqrts)}</sqrts>
  <mass>${escapeXml(mass)}</mass>

  <eff axis="x" prod="${escapeXml(m.prodX)}">1</eff>
  <eff axis="y" prod="${escapeXml(m.prodY)}">1</eff>

  <bestfit>
    <x>${escapeXml(m.bestfit.x)}</x>
    <y>${escapeXml(m.bestfit.y)}</y>
  </bestfit>

  <param>
    <a>${escapeXml(m.abc.a)}</a>
    <b>${escapeXml(m.abc.b)}</b>
    <c>${escapeXml(m.abc.c)}</c>
  </param>
</expmu>
`;
}

/** Validate a parsed/ingested measurement; returns a list of problems (empty == valid). */
export function validateExpMu(p: ParsedExpMu): string[] {
  const problems: string[] = [];
  if (!p.decay) problems.push("missing decay");
  else if (!EXP_DECAY_MODES.has(p.decay)) problems.push(`unknown decay "${p.decay}"`);
  if (!p.dim || p.dim < 1) problems.push("dim must be >= 1");
  if (!p.type) problems.push("missing type");
  if (!p.experiment) problems.push("missing experiment");
  if (!p.source) problems.push("missing source");
  for (const e of p.effs) {
    if (!e.prod) problems.push("eff missing prod");
    else if (!EXP_PRODUCTION_MODES.has(e.prod)) problems.push(`eff has unknown prod "${e.prod}"`);
  }
  if (p.type === "n" && p.dim === 1) {
    if (p.bestfit1d === undefined || !Number.isFinite(p.bestfit1d)) problems.push("1D type=n missing finite bestfit");
    if (p.uncLeft === undefined || p.uncRight === undefined) problems.push("1D type=n missing asymmetric uncertainties");
  }
  if (p.type === "n" && p.dim === 2 && !p.abc) problems.push("2D type=n missing (a,b,c) parametrization");
  return problems;
}

// --- HEPData table extraction ---------------------------------------------

/** Minimal shape of a HEPData table JSON (the `/download/table/.../json` payload). */
export interface HEPDataValueError {
  symerror?: number | string;
  asymerror?: { plus?: number | string; minus?: number | string };
  label?: string;
}
export interface HEPDataValue {
  value?: number | string;
  errors?: HEPDataValueError[];
  low?: number | string;
  high?: number | string;
}
export interface HEPDataVariable {
  header?: { name?: string; units?: string };
  qualifiers?: Array<{ name?: string; value?: string }>;
  values?: HEPDataValue[];
}
export interface HEPDataTable {
  independent_variables?: HEPDataVariable[];
  dependent_variables?: HEPDataVariable[];
}

export interface ExtractedMeasurement {
  prod?: string;
  decay?: string;
  mu: number;
  uncLeft?: number;
  uncRight?: number;
  label?: string;
}
export interface ExtractionResult {
  measurements: ExtractedMeasurement[];
  /** Human-readable reasons a column/row was skipped — surfaced, never silently dropped. */
  unmapped: string[];
}

const SIGNAL_STRENGTH_RE = /signal[\s_-]*strength|\bmu\b|\\mu|µ|μ|\bratio\b.*\bSM\b|\\sigma.*\\sigma_\{?SM\}?/i;

function normalizeProd(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, "").toLowerCase();
  const map: Record<string, string> = {
    ggh: "ggH", ggf: "ggH", gg: "ggH",
    vbf: "VBF", qqh: "VBF",
    wh: "WH", zh: "ZH", vh: "VH", vvh: "VVH",
    tth: "ttH", th: "tH", bbh: "bbH",
  };
  return map[t] ?? (EXP_PRODUCTION_MODES.has(s) ? s : undefined);
}
function normalizeDecay(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/[\s_$\\{}^]+/g, "").toLowerCase();
  const map: Record<string, string> = {
    gammagamma: "gammagamma", "γγ": "gammagamma", aa: "gammagamma", yy: "gammagamma", diphoton: "gammagamma",
    zz: "ZZ", "zz*": "ZZ", "4l": "ZZ", zz4l: "ZZ",
    ww: "WW", "ww*": "WW",
    bb: "bb", bbbar: "bb",
    tautau: "tautau", ττ: "tautau",
    mumu: "mumu", μμ: "mumu",
    cc: "cc", zgamma: "Zgamma", zy: "Zgamma", gg: "gg", invisible: "invisible", inv: "invisible",
  };
  return map[t] ?? (EXP_DECAY_MODES.has(s) ? s : undefined);
}

function errorsToAsym(errors?: HEPDataValueError[]): { left?: number; right?: number } {
  if (!errors || !errors.length) return {};
  let left: number | undefined;
  let right: number | undefined;
  for (const e of errors) {
    if (e.asymerror) {
      const plus = num(String(e.asymerror.plus));
      const minus = num(String(e.asymerror.minus));
      // combine multiple error sources in quadrature
      right = combineQuad(right, plus);
      left = combineQuad(left, minus, true);
    } else if (e.symerror !== undefined) {
      const s = num(String(e.symerror));
      if (s !== undefined) {
        right = combineQuad(right, Math.abs(s));
        left = combineQuad(left, -Math.abs(s), true);
      }
    }
  }
  return { left, right };
}
function combineQuad(acc: number | undefined, val: number | undefined, negative = false): number | undefined {
  if (val === undefined) return acc;
  const v = Math.abs(val);
  const base = acc === undefined ? 0 : Math.abs(acc);
  const combined = Math.sqrt(base * base + v * v);
  return negative ? -combined : combined;
}

/**
 * Best-effort extraction of signal-strength measurements from a HEPData table.
 *
 * This is the core domain heuristic: which dependent variable is a signal
 * strength, and how a row maps to (production, decay). It deliberately returns
 * an `unmapped` list of reasons rather than silently emitting wrong physics.
 */
export function extractMeasurementsFromHEPDataTable(
  table: HEPDataTable,
  hint?: { decay?: string; prod?: string }
): ExtractionResult {
  const measurements: ExtractedMeasurement[] = [];
  const unmapped: string[] = [];
  const deps = table.dependent_variables ?? [];
  const indep = table.independent_variables?.[0];

  if (!deps.length) {
    return { measurements, unmapped: ["table has no dependent_variables"] };
  }

  for (const dep of deps) {
    const headerName = dep.header?.name ?? "";
    const quals = dep.qualifiers ?? [];
    const qualMap = new Map(quals.map((q) => [(q.name ?? "").toLowerCase(), q.value ?? ""]));

    const looksLikeMu =
      SIGNAL_STRENGTH_RE.test(headerName) ||
      [...qualMap.keys()].some((k) => SIGNAL_STRENGTH_RE.test(k)) ||
      [...qualMap.values()].some((v) => SIGNAL_STRENGTH_RE.test(v));
    if (!looksLikeMu) {
      unmapped.push(`column "${headerName || "(unnamed)"}" does not look like a signal strength`);
      continue;
    }

    const colDecay =
      hint?.decay ??
      normalizeDecay(qualMap.get("decay") || qualMap.get("decay channel") || qualMap.get("final state"));
    const colProd =
      hint?.prod ?? normalizeProd(qualMap.get("production") || qualMap.get("prod") || qualMap.get("process"));

    const values = dep.values ?? [];
    values.forEach((val, i) => {
      const mu = num(String(val.value));
      if (mu === undefined) {
        unmapped.push(`row ${i} of "${headerName}" has no numeric value`);
        return;
      }
      // row-level prod/decay can come from the independent variable label
      const rowLabel = indep?.values?.[i] ? String((indep.values[i] as HEPDataValue).value ?? "") : "";
      const decay = colDecay ?? normalizeDecay(rowLabel);
      const prod = colProd ?? normalizeProd(rowLabel);
      const { left, right } = errorsToAsym(val.errors);
      measurements.push({
        prod,
        decay,
        mu,
        uncLeft: left,
        uncRight: right,
        label: rowLabel || headerName,
      });
      if (!prod || !decay) {
        unmapped.push(
          `measurement "${rowLabel || headerName}" (mu=${mu}) is missing ${!prod ? "production" : ""}${!prod && !decay ? " and " : ""}${!decay ? "decay" : ""} mode — provide via hint`
        );
      }
    });
  }

  return { measurements, unmapped };
}

// --- record / search summarization & response classification ---------------

export interface RecordSummary {
  recid?: number;
  inspireId?: string;
  arxiv?: string;
  title?: string;
  collaborations?: string[];
  doi?: string;
  lastUpdated?: string;
  tables: Array<{ name?: string; description?: string; looksLikeSignalStrength: boolean; jsonUrl?: string }>;
}

export function summarizeHEPDataRecord(rec: any): RecordSummary {
  const record = rec?.record ?? {};
  const tables = (rec?.data_tables ?? []).map((t: any) => {
    const text = `${t?.name ?? ""} ${t?.description ?? ""}`;
    return {
      name: t?.name,
      description: typeof t?.description === "string" ? t.description.slice(0, 200) : undefined,
      looksLikeSignalStrength: SIGNAL_STRENGTH_RE.test(text),
      jsonUrl: t?.data?.json,
    };
  });
  return {
    recid: rec?.recid,
    inspireId: record?.inspire_id,
    arxiv: record?.arxiv_id,
    title: typeof record?.title === "string" ? record.title : record?.titles?.[0]?.title,
    collaborations: record?.collaborations,
    doi: record?.hepdata_doi,
    lastUpdated: record?.last_updated,
    tables,
  };
}

export interface InspireHitSummary {
  inspireId?: string;
  title?: string;
  arxiv?: string;
  dois?: string[];
  collaborations?: string[];
  year?: number;
}

export function summarizeInspireHits(json: any): InspireHitSummary[] {
  const hits = json?.hits?.hits ?? [];
  return hits.map((h: any) => {
    const md = h?.metadata ?? {};
    return {
      inspireId: String(md?.control_number ?? h?.id ?? ""),
      title: md?.titles?.[0]?.title,
      arxiv: md?.arxiv_eprints?.[0]?.value,
      dois: (md?.dois ?? []).map((d: any) => d?.value).filter(Boolean),
      collaborations: (md?.collaborations ?? []).map((c: any) => c?.value).filter(Boolean),
      year: md?.publication_info?.[0]?.year ?? md?.earliest_date?.slice?.(0, 4),
    };
  });
}

export type ResponseClass = "json" | "cloudflare-challenge" | "html" | "empty";

/** Classify a raw HTTP response body so callers can give actionable errors. */
export function classifyResponse(status: number, contentType: string | undefined, body: string): ResponseClass {
  if (!body || !body.trim()) return "empty";
  const ct = (contentType ?? "").toLowerCase();
  const looksHtml = ct.includes("text/html") || /^\s*<!doctype html|^\s*<html\b/i.test(body);
  if (looksHtml) {
    if (status === 403 || /cf-ray|cloudflare|cf-mitigated|just a moment|attention required/i.test(body)) {
      return "cloudflare-challenge";
    }
    return "html";
  }
  return "json";
}

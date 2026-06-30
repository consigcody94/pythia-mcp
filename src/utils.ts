/**
 * Shared utility functions for Pythia MCP Server
 */

import * as path from "path";

/**
 * Escape XML special characters to prevent XML injection
 */
export function escapeXml(unsafe: string | number): string {
  const str = String(unsafe);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Validate numeric parameter is within acceptable range
 */
export function validateNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * Validate coupling parameter (allowed range -100 to 100; SM value is 1)
 */
export function validateCoupling(value: unknown, name: string): number {
  if (value === undefined || value === null) {
    return NaN; // Will use default
  }
  return validateNumber(value, name, -100, 100);
}

/**
 * Validate branching ratio (0 to 1)
 */
export function validateBranchingRatio(value: unknown, name: string): number {
  if (value === undefined || value === null) {
    return NaN;
  }
  return validateNumber(value, name, 0, 1);
}

/**
 * Validate Higgs mass (reasonable range)
 */
export function validateMass(value: unknown): number {
  if (value === undefined || value === null) {
    return 125.09; // Default
  }
  return validateNumber(value, "mass", 1, 1000);
}

/**
 * Safely resolve and validate a path within a base directory
 * Prevents path traversal attacks
 */
export function safeResolvePath(basePath: string, userPath: string): string {
  // Normalize and resolve the path
  const resolved = path.resolve(basePath, userPath);
  const normalizedBase = path.resolve(basePath);

  // Ensure the resolved path is within the base directory
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error("Invalid path: access denied");
  }

  return resolved;
}

/**
 * Safely compile regex with error handling for ReDoS prevention
 */
export function safeRegex(pattern: string): RegExp {
  // Limit pattern length
  if (pattern.length > 500) {
    throw new Error("Regex pattern too long");
  }

  // Basic check for dangerous patterns (nested quantifiers)
  if (/(\+|\*|\{[^}]+\})\s*(\+|\*|\{[^}]+\})|(\([^)]*\))\s*(\+|\*|\{[^}]+\})\s*(\+|\*|\{[^}]+\})/.test(pattern)) {
    throw new Error("Potentially dangerous regex pattern");
  }

  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

/**
 * Run operations concurrently with a limit
 */
export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

/**
 * Coupling parameters interface
 */
export interface CouplingParams {
  mass?: number;
  CV?: number;
  CF?: number;
  Ct?: number;
  Cb?: number;
  Cc?: number;
  Ctau?: number;
  Cmu?: number;
  Cg?: number;
  Cgamma?: number;
  CZgamma?: number;
  BRinv?: number;
  BRundet?: number;
  precision?: string;
}

/**
 * Scan parameter configuration for 1D/2D scans
 */
export interface ScanParamConfig {
  name: string;
  min: number;
  max: number;
  steps: number;
}

/**
 * Signal strengths parameters interface
 */
export interface SignalStrengthParams {
  mass?: number;
  signalStrengths: Record<string, number>;
}

// Whitelist of allowed production and decay modes
export const ALLOWED_PRODUCTION_MODES = new Set(["ggH", "VBF", "WH", "ZH", "ttH", "tH", "bbH"]);
export const ALLOWED_DECAY_MODES = new Set(["gammagamma", "ZZ", "WW", "bb", "tautau", "mumu", "cc", "Zgamma", "gg", "invisible"]);

/**
 * Generate XML input for reduced couplings mode with validation and escaping
 */
export function generateReducedCouplingsXML(params: CouplingParams): string {
  // Validate and sanitize inputs
  const mass = validateMass(params.mass);
  const precision = params.precision === "LO" ? "LO" : "BEST-QCD"; // Whitelist allowed values

  // Default to SM values (1.0) if not specified, validate otherwise
  const cvVal = validateCoupling(params.CV, "CV");
  const cfVal = validateCoupling(params.CF, "CF");
  const CV = Number.isNaN(cvVal) ? 1.0 : cvVal;
  const CF = Number.isNaN(cfVal) ? 1.0 : cfVal;

  const ctVal = validateCoupling(params.Ct, "Ct");
  const cbVal = validateCoupling(params.Cb, "Cb");
  const ccVal = validateCoupling(params.Cc, "Cc");
  const ctauVal = validateCoupling(params.Ctau, "Ctau");
  const cmuVal = validateCoupling(params.Cmu, "Cmu");

  const Ct = Number.isNaN(ctVal) ? CF : ctVal;
  const Cb = Number.isNaN(cbVal) ? CF : cbVal;
  const Cc = Number.isNaN(ccVal) ? CF : ccVal;
  const Ctau = Number.isNaN(ctauVal) ? CF : ctauVal;
  const Cmu = Number.isNaN(cmuVal) ? CF : cmuVal;

  const brInvVal = validateBranchingRatio(params.BRinv, "BRinv");
  const brUndetVal = validateBranchingRatio(params.BRundet, "BRundet");
  const BRinv = Number.isNaN(brInvVal) ? 0.0 : brInvVal;
  const BRundet = Number.isNaN(brUndetVal) ? 0.0 : brUndetVal;

  // Build XML with escaped values
  let xml = `<?xml version="1.0"?>
<lilithinput>
<reducedcouplings>
  <mass>${escapeXml(mass)}</mass>

  <C to="tt">${escapeXml(Ct)}</C>
  <C to="bb">${escapeXml(Cb)}</C>
  <C to="cc">${escapeXml(Cc)}</C>
  <C to="tautau">${escapeXml(Ctau)}</C>
  <C to="mumu">${escapeXml(Cmu)}</C>
  <C to="ZZ">${escapeXml(CV)}</C>
  <C to="WW">${escapeXml(CV)}</C>
`;

  // Add loop-induced couplings if specified (validate first)
  if (params.Cg !== undefined) {
    const cg = validateCoupling(params.Cg, "Cg");
    if (!Number.isNaN(cg)) {
      xml += `  <C to="gg">${escapeXml(cg)}</C>\n`;
    }
  }
  if (params.Cgamma !== undefined) {
    const cgamma = validateCoupling(params.Cgamma, "Cgamma");
    if (!Number.isNaN(cgamma)) {
      xml += `  <C to="gammagamma">${escapeXml(cgamma)}</C>\n`;
    }
  }
  if (params.CZgamma !== undefined) {
    const czgamma = validateCoupling(params.CZgamma, "CZgamma");
    if (!Number.isNaN(czgamma)) {
      xml += `  <C to="Zgamma">${escapeXml(czgamma)}</C>\n`;
    }
  }

  xml += `
  <extraBR>
    <BR to="invisible">${escapeXml(BRinv)}</BR>
    <BR to="undetected">${escapeXml(BRundet)}</BR>
  </extraBR>

  <precision>${escapeXml(precision)}</precision>
</reducedcouplings>
</lilithinput>`;

  return xml;
}

/**
 * Generate XML input for signal strengths mode with validation and escaping
 */
export function generateSignalStrengthsXML(params: SignalStrengthParams): string {
  const mass = validateMass(params.mass);

  if (!params.signalStrengths || typeof params.signalStrengths !== "object") {
    throw new Error("signalStrengths must be an object");
  }

  let muEntries = "";
  for (const [key, value] of Object.entries(params.signalStrengths)) {
    // Validate signal strength value
    if (typeof value !== "number" || !Number.isFinite(value) || value < -100 || value > 100) {
      throw new Error(`Invalid signal strength value for ${key}: must be a finite number between -100 and 100`);
    }

    // Key format: "prod_decay" e.g., "ggH_gammagamma"
    const parts = key.split("_");
    if (parts.length !== 2) {
      throw new Error(`Invalid signal strength key format: ${key}. Expected 'prod_decay' format.`);
    }
    const [prod, decay] = parts;

    // Validate production and decay modes against whitelist
    if (!ALLOWED_PRODUCTION_MODES.has(prod)) {
      throw new Error(`Invalid production mode: ${prod}. Allowed: ${[...ALLOWED_PRODUCTION_MODES].join(", ")}`);
    }
    if (!ALLOWED_DECAY_MODES.has(decay)) {
      throw new Error(`Invalid decay mode: ${decay}. Allowed: ${[...ALLOWED_DECAY_MODES].join(", ")}`);
    }

    muEntries += `  <mu prod="${escapeXml(prod)}" decay="${escapeXml(decay)}">${escapeXml(value)}</mu>\n`;
  }

  return `<?xml version="1.0"?>
<lilithinput>
<signalstrengths>
  <mass>${escapeXml(mass)}</mass>
${muEntries}
</signalstrengths>
</lilithinput>`;
}

/**
 * Compute 2HDM reduced couplings from model parameters
 */
export function compute2HDMCouplings(
  type: "I" | "II" | "L" | "F",
  tanBeta: number,
  sinBetaMinusAlpha: number
): { CV: number; Ct: number; Cb: number; Ctau: number; cosBetaMinusAlpha: number } {
  // Clamp to avoid NaN from floating-point imprecision when sinBetaMinusAlpha ≈ ±1
  const cosBetaMinusAlpha = Math.sqrt(Math.max(0, 1 - sinBetaMinusAlpha ** 2));
  const CV = sinBetaMinusAlpha;
  let Ct: number, Cb: number, Ctau: number;

  switch (type) {
    case "I":
      Ct = sinBetaMinusAlpha + cosBetaMinusAlpha / tanBeta;
      Cb = Ct;
      Ctau = Ct;
      break;
    case "II":
      Ct = sinBetaMinusAlpha + cosBetaMinusAlpha / tanBeta;
      Cb = sinBetaMinusAlpha - cosBetaMinusAlpha * tanBeta;
      Ctau = Cb;
      break;
    case "L":
      Ct = sinBetaMinusAlpha + cosBetaMinusAlpha / tanBeta;
      Cb = Ct;
      Ctau = sinBetaMinusAlpha - cosBetaMinusAlpha * tanBeta;
      break;
    case "F":
      Ct = sinBetaMinusAlpha + cosBetaMinusAlpha / tanBeta;
      Cb = sinBetaMinusAlpha - cosBetaMinusAlpha * tanBeta;
      Ctau = Ct;
      break;
  }

  return { CV, Ct, Cb, Ctau, cosBetaMinusAlpha };
}

/**
 * Series expansion for the regularized lower incomplete gamma P(a, x).
 * Accurate (and rapidly convergent) for x < a + 1. Numerical Recipes "gser".
 */
function gammaSeriesP(a: number, x: number): number {
  if (x <= 0) return 0;
  const lnGammaA = lnGamma(a);
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < 1000; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGammaA);
}

/**
 * Continued-fraction expansion for the regularized upper incomplete gamma
 * Q(a, x) = 1 - P(a, x). Accurate for x >= a + 1. Numerical Recipes "gcf".
 *
 * Computing Q directly (rather than 1 - P) is what keeps very small upper-tail
 * probabilities — p-values for large chi-square — accurate instead of
 * collapsing to the ~1e-16 floor of (1 - P).
 */
function gammaContinuedFractionQ(a: number, x: number): number {
  const lnGammaA = lnGamma(a);
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGammaA) * h;
}

/**
 * Regularized lower incomplete gamma function P(a, x) = gamma(a, x) / Gamma(a).
 * Switches between the series and continued-fraction forms at x = a + 1 so it
 * stays accurate across the whole range (the old series-only version diverged
 * for large x). Used for the chi-square CDF.
 */
export function lowerIncompleteGamma(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) return gammaSeriesP(a, x);
  return 1 - gammaContinuedFractionQ(a, x);
}

/**
 * Regularized upper incomplete gamma Q(a, x) = Gamma(a, x) / Gamma(a) = 1 - P(a, x),
 * computed directly so deep-tail values do not underflow through (1 - P).
 */
export function upperIncompleteGamma(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) return 1 - gammaSeriesP(a, x);
  return gammaContinuedFractionQ(a, x);
}

/**
 * Log-gamma function using Lanczos approximation
 */
export function lnGamma(z: number): number {
  const g = 7;
  const coef = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = coef[0];
  for (let i = 1; i < g + 2; i++) {
    x += coef[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Chi-square CDF: P(chi2 <= x | k degrees of freedom)
 */
export function chi2CDF(x: number, k: number): number {
  if (x <= 0) return 0;
  return lowerIncompleteGamma(k / 2, x / 2);
}

/**
 * Compute p-value from chi-square statistic.
 * p = P(chi2 distribution >= observed) = Q(ndf/2, chi2/2), computed directly
 * via the upper incomplete gamma so the deep tail (large chi2) stays accurate.
 */
export function chi2PValue(chi2: number, ndf: number): number {
  if (chi2 <= 0) return 1;
  return upperIncompleteGamma(ndf / 2, chi2 / 2);
}

// ── Lilith output parsing (pure, so the handlers in index.ts stay testable) ──

/**
 * Parse the "-2log(likelihood) = <value>" line from Lilith stdout.
 * Tolerates a leading sign and scientific notation (e.g. 1.2e-05), which the
 * old [\d.]+ pattern silently mis-parsed.
 */
export function parseLilithLikelihood(output: string): number | null {
  const m = output.match(/-2log\(likelihood\)\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** Parse "Ndof = <int>" from Lilith stdout. */
export function parseLilithNdf(output: string): number | null {
  const m = output.match(/Ndof\s*=\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Parse "database version <token>" from Lilith stdout (keeps suffixes like "dev"). */
export function parseLilithDbVersion(output: string): string {
  const m = output.match(/database version\s+(\S+)/);
  return m ? m[1] : "unknown";
}

/**
 * Parse the bundled `data/version` file: first non-empty, non-comment line.
 * The file is "# comment\n<version>", so a naive trim() would return the
 * comment too — this returns just the version token.
 */
export function parseDbVersionFile(fileContent: string): string {
  const line = fileContent
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  return line ?? "unknown";
}

/** Coupling/parameter names a scan is allowed to vary (everything generateReducedCouplingsXML reads). */
export const ALLOWED_SCAN_PARAMS = new Set([
  "mass", "CV", "CF", "Ct", "Cb", "Cc", "Ctau", "Cmu", "Cg", "Cgamma", "CZgamma", "BRinv", "BRundet",
]);

/**
 * Evenly spaced scan points across [min, max] inclusive.
 * Guards steps <= 1 so it never divides by zero (which produced NaN points).
 */
export function scanPoints1D(min: number, max: number, steps: number): number[] {
  if (steps <= 1) return [min];
  const step = (max - min) / (steps - 1);
  return Array.from({ length: steps }, (_, i) => min + i * step);
}

/** Cartesian grid of scan points for a 2D scan, carrying the (i, j) indices. */
export function scanPoints2D(
  min1: number, max1: number, steps1: number,
  min2: number, max2: number, steps2: number
): Array<{ i: number; j: number; val1: number; val2: number }> {
  const xs = scanPoints1D(min1, max1, steps1);
  const ys = scanPoints1D(min2, max2, steps2);
  const points: Array<{ i: number; j: number; val1: number; val2: number }> = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length; j++) {
      points.push({ i, j, val1: xs[i], val2: ys[j] });
    }
  }
  return points;
}

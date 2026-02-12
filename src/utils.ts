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
 * Validate coupling parameter (typically -10 to 10)
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
): { CV: number; Ct: number; Cb: number; Ctau: number } {
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

  return { CV, Ct, Cb, Ctau };
}

/**
 * Approximate the regularized lower incomplete gamma function P(a, x)
 * using a series expansion. This is used for chi-square CDF computation.
 */
export function lowerIncompleteGamma(a: number, x: number): number {
  if (x < 0) return 0;
  if (x === 0) return 0;

  // Use series expansion: P(a,x) = e^(-x) * x^a * sum(x^n / gamma(a+n+1))
  const lnGammaA = lnGamma(a);
  let sum = 0;
  let term = 1 / a;
  sum = term;

  for (let n = 1; n < 200; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < 1e-14 * Math.abs(sum)) break;
  }

  const result = Math.exp(-x + a * Math.log(x) - lnGammaA) * sum;
  return Math.min(Math.max(result, 0), 1);
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
 * Compute p-value from chi-square statistic
 * p = 1 - CDF(chi2, ndf) = probability of observing a value >= chi2
 */
export function chi2PValue(chi2: number, ndf: number): number {
  return 1 - chi2CDF(chi2, ndf);
}

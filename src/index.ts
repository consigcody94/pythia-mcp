#!/usr/bin/env node

/**
 * Pythia MCP Server
 *
 * An MCP (Model Context Protocol) server providing access to Lilith,
 * a tool for constraining new physics from Higgs boson measurements at the LHC.
 *
 * Named after the Oracle of Delphi - providing answers about the Higgs sector.
 *
 * @author Cody Maryland
 * @license GPL-3.0
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import https from "https";
import crypto from "crypto";
import * as zlib from "zlib";
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
  chi2PValue,
  ALLOWED_PRODUCTION_MODES,
  ALLOWED_DECAY_MODES,
  ALLOWED_SCAN_PARAMS,
  scanPoints1D,
  scanPoints2D,
  parseLilithLikelihood,
  parseLilithNdf,
  parseLilithDbVersion,
  parseDbVersionFile,
  SM_XSEC,
  SM_BR,
  SM_TOTAL_WIDTH,
} from "./utils.js";
import type { CouplingParams, SignalStrengthParams, ScanParamConfig } from "./utils.js";
import {
  parseExpMu,
  buildExpMu1D,
  buildExpMu2D,
  validateExpMu,
  extractMeasurementsFromHEPDataTable,
  summarizeHEPDataRecord,
  summarizeInspireHits,
  classifyResponse,
} from "./ingest.js";
import type { HEPDataTable, Measurement1D } from "./ingest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to bundled Lilith installation
const LILITH_DIR = process.env.LILITH_DIR || path.join(__dirname, "..", "lilith");
const PYTHON_CMD = process.env.PYTHON_CMD || "python3";
const DATA_DIR = path.join(LILITH_DIR, "data");
// Ingested measurements are written here (never into the vendored Lilith DB).
const USER_DATA_DIR = process.env.LILITH_USER_DATA_DIR || path.join(DATA_DIR, "user");

// HEPData API configuration
const HEPDATA_API_BASE = "https://www.hepdata.net";

// CERN Open Data API configuration
const CERN_OPENDATA_API = "https://opendata.cern.ch/api/records";

// HTTP request timeout (30 seconds)
const HTTP_TIMEOUT_MS = 30000;

// Maximum concurrent operations for scans
const MAX_CONCURRENT_SCANS = 10;

// Maximum HTTP redirect depth
const MAX_REDIRECTS = 5;

// Hosts httpGetJson is allowed to talk to, including across redirects. Redirects
// are only followed to these hosts over https, so a misbehaving or open-redirect
// upstream cannot turn this server into an SSRF proxy into the local network.
const ALLOWED_FETCH_HOSTS = new Set([
  "www.hepdata.net",
  "hepdata.net",
  "opendata.cern.ch",
  "inspirehep.net",
]);

// Maximum subprocess output size (1MB)
const MAX_SUBPROCESS_OUTPUT = 1024 * 1024;

// Subprocess timeout (60 seconds)
const SUBPROCESS_TIMEOUT_MS = 60000;

// Simple in-memory cache with TTL
interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const apiCache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached<T>(key: string): T | null {
  const entry = apiCache.get(key) as CacheEntry<T> | undefined;
  if (entry && Date.now() < entry.expiry) {
    return entry.data;
  }
  apiCache.delete(key);
  return null;
}

function setCache<T>(key: string, data: T): void {
  // Limit cache size to prevent memory issues
  if (apiCache.size > 1000) {
    // Prefer evicting expired entries first
    const now = Date.now();
    let evicted = false;
    for (const [k, v] of apiCache) {
      if (now >= v.expiry) {
        apiCache.delete(k);
        evicted = true;
        break;
      }
    }
    // Fall back to removing the oldest entry by insertion order
    if (!evicted) {
      const oldestKey = apiCache.keys().next().value;
      if (oldestKey) apiCache.delete(oldestKey);
    }
  }
  apiCache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}


/**
 * Generate secure random temp filename
 */
function generateTempFilename(prefix: string): string {
  const randomId = crypto.randomBytes(16).toString("hex");
  return path.join(LILITH_DIR, `${prefix}_${randomId}.xml`);
}


interface LilithResult {
  likelihood: number;
  ndf: number;
  dbVersion: string;
  results?: Record<string, unknown>[];
  couplings?: Record<string, unknown>;
  signalStrengths?: Record<string, unknown>;
}

/**
 * Execute a Python command with Lilith
 */
async function runLilith(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_CMD, args, {
      cwd: LILITH_DIR,
      env: { ...process.env, PYTHONPATH: LILITH_DIR },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      if (stdout.length < MAX_SUBPROCESS_OUTPUT) {
        stdout += data.toString();
      }
    });

    proc.stderr.on("data", (data) => {
      if (stderr.length < MAX_SUBPROCESS_OUTPUT) {
        stderr += data.toString();
      }
    });

    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    }

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Lilith exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });

    // Kill process if it exceeds timeout
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Lilith process timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s`));
    }, SUBPROCESS_TIMEOUT_MS);

    proc.on("close", () => clearTimeout(timer));
    proc.on("error", () => clearTimeout(timer));
  });
}


// Browser-like UA + JSON Accept. Several physics data portals (notably HEPData,
// which sits behind Cloudflare) reject requests with no User-Agent.
const USER_AGENT = "pythia-mcp/1.1.1 (+https://github.com/consigcody94/pythia-mcp)";
const INSPIRE_API = "https://inspirehep.net/api";
// Cap decoded response size (HEPData records can be large but not unbounded).
const MAX_HTTP_BYTES = 16 * 1024 * 1024;

/**
 * Shared JSON fetch: sets headers, follows redirects, transparently decompresses
 * gzip/deflate, and classifies the body so a Cloudflare challenge or HTML error
 * page becomes an actionable message instead of an opaque "JSON parse failed".
 */
async function httpGetJson(
  url: string,
  opts: { cacheKey?: string; label: string; redirectCount?: number }
): Promise<unknown> {
  const { cacheKey, label } = opts;
  const redirectCount = opts.redirectCount ?? 0;
  if (redirectCount > MAX_REDIRECTS) throw new Error(`${label}: too many redirects`);
  if (cacheKey) {
    const cached = getCached<unknown>(cacheKey);
    if (cached !== null) return cached;
  }

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Encoding": "gzip, deflate" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next: URL;
          try {
            next = new URL(res.headers.location, url);
          } catch {
            reject(new Error(`${label}: invalid redirect Location header`));
            return;
          }
          if (next.protocol !== "https:" || !ALLOWED_FETCH_HOSTS.has(next.hostname)) {
            reject(new Error(`${label}: refusing redirect to disallowed host "${next.hostname}"`));
            return;
          }
          httpGetJson(next.toString(), { cacheKey, label, redirectCount: redirectCount + 1 }).then(resolve).catch(reject);
          return;
        }

        const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());

        const chunks: Buffer[] = [];
        let total = 0;
        stream.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_HTTP_BYTES) {
            req.destroy();
            reject(new Error(`${label}: response exceeded ${MAX_HTTP_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", (e) => reject(new Error(`${label}: decode error: ${e instanceof Error ? e.message : "unknown"}`)));
        stream.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const cls = classifyResponse(res.statusCode ?? 0, res.headers["content-type"], body);
          if (cls === "cloudflare-challenge") {
            reject(new Error(
              `${label}: blocked by Cloudflare bot protection (HTTP ${res.statusCode}). This endpoint is not reachable from automated/server requests. ` +
              `Use fetch_hepdata_record with a known record id, search_inspire for discovery, or pass a downloaded table JSON to ingest_hepdata_record(tableJson=...).`
            ));
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`${label}: HTTP ${res.statusCode}`));
            return;
          }
          if (cls === "html") {
            reject(new Error(`${label}: expected JSON but received an HTML page (HTTP ${res.statusCode})`));
            return;
          }
          if (cls === "empty") {
            reject(new Error(`${label}: empty response (HTTP ${res.statusCode})`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            if (cacheKey) setCache(cacheKey, parsed);
            resolve(parsed);
          } catch (e) {
            reject(new Error(`${label}: failed to parse JSON: ${e instanceof Error ? e.message : "unknown error"}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`${label}: request timeout`));
    });
  });
}

/** Fetch JSON from the HEPData API (hardened: UA, gzip, Cloudflare-aware). */
async function fetchHEPData(endpoint: string): Promise<unknown> {
  return httpGetJson(`${HEPDATA_API_BASE}${endpoint}`, { cacheKey: `hepdata:${endpoint}`, label: "HEPData API" });
}

/** Fetch JSON from the CERN Open Data portal. */
async function fetchCERNOpenData(endpoint: string): Promise<unknown> {
  const url = endpoint.startsWith("http") ? endpoint : `${CERN_OPENDATA_API}${endpoint}`;
  return httpGetJson(url, { cacheKey: `cern:${endpoint}`, label: "CERN Open Data API" });
}

/** Fetch JSON from INSPIRE-HEP (used for discovery; not behind Cloudflare). */
async function fetchInspire(endpoint: string): Promise<unknown> {
  return httpGetJson(`${INSPIRE_API}${endpoint}`, { cacheKey: `inspire:${endpoint}`, label: "INSPIRE-HEP API" });
}


/**
 * Create the MCP server
 */
const server = new Server(
  {
    name: "pythia-mcp",
    version: "1.1.1",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Core Lilith Analysis Tools
      {
        name: "compute_likelihood",
        description: "Compute the Higgs likelihood (-2 log L) for a given set of reduced couplings or signal strengths. This is the primary analysis function that compares theoretical predictions against LHC experimental data.",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["couplings", "signalstrengths"],
              description: "Analysis mode: 'couplings' for reduced coupling input, 'signalstrengths' for direct mu values"
            },
            mass: {
              type: "number",
              description: "Higgs boson mass in GeV (default: 125.09)"
            },
            // Reduced couplings parameters
            CV: {
              type: "number",
              description: "Reduced coupling to vector bosons (W, Z)"
            },
            CF: {
              type: "number",
              description: "Universal reduced coupling to fermions"
            },
            Ct: {
              type: "number",
              description: "Reduced coupling to top quark"
            },
            Cb: {
              type: "number",
              description: "Reduced coupling to bottom quark"
            },
            Cc: {
              type: "number",
              description: "Reduced coupling to charm quark"
            },
            Ctau: {
              type: "number",
              description: "Reduced coupling to tau lepton"
            },
            Cmu: {
              type: "number",
              description: "Reduced coupling to muon"
            },
            Cg: {
              type: "number",
              description: "Reduced coupling to gluons (loop-induced)"
            },
            Cgamma: {
              type: "number",
              description: "Reduced coupling to photons (loop-induced)"
            },
            CZgamma: {
              type: "number",
              description: "Reduced coupling for Z-gamma (loop-induced)"
            },
            BRinv: {
              type: "number",
              description: "Branching ratio to invisible particles (0-1)"
            },
            BRundet: {
              type: "number",
              description: "Branching ratio to undetected particles (0-1)"
            },
            precision: {
              type: "string",
              enum: ["LO", "BEST-QCD"],
              description: "QCD precision for loop calculations"
            },
            // Signal strengths parameters
            signalStrengths: {
              type: "object",
              description: "Map of 'prod_decay' to mu values (e.g., {'ggH_gammagamma': 1.0})"
            },
            expInput: {
              type: "string",
              description: "Path to experimental input list (default: data/latest.list)"
            }
          },
          required: ["mode"]
        }
      },
      {
        name: "compute_sm_likelihood",
        description: "Compute the Standard Model likelihood as a reference point. Returns -2 log L for SM couplings (all C = 1).",
        inputSchema: {
          type: "object",
          properties: {
            expInput: {
              type: "string",
              description: "Path to experimental input list"
            }
          }
        }
      },
      {
        name: "compute_pvalue",
        description: "Compute the p-value for a given model compared to the Standard Model or best-fit point.",
        inputSchema: {
          type: "object",
          properties: {
            likelihood: {
              type: "number",
              description: "The -2 log L value from compute_likelihood"
            },
            ndf: {
              type: "number",
              description: "Number of degrees of freedom"
            },
            smLikelihood: {
              type: "number",
              description: "Standard Model -2 log L (from compute_sm_likelihood). Used when reference='SM' to form delta chi-square; defaults to 0."
            },
            reference: {
              type: "string",
              enum: ["SM", "bestfit"],
              description: "Reference point for comparison. 'SM': deltaChi2 = likelihood - smLikelihood. 'bestfit': the likelihood value is treated as the delta chi-square directly."
            }
          },
          required: ["likelihood", "ndf"]
        }
      },
      {
        name: "scan_2d",
        description: "Perform a 2D parameter scan (e.g., CV-CF plane) and return likelihood values for contour plotting.",
        inputSchema: {
          type: "object",
          properties: {
            param1: {
              type: "object",
              properties: {
                name: { type: "string", description: "Parameter name (CV, CF, Ct, etc.)" },
                min: { type: "number" },
                max: { type: "number" },
                steps: { type: "number" }
              },
              required: ["name", "min", "max", "steps"]
            },
            param2: {
              type: "object",
              properties: {
                name: { type: "string" },
                min: { type: "number" },
                max: { type: "number" },
                steps: { type: "number" }
              },
              required: ["name", "min", "max", "steps"]
            },
            fixedParams: {
              type: "object",
              description: "Fixed parameter values for other couplings"
            }
          },
          required: ["param1", "param2"]
        }
      },
      {
        name: "scan_1d",
        description: "Perform a 1D parameter scan and return likelihood profile.",
        inputSchema: {
          type: "object",
          properties: {
            param: {
              type: "object",
              properties: {
                name: { type: "string" },
                min: { type: "number" },
                max: { type: "number" },
                steps: { type: "number" }
              },
              required: ["name", "min", "max", "steps"]
            },
            fixedParams: {
              type: "object",
              description: "Fixed parameter values for other couplings"
            }
          },
          required: ["param"]
        }
      },

      // Data Management Tools
      {
        name: "list_experimental_data",
        description: "List available experimental datasets in the Lilith database, organized by experiment and run period.",
        inputSchema: {
          type: "object",
          properties: {
            experiment: {
              type: "string",
              enum: ["ATLAS", "CMS", "ATLAS-CMS", "Tevatron", "all"],
              description: "Filter by experiment"
            },
            runPeriod: {
              type: "string",
              enum: ["Run1", "Run2", "all"],
              description: "Filter by LHC run period"
            }
          }
        }
      },
      {
        name: "get_dataset_info",
        description: "Get detailed information about a specific experimental dataset including best-fit values, uncertainties, and correlations.",
        inputSchema: {
          type: "object",
          properties: {
            datasetPath: {
              type: "string",
              description: "Path to dataset XML file (e.g., 'ATLAS/Run2/36fb-1/HIGG-2016-21_ggH-VBF-VH-ttH_gammagamma_vn_dim4-fitted.xml')"
            }
          },
          required: ["datasetPath"]
        }
      },
      {
        name: "search_hepdata",
        description: "Search HEPData repository for new Higgs measurement data from ATLAS and CMS.",
        inputSchema: {
          type: "object",
          properties: {
            collaboration: {
              type: "string",
              enum: ["ATLAS", "CMS"],
              description: "Filter by collaboration"
            },
            year: {
              type: "number",
              description: "Publication year (e.g., 2024)"
            },
            decay: {
              type: "string",
              description: "Decay channel (e.g., 'gammagamma', 'ZZ', 'WW', 'bb', 'tautau')"
            },
            production: {
              type: "string",
              description: "Production mode (e.g., 'ggH', 'VBF', 'VH', 'ttH')"
            },
            query: {
              type: "string",
              description: "Custom search query"
            }
          }
        }
      },
      {
        name: "fetch_hepdata_record",
        description: "Fetch detailed data from a specific HEPData record by its INSPIRE ID or record number.",
        inputSchema: {
          type: "object",
          properties: {
            inspireId: {
              type: "string",
              description: "INSPIRE HEP ID (e.g., 'ins2666787')"
            },
            recordId: {
              type: "number",
              description: "HEPData record number"
            },
            table: {
              type: "string",
              description: "Specific table name to fetch"
            },
            format: {
              type: "string",
              enum: ["json", "yaml", "csv"],
              description: "Output format"
            }
          }
        }
      },
      {
        name: "update_database",
        description: "Check for and optionally download new experimental data from HEPData to update the local Lilith database.",
        inputSchema: {
          type: "object",
          properties: {
            checkOnly: {
              type: "boolean",
              description: "Only check for updates without downloading"
            },
            collaboration: {
              type: "string",
              enum: ["ATLAS", "CMS", "all"],
              description: "Which collaboration's data to update"
            },
            since: {
              type: "string",
              description: "Only fetch data published after this date (YYYY-MM-DD)"
            }
          }
        }
      },

      // Utility Tools
      {
        name: "get_sm_predictions",
        description: "Get Standard Model predictions for Higgs cross sections and branching ratios at specified mass and energy.",
        inputSchema: {
          type: "object",
          properties: {
            mass: {
              type: "number",
              description: "Higgs boson mass in GeV"
            },
            sqrts: {
              type: "number",
              enum: [7, 8, 13, 13.6, 14],
              description: "Center-of-mass energy in TeV"
            }
          }
        }
      },
      {
        name: "convert_to_signal_strength",
        description: "Convert reduced couplings to signal strength values for all production and decay modes.",
        inputSchema: {
          type: "object",
          properties: {
            mass: { type: "number" },
            CV: { type: "number" },
            CF: { type: "number" },
            Ct: { type: "number" },
            Cb: { type: "number" },
            Ctau: { type: "number" },
            Cg: { type: "number" },
            Cgamma: { type: "number" },
            BRinv: { type: "number" }
          }
        }
      },
      {
        name: "get_version_info",
        description: "Get version information for Lilith library and experimental database.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "validate_input",
        description: "Validate XML input format for Lilith without running the full calculation.",
        inputSchema: {
          type: "object",
          properties: {
            xml: {
              type: "string",
              description: "XML input string to validate"
            }
          },
          required: ["xml"]
        }
      },

      // Physics Models
      {
        name: "analyze_2hdm",
        description: "Analyze Two-Higgs-Doublet Model (2HDM) parameters in terms of Higgs couplings. Supports Type-I, Type-II, Lepton-specific, and Flipped variants.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["I", "II", "L", "F"],
              description: "2HDM type: I, II (MSSM-like), L (lepton-specific), F (flipped)"
            },
            tanBeta: {
              type: "number",
              description: "Ratio of Higgs VEVs (tan β)"
            },
            sinBetaMinusAlpha: {
              type: "number",
              description: "sin(β - α) alignment parameter"
            },
            mass: {
              type: "number",
              description: "Light Higgs mass (default: 125.09 GeV)"
            }
          },
          required: ["type", "tanBeta", "sinBetaMinusAlpha"]
        }
      },
      {
        name: "analyze_singlet_extension",
        description: "Analyze Higgs singlet extension model with mixing between SM Higgs and singlet.",
        inputSchema: {
          type: "object",
          properties: {
            mixingAngle: {
              type: "number",
              description: "Mixing angle (radians)"
            },
            BRinv: {
              type: "number",
              description: "Invisible branching ratio from singlet decays"
            }
          },
          required: ["mixingAngle"]
        }
      },

      // CERN Open Data Tools
      {
        name: "search_cern_opendata",
        description: "Search the CERN Open Data portal for Higgs-related datasets, analysis code, and documentation.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query (default: 'Higgs')"
            },
            experiment: {
              type: "string",
              enum: ["ATLAS", "CMS", "ALICE", "LHCb"],
              description: "Filter by experiment"
            },
            type: {
              type: "string",
              enum: ["Dataset", "Software", "Documentation", "Environment"],
              description: "Type of record to search for"
            }
          }
        }
      },
      {
        name: "get_cern_opendata_record",
        description: "Retrieve detailed metadata for a specific CERN Open Data record by its record ID.",
        inputSchema: {
          type: "object",
          properties: {
            recid: {
              type: "number",
              description: "CERN Open Data record ID"
            }
          },
          required: ["recid"]
        }
      },
      {
        name: "list_cern_opendata_files",
        description: "List files available for download from a specific CERN Open Data record.",
        inputSchema: {
          type: "object",
          properties: {
            recid: {
              type: "number",
              description: "CERN Open Data record ID"
            },
            filterPattern: {
              type: "string",
              description: "Regex pattern to filter file names"
            }
          },
          required: ["recid"]
        }
      },
      {
        name: "get_latest_higgs_data",
        description: "Fetch the latest Higgs boson measurement data from both HEPData and CERN Open Data portals. Returns recent signal strength measurements, coupling measurements, and analysis results.",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              enum: ["gammagamma", "ZZ", "WW", "bb", "tautau", "mumu", "invisible", "all"],
              description: "Higgs decay channel to search for"
            },
            collaboration: {
              type: "string",
              enum: ["ATLAS", "CMS", "combined", "all"],
              description: "Which collaboration's data to retrieve"
            },
            since: {
              type: "string",
              description: "Only return data published after this date (YYYY-MM-DD)"
            }
          }
        }
      },
      {
        name: "search_inspire",
        description: "Search INSPIRE-HEP for Higgs measurement papers. Works as a discovery backend when HEPData's own search is unavailable (it sits behind Cloudflare bot protection). Returns compact records with INSPIRE id, arXiv id, title, and collaborations.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Free-text query, e.g. 'Higgs boson couplings combination ATLAS'" },
            size: { type: "number", description: "Max results (1-25, default 10)" },
            collaboration: { type: "string", enum: ["ATLAS", "CMS"], description: "Restrict to a collaboration" }
          },
          required: ["query"]
        }
      },
      {
        name: "ingest_hepdata_record",
        description: "Convert a Higgs signal-strength measurement into a Lilith experimental <expmu> file. Provide a HEPData record (recordId/inspireId) to fetch and convert, OR a downloaded HEPData table JSON via tableJson (works offline / when HEPData is Cloudflare-blocked). Returns generated <expmu> XML plus a list of measurements that could not be mapped automatically. Optionally writes the files into the user data directory.",
        inputSchema: {
          type: "object",
          properties: {
            recordId: { type: "number", description: "HEPData record number to fetch" },
            inspireId: { type: "string", description: "INSPIRE id (e.g. 'ins1753720') to fetch from HEPData" },
            tableName: { type: "string", description: "Specific table name to convert (default: first signal-strength table)" },
            tableJson: { description: "A HEPData table JSON object (or JSON string) to convert directly, bypassing the network" },
            decay: { type: "string", enum: ["gammagamma", "ZZ", "WW", "bb", "tautau", "mumu", "cc", "Zgamma", "gg", "invisible"], description: "Decay-mode hint when the table does not encode it" },
            prod: { type: "string", enum: ["ggH", "VBF", "WH", "ZH", "VH", "VVH", "ttH", "tH", "bbH"], description: "Production-mode hint when the table does not encode it" },
            experiment: { type: "string", description: "Experiment label for generated files (e.g. ATLAS, CMS)" },
            source: { type: "string", description: "Source label for generated files (e.g. HIGG-2018-28)" },
            write: { type: "boolean", description: "If true, write generated <expmu> files into the user data directory" }
          }
        }
      },
      {
        name: "parse_experimental_file",
        description: "Parse an existing Lilith experimental <expmu> file into structured form (decay, production efficiencies, best-fit signal strength, uncertainties, parametrization type). More useful than the raw XML returned by get_dataset_info.",
        inputSchema: {
          type: "object",
          properties: {
            datasetPath: { type: "string", description: "Path relative to the data directory, e.g. 'ATLAS/Run1/HIGG-2013-08_ttH_gammagamma_s.xml'" }
          },
          required: ["datasetPath"]
        }
      },
      {
        name: "build_experimental_file",
        description: "Build a valid Lilith experimental <expmu> file from explicit numbers. Supports 1D (single signal strength with asymmetric uncertainties) and 2D (Gaussian a/b/c parametrization). Useful for adding a measurement by hand or from a paper.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["1D", "2D"], description: "1D single mu, or 2D Gaussian" },
            decay: { type: "string", enum: ["gammagamma", "ZZ", "WW", "bb", "tautau", "mumu", "cc", "Zgamma", "gg", "invisible"] },
            experiment: { type: "string" },
            source: { type: "string" },
            sqrts: { type: "string", description: "Center-of-mass energy label, e.g. '13'" },
            mass: { type: "number", description: "Higgs mass in GeV (default 125.09)" },
            prod: { type: "string", description: "1D: production mode (e.g. ggH)" },
            mu: { type: "number", description: "1D: best-fit signal strength" },
            uncLeft: { type: "number", description: "1D: left (negative) uncertainty" },
            uncRight: { type: "number", description: "1D: right (positive) uncertainty" },
            prodX: { type: "string", description: "2D: x-axis production mode" },
            prodY: { type: "string", description: "2D: y-axis production mode" },
            bestfitX: { type: "number", description: "2D: x best-fit" },
            bestfitY: { type: "number", description: "2D: y best-fit" },
            a: { type: "number", description: "2D: parametrization a" },
            b: { type: "number", description: "2D: parametrization b" },
            c: { type: "number", description: "2D: parametrization c" },
            write: { type: "boolean", description: "If true, write the file into the user data directory" }
          },
          required: ["kind", "decay", "experiment", "source"]
        }
      }
    ]
  };
});

/**
 * List available resources
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = [];

  // Add experimental data lists as resources
  const dataLists = ["latest.list", "latestRun2.list", "finalRun1.list"];
  for (const list of dataLists) {
    resources.push({
      uri: `lilith://data/${list}`,
      name: list,
      description: `Experimental data list: ${list}`,
      mimeType: "text/plain"
    });
  }

  // Add database version info
  resources.push({
    uri: "lilith://version",
    name: "Database Version",
    description: "Current Lilith library and database version information",
    mimeType: "application/json"
  });

  return { resources };
});

/**
 * Read resource contents
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri.startsWith("lilith://data/")) {
    const filename = uri.replace("lilith://data/", "");

    // Validate filename to prevent path traversal
    const safePath = safeResolvePath(DATA_DIR, filename);

    try {
      const content = await fs.readFile(safePath, "utf-8");
      return {
        contents: [{ uri, mimeType: "text/plain", text: content }]
      };
    } catch {
      throw new Error(`Resource not found: ${uri}`);
    }
  }

  if (uri === "lilith://version") {
    const versionFile = path.join(DATA_DIR, "version");
    let dbVersion = "unknown";
    try {
      const content = await fs.readFile(versionFile, "utf-8");
      dbVersion = parseDbVersionFile(content);
    } catch {
      // File doesn't exist, use default
    }

    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          lilithVersion: "2.1",
          databaseVersion: dbVersion,
          pythiaMCPVersion: "1.1.1"
        }, null, 2)
      }]
    };
  }

  throw new Error(`Resource not found: ${uri}`);
});

/**
 * Whitelist of allowed experimental input files
 */
const ALLOWED_EXP_INPUT_FILES = new Set([
  "data/latest.list",
  "data/latestRun2.list",
  "data/finalRun1.list"
]);

/**
 * Safely clean up temp file
 */
async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Handle tool calls
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "compute_likelihood": {
        const params = args as unknown as CouplingParams & SignalStrengthParams & { mode: string; expInput?: string };
        let xmlInput: string;

        if (params.mode === "couplings") {
          xmlInput = generateReducedCouplingsXML(params);
        } else if (params.mode === "signalstrengths") {
          xmlInput = generateSignalStrengthsXML(params);
        } else {
          throw new Error("Invalid mode. Use 'couplings' or 'signalstrengths'");
        }

        // Use secure random temp file
        const tmpFile = generateTempFilename("input");
        await fs.writeFile(tmpFile, xmlInput);

        try {
          // Validate and whitelist experimental input file
          const expInput = params.expInput || "data/latest.list";
          if (!ALLOWED_EXP_INPUT_FILES.has(expInput)) {
            throw new Error(`Invalid experimental input file. Allowed: ${[...ALLOWED_EXP_INPUT_FILES].join(", ")}`);
          }

          const output = await runLilith([
            "run_lilith.py",
            tmpFile,
            expInput,
            "-v"
          ]);

          // Parse output
          const likelihood = parseLilithLikelihood(output);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                likelihood,
                ndf: parseLilithNdf(output),
                dbVersion: parseLilithDbVersion(output),
                rawOutput: output,
                inputXML: xmlInput,
                ...(likelihood === null
                  ? { warning: "Could not parse -2log(likelihood) from Lilith output; see rawOutput." }
                  : {})
              }, null, 2)
            }]
          };
        } finally {
          await cleanupTempFile(tmpFile);
        }
      }

      case "compute_sm_likelihood": {
        const params = args as { expInput?: string };
        const xmlInput = generateReducedCouplingsXML({
          CV: 1.0,
          CF: 1.0,
          BRinv: 0.0,
          BRundet: 0.0
        });

        const tmpFile = generateTempFilename("sm_input");
        await fs.writeFile(tmpFile, xmlInput);

        try {
          const expInput = params?.expInput || "data/latest.list";
          if (!ALLOWED_EXP_INPUT_FILES.has(expInput)) {
            throw new Error(`Invalid experimental input file. Allowed: ${[...ALLOWED_EXP_INPUT_FILES].join(", ")}`);
          }

          const output = await runLilith([
            "run_lilith.py",
            tmpFile,
            expInput
          ]);

          const smLikelihood = parseLilithLikelihood(output);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                smLikelihood,
                description: "Standard Model reference likelihood (-2 log L)",
                ...(smLikelihood === null
                  ? { warning: "Could not parse -2log(likelihood) from Lilith output.", rawOutput: output }
                  : {})
              }, null, 2)
            }]
          };
        } finally {
          await cleanupTempFile(tmpFile);
        }
      }

      case "list_experimental_data": {
        const params = args as { experiment?: string; runPeriod?: string };

        // Whitelist experiment values
        const allowedExperiments = ["ATLAS", "CMS", "ATLAS-CMS", "Tevatron", "all"];
        const experiment = params?.experiment && allowedExperiments.includes(params.experiment)
          ? params.experiment
          : "all";

        const allowedRunPeriods = ["Run1", "Run2", "all"];
        const runPeriod = params?.runPeriod && allowedRunPeriods.includes(params.runPeriod)
          ? params.runPeriod
          : "all";

        interface DatasetInfo {
          path: string;
          experiment: string;
          runPeriod: string;
        }
        const datasets: DatasetInfo[] = [];

        // Read the latest.list to get active datasets
        const latestList = await fs.readFile(path.join(DATA_DIR, "latest.list"), "utf-8");
        const lines = latestList.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;

          // Filter by experiment
          if (experiment !== "all" && !trimmed.startsWith(experiment)) continue;

          // Filter by run period
          if (runPeriod !== "all" && !trimmed.includes(runPeriod)) continue;

          datasets.push({
            path: trimmed,
            experiment: trimmed.split("/")[0],
            runPeriod: trimmed.includes("Run1") ? "Run1" : trimmed.includes("Run2") ? "Run2" : "unknown"
          });
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              totalDatasets: datasets.length,
              datasets
            }, null, 2)
          }]
        };
      }

      case "get_dataset_info": {
        const params = args as { datasetPath: string };

        if (!params.datasetPath || typeof params.datasetPath !== "string") {
          throw new Error("datasetPath is required and must be a string");
        }

        // Use safe path resolution to prevent path traversal
        const safePath = safeResolvePath(DATA_DIR, params.datasetPath);

        try {
          const content = await fs.readFile(safePath, "utf-8");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                path: params.datasetPath,
                xmlContent: content
              }, null, 2)
            }]
          };
        } catch {
          throw new Error(`Dataset not found: ${params.datasetPath}`);
        }
      }

      case "search_hepdata": {
        interface HEPDataSearchParams {
          collaboration?: "ATLAS" | "CMS";
          year?: number;
          decay?: string;
          production?: string;
          query?: string;
        }
        const params = args as HEPDataSearchParams;

        // Whitelist allowed values
        const allowedCollabs = ["ATLAS", "CMS"];
        const allowedDecays = ["gammagamma", "ZZ", "WW", "bb", "tautau", "mumu"];
        const allowedProductions = ["ggH", "VBF", "VH", "ttH"];

        // Build query with validation
        let query = params.query?.slice(0, 200) || "Higgs signal strength";
        if (params.decay && allowedDecays.includes(params.decay)) {
          query += ` ${params.decay}`;
        }
        if (params.production && allowedProductions.includes(params.production)) {
          query += ` ${params.production}`;
        }
        if (params.year && typeof params.year === "number" && params.year >= 2000 && params.year <= 2100) {
          query += ` ${params.year}`;
        }

        let searchUrl = `/search/?q=${encodeURIComponent(query)}&format=json&size=50`;
        if (params.collaboration && allowedCollabs.includes(params.collaboration)) {
          searchUrl += `&collaboration=${params.collaboration}`;
        }

        const results = await fetchHEPData(searchUrl);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }]
        };
      }

      case "fetch_hepdata_record": {
        interface HEPDataRecordParams {
          inspireId?: string;
          recordId?: number;
          table?: string;
          format?: "json" | "yaml" | "csv";
        }
        const params = args as HEPDataRecordParams;

        let recordUrl: string;
        if (params.inspireId) {
          // Validate inspireId format (should be alphanumeric with possible prefix)
          if (!/^[a-zA-Z0-9_-]+$/.test(params.inspireId)) {
            throw new Error("Invalid inspireId format");
          }
          recordUrl = `/record/${params.inspireId}?format=json`;
        } else if (params.recordId) {
          const recId = validateNumber(params.recordId, "recordId", 1, 99999999);
          recordUrl = `/record/${recId}?format=json`;
        } else {
          throw new Error("Must provide either inspireId or recordId");
        }

        if (params.table) {
          // Limit table name length
          recordUrl += `&table=${encodeURIComponent(params.table.slice(0, 100))}`;
        }

        const data = await fetchHEPData(recordUrl);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(data, null, 2)
          }]
        };
      }

      case "update_database": {
        interface UpdateDatabaseParams {
          checkOnly?: boolean;
          collaboration?: "ATLAS" | "CMS" | "all";
          since?: string;
        }
        const params = args as UpdateDatabaseParams;

        // Whitelist and validate
        const allowedCollabs = ["ATLAS", "CMS", "all"];
        const collaboration = params.collaboration && allowedCollabs.includes(params.collaboration)
          ? params.collaboration
          : "all";

        // Validate date format
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        const since = params.since && dateRegex.test(params.since) ? params.since : "2023-01-01";

        const searchResults: unknown[] = [];
        const errors: string[] = [];
        const collabs = collaboration === "all" ? ["ATLAS", "CMS"] : [collaboration];

        for (const collab of collabs) {
          const query = `Higgs signal strength ${since.slice(0, 4)}`;
          const searchUrl = `/search/?q=${encodeURIComponent(query)}&collaboration=${collab}&format=json&size=100`;

          try {
            const results = await fetchHEPData(searchUrl) as { results?: unknown[] };
            if (results.results) {
              searchResults.push(...results.results.map((r) => ({
                ...(r as object),
                collaboration: collab
              })));
            }
          } catch (e) {
            // Surface the reason instead of silently reporting "0 new records".
            errors.push(`${collab}: ${e instanceof Error ? e.message : "unknown error"}`);
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              checkOnly: params.checkOnly ?? true,
              since,
              newRecordsFound: searchResults.length,
              records: searchResults.slice(0, 20), // Return first 20
              ...(errors.length ? { errors } : {}),
              message: errors.length
                ? "HEPData search did not return results. Its /search/ endpoint is often behind Cloudflare bot protection; use search_inspire for discovery, then ingest_hepdata_record."
                : params.checkOnly
                  ? "Use checkOnly: false to download and integrate new data"
                  : "Data integration not yet implemented - manual review required"
            }, null, 2)
          }]
        };
      }

      case "get_sm_predictions": {
        interface SMPredictionsParams {
          mass?: number;
          sqrts?: 7 | 8 | 13 | 13.6 | 14;
        }
        const params = args as SMPredictionsParams;

        const mass = validateMass(params.mass);
        const allowedEnergies = [7, 8, 13, 13.6, 14];
        const sqrts = params.sqrts && allowedEnergies.includes(params.sqrts) ? params.sqrts : 13;

        const crossSections = SM_XSEC[sqrts] || SM_XSEC[13];

        const predictions = {
          mass,
          sqrts,
          crossSections: {
            ...crossSections,
            unit: "pb",
          },
          branchingRatios: { ...SM_BR },
          totalWidth: SM_TOTAL_WIDTH, // GeV
          note:
            "Cross sections: LHC Higgs XS WG Yellow Report 4 (arXiv:1610.07922) at mH = 125.0 GeV " +
            "for 7/8/13/14 TeV; 13.6 TeV is the LHCHWG Run-3 ad-interim recommendation (arXiv:2402.09955). " +
            "tH = tHq + tWH (7/8 TeV approximate). Branching ratios and total width: YR4 at mH = 125.09 GeV. " +
            "These reference values are for mH near 125 GeV and do not rescale with the 'mass' argument. " +
            "Current PDG 2024 Higgs mass world average is 125.20 +/- 0.11 GeV.",
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(predictions, null, 2)
          }]
        };
      }

      case "get_version_info": {
        const versionFile = path.join(DATA_DIR, "version");
        let dbVersion = "unknown";
        try {
          const content = await fs.readFile(versionFile, "utf-8");
          dbVersion = parseDbVersionFile(content);
        } catch {
          // File doesn't exist, use default
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              pythiaMCPVersion: "1.1.1",
              lilithVersion: "2.1",
              databaseVersion: dbVersion,
              pythonCommand: PYTHON_CMD,
              lilithDirectory: LILITH_DIR,
              dataDirectory: DATA_DIR
            }, null, 2)
          }]
        };
      }

      case "scan_1d": {
        const params = args as { param: ScanParamConfig; fixedParams?: CouplingParams };
        const { param, fixedParams = {} } = params;

        if (!param || typeof param.name !== "string") {
          throw new Error("param.name is required");
        }
        if (!ALLOWED_SCAN_PARAMS.has(param.name)) {
          throw new Error(`Invalid scan parameter "${param.name}". Allowed: ${[...ALLOWED_SCAN_PARAMS].join(", ")}`);
        }

        // Validate scan parameters (steps >= 2 so the scan spans a real range)
        validateNumber(param.min, "param.min", -100, 100);
        validateNumber(param.max, "param.max", -100, 100);
        validateNumber(param.steps, "param.steps", 2, 1000);

        if (param.min >= param.max) {
          throw new Error("param.min must be less than param.max");
        }

        // Generate scan points (scanPoints1D guards the steps<=1 divide-by-zero)
        const scanPoints = scanPoints1D(param.min, param.max, param.steps).map((value, index) => ({
          index,
          value,
        }));

        // Run scans in parallel with concurrency limit. A single failing point
        // must not abort the whole scan, so per-point errors resolve to null.
        const scanResults = await parallelLimit(
          scanPoints,
          MAX_CONCURRENT_SCANS,
          async (point) => {
            const couplings = { ...fixedParams, [param.name]: point.value };
            const xmlInput = generateReducedCouplingsXML(couplings);
            const tmpFile = generateTempFilename(`scan1d_${point.index}`);

            await fs.writeFile(tmpFile, xmlInput);
            try {
              // -v (not -s): silent mode suppresses the likelihood line entirely.
              const output = await runLilith(["run_lilith.py", tmpFile, "data/latest.list", "-v"]);
              const likelihood = parseLilithLikelihood(output);
              return likelihood === null ? null : { value: point.value, likelihood };
            } catch {
              return null;
            } finally {
              await cleanupTempFile(tmpFile);
            }
          }
        );

        // Filter out failed results
        const results = scanResults.filter((r): r is { value: number; likelihood: number } => r !== null);

        if (results.length === 0) {
          throw new Error("All scan points failed (check that Lilith runs: try compute_likelihood first)");
        }

        // Find minimum and compute delta chi2
        const minL = Math.min(...results.map(r => r.likelihood));
        const resultsWithDelta = results.map(r => ({
          ...r,
          deltaLikelihood: r.likelihood - minL
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              parameter: param.name,
              range: { min: param.min, max: param.max, steps: param.steps },
              pointsComputed: results.length,
              pointsFailed: scanPoints.length - results.length,
              minimumLikelihood: minL,
              results: resultsWithDelta
            }, null, 2)
          }]
        };
      }

      case "scan_2d": {
        const params = args as { param1: ScanParamConfig; param2: ScanParamConfig; fixedParams?: CouplingParams };
        const { param1, param2, fixedParams = {} } = params;

        if (!param1 || typeof param1.name !== "string" || !param2 || typeof param2.name !== "string") {
          throw new Error("param1.name and param2.name are required");
        }
        for (const name of [param1.name, param2.name]) {
          if (!ALLOWED_SCAN_PARAMS.has(name)) {
            throw new Error(`Invalid scan parameter "${name}". Allowed: ${[...ALLOWED_SCAN_PARAMS].join(", ")}`);
          }
        }
        if (param1.name === param2.name) {
          throw new Error("param1 and param2 must scan different parameters");
        }

        // Validate scan parameters (steps >= 2 so each axis spans a real range)
        validateNumber(param1.min, "param1.min", -100, 100);
        validateNumber(param1.max, "param1.max", -100, 100);
        validateNumber(param1.steps, "param1.steps", 2, 100);
        validateNumber(param2.min, "param2.min", -100, 100);
        validateNumber(param2.max, "param2.max", -100, 100);
        validateNumber(param2.steps, "param2.steps", 2, 100);

        if (param1.min >= param1.max || param2.min >= param2.max) {
          throw new Error("min must be less than max for both parameters");
        }

        // Generate all scan points (scanPoints2D guards the steps<=1 divide-by-zero)
        const scanPoints = scanPoints2D(
          param1.min, param1.max, param1.steps,
          param2.min, param2.max, param2.steps
        );

        // Run scans in parallel with concurrency limit. A single failing point
        // must not abort the whole scan, so per-point errors resolve to null.
        const scanResults = await parallelLimit(
          scanPoints,
          MAX_CONCURRENT_SCANS,
          async (point) => {
            const couplings = {
              ...fixedParams,
              [param1.name]: point.val1,
              [param2.name]: point.val2
            };

            const xmlInput = generateReducedCouplingsXML(couplings);
            const tmpFile = generateTempFilename(`scan2d_${point.i}_${point.j}`);

            await fs.writeFile(tmpFile, xmlInput);
            try {
              // -v (not -s): silent mode suppresses the likelihood line entirely.
              const output = await runLilith(["run_lilith.py", tmpFile, "data/latest.list", "-v"]);
              const likelihood = parseLilithLikelihood(output);
              return likelihood === null ? null : { x: point.val1, y: point.val2, likelihood };
            } catch {
              return null;
            } finally {
              await cleanupTempFile(tmpFile);
            }
          }
        );

        // Filter out failed results
        const results = scanResults.filter((r): r is { x: number; y: number; likelihood: number } => r !== null);

        if (results.length === 0) {
          throw new Error("All scan points failed (check that Lilith runs: try compute_likelihood first)");
        }

        const minL = Math.min(...results.map(r => r.likelihood));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              param1: { name: param1.name, min: param1.min, max: param1.max },
              param2: { name: param2.name, min: param2.min, max: param2.max },
              pointsComputed: results.length,
              pointsFailed: scanPoints.length - results.length,
              minimumLikelihood: minL,
              results: results.map(r => ({
                ...r,
                deltaLikelihood: r.likelihood - minL
              }))
            }, null, 2)
          }]
        };
      }

      case "analyze_2hdm": {
        interface TwoHDMParams {
          type: "I" | "II" | "L" | "F";
          tanBeta: number;
          sinBetaMinusAlpha: number;
          mass?: number;
        }
        const params = args as unknown as TwoHDMParams;

        // Validate 2HDM type
        const allowedTypes = ["I", "II", "L", "F"] as const;
        if (!allowedTypes.includes(params.type)) {
          throw new Error(`Invalid 2HDM type. Allowed: ${allowedTypes.join(", ")}`);
        }

        // Validate numeric parameters
        const tanBeta = validateNumber(params.tanBeta, "tanBeta", 0.1, 100);
        const sinBetaMinusAlpha = validateNumber(params.sinBetaMinusAlpha, "sinBetaMinusAlpha", -1, 1);
        const mass = validateMass(params.mass);

        const { CV, Ct, Cb, Ctau, cosBetaMinusAlpha } = compute2HDMCouplings(params.type, tanBeta, sinBetaMinusAlpha);

        // Compute likelihood for these couplings
        const xmlInput = generateReducedCouplingsXML({
          mass,
          CV,
          Ct,
          Cb,
          Ctau,
          Cmu: Ctau,
          Cc: Ct
        });

        const tmpFile = generateTempFilename("2hdm");
        await fs.writeFile(tmpFile, xmlInput);

        try {
          const output = await runLilith(["run_lilith.py", tmpFile, "data/latest.list", "-v"]);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                model: `2HDM Type-${params.type}`,
                parameters: {
                  tanBeta,
                  sinBetaMinusAlpha,
                  cosBetaMinusAlpha
                },
                note: "cos(beta - alpha) is taken as the non-negative root; the wrong-sign coupling region (cos(beta - alpha) < 0) is not explored by this tool.",
                reducedCouplings: {
                  CV,
                  Ct,
                  Cb,
                  Ctau
                },
                likelihood: parseLilithLikelihood(output)
              }, null, 2)
            }]
          };
        } finally {
          await cleanupTempFile(tmpFile);
        }
      }

      case "analyze_singlet_extension": {
        interface SingletParams {
          mixingAngle: number;
          BRinv?: number;
        }
        const params = args as unknown as SingletParams;

        // Validate parameters
        const mixingAngle = validateNumber(params.mixingAngle, "mixingAngle", -Math.PI, Math.PI);
        const BRinv = validateBranchingRatio(params.BRinv, "BRinv");

        // In singlet extension, all SM couplings scale by cos(mixing angle)
        const cosMix = Math.cos(mixingAngle);

        const xmlInput = generateReducedCouplingsXML({
          CV: cosMix,
          CF: cosMix,
          BRinv: Number.isNaN(BRinv) ? 0 : BRinv
        });

        const tmpFile = generateTempFilename("singlet");
        await fs.writeFile(tmpFile, xmlInput);

        try {
          const output = await runLilith(["run_lilith.py", tmpFile, "data/latest.list", "-v"]);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                model: "Higgs Singlet Extension",
                parameters: {
                  mixingAngle,
                  mixingAngleDegrees: mixingAngle * 180 / Math.PI,
                  BRinv: Number.isNaN(BRinv) ? 0 : BRinv
                },
                reducedCouplings: {
                  C: cosMix // Universal scaling
                },
                likelihood: parseLilithLikelihood(output)
              }, null, 2)
            }]
          };
        } finally {
          await cleanupTempFile(tmpFile);
        }
      }

      case "compute_pvalue": {
        interface PValueParams {
          likelihood: number;
          ndf: number;
          smLikelihood?: number;
          reference?: "SM" | "bestfit";
        }
        const params = args as unknown as PValueParams;

        // Validate parameters
        const likelihood = validateNumber(params.likelihood, "likelihood", 0, 1e10);
        const ndf = validateNumber(params.ndf, "ndf", 1, 1000);
        const reference = params.reference === "bestfit" ? "bestfit" : "SM";

        // Compute delta chi-square relative to reference
        const smLikelihood = params.smLikelihood !== undefined
          ? validateNumber(params.smLikelihood, "smLikelihood", 0, 1e10)
          : 0;
        const deltaChi2 = reference === "SM" ? likelihood - smLikelihood : likelihood;

        // Compute actual p-value from chi-square distribution
        const pValue = chi2PValue(Math.max(deltaChi2, 0), ndf);

        // Compute number of sigma
        // For a chi2 distribution, convert p-value to equivalent Gaussian sigma
        // Using the approximation: sigma = sqrt(2) * erfinv(1 - pValue)
        // Simplified: use the common thresholds
        let sigmaEquivalent: string;
        if (pValue > 0.3173) sigmaEquivalent = "< 1σ";
        else if (pValue > 0.0455) sigmaEquivalent = "1-2σ";
        else if (pValue > 0.0027) sigmaEquivalent = "2-3σ";
        else if (pValue > 6.3e-5) sigmaEquivalent = "3-4σ";
        else if (pValue > 5.7e-7) sigmaEquivalent = "4-5σ";
        else sigmaEquivalent = "> 5σ (discovery-level)";

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              deltaChi2,
              ndf,
              pValue,
              sigmaEquivalent,
              reference,
              interpretation: pValue > 0.05
                ? "Model is compatible with data at 95% CL"
                : pValue > 0.0027
                  ? "Model shows tension with data (> 2σ)"
                  : "Model is strongly disfavored by data (> 3σ)",
              thresholds: {
                "1σ (68% CL)": { "1D": 1.00, "2D": 2.30 },
                "2σ (95% CL)": { "1D": 3.84, "2D": 5.99 },
                "3σ (99.7% CL)": { "1D": 9.00, "2D": 11.83 },
              }
            }, null, 2)
          }]
        };
      }

      case "convert_to_signal_strength": {
        const params = args as CouplingParams;

        const xmlInput = generateReducedCouplingsXML(params);
        const tmpFile = generateTempFilename("convert");
        await fs.writeFile(tmpFile, xmlInput);

        const muFile = generateTempFilename("mu_output");

        try {
          const output = await runLilith([
            "run_lilith.py",
            tmpFile,
            "data/latest.list",
            "-m", muFile
          ]);

          // Read the signal strengths output
          let muContent = "";
          try {
            muContent = await fs.readFile(muFile, "utf-8");
          } catch {
            // File might not exist
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                inputCouplings: params,
                signalStrengthsXML: muContent,
                rawOutput: output
              }, null, 2)
            }]
          };
        } finally {
          await cleanupTempFile(tmpFile);
          await cleanupTempFile(muFile);
        }
      }

      case "validate_input": {
        interface ValidateInputParams {
          xml: string;
        }
        const params = args as unknown as ValidateInputParams;

        if (!params.xml || typeof params.xml !== "string") {
          throw new Error("xml is required and must be a string");
        }

        // Limit XML size to prevent DoS
        if (params.xml.length > 100000) {
          throw new Error("XML input too large (max 100KB)");
        }

        // Block DOCTYPE/ENTITY declarations: Lilith parses with lxml, which
        // resolves entities by default (XXE / billion-laughs). Lilith input
        // never needs a DTD, so refuse it outright.
        if (/<!DOCTYPE/i.test(params.xml) || /<!ENTITY/i.test(params.xml)) {
          throw new Error("XML DOCTYPE/ENTITY declarations are not allowed");
        }

        const tmpFile = generateTempFilename("validate");
        await fs.writeFile(tmpFile, params.xml);

        try {
          await runLilith(["run_lilith.py", tmpFile, "data/latest.list", "-s"]);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                valid: true,
                message: "Input XML is valid"
              }, null, 2)
            }]
          };
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : "Unknown error";
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                valid: false,
                error: errorMessage
              }, null, 2)
            }]
          };
        } finally {
          await cleanupTempFile(tmpFile);
        }
      }

      // CERN Open Data Portal Tools
      case "search_cern_opendata": {
        interface CERNSearchParams {
          query?: string;
          experiment?: "ATLAS" | "CMS" | "ALICE" | "LHCb";
          type?: "Dataset" | "Software" | "Documentation" | "Environment";
        }
        const params = args as CERNSearchParams;

        // Whitelist allowed values
        const allowedExperiments = ["ATLAS", "CMS", "ALICE", "LHCb"];
        const allowedTypes = ["Dataset", "Software", "Documentation", "Environment"];

        const queryParts: string[] = [];
        // Limit query length
        const query = params.query?.slice(0, 200) || "Higgs";
        queryParts.push(`q=${encodeURIComponent(query)}`);

        if (params.experiment && allowedExperiments.includes(params.experiment)) {
          queryParts.push(`experiment=${params.experiment}`);
        }
        if (params.type && allowedTypes.includes(params.type)) {
          queryParts.push(`type=${params.type}`);
        }
        queryParts.push("size=50");

        const results = await fetchCERNOpenData(`?${queryParts.join("&")}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "CERN Open Data Portal",
              apiUrl: "https://opendata.cern.ch",
              results
            }, null, 2)
          }]
        };
      }

      case "get_cern_opendata_record": {
        interface CERNRecordParams {
          recid: number;
        }
        const params = args as unknown as CERNRecordParams;

        const recid = validateNumber(params.recid, "recid", 1, 99999999);
        const data = await fetchCERNOpenData(`/${recid}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "CERN Open Data Portal",
              recordId: recid,
              data
            }, null, 2)
          }]
        };
      }

      case "list_cern_opendata_files": {
        interface CERNFilesParams {
          recid: number;
          filterPattern?: string;
        }
        const params = args as unknown as CERNFilesParams;

        const recid = validateNumber(params.recid, "recid", 1, 99999999);
        const data = await fetchCERNOpenData(`/${recid}`) as { metadata?: { files?: Array<{ key?: string; filename?: string; size?: number; checksum?: string; uri?: string }> } };

        let files = data?.metadata?.files || [];

        if (params.filterPattern) {
          // Use safe regex to prevent ReDoS
          const regex = safeRegex(params.filterPattern);
          files = files.filter((f) => regex.test(f.key || f.filename || ""));
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "CERN Open Data Portal",
              recordId: recid,
              totalFiles: files.length,
              files: files.map((f) => ({
                name: f.key || f.filename,
                size: f.size,
                checksum: f.checksum,
                uri: f.uri
              }))
            }, null, 2)
          }]
        };
      }

      case "get_latest_higgs_data": {
        interface LatestHiggsParams {
          channel?: "gammagamma" | "ZZ" | "WW" | "bb" | "tautau" | "mumu" | "invisible" | "all";
          collaboration?: "ATLAS" | "CMS" | "combined" | "all";
          since?: string;
        }
        const params = args as LatestHiggsParams;

        // Whitelist allowed values
        const allowedChannels = ["gammagamma", "ZZ", "WW", "bb", "tautau", "mumu", "invisible", "all"];
        const allowedCollabs = ["ATLAS", "CMS", "combined", "all"];

        const channel = params.channel && allowedChannels.includes(params.channel) ? params.channel : "all";
        const collaboration = params.collaboration && allowedCollabs.includes(params.collaboration) ? params.collaboration : "all";
        const since = params.since;

        interface HiggsSearchResults {
          hepdata: unknown[];
          cernOpenData: unknown[];
          timestamp: string;
          hepdataError?: string;
          cernOpenDataError?: string;
        }
        const results: HiggsSearchResults = {
          hepdata: [],
          cernOpenData: [],
          timestamp: new Date().toISOString()
        };

        // Search HEPData
        try {
          let hepQuery = "Higgs signal strength";
          if (channel !== "all") hepQuery += ` ${channel}`;

          const collabs = collaboration === "all" ? ["ATLAS", "CMS"] : [collaboration];

          for (const collab of collabs) {
            if (collab === "combined") continue;
            const searchUrl = `/search/?q=${encodeURIComponent(hepQuery)}&collaboration=${collab}&format=json&size=20`;
            const hepResults = await fetchHEPData(searchUrl) as { results?: unknown[] };
            if (hepResults.results) {
              results.hepdata.push(...hepResults.results.map((r) => ({
                ...(r as object),
                collaboration: collab
              })));
            }
          }
        } catch (e) {
          results.hepdataError = `HEPData search failed: ${e instanceof Error ? e.message : "unknown error"}`;
        }

        // Search CERN Open Data
        try {
          let openDataQuery = "Higgs";
          if (channel !== "all") openDataQuery += ` ${channel}`;

          const queryParts = [`q=${encodeURIComponent(openDataQuery)}`, "size=20"];
          if (collaboration !== "all" && collaboration !== "combined") {
            queryParts.push(`experiment=${collaboration}`);
          }

          const openDataResults = await fetchCERNOpenData(`?${queryParts.join("&")}`) as { hits?: { hits?: unknown[] } };
          if (openDataResults.hits?.hits) {
            results.cernOpenData = openDataResults.hits.hits;
          }
        } catch (e) {
          results.cernOpenDataError = `CERN Open Data search failed: ${e instanceof Error ? e.message : "unknown error"}`;
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query: { channel, collaboration, since },
              sources: {
                hepdata: "https://www.hepdata.net",
                cernOpenData: "https://opendata.cern.ch"
              },
              results
            }, null, 2)
          }]
        };
      }

      case "search_inspire": {
        const p = args as { query?: string; size?: number; collaboration?: string };
        if (!p.query || typeof p.query !== "string") throw new Error("query is required and must be a string");
        const size = Math.min(Math.max(Math.floor(Number(p.size) || 10), 1), 25);
        let q = p.query.slice(0, 300);
        if (p.collaboration && ["ATLAS", "CMS"].includes(p.collaboration)) {
          q += ` and collaboration ${p.collaboration}`;
        }
        const fields = "titles,arxiv_eprints,dois,collaborations,publication_info,control_number,earliest_date";
        const json = await fetchInspire(`/literature?q=${encodeURIComponent(q)}&size=${size}&fields=${fields}`);
        const hits = summarizeInspireHits(json);
        return {
          content: [{ type: "text", text: JSON.stringify({ query: q, count: hits.length, results: hits }, null, 2) }]
        };
      }

      case "parse_experimental_file": {
        const p = args as { datasetPath?: string };
        if (!p.datasetPath || typeof p.datasetPath !== "string") throw new Error("datasetPath is required and must be a string");
        const safePath = safeResolvePath(DATA_DIR, p.datasetPath);
        let content: string;
        try {
          content = await fs.readFile(safePath, "utf-8");
        } catch {
          throw new Error(`Dataset not found: ${p.datasetPath}`);
        }
        const parsed = parseExpMu(content);
        const problems = validateExpMu(parsed);
        return {
          content: [{ type: "text", text: JSON.stringify({ path: p.datasetPath, parsed, valid: problems.length === 0, problems }, null, 2) }]
        };
      }

      case "build_experimental_file": {
        const p = args as Record<string, unknown>;
        const kind = p.kind === "2D" ? "2D" : "1D";
        const experiment = String(p.experiment);
        const source = String(p.source);
        const decay = String(p.decay);
        const sqrts = p.sqrts !== undefined ? String(p.sqrts) : undefined;
        const mass = p.mass !== undefined ? validateMass(p.mass) : undefined;
        let xml: string;
        let prodLabel: string;
        if (kind === "1D") {
          const m: Measurement1D = {
            decay, prod: String(p.prod), experiment, source, sqrts, mass,
            mu: Number(p.mu), uncLeft: Number(p.uncLeft), uncRight: Number(p.uncRight),
          };
          xml = buildExpMu1D(m);
          prodLabel = m.prod;
        } else {
          xml = buildExpMu2D({
            decay, prodX: String(p.prodX), prodY: String(p.prodY), experiment, source, sqrts, mass,
            bestfit: { x: Number(p.bestfitX), y: Number(p.bestfitY) },
            abc: { a: Number(p.a), b: Number(p.b), c: Number(p.c) },
          });
          prodLabel = `${String(p.prodX)}-${String(p.prodY)}`;
        }
        let written: string | undefined;
        if (p.write) {
          await fs.mkdir(USER_DATA_DIR, { recursive: true });
          const fname = `${experiment}_${source}_${prodLabel}_${decay}_${kind === "2D" ? "n68" : "s"}.xml`.replace(/[^A-Za-z0-9_.-]/g, "_");
          const fp = path.join(USER_DATA_DIR, fname);
          await fs.writeFile(fp, xml, "utf-8");
          written = path.relative(DATA_DIR, fp).replace(/\\/g, "/");
        }
        return { content: [{ type: "text", text: JSON.stringify({ kind, xml, written }, null, 2) }] };
      }

      case "ingest_hepdata_record": {
        const p = args as Record<string, unknown>;
        let table: HEPDataTable;
        let experiment = p.experiment ? String(p.experiment) : "";
        let source = p.source ? String(p.source) : "";
        let provenance: string;

        if (p.tableJson !== undefined) {
          table = (typeof p.tableJson === "string" ? JSON.parse(p.tableJson) : p.tableJson) as HEPDataTable;
          provenance = "provided tableJson";
        } else if (p.recordId || p.inspireId) {
          const id = p.inspireId
            ? String(p.inspireId).replace(/[^a-zA-Z0-9]/g, "")
            : validateNumber(p.recordId, "recordId", 1, 99999999);
          const rec = await fetchHEPData(`/record/${id}?format=json`);
          const summary = summarizeHEPDataRecord(rec);
          if (!experiment && summary.collaborations?.length) experiment = summary.collaborations[0];
          if (!source) source = summary.inspireId ? `ins${summary.inspireId}` : String(id);
          const wanted = p.tableName
            ? summary.tables.find((t) => t.name === p.tableName)
            : summary.tables.find((t) => t.looksLikeSignalStrength) || summary.tables[0];
          if (!wanted || !wanted.jsonUrl) {
            return {
              content: [{ type: "text", text: JSON.stringify({ record: summary, message: "No signal-strength table found. Specify tableName, or download a table JSON and pass it via tableJson." }, null, 2) }]
            };
          }
          table = (await fetchHEPData(wanted.jsonUrl.replace(/^https?:\/\/[^/]+/, ""))) as HEPDataTable;
          provenance = `HEPData ${id} / ${wanted.name}`;
        } else {
          throw new Error("Provide tableJson, or recordId/inspireId to fetch from HEPData.");
        }

        const { measurements, unmapped } = extractMeasurementsFromHEPDataTable(table, {
          decay: p.decay as string | undefined,
          prod: p.prod as string | undefined,
        });

        const generated: Array<{ filename: string; xml: string }> = [];
        const skipped: string[] = [...unmapped];
        for (const m of measurements) {
          if (m.prod && m.decay && m.uncLeft !== undefined && m.uncRight !== undefined && Number.isFinite(m.mu)) {
            try {
              const xml = buildExpMu1D({
                decay: m.decay, prod: m.prod, experiment: experiment || "UNKNOWN", source: source || "ingested",
                mu: m.mu, uncLeft: m.uncLeft, uncRight: m.uncRight,
              });
              const filename = `${experiment || "X"}_${source || "ingested"}_${m.prod}_${m.decay}_s.xml`.replace(/[^A-Za-z0-9_.-]/g, "_");
              generated.push({ filename, xml });
            } catch (e) {
              skipped.push(`could not build <expmu> for ${m.label}: ${e instanceof Error ? e.message : "error"}`);
            }
          }
        }

        let written: string[] | undefined;
        if (p.write && generated.length) {
          await fs.mkdir(USER_DATA_DIR, { recursive: true });
          written = [];
          for (const g of generated) {
            const fp = path.join(USER_DATA_DIR, g.filename);
            await fs.writeFile(fp, g.xml, "utf-8");
            written.push(path.relative(DATA_DIR, fp).replace(/\\/g, "/"));
          }
          await fs.appendFile(path.join(USER_DATA_DIR, "user.list"), written.join("\n") + "\n", "utf-8");
        }

        return {
          content: [{ type: "text", text: JSON.stringify({
            provenance, experiment, source,
            measurementsFound: measurements.length,
            generatedCount: generated.length,
            generated: generated.slice(0, 20),
            unmapped: skipped.slice(0, 40),
            written,
            note: "Only 1D type=n measurements (single signal strength with asymmetric uncertainties) are auto-converted. For 2D/correlation or multi-dimensional (vn) measurements use build_experimental_file.",
          }, null, 2) }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: unknown) {
    // Don't expose stack traces to users - only return the error message
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: errorMessage
        }, null, 2)
      }],
      isError: true
    };
  }
});

/**
 * Main entry point
 */
async function main() {
  // Verify Lilith installation using sync fs for startup check
  if (!existsSync(LILITH_DIR)) {
    console.error(`Lilith directory not found: ${LILITH_DIR}`);
    console.error("Set LILITH_DIR environment variable to point to Lilith installation");
    process.exit(1);
  }

  // Check for run_lilith.py script
  const lilithScript = path.join(LILITH_DIR, "run_lilith.py");
  if (!existsSync(lilithScript)) {
    console.error(`Lilith script not found: ${lilithScript}`);
    console.error("Ensure run_lilith.py exists in the Lilith directory");
    process.exit(1);
  }

  // Verify Python is available
  try {
    const proc = spawn(PYTHON_CMD, ["--version"], { timeout: 5000 });
    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => code === 0 ? resolve() : reject());
      proc.on("error", reject);
    });
  } catch {
    console.error(`Python not found: ${PYTHON_CMD}`);
    console.error("Set PYTHON_CMD environment variable to your Python executable");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Pythia MCP Server started");
  console.error(`Lilith directory: ${LILITH_DIR}`);
  console.error(`Python command: ${PYTHON_CMD}`);
}

main().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";
  console.error("Fatal error:", errorMessage);
  process.exit(1);
});

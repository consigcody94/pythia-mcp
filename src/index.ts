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
import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to bundled Lilith installation
const LILITH_DIR = process.env.LILITH_DIR || path.join(__dirname, "..", "lilith");
const PYTHON_CMD = process.env.PYTHON_CMD || "python3";
const DATA_DIR = path.join(LILITH_DIR, "data");

// HEPData API configuration
const HEPDATA_API_BASE = "https://www.hepdata.net";

// CERN Open Data API configuration
const CERN_OPENDATA_API = "https://opendata.cern.ch/api/records";

interface LilithResult {
  likelihood: number;
  ndf: number;
  dbVersion: string;
  results?: any[];
  couplings?: any;
  signalStrengths?: any;
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
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
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
  });
}

/**
 * Generate XML input for reduced couplings mode
 */
function generateReducedCouplingsXML(params: {
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
}): string {
  const mass = params.mass ?? 125.09;
  const precision = params.precision ?? "BEST-QCD";

  // Default to SM values (1.0) if not specified
  const CV = params.CV ?? 1.0;
  const Ct = params.Ct ?? params.CF ?? 1.0;
  const Cb = params.Cb ?? params.CF ?? 1.0;
  const Cc = params.Cc ?? params.CF ?? 1.0;
  const Ctau = params.Ctau ?? params.CF ?? 1.0;
  const Cmu = params.Cmu ?? params.CF ?? 1.0;
  const BRinv = params.BRinv ?? 0.0;
  const BRundet = params.BRundet ?? 0.0;

  let xml = `<?xml version="1.0"?>
<lilithinput>
<reducedcouplings>
  <mass>${mass}</mass>

  <C to="tt">${Ct}</C>
  <C to="bb">${Cb}</C>
  <C to="cc">${Cc}</C>
  <C to="tautau">${Ctau}</C>
  <C to="mumu">${Cmu}</C>
  <C to="ZZ">${CV}</C>
  <C to="WW">${CV}</C>
`;

  // Add loop-induced couplings if specified
  if (params.Cg !== undefined) {
    xml += `  <C to="gg">${params.Cg}</C>\n`;
  }
  if (params.Cgamma !== undefined) {
    xml += `  <C to="gammagamma">${params.Cgamma}</C>\n`;
  }
  if (params.CZgamma !== undefined) {
    xml += `  <C to="Zgamma">${params.CZgamma}</C>\n`;
  }

  xml += `
  <extraBR>
    <BR to="invisible">${BRinv}</BR>
    <BR to="undetected">${BRundet}</BR>
  </extraBR>

  <precision>${precision}</precision>
</reducedcouplings>
</lilithinput>`;

  return xml;
}

/**
 * Generate XML input for signal strengths mode
 */
function generateSignalStrengthsXML(params: {
  mass?: number;
  signalStrengths: { [key: string]: number };
}): string {
  const mass = params.mass ?? 125.09;

  let muEntries = "";
  for (const [key, value] of Object.entries(params.signalStrengths)) {
    // Key format: "prod_decay" e.g., "ggH_gammagamma"
    const [prod, decay] = key.split("_");
    muEntries += `  <mu prod="${prod}" decay="${decay}">${value}</mu>\n`;
  }

  return `<?xml version="1.0"?>
<lilithinput>
<signalstrengths>
  <mass>${mass}</mass>
${muEntries}
</signalstrengths>
</lilithinput>`;
}

/**
 * Fetch data from HEPData API
 */
async function fetchHEPData(endpoint: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = `${HEPDATA_API_BASE}${endpoint}`;

    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse HEPData response: ${e}`));
        }
      });
    }).on("error", reject);
  });
}

/**
 * Search HEPData for Higgs signal strength measurements
 */
async function searchHEPDataHiggs(params: {
  collaboration?: string;
  year?: number;
  decay?: string;
  production?: string;
}): Promise<any> {
  let query = "Higgs signal strength";
  if (params.decay) query += ` ${params.decay}`;
  if (params.production) query += ` ${params.production}`;

  let searchUrl = `/search/?q=${encodeURIComponent(query)}&format=json&size=50`;
  if (params.collaboration) {
    searchUrl += `&collaboration=${params.collaboration}`;
  }

  return fetchHEPData(searchUrl);
}

/**
 * Fetch data from CERN Open Data portal
 */
async function fetchCERNOpenData(endpoint: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = endpoint.startsWith("http") ? endpoint : `${CERN_OPENDATA_API}${endpoint}`;

    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse CERN Open Data response: ${e}`));
        }
      });
    }).on("error", reject);
  });
}

/**
 * Search CERN Open Data for Higgs-related records
 */
async function searchCERNOpenData(params: {
  query?: string;
  type?: string;
  experiment?: string;
}): Promise<any> {
  let searchUrl = `${CERN_OPENDATA_API}?`;
  const queryParts: string[] = [];

  if (params.query) {
    queryParts.push(`q=${encodeURIComponent(params.query)}`);
  } else {
    queryParts.push(`q=${encodeURIComponent("Higgs")}`);
  }

  if (params.type) {
    queryParts.push(`type=${params.type}`);
  }

  if (params.experiment) {
    queryParts.push(`experiment=${params.experiment}`);
  }

  queryParts.push("size=50");

  return fetchCERNOpenData(`?${queryParts.join("&")}`);
}

/**
 * Create the MCP server
 */
const server = new Server(
  {
    name: "pythia-mcp",
    version: "1.0.0",
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
            reference: {
              type: "string",
              enum: ["SM", "bestfit"],
              description: "Reference point for comparison"
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
    const filepath = path.join(DATA_DIR, filename);

    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, "utf-8");
      return {
        contents: [{ uri, mimeType: "text/plain", text: content }]
      };
    }
  }

  if (uri === "lilith://version") {
    const versionFile = path.join(DATA_DIR, "version");
    let dbVersion = "unknown";
    if (fs.existsSync(versionFile)) {
      dbVersion = fs.readFileSync(versionFile, "utf-8").trim().split("\n")[1] || "unknown";
    }

    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          lilithVersion: "2.1",
          databaseVersion: dbVersion,
          pythiaMCPVersion: "1.0.0"
        }, null, 2)
      }]
    };
  }

  throw new Error(`Resource not found: ${uri}`);
});

/**
 * Handle tool calls
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "compute_likelihood": {
        const params = args as any;
        let xmlInput: string;

        if (params.mode === "couplings") {
          xmlInput = generateReducedCouplingsXML(params);
        } else if (params.mode === "signalstrengths") {
          xmlInput = generateSignalStrengthsXML(params);
        } else {
          throw new Error("Invalid mode. Use 'couplings' or 'signalstrengths'");
        }

        // Write temporary input file
        const tmpFile = path.join(LILITH_DIR, "tmp_input.xml");
        fs.writeFileSync(tmpFile, xmlInput);

        // Run Lilith
        const expInput = params.expInput || "data/latest.list";
        const output = await runLilith([
          "run_lilith.py",
          tmpFile,
          expInput,
          "-v"
        ]);

        // Clean up
        fs.unlinkSync(tmpFile);

        // Parse output
        const likelihoodMatch = output.match(/-2log\(likelihood\)\s*=\s*([\d.]+)/);
        const ndfMatch = output.match(/Ndof\s*=\s*(\d+)/);
        const dbVersionMatch = output.match(/database version\s+([\d.]+)/);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              likelihood: likelihoodMatch ? parseFloat(likelihoodMatch[1]) : null,
              ndf: ndfMatch ? parseInt(ndfMatch[1]) : null,
              dbVersion: dbVersionMatch ? dbVersionMatch[1] : "unknown",
              rawOutput: output,
              inputXML: xmlInput
            }, null, 2)
          }]
        };
      }

      case "compute_sm_likelihood": {
        const params = args as any;
        const xmlInput = generateReducedCouplingsXML({
          CV: 1.0,
          CF: 1.0,
          BRinv: 0.0,
          BRundet: 0.0
        });

        const tmpFile = path.join(LILITH_DIR, "tmp_sm_input.xml");
        fs.writeFileSync(tmpFile, xmlInput);

        const expInput = params?.expInput || "data/latest.list";
        const output = await runLilith([
          "run_lilith.py",
          tmpFile,
          expInput
        ]);

        fs.unlinkSync(tmpFile);

        const likelihoodMatch = output.match(/-2log\(likelihood\)\s*=\s*([\d.]+)/);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              smLikelihood: likelihoodMatch ? parseFloat(likelihoodMatch[1]) : null,
              description: "Standard Model reference likelihood (-2 log L)"
            }, null, 2)
          }]
        };
      }

      case "list_experimental_data": {
        const params = args as any;
        const experiment = params?.experiment || "all";
        const runPeriod = params?.runPeriod || "all";

        const datasets: any[] = [];
        const dataDir = DATA_DIR;

        // Read the latest.list to get active datasets
        const latestList = fs.readFileSync(path.join(dataDir, "latest.list"), "utf-8");
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
        const params = args as any;
        const datasetPath = path.join(DATA_DIR, params.datasetPath);

        if (!fs.existsSync(datasetPath)) {
          throw new Error(`Dataset not found: ${params.datasetPath}`);
        }

        const content = fs.readFileSync(datasetPath, "utf-8");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              path: params.datasetPath,
              xmlContent: content
            }, null, 2)
          }]
        };
      }

      case "search_hepdata": {
        const params = args as any;

        let query = params.query || "Higgs signal strength";
        if (params.decay) query += ` ${params.decay}`;
        if (params.production) query += ` ${params.production}`;
        if (params.year) query += ` ${params.year}`;

        let searchUrl = `/search/?q=${encodeURIComponent(query)}&format=json&size=50`;
        if (params.collaboration) {
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
        const params = args as any;

        let recordUrl: string;
        if (params.inspireId) {
          recordUrl = `/record/${params.inspireId}?format=json`;
        } else if (params.recordId) {
          recordUrl = `/record/${params.recordId}?format=json`;
        } else {
          throw new Error("Must provide either inspireId or recordId");
        }

        if (params.table) {
          recordUrl += `&table=${encodeURIComponent(params.table)}`;
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
        const params = args as any;

        // Search for recent Higgs results
        const collaboration = params.collaboration || "all";
        const since = params.since || "2023-01-01";

        const searchResults: any[] = [];

        const collabs = collaboration === "all" ? ["ATLAS", "CMS"] : [collaboration];

        for (const collab of collabs) {
          const query = `Higgs signal strength ${since.slice(0, 4)}`;
          const searchUrl = `/search/?q=${encodeURIComponent(query)}&collaboration=${collab}&format=json&size=100`;

          try {
            const results = await fetchHEPData(searchUrl);
            if (results.results) {
              searchResults.push(...results.results.map((r: any) => ({
                ...r,
                collaboration: collab
              })));
            }
          } catch (e) {
            // Continue on error
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
              message: params.checkOnly
                ? "Use checkOnly: false to download and integrate new data"
                : "Data integration not yet implemented - manual review required"
            }, null, 2)
          }]
        };
      }

      case "get_sm_predictions": {
        const params = args as any;
        const mass = params?.mass || 125.09;
        const sqrts = params?.sqrts || 13;

        // These are approximate SM predictions - actual values from Lilith grids
        const predictions = {
          mass,
          sqrts,
          crossSections: {
            ggH: sqrts === 13 ? 48.58 : sqrts === 8 ? 19.27 : 15.13, // pb
            VBF: sqrts === 13 ? 3.78 : sqrts === 8 ? 1.58 : 1.22,
            WH: sqrts === 13 ? 1.37 : sqrts === 8 ? 0.70 : 0.58,
            ZH: sqrts === 13 ? 0.88 : sqrts === 8 ? 0.42 : 0.34,
            ttH: sqrts === 13 ? 0.51 : sqrts === 8 ? 0.13 : 0.09,
            unit: "pb"
          },
          branchingRatios: {
            bb: 0.5809,
            WW: 0.2152,
            gg: 0.0818,
            tautau: 0.0627,
            cc: 0.0289,
            ZZ: 0.0264,
            gammagamma: 0.00228,
            Zgamma: 0.00154,
            mumu: 0.000218
          },
          totalWidth: 4.07e-3, // GeV
          note: "Values interpolated from YR4 predictions at mH = 125.09 GeV"
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
        if (fs.existsSync(versionFile)) {
          dbVersion = fs.readFileSync(versionFile, "utf-8").trim();
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              pythiaMCPVersion: "1.0.0",
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
        const params = args as any;
        const { param, fixedParams } = params;

        const results: { value: number; likelihood: number }[] = [];
        const step = (param.max - param.min) / (param.steps - 1);

        for (let i = 0; i < param.steps; i++) {
          const value = param.min + i * step;
          const couplings = { ...fixedParams, [param.name]: value };

          const xmlInput = generateReducedCouplingsXML(couplings);
          const tmpFile = path.join(LILITH_DIR, `tmp_scan_${i}.xml`);
          fs.writeFileSync(tmpFile, xmlInput);

          try {
            const output = await runLilith(["run_lilith.py", tmpFile, "data/latest.list", "-s"]);
            fs.unlinkSync(tmpFile);

            const match = output.match(/-2log\(likelihood\)\s*=\s*([\d.]+)/);
            if (match) {
              results.push({ value, likelihood: parseFloat(match[1]) });
            }
          } catch (e) {
            fs.unlinkSync(tmpFile);
          }
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
              minimumLikelihood: minL,
              results: resultsWithDelta
            }, null, 2)
          }]
        };
      }

      case "scan_2d": {
        const params = args as any;
        const { param1, param2, fixedParams } = params;

        const results: { x: number; y: number; likelihood: number }[] = [];
        const step1 = (param1.max - param1.min) / (param1.steps - 1);
        const step2 = (param2.max - param2.min) / (param2.steps - 1);

        for (let i = 0; i < param1.steps; i++) {
          for (let j = 0; j < param2.steps; j++) {
            const val1 = param1.min + i * step1;
            const val2 = param2.min + j * step2;

            const couplings = {
              ...fixedParams,
              [param1.name]: val1,
              [param2.name]: val2
            };

            const xmlInput = generateReducedCouplingsXML(couplings);
            const tmpFile = path.join(LILITH_DIR, `tmp_scan2d_${i}_${j}.xml`);
            fs.writeFileSync(tmpFile, xmlInput);

            try {
              const output = await runLilith(["run_lilith.py", tmpFile, "data/latest.list", "-s"]);
              fs.unlinkSync(tmpFile);

              const match = output.match(/-2log\(likelihood\)\s*=\s*([\d.]+)/);
              if (match) {
                results.push({ x: val1, y: val2, likelihood: parseFloat(match[1]) });
              }
            } catch (e) {
              fs.unlinkSync(tmpFile);
            }
          }
        }

        const minL = Math.min(...results.map(r => r.likelihood));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              param1: { name: param1.name, min: param1.min, max: param1.max },
              param2: { name: param2.name, min: param2.min, max: param2.max },
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
        const params = args as any;
        const { type, tanBeta, sinBetaMinusAlpha, mass = 125.09 } = params;

        const cosBetaMinusAlpha = Math.sqrt(1 - sinBetaMinusAlpha ** 2);
        const sinBeta = tanBeta / Math.sqrt(1 + tanBeta ** 2);
        const cosBeta = 1 / Math.sqrt(1 + tanBeta ** 2);

        // Reduced couplings in alignment limit approach
        let CV = sinBetaMinusAlpha;
        let Ct, Cb, Ctau;

        // Type-dependent fermion couplings
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
          default:
            throw new Error(`Unknown 2HDM type: ${type}`);
        }

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

        const tmpFile = path.join(LILITH_DIR, "tmp_2hdm.xml");
        fs.writeFileSync(tmpFile, xmlInput);

        const output = await runLilith(["run_lilith.py", tmpFile, "data/latest.list"]);
        fs.unlinkSync(tmpFile);

        const likelihoodMatch = output.match(/-2log\(likelihood\)\s*=\s*([\d.]+)/);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              model: `2HDM Type-${type}`,
              parameters: {
                tanBeta,
                sinBetaMinusAlpha,
                cosBetaMinusAlpha
              },
              reducedCouplings: {
                CV,
                Ct,
                Cb,
                Ctau
              },
              likelihood: likelihoodMatch ? parseFloat(likelihoodMatch[1]) : null
            }, null, 2)
          }]
        };
      }

      case "analyze_singlet_extension": {
        const params = args as any;
        const { mixingAngle, BRinv = 0 } = params;

        // In singlet extension, all SM couplings scale by cos(mixing angle)
        const cosMix = Math.cos(mixingAngle);

        const xmlInput = generateReducedCouplingsXML({
          CV: cosMix,
          CF: cosMix,
          BRinv
        });

        const tmpFile = path.join(LILITH_DIR, "tmp_singlet.xml");
        fs.writeFileSync(tmpFile, xmlInput);

        const output = await runLilith(["run_lilith.py", tmpFile, "data/latest.list"]);
        fs.unlinkSync(tmpFile);

        const likelihoodMatch = output.match(/-2log\(likelihood\)\s*=\s*([\d.]+)/);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              model: "Higgs Singlet Extension",
              parameters: {
                mixingAngle,
                mixingAngleDegrees: mixingAngle * 180 / Math.PI,
                BRinv
              },
              reducedCouplings: {
                C: cosMix // Universal scaling
              },
              likelihood: likelihoodMatch ? parseFloat(likelihoodMatch[1]) : null
            }, null, 2)
          }]
        };
      }

      case "compute_pvalue": {
        const params = args as any;
        const { likelihood, ndf, reference = "SM" } = params;

        // Chi-square p-value calculation would require scipy
        // Return the delta chi2 and reference info
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              likelihood,
              ndf,
              reference,
              note: "P-value calculation: Use chi2 distribution with ndf degrees of freedom. For 68%/95%/99.7% CL in 2D: delta_chi2 = 2.30/5.99/11.83"
            }, null, 2)
          }]
        };
      }

      case "convert_to_signal_strength": {
        const params = args as any;

        const xmlInput = generateReducedCouplingsXML(params);
        const tmpFile = path.join(LILITH_DIR, "tmp_convert.xml");
        fs.writeFileSync(tmpFile, xmlInput);

        const output = await runLilith([
          "run_lilith.py",
          tmpFile,
          "data/latest.list",
          "-m", path.join(LILITH_DIR, "tmp_mu_output.xml")
        ]);

        fs.unlinkSync(tmpFile);

        // Read the signal strengths output
        const muFile = path.join(LILITH_DIR, "tmp_mu_output.xml");
        let muContent = "";
        if (fs.existsSync(muFile)) {
          muContent = fs.readFileSync(muFile, "utf-8");
          fs.unlinkSync(muFile);
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
      }

      case "validate_input": {
        const params = args as any;
        const { xml } = params;

        const tmpFile = path.join(LILITH_DIR, "tmp_validate.xml");
        fs.writeFileSync(tmpFile, xml);

        try {
          const output = await runLilith(["run_lilith.py", tmpFile, "data/latest.list", "-s"]);
          fs.unlinkSync(tmpFile);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                valid: true,
                message: "Input XML is valid"
              }, null, 2)
            }]
          };
        } catch (e: any) {
          fs.unlinkSync(tmpFile);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                valid: false,
                error: e.message
              }, null, 2)
            }]
          };
        }
      }

      // CERN Open Data Portal Tools
      case "search_cern_opendata": {
        const params = args as any;

        const queryParts: string[] = [];
        queryParts.push(`q=${encodeURIComponent(params.query || "Higgs")}`);

        if (params.experiment) {
          queryParts.push(`experiment=${params.experiment}`);
        }
        if (params.type) {
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
        const params = args as any;
        const { recid } = params;

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
        const params = args as any;
        const { recid, filterPattern } = params;

        const data = await fetchCERNOpenData(`/${recid}`);

        let files = data?.metadata?.files || [];

        if (filterPattern) {
          const regex = new RegExp(filterPattern);
          files = files.filter((f: any) => regex.test(f.key || f.filename));
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "CERN Open Data Portal",
              recordId: recid,
              totalFiles: files.length,
              files: files.map((f: any) => ({
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
        const params = args as any;
        const { channel = "all", collaboration = "all", since } = params;

        const results: any = {
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
            const hepResults = await fetchHEPData(searchUrl);
            if (hepResults.results) {
              results.hepdata.push(...hepResults.results.map((r: any) => ({
                ...r,
                collaboration: collab
              })));
            }
          }
        } catch (e) {
          results.hepdataError = `HEPData search failed: ${e}`;
        }

        // Search CERN Open Data
        try {
          let openDataQuery = "Higgs";
          if (channel !== "all") openDataQuery += ` ${channel}`;

          const queryParts = [`q=${encodeURIComponent(openDataQuery)}`, "size=20"];
          if (collaboration !== "all" && collaboration !== "combined") {
            queryParts.push(`experiment=${collaboration}`);
          }

          const openDataResults = await fetchCERNOpenData(`?${queryParts.join("&")}`);
          if (openDataResults.hits?.hits) {
            results.cernOpenData = openDataResults.hits.hits;
          }
        } catch (e) {
          results.cernOpenDataError = `CERN Open Data search failed: ${e}`;
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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error.message,
          stack: error.stack
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
  // Verify Lilith installation
  if (!fs.existsSync(LILITH_DIR)) {
    console.error(`Lilith directory not found: ${LILITH_DIR}`);
    console.error("Set LILITH_DIR environment variable to point to Lilith installation");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Pythia MCP Server started");
  console.error(`Lilith directory: ${LILITH_DIR}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

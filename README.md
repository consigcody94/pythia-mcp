<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d1117,50:161b22,100:1a1e2e&height=220&section=header&text=PYTHIA&fontSize=90&fontColor=c9d1d9&animation=fadeIn&fontAlignY=32&desc=Higgs%20Boson%20Phenomenology%20%E2%80%A2%20MCP%20Server&descAlignY=56&descSize=16&descColor=8b949e"/>

<br/>

[![CI](https://github.com/consigcody94/pythia-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/consigcody94/pythia-mcp/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-Compatible-00d4aa?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA4LTggOHoiLz48L3N2Zz4=)](https://modelcontextprotocol.io)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Python](https://img.shields.io/badge/Python-3.6+-3776ab?style=flat-square&logo=python&logoColor=white)](https://www.python.org)

<br/>

**Constrain beyond-Standard-Model physics from LHC Higgs measurements — directly from Claude.**

Pythia wraps the [Lilith](https://github.com/sabinekraml/Lilith-2) library as an MCP server,<br/>
giving AI assistants access to 28 particle physics analysis tools.

<br/>

[Getting Started](#getting-started) &ensp;&bull;&ensp; [Tools](#tools) &ensp;&bull;&ensp; [Examples](#examples) &ensp;&bull;&ensp; [Architecture](#architecture) &ensp;&bull;&ensp; [Citations](#citations)

</div>

<br/>

> [!IMPORTANT]
> **Lilith Attribution** &mdash; All physics calculations are performed by [**Lilith-2**](https://github.com/sabinekraml/Lilith-2), developed by Sabine Kraml and collaborators at LPSC Grenoble. Pythia is an MCP interface layer. Please [star the original repo](https://github.com/sabinekraml/Lilith-2) and cite the Lilith papers in any research output.

<br/>

## Overview

The 125 GeV Higgs boson, discovered at CERN in 2012, is the cornerstone of electroweak symmetry breaking. Precision measurements of its couplings to other particles provide one of the most powerful probes for physics beyond the Standard Model (BSM).

Pythia bridges this frontier physics with conversational AI. Instead of manually running Python scripts and parsing XML, you ask Claude:

> *"What constraints does LHC data place on a Type-II two-Higgs-doublet model with tan(beta) = 2?"*

Under the hood, Pythia generates validated XML input, invokes Lilith's likelihood engine against the full ATLAS + CMS dataset, and returns structured results &mdash; all through the [Model Context Protocol](https://modelcontextprotocol.io).

<br/>

## Getting Started

### Prerequisites

| Requirement | Version |
|:--|:--|
| Node.js | >= 18.0 |
| Python | >= 3.6 |
| NumPy + SciPy | latest |

### Install

```bash
git clone https://github.com/consigcody94/pythia-mcp.git
cd pythia-mcp
npm install
npm run build
pip install numpy scipy
```

### Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pythia": {
      "command": "node",
      "args": ["/path/to/pythia-mcp/dist/index.js"],
      "env": {
        "LILITH_DIR": "/path/to/pythia-mcp/lilith",
        "PYTHON_CMD": "python3"
      }
    }
  }
}
```

### Verify

```bash
cd lilith
python run_lilith.py userinput/example_couplings.xml
```

You should see a `-2log(likelihood)` value printed to stdout.

<br/>

## Tools

Pythia exposes **28 tools** organized into four categories.

### Core Analysis

| Tool | Description |
|:--|:--|
| `compute_likelihood` | Compute -2 log(L) for any BSM coupling or signal-strength scenario |
| `compute_sm_likelihood` | Standard Model reference likelihood |
| `compute_pvalue` | P-value for model comparison against SM or best-fit |
| `scan_1d` | 1D parameter scan with likelihood profile (parallel execution) |
| `scan_2d` | 2D parameter scan for contour plots (parallel execution) |

### Data Management

| Tool | Description |
|:--|:--|
| `list_experimental_data` | Browse Lilith's built-in ATLAS/CMS/Tevatron datasets |
| `get_dataset_info` | Inspect a specific experimental XML measurement file |
| `search_hepdata` | Query the [HEPData](https://www.hepdata.net) repository for new results |
| `fetch_hepdata_record` | Download a HEPData record by INSPIRE ID or record number |
| `update_database` | Check HEPData for new signal-strength publications |
| `get_latest_higgs_data` | Aggregate latest measurements from HEPData + CERN Open Data |

### Physics Models

| Tool | Description |
|:--|:--|
| `analyze_2hdm` | Two-Higgs-Doublet Model (Types I, II, Lepton-specific, Flipped) |
| `analyze_singlet_extension` | Higgs singlet extension with mixing angle |
| `get_sm_predictions` | SM cross sections and branching ratios at 7-14 TeV |
| `convert_to_signal_strength` | Convert reduced couplings to signal-strength values |
| `validate_input` | Validate Lilith XML input without running the full calculation |
| `get_version_info` | Library and database version information |

### CERN Open Data

| Tool | Description |
|:--|:--|
| `search_cern_opendata` | Search the CERN Open Data portal |
| `get_cern_opendata_record` | Retrieve record metadata by ID |
| `list_cern_opendata_files` | List downloadable files for a record |

<br/>

## Examples

### Check SM Consistency

> *"Compute the Standard Model likelihood and tell me if the Higgs data is consistent with the SM."*

### Test Modified Couplings

> *"Calculate the likelihood for C_t = 0.9, C_V = 1.1"*

```json
{ "mode": "couplings", "Ct": 0.9, "CV": 1.1 }
```

### Two-Higgs-Doublet Model

> *"Analyze a Type-II 2HDM with tan(beta) = 2 and sin(beta - alpha) = 0.99"*

```json
{ "type": "II", "tanBeta": 2, "sinBetaMinusAlpha": 0.99 }
```

### Parameter Scan

> *"Scan the C_V&ndash;C_F plane from 0.8 to 1.2"*

```json
{
  "param1": { "name": "CV", "min": 0.8, "max": 1.2, "steps": 50 },
  "param2": { "name": "CF", "min": 0.8, "max": 1.2, "steps": 50 }
}
```

<br/>

## Physics Reference

### Reduced Couplings (kappa-framework)

The kappa-framework parameterizes deviations from SM Higgs couplings as multiplicative modifiers:

| Parameter | Description | SM Value |
|:--|:--|--:|
| C_V | Vector boson coupling (W, Z) | 1.0 |
| C_t | Top quark coupling | 1.0 |
| C_b | Bottom quark coupling | 1.0 |
| C_c | Charm quark coupling | 1.0 |
| C_tau | Tau lepton coupling | 1.0 |
| C_mu | Muon coupling | 1.0 |
| C_g | Effective gluon coupling (loop-induced) | 1.0 |
| C_gamma | Effective photon coupling (loop-induced) | 1.0 |

**Signal strength**: &mu; = &sigma;_obs / &sigma;_SM. A value of &mu; = 1 is consistent with the Standard Model.

### Supported Production & Decay Modes

**Production**: ggH, VBF, WH, ZH, ttH, tH, bbH

**Decay**: &gamma;&gamma;, ZZ, WW, bb, &tau;&tau;, &mu;&mu;, cc, Z&gamma;, gg, invisible

<br/>

## Architecture

```
pythia-mcp/
├── src/
│   ├── index.ts           # MCP server, request handlers, tool dispatch
│   ├── utils.ts           # Validation, XML generation, physics models
│   └── utils.test.ts      # Unit tests (71 tests via Vitest)
├── lilith/                # Bundled Lilith-2 library
│   ├── run_lilith.py      # CLI entry point
│   ├── lilith/            # Core Python package
│   │   ├── main.py        # Lilith class — likelihood engine
│   │   └── internal/      # Couplings, BRs, likelihood computation
│   ├── data/              # Experimental database (ATLAS, CMS, Tevatron)
│   └── userinput/         # Example XML input files
├── .github/workflows/     # CI: build (Node 18/20/22) + test
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Security

- **Input validation** &mdash; All coupling, mass, and branching-ratio parameters are range-checked before use.
- **XML injection prevention** &mdash; All user-supplied values are escaped before embedding in XML.
- **Path traversal protection** &mdash; Dataset paths are resolved and verified against a base directory.
- **ReDoS prevention** &mdash; User-supplied regex patterns are length-limited and checked for dangerous constructs.
- **API safety** &mdash; HTTP requests enforce 30s timeouts, redirect depth limits, and response caching with TTL.
- **Subprocess limits** &mdash; Python process output is capped at 1 MB to prevent memory exhaustion.

<br/>

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run unit tests
npm run test:watch   # Run tests in watch mode
npm run dev          # Run with ts-node (development)
```

### Environment Variables

| Variable | Default | Description |
|:--|:--|:--|
| `LILITH_DIR` | `../lilith` (relative to dist) | Path to Lilith installation |
| `PYTHON_CMD` | `python3` | Python interpreter command |

<br/>

## Citations

**If you use Pythia in research, you must cite the Lilith papers:**

```bibtex
@article{Bernon:2015hsa,
    author  = "Bernon, J\'er\'emy and Dumont, B\'eranger",
    title   = "{Lilith: a tool for constraining new physics from Higgs measurements}",
    journal = "Eur. Phys. J. C",
    volume  = "75",
    pages   = "440",
    year    = "2015",
    doi     = "10.1140/epjc/s10052-015-3645-9",
    eprint  = "1502.04138",
    archivePrefix = "arXiv"
}

@article{Kraml:2019sis,
    author  = "Kraml, Sabine and others",
    title   = "{Lilith-2: improved constraints on new physics from Higgs measurements}",
    year    = "2019",
    eprint  = "1908.03952",
    archivePrefix = "arXiv"
}
```

### Acknowledgments

| | |
|:--|:--|
| **Sabine Kraml & Lilith Team** | LPSC Grenoble &mdash; physics engine |
| **ATLAS & CMS Collaborations** | Higgs boson measurements |
| **HEPData** | Durham / CERN &mdash; data archive |
| **Anthropic** | Model Context Protocol |

<br/>

## References

| Resource | Link |
|:--|:--|
| Lilith-2 source | [github.com/sabinekraml/Lilith-2](https://github.com/sabinekraml/Lilith-2) |
| Lilith paper | [arXiv:1502.04138](https://arxiv.org/abs/1502.04138) |
| HEPData | [hepdata.net](https://www.hepdata.net) |
| CERN Open Data | [opendata.cern.ch](https://opendata.cern.ch) |
| LHC Higgs XS WG | [twiki.cern.ch/LHCPhysics/LHCHWG](https://twiki.cern.ch/twiki/bin/view/LHCPhysics/LHCHWG) |
| Model Context Protocol | [modelcontextprotocol.io](https://modelcontextprotocol.io) |

<br/>

## License

[GNU General Public License v3.0](LICENSE) &mdash; Pythia and the bundled Lilith library are both GPL-3.0 licensed.

<br/>

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d1117,50:161b22,100:1a1e2e&height=100&section=footer"/>

*"The Higgs boson is the key to understanding the origin of mass in the universe."*<br/>
&mdash; Peter Higgs

<sub>Built for open science and particle physics research.</sub>

</div>

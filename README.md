# Pythia MCP Server

<div align="center">

**An Oracle for Higgs Boson Phenomenology**

*Model Context Protocol Server for Constraining New Physics from LHC Higgs Measurements*

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.6+-blue.svg)](https://www.python.org/)

</div>

---

## Overview

**Pythia** (named after the Oracle of Delphi in Greek mythology) is a Model Context Protocol (MCP) server that provides AI assistants with powerful tools for Higgs boson phenomenology. It interfaces with [Lilith](https://github.com/sabinekraml/Lilith-2), a comprehensive framework for constraining new physics scenarios using signal strength measurements from the ATLAS and CMS experiments at the Large Hadron Collider (LHC).

### Key Features

- **Likelihood Computation**: Calculate -2 log(L) for arbitrary BSM scenarios
- **Parameter Scans**: 1D and 2D parameter space scans with likelihood profiles
- **Physics Models**: Built-in support for Two-Higgs-Doublet Models (2HDM) and singlet extensions
- **Live Data Access**: Real-time queries to HEPData and CERN Open Data portals
- **Database Updates**: Fetch latest experimental results from ATLAS and CMS
- **SM Predictions**: Standard Model cross sections and branching ratios

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Available Tools](#available-tools)
- [Usage Examples](#usage-examples)
- [Physics Background](#physics-background)
- [Data Sources](#data-sources)
- [Contributing](#contributing)
- [Citations & Acknowledgments](#citations--acknowledgments)
- [License](#license)

---

## Installation

### Prerequisites

- **Node.js** 20.x or higher
- **Python** 3.6 or higher
- **NumPy** and **SciPy** Python packages

### Step 1: Clone the Repository

```bash
git clone https://github.com/codymaryland/pythia-mcp.git
cd pythia-mcp
```

### Step 2: Install Node.js Dependencies

```bash
npm install
```

### Step 3: Build the TypeScript

```bash
npm run build
```

### Step 4: Install Lilith

Pythia requires Lilith-2 to be installed. You can either:

**Option A: Use the bundled Lilith (recommended)**
```bash
# The repository includes Lilith in the 'lilith' subdirectory
# Ensure Python dependencies are installed:
pip install numpy scipy
```

**Option B: Set custom Lilith path**
```bash
# Clone Lilith separately
git clone https://github.com/sabinekraml/Lilith-2.git /path/to/lilith

# Set environment variable
export LILITH_DIR=/path/to/lilith
```

### Step 5: Verify Installation

```bash
# Test that Lilith works
cd lilith
python run_lilith.py userinput/example_couplings.xml
```

---

## Configuration

### Adding Pythia to Claude Code

Add the following to your Claude Code MCP configuration file (`~/.claude.json` for user-level or `.mcp.json` for project-level):

```json
{
  "mcpServers": {
    "pythia": {
      "type": "stdio",
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

Or use the Claude CLI:

```bash
claude mcp add-json pythia '{
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/pythia-mcp/dist/index.js"],
  "env": {
    "LILITH_DIR": "/path/to/pythia-mcp/lilith"
  }
}' -s user
```

### Adding to Other MCP-Compatible Applications

For other applications supporting MCP (e.g., custom AI assistants), use the standard stdio transport:

```json
{
  "name": "pythia",
  "transport": "stdio",
  "command": "node",
  "args": ["/path/to/pythia-mcp/dist/index.js"]
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LILITH_DIR` | Path to Lilith installation | `./lilith` |
| `PYTHON_CMD` | Python executable | `python3` |

---

## Available Tools

### Core Analysis Tools

| Tool | Description |
|------|-------------|
| `compute_likelihood` | Compute Higgs likelihood for reduced couplings or signal strengths |
| `compute_sm_likelihood` | Get Standard Model reference likelihood |
| `compute_pvalue` | Calculate p-value for model comparison |
| `scan_1d` | 1D parameter scan with likelihood profile |
| `scan_2d` | 2D parameter scan for contour plots |

### Data Management Tools

| Tool | Description |
|------|-------------|
| `list_experimental_data` | List datasets in Lilith database |
| `get_dataset_info` | Get detailed info for a specific dataset |
| `search_hepdata` | Search HEPData for new measurements |
| `fetch_hepdata_record` | Download specific HEPData record |
| `update_database` | Check for database updates |

### CERN Open Data Tools

| Tool | Description |
|------|-------------|
| `search_cern_opendata` | Search CERN Open Data portal |
| `get_cern_opendata_record` | Get record metadata |
| `list_cern_opendata_files` | List downloadable files |
| `get_latest_higgs_data` | Fetch latest Higgs data from all sources |

### Physics Model Tools

| Tool | Description |
|------|-------------|
| `analyze_2hdm` | Analyze Two-Higgs-Doublet Models |
| `analyze_singlet_extension` | Analyze Higgs singlet extension |
| `get_sm_predictions` | Get SM cross sections and branching ratios |
| `convert_to_signal_strength` | Convert couplings to signal strengths |

### Utility Tools

| Tool | Description |
|------|-------------|
| `get_version_info` | Get Pythia and Lilith version info |
| `validate_input` | Validate XML input format |

---

## Usage Examples

### Example 1: Check if SM is Compatible with Data

Ask your AI assistant:
> "Use Pythia to compute the Standard Model likelihood and tell me if the Higgs data is consistent with the SM."

### Example 2: Test a BSM Scenario

> "Calculate the likelihood for a model where the Higgs coupling to top quarks is 0.9 and to vector bosons is 1.1"

This will use `compute_likelihood` with:
```json
{
  "mode": "couplings",
  "Ct": 0.9,
  "CV": 1.1
}
```

### Example 3: 2HDM Analysis

> "Analyze a Type-II 2HDM with tan(β) = 2 and sin(β-α) = 0.99"

This will use `analyze_2hdm`:
```json
{
  "type": "II",
  "tanBeta": 2,
  "sinBetaMinusAlpha": 0.99
}
```

### Example 4: Parameter Scan

> "Scan the CV-CF plane from 0.8 to 1.2 with 50 steps each and find the best fit point"

This will use `scan_2d`:
```json
{
  "param1": {"name": "CV", "min": 0.8, "max": 1.2, "steps": 50},
  "param2": {"name": "CF", "min": 0.8, "max": 1.2, "steps": 50}
}
```

### Example 5: Get Latest Data

> "Search HEPData for the latest ATLAS Higgs to diphoton measurements"

This will use `search_hepdata`:
```json
{
  "collaboration": "ATLAS",
  "decay": "gammagamma"
}
```

---

## Physics Background

### Reduced Couplings

Lilith uses **reduced couplings** (also called coupling modifiers or κ-framework) to parameterize deviations from the Standard Model:

| Coupling | SM Value | Description |
|----------|----------|-------------|
| C_V | 1.0 | Coupling to W and Z bosons |
| C_t | 1.0 | Coupling to top quark |
| C_b | 1.0 | Coupling to bottom quark |
| C_τ | 1.0 | Coupling to tau lepton |
| C_g | 1.0 | Effective coupling to gluons (loop) |
| C_γ | 1.0 | Effective coupling to photons (loop) |

### Signal Strengths

The signal strength μ is defined as:

```
μ = (σ × BR)_observed / (σ × BR)_SM
```

Where σ is the production cross section and BR is the branching ratio.

### Likelihood

Lilith computes **-2 log(L)** where L is the likelihood. Lower values indicate better agreement with data. The SM typically has -2 log(L) ≈ Ndof (number of measurements).

### Confidence Levels

For 2D parameter scans, the confidence level contours correspond to:
- **68% CL**: Δ(-2 log L) = 2.30
- **95% CL**: Δ(-2 log L) = 5.99
- **99.7% CL**: Δ(-2 log L) = 11.83

---

## Data Sources

Pythia integrates with multiple authoritative data sources:

### Lilith Experimental Database

The built-in database includes published ATLAS and CMS results:
- Run 1 (7+8 TeV): Final combined results
- Run 2 (13 TeV): 36 fb⁻¹ and 140 fb⁻¹ results
- Multiple decay channels: γγ, ZZ, WW, bb, ττ, μμ, invisible

### HEPData

[HEPData](https://www.hepdata.net) is the official repository for publication-related High-Energy Physics data, hosted by CERN and Durham University.

**API Documentation**: https://hepdata.readthedocs.io

### CERN Open Data Portal

[CERN Open Data](https://opendata.cern.ch) provides open access to real collision data, simulated datasets, analysis code, and documentation from LHC experiments.

**API Documentation**: https://opendata.atlas.cern/docs/data/cern_opendata_portal

**CLI Tool**: `cernopendata-client`
```bash
pip install cernopendata-client
cernopendata-client get-metadata --recid 1
```

---

## Contributing

Contributions are welcome! Please feel free to submit pull requests for:

- New physics models
- Updated experimental data
- Bug fixes
- Documentation improvements

### Development Setup

```bash
git clone https://github.com/codymaryland/pythia-mcp.git
cd pythia-mcp
npm install
npm run dev  # Run in development mode
```

---

## Citations & Acknowledgments

### Lilith

If you use Pythia (which uses Lilith) for your research, please cite:

```bibtex
@article{Bernon:2015hsa,
    author = "Bernon, Jérémy and Dumont, Béranger",
    title = "{Lilith: A tool for constraining new physics from Higgs measurements}",
    journal = "Eur. Phys. J. C",
    volume = "75",
    number = "9",
    pages = "440",
    year = "2015",
    doi = "10.1140/epjc/s10052-015-3645-9",
    eprint = "1502.04138",
    archivePrefix = "arXiv"
}

@article{Kraml:2019sis,
    author = "Kraml, Sabine and others",
    title = "{Lilith-2: A new release with improved precision constraints}",
    year = "2019",
    eprint = "1908.03952",
    archivePrefix = "arXiv"
}
```

### HEPData

```bibtex
@article{Maguire:2017ypu,
    author = "Maguire, Eamonn and others",
    title = "{HEPData: a repository for high energy physics data}",
    journal = "J. Phys. Conf. Ser.",
    volume = "898",
    number = "10",
    pages = "102006",
    year = "2017",
    doi = "10.1088/1742-6596/898/10/102006"
}
```

### CERN Open Data

```bibtex
@misc{cernopendata,
    author = "{CERN}",
    title = "{CERN Open Data Portal}",
    url = "https://opendata.cern.ch",
    year = "2024"
}
```

### Special Thanks

- **Sabine Kraml** and the Lilith development team at LPSC Grenoble
- **ATLAS and CMS Collaborations** for publishing their Higgs measurements
- **HEPData Team** at Durham University and CERN
- **CERN Open Data Team** for making particle physics data accessible
- **Anthropic** for developing the Model Context Protocol

---

## License

This project is licensed under the **GNU General Public License v3.0** - see the [LICENSE](LICENSE) file for details.

Lilith is also licensed under GPL v3.

---

## References

### Primary Publications

1. Bernon & Dumont, *"Lilith: A tool for constraining new physics from Higgs measurements"*, [arXiv:1502.04138](https://arxiv.org/abs/1502.04138)

2. Kraml et al., *"Lilith-2: Improvements in Higgs likelihood calculations"*, [arXiv:1908.03952](https://arxiv.org/abs/1908.03952)

3. Bechtle et al., *"Higgs-mass predictions in the MSSM"*, [arXiv:2012.11408](https://arxiv.org/abs/2012.11408)

### Experimental Results

- [ATLAS Higgs Results](https://atlas.cern/tags/higgs-boson)
- [CMS Higgs Results](https://cms.cern/physics/higgs-boson)
- [LHC Higgs Cross Section Working Group](https://twiki.cern.ch/twiki/bin/view/LHCPhysics/LHCHWG)

### Tutorials

- [Lilith-2 Tutorial (Tools 2020)](https://indico.cern.ch/event/955391/contributions/4086275/)

---

<div align="center">

**Pythia MCP Server** — *Seeking truth in the Higgs sector*

Made with dedication to open science and particle physics research.

</div>

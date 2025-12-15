<div align="center">

<!-- Animated Header -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=24,25,26&height=200&section=header&text=🔮%20PYTHIA&fontSize=80&fontColor=fff&animation=twinkling&fontAlignY=35&desc=Higgs%20Boson%20Phenomenology%20MCP%20Server&descAlignY=55&descSize=18"/>

<br/>

<!-- Badges Row 1 -->
<p>
<a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-Server-00d4aa?style=for-the-badge" alt="MCP Server"/></a>
<a href="https://home.cern"><img src="https://img.shields.io/badge/CERN-LHC_Data-0033a0?style=for-the-badge" alt="CERN"/></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL_v3-blue?style=for-the-badge" alt="License"/></a>
<a href="#"><img src="https://img.shields.io/badge/Physics-Research-9b59b6?style=for-the-badge" alt="Physics"/></a>
</p>

<!-- Badges Row 2 -->
<p>
<img src="https://img.shields.io/badge/TypeScript-✓-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
<img src="https://img.shields.io/badge/Python-3.6+-3776ab?style=flat-square&logo=python&logoColor=white" alt="Python"/>
<img src="https://img.shields.io/badge/Lilith-Interface-ff6b6b?style=flat-square" alt="Lilith"/>
<img src="https://img.shields.io/badge/Higgs_Boson-125_GeV-gold?style=flat-square" alt="Higgs"/>
<img src="https://img.shields.io/badge/Claude_Desktop-Ready-blueviolet?style=flat-square&logo=anthropic" alt="Claude"/>
</p>

<br/>

<!-- Tagline Box -->
<table>
<tr>
<td>

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   🔮  Named after the Oracle of Delphi, Pythia brings the power of          ║
║       particle physics to your AI assistant — enabling Claude to            ║
║       constrain new physics from LHC Higgs boson measurements.              ║
║                                                                              ║
║       ⚛️  Interface: Lilith library for Higgs phenomenology                  ║
║       📊  Data: ATLAS + CMS signal strength measurements                     ║
║       🔬  Physics: Beyond Standard Model constraints                         ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

</td>
</tr>
</table>

<br/>

<!-- Quick Links -->
[**🚀 Quick Start**](#-quick-start) · [**⚛️ Physics**](#-physics-background) · [**🔧 Tools**](#-available-tools) · [**📖 Examples**](#-usage-examples) · [**📚 Citations**](#-citations--acknowledgments)

<br/>

</div>

---

<br/>

## 🏛️ Built on Lilith

<div align="center">

> **⚠️ IMPORTANT**: This project is a wrapper around [**Lilith-2**](https://github.com/sabinekraml/Lilith-2), a powerful Python tool developed by **Sabine Kraml and collaborators** at LPSC Grenoble. All physics calculations are performed by Lilith — Pythia simply provides an MCP interface.
>
> **[⭐ Star the Original Lilith Repository](https://github.com/sabinekraml/Lilith-2)** and cite the Lilith papers in your research!

</div>

<br/>

---

<br/>

## 🎯 What is Pythia?

<table>
<tr>
<td width="50%">

### 🔬 The Challenge
```
New physics theories predict
modified Higgs couplings...

But how do we test them
against LHC data?

❌ Complex calculations
❌ Multiple decay channels
❌ Statistical combinations
❌ Expert knowledge required
```

</td>
<td width="50%">

### ✅ Pythia Solution
```
Ask Claude in plain English:

"What constraints does LHC
 data place on a two-Higgs
 doublet model?"

✅ Lilith handles the math
✅ Signal strengths computed
✅ Constraints calculated
✅ Results explained clearly
```

</td>
</tr>
</table>

<br/>

---

<br/>

## ⚛️ Physics Background

<div align="center">

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                    THE 125 GeV HIGGS BOSON                                 │
│                                                                             │
│    Discovery: July 4, 2012 at CERN's Large Hadron Collider                 │
│                                                                             │
│    ┌─────────────────────────────────────────────────────────────┐         │
│    │                                                             │         │
│    │   Production Modes          Decay Channels                  │         │
│    │   ────────────────          ──────────────                  │         │
│    │   • ggF (gluon fusion)      • H → γγ (diphoton)            │         │
│    │   • VBF (vector boson)      • H → ZZ* → 4ℓ                 │         │
│    │   • WH, ZH (associated)     • H → WW* → ℓνℓν               │         │
│    │   • ttH (top associated)    • H → bb̄, ττ, μμ               │         │
│    │                                                             │         │
│    └─────────────────────────────────────────────────────────────┘         │
│                                                                             │
│    Signal Strength: μ = σ_observed / σ_SM_predicted                        │
│                                                                             │
│    μ = 1  →  Standard Model ✓                                              │
│    μ ≠ 1  →  New Physics! 🎉                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

</div>

<br/>

### 📊 Reduced Couplings (κ-Framework)

<div align="center">

| Coupling | SM Value | Description |
|:--------:|:--------:|:-----------:|
| **C_V** | 1.0 | Coupling to W and Z bosons |
| **C_t** | 1.0 | Coupling to top quark |
| **C_b** | 1.0 | Coupling to bottom quark |
| **C_τ** | 1.0 | Coupling to tau lepton |
| **C_g** | 1.0 | Effective coupling to gluons (loop) |
| **C_γ** | 1.0 | Effective coupling to photons (loop) |

</div>

<br/>

---

<br/>

## 🚀 Quick Start

### 📦 Installation

```bash
# Clone the repository
git clone https://github.com/consigcody94/pythia-mcp.git
cd pythia-mcp

# Install Node.js dependencies
npm install

# Build TypeScript
npm run build

# Ensure Python dependencies are installed
pip install numpy scipy
```

### ⚡ Claude Desktop Configuration

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

### ✅ Verify Installation

```bash
cd lilith
python run_lilith.py userinput/example_couplings.xml
```

<br/>

---

<br/>

## 🔧 Available Tools

### 🔬 Core Analysis

<div align="center">

| Tool | Description |
|:----:|:-----------:|
| `compute_likelihood` | Calculate -2 log(L) for BSM scenarios |
| `compute_sm_likelihood` | Get Standard Model reference |
| `compute_pvalue` | Calculate p-value for model comparison |
| `scan_1d` | 1D parameter scan with likelihood profile |
| `scan_2d` | 2D scan for contour plots |

</div>

### 📊 Data Management

<div align="center">

| Tool | Description |
|:----:|:-----------:|
| `list_experimental_data` | List datasets in Lilith database |
| `search_hepdata` | Search HEPData for new measurements |
| `fetch_hepdata_record` | Download specific HEPData record |
| `get_latest_higgs_data` | Fetch latest from all sources |

</div>

### 🧪 Physics Models

<div align="center">

| Tool | Description |
|:----:|:-----------:|
| `analyze_2hdm` | Two-Higgs-Doublet Model analysis |
| `analyze_singlet_extension` | Higgs singlet extension |
| `get_sm_predictions` | SM cross sections & branching ratios |
| `convert_to_signal_strength` | Convert couplings to μ values |

</div>

<br/>

---

<br/>

## 📖 Usage Examples

### Example 1: Standard Model Check

> *"Use Pythia to compute the Standard Model likelihood and tell me if the Higgs data is consistent with the SM."*

### Example 2: BSM Scenario

> *"Calculate the likelihood for a model where the Higgs coupling to top quarks is 0.9 and to vector bosons is 1.1"*

```json
{
  "mode": "couplings",
  "Ct": 0.9,
  "CV": 1.1
}
```

### Example 3: 2HDM Analysis

> *"Analyze a Type-II 2HDM with tan(β) = 2 and sin(β-α) = 0.99"*

```json
{
  "type": "II",
  "tanBeta": 2,
  "sinBetaMinusAlpha": 0.99
}
```

### Example 4: Parameter Scan

> *"Scan the CV-CF plane from 0.8 to 1.2 with 50 steps each"*

```json
{
  "param1": {"name": "CV", "min": 0.8, "max": 1.2, "steps": 50},
  "param2": {"name": "CF", "min": 0.8, "max": 1.2, "steps": 50}
}
```

<br/>

---

<br/>

## 📊 Data Sources

<div align="center">

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│   │  🔬 LILITH DB   │  │  📚 HEPDATA     │  │  🌐 CERN OPEN   │            │
│   │  ────────────── │  │  ────────────── │  │  ────────────── │            │
│   │  Run 1 (7+8TeV) │  │  Official HEP   │  │  Real collision │            │
│   │  Run 2 (13TeV)  │  │  data archive   │  │  data & MC      │            │
│   │  ATLAS + CMS    │  │  CERN/Durham    │  │  analysis code  │            │
│   └─────────────────┘  └─────────────────┘  └─────────────────┘            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

</div>

<br/>

---

<br/>

## 🏗️ Architecture

```
pythia-mcp/
├── 📦 src/
│   ├── index.ts          # MCP server entry point
│   └── tools/            # Tool implementations
│
├── 🔮 lilith/            # Lilith library (bundled)
│   ├── run_lilith.py     # Main entry point
│   ├── userinput/        # XML input templates
│   └── data/             # Experimental database
│
├── 📦 dist/              # Compiled output
├── 📄 package.json
└── 📄 tsconfig.json
```

<br/>

---

<br/>

## 📚 Citations & Acknowledgments

### 📖 Required Citations

**If you use Pythia for research, you MUST cite Lilith:**

```bibtex
@article{Bernon:2015hsa,
    author = "Bernon, Jérémy and Dumont, Béranger",
    title = "{Lilith: A tool for constraining new physics from Higgs measurements}",
    journal = "Eur. Phys. J. C",
    volume = "75",
    pages = "440",
    year = "2015",
    doi = "10.1140/epjc/s10052-015-3645-9",
    eprint = "1502.04138",
    archivePrefix = "arXiv"
}

@article{Kraml:2019sis,
    author = "Kraml, Sabine and others",
    title = "{Lilith-2: Improved precision constraints}",
    year = "2019",
    eprint = "1908.03952",
    archivePrefix = "arXiv"
}
```

### 🙏 Special Thanks

<div align="center">

| | |
|:-:|:-:|
| **Sabine Kraml & Lilith Team** | LPSC Grenoble |
| **ATLAS & CMS Collaborations** | Higgs measurements |
| **HEPData Team** | Durham/CERN |
| **Anthropic** | MCP Protocol |

</div>

<br/>

---

<br/>

## 🔗 References

<div align="center">

| Resource | Link |
|:--------:|:----:|
| **Lilith-2** | [github.com/sabinekraml/Lilith-2](https://github.com/sabinekraml/Lilith-2) |
| **Lilith Paper** | [arXiv:1502.04138](https://arxiv.org/abs/1502.04138) |
| **HEPData** | [hepdata.net](https://www.hepdata.net) |
| **CERN Open Data** | [opendata.cern.ch](https://opendata.cern.ch) |
| **LHC Higgs XS WG** | [twiki.cern.ch](https://twiki.cern.ch/twiki/bin/view/LHCPhysics/LHCHWG) |

</div>

<br/>

---

<br/>

## 📄 License

<div align="center">

**GNU General Public License v3.0**

This project and Lilith are licensed under GPL v3 - see [LICENSE](LICENSE) for details.

</div>

<br/>

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=24,25,26&height=100&section=footer"/>

<br/>

**🔮 Pythia** — *Seeking Truth in the Higgs Sector*

<br/>

*"The Higgs boson is the key to understanding the origin of mass in the universe."*
<br/>
— Peter Higgs

<br/>

Made with dedication to open science and particle physics research

<br/>

[⬆ Back to Top](#-pythia)

</div>

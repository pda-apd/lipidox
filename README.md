# LipidoX

LipidoX is a self-hosted web platform for LC-MS/MS lipidomics data processing,
statistical analysis, and interactive visualization. This repository holds the
source code (v1.0.0) released with the accompanying manuscript.

## Repository layout

```
backend/                  FastAPI backend and analysis services
  services/               preprocessing, PCA, PLS-DA, univariate tests,
                          biomarker models, enrichment, lipid ID conversion
  example_seed/Example/   bundled demonstration datasets
client/                   HTML/JavaScript interface
Dockerfile                single-container image (Python 3.10)
run_dev.bat               Windows helper for local development
```

## Availability and requirements

| Field | Value |
|---|---|
| Project name | LipidoX (LipidPortal v4) |
| Project home page | https://github.com/pda-apd/lipidox |
| Operating system(s) | Platform independent (Docker); Linux, macOS, Windows (Python) |
| Programming language | Python 3.10 (backend), JavaScript (frontend) |
| Other requirements | Docker 20+, or Python 3.10 with the packages in `backend/requirements.txt` |
| License | MIT (see `LICENSE`) |

## Run with Docker

```bash
docker build -t lipidox .
docker run -p 7860:7860 -e JWT_SECRET="$(python -c 'import secrets;print(secrets.token_hex(32))')" -v lipidox_data:/data lipidox
```

Then open `http://localhost:7860/register.html` and create an account.

## Run locally

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    |    Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Without a `.env` file the application stores its database and uploaded files
under `./data`. See `backend/.env.example` for the available settings.

`backend/requirements.txt` lists the packages; `backend/requirements.lock.txt`
records the exact versions used for the analyses reported in the manuscript.

## Demonstration dataset

`backend/example_seed/Example/LipidoX_demo_90x223/` contains the dataset used
in the manuscript:

| File | Content |
|---|---|
| `matrix_raw.csv` | raw lipid intensities, 223 features × 90 samples |
| `matrix_IS_NIST.csv` | the same samples after internal-standard and NIST normalization |
| `metadata.csv` | sample annotations (age, sex, AST, ALT, RBC, HGB, WBC, group) |

The dataset comprises three groups of 30 samples each (Normal, Hepatitis,
Cirrhosis). To reproduce the preprocessing figures, create a project, upload
`matrix_raw.csv` with `metadata.csv`, run the internal-standard and NIST
normalization steps, apply the log₂ transformation, and run PCA.

## Analysis modules

- **Preprocessing**: sample/feature validation, internal-standard normalization,
  NIST reference-material normalization, missing-value, RSD, low-variance and
  low-abundance filtering, imputation (1/5 minimum, QRILC), sample
  normalization (sum, median, quantile), transformation (log₂, log₁₀, square
  root, cube root), batch correction (ComBat, PCA-based), scaling (mean
  centring, autoscaling, Pareto, range).
- **Multivariate analysis**: PCA, UMAP, t-SNE, PLS-DA, OPLS-DA, K-means,
  self-organizing maps, hierarchical clustering.
- **Univariate analysis**: distribution-adaptive routing between parametric and
  non-parametric tests, with effect sizes and FDR correction.
- **Biomarker models**: OLS and ordinal logistic regression, correlation
  analysis, ROC analysis, random forest, SVM.
- **Enrichment**: gene/protein set enrichment (GSEA), lipid over-representation
  and lipid set enrichment analysis, enrichment-map networks, lipid reaction
  and pathway activity networks.
- **Lipid ID conversion**: pygoslin-based name parsing with locally bundled
  annotation snapshots.

## Licensing and citation

Released under the MIT License. Citation metadata is provided in
`CITATION.cff`. If you use LipidoX in published work, please cite the
manuscript and the archived release DOI.

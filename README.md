# LipidoX

LipidoX is a self-hosted web platform for LC-MS/MS lipidomics data processing,
statistical analysis, and interactive visualization. This repository holds the
source code (v1.0.0) released with the accompanying manuscript.

## Repository layout

```
backend/                  FastAPI backend and analysis services
  services/               preprocessing, PCA, PLS-DA, univariate tests,
                          biomarker models, enrichment, lipid ID conversion,
                          pathway / GATOM / lipid-reaction networks
  example_seed/Example/   bundled demonstration dataset (Normal_vs_CHB)
client/                   HTML/JavaScript interface
tools/                    offline helpers (LipidSigR annotation export, network runner)
Dockerfile                single-container image (Python 3.12)
```

## Availability and requirements

| Field | Value |
|---|---|
| Project name | LipidoX (LipidPortal v4) |
| Project home page | https://github.com/pda-apd/lipidox |
| Operating system(s) | Platform independent (Docker); Linux, macOS, Windows (Python) |
| Programming language | Python 3.12 (backend), JavaScript (frontend) |
| Other requirements | Docker 20+, or Python 3.12 with the packages in `backend/requirements.txt`. The pathway / GATOM / lipid-reaction network module additionally requires R with the LipidSigR package; it is disabled automatically when `Rscript` is not available. |
| License | MIT for the source code; CC BY 4.0 for the demonstration dataset (see `LICENSE` and `backend/example_seed/Example/Normal_vs_CHB/LICENSE.txt`) |

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
under `./data` and generates a random JWT signing key at `./data/.jwt_secret`
on first start. See `backend/.env.example` for the available settings.

`backend/requirements.txt` lists the packages; `backend/requirements.lock.txt`
pins the exact versions installed in the container image.

## Demonstration dataset

`backend/example_seed/Example/Normal_vs_CHB/` contains the dataset used in the
manuscript and the dataset loaded by the **Example** entry in the interface:

| File | Content |
|---|---|
| `matrix.csv` | internal-standard and NIST-normalized intensities, 223 features × 90 samples (loaded by the interface) |
| `matrix_raw.csv` | the same samples before normalization, 223 features × 90 samples |
| `meta.csv` | sample annotations (age, sex, AST, ALT, RBC, HGB, WBC, group) |
| `README.md` | data documentation, including the ethics approvals |

The dataset comprises three groups of 30 samples each (Normal, Hepatitis,
Cirrhosis). To reproduce the preprocessing figures, create a project, upload
`matrix_raw.csv` with `meta.csv`, run the internal-standard and NIST
normalization steps, apply the log₂ transformation, and run PCA. To start from
the normalized matrix instead, upload `matrix.csv` with `meta.csv` and apply the
log₂ transformation before PCA.

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
  and lipid set enrichment analysis, and enrichment-map networks.
- **Network analysis**: pathway activity, GATOM and lipid-reaction networks,
  computed through LipidSigR (`tools/run_network.R`) and rendered in the
  browser; requires an R installation with LipidSigR on the server.
- **Lipid ID conversion**: pygoslin-based name parsing with locally bundled
  annotation snapshots.

## Deployment notes

- `JWT_SECRET` is generated and persisted at `<DATA_DIR>/.jwt_secret` when it is
  not supplied; set it explicitly when several instances share a database.
- The interactive API documentation is disabled. Set `ENABLE_DOCS=1` to expose
  `/docs` on a private instance.
- `MAX_UPLOAD_MB` and `PROJECT_QUOTA_MB` bound disk use per upload and per
  project; `ALLOWED_HOSTS` restricts the accepted `Host` header; `CORS_ORIGINS`
  defaults to local development origins rather than `*`.
- Database and storage backups can be encrypted with `BACKUP_ENCRYPTION_KEY`.
- The container runs as an unprivileged user (UID 1000) and keeps its state in
  the `/data` volume.

## Licensing and citation

The source code is released under the MIT License. The demonstration dataset in
`backend/example_seed/Example/Normal_vs_CHB/` is released under CC BY 4.0 (see
`LICENSE.txt` in that folder). Citation metadata is provided in `CITATION.cff`.
If you use LipidoX in published work, please cite the manuscript and the
versioned release (v1.0.0).

The MIT License covers the source code. The names "LipidoX" and the project logo
are not licensed for use in derivative product names or endorsement. Annotation
tables in `backend/services/lipidref/data/` derive from third-party resources;
see `THIRD_PARTY_NOTICES.md`.

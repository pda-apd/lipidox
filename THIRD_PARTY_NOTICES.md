# Third-party notices

LipidoX is released under the MIT License (see `LICENSE`). This file records the
origin and licensing of third-party components and data distributed with, or
downloaded by, the software. The MIT License of LipidoX does not override the
terms of these components.

## Bundled software

| Component | Location | License | Copyright |
|---|---|---|---|
| LipidSigR | required at runtime by `tools/run_network.R` (not redistributed) | MIT (Version 1.0.4, `License: MIT + file LICENSE`) | Wei-Chung Cheng and contributors, https://github.com/BioinfOMICS/LipidSigR |
| plotly.js 2.35.2 | `client/src/js/vendor/plotly-2.35.2.min.js` | MIT | Copyright 2012-2024, Plotly, Inc. |
| Bootstrap 5.3.2 / 5.3.3 | loaded from cdn.jsdelivr.net | MIT | Copyright 2011-2024 The Bootstrap Authors |
| Font Awesome Free 6.5.0 / 6.5.1 | loaded from cdnjs.cloudflare.com | Icons CC BY 4.0; fonts SIL OFL 1.1; code MIT | Copyright Fonticons, Inc. |
| MathJax 3 | loaded from cdn.jsdelivr.net | Apache-2.0 | Copyright The MathJax Consortium |
| vis-network | loaded from unpkg.com by the generated network report | Apache-2.0 OR MIT | Copyright vis.js contributors |
| Python packages | `backend/requirements.txt` | per package | see each package |

## Bundled data

### LipidSigR annotation snapshots

`backend/services/lipidref/data/*.parquet` (`resource_id_anno`, `lion_id_anno`,
`lion_char`, `gatom_metabolites`) were exported from the LipidSigR package
(MIT, v1.0.4) with `tools/export_lipidsigr_data.R`. LipidSigR aggregates
identifier mappings and lipid annotations from LIPID MAPS, SwissLipids, HMDB,
ChEBI, KEGG, MetaNetX, LipidBank, PubChem and PlantFA. Those source databases
keep their own terms and should be cited as described by their providers.

### Gene and protein sets

| Files | Origin | Terms |
|---|---|---|
| `backend/services/kegg_gmt/*.gmt` (6 files) | KEGG PATHWAY gene sets | © Kanehisa Laboratories. KEGG data are distributed under the terms at https://www.kegg.jp/kegg/legal.html ; academic users should cite Kanehisa M, et al. |
| `backend/services/HPA_GMT/*.gmt` (12 files), `A.proteinatlas.tsv` | Human Protein Atlas classification gene sets | Human Protein Atlas, https://www.proteinatlas.org ; see https://www.proteinatlas.org/about/licence |
| WikiPathway 2023 Human, KEGG 2021 Human and other GMT sets fetched at run time | retrieved by `gseapy` from Enrichr | see the Enrichr terms of use |

## Trademarks

"LipidoX" is the name of this project. The MIT License grants copyright and
patent permissions on the source code only; it does not grant permission to use
the project name or its logo to endorse or promote a derived product.

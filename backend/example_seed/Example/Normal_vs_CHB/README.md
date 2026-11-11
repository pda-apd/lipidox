# LipidoX demonstration lipidomics dataset (90 samples × 223 lipid features)

De-identified LC-MS/MS lipidomics data used to demonstrate the LipidoX platform.
This is the **primary Example dataset**: the 223-feature panel analysed in the
manuscript. The same 90 samples with an extended 341-feature panel are provided
in `../Normal_vs_CHB_341/` for the LipidSigR-backed enrichment and network
modules.

## Contents

| File | Content |
|---|---|
| `matrix.csv` | The same samples after internal-standard (IS) normalization and NIST SRM 1950-based normalization, rounded to five decimal places. Rows are lipid features, columns are samples. This is the file the interface loads. |
| `matrix_raw.csv` | Raw lipid intensities for the same samples. Rows are lipid features, columns are samples. Use this file to reproduce the preprocessing steps. |
| `meta.csv` | Sample annotations. |

## Samples

90 human plasma samples in three groups of 30: Normal, Hepatitis, Cirrhosis.
Samples were collected at Phenikaa University Hospital and Bach Mai Hospital
(Hanoi, Vietnam). Lipid extraction and LC-MS/MS analysis were performed at the
Applied Biomedical Research Center, Phenikaa University.

## Metadata columns

| Column | Unit | Description |
|---|---|---|
| `sample_name` | – | Sample identifier; matches the column names in the two matrix files |
| `Age` | years | Age at sampling |
| `Gender` | – | F, female; M, male |
| `AST` | U/L | Aspartate aminotransferase |
| `ALT` | U/L | Alanine aminotransferase |
| `RBC` | T/L (10¹²/L) | Red blood cell count |
| `HGB` | g/L | Hemoglobin |
| `WBC` | G/L (10⁹/L) | White blood cell count |
| `group` | – | Normal, Hepatitis, or Cirrhosis |

## Lipid features

223 features across the following classes: phosphatidylcholine (PC),
triacylglycerol (TG), lysophosphatidylcholine (LPC), sphingomyelin (SM),
cholesteryl ester (CE), acylcarnitine, lysophosphatidylethanolamine (LPE), and
ubiquinol/ubiquinone. Feature names are given as exported by the acquisition
software; both `PC 32:0` and `PC(O-34:1)` style names occur in this file, which
is representative of the naming heterogeneity the platform's lipid ID
conversion module is designed to handle.

## How to use

To reproduce the full workflow from raw data:

1. Create a LipidoX project.
2. Upload `matrix_raw.csv` (matrix) and `meta.csv` (metadata).
3. Run the preprocessing steps: data validation, IS normalization, NIST
   normalization, log₂ transformation.
4. Run PCA on the resulting matrix.

The pre-normalized matrix `matrix.csv` is provided so that the downstream
analyses can be checked without repeating the normalization. With the
log₂-transformed `matrix.csv`, the first two principal components explain
34.99% and 17.58% of the variance; for `matrix_raw.csv` the corresponding
values are 66.07% and 22.50%.

## Ethics

The study was approved by the Ethics Committees in Biomedical Research of Bach
Mai Hospital, Hanoi, Vietnam (Approval No. 7197/BM-HĐĐĐ) and Hanoi Medical
University, Hanoi, Vietnam (Approval No. 1826/BB-HĐĐĐ). The released data are
de-identified.

## Related resources

- LipidoX source code, version 1.0.0: https://github.com/pda-apd/lipidox
- The manuscript describing the platform.

## License

CC BY 4.0. See `LICENSE.txt`.

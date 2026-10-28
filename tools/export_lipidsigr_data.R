#!/usr/bin/env Rscript
# One-time export of LipidSigR internal annotation tables to .csv.gz,
# which the portal then converts to parquet (backend/services/lipidref/data/).
#
# Usage:
#   Rscript tools/export_lipidsigr_data.R <out_dir_csv_gz>
#
# Requires: LipidSigR (and its data.table import) installed.
# The portal NEVER needs R at runtime — this script runs once, offline.

args <- commandArgs(trailingOnly = TRUE)
out_dir <- if (length(args) >= 1) args[1] else file.path(tempdir(), "lipidref_export")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)

suppressMessages(library(LipidSigR))
suppressMessages(library(data.table))

ns <- asNamespace("LipidSigR")

dump_table <- function(obj, name) {
  dt <- as.data.table(obj)
  f <- file.path(out_dir, paste0(name, ".csv.gz"))
  fwrite(dt, f)
  cat(sprintf("%s: %d rows x %d cols -> %s\n", name, nrow(dt), ncol(dt), f))
}

dump_table(get("resource_id_anno", envir = ns), "resource_id_anno")
dump_table(get("lion_id_anno", envir = ns), "lion_id_anno")
dump_table(get("lion_char", envir = ns), "lion_char")
dump_table(get("gatom_lipid_db", envir = ns)$metabolites, "gatom_metabolites")

cat("DONE\n")

#!/usr/bin/env Rscript
# LipidSigR network runner for the web portal (pathway activity / GATOM / lipid reaction).
#
# Builds the deSp-like SummarizedExperiment from the project matrix + metadata
# (same annotation path as as_summarized_experiment(), i.e. lipid_annotation()
# which fills GATOM.abbr and LIPIDMAPS.reaction.abbr), then REPLACES the DE
# tables in metadata with the web's own DE results so the network reflects the
# table the user is looking at.
#
# Usage:
#   Rscript run_network.R <type> <matrix.csv> <meta.csv> <de.csv> <out_dir> \
#           <ref_group> <organism> [n_lipid] [p_cutoff] [FC_cutoff] [target_group] [group_col]
#
#   type         : pathway | gatom | lipid_reaction
#   de.csv       : feature,log2FC,pval,padj      (web DE export)
#   ref_group    : control group name as it appears in meta.csv
#   organism     : human | mouse
#   target_group : comparison group; when given, samples outside
#                  ref_group/target_group are dropped
#   group_col    : metadata column holding the group labels (default: group)
#
# Outputs (out_dir):
#   pathway: pathway_nodes.csv, pathway_edges.csv,
#            pathway_pathway_score.csv, pathway_zscore.csv
#   gatom  : gatom_nodes.csv, gatom_edges.csv,
#            gatom_reactions.csv, gatom_stats.csv
#   lipid_reaction: lipid_reaction_between_nodes.csv, _edges.csv, _reactions.csv,
#            _stats.csv (primary) and lipid_reaction_all_* for the second
#            display mode (all reactions of the significant classes)

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 7) {
  stop("Usage: Rscript run_network.R <type> <matrix.csv> <meta.csv> <de.csv> <out_dir> <ref_group> <organism> [n_lipid] [p_cutoff] [FC_cutoff] [target_group] [group_col]")
}
net_type   <- args[1]
matrix_path <- args[2]
meta_path  <- args[3]
de_path    <- args[4]
out_dir    <- args[5]
ref_group  <- args[6]
organism   <- args[7]
n_lipid    <- if (length(args) >= 8) as.integer(args[8]) else 100L
p_cutoff   <- if (length(args) >= 9) as.numeric(args[9]) else 0.05
FC_cutoff  <- if (length(args) >= 10) as.numeric(args[10]) else 1
target_group <- if (length(args) >= 11) args[11] else ""
group_col    <- if (length(args) >= 12 && nzchar(args[12])) args[12] else "group"

stopifnot(net_type %in% c("pathway", "gatom", "lipid_reaction"))
stopifnot(file.exists(matrix_path), file.exists(meta_path), file.exists(de_path))
dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)

suppressPackageStartupMessages({
  library(LipidSigR)
  library(SummarizedExperiment)
  library(rgoslin)
  library(dplyr)
})

cat("Reading abundance:", matrix_path, "\n")
abundance <- read.csv(matrix_path, check.names = FALSE, stringsAsFactors = FALSE)
meta_raw <- read.csv(meta_path, check.names = FALSE, stringsAsFactors = FALSE)
if (!"sample_name" %in% colnames(meta_raw)) colnames(meta_raw)[1] <- "sample_name"
if (!group_col %in% colnames(meta_raw)) {
  if (!"group" %in% colnames(meta_raw)) {
    stop("Group column '", group_col, "' not found in meta. Available: ",
         paste(colnames(meta_raw), collapse = ", "))
  }
  cat("Group column '", group_col, "' not in meta; falling back to 'group'.\n", sep = "")
  group_col <- "group"
}

# as_summarized_experiment() requires exactly sample_name/label_name/group/pair
# and exactly two groups, but project / manual / split metadata can carry any
# number of columns and groups. Build the 4-column group_info ourselves and
# keep only the two groups under comparison.
group_values <- as.character(meta_raw[[group_col]])
gi <- data.frame(
  sample_name = as.character(meta_raw$sample_name),
  label_name  = group_values,
  group       = group_values,
  pair        = NA_character_,
  stringsAsFactors = FALSE
)
gi <- gi[!is.na(gi$group) & nzchar(gi$group), , drop = FALSE]
if (!ref_group %in% gi$group) {
  stop("ref_group '", ref_group, "' not found in '", group_col, "'. Available: ",
       paste(unique(gi$group), collapse = ", "))
}
if (nzchar(target_group)) {
  if (!target_group %in% gi$group) {
    stop("target group '", target_group, "' not found in '", group_col, "'. Available: ",
         paste(unique(gi$group), collapse = ", "))
  }
  if (identical(target_group, ref_group)) stop("ref_group and target group must differ.")
  gi <- gi[gi$group %in% c(ref_group, target_group), , drop = FALSE]
}
keep_samples <- intersect(unique(gi$sample_name), colnames(abundance))
gi <- gi[match(keep_samples, gi$sample_name), , drop = FALSE]
if (any(table(gi$group) < 2)) stop("Each group needs at least 2 samples with data.")
abundance <- abundance[, c("feature", keep_samples), drop = FALSE]
cat("Keeping", nrow(gi), "samples | ctrl:", ref_group,
    "| exp:", if (nzchar(target_group)) target_group else "other", "\n")
gi$group <- ifelse(gi$group == ref_group, "ctrl", "exp")

cat("Parsing lipid names with rgoslin...\n")
gos <- tryCatch(
  as.data.frame(parseLipidNames(abundance$feature)),
  error = function(e) stop("rgoslin failed to parse any feature name: ", conditionMessage(e))
)
parsed <- gos$Original.Name[!is.na(gos$Original.Name) & gos$Original.Name != ""]
drops <- setdiff(abundance$feature, parsed)
if (length(drops)) {
  cat("Dropping", length(drops), "feature(s) rgoslin cannot parse:",
      paste(head(drops, 10), collapse = ", "), "\n")
  abundance <- abundance[abundance$feature %in% parsed, ]
}

# Networks do not use pairing; deSp's DE tables are replaced below anyway.
se <- as_summarized_experiment(
  abundance         = abundance,
  goslin_annotation = gos,
  group_info        = gi,
  se_type           = "de_two",
  paired_sample     = FALSE
)

# Replace the DE tables with the web's results (network thresholds/z-scores
# must match the DE table the user is looking at, not a re-run of deSp).
de <- read.csv(de_path, stringsAsFactors = FALSE)
missing_cols <- setdiff(c("feature", "log2FC", "pval", "padj"), colnames(de))
if (length(missing_cols)) stop("de.csv missing column(s): ", paste(missing_cols, collapse = ", "))
# nw_lipid_reaction() reads the test name from all_deSp_result$method to
# aggregate species into class-level statistics; the web DE export has no
# method column, so use the deSp default.
if (!"method" %in% colnames(de)) de$method <- "t-test"
features <- as.character(SummarizedExperiment::rowData(se)$feature)
de <- de[de$feature %in% features, , drop = FALSE]
if (nrow(de) == 0) stop("No DE feature overlaps the annotated lipid table.")

sig <- de[!is.na(de$pval) & de$pval < p_cutoff & abs(de$log2FC) > log2(FC_cutoff), , drop = FALSE]
sig_table <- if (nrow(sig) == 0) "No significant lipids." else sig

abund_df <- as.data.frame(SummarizedExperiment::assay(se))
abund_df <- cbind(feature = rownames(abund_df), abund_df, stringsAsFactors = FALSE)
rownames(abund_df) <- NULL

S4Vectors::metadata(se) <- list(
  all_deSp_result     = de,
  sig_deSp_result     = sig_table,
  processed_abundance = abund_df,
  significant         = "pval",
  p_cutoff            = p_cutoff,
  FC_cutoff           = FC_cutoff,
  transform           = "none"
)

set.seed(42)
nw <- NULL
if (net_type == "pathway") {
  cat("Running nw_pathway_activity | organism:", organism, "\n")
  nw <- nw_pathway_activity(se, organism = organism)
  prefix <- "pathway"
} else if (net_type == "gatom") {
  cat("Running nw_gatom | organism:", organism, "| n_lipid:", n_lipid,
      "| p:", p_cutoff, "| FC:", FC_cutoff, "\n")
  nw <- nw_gatom(
    se,
    organism       = organism,
    n_lipid        = n_lipid,
    sp_significant = "pval",
    sp_p_cutoff    = p_cutoff,
    sp_FC_cutoff   = FC_cutoff
  )
  prefix <- "gatom"
} else {
  cat("Running nw_lipid_reaction | organism:", organism,
      "| p:", p_cutoff, "| FC:", FC_cutoff, "\n")
  run_lipid_reaction <- function(show_all) {
    nw_lipid_reaction(
      se,
      organism           = organism,
      show_sp            = "all",
      show_all_reactions = show_all,
      sp_significant     = "pval",
      sp_p_cutoff        = p_cutoff,
      sp_FC_cutoff       = FC_cutoff,
      class_significant  = "pval",
      class_p_cutoff     = p_cutoff,
      class_FC_cutoff    = FC_cutoff
    )
  }
  # Primary display mode: reactions between significant classes only.
  nw <- run_lipid_reaction(FALSE)
  prefix <- "lipid_reaction_between"
}

if (is.null(nw) || !is.list(nw) || is.null(nw$table_node)) {
  stop("Network returned no result: ", paste(as.character(nw), collapse = " "))
}

write.csv(nw$table_node, file.path(out_dir, paste0(prefix, "_nodes.csv")), row.names = FALSE)
write.csv(nw$table_edge, file.path(out_dir, paste0(prefix, "_edges.csv")), row.names = FALSE)
if (net_type == "pathway") {
  if (!is.null(nw$table_pathway_score))
    write.csv(nw$table_pathway_score, file.path(out_dir, "pathway_pathway_score.csv"), row.names = FALSE)
  if (!is.null(nw$table_zScore))
    write.csv(nw$table_zScore, file.path(out_dir, "pathway_zscore.csv"), row.names = FALSE)
} else if (net_type == "gatom") {
  if (!is.null(nw$table_reaction))
    write.csv(nw$table_reaction, file.path(out_dir, "gatom_reactions.csv"), row.names = FALSE)
  if (!is.null(nw$table_stat))
    write.csv(nw$table_stat, file.path(out_dir, "gatom_stats.csv"), row.names = FALSE)
} else {
  if (!is.null(nw$table_reaction))
    write.csv(nw$table_reaction, file.path(out_dir, paste0(prefix, "_reactions.csv")), row.names = FALSE)
  if (!is.null(nw$table_stat))
    write.csv(nw$table_stat, file.path(out_dir, paste0(prefix, "_stats.csv")), row.names = FALSE)
  # Secondary display mode: all reactions of the significant classes.
  nw_all <- tryCatch(run_lipid_reaction(TRUE), error = function(e) {
    cat("All-reactions mode failed (keeping between only):", conditionMessage(e), "\n")
    NULL
  })
  if (!is.null(nw_all) && is.list(nw_all) && !is.null(nw_all$table_node)) {
    write.csv(nw_all$table_node, file.path(out_dir, "lipid_reaction_all_nodes.csv"), row.names = FALSE)
    write.csv(nw_all$table_edge, file.path(out_dir, "lipid_reaction_all_edges.csv"), row.names = FALSE)
    if (!is.null(nw_all$table_reaction))
      write.csv(nw_all$table_reaction, file.path(out_dir, "lipid_reaction_all_reactions.csv"), row.names = FALSE)
    if (!is.null(nw_all$table_stat))
      write.csv(nw_all$table_stat, file.path(out_dir, "lipid_reaction_all_stats.csv"), row.names = FALSE)
    cat("All-reactions mode:", nrow(nw_all$table_node), "nodes,", nrow(nw_all$table_edge), "edges\n")
  }
}

cat("Done:", nrow(nw$table_node), "nodes,", nrow(nw$table_edge), "edges ->", out_dir, "\n")

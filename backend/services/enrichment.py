import io
import json
import logging
import math
import os
import threading
import time
from functools import lru_cache

import networkx as nx
import numpy as np
import pandas as pd
from gseapy import enrichment_map
import gseapy as gp

from config import get_settings
from services.common import *
from storage import _normalize_rel_path

logger = logging.getLogger(__name__)
settings = get_settings()


def _run_with_timeout(func, timeout, label):
    """Run a blocking remote call without letting it pin a worker forever."""
    outcome = {}

    def target():
        try:
            outcome["value"] = func()
        except BaseException as exc:  # noqa: BLE001 - re-raised below
            outcome["error"] = exc

    worker = threading.Thread(target=target, daemon=True, name=f"external-{label}")
    worker.start()
    worker.join(max(1, int(timeout)))
    if worker.is_alive():
        logger.warning("%s exceeded %ss; using the local fallback.", label, timeout)
        return None
    if "error" in outcome:
        raise outcome["error"]
    return outcome.get("value")

# Feature-percent mode for GSEA payloads:
# 0 -> use Gene % (position on ranked list)
# 1 -> use Tag %  (overlap in gene set: hits / term size)
switch = 1

# Fixed database list exposed to users
DEFAULT_ENRICHMENT_DATABASES = [
    "GO_Biological_Process_2023",
    "GO_Cellular_Component_2023",
    "GO_Molecular_Function_2023",
    "KEGG_2021_Human",
    "Reactome_2022",
    "WikiPathway_2023_Human",
    "Human_Protein_Atlas_ver25_Biological_process",
    "Human_Protein_Atlas_ver25_Disease_involvement",
    "Human_Protein_Atlas_ver25_Protein_class",
]

# Map HPA virtual database names → GMT filename fragment
_HPA_DATABASE_GMT_FRAGMENT = {
    "Human_Protein_Atlas_ver25_Biological_process": "Biological_process",
    "Human_Protein_Atlas_ver25_Disease_involvement": "Disease_involvement",
    "Human_Protein_Atlas_ver25_Protein_class": "Protein_class",
}

# Location of local HPA GMT files (relative to this file)
_HPA_GMT_DIR = os.path.join(os.path.dirname(__file__), "HPA_GMT")

VALID_HPA_INPUT_TYPES = ("Gene", "Ensembl", "Uniprot")


def _safe_float(value, default=None):
    try:
        if value is None or value == "":
            return default
        out = float(value)
        if math.isnan(out) or math.isinf(out):
            return default
        return out
    except Exception:
        return default


def _safe_ratio_float(value, default=0.0):
    if isinstance(value, str) and "/" in value:
        lhs, _, rhs = value.partition("/")
        left_num = _safe_float(lhs)
        right_num = _safe_float(rhs)
        if left_num is None or right_num in (None, 0):
            return default
        return left_num / right_num
    return _safe_float(value, default)


def _clean_feature_name(value):
    text = str(value or "").strip()
    if not text or text.lower() == "nan":
        return ""
    return text


def _detect_identifier_type(features):
    clean = [feature for feature in features if feature]
    if not clean:
        return None
    numeric_count = sum(1 for feature in clean if feature.isdigit())
    return "entrezgene" if numeric_count / len(clean) >= 0.8 else None


def _map_features_to_genes(features):
    clean_features = [_clean_feature_name(feature) for feature in features]
    mapping = {feature: feature for feature in clean_features if feature}
    identifier_type = _detect_identifier_type(clean_features)
    if not identifier_type:
        return mapping
    if not settings.external_enrichment_enabled:
        # SSRF-02: operator opted out of sending feature names to NCBI.
        return mapping

    try:
        import mygene

        mg = mygene.MyGeneInfo()
        try:
            import httpx

            # biothings_client disables timeouts by default.
            mg.http_client = httpx.Client(timeout=settings.external_call_timeout_seconds)
            mg.http_client_setup = True
        except Exception:
            pass
        query_result = _run_with_timeout(
            lambda: mg.querymany(
                [feature for feature in clean_features if feature],
                scopes=identifier_type,
                fields="symbol",
                species="human",
                as_dataframe=False,
                returnall=False,
                verbose=False,
            ),
            settings.external_call_timeout_seconds,
            "mygene",
        )
        for item in query_result or []:
            query = _clean_feature_name(item.get("query"))
            symbol = _clean_feature_name(item.get("symbol"))
            if query and symbol:
                mapping[query] = symbol
    except Exception as exc:
        logger.warning("Feature-to-gene mapping fallback to raw feature names: %s", exc)

    return mapping


def _prepare_ranking_dataframe(source_results):
    rows = []
    raw_features = []

    for record in source_results or []:
        feature = _clean_feature_name(
            record.get("gene")
            or record.get("Gene")
            or record.get("feature")
            or record.get("Feature")
            or record.get("lipid")
            or record.get("Lipid")
        )
        logfc = _safe_float(record.get("log2fc", record.get("Log2FC", record.get("log_fc", record.get("LogFC")))))
        fdr = _safe_float(record.get("fdr", record.get("FDR")))
        if not feature or logfc is None or fdr is None:
            continue
        raw_features.append(feature)
        rows.append({"Feature": feature, "LogFC": logfc, "FDR": max(fdr, 1e-300)})

    if not rows:
        raise ValueError("No valid DAL records available for enrichment ranking.")

    gene_map = _map_features_to_genes(raw_features)
    ranking_df = pd.DataFrame(rows)
    ranking_df["Gene"] = ranking_df["Feature"].map(lambda feature: _clean_feature_name(gene_map.get(feature, feature)))
    ranking_df = ranking_df[ranking_df["Gene"].ne("")].copy()
    ranking_df["Rank"] = np.sign(ranking_df["LogFC"]) * -np.log10(ranking_df["FDR"].clip(lower=1e-300))
    ranking_df["AbsRank"] = ranking_df["Rank"].abs()

    ranking_df = ranking_df.sort_values(
        by=["AbsRank", "Rank", "LogFC", "Gene", "Feature"],
        ascending=[False, False, False, True, True],
    )
    ranking_df = ranking_df.drop_duplicates(subset=["Gene"], keep="first").copy()

    if ranking_df.empty or len(ranking_df) < 10:
        raise ValueError("Too few ranked genes after mapping and de-duplication for enrichment.")

    ranking_df = ranking_df.sort_values(by=["Rank", "LogFC", "Gene"], ascending=[False, False, True]).reset_index(drop=True)
    ranking_df["RankForGsea"] = ranking_df["Rank"] + np.linspace(0.0, 1e-9, len(ranking_df), endpoint=False)
    ranking_df["RankIndex"] = np.arange(1, len(ranking_df) + 1)
    return ranking_df


def _load_json_payload_from_storage(uid, project_id, url_or_path):
    """Load a JSON payload previously stored via upload_public.

    Accepts both relative paths and REST URLs like
    `/files/projects/{uid}/{project_id}/univariate_results/xxx.json`.
    """
    value = str(url_or_path or "").strip().lstrip("/")
    # Strip /files/ prefix from REST URLs
    if value.startswith("files/"):
        value = value[len("files/"):]
    rel_path = _normalize_rel_path(uid, project_id, value)
    return load_json_file(uid, project_id, rel_path)


def _load_source_ttest_run(uid, project_id, source_run_id=None):
    project_data = get_project_data(project_id)

    history = project_data.get("ttest_history") or []
    source_entry = None

    if source_run_id:
        source_entry = next((item for item in history if item.get("run_id") == source_run_id), None)

    if source_entry is None and history:
        source_entry = history[0]

    if source_entry is None and (project_data.get("univariate_results") or project_data.get("univariate_results_url")):
        source_entry = {
            "run_id": source_run_id or "adhoc",
            "name": "Current DAL",
            "target": project_data.get("target_meta"),
            "comparison": project_data.get("comparison"),
            "results": project_data.get("univariate_results") or [],
            "csv_url": project_data.get("univariate_csv_url"),
            "data_url": project_data.get("univariate_results_url"),
        }

    if source_entry is None:
        raise ValueError("No DAL result found for enrichment.")

    if not source_entry.get("results") and source_entry.get("data_url"):
        source_payload = _load_json_payload_from_storage(uid, project_id, source_entry["data_url"])
        source_entry = {**source_entry, "results": source_payload.get("results", [])}

    return project_data, source_entry


def _parse_fraction(value):
    if isinstance(value, str) and "/" in value:
        lhs, _, rhs = value.partition("/")
        left_num = _safe_float(lhs, 0)
        right_num = _safe_float(rhs, 0)
        return f"{int(left_num)}/{int(right_num)}" if right_num else value
    return value


def _resolve_feature_percent_mode(settings=None):
    if isinstance(settings, dict):
        requested = settings.get("feature_percent_mode", settings.get("switch", None))
        if requested is not None:
            try:
                return 1 if int(requested) == 1 else 0
            except Exception:
                pass
    try:
        return 1 if int(switch) == 1 else 0
    except Exception:
        return 0


def _clean_term_name(term, database):
    term_text = str(term or "")
    prefix = f"{database}__"
    if term_text.startswith(prefix):
        return term_text[len(prefix):]
    return term_text


def _build_term_payload(raw_term, database, row, result_detail, ranked_genes, feature_percent_mode=0):
    hits = result_detail.get("hits") or []
    if hits and isinstance(hits[0], (int, float, np.integer, np.floating)):
        matched_features = [ranked_genes[int(hit)] for hit in hits if int(hit) < len(ranked_genes)]
        hit_indices = [int(hit) for hit in hits if int(hit) < len(ranked_genes)]
    else:
        matched_features = [_clean_feature_name(hit) for hit in hits if _clean_feature_name(hit)]
        ranked_index = {gene: idx for idx, gene in enumerate(ranked_genes)}
        hit_indices = [int(ranked_index[gene]) for gene in matched_features if gene in ranked_index]

    running_score = result_detail.get("RES") or result_detail.get("res") or []
    running_score = [float(value) for value in running_score]

    display_term = _clean_term_name(raw_term, database)
    term_id = f"{database}::{display_term}"
    gene_percent = row.get("Gene %") or row.get("Gene_percent") or result_detail.get("gene_fraction") or ""
    tag_percent = row.get("Tag %") or row.get("Tag_percent") or result_detail.get("tag_fraction") or ""
    feature_percent = tag_percent if int(feature_percent_mode or 0) == 1 else gene_percent

    table_record = {
        "term_id": term_id,
        "Term": display_term,
        "Matched features": ", ".join(matched_features),
        "Database": database,
        "p-value": _safe_float(row.get("NOM p-val"), _safe_float(result_detail.get("pval"), 1.0)),
        "FDR": _safe_float(row.get("FDR q-val"), _safe_float(result_detail.get("fdr"), 1.0)),
        "NES": _safe_float(row.get("NES"), _safe_float(result_detail.get("nes"), 0.0)),
        "|NES|": abs(_safe_float(row.get("NES"), _safe_float(result_detail.get("nes"), 0.0)) or 0.0),
        "ES": _safe_float(row.get("ES"), _safe_float(result_detail.get("es"), 0.0)),
        "Feature count": len(matched_features),
        "Feature percent": _parse_fraction(feature_percent),
        "Tag percent": _parse_fraction(tag_percent),
    }

    detail_payload = {
        "term_id": term_id,
        "term": display_term,
        "database": database,
        "matched_features": matched_features,
        "hit_indices": hit_indices,
        "running_score": running_score,
        "nes": table_record["NES"],
        "es": table_record["ES"],
        "fdr": table_record["FDR"],
        "p_value": table_record["p-value"],
        "feature_count": table_record["Feature count"],
        "feature_percent": table_record["Feature percent"],
        "tag_percent": table_record["Tag percent"],
    }

    return table_record, detail_payload


def _build_network_payload(result_frames, term_details):
    if not result_frames:
        return {"nodes": [], "edges": []}

    combined = pd.concat(result_frames, ignore_index=True)
    if combined.empty:
        return {"nodes": [], "edges": []}

    try:
        nodes_df, edges_df = enrichment_map(combined)
    except Exception as exc:
        logger.warning("Unable to generate enrichment map: %s", exc)
        return {"nodes": [], "edges": []}

    if nodes_df.empty:
        return {"nodes": [], "edges": []}

    if edges_df is not None and not edges_df.empty:
        graph = nx.from_pandas_edgelist(
            edges_df,
            source="src_idx",
            target="targ_idx",
            edge_attr=["jaccard_coef", "overlap_coef", "overlap_genes"],
            create_using=nx.Graph(),
        )
    else:
        graph = nx.Graph()

    for node_idx in nodes_df.index.tolist():
        graph.add_node(int(node_idx))

    if graph.number_of_nodes() == 1:
        only_node = next(iter(graph.nodes))
        positions = {only_node: np.array([0.0, 0.0])}
    else:
        positions = nx.spiral_layout(graph)

    nodes = []
    for node_idx, row in nodes_df.iterrows():
        raw_term_id = str(row.get("Term") or "")
        term_info = term_details.get(raw_term_id, {})
        position = positions.get(int(node_idx), np.array([0.0, 0.0]))
        nodes.append(
            {
                "node_idx": int(node_idx),
                "term_id": raw_term_id,
                "term": term_info.get("term") or raw_term_id.split("::", 1)[-1],
                "database": term_info.get("database") or raw_term_id.split("::", 1)[0],
                "nes": _safe_float(row.get("NES"), 0.0),
                "fdr": _safe_float(row.get("FDR q-val"), 1.0),
                "hits_ratio": _safe_ratio_float(row.get("Hits_ratio"), 0.0),
                "x": float(position[0]),
                "y": float(position[1]),
            }
        )

    edges = []
    for _, row in edges_df.iterrows():
        overlap_genes = row.get("overlap_genes")
        if isinstance(overlap_genes, (list, tuple, np.ndarray)):
            overlap_genes = ", ".join(str(gene) for gene in overlap_genes)
        edges.append(
            {
                "src_idx": int(row.get("src_idx")),
                "targ_idx": int(row.get("targ_idx")),
                "jaccard_coef": _safe_float(row.get("jaccard_coef"), 0.0),
                "overlap_coef": _safe_float(row.get("overlap_coef"), 0.0),
                "overlap_genes": str(overlap_genes or ""),
            }
        )

    return {"nodes": nodes, "edges": edges}


def get_available_enrichment_databases():
    """Return the fixed set of databases available to users."""
    return DEFAULT_ENRICHMENT_DATABASES


def _build_ora_network_payload(result_records):
    """Build a network payload for ORA results using gene-overlap (Jaccard) edges."""
    if not result_records:
        return {"nodes": [], "edges": []}

    term_ids = [rec["term_id"] for rec in result_records]
    term_genes = {}
    for rec in result_records:
        genes_text = rec.get("Matched features", rec.get("Matched genes", ""))
        genes = set(g.strip() for g in str(genes_text).split(",") if g.strip())
        term_genes[rec["term_id"]] = genes

    graph = nx.Graph()
    for i in range(len(term_ids)):
        graph.add_node(i)

    edge_data = []
    for i in range(len(term_ids)):
        for j in range(i + 1, len(term_ids)):
            genes_i = term_genes[term_ids[i]]
            genes_j = term_genes[term_ids[j]]
            union = genes_i | genes_j
            if not union:
                continue
            jaccard = len(genes_i & genes_j) / len(union)
            if jaccard >= 0.3:
                graph.add_edge(i, j)
                edge_data.append({
                    "src_idx": i,
                    "targ_idx": j,
                    "jaccard_coef": round(jaccard, 4),
                    "overlap_coef": 0.0,
                    "overlap_genes": ", ".join(genes_i & genes_j),
                })

    if graph.number_of_nodes() == 0:
        return {"nodes": [], "edges": []}
    if graph.number_of_nodes() == 1:
        positions = {0: np.array([0.0, 0.0])}
    else:
        positions = nx.spiral_layout(graph)

    nodes = []
    for i, rec in enumerate(result_records):
        pos = positions.get(i, np.array([0.0, 0.0]))
        p_value = rec.get("p-value") or 1.0
        score = -math.log10(max(p_value, 1e-300))
        nodes.append({
            "node_idx": i,
            "term_id": rec["term_id"],
            "term": rec["Term"],
            "database": rec["Database"],
            "nes": round(score, 4),
            "fdr": _safe_float(p_value, 1.0),
            "hits_ratio": 0.0,
            "x": float(pos[0]),
            "y": float(pos[1]),
        })

    return {"nodes": nodes, "edges": edge_data}


def run_ttest_enrichment_ora(project_id, uid, settings, run_id=None, task_id=None):
    """Run Over-Representation Analysis (ORA) via gseapy.enrichr."""
    task_run_id = run_id or f"enrich_ora_{int(time.time() * 1000)}"
    source_run_id = settings.get("source_run_id")
    title = settings.get("title") or f"Enrichment ORA {time.strftime('%Y-%m-%d %H:%M:%S')}"
    feature_source = settings.get("feature_source") or "all"  # all | up | down
    input_type = settings.get("input_type") or "Gene"
    if input_type not in VALID_HPA_INPUT_TYPES:
        input_type = "Gene"
    selected_databases = [db_name for db_name in settings.get("databases") or [] if db_name]
    if not selected_databases:
        selected_databases = DEFAULT_ENRICHMENT_DATABASES[:1]

    project_data = get_project_data(project_id)
    existing_task = project_data.get("ttest_enrichment_task") or {}
    task_started_at = existing_task.get("started_at") or utc_now_iso()

    try:
        update_project(
            project_id,
            ttest_enrichment_task={
                "run_id": task_run_id,
                "task_id": task_id,
                "title": title,
                "source_run_id": source_run_id,
                "target": settings.get("target_meta"),
                "comparison": settings.get("comparison"),
                "method": "ORA",
                "feature_source": feature_source,
                "databases": selected_databases,
                "status": "running",
                "message": "Running ORA enrichment analysis.",
                "started_at": task_started_at,
            }
        )
        existing_history = project_data.get("ttest_enrichment_history") or []
        running_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "title": title,
            "date": task_started_at,
            "source_run_id": source_run_id,
            "target": settings.get("target_meta"),
            "comparison": settings.get("comparison"),
            "method": "ORA",
            "feature_source": feature_source,
            "databases": selected_databases,
            "status": "running",
            "message": "Running ORA enrichment analysis.",
        }
        update_project(
            project_id,
            ttest_enrichment_history=[running_entry]
            + [item for item in existing_history if item.get("run_id") != task_run_id]
        )

        project_data, source_entry = _load_source_ttest_run(uid, project_id, source_run_id=source_run_id)
        source_results = source_entry.get("results") or []
        if not source_results:
            raise ValueError("Selected DAL run does not contain result rows.")

        # Build background gene set from ALL features in the DEA result
        all_raw_features = []
        for record in source_results:
            feature = _clean_feature_name(
                record.get("gene") or record.get("Gene") or record.get("feature")
                or record.get("Feature") or record.get("lipid") or record.get("Lipid")
            )
            if feature:
                all_raw_features.append(feature)

        all_gene_map = _map_features_to_genes(all_raw_features)
        background_genes = list(dict.fromkeys(
            all_gene_map.get(f, f) for f in all_raw_features if all_gene_map.get(f, f)
        ))

        # Filter features by source direction for the query list
        raw_features = []
        for record in source_results:
            feature = _clean_feature_name(
                record.get("gene") or record.get("Gene") or record.get("feature")
                or record.get("Feature") or record.get("lipid") or record.get("Lipid")
            )
            logfc = _safe_float(
                record.get("log2fc", record.get("Log2FC", record.get("log_fc", record.get("LogFC"))))
            )
            if not feature or logfc is None:
                continue
            if feature_source == "up" and logfc <= 0:
                continue
            if feature_source == "down" and logfc >= 0:
                continue
            raw_features.append(feature)

        if not raw_features:
            raise ValueError("No features match the selected direction filter (up/down/all).")

        gene_map = _map_features_to_genes(raw_features)
        genes = list(dict.fromkeys(
            gene_map.get(f, f) for f in raw_features if gene_map.get(f, f)
        ))

        if not genes:
            raise ValueError("No valid gene names available for ORA after mapping.")

        result_records = []
        for database in selected_databases:
            logger.info("Running ORA for database: %s", database)
            is_hpa = database in _HPA_DATABASE_GMT_FRAGMENT
            if is_hpa:
                gmt_path = _get_hpa_gmt_path(database, input_type)
                if not gmt_path or not os.path.isfile(gmt_path):
                    logger.warning("HPA GMT file not found for %s / %s, skipping.", database, input_type)
                    continue
                gene_sets_arg = gmt_path
                bg_arg = background_genes or 20000
            else:
                if not settings.external_enrichment_enabled:
                    logger.warning(
                        "Skipping remote Enrichr database %s (EXTERNAL_ENRICHMENT_ENABLED=0).",
                        database,
                    )
                    continue
                gene_sets_arg = database
                bg_arg = background_genes or 20000

            try:
                enr = _run_with_timeout(
                    lambda: gp.enrich(
                        gene_list=genes,
                        gene_sets=gene_sets_arg,
                        background=bg_arg,
                        outdir=None,
                        no_plot=True,
                    ),
                    settings.external_call_timeout_seconds,
                    f"gseapy-{database}",
                )
                if enr is None:
                    continue
                result_df = enr.results
            except Exception as exc:
                logger.warning("ORA failed for database %s: %s", database, exc)
                continue

            if result_df is None or result_df.empty:
                continue

            for _, row in result_df.iterrows():
                raw_term = str(row.get("Term") or "")
                display_term = _clean_term_name(raw_term, database)
                term_id = f"{database}::{display_term}"

                overlap_str = str(row.get("Overlap") or "0/0")
                if "/" in overlap_str:
                    parts = overlap_str.split("/")
                    matched_count = int(parts[0]) if parts[0].isdigit() else 0
                else:
                    matched_count = int(_safe_float(row.get("Overlap"), 0) or 0)

                genes_str = str(row.get("Lead_genes") or row.get("Genes") or "")
                matched_genes = [g.strip() for g in genes_str.replace(",", ";").split(";") if g.strip()]

                p_adj = _safe_float(row.get("Adjusted P-value"), _safe_float(row.get("P-value"), 1.0))

                result_records.append({
                    "term_id": term_id,
                    "Term": display_term,
                    "Database": database,
                    "p-value": p_adj if p_adj is not None else 1.0,
                    "Feature count": matched_count,
                    "Matched features": ", ".join(matched_genes),
                })

        if not result_records:
            raise ValueError("No ORA results returned for the selected databases.")

        result_table = (
            pd.DataFrame(result_records)
            .sort_values(by="p-value", ascending=True)
            .reset_index(drop=True)
        )
        network_payload = _build_ora_network_payload(result_records)
        export_table = result_table[["Term", "Database", "p-value", "Feature count", "Matched features"]].copy()

        payload = {
            "run_id": task_run_id,
            "title": title,
            "date": utc_now_iso(),
            "source_run_id": source_entry.get("run_id"),
            "source_name": source_entry.get("name") or "DAL",
            "target": source_entry.get("target") or settings.get("target_meta"),
            "comparison": source_entry.get("comparison") or settings.get("comparison"),
            "method": "ORA",
            "feature_source": feature_source,
            "databases": selected_databases,
            "results_table": make_json_safe(result_table.to_dict(orient="records")),
            "network": make_json_safe(network_payload),
        }

        csv_buffer = io.StringIO()
        csv_safe_frame(export_table).to_csv(csv_buffer, index=False)

        data_dest = f"projects/{uid}/{project_id}/ttest_enrichment_{task_run_id}.json"
        csv_dest = f"projects/{uid}/{project_id}/ttest_enrichment_{task_run_id}.csv"

        data_url = upload_public(
            uid, project_id, data_dest,
            json.dumps(make_json_safe(payload), ensure_ascii=False, allow_nan=False),
            "application/json",
        )
        csv_url = upload_public(
            uid, project_id, csv_dest,
            csv_buffer.getvalue().encode("utf-8-sig"),
            "text/csv; charset=utf-8",
        )

        significant_count = int((result_table["p-value"] < 0.05).sum())
        history_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "title": title,
            "date": payload["date"],
            "source_run_id": payload["source_run_id"],
            "source_name": payload["source_name"],
            "target": payload["target"],
            "comparison": payload["comparison"],
            "method": "ORA",
            "feature_source": feature_source,
            "databases": selected_databases,
            "term_count": int(len(result_table)),
            "significant_count": significant_count,
            "csv_url": csv_url,
            "data_url": data_url,
            "status": "done",
            "message": "ORA enrichment completed successfully.",
        }

        existing_history = project_data.get("ttest_enrichment_history") or []
        next_history = [history_entry] + [item for item in existing_history if item.get("run_id") != task_run_id]
        update_project(
            project_id,
            ttest_enrichment_history=next_history,
            ttest_enrichment_task={
                "run_id": task_run_id,
                "task_id": task_id,
                "title": title,
                "source_run_id": payload["source_run_id"],
                "target": payload["target"],
                "comparison": payload["comparison"],
                "method": "ORA",
                "feature_source": feature_source,
                "databases": selected_databases,
                "status": "done",
                "message": "ORA enrichment completed successfully.",
                "started_at": task_started_at,
                "completed_at": utc_now_iso(),
                "term_count": int(len(result_table)),
                "significant_count": significant_count,
                "csv_url": csv_url,
                "data_url": data_url,
            },
        )

        logger.info(
            "ORA enrichment done | project_id=%s run_id=%s term_count=%s significant_count=%s",
            project_id,
            task_run_id,
            int(len(result_table)),
            significant_count,
        )

        payload["csv_url"] = csv_url
        payload["data_url"] = data_url
        payload["history_entry"] = history_entry
        return payload

    except Exception as exc:
        logger.error("ORA enrichment error: %s", exc)
        logger.exception("ORA enrichment failed")
        update_project(
            project_id,
            ttest_enrichment_task={
                "run_id": task_run_id,
                "task_id": task_id,
                "title": title,
                "source_run_id": source_run_id,
                "target": settings.get("target_meta"),
                "comparison": settings.get("comparison"),
                "method": "ORA",
                "feature_source": feature_source,
                "databases": selected_databases,
                "status": "error",
                "message": str(exc),
                "started_at": task_started_at,
                "completed_at": utc_now_iso(),
            }
        )
        project_data = get_project_data(project_id)
        error_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "title": title,
            "date": task_started_at or utc_now_iso(),
            "source_run_id": source_run_id,
            "target": settings.get("target_meta"),
            "comparison": settings.get("comparison"),
            "method": "ORA",
            "feature_source": feature_source,
            "databases": selected_databases,
            "status": "error",
            "message": str(exc),
        }
        update_project(
            project_id,
            ttest_enrichment_history=[error_entry]
            + [
                item
                for item in (project_data.get("ttest_enrichment_history") or [])
                if item.get("run_id") != task_run_id
            ]
        )
        raise


def _get_hpa_gmt_path(database_name, input_type):
    """Return the absolute path to the local HPA GMT file."""
    fragment = _HPA_DATABASE_GMT_FRAGMENT.get(database_name)
    if not fragment:
        return None
    safe_input_type = input_type if input_type in VALID_HPA_INPUT_TYPES else "Gene"
    filename = f"HPA_{fragment}_{safe_input_type}.gmt"
    return os.path.join(_HPA_GMT_DIR, filename)


def run_ttest_enrichment(project_id, uid, settings, run_id=None, task_id=None):
    task_run_id = run_id or f"enrich_{int(time.time() * 1000)}"
    source_run_id = settings.get("source_run_id")
    title = settings.get("title") or f"Enrichment {time.strftime('%Y-%m-%d %H:%M:%S')}"
    method = settings.get("method") or settings.get("GSEA") or "GSEA"
    ranking_metric = settings.get("ranking_metric") or "sign(Log2FC) x -Log10FDR"
    input_type = settings.get("input_type") or "Gene"
    if input_type not in VALID_HPA_INPUT_TYPES:
        input_type = "Gene"
    selected_databases = [db_name for db_name in settings.get("databases") or [] if db_name]
    if not selected_databases:
        selected_databases = DEFAULT_ENRICHMENT_DATABASES[:1]
    feature_percent_mode = _resolve_feature_percent_mode(settings)

    project_data = get_project_data(project_id)
    existing_task = project_data.get("ttest_enrichment_task") or {}
    task_started_at = existing_task.get("started_at") or utc_now_iso()

    try:
        update_project(
            project_id,
            ttest_enrichment_task={
                "run_id": task_run_id,
                "task_id": task_id,
                "title": title,
                "source_run_id": source_run_id,
                "target": settings.get("target_meta"),
                "comparison": settings.get("comparison"),
                "method": method,
                "ranking_metric": ranking_metric,
                "databases": selected_databases,
                "status": "running",
                "message": "Running enrichment analysis.",
                "started_at": task_started_at,
            }
        )
        existing_history = project_data.get("ttest_enrichment_history") or []
        running_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "title": title,
            "date": task_started_at,
            "source_run_id": source_run_id,
            "target": settings.get("target_meta"),
            "comparison": settings.get("comparison"),
            "method": method,
            "ranking_metric": ranking_metric,
            "databases": selected_databases,
            "status": "running",
            "message": "Running enrichment analysis.",
        }
        update_project(
            project_id,
            ttest_enrichment_history=[running_entry]
            + [item for item in existing_history if item.get("run_id") != task_run_id]
        )

        project_data, source_entry = _load_source_ttest_run(uid, project_id, source_run_id=source_run_id)

        source_results = source_entry.get("results") or []
        if not source_results:
            raise ValueError("Selected DAL run does not contain result rows.")

        ranking_df = _prepare_ranking_dataframe(source_results)
        ranked_genes = ranking_df["Gene"].tolist()
        rnk_gene = ranking_df[["Gene", "RankForGsea"]].rename(columns={"RankForGsea": "Rank"})

        # For HPA Ensembl/Uniprot input types, rank by Feature identifier directly
        if input_type != "Gene":
            rnk_hpa = ranking_df[["Feature", "RankForGsea"]].rename(
                columns={"Feature": "Gene", "RankForGsea": "Rank"}
            )
        else:
            rnk_hpa = rnk_gene

        result_records = []
        term_details = {}
        raw_result_frames = []

        for database in selected_databases:
            logger.info("Running enrichment for database: %s", database)
            is_hpa = database in _HPA_DATABASE_GMT_FRAGMENT
            if is_hpa:
                gmt_path = _get_hpa_gmt_path(database, input_type)
                if not gmt_path or not os.path.isfile(gmt_path):
                    logger.warning("HPA GMT file not found for %s / %s, skipping.", database, input_type)
                    continue
                gene_sets_arg = gmt_path
                rnk = rnk_hpa
            else:
                gene_sets_arg = database
                rnk = rnk_gene
            pre_res = gp.prerank(
                rnk=rnk,
                gene_sets=gene_sets_arg,
                processes=4,
                permutation_num=1000,
                outdir=None,
                seed=42,
                verbose=False,
            )
            result_df = pre_res.res2d.copy().reset_index(drop=True)
            if result_df.empty:
                continue

            raw_frame = result_df.copy()
            raw_frame["Term"] = raw_frame["Term"].map(lambda term: f"{database}::{_clean_term_name(term, database)}")
            raw_result_frames.append(raw_frame)

            for _, row in result_df.iterrows():
                raw_term = str(row.get("Term") or "")
                detail = pre_res.results.get(raw_term) or pre_res.results.get(f"{database}__{raw_term}") or {}
                table_record, detail_payload = _build_term_payload(
                    raw_term,
                    database,
                    row,
                    detail,
                    ranked_genes,
                    feature_percent_mode=feature_percent_mode,
                )
                result_records.append(table_record)
                term_details[table_record["term_id"]] = detail_payload

        if not result_records:
            raise ValueError("No enrichment result returned for the selected databases.")

        result_table = pd.DataFrame(result_records).sort_values(by=["|NES|", "FDR"], ascending=[False, True]).reset_index(drop=True)
        network_payload = _build_network_payload(raw_result_frames, term_details)
        if "Matched features" not in result_table.columns and "Matched genes" in result_table.columns:
            result_table["Matched features"] = result_table["Matched genes"]
        if "Feature count" not in result_table.columns:
            if "Count" in result_table.columns:
                result_table["Feature count"] = result_table["Count"]
            elif "Gene count" in result_table.columns:
                result_table["Feature count"] = result_table["Gene count"]
            else:
                result_table["Feature count"] = 0
        if "Feature percent" not in result_table.columns:
            if "Percent" in result_table.columns:
                result_table["Feature percent"] = result_table["Percent"]
            elif "Gene percent" in result_table.columns:
                result_table["Feature percent"] = result_table["Gene percent"]
            else:
                result_table["Feature percent"] = ""

        export_table = result_table[[
            "Term",
            "Database",
            "Matched features",
            "p-value",
            "FDR",
            "NES",
            "|NES|",
            "ES",
            "Feature count",
            "Feature percent",
            "Tag percent",
        ]].copy()

        payload = {
            "run_id": task_run_id,
            "title": title,
            "date": utc_now_iso(),
            "source_run_id": source_entry.get("run_id"),
            "source_name": source_entry.get("name") or "DAL",
            "target": source_entry.get("target") or settings.get("target_meta"),
            "comparison": source_entry.get("comparison") or settings.get("comparison"),
            "method": method,
            "ranking_metric": ranking_metric,
            "feature_percent_mode": feature_percent_mode,
            "databases": selected_databases,
            "ranking_preview": make_json_safe(
                ranking_df[["Feature", "Rank", "LogFC", "FDR", "Gene", "RankIndex"]]
                .rename(columns={"Gene": "Mapped feature"})
                .to_dict(orient="records")
            ),
            "results_table": make_json_safe(result_table.to_dict(orient="records")),
            "term_details": make_json_safe(term_details),
            "network": make_json_safe(network_payload),
        }

        csv_buffer = io.StringIO()
        csv_safe_frame(export_table).to_csv(csv_buffer, index=False)

        data_dest = f"projects/{uid}/{project_id}/ttest_enrichment_{task_run_id}.json"
        csv_dest = f"projects/{uid}/{project_id}/ttest_enrichment_{task_run_id}.csv"

        data_url = upload_public(
            uid, project_id, data_dest,
            json.dumps(make_json_safe(payload), ensure_ascii=False, allow_nan=False),
            "application/json",
        )
        csv_url = upload_public(
            uid, project_id, csv_dest,
            csv_buffer.getvalue().encode("utf-8-sig"),
            "text/csv; charset=utf-8",
        )

        history_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "title": title,
            "date": payload["date"],
            "source_run_id": payload["source_run_id"],
            "source_name": payload["source_name"],
            "target": payload["target"],
            "comparison": payload["comparison"],
            "method": method,
            "ranking_metric": ranking_metric,
            "databases": selected_databases,
            "term_count": int(len(result_table)),
            "significant_count": int((result_table["FDR"] < 0.05).sum()),
            "csv_url": csv_url,
            "data_url": data_url,
            "status": "done",
            "message": "Enrichment completed successfully.",
        }

        existing_history = project_data.get("ttest_enrichment_history") or []
        next_history = [history_entry] + [item for item in existing_history if item.get("run_id") != task_run_id]
        update_project(
            project_id,
            ttest_enrichment_history=next_history,
            ttest_enrichment_task={
                "run_id": task_run_id,
                "task_id": task_id,
                "title": title,
                "source_run_id": payload["source_run_id"],
                "source_name": payload["source_name"],
                "target": payload["target"],
                "comparison": payload["comparison"],
                "method": method,
                "ranking_metric": ranking_metric,
                "databases": selected_databases,
                "status": "done",
                "message": "Enrichment completed successfully.",
                "started_at": task_started_at,
                "completed_at": utc_now_iso(),
                "term_count": int(len(result_table)),
                "significant_count": int((result_table["FDR"] < 0.05).sum()),
                "csv_url": csv_url,
                "data_url": data_url,
            },
        )

        logger.info(
            "GSEA enrichment done | project_id=%s run_id=%s term_count=%s significant_count=%s",
            project_id,
            task_run_id,
            int(len(result_table)),
            int((result_table["FDR"] < 0.05).sum()),
        )

        payload["csv_url"] = csv_url
        payload["data_url"] = data_url
        payload["history_entry"] = history_entry
        return payload

    except Exception as exc:
        logger.error("T-test enrichment error: %s", exc)
        logger.exception("T-test enrichment failed")
        update_project(
            project_id,
            ttest_enrichment_task={
                "run_id": task_run_id,
                "task_id": task_id,
                "title": title,
                "source_run_id": source_run_id,
                "target": settings.get("target_meta"),
                "comparison": settings.get("comparison"),
                "method": method,
                "ranking_metric": ranking_metric,
                "databases": selected_databases,
                "status": "error",
                "message": str(exc),
                "started_at": task_started_at,
                "completed_at": utc_now_iso(),
            }
        )
        project_data = get_project_data(project_id)
        error_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "title": title,
            "date": task_started_at or utc_now_iso(),
            "source_run_id": source_run_id,
            "target": settings.get("target_meta"),
            "comparison": settings.get("comparison"),
            "method": method,
            "ranking_metric": ranking_metric,
            "databases": selected_databases,
            "status": "error",
            "message": str(exc),
        }
        update_project(
            project_id,
            ttest_enrichment_history=[error_entry]
            + [
                item
                for item in (project_data.get("ttest_enrichment_history") or [])
                if item.get("run_id") != task_run_id
            ]
        )
        raise

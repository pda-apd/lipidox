"""LipidSigR network CSV tables -> vis-network spec JSON (pathway / gatom / lipid_reaction).

Ported 1:1 from the lab's lipid_paper_pipeline `r_tables_to_spec.py`
(df_to_vis_nodes / df_to_vis_edges / the pathway extra builder), trimmed to the
network types the portal exposes.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd

LABEL_OFFSET = 8


def _df_to_vis_nodes(nodes_df: pd.DataFrame) -> list[dict]:
    out = []
    for _, r in nodes_df.iterrows():
        node = {"id": str(r["id"]), "label": str(r.get("label", r["id"]))}
        node["shape"] = "square" if str(r.get("shape", "dot")) == "square" else "dot"
        color = r.get("color", None)
        if isinstance(color, str) and color.startswith("#"):
            node["color"] = color
        try:
            size = float(r.get("size", 20))
            if not np.isfinite(size):
                size = 20
        except Exception:
            size = 20
        node["size"] = max(5, size)
        node["_origSize"] = node["size"]
        title = r.get("title", "")
        node["title"] = "" if pd.isna(title) else str(title).replace("</br>", "<br>")
        if pd.notna(r.get("group", None)):
            node["group"] = str(r["group"])
        out.append(node)
    return out


def _df_to_vis_edges(edges_df: pd.DataFrame) -> list[dict]:
    out = []
    pairs = {(str(r["from"]), str(r["to"])) for _, r in edges_df.iterrows()}
    bidir = {}
    for a, b in pairs:
        if a != b and (b, a) in pairs:
            bidir[(a, b)] = 1 if a < b else -1
    for i, r in edges_df.iterrows():
        a, b = str(r["from"]), str(r["to"])
        edge = {"id": f"e{i}", "from": a, "to": b}
        label = r.get("label", "")
        if pd.notna(label) and str(label).strip() not in ("", "nan"):
            edge["label"] = str(label)
        color = r.get("color", None)
        if isinstance(color, str) and color.startswith("#"):
            edge["color"] = color
        try:
            width = float(r.get("width", 1))
            if not np.isfinite(width):
                width = 3
        except Exception:
            width = 1
        edge["width"] = max(0.5, min(8, width))
        edge["_origWidth"] = edge["width"]
        arrows = r.get("arrows", "to")
        edge["arrows"] = "" if pd.isna(arrows) else str(arrows)
        title = r.get("title", "")
        if pd.notna(title):
            edge["title"] = str(title).replace("</br>", "<br>")
        if (a, b) in bidir:
            edge["font"] = {"vadjust": bidir[(a, b)] * LABEL_OFFSET}
        out.append(edge)
    return out


def _extra_from(df: pd.DataFrame | None, cols: list[str], chain_field: str) -> dict:
    rows = []
    if df is not None and not df.empty:
        for _, r in df.iterrows():
            rows.append({c: (None if pd.isna(r.get(c, None)) else str(r.get(c, ""))) for c in cols})
    return {"rows": rows, "columns": cols, "chainField": chain_field}


def _edge_reaction_lookup(edges_df: pd.DataFrame | None) -> dict:
    out: dict[tuple[str, str], list[tuple[str, str]]] = {}
    if edges_df is None:
        return out
    for _, r in edges_df.iterrows():
        title = str(r.get("title", "")).replace("</br>", "<br>")
        rec = {}
        for line in re.split(r"<br\s*/?>|\n", title):
            if ":" in line:
                k, v = line.split(":", 1)
                rec[k.strip().lower()] = v.strip()
        reaction = rec.get("reaction")
        if not reaction:
            continue
        item = (reaction, rec.get("enzyme", ""))
        bucket = out.setdefault((str(r["from"]), str(r["to"])), [])
        if item not in bucket:
            bucket.append(item)
    return out


def _chain_reaction_columns(chain: str, lookup: dict) -> tuple[str, str]:
    parts = [p.strip() for p in str(chain).split("->")]
    reactions, enzymes = [], []
    for a, b in zip(parts, parts[1:]):
        hits = lookup.get((a, b), [])
        if not hits:
            continue
        step = f"[{a} -> {b}] "
        reactions.append(step + "; ".join(h[0] for h in hits))
        ec = [h[1] for h in hits if h[1]]
        if ec:
            enzymes.append(step + "; ".join(ec))
    return " | ".join(reactions), " | ".join(enzymes)


def _pathway_extra(score_df: pd.DataFrame | None, edges_df: pd.DataFrame | None) -> dict:
    cols = ["path_name", "reaction_chain", "pathway_score", "genes"]
    if score_df is None or score_df.empty:
        return _extra_from(score_df, cols, "reaction_chain")
    lookup = _edge_reaction_lookup(edges_df)
    rows = []
    for _, r in score_df.iterrows():
        chain = None if pd.isna(r.get("reaction_chain")) else str(r["reaction_chain"])
        reaction, enzyme = _chain_reaction_columns(chain or "", lookup)
        rows.append({
            "path_name": None if pd.isna(r.get("path_name")) else str(r["path_name"]),
            "reaction_chain": chain,
            "pathway_score": None if pd.isna(r.get("pathway_score")) else str(r["pathway_score"]),
            "genes": None if pd.isna(r.get("genes")) else str(r["genes"]),
            "reaction": reaction,
            "enzyme": enzyme,
        })
    return {
        "rows": rows,
        "columns": cols + ["reaction", "enzyme"],
        "chainField": "reaction_chain",
    }


def _read(tables_dir: Path, name: str) -> pd.DataFrame | None:
    path = tables_dir / name
    return pd.read_csv(path) if path.exists() else None


def build_spec(
    network_type: str, tables_dir: str | Path, pair: str, lipid_mode: str = "between"
) -> dict:
    """Return the vis-network spec dict for `network_type` (pathway | gatom | lipid_reaction)."""
    t = Path(tables_dir)
    mode = "all" if str(lipid_mode).lower() == "all" else "between"
    if network_type == "lipid_reaction":
        prefix = f"lipid_reaction_{mode}"
    else:
        prefix = network_type if network_type in ("pathway", "gatom") else "pathway"
    nodes_df = _read(t, f"{prefix}_nodes.csv")
    edges_df = _read(t, f"{prefix}_edges.csv")
    if nodes_df is None or nodes_df.empty:
        raise ValueError("The network returned no nodes (check the DE thresholds or the mapping).")
    if edges_df is None or edges_df.empty:
        raise ValueError("The network returned no edges (check the DE thresholds or the mapping).")

    if network_type == "pathway":
        title = f"Pathway activity network \u2014 {pair}"
        extra = _pathway_extra(_read(t, "pathway_pathway_score.csv"), edges_df)
    elif network_type == "gatom":
        title = f"GATOM network \u2014 {pair}"
        extra = _extra_from(_read(t, "gatom_reactions.csv"), ["Path", "Reaction", "Enzyme", "Gene"], "Path")
    else:
        suffix = " (all reactions)" if mode == "all" else ""
        title = f"Lipid reaction network{suffix} \u2014 {pair}"
        extra = _extra_from(
            _read(t, f"lipid_reaction_{mode}_reactions.csv"),
            ["Path", "Reaction", "Enzyme", "Gene"],
            "Path",
        )

    spec = {
        "title": title,
        "network_type": network_type,
        "nodes": _df_to_vis_nodes(nodes_df),
        "edges": _df_to_vis_edges(edges_df),
        "extra": extra,
    }
    if network_type == "lipid_reaction":
        spec["lipid_mode"] = mode
    return spec

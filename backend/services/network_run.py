"""LipidSigR network runs for the portal (pathway activity / GATOM / lipid reaction).

Computes the network in R (needs `Rscript` + LipidSigR), converts the R CSV
tables to a vis-network spec, and renders the lab's standalone network HTML
that the DE page shows inside its result frame.

The SummarizedExperiment is built by `tools/run_network.R` from the project
matrix + metadata; its DE tables are replaced with the web's own DE results so
the network matches the table the user is looking at.
"""
from __future__ import annotations

import html
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import pandas as pd

from services.common import *
from services.enrichment import _load_source_ttest_run
from services.lipid_enrichment import _extract_feature_stats
from services.network_spec import build_spec

logger = logging.getLogger(__name__)

_TEMPLATE = Path(__file__).resolve().parent / "network_html" / "network_vis.html.tmpl"
_R_SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "run_network.R"
_RUN_TIMEOUT_SECONDS = 20 * 60
_NETWORK_TYPES = ("pathway", "gatom", "lipid_reaction")
_TYPE_LABELS = {
    "pathway": "Pathway activity",
    "gatom": "GATOM",
    "lipid_reaction": "Lipid reaction",
}
_ORGANISMS = ("human", "mouse")
_LIPID_MODES = {
    "between": "Reactions between significant classes",
    "all": "All reactions of significant classes",
}
_SELECTION_PRESETS = {
    "pathway": (
        "Reaction chains",
        "Check rows to highlight chain. Right-click node \u2192 highlight all chains containing it.",
    ),
    "gatom": (
        "Reactions",
        "Check rows to highlight path. Right-click node \u2192 highlight all paths containing it. Ctrl+click nodes for multi-select.",
    ),
    "lipid_reaction": (
        "Reactions",
        "Check rows to highlight the reaction between two lipid classes. Right-click a class node \u2192 highlight all reactions containing it.",
    ),
}


def find_rscript() -> str | None:
    """Locate Rscript (env RSCRIPT_PATH, PATH, then the usual Windows install)."""
    env = os.environ.get("RSCRIPT_PATH")
    if env and Path(env).is_file():
        return env
    found = shutil.which("Rscript")
    if found:
        return found
    for candidate in (
        Path(r"C:\Program Files\R\R-4.5.3\bin\Rscript.exe"),
        Path("/usr/bin/Rscript"),
        Path("/usr/local/bin/Rscript"),
    ):
        if candidate.is_file():
            return str(candidate)
    r_root = Path(r"C:\Program Files\R")
    if r_root.is_dir():
        versions = sorted((p / "bin" / "Rscript.exe" for p in r_root.glob("R-*")), reverse=True)
        for candidate in versions:
            if candidate.is_file():
                return str(candidate)
    return None


def r_available() -> dict:
    rscript = find_rscript()
    return {"available": bool(rscript), "rscript": rscript}


def _mode_switch_html(mode: str, has_other: bool) -> str:
    parts = []
    if has_other:
        options = "".join(
            f'<option value="{value}"{" selected" if value == mode else ""}>{label}</option>'
            for value, label in _LIPID_MODES.items()
        )
        parts.append(
            '<label class="mode-switch">Display '
            f'<select id="modeSelect" onchange="setMode(this.value)">{options}</select></label>'
        )
    parts.append(
        '<label class="hide-circles" title="Hide species (circle) nodes and their links">'
        '<input type="checkbox" id="hideCircles" onchange="toggleCircles()"> Hide circles</label>'
    )
    return "".join(parts)


def _json_for_script(value) -> str:
    """JSON that cannot close the surrounding <script> element."""
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ": "))
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


def _build_html(spec: dict, meta: dict | None = None, other: dict | None = None) -> str:
    label, hint = _SELECTION_PRESETS[spec["network_type"]]
    template = _TEMPLATE.read_text(encoding="utf-8")
    extra = dict(spec["extra"])
    if meta:
        extra["meta"] = meta
    other_payload = "null"
    if spec["network_type"] == "lipid_reaction" and other:
        other_extra = dict(other["extra"])
        if meta:
            other_extra["meta"] = meta
        other_payload = _json_for_script({
            "mode": other.get("lipid_mode", "all"),
            "title": other["title"],
            "nodes": other["nodes"],
            "edges": other["edges"],
            "extra": other_extra,
        })
    mode_switch = (
        _mode_switch_html(spec.get("lipid_mode", "between"), bool(other))
        if spec["network_type"] == "lipid_reaction" else ""
    )
    return (
        template.replace("@@TITLE@@", html.escape(str(spec["title"])))
        .replace("@@NETWORK_TYPE@@", html.escape(str(spec["network_type"])))
        .replace("@@LIPID_MODE@@", html.escape(str(spec.get("lipid_mode", ""))))
        .replace("@@NODES@@", _json_for_script(spec["nodes"]))
        .replace("@@EDGES@@", _json_for_script(spec["edges"]))
        .replace("@@EXTRA@@", _json_for_script(extra))
        .replace("@@OTHER_MODE@@", other_payload)
        .replace("@@SELECTION_LABEL@@", html.escape(label))
        .replace("@@SELECTION_HINT@@", html.escape(hint))
        .replace("@@MODE_SWITCH@@", mode_switch)
    )


def _write_de_csv(stats_rows: list[dict], path: Path) -> int:
    records = []
    for row in stats_rows:
        feature = row.get("Feature")
        if not feature:
            continue
        records.append({
            "feature": feature,
            "log2FC": row.get("LogFC"),
            "pval": row.get("PValue"),
            "padj": row.get("FDR"),
        })
    frame = pd.DataFrame(records, columns=["feature", "log2FC", "pval", "padj"])
    csv_safe_frame(frame).to_csv(path, index=False)
    return len(frame)


def run_network(project_id, uid, settings, run_id=None, task_id=None):
    """Background runner for a LipidSigR network (pathway | gatom | lipid_reaction)."""
    task_run_id = run_id or f"network_{int(time.time() * 1000)}"
    network_type = str(settings.get("network_type") or "pathway").lower()
    if network_type not in _NETWORK_TYPES:
        raise ValueError(f"network_type must be one of {_NETWORK_TYPES}")
    organism = str(settings.get("organism") or "human").lower()
    if organism not in _ORGANISMS:
        organism = "human"
    ref_group = str(settings.get("ref_group") or "").strip()
    n_lipid = int(settings.get("n_lipid") or 100)
    p_cutoff = float(settings.get("p_cutoff") or 0.05)
    fc_cutoff = float(settings.get("fc_cutoff") or 1)
    matrix_path = settings.get("matrix_path")
    meta_path = settings.get("meta_path")
    title = settings.get("title") or f"{_TYPE_LABELS[network_type]} network {time.strftime('%Y-%m-%d %H:%M:%S')}"
    comparison = settings.get("comparison")
    # Backend metadata column holding the DE groups (manual / split runs write
    # a derived column); the R runner reads group labels from it.
    group_column = str(settings.get("group_column") or "group")
    # The R runner drops samples outside ref_group/target_group (manual and
    # split metadata can carry more groups than the comparison under study).
    target_group = ""
    if comparison:
        groups = [g.strip() for g in str(comparison).split(" vs ")]
        if len(groups) == 2:
            target_group = groups[1] if ref_group == groups[0] else groups[0]

    def _task(status, message, **extra):
        return {
            "run_id": task_run_id, "task_id": task_id, "title": title,
            "source_run_id": settings.get("source_run_id"),
            "target": settings.get("target_meta"), "comparison": comparison,
            "network_type": network_type, "organism": organism, "ref_group": ref_group,
            "status": status, "message": message, "started_at": utc_now_iso(), **extra,
        }

    project_data = get_project_data(project_id)

    def _history(status, message, date, **extra):
        return {
            "run_id": task_run_id, "task_id": task_id, "title": title, "date": date,
            "source_run_id": settings.get("source_run_id"),
            "target": settings.get("target_meta"), "comparison": comparison,
            "network_type": network_type, "organism": organism, "ref_group": ref_group,
            "status": status, "message": message, **extra,
        }

    staging = Path(tempfile.mkdtemp(prefix="network_"))
    try:
        update_project(project_id, network_task=_task("running", f"Running {_TYPE_LABELS[network_type]} network."))
        history = project_data.get("network_history") or []
        update_project(
            project_id,
            network_history=[_history("running", f"Running {_TYPE_LABELS[network_type]} network.", utc_now_iso())]
            + [item for item in history if item.get("run_id") != task_run_id],
        )

        rscript = find_rscript()
        if not rscript:
            raise RuntimeError(
                "R is not available on this server (Rscript not found). "
                "Set RSCRIPT_PATH or install R + LipidSigR to run networks."
            )
        if not matrix_path or not meta_path:
            raise ValueError("matrix_path and meta_path are required for a network run.")
        if not ref_group:
            raise ValueError("ref_group (control group) is required for a network run.")

        project_data, source_entry = _load_source_ttest_run(
            uid, project_id, source_run_id=settings.get("source_run_id")
        )
        stats_rows = _extract_feature_stats(source_entry.get("results") or [])
        if not stats_rows:
            raise ValueError("The selected DAL run has no features.")

        (staging / "matrix.csv").write_bytes(read_bytes(uid, project_id, matrix_path))
        (staging / "meta.csv").write_bytes(read_bytes(uid, project_id, meta_path))
        n_de = _write_de_csv(stats_rows, staging / "de.csv")
        logger.info("[Network] %s | %s | %d DE features | ref=%s", network_type, organism, n_de, ref_group)

        out_dir = staging / "out"
        cmd = [
            rscript, str(_R_SCRIPT), network_type,
            str(staging / "matrix.csv"), str(staging / "meta.csv"), str(staging / "de.csv"),
            str(out_dir), ref_group, organism,
            str(n_lipid), str(p_cutoff), str(fc_cutoff), target_group, group_column,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=_RUN_TIMEOUT_SECONDS)
        if proc.stdout:
            logger.info("[Network][R] %s", proc.stdout.strip()[-2000:])
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "R script failed").strip()[-2000:])

        pair = settings.get("comparison") or "comparison"
        spec = build_spec(network_type, out_dir, pair)
        other_spec = None
        if network_type == "lipid_reaction":
            try:
                other_spec = build_spec(network_type, out_dir, pair, lipid_mode="all")
            except ValueError as exc:
                # The between-only viewer is still usable; the mode switch is hidden.
                logger.info("[Network] all-reactions mode unavailable: %s", exc)
        meta = {
            "title": title,
            "network_type": network_type,
            "comparison": comparison,
            "target": settings.get("target_meta"),
            "organism": organism,
            "ref_group": ref_group,
            "n_lipid": n_lipid,
            "p_cutoff": p_cutoff,
            "fc_cutoff": fc_cutoff,
            "source_run_id": settings.get("source_run_id"),
            "run_id": task_run_id,
            "date": utc_now_iso(),
            "node_count": len(spec["nodes"]),
            "edge_count": len(spec["edges"]),
        }
        if spec.get("lipid_mode"):
            meta["lipid_mode"] = spec["lipid_mode"]
        html = _build_html(spec, meta, other_spec)
        html_dest = f"projects/{uid}/{project_id}/network/{task_run_id}.html"
        html_url = upload_public(uid, project_id, html_dest, html, "text/html")
        run_dest = f"projects/{uid}/{project_id}/network/{task_run_id}.json"
        upload_public(
            uid, project_id, run_dest,
            json.dumps(make_json_safe({
                "run_id": task_run_id, "title": title, "date": utc_now_iso(),
                "network_type": network_type, "organism": organism, "ref_group": ref_group,
                "n_lipid": n_lipid, "p_cutoff": p_cutoff, "fc_cutoff": fc_cutoff,
                "node_count": len(spec["nodes"]), "edge_count": len(spec["edges"]),
                "html_url": html_url,
            }), ensure_ascii=False),
            "application/json",
        )

        history_entry = _history(
            "done", f"{_TYPE_LABELS[network_type]} network completed.", utc_now_iso(),
            node_count=len(spec["nodes"]), edge_count=len(spec["edges"]), html_url=html_url,
        )
        project_data = get_project_data(project_id)
        history = project_data.get("network_history") or []
        update_project(
            project_id,
            network_history=[history_entry] + [i for i in history if i.get("run_id") != task_run_id],
            network_task=_task(
                "done", history_entry["message"],
                node_count=len(spec["nodes"]), edge_count=len(spec["edges"]), html_url=html_url,
            ),
        )
        return {"run_id": task_run_id, "node_count": len(spec["nodes"]), "edge_count": len(spec["edges"])}

    except Exception as exc:  # noqa: BLE001 - surfaced to the UI as a failed run
        logger.exception("[Network] run failed: %s", exc)
        message = str(exc)
        project_data = get_project_data(project_id)
        history = project_data.get("network_history") or []
        update_project(
            project_id,
            network_history=[_history("error", message, utc_now_iso())]
            + [i for i in history if i.get("run_id") != task_run_id],
            network_task=_task("error", message),
        )
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)

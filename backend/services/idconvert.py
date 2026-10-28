"""Lipid ID conversion — offline re-implementation of the LipidSig web
"ID conversion" block using the exported LipidSigR annotation snapshots
(services/lipidref) plus pygoslin (the official Python port of Goslin 2.0).

Pipeline: raw name -> pygoslin parse -> candidate names
(raw / Species / Molecular / Sn / deeper levels, plus parenthesised
variants for the legacy LION naming style) -> exact matches against
resource_id_anno / lion_id_anno / gatom_metabolites.

Exact semantics follow the verified local R pipeline documented in
LOCAL_ANALYSIS.md (raw lookup first, then goslin candidates).
"""
from __future__ import annotations

import logging
import math
import re
from typing import Any, Dict, List, Optional

import pandas as pd

from services.lipidref import load_table

logger = logging.getLogger("API")

_ID_COLS = ["LIPIDMAPS", "SwissLipids", "HMDB", "ChEBI", "KEGG", "MetaNetX", "LipidBank", "PubChem", "PlantFA"]
_RESOURCE_NAME_COLS = ["Species.Name", "Molecular.Species.Name", "Sn.Position.Name"]
_LION_CHAR_COLS = [
    "Category", "Main.Class", "Sub.Class", "Cellular.Component", "Function", "Contain.FA",
    "Bond.type", "Headgroup.Charge", "Lateral.Diffusion", "Bilayer.Thickness",
    "Intrinsic.Curvature", "Transition.Temperature",
    "FA.Unsaturation.Category1", "FA.Unsaturation.Category2",
    "FA.Chain.Length.Category1", "FA.Chain.Length.Category2",
]

try:
    from pygoslin.parser.Parser import LipidParser
    from pygoslin.domain.LipidLevel import LipidLevel

    _PARSER = LipidParser()
    # Candidate levels in increasing structural resolution.
    _LEVELS = [
        ("SPECIES", LipidLevel.SPECIES),
        ("MOLECULAR", LipidLevel.MOLECULAR_SPECIES),
        ("SN", LipidLevel.SN_POSITION),
        ("STRUCTURE", LipidLevel.STRUCTURE_DEFINED),
        ("FULL_STRUCTURE", LipidLevel.FULL_STRUCTURE),
        ("COMPLETE", LipidLevel.COMPLETE_STRUCTURE),
    ]
    PYGOSLIN_AVAILABLE = True
except Exception:  # pragma: no cover - defensive; requirements pin pygoslin
    _PARSER = None
    _LEVELS = []
    PYGOSLIN_AVAILABLE = False
    logger.warning("pygoslin not available — ID conversion will only do raw-name lookups")


# --- Lookup indices (built once, cached) ---

_INDEX: Optional[Dict[str, Any]] = None


def _paren_variant(name: str) -> Optional[str]:
    """'CE 18:2' -> 'CE(18:2)' (legacy LION naming style)."""
    m = re.match(r"^(\S+)\s+(\S.*)$", name)
    return f"{m.group(1)}({m.group(2)})" if m else None


def _coalesce_by(df: pd.DataFrame, key: str) -> pd.DataFrame:
    """Group rows by key, taking the first non-empty value per column."""
    sub = df[df[key] != ""]
    sub = sub.replace("", pd.NA)
    return sub.groupby(key, sort=False).first()


def _build_index() -> Dict[str, Any]:
    global _INDEX
    if _INDEX is not None:
        return _INDEX

    res = load_table("resource_id_anno")
    res_lookups = {col: _coalesce_by(res, col) for col in _RESOURCE_NAME_COLS}

    lion_anno = load_table("lion_id_anno")
    lion_by_name = lion_anno[lion_anno["name"] != ""].drop_duplicates(subset=["name"]).set_index("name")
    lion_by_lm = lion_anno[lion_anno["LIPIDMAPS_ID"] != ""].drop_duplicates(subset=["LIPIDMAPS_ID"]).set_index("LIPIDMAPS_ID")
    lion_by_sl = lion_anno[lion_anno["SwissLipids_ID"] != ""].drop_duplicates(subset=["SwissLipids_ID"]).set_index("SwissLipids_ID")

    lion_char = load_table("lion_char").drop_duplicates(subset=["LION_ID"]).set_index("LION_ID")

    gatom = load_table("gatom_metabolites")
    gatom_by_lm = gatom[gatom["LipidMaps_ID"] != ""].drop_duplicates(subset=["LipidMaps_ID"]).set_index("LipidMaps_ID")

    _INDEX = {
        "res": res_lookups,
        "lion_by_name": lion_by_name,
        "lion_by_lm": lion_by_lm,
        "lion_by_sl": lion_by_sl,
        "lion_char": lion_char,
        "gatom_by_lm": gatom_by_lm,
        "lion_name_by_id": lion_anno.drop_duplicates(subset=["LION_ID"]).set_index("LION_ID")["name"],
    }
    logger.info(
        "[IDConvert] Index ready: resource=%d rows, lion_anno=%d, lion_char=%d, gatom=%d",
        len(res), len(lion_anno), len(lion_char), len(gatom),
    )
    return _INDEX


# --- pygoslin parsing ---

_SPECIES_TAIL = re.compile(r"(\d+):(\d+)(?:;O(\d+))?$")


def _fa_oh(fa) -> int:
    fg = getattr(fa, "functional_groups", None) or {}
    oh = fg.get("OH")
    return len(oh) if isinstance(oh, list) else (int(oh) if oh else 0)


def _fa_block(fa) -> Dict[str, Any]:
    """One fatty-acid chain -> LipidSig-style detail fields."""
    try:
        ts = fa.to_string(LipidLevel.STRUCTURE_DEFINED)
    except Exception:
        try:
            ts = fa.to_string(LipidLevel.COMPLETE_STRUCTURE)
        except Exception:
            ts = fa.to_string(LipidLevel.FULL_STRUCTURE) if True else ""
    bond = getattr(fa, "lipid_FA_bond_type", None)
    return {
        "name": ts,
        "C": getattr(fa, "num_carbon", ""),
        "DB": fa.get_double_bonds(),
        "OH": _fa_oh(fa),
        "Bond": bond.name if bond is not None else "",
    }


def _parse_name(raw: str) -> Dict[str, Any]:
    """Parse one lipid name with goslin; return level strings + candidates +
    chain-level detail (FA1..FA4 / LCB blocks) mirroring rgoslin output."""
    out: Dict[str, Any] = {
        "parseable": False, "category": "", "class": "", "sum_formula": "", "mass": "",
        "levels": {}, "candidates": [], "level": "", "chains": [],
    }
    if not PYGOSLIN_AVAILABLE:
        out["candidates"].append(raw)
        return out
    try:
        parsed = _PARSER.parse(raw)
    except Exception:
        out["candidates"].append(raw)
        return out

    out["parseable"] = True
    try:
        out["sum_formula"] = parsed.get_sum_formula()
    except Exception:
        pass
    try:
        mass = parsed.get_mass()
        out["mass"] = round(mass, 4) if isinstance(mass, float) and math.isfinite(mass) else ""
    except Exception:
        pass
    try:
        level = getattr(parsed.lipid.info, "level", None)
        out["level"] = level.name if level is not None else ""
    except Exception:
        pass

    chains = []
    try:
        for fa in parsed.lipid.fa_list:
            blk = _fa_block(fa)
            blk["is_lcb"] = str(getattr(fa, "name", "")).upper() == "LCB"
            chains.append(blk)
    except Exception:
        pass
    out["chains"] = chains

    candidates: List[str] = [raw]
    for lv_name, lv in _LEVELS:
        try:
            s = parsed.get_lipid_string(lv)
        except Exception:
            continue
        if not s:
            continue
        out["levels"][lv_name] = s
        if lv_name == "SPECIES":
            parts = s.split(" ", 1)
            out["class"] = parts[0]
        if s not in candidates:
            candidates.append(s)
        paren = _paren_variant(s)
        if paren and paren not in candidates:
            candidates.append(paren)

    try:
        cat = parsed.lipid.get_lipid_string(LipidLevel.CATEGORY)
        out["category"] = cat or ""
    except Exception:
        pass

    paren_raw = _paren_variant(raw)
    if paren_raw and paren_raw not in candidates:
        candidates.append(paren_raw)
    out["candidates"] = candidates
    return out


# --- Matching ---

def _match_resource(idx: Dict[str, Any], candidates: List[str]):
    for cand in candidates:
        for col in _RESOURCE_NAME_COLS:
            table = idx["res"][col]
            if cand in table.index:
                return cand, col, table.loc[cand]
    return None, None, None


def _match_lion(idx: Dict[str, Any], candidates: List[str], lm_id: str, sl_id: str):
    for cand in candidates:
        if cand in idx["lion_by_name"].index:
            return idx["lion_by_name"].loc[cand, "LION_ID"]
    if lm_id and lm_id in idx["lion_by_lm"].index:
        return idx["lion_by_lm"].loc[lm_id, "LION_ID"]
    if sl_id and sl_id in idx["lion_by_sl"].index:
        return idx["lion_by_sl"].loc[sl_id, "LION_ID"]
    return ""


def _try_match(idx: Dict[str, Any], name: str):
    """Full parse+lookup for one candidate name. Returns (parsed, res_tuple, lion_id) or None."""
    parsed = _parse_name(name)
    matched_name, matched_col, res_row = _match_resource(idx, parsed["candidates"])
    lion_id = ""
    if res_row is None:
        lion_id = _match_lion(idx, parsed["candidates"], "", "")
    if res_row is None and not lion_id:
        return None
    return parsed, (matched_name, matched_col, res_row), lion_id


# Vendor alias class tokens => goslin-parseable shorthand class.
_NAME_ALIASES = {
    "acylcarnitine": "CAR",
}

# LIPID MAPS category long name per goslin category token (primary source
# when parseable); class-token map is the fallback for unparseable vendor
# names. Either way the fill is marked in Note as inferred.
_CATEGORY_FROM_TOKEN = {
    "FA": "Fatty Acyls [FA]", "GP": "Glycerophospholipids [GP]",
    "SP": "Sphingolipids [SP]", "GL": "Glycerolipids [GL]",
    "ST": "Sterol Lipids [ST]", "PK": "Polyketides [PK]",
    "PR": "Prenol Lipids [PR]", "SL": "Saccharolipids [SL]",
}

_CATEGORY_FROM_CLASS = {
    "FA": "Fatty Acyls [FA]", "CAR": "Fatty Acyls [FA]",
    "PC": "Glycerophospholipids [GP]", "LPC": "Glycerophospholipids [GP]",
    "PE": "Glycerophospholipids [GP]", "LPE": "Glycerophospholipids [GP]",
    "PI": "Glycerophospholipids [GP]", "LPI": "Glycerophospholipids [GP]",
    "PG": "Glycerophospholipids [GP]", "PS": "Glycerophospholipids [GP]",
    "PA": "Glycerophospholipids [GP]",
    "SM": "Sphingolipids [SP]", "Cer": "Sphingolipids [SP]",
    "dhCer": "Sphingolipids [SP]", "Hex1Cer": "Sphingolipids [SP]",
    "Hex2Cer": "Sphingolipids [SP]", "Hex3Cer": "Sphingolipids [SP]",
    "GM3": "Sphingolipids [SP]", "S1P": "Sphingolipids [SP]",
    "CE": "Sterol Lipids [ST]", "COH": "Sterol Lipids [ST]",
    "dimethyl-CE": "Sterol Lipids [ST]",
    "TG": "Glycerolipids [GL]", "DG": "Glycerolipids [GL]", "MG": "Glycerolipids [GL]",
    "Ubiquinone": "Prenol Lipids [PR]", "Ubiquinol": "Prenol Lipids [PR]",
}


# Partial-chain annotation: 'DG 36:1 -(18:1)' declares one acyl chain of a
# species-level name → the true molecular species is the complement
# (36:1 total minus 18:1 chain = 18:0) → 'DG 18:0_18:1'. This is NOT tail
# stripping: the annotation's information is used, not discarded.
_FA_TAIL = re.compile(r"^([A-Za-z0-9]+)[\s\(]*(\d+):(\d+)[^\s\)]*\)?\s*-\((\d+):(\d+)\)\s*$")


def _fa_complement_variants(name: str) -> List[str]:
    m = _FA_TAIL.match(name)
    if not m:
        return []
    cls, total_c, total_db, dc, dd = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
    comp_c, comp_db = total_c - dc, total_db - dd
    if comp_c < 1 or comp_db < 0:
        return []
    out = []
    for sep in ("_", "/"):
        out.append(f"{cls} {comp_c}:{comp_db}{sep}{dc}:{dd}")
        out.append(f"{cls} {dc}:{dd}{sep}{comp_c}:{comp_db}")
    return out


def _space_variants(name: str) -> List[str]:
    """Generate names with spaces removed: 1 space (each position), then 2
    spaces (each pair), then all spaces — the recovery ladder for names like
    'LPC 17:1 (a) [sn1]'."""
    from itertools import combinations
    idxs = [i for i, c in enumerate(name) if c == " "]
    out: List[str] = []
    if not idxs:
        return out
    for i in idxs:
        out.append(name[:i] + " " * 0 + name[i + 1:])
    for a, b in combinations(idxs, 2):
        out.append(name[:a] + name[a + 1:b] + name[b + 1:])
    no_space = name.replace(" ", "")
    if no_space not in out:
        out.append(no_space)
    # dedupe, preserve order
    seen = set()
    uniq = []
    for v in out:
        if v not in seen and v != name:
            seen.add(v)
            uniq.append(v)
    return uniq


# --- Public API ---

# Internal row keys (existing preview + IDs) stay unchanged; CSV_FIELDS below
# adds the extended LipidSig-style structural columns for the download.
RESULT_COLUMNS = (
    ["Input.Name", "Parseable", "Goslin.Species", "Goslin.Molecular", "Goslin.Sn",
     "Goslin.Sum.Formula", "Goslin.Mass", "Goslin.Category", "Goslin.Class",
     "Matched.Name", "Matched.Level"]
    + _ID_COLS
    + ["core", "main_class", "sub_class", "LION_ID", "GATOM.Abbreviation"]
    + [f"LION.{c}" for c in _LION_CHAR_COLS]
    + ["Note"]
)

# Download-CSV column order — mirrors the LipidSig ID-conversion table the
# user is used to (structural block from goslin, LION block, abbreviations),
# then the cross-database IDs appended after.
_FA_SLOTS = ["FA1", "FA2", "FA3", "FA4"]
CSV_FIELDS = (
    ["feature", "class", "Lipid.Maps.Category",
     "Species.Name", "Molecular.Species.Name", "Structural.Species.Name",
     "Level", "Mass", "Sum.Formula",
     "Total.FA", "Total.C", "Total.DB", "Total.OH",
     "FA", "FA.C", "FA.DB", "FA.OH",
     "LCB", "LCB2", "LCB.C", "LCB.DB", "LCB.OH", "LCB.Bond.Type"]
    + [f"{p}{s}" for p in _FA_SLOTS for s in ("", ".C", ".DB", ".OH", ".Bond.Type")]
    + _LION_CHAR_COLS
    + ["FA.Chain.Length.Category3", "LION.abbr", "GATOM.abbr", "LIPIDMAPS.reaction.abbr"]
    + _ID_COLS
    + ["LION_ID", "Matched.Name", "Matched.Level", "Note"]
)


def convert_ids(names: List[str]) -> Dict[str, Any]:
    """Convert a list of raw lipid names to the annotation table.

    Returns {"stats": {...}, "warnings": [...], "rows": [dict, ...]}
    where each row follows RESULT_COLUMNS.
    """
    idx = _build_index()
    rows: List[Dict[str, Any]] = []
    warnings: List[str] = []
    n_mapped = 0
    n_lion = 0

    seen = set()
    uniq_names = []
    for n in names:
        n = str(n).strip()
        if n and n not in seen:
            seen.add(n)
            uniq_names.append(n)

    for raw in uniq_names:
        parsed = _parse_name(raw)
        row: Dict[str, Any] = {c: "" for c in RESULT_COLUMNS}
        row["Input.Name"] = raw
        row["Parseable"] = parsed["parseable"]
        row["Goslin.Species"] = parsed["levels"].get("SPECIES", "")
        row["Goslin.Molecular"] = parsed["levels"].get("MOLECULAR", "")
        row["Goslin.Sn"] = parsed["levels"].get("SN", "")
        row["Goslin.Sum.Formula"] = parsed["sum_formula"]
        row["Goslin.Mass"] = parsed["mass"]
        row["Goslin.Category"] = parsed["category"]
        row["Goslin.Class"] = parsed["class"]
        row["Note"] = ""

        if not parsed["parseable"]:
            row["Note"] = "not parseable by goslin (vendor/alias name) — raw lookup only"

        # Matching ladder: raw → vendor-alias rewrite → space-deletion loop.
        hit = _try_match(idx, raw)
        matched_via = raw
        if hit is None:
            for alias, goslin_class in _NAME_ALIASES.items():
                if raw.lower().startswith(alias + " "):
                    alt = goslin_class + raw[len(alias):]
                    hit = _try_match(idx, alt)
                    if hit:
                        matched_via = alt
                        break
        if hit is None:
            for variant in _space_variants(raw):
                hit = _try_match(idx, variant)
                if hit:
                    matched_via = variant
                    break
        if hit is None:
            # 'DG 36:1 -(18:1)' -> molecular species complement 'DG 18:0_18:1'
            for variant in _fa_complement_variants(raw):
                hit = _try_match(idx, variant)
                if hit:
                    matched_via = variant
                    break

        if hit:
            parsed_m, (matched_name, matched_col, res_row), lion_id = hit
            parsed = parsed_m  # goslin columns describe the matched variant
            row["Goslin.Species"] = parsed["levels"].get("SPECIES", "")
            row["Goslin.Molecular"] = parsed["levels"].get("MOLECULAR", "")
            row["Goslin.Sn"] = parsed["levels"].get("SN", "")
            row["Goslin.Class"] = parsed["class"] or row["Goslin.Class"]
        else:
            matched_name = matched_col = res_row = None
            lion_id = ""

        if matched_via != raw:
            note = f"matched after rewriting input to '{matched_via}'"
            row["Note"] = f"{row['Note']}; {note}" if row["Note"] else note

        if res_row is not None:
            n_mapped += 1
            row["Matched.Name"] = matched_name
            row["Matched.Level"] = matched_col.replace(".Name", "")
            for c in _ID_COLS + ["core", "main_class", "sub_class"]:
                v = res_row.get(c)
                row[c] = "" if v is None or (isinstance(v, float) and pd.isna(v)) else str(v)

        if not lion_id and hit:
            # resource hit may also bridge to LION via IDs
            lion_id = _match_lion(
                idx, parsed["candidates"], row.get("LIPIDMAPS", ""), row.get("SwissLipids", "")
            )
        lion_name = ""
        if lion_id:
            n_lion += 1
            row["LION_ID"] = lion_id
            lion_name = idx["lion_name_by_id"].get(lion_id, "")
            if lion_id in idx["lion_char"].index:
                char_row = idx["lion_char"].loc[lion_id]
                for c in _LION_CHAR_COLS:
                    v = char_row.get(c)
                    row[f"LION.{c}"] = "" if v is None or (isinstance(v, float) and pd.isna(v)) else str(v)

        gatom_lm_abbr = gatom_sl_abbr = ""
        lm = row.get("LIPIDMAPS", "")
        if lm and lm in idx["gatom_by_lm"].index:
            g = idx["gatom_by_lm"].loc[lm]
            gatom_lm_abbr = str(g.get("Abbreviation_LipidMaps") or "")
            gatom_sl_abbr = str(g.get("Abbreviation_SwissLipids") or "")
            row["GATOM.Abbreviation"] = gatom_lm_abbr

        # Category/class inference for names that never matched a DB row —
        # same spirit as the original tool (still shows the lipid class).
        if not row.get("core"):
            inferred = _CATEGORY_FROM_TOKEN.get(parsed["category"], "")
            if not inferred:
                token = parsed["class"]
                if not token:
                    token = re.split(r"[\s(]", raw, maxsplit=1)[0]
                    token = _NAME_ALIASES.get(token.lower(), token)
                inferred = _CATEGORY_FROM_CLASS.get(token, "")
            if inferred:
                row["core"] = inferred
                row["_inferred_category"] = True
                note = "category inferred (no database match)"
                row["Note"] = f"{row['Note']}; {note}" if row["Note"] else note

        row["_csv"] = _build_csv_row(raw, parsed, row, lion_name, gatom_lm_abbr, gatom_sl_abbr)

        if res_row is None and not lion_id:
            warnings.append(raw)
        elif not parsed["parseable"]:
            warnings.append(f"{raw} (mapped by raw name; not goslin-parseable)")
        rows.append(row)

    stats = {
        "input": len(names),
        "unique": len(uniq_names),
        "parsed_ok": sum(1 for r in rows if r["Parseable"]),
        "mapped_resource": n_mapped,
        "mapped_lion": n_lion,
        "unmapped": len(uniq_names) - n_mapped,
    }
    return {"stats": stats, "warnings": warnings, "rows": rows}


def _build_csv_row(raw: str, parsed: Dict[str, Any], row: Dict[str, Any],
                   lion_name: str, gatom_lm_abbr: str, gatom_sl_abbr: str) -> Dict[str, Any]:
    """Assemble the LipidSig-style extended CSV row (see CSV_FIELDS)."""
    out: Dict[str, Any] = {c: "" for c in CSV_FIELDS}
    chains = parsed["chains"]
    lcb_chains = [c for c in chains if c["is_lcb"]]
    fa_chains = [c for c in chains if not c["is_lcb"]]

    # Species-level fallbacks when no chain detail exists ("PC 34:1" style).
    sp_tail_c = sp_tail_db = sp_tail_oh = None
    species = parsed["levels"].get("SPECIES", "")
    m = _SPECIES_TAIL.search(species)
    if m:
        sp_tail_c, sp_tail_db = m.group(1), m.group(2)
        sp_tail_oh = m.group(3)

    def _sum(key, seq):
        vals = [x[key] for x in seq if isinstance(x[key], int)]
        return sum(vals) if vals else ""

    out["feature"] = raw
    out["class"] = row["Goslin.Class"] or row.get("main_class", "")
    out["Lipid.Maps.Category"] = row.get("core", "")
    out["Species.Name"] = parsed["levels"].get("SPECIES", "")
    out["Molecular.Species.Name"] = parsed["levels"].get("MOLECULAR", "")
    out["Structural.Species.Name"] = (
        parsed["levels"].get("SN") or parsed["levels"].get("STRUCTURE") or ""
    )
    out["Level"] = parsed["level"]
    out["Mass"] = parsed["mass"]
    out["Sum.Formula"] = parsed["sum_formula"]

    out["Total.FA"] = len(fa_chains) if chains else ""
    out["Total.C"] = _sum("C", chains) if chains else (sp_tail_c or "")
    out["Total.DB"] = _sum("DB", chains) if chains else (sp_tail_db or "")
    out["Total.OH"] = _sum("OH", chains) if chains else (sp_tail_oh or "")

    out["FA"] = "_".join(c["name"] for c in fa_chains) if fa_chains else ""
    out["FA.C"] = _sum("C", fa_chains)
    out["FA.DB"] = _sum("DB", fa_chains)
    out["FA.OH"] = _sum("OH", fa_chains)

    if lcb_chains:
        l = lcb_chains[0]
        out["LCB"], out["LCB.C"], out["LCB.DB"], out["LCB.OH"], out["LCB.Bond.Type"] = (
            l["name"], l["C"], l["DB"], l["OH"], l["Bond"])
        if len(lcb_chains) > 1:
            out["LCB2"] = lcb_chains[1]["name"]
    for i, slot in enumerate(_FA_SLOTS):
        if i < len(fa_chains):
            c = fa_chains[i]
            out[slot], out[f"{slot}.C"], out[f"{slot}.DB"], out[f"{slot}.OH"], out[f"{slot}.Bond.Type"] = (
                c["name"], c["C"], c["DB"], c["OH"], c["Bond"])

    for c in _LION_CHAR_COLS:
        out[c] = row.get(f"LION.{c}", "")
    out["LION.abbr"] = lion_name
    out["GATOM.abbr"] = gatom_lm_abbr
    out["LIPIDMAPS.reaction.abbr"] = gatom_sl_abbr
    for c in _ID_COLS:
        out[c] = row.get(c, "")
    out["LION_ID"] = row.get("LION_ID", "")
    out["Matched.Name"] = row.get("Matched.Name", "")
    out["Matched.Level"] = row.get("Matched.Level", "")
    out["Note"] = row.get("Note", "")
    return out


def demo() -> None:
    """Self-check: a handful of typical names must map."""
    res = convert_ids(["PC 34:1", "Cer 38:1;O2", "LPC O-16:0", "CAR 10:0", "SM d18:1/16:0", "NotALipid 123"])
    s = res["stats"]
    assert s["unique"] == 6, s
    assert s["mapped_resource"] >= 4, s  # PC/Cer/LPC/CAR/SM must hit
    names = {r["Input.Name"]: r for r in res["rows"]}
    assert names["PC 34:1"]["LIPIDMAPS"], names["PC 34:1"]
    assert any("NotALipid 123" in w for w in res["warnings"])
    print("idconvert.demo OK:", s)


if __name__ == "__main__":
    demo()

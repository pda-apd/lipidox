import io
import logging
import re
from typing import Dict, List, Optional, Tuple
import numpy as np
import pandas as pd

from services.common import *
from services.validator import run_integrity_validation

logger = logging.getLogger("PREPROCESS")

PREPROCESS_MODE = "preprocess_portal"

NIST_SAMPLE_COLUMN = "sample_id"
NIST_REFERENCE_COLUMN = "paired_nist"
IS_TARGET_COLUMN = "compound_name"
IS_STANDARD_COLUMN = "ISTD"


def _canonicalize_name(value) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "", str(value).strip()).lower()


def _build_canonical_name_map(values, label: str) -> Dict[str, str]:
    mapping = {}
    collisions = {}

    for raw_value in values:
        original_value = str(raw_value).strip()
        canonical_value = _canonicalize_name(original_value)
        if not canonical_value:
            continue
        if canonical_value in mapping and mapping[canonical_value] != original_value:
            collisions.setdefault(canonical_value, {mapping[canonical_value]})
            collisions[canonical_value].add(original_value)
            continue
        mapping[canonical_value] = original_value

    if collisions:
        details = "; ".join(
            f"{canonical}: {sorted(values)}" for canonical, values in collisions.items()
        )
        raise ValueError(f"Duplicate normalized names detected in {label}: {details}")

    return mapping


def _normalize_mapping_values(frame: pd.DataFrame, columns: List[str]) -> pd.DataFrame:
    normalized = frame.copy()
    for column in columns:
        normalized[column] = normalized[column].astype(str).str.strip().map(_canonicalize_name)
    return normalized


def _build_original_name_lookup(frame: pd.DataFrame, columns: List[str]) -> Dict[str, Dict[str, str]]:
    lookup = {}
    for column in columns:
        column_lookup = {}
        for value in frame[column].dropna().astype(str).str.strip():
            canonical_value = _canonicalize_name(value)
            if canonical_value and canonical_value not in column_lookup:
                column_lookup[canonical_value] = value
        lookup[column] = column_lookup
    return lookup


def _restore_names_for_diagnostics(values: List[str], lookup: Dict[str, str]) -> List[str]:
    return [lookup.get(str(value), str(value)) for value in values]


def _restore_feature_names(matrix: pd.DataFrame, feature_name_map: Dict[str, str]) -> pd.DataFrame:
    restored = matrix.copy()
    restored.index = [feature_name_map.get(str(index), str(index)) for index in restored.index]
    restored.index.name = None
    return restored


def _restore_sample_names(
    matrix: pd.DataFrame,
    metadata: pd.DataFrame,
    matrix_sample_name_map: Dict[str, str],
    metadata_sample_name_map: Dict[str, str],
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    restored_matrix = matrix.copy()
    restored_metadata = metadata.copy()

    restored_matrix.columns = [
        metadata_sample_name_map.get(str(column), matrix_sample_name_map.get(str(column), str(column)))
        for column in restored_matrix.columns
    ]
    restored_metadata.index = [
        metadata_sample_name_map.get(str(index), str(index))
        for index in restored_metadata.index
    ]

    return restored_matrix, restored_metadata


def _load_csv_from_storage(uid, project_id, path, index_col=None):
    return load_csv(uid, project_id, path, index_col=0) if index_col is not None else load_csv(uid, project_id, path)


def _sanitize_numeric_matrix(frame: pd.DataFrame) -> pd.DataFrame:
    numeric = frame.apply(pd.to_numeric, errors="coerce")
    numeric = numeric.replace([np.inf, -np.inf], np.nan)
    return numeric


def _as_string_list(values: List[str]) -> List[str]:
    return [str(value) for value in values]


def _require_columns(frame: pd.DataFrame, required_columns: List[str], file_label: str) -> None:
    missing_columns = [column for column in required_columns if column not in frame.columns]
    if missing_columns:
        raise ValueError(f"{file_label} must contain columns: {', '.join(required_columns)}. Missing: {', '.join(missing_columns)}")


def _remove_reference_samples_from_metadata(metadata: pd.DataFrame, reference_samples: List[str]) -> pd.DataFrame:
    if not reference_samples:
        return metadata
    reference_sample_set = set(reference_samples)
    kept_index = [sample for sample in metadata.index if sample not in reference_sample_set]
    return metadata.loc[kept_index].copy()


def _apply_internal_standard_normalization(
    matrix: pd.DataFrame,
    mapping: pd.DataFrame,
) -> Tuple[pd.DataFrame, Dict[str, List[str]], List[str]]:
    _require_columns(mapping, [IS_TARGET_COLUMN, IS_STANDARD_COLUMN], "IS file")

    mapping = mapping[[IS_TARGET_COLUMN, IS_STANDARD_COLUMN]].dropna(how="any")
    mapping[IS_TARGET_COLUMN] = mapping[IS_TARGET_COLUMN].astype(str).str.strip()
    mapping[IS_STANDARD_COLUMN] = mapping[IS_STANDARD_COLUMN].astype(str).str.strip()

    sample_names = list(matrix.columns)
    missing_targets = []
    missing_standards = []
    normalized_targets = []
    result_rows = []
    istd_set = set(mapping[IS_STANDARD_COLUMN].unique())

    for _, row in mapping.iterrows():
        target = row[IS_TARGET_COLUMN]
        standard = row[IS_STANDARD_COLUMN]

        if target not in matrix.index:
            missing_targets.append(target)
            continue
        if standard not in matrix.index:
            missing_standards.append(standard)
            continue

        target_values = pd.to_numeric(matrix.loc[target, sample_names], errors="coerce").fillna(0.0).to_numpy(dtype=float)
        standard_values = pd.to_numeric(matrix.loc[standard, sample_names], errors="coerce").fillna(0.0).to_numpy(dtype=float)
        ratio_values = np.where(standard_values > 0, target_values / standard_values, 0.0)

        result_row = {sample_name: round(float(ratio_values[index]), 5) for index, sample_name in enumerate(sample_names)}
        result_rows.append(pd.Series(result_row, name=target))
        normalized_targets.append(target)

    if result_rows:
        matrix_out = pd.DataFrame(result_rows)
        matrix_out.index.name = matrix.index.name
        matrix_out = matrix_out.loc[~matrix_out.index.isin(istd_set)]
        matrix_out = matrix_out.round(5)
    else:
        matrix_out = matrix.copy().round(5)

    if normalized_targets:
        report = [
            f"IS normalization applied to {len(normalized_targets)} compounds.",
            f"Retained {len(matrix_out.index)} mapped compounds after ISTD normalization.",
            f"Removed {len(istd_set.intersection(set(matrix.index.astype(str))))} internal-standard rows after normalization.",
        ]
    else:
        report = [
            "No matched Compound-ISTD pairs were found. The raw matrix was kept unchanged for the next step.",
        ]

    diagnostics = {
        "missing_is_compounds": _as_string_list(sorted(set(missing_targets))),
        "missing_is_standards": _as_string_list(sorted(set(missing_standards))),
    }

    return matrix_out, diagnostics, report


def _apply_nist_normalization(
    matrix: pd.DataFrame,
    metadata: pd.DataFrame,
    mapping: pd.DataFrame,
) -> Tuple[pd.DataFrame, pd.DataFrame, Dict[str, List[str]], List[str]]:
    _require_columns(mapping, [NIST_SAMPLE_COLUMN, NIST_REFERENCE_COLUMN], "NIST file")

    mapping = mapping[[NIST_SAMPLE_COLUMN, NIST_REFERENCE_COLUMN]].dropna(how="any")
    mapping[NIST_SAMPLE_COLUMN] = mapping[NIST_SAMPLE_COLUMN].astype(str).str.strip()
    mapping[NIST_REFERENCE_COLUMN] = mapping[NIST_REFERENCE_COLUMN].astype(str).str.strip()

    matrix_out = matrix.copy()
    metadata_index = set(metadata.index.astype(str))
    missing_samples_in_matrix = []
    missing_references_in_matrix = []
    missing_samples_in_meta = []
    missing_references_in_meta = []
    normalized_samples = []
    used_reference_samples = set()

    for _, row in mapping.iterrows():
        sample_name = row[NIST_SAMPLE_COLUMN]
        reference_name = row[NIST_REFERENCE_COLUMN]

        if sample_name not in matrix_out.columns:
            missing_samples_in_matrix.append(sample_name)
            continue
        if reference_name not in matrix_out.columns:
            missing_references_in_matrix.append(reference_name)
            continue

        if sample_name not in metadata_index:
            missing_samples_in_meta.append(sample_name)
        if reference_name not in metadata_index:
            missing_references_in_meta.append(reference_name)

        sample_values = pd.to_numeric(matrix_out[sample_name], errors="coerce").fillna(0.0).to_numpy(dtype=float)
        reference_values = pd.to_numeric(matrix_out[reference_name], errors="coerce").fillna(0.0).to_numpy(dtype=float)
        normalized_values = np.where(reference_values > 0, sample_values / reference_values, 0.0)
        matrix_out[sample_name] = np.round(normalized_values, 5)
        normalized_samples.append(sample_name)
        used_reference_samples.add(reference_name)

    reference_columns_to_drop = [name for name in used_reference_samples if name in matrix_out.columns]
    if reference_columns_to_drop:
        matrix_out = matrix_out.drop(columns=reference_columns_to_drop)
    metadata_out = _remove_reference_samples_from_metadata(metadata, reference_columns_to_drop)

    report = [
        f"NIST normalization applied to {len(normalized_samples)} samples.",
        f"Removed {len(reference_columns_to_drop)} NIST reference columns after normalization.",
        f"Removed {len(reference_columns_to_drop)} paired NIST rows from metadata.",
    ]

    diagnostics = {
        "missing_nist_samples_in_matrix": _as_string_list(sorted(set(missing_samples_in_matrix))),
        "missing_nist_references_in_matrix": _as_string_list(sorted(set(missing_references_in_matrix))),
        "missing_nist_samples_in_meta": _as_string_list(sorted(set(missing_samples_in_meta))),
        "missing_nist_references_in_meta": _as_string_list(sorted(set(missing_references_in_meta))),
    }

    return matrix_out, metadata_out, diagnostics, report


def _check_sample_id_consistency(
    matrix: pd.DataFrame,
    metadata: pd.DataFrame,
    nist_mapping: pd.DataFrame,
    is_mapping: pd.DataFrame,
    original_matrix_sample_map: Dict[str, str],
    original_meta_sample_map: Dict[str, str],
    original_nist_lookup: Dict[str, Dict[str, str]],
    original_is_lookup: Dict[str, Dict[str, str]],
) -> Tuple[List[str], Dict[str, List[str]]]:
    """Check sample ID consistency across all input files BEFORE IS/NIST processing."""
    warnings_list: List[str] = []
    cross_file_issues: Dict[str, List[str]] = {}

    matrix_samples = set(matrix.columns.astype(str))
    meta_samples = set(metadata.index.astype(str))

    nist_sample_col = (
        nist_mapping[NIST_SAMPLE_COLUMN].dropna().astype(str).tolist()
        if NIST_SAMPLE_COLUMN in nist_mapping.columns else []
    )
    nist_ref_col = (
        nist_mapping[NIST_REFERENCE_COLUMN].dropna().astype(str).tolist()
        if NIST_REFERENCE_COLUMN in nist_mapping.columns else []
    )
    nist_all = set(nist_sample_col + nist_ref_col)

    def _restore(canonical_list: List[str], *lookups: Dict[str, str]) -> List[str]:
        result = []
        for c in canonical_list:
            restored = c
            for lk in lookups:
                if c in lk:
                    restored = lk[c]
                    break
            result.append(restored)
        return sorted(result)

    # 1. Matrix vs Metadata — ignore NIST columns (will be removed later)
    in_matrix_not_meta = matrix_samples - meta_samples - nist_all
    in_meta_not_matrix = meta_samples - matrix_samples

    if in_matrix_not_meta:
        restored = _restore(sorted(in_matrix_not_meta), original_matrix_sample_map)
        warnings_list.append(
            f"[Pre-check] {len(restored)} sample(s) in matrix but NOT in metadata "
            f"(and not in NIST mapping): {restored}"
        )
        cross_file_issues["matrix_not_in_metadata"] = restored

    if in_meta_not_matrix:
        restored = _restore(sorted(in_meta_not_matrix), original_meta_sample_map)
        warnings_list.append(
            f"[Pre-check] {len(restored)} sample(s) in metadata but NOT in matrix: {restored}"
        )
        cross_file_issues["metadata_not_in_matrix"] = restored

    # 2. NIST sample_id column vs matrix columns
    nist_samples_missing = [s for s in nist_sample_col if s not in matrix_samples]
    if nist_samples_missing:
        restored = _restore(nist_samples_missing, original_nist_lookup.get(NIST_SAMPLE_COLUMN, {}))
        warnings_list.append(
            f"[Pre-check] {len(restored)} NIST sample_id(s) in nist.csv NOT found in matrix columns: {restored}"
        )
        cross_file_issues["nist_sample_id_not_in_matrix"] = restored

    # 3. NIST paired_nist column vs matrix columns
    nist_refs_missing = [s for s in nist_ref_col if s not in matrix_samples]
    if nist_refs_missing:
        restored = _restore(nist_refs_missing, original_nist_lookup.get(NIST_REFERENCE_COLUMN, {}))
        warnings_list.append(
            f"[Pre-check] {len(restored)} NIST paired_nist value(s) in nist.csv NOT found in matrix columns: {restored}"
        )
        cross_file_issues["nist_paired_nist_not_in_matrix"] = restored

    # 4. Matrix columns that look like NIST but are NOT in nist.csv at all
    nist_like_in_matrix = [s for s in matrix_samples if "nist" in s.lower() and s not in nist_all]
    if nist_like_in_matrix:
        restored = _restore(nist_like_in_matrix, original_matrix_sample_map)
        warnings_list.append(
            f"[Pre-check] {len(restored)} column(s) in matrix look like NIST samples but are NOT listed "
            f"in nist.csv — these will NOT be removed during NIST normalization: {restored}"
        )
        cross_file_issues["nist_like_columns_not_in_nist_csv"] = restored

    # 5. IS standard names vs matrix feature rows
    if IS_STANDARD_COLUMN in is_mapping.columns:
        is_standards = set(is_mapping[IS_STANDARD_COLUMN].dropna().astype(str))
        is_standards_missing = [s for s in is_standards if s not in set(matrix.index.astype(str))]
        if is_standards_missing:
            restored = _restore(is_standards_missing, original_is_lookup.get(IS_STANDARD_COLUMN, {}))
            warnings_list.append(
                f"[Pre-check] {len(restored)} IS standard(s) in is.csv NOT found as matrix feature rows: {restored}"
            )
            cross_file_issues["is_standard_not_in_matrix_features"] = restored

    for msg in warnings_list:
        logger.warning(msg)

    return warnings_list, cross_file_issues


def process_preprocessing_portal(
    project_id: str,
    matrix_raw_path: str,
    meta_path: str,
    nist_path: str,
    is_path: str,
    uid: Optional[str] = None,
):
    try:
        logger.info("[Preprocess] START | project=%s", project_id)
        project_data = get_project_data(project_id)
        resolved_uid = uid or project_data.get("uid")
        if not resolved_uid:
            raise ValueError("Unable to resolve the project owner.")

        update_project(
            project_id,
            status="processing_preprocessing",
            uploadMode=PREPROCESS_MODE,
        )

        raw_matrix = _load_csv_from_storage(resolved_uid, project_id, matrix_raw_path, index_col=0)
        metadata = _load_csv_from_storage(resolved_uid, project_id, meta_path, index_col=0)
        nist_mapping = _load_csv_from_storage(resolved_uid, project_id, nist_path)
        is_mapping = _load_csv_from_storage(resolved_uid, project_id, is_path)

        original_nist_lookup = _build_original_name_lookup(nist_mapping, [NIST_SAMPLE_COLUMN, NIST_REFERENCE_COLUMN])
        original_is_lookup = _build_original_name_lookup(is_mapping, [IS_TARGET_COLUMN, IS_STANDARD_COLUMN])

        raw_matrix.columns = raw_matrix.columns.astype(str).str.strip()
        raw_matrix.index = raw_matrix.index.astype(str).str.strip()
        metadata.index = metadata.index.astype(str).str.strip()

        feature_name_map = _build_canonical_name_map(raw_matrix.index, "matrix features")
        matrix_sample_name_map = _build_canonical_name_map(raw_matrix.columns, "matrix samples")
        metadata_sample_name_map = _build_canonical_name_map(metadata.index, "metadata samples")

        raw_matrix.index = [_canonicalize_name(value) for value in raw_matrix.index]
        raw_matrix.columns = [_canonicalize_name(value) for value in raw_matrix.columns]
        metadata.index = [_canonicalize_name(value) for value in metadata.index]

        is_mapping = _normalize_mapping_values(is_mapping, [IS_TARGET_COLUMN, IS_STANDARD_COLUMN])
        nist_mapping = _normalize_mapping_values(nist_mapping, [NIST_SAMPLE_COLUMN, NIST_REFERENCE_COLUMN])

        matrix = _sanitize_numeric_matrix(raw_matrix)
        preprocessing_report = [
            f"Loaded raw matrix: {matrix.shape[0]} compounds x {matrix.shape[1]} samples.",
            f"Loaded metadata: {metadata.shape[0]} samples x {metadata.shape[1]} columns.",
        ]

        # --- Sample ID cross-file check BEFORE IS/NIST processing ---
        consistency_warnings, consistency_issues = _check_sample_id_consistency(
            matrix, metadata, nist_mapping, is_mapping,
            matrix_sample_name_map, metadata_sample_name_map,
            original_nist_lookup, original_is_lookup,
        )
        if consistency_warnings:
            preprocessing_report.append("--- Sample ID Cross-file Check ---")
            preprocessing_report.extend(consistency_warnings)

        matrix_after_is, is_diagnostics, is_report = _apply_internal_standard_normalization(matrix, is_mapping)
        matrix_after_nist, metadata_after_nist, nist_diagnostics, nist_report = _apply_nist_normalization(matrix_after_is, metadata, nist_mapping)
        matrix_after_nist = matrix_after_nist.replace([np.inf, -np.inf], np.nan)
        matrix_after_nist = matrix_after_nist.dropna(how="all")
        matrix_after_nist = matrix_after_nist.round(5)
        matrix_after_nist = _restore_feature_names(matrix_after_nist, feature_name_map)
        matrix_after_nist, metadata_after_nist = _restore_sample_names(
            matrix_after_nist,
            metadata_after_nist,
            matrix_sample_name_map,
            metadata_sample_name_map,
        )
        metadata_after_nist.index.name = None

        preprocessing_report.extend(is_report)
        preprocessing_report.extend(nist_report)
        preprocessing_report.append(
            f"Preprocessed matrix ready: {matrix_after_nist.shape[0]} compounds x {matrix_after_nist.shape[1]} samples."
        )

        output = io.StringIO()
        csv_safe_frame(matrix_after_nist).to_csv(output)
        preprocessed_path = f"projects/{resolved_uid}/{project_id}/matrix_preprocessed.csv"
        save_text(resolved_uid, project_id, preprocessed_path, output.getvalue())

        metadata_output = io.StringIO()
        csv_safe_frame(metadata_after_nist).to_csv(metadata_output)
        processed_meta_path = f"projects/{resolved_uid}/{project_id}/metadata_preprocessed.csv"
        save_text(resolved_uid, project_id, processed_meta_path, metadata_output.getvalue())

        integrity = run_integrity_validation(matrix_after_nist, metadata_after_nist)
        diagnostics = {
            "missing_is_compounds": _restore_names_for_diagnostics(
                is_diagnostics.get("missing_is_compounds", []),
                original_is_lookup.get(IS_TARGET_COLUMN, {}),
            ),
            "missing_is_standards": _restore_names_for_diagnostics(
                is_diagnostics.get("missing_is_standards", []),
                original_is_lookup.get(IS_STANDARD_COLUMN, {}),
            ),
            "missing_nist_samples_in_matrix": _restore_names_for_diagnostics(
                nist_diagnostics.get("missing_nist_samples_in_matrix", []),
                original_nist_lookup.get(NIST_SAMPLE_COLUMN, {}),
            ),
            "missing_nist_references_in_matrix": _restore_names_for_diagnostics(
                nist_diagnostics.get("missing_nist_references_in_matrix", []),
                original_nist_lookup.get(NIST_REFERENCE_COLUMN, {}),
            ),
            "missing_nist_samples_in_meta": _restore_names_for_diagnostics(
                nist_diagnostics.get("missing_nist_samples_in_meta", []),
                original_nist_lookup.get(NIST_SAMPLE_COLUMN, {}),
            ),
            **consistency_issues,
        }

        base_update = {
            "uploadMode": PREPROCESS_MODE,
            "matrixRawPath": matrix_raw_path,
            "metaRawPath": meta_path,
            "metaPath": processed_meta_path,
            "nistPath": nist_path,
            "isPath": is_path,
            "matrixPreprocessedPath": preprocessed_path,
            "preprocessingReport": preprocessing_report,
            "preprocessingDiagnostics": diagnostics,
        }

        if integrity["errors"]:
            update_project(
                project_id,
                **base_update,
                status="integrity_error",
                details=integrity["errors"],
                integrity_report=preprocessing_report + integrity["report"],
            )
            logger.warning("[Preprocess] Integrity failed after preprocessing | project=%s", project_id)
            return

        update_project(
            project_id,
            **base_update,
            status="integrity_success",
            integrity_report=preprocessing_report + integrity["report"],
        )
        logger.info("[Preprocess] DONE | project=%s", project_id)

    except Exception as exc:
        logger.exception("[Preprocess] CRASH: %s", exc)
        update_project(
            project_id,
            status="integrity_error",
            message=str(exc),
        )

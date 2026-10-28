import pandas as pd
import io
import re
import logging

from services.common import *

logger = logging.getLogger("VALIDATOR")


def clean_name(value):
    return re.sub(r'[^a-zA-Z0-9/_ -]', '', str(value)).replace(' ', '_')


def run_integrity_validation(df_matrix: pd.DataFrame, df_meta: pd.DataFrame):
    report = []
    errors = []

    matrix_samples = set(df_matrix.columns)
    meta_samples = set(df_meta.index)

    logger.info(f"[Integrity] Matrix samples: {len(matrix_samples)}")
    logger.info(f"[Integrity] Meta samples: {len(meta_samples)}")

    if matrix_samples != meta_samples:
        logger.warning("[Integrity] Sample mismatch detected")

        missing_meta = sorted(matrix_samples - meta_samples)
        missing_matrix = sorted(meta_samples - matrix_samples)

        if missing_meta:
            errors.append(f"Missing in metadata: {missing_meta}")
            logger.warning(f"Missing in metadata: {missing_meta}")

        if missing_matrix:
            errors.append(f"Missing in matrix: {missing_matrix}")
            logger.warning(f"Missing in matrix: {missing_matrix}")

        return {"report": report, "errors": errors}

    report.append("Checking data content ... passed.")
    report.append(f"{df_matrix.shape[1]} samples x {df_matrix.shape[0]} features")

    df_matrix.columns = [clean_name(column) for column in df_matrix.columns]
    df_meta.index = [clean_name(index) for index in df_meta.index]

    logger.info("[Integrity] Sample names cleaned")

    if df_meta.shape[1] == 0:
        errors.append("Metadata must contain at least one annotation column.")
        return {"report": report, "errors": errors}

    group_col = df_meta.columns[0]
    group_counts = df_meta[group_col].value_counts()

    logger.info(f"[Integrity] Group column: {group_col}")
    logger.info(f"[Integrity] Group counts:\n{group_counts.to_dict()}")

    return {"report": report, "errors": errors}


# --- HÀM 1: INTEGRITY CHECK ---
def process_integrity_check(project_id: str, uid: str, matrix_path: str, meta_path: str):
    try:
        logger.info(f"[Integrity] START | project={project_id}")

        logger.info("[Integrity] Downloading files...")
        df_matrix = load_csv(uid, project_id, matrix_path, index_col=0)
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        logger.info(f"[Integrity] Matrix shape: {df_matrix.shape}")
        logger.info(f"[Integrity] Meta shape: {df_meta.shape}")

        result = run_integrity_validation(df_matrix, df_meta)
        report = result["report"]
        errors = result["errors"]

        # --- SAVE RESULT ---
        if errors:
            update_project(
                project_id,
                status="integrity_error",
                details=errors,
            )
            logger.error(f"[Integrity] FAILED | errors={len(errors)}")
        else:
            update_project(
                project_id,
                status="integrity_success",
                integrity_report=report,
            )
            logger.info("[Integrity] SUCCESS")

    except Exception as e:
        logger.exception(f"[Integrity] CRASH: {str(e)}")
        update_project(
            project_id,
            status="integrity_error",
            message=str(e),
        )


# --- HÀM 2: META CHECK ---
def process_meta_check(project_id: str, uid: str, meta_path: str):
    try:
        logger.info(f"[MetaCheck] START | project={project_id}")

        logger.info("[MetaCheck] Downloading meta...")
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        logger.info(f"[MetaCheck] Shape: {df_meta.shape}")

        meta_info = []

        for col in df_meta.columns:
            series = df_meta[col]

            series_text = series.astype(str).str.strip()
            missing_mask = series.isna() | (series_text == "") | (series_text.str.lower() == "nan")
            non_missing = series[~missing_mask]
            numeric_non_missing = pd.to_numeric(non_missing, errors='coerce')
            if hasattr(numeric_non_missing.dtype, 'name') and numeric_non_missing.dtype.name == 'boolean':
                numeric_non_missing = numeric_non_missing.astype('Float64')

            is_all_numeric = bool(len(non_missing) > 0 and numeric_non_missing.notna().all())
            unique_numeric = int(numeric_non_missing.dropna().nunique()) if len(non_missing) else 0
            has_decimal = bool(
                len(non_missing) > 0 and
                ((numeric_non_missing.dropna().astype('Float64') - numeric_non_missing.dropna().round().astype('Float64')).abs() > 1e-12).any()
            )

            dtype = "Continuous" if is_all_numeric and (has_decimal or unique_numeric > 5) else "Categorical"

            status = "OK"
            details = []

            if dtype == "Categorical":
                counts = series[~missing_mask].value_counts()
                unique_vals = int(counts.size)

                if unique_vals < 2:
                    status = "Error"
                    details.append("At least two groups are required.")
                elif (counts < 3).any():
                    status = "Warning"
                    details.append("At least one group has fewer than 3 samples.")

                logger.info(f"[MetaCheck] {col} | groups={counts.to_dict()}")

            else:
                logger.info(f"[MetaCheck] {col} | numeric | unique_numeric={unique_numeric} | has_decimal={has_decimal}")

            meta_info.append({
                "name": col,
                "type": dtype,
                "status": status,
                "details": details,
                "groups": [str(g) for g in series[~missing_mask].unique()],
                "group_counts": {str(k): int(v) for k, v in series[~missing_mask].value_counts().to_dict().items()}
            })

        update_project(
            project_id,
            status="meta_check_ready",
            meta_metadata=meta_info,
        )

        logger.info("[MetaCheck] DONE")

    except Exception as e:
        logger.exception(f"[MetaCheck] CRASH: {str(e)}")
        update_project(
            project_id,
            status="error",
            message=str(e),
        )


# --- HÀM 3: SAVE CHECKED META ---
def save_checked_meta(project_id: str, uid: str, meta_path: str, changes: dict):
    try:
        logger.info(f"[SaveMeta] START | project={project_id} | user={uid}")

        logger.info("[SaveMeta] Loading original meta...")
        df = load_csv(uid, project_id, meta_path, index_col=0, skipinitialspace=True)

        # Strip leading/trailing whitespace from column names, index, and string values
        df.columns = df.columns.str.strip()
        df.index = df.index.astype(str).str.strip()
        for col in df.columns:
            if df[col].dtype == object:
                df[col] = df[col].str.strip()

        logger.info(f"[SaveMeta] Shape: {df.shape}")

        # --- SAMPLE EDIT ---
        if "sampleEdits" in changes:
            logger.info("[SaveMeta] Applying sample edits...")

            for col, edits in changes["sampleEdits"].items():
                for sample, new_label in edits.items():
                    if sample in df.index:
                        df.loc[sample, col] = new_label

            logger.info(f"[SaveMeta] Edited columns: {list(changes['sampleEdits'].keys())}")

        # --- ORDER ENCODE ---
        if "orders" in changes:
            logger.info("[SaveMeta] Encoding order...")

            for col, order in changes["orders"].items():
                mapping = {val: i for i, val in enumerate(order)}
                df[f"{col}_encoded"] = df[col].map(mapping)

                logger.info(f"[SaveMeta] Encoded {col} → {col}_encoded")

        # --- SAVE ---
        output = io.StringIO()
        df.to_csv(output)

        new_path = f"projects/{uid}/{project_id}/meta_checked.csv"
        save_text(uid, project_id, new_path, output.getvalue())

        logger.info("[SaveMeta] Saved metadata file")

        # --- DB ---
        update_project(
            project_id,
            status="ready_for_analysis",
            metaCheckedPath=new_path,
        )

        logger.info("[SaveMeta] DONE")

    except Exception as e:
        logger.exception(f"[SaveMeta] CRASH: {str(e)}")
        update_project(
            project_id,
            status="error",
            message=str(e),
        )

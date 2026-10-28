import pandas as pd
import numpy as np
import io
import logging
import time

from services.common import *

logger = logging.getLogger("MATRIX_FILTER")


def process_matrix_filtering(project_id: str, uid: str, matrix_path: str, meta_path: str, settings: dict):
    start_time = time.time()

    try:
        logger.info(f"[Filter] START | project={project_id} | user={uid}")

        # --- LOAD ---
        logger.info("[Filter] Loading data...")
        df = load_csv(uid, project_id, matrix_path, index_col=0)
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        logger.info(f"[Filter] Initial shape: {df.shape}")

        initial_count = len(df)
        report = []

        # ==============================
        # A. MISSING VALUE FILTER
        # ==============================
        mv_limit = min(float(settings.get('mv_threshold', 50)), 100.0) / 100
        logger.info(f"[Filter] Missing value threshold: {mv_limit*100:.1f}%")

        mv_per_row = df.isnull().mean(axis=1)
        before_mv = len(df)
        df = df[mv_per_row <= mv_limit]
        removed_mv = before_mv - len(df)

        logger.info(f"[Filter] MV removed: {removed_mv}")
        report.append(f"Removed {removed_mv} features with >{settings.get('mv_threshold')}% missing values.")

        # ==============================
        # B. RSD FILTER (QC)
        # ==============================
        qc_samples = [s for s in df.columns if 'rsd' in s.lower()]

        logger.info(f"[Filter] RSD samples detected: {qc_samples}")

        if len(qc_samples) >= 3:
            rsd_limit = min(float(settings.get('rsd_threshold', 20)), 100.0) / 100
            logger.info(f"[Filter] RSD threshold: {rsd_limit*100:.1f}%")

            df_qc = df[qc_samples]

            rsd = df_qc.std(axis=1) / df_qc.mean(axis=1).replace(0, np.nan)

            before_rsd = len(df)
            df = df[rsd <= rsd_limit]
            removed_rsd = before_rsd - len(df)

            logger.info(f"[Filter] RSD removed: {removed_rsd}")
            report.append(f"QC detected. Removed {removed_rsd} features with RSD > {settings.get('rsd_threshold')}%.")

            qc_in_matrix = [s for s in qc_samples if s in df.columns]
            if qc_in_matrix:
                df = df.drop(columns=qc_in_matrix)
                logger.info(f"[Filter] Dropped {len(qc_in_matrix)} QC columns from matrix: {qc_in_matrix}")
                report.append(f"Removed {len(qc_in_matrix)} QC sample columns from matrix after RSD filtering.")

            qc_in_meta = [s for s in qc_samples if s in df_meta.index]
            if qc_in_meta:
                df_meta = df_meta.drop(index=qc_in_meta)
                logger.info(f"[Filter] Dropped {len(qc_in_meta)} QC rows from metadata: {qc_in_meta}")
                report.append(f"Removed {len(qc_in_meta)} QC sample rows from metadata after RSD filtering.")
        else:
            logger.warning("[Filter] No QC samples → skip RSD")
            report.append("No QC samples detected. Skip RSD filtering.")

        # ==============================
        # C. LOW VARIANCE FILTER
        # ==============================
        var_percent = min(float(settings.get('var_percent', 40)), 100.0) / 100
        var_method = settings.get('var_method', 'IQR')

        logger.info(f"[Filter] Variance filter: {var_method} | remove bottom {var_percent*100:.1f}%")

        if var_percent > 0:
            if var_method == 'IQR':
                v_scores = df.apply(lambda x: np.percentile(x, 75) - np.percentile(x, 25), axis=1)
            elif var_method == 'SD':
                v_scores = df.std(axis=1)
            else:
                v_scores = df.apply(lambda x: np.median(np.abs(x - np.median(x))), axis=1)

            thresh = v_scores.quantile(var_percent)

            before_var = len(df)
            df = df[v_scores > thresh]
            removed_var = before_var - len(df)

            logger.info(f"[Filter] Variance removed: {removed_var}")
            report.append(f"Filtered out {removed_var} low-variance features (bottom {settings.get('var_percent')}% by {var_method}).")
        else:
            logger.info("[Filter] Skip variance filtering (0%)")
            report.append("Variance filter skipped (0%).")

        # ==============================
        # D. LOW ABUNDANCE FILTER
        # ==============================
        abun_percent = min(float(settings.get('abun_percent', 0)), 100.0) / 100

        if abun_percent > 0:
            method = settings.get('abun_method')
            logger.info(f"[Filter] Abundance filter: {method} | remove bottom {abun_percent*100:.1f}%")

            scores = df.mean(axis=1) if method == 'Mean' else df.median(axis=1)

            before_abun = len(df)
            df = df[scores > scores.quantile(abun_percent)]
            removed_abun = before_abun - len(df)

            logger.info(f"[Filter] Abundance removed: {removed_abun}")
            report.append(f"Filtered out {settings.get('abun_percent')}% low-abundance features.")
        else:
            logger.info("[Filter] Skip abundance filtering")

        # ==============================
        # FINAL STATS
        # ==============================
        final_count = len(df)
        logger.info(f"[Filter] Final features: {final_count} (from {initial_count})")

        # ==============================
        # SAVE
        # ==============================
        output = io.StringIO()
        df.to_csv(output)

        new_path = f"projects/{uid}/{project_id}/matrix_checked.csv"
        save_text(uid, project_id, new_path, output.getvalue())

        logger.info("[Filter] Saved matrix")

        meta_output = io.StringIO()
        df_meta.to_csv(meta_output)
        new_meta_path = f"projects/{uid}/{project_id}/metadata_checked.csv"
        save_text(uid, project_id, new_meta_path, meta_output.getvalue())
        logger.info("[Filter] Saved metadata")

        # ==============================
        # DB
        # ==============================
        update_project(
            project_id,
            status="matrix_check_ready",
            matrixCheckedPath=new_path,
            metaCheckedPath=new_meta_path,
            filtering_report=report,
            final_feature_count=final_count,
        )

        logger.info("[Filter] DONE")

        # ==============================
        # TIME
        # ==============================
        elapsed = time.time() - start_time
        logger.info(f"[Filter] Time elapsed: {elapsed:.2f}s")

    except Exception as e:
        logger.exception(f"[Filter] CRASH: {str(e)}")

        update_project(
            project_id,
            status="error",
            message=str(e),
        )

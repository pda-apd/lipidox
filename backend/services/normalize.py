import pandas as pd
import numpy as np
import io
import logging
import time
from scipy import stats
from sklearn.preprocessing import QuantileTransformer
from sklearn.decomposition import PCA
from pycombat import pycombat

from services.common import *

logger = logging.getLogger("NORMALIZE")

# Zero replacement method (default when not specified in settings):
#   0 = 1/5 Minimum
#   1 = QRILC
ZERO_HANDLING = 0


class Normalizer:
    SUFFIX_MAP = {
        "sample_norm": {"Sum": "NaSum", "Median": "NaMed", "Quantile": "NaQu", "PQN": "NaPqn"},
        "data_trans": {"Log10": "TbL10", "Log2": "TbL2", "Sqrt": "TbSqr", "Cube": "TbCub"},
        "batch_corr": {"ComBat": "BcComb", "Blind": "BcBlnd"},
        "data_scaling": {"MeanCenter": "SdMean", "Auto": "SdAuto", "Pareto": "SdPar", "Range": "SdRan"},
        "zero_handling": {"M1_5": "ZhM1_5"}
    }

    @staticmethod
    def apply_one_fifth_minimum(df):
        logger.info("[Min1_5] Applying 1/5 minimum zero replacement...")
        df_out = df.astype(float).copy()
        for feature in df_out.index:
            row = df_out.loc[feature]
            zeros = row == 0
            if zeros.any():
                positives = row[row > 0]
                m1_5 = positives.min() / 5 if not positives.empty else 1e-12
                df_out.loc[feature, zeros] = m1_5
        return df_out

    @staticmethod
    def apply_pqn(df, df_meta=None):
        logger.info("[PQN] Applying PQN normalization...")
        df_temp = df.replace(0, 1e-9)

        pqn_samples = [s for s in df_temp.columns if 'pqn' in s.lower()]

        if pqn_samples:
            logger.info(f"[PQN] Found {len(pqn_samples)} reference sample(s): {pqn_samples}")
            reference = df_temp[pqn_samples].median(axis=1)
        else:
            logger.warning(
                "[PQN] No PQN reference samples detected (expected sample names or metadata values "
                "containing 'pqn', e.g. 'PQN_1', 'PQN_2'). "
                "Falling back to dataset median as reference spectrum."
            )
            reference = df_temp.median(axis=1)

        quotients = df_temp.div(reference, axis=0)
        quotient_medians = quotients.median(axis=0)
        return df_temp.div(quotient_medians, axis=1)

    @staticmethod
    def apply_zero_replacement(df, tune_sigma=1.0, random_state=42):
        logger.info("[ZeroReplace] Applying QRILC imputation...")

        df_imputed = df.astype(float).copy()
        zero_mask = df_imputed == 0
        total_zeros = int(zero_mask.sum().sum())
        skipped_zeros = 0

        if total_zeros == 0:
            logger.info("[ZeroReplace] No zeros detected; skipping QRILC.")
            return df_imputed

        df_imputed = df_imputed.mask(zero_mask)
        upper_q = 0.999
        rng = np.random.default_rng(random_state)
        global_observed = df_imputed.stack().dropna()
        global_positive = global_observed[global_observed > 0]
        feature_stats = []

        for feature in df_imputed.index:
            curr_feature = df_imputed.loc[feature]
            missing_mask = curr_feature.isna()
            n_missing = int(missing_mask.sum())

            if n_missing == 0:
                continue

            observed = curr_feature.dropna()
            p_nas = n_missing / len(curr_feature)

            if p_nas > 0.8:
                logger.warning(f"[ZeroReplace] Feature '{feature}' has too many missing values ({p_nas:.2%}); skipping QRILC.")
                skipped_zeros += n_missing
                continue

            if observed.empty:
                if global_positive.empty:
                    logger.warning(f"[ZeroReplace] Feature '{feature}' has no observed values; leaving zeros as NaN.")
                    skipped_zeros += n_missing
                    continue
                logger.warning(f"[ZeroReplace] Feature '{feature}' has no observed values; using global positive fallback distribution.")
                observed = global_positive

            observed = observed[observed > 0]
            if observed.empty:
                if global_positive.empty:
                    logger.warning(f"[ZeroReplace] Feature '{feature}' has no positive values; leaving zeros as NaN.")
                    skipped_zeros += n_missing
                    continue
                logger.warning(f"[ZeroReplace] Feature '{feature}' has no positive values; using global positive fallback distribution.")
                observed = global_positive

            log_observed = np.log(observed.to_numpy())
            probs = np.linspace(0.001, 0.1, 100)

            if len(observed) < 5:
                logger.warning(f"[ZeroReplace] Feature '{feature}' too few observations; using mean/sd fallback.")
                mean_cdd = float(log_observed.mean())
                sd_cdd = float(log_observed.std(ddof=1)) if len(log_observed) > 1 else 0.1
            else:
                q_sample = np.quantile(log_observed, probs)
                q_normal = stats.norm.ppf(probs)

                try:
                    slope, intercept = np.polyfit(q_normal, q_sample, 1)
                except np.linalg.LinAlgError:
                    slope = np.nan
                    intercept = np.nan

                mean_cdd = intercept
                sd_cdd = abs(float(slope)) if np.isfinite(slope) else np.nan

                if not np.isfinite(mean_cdd):
                    mean_cdd = float(log_observed.mean())
                if not np.isfinite(sd_cdd) or sd_cdd == 0:
                    sd_cdd = float(log_observed.std(ddof=1)) if len(log_observed) > 1 else 0.0
            if not np.isfinite(sd_cdd) or sd_cdd == 0:
                sd_cdd = max(float(abs(mean_cdd)) * 0.1, 1e-9)

            scale = sd_cdd * tune_sigma
            threshold_prob = float(np.median(probs[:10]))
            threshold = stats.norm.ppf(threshold_prob, loc=mean_cdd, scale=scale)
            truncnorm_upper = (threshold - mean_cdd) / scale
            if truncnorm_upper < -10:
                truncnorm_upper = -10
            try:
                imputed_values = stats.truncnorm.rvs(
                    a=-np.inf,
                    b=truncnorm_upper,
                    loc=mean_cdd,
                    scale=scale,
                    size=n_missing,
                    random_state=rng,
                )
            except TypeError:
                imputed_values = stats.truncnorm.rvs(
                    a=-np.inf,
                    b=truncnorm_upper,
                    loc=mean_cdd,
                    scale=scale,
                    size=n_missing,
                )
            imputed_values = np.exp(imputed_values)
            imputed_values = np.clip(imputed_values, 1e-12, None)

            df_imputed.loc[feature, missing_mask] = imputed_values
            feature_stats.append((feature, p_nas, mean_cdd, sd_cdd))

        imputed_zeros = total_zeros - skipped_zeros
        logger.info(f"[ZeroReplace] QRILC imputed {imputed_zeros} of {total_zeros} zeros across {len(feature_stats)} features.")
        return df_imputed

    @staticmethod
    def shapiro_test(df):
        logger.info("[Shapiro] Calculating normality...")
        normal_count = 0

        for i, (_, row) in enumerate(df.iterrows()):
            data = row.dropna()
            if len(data) >= 3:
                _, p = stats.shapiro(data)
                if p > 0.05:
                    normal_count += 1

            if i < 3:
                logger.debug(f"[Shapiro] Row {i} p={p:.4f}")

        return {
            "normal_features": normal_count,
            "total_features": len(df),
            "percentage": round(normal_count / len(df) * 100, 2) if len(df) > 0 else 0
        }


def process_normalization(project_id, uid, matrix_path, meta_path, settings):
    start_time = time.time()

    try:
        logger.info(f"[Normalize] START | project={project_id} | user={uid}")

        # --- LOAD ---
        logger.info("[Normalize] Loading data...")
        df = load_csv(uid, project_id, matrix_path, index_col=0)
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        logger.info(f"[Normalize] Metadata loaded (read-only): {list(df_meta.columns)}")

        logger.info(f"[Normalize] Shape: {df.shape}")

        # --- SETTINGS ---
        logger.info(f"[Normalize] Settings: {settings}")

        n_before = len(df)
        # Remove only truly all-zero / all-NaN features. Using abs().sum() keeps
        # features whose values sum to <= 0 (e.g. Olink NPX / signed data).
        df = df.loc[df.fillna(0).abs().sum(axis=1) > 0]
        n_removed = n_before - len(df)
        if n_removed > 0:
            logger.info(f"[Normalize] Removed {n_removed} all-zero features ({n_before} → {len(df)})")

        # --- 0. ZERO REPLACEMENT ---
        zero = settings.get('zero', 1)
        if zero == -1:
            logger.info("[Normalize] Zero replacement: None (skipped)")
        elif zero == 0:
            logger.info("[Normalize] Zero replacement: 1/5 minimum...")
            df = Normalizer.apply_one_fifth_minimum(df)
        else:
            logger.info("[Normalize] Zero replacement: QRILC...")
            df = Normalizer.apply_zero_replacement(
                df,
                tune_sigma=settings.get('qrilc_tune_sigma', 1.0),
                random_state=settings.get('qrilc_random_state', 42),
            )

        # --- 1. SAMPLE NORMALIZATION ---
        sn = settings.get('sample_norm')
        if sn:
            logger.info(f"[Normalize] Sample normalization: {sn}")

        if sn == "Sum":
            df = df.div(df.sum(), axis=1) * df.sum().mean()

        elif sn == "Median":
            df = df.div(df.median(), axis=1) * df.median().mean()

        elif sn == "Quantile":
            logger.info("[Normalize] Running QuantileTransformer...")
            qt = QuantileTransformer(output_distribution='normal', n_quantiles=min(len(df), 100))
            df = pd.DataFrame(qt.fit_transform(df.T).T, index=df.index, columns=df.columns)

        elif sn == "PQN":
            df = Normalizer.apply_pqn(df, df_meta=df_meta)

  # --- 2. DATA TRANSFORMATION ---
        dt = settings.get('data_trans')
        if dt:
            logger.info(f"[Normalize] Data transformation: {dt}")
            if dt == "Log10":
                df = np.log10(df.replace(0, np.nan))
            elif dt == "Log2":
                df = np.log2(df.replace(0, np.nan))
            elif dt == "Sqrt":
                df = np.sqrt(df.clip(lower=0))
            elif dt == "Cube":
                df = np.cbrt(df)

        # --- 3. BATCH CORRECTION ---
        bc = settings.get('batch_corr')
        if bc:
            logger.info(f"[Normalize] Batch correction: {bc}")
            if bc == "ComBat" and settings.get('batch_col'):
                batch_col = settings.get('batch_col')
                logger.info(f"[Normalize] Using batch column: {batch_col}")
                df = pycombat(
                    df,
                    df_meta.loc[df.columns, batch_col].values
                )
            elif bc == "Blind":
                logger.info("[Normalize] Running PCA (Blind correction) — assumes PC1 = technical variation...")
                pca = PCA(n_components=1)
                pcs = pca.fit_transform(df.T)
                df = (df.T - pca.inverse_transform(pcs)).T

        # --- 4. DATA SCALING ---
        df_prescale = df.copy()

        ds = settings.get('data_scaling')
        if ds:
            logger.info(f"[Normalize] Data scaling: {ds}")
            if ds != "None":
                mean = df.mean(axis=1)
                std = df.std(axis=1).replace(0, 1)

                if ds == "MeanCenter":
                    df = df.sub(mean, axis=0)
                elif ds == "Auto":
                    df = df.sub(mean, axis=0).div(std, axis=0)
                elif ds == "Pareto":
                    df = df.sub(mean, axis=0).div(np.sqrt(std), axis=0)
                elif ds == "Range":
                    divisor = (df.max(axis=1) - df.min(axis=1)).replace(0, 1)
                    df = df.sub(mean, axis=0).div(divisor, axis=0)

        # --- 5. NORMALITY ---
        stat = Normalizer.shapiro_test(df)
        logger.info(f"[Normalize] Normality: {stat}")

        # --- 6. SAVE ---
        name_parts = ["matrix_checked"]
        for k in ["sample_norm", "data_trans", "batch_corr", "data_scaling"]:
            val = settings.get(k, "None")
            if val != "None":
                name_parts.append(Normalizer.SUFFIX_MAP[k][val])
        zero = settings.get('zero', 1)
        if zero == 0:
            name_parts.append(Normalizer.SUFFIX_MAP["zero_handling"]["M1_5"])
        elif zero == 1:
            name_parts.append("ZhQrilc")

        new_filename = f"{'_'.join(name_parts)}.csv"
        new_path = f"projects/{uid}/{project_id}/{new_filename}"

        logger.info(f"[Normalize] Saving file: {new_filename}")

        output = io.StringIO()
        df.to_csv(output)
        save_text(uid, project_id, new_path, output.getvalue())

        logger.info("[Normalize] Upload completed")

        # --- PRE-SCALE FILE (for statistical tests: t-test, ANOVA, biomarker) ---
        name_parts_pre = ["matrix_checked"]
        for k in ["sample_norm", "data_trans", "batch_corr"]:
            val = settings.get(k, "None")
            if val != "None":
                name_parts_pre.append(Normalizer.SUFFIX_MAP[k][val])
        if zero == 0:
            name_parts_pre.append(Normalizer.SUFFIX_MAP["zero_handling"]["M1_5"])
        elif zero == 1:
            name_parts_pre.append("ZhQrilc")

        ds = settings.get('data_scaling', 'None')
        if ds and ds != "None":
            pre_scale_filename = f"{'_'.join(name_parts_pre)}_preScale.csv"
            pre_scale_path = f"projects/{uid}/{project_id}/{pre_scale_filename}"
            pre_output = io.StringIO()
            df_prescale.to_csv(pre_output)
            save_text(uid, project_id, pre_scale_path, pre_output.getvalue())
            logger.info("[Normalize] Pre-scale file upload completed")
        else:
            pre_scale_path = new_path

        # --- DB ---
        update_project(
            project_id,
            status="norm_ready",
            matrixNormPath=new_path,
            matrixPreScalePath=pre_scale_path,
            normality_stat=stat,
            norm_settings=settings,
        )

        logger.info("[Normalize] DONE")

        # --- TIME ---
        elapsed = time.time() - start_time
        logger.info(f"[Normalize] Time elapsed: {elapsed:.2f}s")

    except Exception as e:
        logger.exception(f"[Normalize] CRASH: {str(e)}")

        update_project(
            project_id,
            status="error",
            message=str(e),
        )

import pandas as pd
import seaborn as sns
import matplotlib
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import io
import time
import numpy as np
import logging

from services.common import *

matplotlib.use('Agg')

logger = logging.getLogger("HEATMAP")


def _merge_heatmap_history(history, entry):
    existing = history if isinstance(history, list) else []
    return [entry] + [item for item in existing if isinstance(item, dict) and item.get("run_id") != entry.get("run_id")]


def generate_heatmap_epress(project_id, uid, matrix_path, meta_path, settings, run_id=None, task_id=None):
    start_time = time.time()

    try:
        logger.info(f"[Heatmap] START | project={project_id} | user={uid}")

        if run_id:
            project_data = get_project_data(project_id)
            history = project_data.get("heatmap_history") or []
            running_entry = {
                "run_id": run_id,
                "task_id": task_id,
                "status": "running",
                "message": "Heatmap is running...",
                "updated_at": utc_now_iso(),
            }
            update_project(
                project_id,
                heatmap_history=_merge_heatmap_history(history, {
                    **next((item for item in history if isinstance(item, dict) and item.get("run_id") == run_id), {}),
                    **running_entry,
                }),
            )

        # --- LOAD ---
        logger.info("[Heatmap] Loading data...")
        df = load_csv(uid, project_id, matrix_path, index_col=0)
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        logger.info(f"[Heatmap] Matrix shape: {df.shape}")
        logger.info(f"[Heatmap] Meta shape: {df_meta.shape}")

        # --- SETTINGS ---
        mode = settings.get('mode')
        scale_mode = str(settings.get('scale_mode') or 'row_zscore').strip().lower()
        meta_col = settings.get('meta_col')
        selected_features = [str(feature) for feature in (settings.get('selected_features') or []) if str(feature)]
        preserve_feature_order = bool(settings.get('preserve_feature_order'))
        feature_sections = settings.get('feature_sections') if isinstance(settings.get('feature_sections'), list) else []
        palette = settings.get('palette', 'RdBu_r')
        fig_w, fig_h = float(settings.get('width', 12)), float(settings.get('height', 10))
        logger.info(f"[Heatmap] Mode: {mode}")
        logger.info(f"[Heatmap] Scale mode: {scale_mode}")
        logger.info(f"[Heatmap] Meta column: {meta_col}")
        logger.info(f"[Heatmap] Selected features: {len(selected_features)} | Preserve order: {preserve_feature_order}")
        logger.info(f"[Heatmap] Palette: {palette}")
        logger.info(f"[Heatmap] Figure size: {fig_w}x{fig_h}")

        common_samples = df.columns.intersection(df_meta.index)
        if common_samples.empty:
            raise ValueError("No overlap between matrix samples and metadata rows.")
        df = df[common_samples]
        df_meta = df_meta.loc[common_samples].copy()

        if selected_features:
            ordered_features = [feature for feature in selected_features if feature in df.index]
            if not ordered_features:
                raise ValueError("No selected features matched the normalized matrix.")
            df = df.loc[ordered_features]

        # reset cache
        update_project(project_id, heatmap_url=None)

        # ==============================
        # DATA PREP
        # ==============================
        if mode == "per_sample":
            logger.info("[Heatmap] Mode: per_sample")
            df_meta_plot = df_meta.sort_values(by=meta_col)
            df_plot = df[df_meta_plot.index]
            logger.info(f"[Heatmap] Samples ordered: {len(df_plot.columns)}")
        else:
            logger.info("[Heatmap] Mode: mean_expression")
            df_plot = df.T.join(df_meta[[meta_col]]).groupby(meta_col).mean().T
            df_meta_plot = pd.DataFrame({meta_col: df_plot.columns}, index=df_plot.columns)
            logger.info(f"[Heatmap] Groups: {df_plot.columns.tolist()}")

        logger.info(f"[Heatmap] Plot shape: {df_plot.shape}")

        if scale_mode == "row_zscore":
            logger.info("[Heatmap] Applying row z-score scaling")
            row_mean = df_plot.mean(axis=1)
            row_std = df_plot.std(axis=1).replace(0, np.nan)
            df_plot = df_plot.sub(row_mean, axis=0).div(row_std, axis=0).fillna(0.0)
        else:
            logger.info("[Heatmap] Keeping raw values")

        # ==============================
        # COLOR ANNOTATION
        # ==============================
        unique_groups = df_meta_plot[meta_col].unique()
        logger.info(f"[Heatmap] Unique groups: {list(unique_groups)}")

        colors = sns.color_palette("Set2", len(unique_groups))
        lut = dict(zip(unique_groups, colors))
        col_colors = df_meta_plot[meta_col].map(lut)

        # ==============================
        # PLOT
        # ==============================
        plt.close('all')

        logger.info("[Heatmap] Generating clustermap...")

        g = sns.clustermap(
            df_plot,
            cmap=palette,
            method='ward',
            metric='euclidean',
            col_cluster=False if mode == "per_sample" else True,
            row_cluster=not preserve_feature_order,
            col_colors=col_colors,
            figsize=(fig_w, fig_h),
            cbar_pos=(1.02, 0.1, 0.03, 0.25),
            cbar_kws={'label': 'Normalize Expression'},
            xticklabels=True,
            yticklabels=True,
            standard_scale=None,
            z_score=None,
            linewidths=0
        )

        logger.info("[Heatmap] Clustermap generated")

        # ==============================
        # SEPARATOR LINES
        # ==============================
        if mode == "per_sample":
            group_sizes = df_meta_plot[meta_col].value_counts(sort=False)
            logger.info(f"[Heatmap] Group sizes: {group_sizes.to_dict()}")

            current_pos = 0
            for size in group_sizes[:-1]:
                current_pos += size
                g.ax_heatmap.axvline(current_pos, color='white', lw=3)
                g.ax_col_colors.axvline(current_pos, color='white', lw=3)
        else:
            logger.info("[Heatmap] Drawing group separators (mean mode)")
            for i in range(1, len(df_plot.columns)):
                g.ax_heatmap.axvline(i, color='white', lw=3)
                g.ax_col_colors.axvline(i, color='white', lw=3)

        if preserve_feature_order and feature_sections:
            logger.info("[Heatmap] Drawing feature block separators")
            current_pos = 0
            for section in feature_sections[:-1]:
                try:
                    current_pos += int(section.get('count', 0))
                except Exception:
                    continue
                if current_pos > 0:
                    g.ax_heatmap.axhline(current_pos, color='white', lw=2.5)

        # ==============================
        # LEGEND
        # ==============================
        logger.info("[Heatmap] Creating legend...")

        patches = [mpatches.Patch(color=c, label=l) for l, c in lut.items()]

        g.fig.legend(
            handles=patches,
            title=f"Groups: {meta_col}",
            bbox_to_anchor=(1.01, 0.82),
            loc='upper left',
            frameon=False,
            title_fontproperties={'weight': 'bold'}
        )

        # ==============================
        # SAVE IMAGE
        # ==============================
        logger.info("[Heatmap] Saving image (300 DPI)...")

        img_buf = io.BytesIO()
        plt.savefig(img_buf, format='jpg', dpi=300, bbox_inches='tight')
        img_buf.seek(0)

        timestamp = int(time.time())
        dest_path = f"projects/{uid}/{project_id}/heatmap_{timestamp}.jpg"

        img_url = upload_public(uid, project_id, dest_path, img_buf.getvalue(), 'image/jpeg')

        logger.info("[Heatmap] Upload completed")

        # ==============================
        # DB
        # ==============================
        project_data = get_project_data(project_id)
        history = project_data.get("heatmap_history") or []
        done_entry = {
            **next((item for item in history if isinstance(item, dict) and item.get("run_id") == run_id), {}),
            "run_id": run_id,
            "task_id": task_id,
            "status": "done",
            "message": "Heatmap generated successfully.",
            "heatmap_url": img_url,
            "updated_at": utc_now_iso(),
            "completed_at": utc_now_iso(),
        } if run_id else None

        update_project(
            project_id,
            heatmap_url=img_url,
            heatmap_status="ready",
            **({"heatmap_history": _merge_heatmap_history(history, done_entry)} if done_entry else {}),
        )

        logger.info("[Heatmap] DONE")

        # ==============================
        # TIME
        # ==============================
        elapsed = time.time() - start_time
        logger.info(f"[Heatmap] Time elapsed: {elapsed:.2f}s")

    except Exception as e:
        logger.exception(f"[Heatmap] CRASH: {str(e)}")
        project_data = get_project_data(project_id)
        history = project_data.get("heatmap_history") or []
        error_entry = {
            **next((item for item in history if isinstance(item, dict) and item.get("run_id") == run_id), {}),
            "run_id": run_id,
            "task_id": task_id,
            "status": "error",
            "message": str(e),
            "updated_at": utc_now_iso(),
            "completed_at": utc_now_iso(),
        } if run_id else None

        update_project(
            project_id,
            status="error",
            message=str(e),
            **({"heatmap_history": _merge_heatmap_history(history, error_entry)} if error_entry else {}),
        )

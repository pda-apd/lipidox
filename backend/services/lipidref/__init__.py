"""Lazy loaders for the LipidSigR annotation snapshots (parquet).

Tables are one-time exports from the LipidSigR R package (see
tools/export_lipidsigr_data.R) so the portal resolves lipid IDs fully
offline, with the exact data verified locally in LOCAL_ANALYSIS.md.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict

import pandas as pd

DATA_DIR = Path(__file__).parent / "data"

_cache: Dict[str, pd.DataFrame] = {}


def load_table(name: str) -> pd.DataFrame:
    """Load a parquet snapshot by stem name (cached)."""
    if name not in _cache:
        path = DATA_DIR / f"{name}.parquet"
        if not path.is_file():
            raise FileNotFoundError(
                f"Lipid reference table missing: {path}. "
                "Run tools/export_lipidsigr_data.R + parquet conversion first."
            )
        _cache[name] = pd.read_parquet(path)
    return _cache[name]

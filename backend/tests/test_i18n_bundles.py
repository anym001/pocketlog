"""Both translation bundles must carry the same key set.

A missing key in one bundle would render as the raw key (`tr()`
fallback) on language switch. Pinning the diff here means a forgotten
translation fails CI immediately, not in production.
"""
from __future__ import annotations

import json
from pathlib import Path

FRONTEND_I18N = Path(__file__).resolve().parents[2] / "frontend" / "i18n"


def _flatten(prefix: str, value, out: set[str]) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            key = f"{prefix}.{k}" if prefix else k
            _flatten(key, v, out)
    else:
        out.add(prefix)


def _keys_of(bundle: str) -> set[str]:
    with (FRONTEND_I18N / f"{bundle}.json").open() as fh:
        data = json.load(fh)
    out: set[str] = set()
    _flatten("", data, out)
    return out


def test_bundle_key_sets_match():
    de = _keys_of("de")
    en = _keys_of("en")
    only_de = de - en
    only_en = en - de
    assert not only_de and not only_en, (
        f"i18n key drift — only in de: {sorted(only_de)} | "
        f"only in en: {sorted(only_en)}"
    )

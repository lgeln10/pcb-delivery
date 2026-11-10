"""Op vocabulary ⇄ mapping doc ⇄ stage registry stay in sync."""

import re
from pathlib import Path

from engine.adapters import OPS, STAGE_OPS, CamOp
from engine.pipeline.registry import STAGE_NAMES

DOC = Path(__file__).resolve().parents[1] / "docs" / "genesis_op_mapping.md"


def _doc_sections() -> dict[str, int]:
    text = DOC.read_text(encoding="utf-8")
    return {m.group(2): int(m.group(1)) for m in re.finditer(r"^## (\d+)\. ([A-Za-z]+)", text, re.MULTILINE)}


def _doc_overview() -> set[str]:
    text = DOC.read_text(encoding="utf-8")
    return set(re.findall(r"^\| \d+ \| (\w+) \|", text, re.MULTILINE))


def test_every_op_has_a_doc_section():
    sections = _doc_sections()
    missing = [op.value for op in CamOp if op.value not in sections]
    assert not missing, f"ops without a '## N. <op>' section in {DOC.name}: {missing}"


def test_doc_has_no_unknown_ops():
    known = {op.value for op in CamOp}
    extra = set(_doc_sections()) - known
    assert not extra, f"doc sections that are not CamOp members: {sorted(extra)}"
    assert _doc_overview() == known


def test_doc_section_numbers_are_unique_and_dense():
    nums = sorted(_doc_sections().values())
    assert nums == list(range(1, len(CamOp) + 1))


def test_every_op_belongs_to_a_known_stage():
    for spec in OPS.values():
        assert spec.stage in STAGE_NAMES, spec
    assert set(STAGE_OPS) <= set(STAGE_NAMES)


def test_pages_are_within_pdf():
    for spec in OPS.values():
        assert spec.pages and all(1 <= p <= 219 for p in spec.pages), spec


def test_names_are_stable_identifiers():
    for op in CamOp:
        assert re.fullmatch(r"[A-Z][A-Za-z]+", op.value), op

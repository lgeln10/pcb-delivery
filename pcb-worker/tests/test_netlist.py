"""Netlist extraction + the two compares (p130) on synthetic copper and on the sample boards."""

from __future__ import annotations

from shapely.geometry import Point, box
from shapely.ops import unary_union

from engine.netlist.extract import (
    CopperLayerNodes,
    HoleLink,
    apply_declared,
    compare_reduced,
    extract_nets,
    find_shorts_and_opens,
    reduce_layers,
)


def _layer(rel, index, *polys):
    return CopperLayerNodes(rel=rel, index=index, polys=list(polys))


def test_holes_join_layers_within_span():
    top = _layer("top", 1, box(0, 0, 2, 2), box(10, 0, 12, 2))
    in1 = _layer("in1", 2, box(0, 0, 2, 2))
    bot = _layer("bot", 3, box(0, 0, 2, 2), box(10, 0, 12, 2))
    holes = [HoleLink(1, 1, 0.5, (1, 3)), HoleLink(11, 1, 0.5, (1, 2))]  # second is blind 1-2: no copper on in1 there
    nl = extract_nets({"top": top, "in1": in1, "bot": bot}, holes)
    nets = sorted((sorted(n.nodes) for n in nl.nets), key=len, reverse=True)
    assert nets[0] == [("bot", 0), ("in1", 0), ("top", 0)]
    assert [("top", 1)] in nets and [("bot", 1)] in nets  # blind via cannot reach the bottom


def test_shorts_and_opens_from_declared_names():
    top = _layer("top", 1, box(0, 0, 4, 1), box(10, 0, 11, 1), box(12, 0, 13, 1))
    nl = extract_nets({"top": top}, [])
    declared = {"top": [("A", Point(0.5, 0.5), None), ("B", Point(3.5, 0.5), None), ("C", Point(10.5, 0.5), None), ("C", Point(12.5, 0.5), None)]}
    unplaced = apply_declared(nl, declared)
    assert not unplaced
    shorts, opens = find_shorts_and_opens(nl)
    assert len(shorts) == 1 and shorts[0].names == ["A", "B"]
    assert len(opens) == 1 and opens[0].name == "C" and len(opens[0].pieces) == 1


def test_reduce_splits_thin_neck():
    neck = unary_union([box(0, 0, 2, 2), box(2, 0.95, 4, 1.05), box(4, 0, 6, 2)])  # 0.1 mm neck
    solid = unary_union([box(10, 0, 12, 2), box(12, 0.5, 14, 1.5), box(14, 0, 16, 2)])  # 1 mm neck
    layers = {"top": _layer("top", 1, neck, solid)}
    nl = extract_nets(layers, [])
    reduced = extract_nets(reduce_layers(layers, 0.15), [])
    splits = compare_reduced(nl, reduced)
    assert len(splits) == 1 and splits[0].n_pieces == 2
    assert splits[0].pieces[0][1].bounds[0] >= 0 and splits[0].pieces[0][1].bounds[2] <= 6.1


def test_stage_on_sample_boards(pipeline):
    for board, has_ref in (("kicad-x2ap", False), ("eagle-newer", False)):  # Flashpads: every net is N/C
        rep = pipeline.run(board, "net_compare")
        assert rep.status in ("ok", "needs_review"), (board, rep.summary)
        kinds = {i.kind for i in rep.items}
        assert "net_summary" in kinds and "layer_parse_error" not in kinds
        assert ("no_reference_netlist" in kinds) == (not has_ref), (board, kinds)
        if has_ref:
            assert "net_short" not in kinds, [i.message for i in rep.items if i.kind == "net_short"]
        assert any(a.filename == "netlist.json" for a in rep.artifacts)

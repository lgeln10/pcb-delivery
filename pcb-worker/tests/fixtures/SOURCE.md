# Test fixtures: source and licensing

All three boards were copied verbatim from the gerbonara test-suite
(`tests/resources/` in https://gitlab.com/gerbolyze/gerbonara, commit `736107f`,
gerbonara 1.6.x). gerbonara itself is Apache-2.0; the boards carry their own
upstream licences as recorded by the gerbonara maintainers:

| fixture dir        | EDA tool / format                                   | upstream                                                              | licence                    |
|--------------------|-----------------------------------------------------|-----------------------------------------------------------------------|----------------------------|
| `kicad-x2ap/`      | KiCad 5.99 (Gerber X2 + aperture attributes), PTH/NPTH Excellon | gerbonara `tests/resources/kicad-x2-tests/x2ap`; originally posted on forum.kicad.info (JLCPCB X2 thread, "Flashpads" test board) | test board shared publicly on the KiCad forum; no explicit licence file upstream -- treat as test-only, do not redistribute outside this repo |
| `altium-limesdr/`  | Altium Designer, 12-layer, composite drill (`;TYPE=PLATED`), routed slots, `.apr`/`.REP`/`.RUL` side files | gerbonara `tests/resources/altium-composite-drill` <- https://github.com/myriadrf/LimeSDR-QPCIe | CC-BY 3.0 Unported (see `LICENSE`) |
| `eagle-newer/`     | Autodesk EAGLE 9.0 (Gerber X2 written as `G04 #@!` comments), `.xln` drill, `.gbrjob` | gerbonara `tests/resources/eagle-newer` <- https://github.com/GanzYouthWorkshop/GYW-Electro-Curriculum | MIT (see `LICENSE`) |

The IPC-356 checks in `docs/tech-verification.md` used `tests/resources/ipc-d-356.ipc`
and `tests/resources/allegro-2/MinnowMax_RevA1_IPC356A.ipc` (CC-BY-SA 3.0, CircuitCo)
directly from the gerbonara checkout; they are **not** copied here.

The fixtures are used for parser/geometry regression tests only; they are not
part of any product deliverable.

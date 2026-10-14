# Phase 7 rendering comparison

- baseline: `docs/verification/rendering-performance/baseline-native.json`
- candidate: `docs/verification/rendering-performance/baseline-deferred-current.json`

- correctness: **pass**
- no-regression: **pass**
- optimization success: **not-achieved**

| metric | baseline | candidate | change | reduction | target |
|---|---|---|---|---|---|
| cpuP95 | 5.200 | 8.200 | +57.7% | -57.7% | 15% |
| gpuP50 | 2.122 | 20.751 | +878.0% | -878.0% | 10% |
| programBinds | 0.000 | 0.000 | not comparable | not comparable | 30% |

| counter | baseline | candidate |
|---|---|---|
| drawCalls | 84 | 666 |
| submittedCommands | 621 | 608 |
| drawHookInvocations | 94758 | 190928 |
| ccrTextureBytes | 8294400 | 143240712 |
| poolPeakBytes | 0 | 0 |
| graphPeakBytes | 0 | 0 |
| validFrames | 300 | 300 |
| invalidFrames | 0 | 0 |

## Caveats

- tracked allocation bytes are CCR-owned allocations, not true board VRAM
- headless/short samples are not production performance
- GPU timing available on both sides

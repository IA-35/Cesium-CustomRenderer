webgpu-cesium RenderGraph adaptation
Copyright 2026 webgpu-cesium contributors

This project adapts the Render Graph declaration, dependency analysis, topological ordering,
transient lifetime and alias-slot algorithms from:
https://github.com/Xiaobai-grow/webgpu-cesium/blob/main/packages/renderer/src/graph/RenderGraph.ts

The original project is licensed under the Apache License, Version 2.0.
The current adapter removes WebGPU execution and integrates with the Cesium WebGL2
RenderTargetPool143 implementation.

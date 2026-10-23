// Cesium 1.143 私有场景状态的唯一读取入口。升级 Cesium 时只需核对本文件。
//
// 全部实时读取、不缓存：约一半调用点在 updateAndExecuteCommands 之外（诊断、scopeReason、preUpdate、
// 后处理 uniform 回调），按调用缓存的快照在那里会过期——拾取后仍指向拾取视图，缩放后指向已销毁的
// framebuffer。逐 draw 的热点已由 SceneTargets143 的目标种类承担。
// 全部为空安全读取：路径缺失时返回 undefined / false，调用点保留各自的默认值。
// tests/rendering/cesium-private-gateway.test.mjs 会检查 src/ 下没有其它文件再直接读这些字段。

// ---- View ----
export const viewOf = scene => scene?._view
export const frustumBinsOf = scene => scene?._view?.frustumCommandsList
export const viewPassStateOf = scene => scene?._view?.passState

// 1.143 的 sceneFramebuffer.framebuffer getter 返回 _colorFramebuffer.framebuffer，globeDepth.framebuffer
// 返回 colorFramebufferManager.framebuffer。取 framebuffer 统一走 getter，跨版本更稳。
export const sceneColorManagerOf = scene => scene?._view?.sceneFramebuffer?._colorFramebuffer
export const sceneColorFramebufferOf = scene => scene?._view?.sceneFramebuffer?.framebuffer
export const selectedIdFramebufferOf = scene => scene?._view?.sceneFramebuffer?.idFramebuffer

// 拾取时 colorFramebufferManager 切到独立的拾取目标，getter 跟着切换。
export const globeColorManagerOf = scene => scene?._view?.globeDepth?.colorFramebufferManager
export const globeColorFramebufferOf = scene => scene?._view?.globeDepth?.framebuffer

// ---- OIT ----
export const oitOf = scene => scene?._view?.oit
export const oitOpaqueTextureOf = scene => scene?._view?.oit?._opaqueTexture
export const oitAccumulationTextureOf = scene => scene?._view?.oit?._accumulationTexture
export const oitRevealageTextureOf = scene => scene?._view?.oit?._revealageTexture
export const oitMrtSupported = scene => !!scene?._view?.oit?._translucentMRTSupport
export const oitMultipassSupported = scene => !!scene?._view?.oit?._translucentMultipass
export const oitOpaqueSamplesOf = scene => scene?._view?.oit?._opaqueFBO?._numSamples
export const oitTranslucentFramebufferOf = scene => scene?._view?.oit?._translucentFBO?.framebuffer
export const oitAlphaFramebufferOf = scene => scene?._view?.oit?._alphaFBO?.framebuffer

// ---- Environment state（Cesium 在每次 updateAndExecuteCommands 前由 updateEnvironment 重算）----
export const hasEnvironmentState = scene => !!scene?._environmentState
export const usesOit = scene => scene?._environmentState?.useOIT === true
export const usesWebVR = scene => scene?._environmentState?.useWebVR === true
export const usesInvertClassification = scene => scene?._environmentState?.useInvertClassification === true
export const usesPostProcessSelected = scene => scene?._environmentState?.usePostProcessSelected === true
export const usesGlobeDepthFramebuffer = scene => scene?._environmentState?.useGlobeDepthFramebuffer === true
export const clearsGlobeDepth = scene => scene?._environmentState?.clearGlobeDepth === true
export const usesDepthPlane = scene => scene?._environmentState?.useDepthPlane === true
export const depthPlaneCommandOf = scene => scene?._depthPlane?._command
export const globeTranslucent = scene => scene?._globeTranslucencyState?.translucent === true

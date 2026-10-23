# 树木阴影关闭与 Viewer 生命周期修复

日期：2026-10-20。验收页面：`http://127.0.0.1:81/#/campus`。

## 修改

- CCR `src/instances/FixedTreeCollection.js`：EzTree 的 castShadows 改为 false，覆盖程序化几何和通过 EzTree 批量绘制的 GLB 树木。该上游开关同时关闭树木接收阴影。建筑和地面阴影配置未变。
- 业务仓库 `src/plugins/actionCenter.js`：注册返回注销函数，仅在当前回调仍属于该注册时删除；旧组件卸载不会删除新组件同名注册。
- 业务 `MainMapView.vue`：跟踪并卸载 23 个全局回调，清空模块级 Viewer、拾取实体和选中建筑引用。
- 校园父页面、xyzlIndex、sjmyIndex：将其 6 个全局回调注销接入 Vue beforeDestroy hook，避免父页面/面板间接保留已卸载的地图组件树。
- 业务瓦片加载批次捕获原 Viewer，停止销毁/替换后的排队任务；异步返回的旧瓦片在登记前释放，不再通过模块级 viewer 进入新场景。

没有修改 Map.vue（该文件标记不修改）。其已有销毁顺序为兼容适配器 → CCR 管线 → Viewer；模型、瓦片、植被 primitive 的实际销毁已通过运行时验收。SharedGlbTextureCache 已有资源缓存键 hook 还原与 activeCache 释放；植被、车流、拾取 handler、罗盘事件和加载会话也已有对应清理入口，本轮未另建释放框架。

## 验证

- CCR 树木定向测试：8/8。
- 业务生命周期测试：3/3，覆盖注销不误删新注册、地图卸载、Viewer 替换期间迟到瓦片释放与后续批次停止。
- 修改的 Vue script 均通过语法解析；实际 dev 页面编译和挂载成功。
- `npm run build` 成功；CCR.min.js SHA-256：`d2d04157eaeb8d11ba76cdf34a898db42e8504f75ffce634c818cbfc34047e3d`。已同步到业务 `public/js/CCR.min.js`，没有重打包业务 dist。
- 路由守卫没有允许测试跳转离开校园，因此该次跳转不算卸载验收。最终使用临时替换根组件 render 并通过 Vue 正常 patch 卸载、恢复的方式验证；原 render 已恢复，未改路由守卫或认证状态。
- 卸载前记录 74 个对象（70 Model、2 Tileset、2 EzTree primitive）。卸载后全部 isDestroyed=true；Viewer、地图组件、管线均销毁，管线 rhi=null，旧 canvas 已脱离 DOM，23 个地图回调清空，地图和校园列表等全局查询回调不再可用。
- 重建后是新的 Viewer：70 个建筑 Model ready、77 个根 primitive、仅一个 Cesium canvas；23 个地图回调重新注册。两组树木提交 26+24 条绘制，投射阴影命令为 0，阴影 caster 数由此前同视角 571 降至 521；全局 shadows=true。
- 捕获到的 pageerror 为 0。页面同时提示后端登录过期，选择取消保留场景，没有进行登录或变更账号；不将场景验收等同于已验证认证业务接口。

原始证据位于本目录 tree-lifecycle/。截图是最终恢复后的业务页面。单次卸载重建证明资源销毁路径有效，不等同于已证明长期无内存增长、驱动显存立即归还或全部长帧消失；本轮没有强制 GC，也没有重复进行重型性能采样。

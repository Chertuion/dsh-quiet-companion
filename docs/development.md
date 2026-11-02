# 开发与验证

本文记录开发环境、构建流程和验证边界，不代表某个版本已安装到用户日常 Desktop profile。安装入口见[项目首页](../README.md)，用户操作见[使用指南](guide.md)。

## 环境与依赖

- Node.js 24及以上，与当前 Harness 开发环境保持兼容。
- Apple Silicon Mac、macOS 14及以上；原生组件使用 Swift、AppKit、ScreenCaptureKit、Speech 与系统框架。
- 构建原生组件需要 Xcode Command Line Tools。安装已打包插件不需要自行编译。
- 开发依赖固定在 `package-lock.json`；不需要新的模型账号或独立 API Key。

在仓库根目录运行：

```sh
npm ci --ignore-scripts
npm run build:client
npm test
./native/build.sh
```

`npm ci --ignore-scripts` 按锁文件安装依赖，不运行安装生命周期脚本。客户端构建是本机离线的闭包工厂打包，共用 Host 的 React 和 UI 组件，不额外捆绑一份 React。

## 客户端设置页

入口源码在 `client/`，发布产物是根目录的 `client.js`。改动后运行 `npm run build:client`，避免测试或安装仍使用旧产物。

协议与生命周期测试使用假连接。React SSR 测试需要已经安装依赖的 Harness 源码目录：

```sh
DSH_HARNESS_DIR="/path/to/deepseek-harness" npm test
```

未提供可用的 Host React 环境时，这部分 SSR 检查会跳过；其他测试通过不能代替页面渲染验证。SSR 本身也不等同于真实 Desktop 的点击、布局或权限窗口验收。

设置页注册到 Host 的 `settings.section`，与其他设置同级；读取快照与保存设置走 Host 已认证的 `/api/quiet-companion/` 接口，仅允许所有者。页面挂载时轮询，关闭后停止。读取快照不启动采集或模型请求；屏幕、系统声音和鼠标权限必须由明确操作触发。

## 原生构建与素材

`native/build.sh` 在独立的临时目录编译、签名和验证，最后一行输出 `.app` 路径。可选的第一个参数用于复制完成的 bundle；日常开发可以先保留独立产物，完成检查后再打包。

唯一角色素材来源是 `assets/orange-character/`。构建先验证清单、橙发角色标识和 PNG，缺失或无效时失败，不从旧 bundle 或旧角色目录恢复素材。新 bundle 只复制两张立绘、四套图集与清单。

清单为 `schemaVersion: 2`、`characterId: orange-book-companion`、4列×4行，完整提供16种状态，每种4个关键帧。1254像素图集按整数 floor 边界裁切，使用一致的名义显示尺寸；素材、交互区域和嘴部锚点约定见 [native/README.txt](../native/README.txt)。图集动画不是 Live2D 或连续视频。

将路径替换为构建脚本实际输出：

```sh
companion_app="/path/to/QuietCompanion.app"
codesign --verify --strict "$companion_app"
"$companion_app/Contents/MacOS/QuietCompanion" --self-test
python3 native/protocol-test.py "$companion_app" --launch-services
```

构建脚本执行本地 ad-hoc 签名及严格验证。严格签名验证不等于 Developer ID 签名或 Apple 公证；也不修改 Harness 应用或它的签名。

## LaunchServices 与本机协议

正式启动通过 LaunchServices 打开完整 `.app`，使用插件拥有的私有 Unix socket 通信。临时目录为0700、socket为0600，首次握手校验随机令牌；令牌和进程标识只用于传输，不进入设置页面或模型。退出时只清理本插件拥有的 helper、请求、监听与计时器。

保留完整 bundle 和用途说明对于 Speech 授权归属很重要。直接运行裸二进制不是正式启动方式；缺少安全条件时，原生端会阻止语音授权请求。`--self-test` 可以直接运行，因为它不创建界面或请求权限。

`native/protocol-test.py --launch-services` 使用无采集的预览路径检查实际通信、状态同步和退出。它不是录屏、录音或真实鼠标控制测试。协议和原生行为的详细字段见 [native/README.txt](../native/README.txt)。

## 本轮验证记录与范围

本轮开发记录为 **134项自动测试通过**；后续修改应以最终测试输出为准，不把历史计数当成当前通过数。

| 验证层 | 已验证的范围 | 不能由此推导的结论 |
| --- | --- | --- |
| 自动测试 | 模型路由与流解析、图像能力及附件门禁、取消、记忆、用量、成长、设置 RPC、客户端协议和 SSR 等；使用合成输入与模拟模型 | 不证明任意供应商、任意权限环境或真实桌面的理解质量 |
| 原生与素材 | 编译、严格签名、自检；16×4图集单元解码、橙发身份、静态立绘；无采集的紧凑/展开实际界面预览、通信与启动/退出 | 不证明录屏、系统声音识别或辅助功能授权后的真实效果 |
| 真实 Host 用量小范围链路 | 一次真实 Host 验证记录8998个已上报 token，累计4份虚拟零食、进食1份；对应数值、库存与成长流程 | 不等于所有模型账单完整、全部历史用量正确，或宠物视觉/音频及对话质量已全面验收 |
| 尚未验收 | 真实用户屏幕内容、系统音频及其模型理解质量需要用户主动授权后分别测试 | 不能把编译、自检、预览或数字结算测试称为这些能力的实测 |

界面预览和协议测试中的状态可由合成数据驱动，应在截图或记录中说明。真实 Host 的8998 token 记录与合成用量测试是不同证据；均不应展示密钥、聊天正文或用户桌面内容来证明数字计数。

开发验证、隔离安装和安装到日常 Desktop profile 是独立步骤。本文不声明 `0.4.1-beta.1` 已安装到用户的日常环境。

## 变更时的检查重点

- 默认模型、附件或权限改变后，旧的画面/音频发送同意必须失效；等待中的确认不能在取消或切换模型后重新开启。
- 只读设置快照不写成长文件、不触发推理或授权；取消和退出不能再发后续模型请求。
- 用量只接收真实上报计数。奖励去重、缺失值、统计口径与宠物预算保持区分。
- 更换素材、隐藏状态栏或调整显示不迁移用户记忆、不删除成长库存。旧 `tail` 仅保留内部兼容，当前角色发出 `skirt` 互动。
- 图像经 Harness 附件服务可能持久落盘。不能把内存暂存帧的规则扩大成“所有图像零留存”。

源码与角色素材许可分开，发布前同步检查 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 及相应许可文件。新依赖、素材或调研链接不自动代表已集成或有统一再分发许可。

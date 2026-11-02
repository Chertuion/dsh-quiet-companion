# 实际复用与调研记录

这里区分已经进入运行路径的组件、只看过的项目，以及仍未实现的能力。外观、主动发言、记忆或成长功能相似，不代表移植了对方的完整实现。完整版本与许可记录见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 已实际使用

| 来源 | 当前使用方式 | 边界 |
| --- | --- | --- |
| [MCP Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)，`@modelcontextprotocol/server-memory@2.0.1` | 直接调用 `KnowledgeGraphManager` 持久化实体、观察与关系 | 不启动 MCP stdio 服务；用户证据、置顶、纠正、遗忘与限额由本项目包装层处理 |
| [Orama](https://github.com/oramasearch/orama)，`@orama/orama@3.1.18` | 本机全文检索；中文单字/双字词扩展，并结合近期与重要性排序 | 是词法/BM25检索，不是嵌入向量检索，也不是 Mem0 服务 |
| [ajuwm/dsh-roleplay-plugin](https://github.com/ajuwm/dsh-roleplay-plugin/tree/c2f4844e8e342c9a0079b7d4df419adb774bccef)，MIT | 从食品清单与恢复逻辑提取4种食品，包装为不可变的 `applyFood`；实际调用 `axisTier` 与 `repeatDimOf`，用于熟悉阶段及重复互动收益递减 | 仅为部分纯规则复用，没有接入完整角色扮演插件 |

roleplay 复用固定于提交 `c2f4844e8e342c9a0079b7d4df419adb774bccef`：

- 食品值来自 [`roleplay-host.mjs` 的食品清单](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/roleplay-host.mjs#L178-L185)。
- 饱腹与心情恢复来自同文件的 [`applyItemEffects`](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/roleplay-host.mjs#L1337-L1349)。
- 分级和重复递减来自 [`relation-core.mjs`](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/lib/relation-core.mjs)。

本地适配文件 `third_party/roleplay-game-core.mjs` 不是上游同名的小游戏模块。食品的价格和健康元数据没有成为本插件的购买或健康系统；本插件自行实现 token 收据、去重、库存/储备、XP阈值、温和状态变化、进食门禁、私有持久化及 macOS 展示。原始许可保存在 `third_party/ROLEPLAY-GROWTH-LICENSE.txt`。

## 只经过调研

| 项目 | 调研内容 | 当前没有接入的部分 |
| --- | --- | --- |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 语音伙伴、透明展示、视觉情境与主动互动的产品方式 | 未引入其依赖、源码、模型或完整服务；本版自己的 PCM-RMS 嘴部动画并非移植其口型、Live2D 或麦克风管线 |
| [CrossPet](https://github.com/lokicorvus/crosspet/tree/5c64326b6e7fc175eda0360c0bb5c4732541d138) | 桌面伙伴的界面、角色呈现和 README 组织 | 没有复制其角色图片、图集、生图提示词或代码，也不是本插件依赖 |
| [`xp-level-system`](https://www.npmjs.com/package/xp-level-system) 与 [`xp-parser`](https://www.npmjs.com/package/xp-parser) | XP框架及等级计算方案 | 未安装、导入或打包；当前XP规则为本项目实现，没有额外XP框架依赖 |

CrossPet 的代码许可与美术许可不同。其角色素材另有 [CC BY-NC-SA 4.0 条款](https://github.com/lokicorvus/crosspet/blob/5c64326b6e7fc175eda0360c0bb5c4732541d138/characters/LICENSE.md)，不能用代码的 MIT 许可替代角色素材条款。当前橙发角色通过图像工具基于用户提供的AI参考图生成，没有借此获得 CrossPet 或用户参考素材的新授权。

本版不再包含此前经 QCYTSN/dsh-dafeiyu、PC2005-cloud/dsh-pet 复用的鲸尾动作帧；旧参考生成的两张立绘也已替换。旧素材的许可说明不适用于新生成角色；当前素材的来源与许可状态以第三方说明为准。

## 相似能力与未实现能力

- **人设提示不等于角色卡系统**：当前人设写在模型提示中，没有角色卡导入/管理、多角色独立人格或角色编辑器。
- **聊天与事实不等于日记**：已有文字回合、用户事实、来源与检索；没有独立日记、纪念日、约定日程或完整关系管理界面。
- **虚拟成长不等于完整养成游戏**：已有零食、等级、熟悉阶段和温和虚拟状态；没有金币商城、充值、小游戏、死亡或缺席惩罚。
- **网格微动不等于 Live2D**：本次 Q 版使用24个语义动作、各8姿势，并用 SpriteKit 对单层画稿作小幅网格形变；没有可独立控制的分层模型、骨骼、表情 rig 或 Live2D SDK。
- **RMS 嘴部开合不等于音素口型**：本机 TTS PCM 的音量随实际播放时钟驱动小范围开合；不判断元音、辅音或词义，也不由此推断情绪。静态图有有效嘴框时同样可用。
- **系统声音转写不等于语音对话**：已有可选系统播放声的本机离线转写；没有持续麦克风输入、用户开口打断 AI 的语音管线。
- **关键帧不等于完整视频流**：模型最多获得选出的近期关键帧与可用转写，不能据此宣称理解整段视频或未提供的声音。

这些是当前边界，不作为承诺的开发排期。功能是否可用、是否实测及测试范围分别记录在[使用指南](guide.md)和[开发与验证](development.md)。

## 动作升级如何比较

| 版本 | 素材与播放指标 | 可以说明什么 |
| --- | --- | --- |
| 旧蓝发 `v0.3.0-beta.1` | 16个动作、3444个已有动作帧，名义帧间隔42ms，约23.8次姿势更新/秒 | 旧素材逐帧信息较多；不能把所有文件数当成独立语义动作数 |
| 旧橙发 `v0.4.0` / `v0.4.1` | 16个动作、各4姿势，共64帧，帧间隔250ms | 动作种类与画面变化都较有限；不应因角色更换而宣称动画更流畅 |
| 本次 `0.5.0-beta.1` Q 版候选 | 24个语义动作、各8姿势，共192帧；可变姿势时长，叠加目标30fps的网格微动 | 比旧橙发增加语义和姿势；192帧仍少于旧蓝发3444帧，网格采样也没有增加独立画稿 |

动作数量、画稿数量、播放时长、渲染更新和用户观感分别记录。本次不以“192帧”或“30fps”证明整体一定优于旧蓝发素材；循环接缝、锚点稳定、动作辨识、口型同步和资源占用需要实际预览。本次最终验收尚未完成，历史测试不作为新版效果证明。

## 如果未来采用 Live2D

当前包未采用 Live2D 素材、SDK、Core 或第三方 rig，也没有因“类似 Live2D 的效果”而取得其授权。未来若选这条路线，需要有权使用、可拆层并可绑定的角色源文件，制作模型与动作，再接入适用平台的 SDK；不能把几张 PNG 的网格变形称作已完成 Live2D 模型。

采用前还应分别核对角色与 rig 的授权、[Live2D SDK 使用及发布许可](https://www.live2d.com/en/sdk/license/)和应用所属类别，不能假定个人或开源项目在所有用途下都豁免。Cubism Core 与公开框架的提供方式也不同，见[官方 Core 说明](https://docs.live2d.com/en/cubism-sdk-manual/cubism-core/)。这只是未来方案边界，不是本版依赖或已承诺的开发计划。

## README 结构参考

本轮完整调研了DSH大肥鱼、Whale记账挂件、roleplay和非宠物插件Hub的README。固定版本、结构对比、首页采用顺序及来源链接见[README结构调研](readme-reference.md)。CrossPet与PC2005-cloud/dsh-pet为此前展示与文档调研的来源，不把它们称为本轮新增代码依赖。

首页现在逐项链接直接/间接npm、SDK内嵌运行时代码、SDK附带类型声明、提取适配规则，以及实际使用的Host/共享React/UI基础；完整原始许可继续放在third_party。产品调研、文档参考和历史素材另列，避免读者将功能设想当作当前集成。

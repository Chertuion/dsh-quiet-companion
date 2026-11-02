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
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 语音伙伴、透明展示、视觉情境与主动互动的产品方式 | 未引入其依赖、源码或完整服务；没有 Live2D、口型与连续麦克风语音管线 |
| [CrossPet](https://github.com/lokicorvus/crosspet/tree/5c64326b6e7fc175eda0360c0bb5c4732541d138) | 桌面伙伴的界面、角色呈现和 README 组织 | 没有复制其角色图片、图集、生图提示词或代码，也不是本插件依赖 |
| [`xp-level-system`](https://www.npmjs.com/package/xp-level-system) 与 [`xp-parser`](https://www.npmjs.com/package/xp-parser) | XP框架及等级计算方案 | 未安装、导入或打包；当前XP规则为本项目实现，没有额外XP框架依赖 |

CrossPet 的代码许可与美术许可不同。其角色素材另有 [CC BY-NC-SA 4.0 条款](https://github.com/lokicorvus/crosspet/blob/5c64326b6e7fc175eda0360c0bb5c4732541d138/characters/LICENSE.md)，不能用代码的 MIT 许可替代角色素材条款。当前橙发角色通过图像工具基于用户提供的AI参考图生成，没有借此获得 CrossPet 或用户参考素材的新授权。

本版不再包含此前经 QCYTSN/dsh-dafeiyu、PC2005-cloud/dsh-pet 复用的鲸尾动作帧；旧参考生成的两张立绘也已替换。旧素材的许可说明不适用于新生成角色；当前素材的来源与许可状态以第三方说明为准。

## 相似能力与未实现能力

- **人设提示不等于角色卡系统**：当前人设写在模型提示中，没有角色卡导入/管理、多角色独立人格或角色编辑器。
- **聊天与事实不等于日记**：已有文字回合、用户事实、来源与检索；没有独立日记、纪念日、约定日程或完整关系管理界面。
- **虚拟成长不等于完整养成游戏**：已有零食、等级、熟悉阶段和温和虚拟状态；没有金币商城、充值、小游戏、死亡或缺席惩罚。
- **图集不等于 Live2D**：当前为16种状态各4个关键帧，没有骨骼、连续口型或音频驱动表情。
- **系统声音转写不等于语音对话**：已有可选系统播放声的本机离线转写；没有持续麦克风输入、用户开口打断 AI 的语音管线。
- **关键帧不等于完整视频流**：模型最多获得选出的近期关键帧与可用转写，不能据此宣称理解整段视频或未提供的声音。

这些是当前边界，不作为承诺的开发排期。功能是否可用、是否实测及测试范围分别记录在[使用指南](guide.md)和[开发与验证](development.md)。

## README 结构参考

只借鉴信息组织，不复制正文、截图、角色素材或功能结论：

- [CrossPet README](https://github.com/lokicorvus/crosspet/blob/main/README.md)：封面与操作预览靠前，用用户能完成的动作组织说明，区分已测和待测范围。
- [QCYTSN/dsh-dafeiyu README](https://github.com/QCYTSN/dsh-dafeiyu/blob/main/README.md)：明确客户端与安装位置，将更新、排错和动画规则分开说明。
- [PC2005-cloud/dsh-pet README](https://github.com/PC2005-cloud/dsh-pet/blob/main/README.md)：简短安装入口，详细功能、配置与接口另用文档承载。

本仓库首页优先预览、安装和体验；长规则、权限说明、验证记录与调研边界分置这些文档，避免把研究过的功能混入已经完成的能力。

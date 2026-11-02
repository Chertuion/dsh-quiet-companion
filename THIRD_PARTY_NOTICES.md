# 第三方软件、素材来源与许可

本项目自有部分的 `UNLICENSED` 声明不替代第三方原许可。以下清单对应本次 `0.4.1-beta.1` 构建所核验的锁定及已安装版本：直接npm依赖2项、间接npm依赖3项，以及MCP SDK已内嵌的7个库。安装器可能按传递依赖的semver范围重新解析版本，本清单不保证未来所有安装都使用相同版本。核查记录见 [docs/license-audit.md](docs/license-audit.md)。

原始许可全文保存在 `third_party/`，不以本页中文说明代替、翻译或改写原文。

## 实际 npm 依赖

| 类型 | 组件与本次版本 | 许可与固定上游 | 原文入口 |
| --- | --- | --- | --- |
| 直接 | `@modelcontextprotocol/server-memory@2.0.1` | MCP转型全文（Apache-2.0及保留MIT等）；[固定源码](https://github.com/modelcontextprotocol/servers/tree/194cc86e3ae6400958555bd4116849d822d69263/src/memory) | [MCP-MEMORY-LICENSE.txt](third_party/MCP-MEMORY-LICENSE.txt) |
| 直接 | `@orama/orama@3.1.18` | Apache-2.0；2023 OramaSearch Inc；[固定源码](https://github.com/oramasearch/orama/tree/2fe41e163c2bdd7830eed7496c69134aea8ee3ba/packages/orama) | [ORAMA-LICENSE.md](third_party/ORAMA-LICENSE.md) |
| 间接 | `@modelcontextprotocol/server@2.4.0` | MCP转型全文（Apache-2.0及保留MIT等）；[固定源码](https://github.com/modelcontextprotocol/typescript-sdk/tree/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5) | [modelcontextprotocol-server-LICENSE](third_party/modelcontextprotocol-server-LICENSE) |
| 间接 | `@modelcontextprotocol/core@2.4.0` | 与server的实际许可逐字相同；[固定源码](https://github.com/modelcontextprotocol/typescript-sdk/tree/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5) | [modelcontextprotocol-server-LICENSE](third_party/modelcontextprotocol-server-LICENSE) |
| 间接 | `zod@4.6.7` | MIT；2025 Colin McDonnell；[固定源码](https://github.com/colinhacks/zod/tree/b500a2ee95134f81d74da7911d7378dd2853d042/packages/zod) | [zod-LICENSE](third_party/zod-LICENSE) |

Memory：调用 `KnowledgeGraphManager` 保存本机知识图谱，不启动MCP stdio服务。`2.0.1` npm包声明 `SEE LICENSE IN LICENSE`，但该发布包漏带LICENSE；本项目从[固定源码根LICENSE](https://github.com/modelcontextprotocol/servers/blob/194cc86e3ae6400958555bd4116849d822d69263/LICENSE)补入完整原文。其采用子目录没有另行许可。包装层另增用户原文证据核验、置顶、主题纠正、遗忘、检索排序及取消任务等行为。

MCP SDK：server/core的实际LICENSE与现有MCP许可文件逐字相同。全文含MIT向Apache-2.0过渡的说明：新代码及已取得同意的贡献按Apache-2.0提供，未取得重新许可同意的原MIT贡献仍按MIT提供；非规范文档另有CC-BY-4.0说明。全文含Apache正文及MIT版权 `2024-2025 Model Context Protocol a Series of LF Projects, LLC.`，不能只凭package metadata概括为全部纯Apache。

Orama：使用本机全文检索引擎；本地包装增加中文单字/双字词、近期与重要性排序，不是嵌入向量检索。保留采用包目录的原版权文件，完整Apache-2.0正文另随MCP许可文件提供，没有用monorepo其他目录许可替代。

本插件没有修改以上上游包。对本次采用路径和实际发布包未发现另行提供的NOTICE文件。Apache-2.0关于提供许可、保留声明、标注上游文件修改，以及存在上游NOTICE时传递其内容的原条件仍以全文为准。MIT原版权、许可和免责声明同样保留。

## MCP server 2.4.0 实际内嵌的库

下列代码由SDK自己编译进npm发布包，SDK的source-region/source map给出这些精确版本；它们不是本插件新增直接依赖，也不会在本项目lockfile中各自出现独立节点。完整原文集合：[SDK-BUNDLED-THIRD-PARTY-LICENSES.txt](third_party/SDK-BUNDLED-THIRD-PARTY-LICENSES.txt)。

| SDK内嵌组件 | 原许可与作者 | 固定上游 |
| --- | --- | --- |
| `ajv-formats@3.0.1` | MIT；Copyright (c) 2020 Evgeny Poberezkin | [固定源码](https://github.com/ajv-validator/ajv-formats/tree/1fb3fa7d967f919ff924bb34aef73a2f39ab0de3) |
| `ajv@8.18.0` | MIT；Copyright (c) 2015-2021 Evgeny Poberezkin | [固定源码](https://github.com/ajv-validator/ajv/tree/142ce84b807c4fe66e619c22480a28d0e4bd50fa) |
| `@cfworker/json-schema@4.1.1` | MIT；Copyright (c) 2020 Jeremy Danyow | [固定源码](https://github.com/cfworker/cfworker/tree/5409fdc2bd144f68e8b28c61c71fcb16600000a6) |
| `content-type@1.0.5` | MIT；Copyright (c) 2015 Douglas Christopher Wilson | [固定源码](https://github.com/jshttp/content-type/tree/6115a4064e4dfd9845241c3f89c233ee2423deeb) |
| `fast-deep-equal@3.1.3` | MIT；Copyright (c) 2017 Evgeny Poberezkin | [固定源码](https://github.com/epoberezkin/fast-deep-equal/tree/d807ffc5013e710deb1c63d463a03f729bcd144d) |
| `fast-uri@3.1.8` | BSD-3-Clause；Copyright (c) 2011-2021 Gary Court；Copyright (c) 2021-present The Fastify team（完整原行及URI.js溯源链接见原文） | [固定源码](https://github.com/fastify/fast-uri/tree/ead3ab7bb134c989e972c8174632d0670023f269) |
| `json-schema-traverse@1.0.0` | MIT；Copyright (c) 2017 Evgeny Poberezkin | [固定源码](https://github.com/epoberezkin/json-schema-traverse/tree/6b45983cd76270042cc79527da5c8972f13599ec) |

六个MIT库各自的版权、许可和免责声明均保留；fast-uri的BSD-3-Clause原文另保留条件、免责声明及不得借作者/贡献者名字背书的条款。`@cfworker/json-schema@4.1.1` 的npm包也漏带LICENSE，本集合从其精确registry gitHead对应的 [LICENSE.md](https://github.com/cfworker/cfworker/blob/5409fdc2bd144f68e8b28c61c71fcb16600000a6/LICENSE.md)补入原文，其他六项采用各自精确npm发布包中的许可。

## 部分复用的 roleplay 养成规则

来源：[ajuwm/dsh-roleplay-plugin](https://github.com/ajuwm/dsh-roleplay-plugin/tree/c2f4844e8e342c9a0079b7d4df419adb774bccef)，固定提交 `c2f4844e8e342c9a0079b7d4df419adb774bccef`；MIT；Copyright (c) 2026 roleplay-plugin contributors。完整原文：[ROLEPLAY-GROWTH-LICENSE.txt](third_party/ROLEPLAY-GROWTH-LICENSE.txt)。

- [食品项](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/roleplay-host.mjs#L181-L184)和[恢复规则](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/roleplay-host.mjs#L1337-L1349)提取为四种食品与本地无副作用的 `applyFood` 包装；[relation-core.mjs](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/lib/relation-core.mjs)的 `axisTier`、`repeatDimOf` 保持原文，用于熟悉阶段与重复互动递减。
- 本地 [roleplay-game-core.mjs](third_party/roleplay-game-core.mjs)文件头标明来源和适配范围；它不是上游同名小游戏模块。价格/健康字段未扩展为本插件的购买或健康系统。token收据去重、库存/储备、XP阈值、状态变化、进食门禁、持久化及macOS展示由本项目另行实现。
- 未接入上游完整预设、角色卡、多角色关系、日记、纪念日、小游戏、金币购买、死亡/久别惩罚、全局Host hooks、PowerShell或Windows可执行文件。

## 当前生成角色与历史素材

橙发花饰、白橙长裙、抱书角色的普通/害羞立绘与四套4×4图集由图像工具基于用户提供的AI参考图生成，共16种状态、每种4个关键帧。静态和动态使用同一角色，程序提供播放与过渡；这不是Live2D、口型管线或连续视频动画。源码素材说明见 [ASSET_SOURCE.md](assets/orange-character/ASSET_SOURCE.md)。

图像生成或处理不改变参考图中可能存在的权利；本项目不对参考原图授予新权、不将生成素材声明为MIT，也不额外授予其再分发许可。参考图按用户说明为AI生成，本次未进一步追溯原图来源。软件依赖许可不适用于这些图像。

当前包已替换此前鲸尾立绘及QCYTSN/dsh-dafeiyu、PC2005-cloud/dsh-pet动画集，不包含archived/restricted BigFish、其光标或声音。历史 `v0.2.0-beta.1`、`v0.2.0-beta.2`、`v0.3.0-beta.1` 含旧动画并保留相应原MIT；`v0.1.0-preview.1` 只有旧参考生成立绘。历史文件适用各自当时保留的条件，不能将旧动画MIT转授当前橙发参考或生成图。`v0.4.0-beta.1` 起为新角色。

## 仅调研，未作为依赖或复制实现

Open-LLM-VTuber、`xp-level-system`、`xp-parser`没有安装、导入或随包提供其代码/素材；功能相似不表示已接入。CrossPet仅核验过固定提交 [5c64326b6e7fc175eda0360c0bb5c4732541d138](https://github.com/lokicorvus/crosspet/tree/5c64326b6e7fc175eda0360c0bb5c4732541d138)，没有复制图片、角色配置、提示词或代码。其代码MIT明确排除素材，[角色素材为CC BY-NC-SA 4.0](https://github.com/lokicorvus/crosspet/blob/5c64326b6e7fc175eda0360c0bb5c4732541d138/characters/LICENSE.md)，不能将该许可当成本项目新生成图的授权来源。

以上是本次实际版本及已核验来源的归属记录，不构成对全部法律权利或未来版本的合规保证。

# 许可核查记录

本记录对应 `0.4.1-beta.1` 本次构建采用的依赖和素材，核查实际package-lock、已安装包、官方npm发布包与固定上游源码，没有仅凭README或license metadata下结论。它是来源与文本保留检查，不是法律全合规保证。完整归属及原文入口见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 本次固定版本

| 类型 | 组件与本次版本 | 固定上游 |
| --- | --- | --- |
| 直接 | `@modelcontextprotocol/server-memory@2.0.1` | [采用源码](https://github.com/modelcontextprotocol/servers/tree/194cc86e3ae6400958555bd4116849d822d69263/src/memory) |
| 直接 | `@orama/orama@3.1.18` | [采用源码](https://github.com/oramasearch/orama/tree/2fe41e163c2bdd7830eed7496c69134aea8ee3ba/packages/orama) |
| 间接 | `@modelcontextprotocol/server@2.4.0` | [采用源码](https://github.com/modelcontextprotocol/typescript-sdk/tree/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5) |
| 间接 | `@modelcontextprotocol/core@2.4.0` | [采用源码](https://github.com/modelcontextprotocol/typescript-sdk/tree/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5) |
| 间接 | `zod@4.6.7` | [采用源码](https://github.com/colinhacks/zod/tree/b500a2ee95134f81d74da7911d7378dd2853d042/packages/zod) |
| SDK内嵌 | `ajv-formats@3.0.1` | [采用源码](https://github.com/ajv-validator/ajv-formats/tree/1fb3fa7d967f919ff924bb34aef73a2f39ab0de3) |
| SDK内嵌 | `ajv@8.18.0` | [采用源码](https://github.com/ajv-validator/ajv/tree/142ce84b807c4fe66e619c22480a28d0e4bd50fa) |
| SDK内嵌 | `@cfworker/json-schema@4.1.1` | [采用源码](https://github.com/cfworker/cfworker/tree/5409fdc2bd144f68e8b28c61c71fcb16600000a6) |
| SDK内嵌 | `content-type@1.0.5` | [采用源码](https://github.com/jshttp/content-type/tree/6115a4064e4dfd9845241c3f89c233ee2423deeb) |
| SDK内嵌 | `fast-deep-equal@3.1.3` | [采用源码](https://github.com/epoberezkin/fast-deep-equal/tree/d807ffc5013e710deb1c63d463a03f729bcd144d) |
| SDK内嵌 | `fast-uri@3.1.8` | [采用源码](https://github.com/fastify/fast-uri/tree/ead3ab7bb134c989e972c8174632d0670023f269) |
| SDK内嵌 | `json-schema-traverse@1.0.0` | [采用源码](https://github.com/epoberezkin/json-schema-traverse/tree/6b45983cd76270042cc79527da5c8972f13599ec) |

五个npm锁定节点与已安装版本完全一致，官方tarball的SHA-512与registry及lock一致。SDK内嵌七项版本由发布包的 `.pnpm` source-region/source map标识，各自原始包也按registry integrity核验，没有作为新直接依赖安装。锁图未发现额外dev、optional、平台专用或嵌套重复节点；有限静态扫描不构成对所有可能衍生来源的绝对排除证明。

## 保留项与本次补齐

| 项目 | 需保留项及本次处理 |
| --- | --- |
| MCP Memory / SDK server / core | 实际全文含Apache转型说明、Apache正文、保留MIT贡献及版权、文档CC-BY说明，不能笼统称纯Apache。现有两份MCP原文与固定上游逐字一致；memory的npm包自己漏带LICENSE，已由固定源补入。本次补列core归属并映射现有同字节全文。 |
| Orama | 保留采用包目录的2023 OramaSearch Inc版权原文；完整Apache正文随MCP许可文件提供。没有改动上游源码，未发现采用路径另行提供NOTICE。 |
| Zod | 保留2025 Colin McDonnell的MIT版权、完整许可和免责声明，原文与实际包及registry gitHead源码一致。 |
| roleplay | [固定提交c2f4844e8e342c9a0079b7d4df419adb774bccef](https://github.com/ajuwm/dsh-roleplay-plugin/tree/c2f4844e8e342c9a0079b7d4df419adb774bccef)的2026 roleplay-plugin contributors MIT原文完整保留。四种食品/恢复规则提取适配，axisTier/repeatDimOf逐字保留，文件头说明来源与改动；没有复用完整角色扮演或小游戏模块。 |
| SDK内嵌七库 | 本次新增[完整原文集合](../third_party/SDK-BUNDLED-THIRD-PARTY-LICENSES.txt)，保留六个MIT库的各自版权、许可、免责声明，以及fast-uri的BSD-3-Clause原文、条件、免责声明和非背书条款。cfworker的npm包漏带LICENSE，已从其精确gitHead根LICENSE.md补入。没有以MCP版权代替其他作者。 |

新增集合为10452字节，SHA-256：`1ca80df5474c845d01d6b9eaedc7abffb00ddd260f574f69b0acc4477fd5b883`，与核查取得的原集合逐字相同。已有原始许可未翻译、改写或删除。

Apache条件包括保留许可与相关声明；后续若修改上游文件需标注，若上游提供NOTICE则按原条件保留适用内容。本次采用路径未发现独立上游NOTICE，不虚构缺漏。MIT与BSD的作者/条件/免责声明仍以原文为准。

## 素材与历史边界

当前普通/害羞立绘、四张图集及manifest与原生包内7个文件逐字匹配；构建使用 `assets/orange-character/` 白名单，没有旧鲸尾动画目录。新图基于用户提供的AI参考图由图像工具生成；生成与处理不改变可能存在的参考图权利，未将新图声明MIT，也未额外授予参考原图或生成图再分发权。参考图按用户说明为AI生成，本次未进一步追溯；本记录不为图片另行授予商用或再分发权。

历史 `v0.2.0-beta.1`、`v0.2.0-beta.2`、`v0.3.0-beta.1` 的旧动画保留 [PC2005-cloud固定MIT](https://github.com/PC2005-cloud/dsh-pet/blob/549fff2ea33c2acfb16612c76912c6137da4a758/dsh-pet/LICENSE)，并按 [QCYTSN固定素材说明](https://github.com/QCYTSN/dsh-dafeiyu/blob/084323845ab82b68d5388d5c638bec09d8544a8a/ASSET_LICENSE.md)区分MIT鲸尾帧与受限legacy素材。`v0.1.0-preview.1`只有旧参考生成立绘；`v0.4.0-beta.1`起已换新图。历史tag应保留原许可，不把旧动画MIT套用当前参考或新图。

CrossPet、Open-LLM-VTuber、xp-level-system、xp-parser仅调研，未作为依赖或复制代码/素材。CrossPet的代码MIT排除角色素材，后者另为[CC BY-NC-SA 4.0](https://github.com/lokicorvus/crosspet/blob/5c64326b6e7fc175eda0360c0bb5c4732541d138/characters/LICENSE.md)，没有成为本项目新图的授权来源。

## 版本和发布边界

本记录针对本次实际版本，不保证未来semver解析结果不变。根npm包不携带node_modules，传递依赖由安装器另行取得；开发目录package-lock不能单独证明所有未来用户都安装同一图。发布时应检查最终安装版本，以及最终tgz中的完整许可和声明；更新依赖或素材后重新核对。本记录不取代各原许可，也不构成法律合规保证。

# README 结构调研与采用说明

调研开始于2026-11-02，文档整理于2026-11-03。先读取下列DSH插件的完整README及来源/许可说明，再按固定提交复核；目录站导读只作入口，项目描述以GitHub主源为准。这里借鉴的是信息组织，未复制上游正文、截图或角色素材，也未安装这些项目来验证其功能。

## 四个样本

| 样本 | 固定README | 值得借鉴的组织方式 | 本项目的采用 |
| --- | --- | --- | --- |
| 角色扮演插件 | [ajuwm/dsh-roleplay-plugin · c2f4844](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/README.md) | 先界定核心体验，再讲特性、安装、专题文档与素材 | 先解释模型驱动的陪伴，再写感知、记忆、任务和成长；复杂实现交给详细文档 |
| 原生Agent桌宠 | [QCYTSN/dsh-dafeiyu · 0843238](https://github.com/QCYTSN/dsh-dafeiyu/blob/084323845ab82b68d5388d5c638bec09d8544a8a/README.md) | 预览与版本靠前，区分客户端/profile，安装、设置、平台、排错和素材逐项说明 | 桌面端安装优先，明确desktop配置、自带CLI、Release安装包、常用操作和验证平台 |
| 页面余额挂件 | [MeteorNOX/DeepSeek-Balance-Whale-Widget · 5247dd6](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/5247dd6813d6e4430728f39ccc63d43cda046022/README.md) | 功能按领域分组，解释数据来源、统计口径、凭据和失败状态 | 将成长token、插件预算和账户余额拆开，写清默认值、数据去向与未知情况 |
| 非宠物插件市场 | [dshplugin/dsh-plugin-hub · e391605](https://github.com/dshplugin/dsh-plugin-hub/blob/e3916054f490f59cc89ca593944b1f185131b20c/README.md) | 按用户任务配图，集中提供安装/更新/反馈入口，标明独立社区身份 | 首页放角色预览与操作入口，设置按任务组织，明确与DeepSeek官方无隶属关系 |

补读的归属材料包括：[roleplay LICENSE](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/LICENSE)、[大肥鱼素材说明](https://github.com/QCYTSN/dsh-dafeiyu/blob/084323845ab82b68d5388d5c638bec09d8544a8a/ASSET_LICENSE.md)、[Whale PROVENANCE](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/5247dd6813d6e4430728f39ccc63d43cda046022/PROVENANCE.md)和 [Hub LICENSE](https://github.com/dshplugin/dsh-plugin-hub/blob/e3916054f490f59cc89ca593944b1f185131b20c/LICENSE)。

## 最终首页顺序

1. 名称、体验定位、预览和版本状态。
2. 可以完成的事情，注明候选新增能力。
3. 支持环境与官方桌面版安装。
4. 第一次使用、桌面操作与五个设置分区。
5. 零食成长、用量口径与记忆管理。
6. 权限、发送对象、存储和清理边界。
7. 更新、恢复与按现象排查的问题。
8. 实际第三方依赖、提取适配、Host共享基础、调研和历史来源。
9. 开发、验证范围、许可与反馈。

这样读者可以先完成安装和日常操作，再深入了解数据或开发细节。复杂参数与测试证据继续放在[使用指南](guide.md)、[开发记录](development.md)、[第三方声明](../THIRD_PARTY_NOTICES.md)与[许可核查](license-audit.md)。

## 没有照搬的内容

- 上游的跨平台支持、素材帧数、余额接口与授权范围，不能套用于本插件。
- 宣传数字、收费价格、全部已审核等结论没有用作本项目事实。
- 没有用测试badge、设计立绘或旧版截图暗示0.5已完成实机验收。当前Q图明确标为美术预览，旧布局图说明版本和合成数据。
- 仅作产品或文档调研的项目，与实际运行依赖分别列出。roleplay既是文档样本，也有少量规则被实际提取，两种关系均注明具体范围。
- 本插件自己的开关、来源、统计和默认值按当前源码核对；已发布版本、候选源码与安装结果分别记录。

## 与素材和代码复用的关系

参考README结构不表示复制项目实现。具体采用的代码、版本、完整许可与本地适配文件见[第三方声明](../THIRD_PARTY_NOTICES.md)。此前关注的Open-LLM-VTuber、CrossPet、XP方案，以及旧蓝发动画历史见[功能与调研记录](research.md)。

当前Q角色的来源、生成提示、文件索引和嘴框校准见[素材说明](../assets/orange-character/ASSET_SOURCE.md)。文档参考项目的代码许可不自动成为本项目代码或角色图片的许可。

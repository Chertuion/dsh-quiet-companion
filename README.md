<div align="center">

# 安静陪伴 · Quiet Companion

**在你工作、浏览和看视频时，能聊两句，也懂得安静陪着你的桌面伙伴。**

[发行版本](https://github.com/Chertuion/dsh-quiet-companion/releases) · [使用指南](docs/guide.md) · [更新记录](CHANGELOG.md) · [问题反馈](https://github.com/Chertuion/dsh-quiet-companion/issues)

<img src="docs/assets/q-render-open.png" width="240" alt="橙发花饰Q版角色的原生渲染预览，怀抱书本，穿白橙色裙装">

*上图为原生渲染器输出，口型输入为合成音量；不含桌面采集、真实用量或音频播放。*

</div>

安静陪伴是运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中的 **macOS 桌面陪伴插件**。她沿用 Harness 当前默认模型，结合经你开启的应用、画面和视频对白上下文，选择合适的时候关心或调侃；文字交流、可管理的记忆、真实 Agent 状态和身边的虚拟零食，共同构成日常陪伴。

角色风格是安静、体贴，带一点黏人与俏皮。主动回应由事件与上下文决定，模型可以选择保持安静。角色随 Harness 启停，使用官方桌面版时不需要一直开着终端。

> **本轮测试版：[`v0.5.1-beta.9`](https://github.com/Chertuion/dsh-quiet-companion/releases/tag/v0.5.1-beta.9)**。设置页切回前台立即刷新诊断；鼠标测试将“请求已发送”和“原生最近报告”分开显示，避免旧状态被误认作本次执行结果。继续沿用默认模型、Max适配及同字节build9原生组件，范围见[本轮记录](docs/development.md#beta9-validation)。

227项代码回归已通过。固定系统声音链路、重启配置保留和错误反馈已有实机证据；受控目标码与真实鼠标位移/接管仍待验收。新包先公开到GitHub，安装与测试结果另行补记，不把代码回归当作实机通过。

beta6已按“先公开GitHub、再安装”完成89文件、签名与状态保留核对。实际聊天错误终态和顶部重启保留配置已通过；受控画面目标码和真实指针动作仍待解锁后的实际操作，不记为已通过。

## 目录

- [她能做什么](#她能做什么)
- [Q版动作与语音口型〔0.5新增〕](#q-animation)
- [支持环境](#支持环境)
- [安装到官方桌面版](#安装到官方桌面版)
- [第一次使用](#第一次使用)
- [日常操作与设置](#日常操作与设置)
- [零食成长与用量口径](#零食成长与用量口径)
- [记忆如何工作](#记忆如何工作)
- [权限与数据去向](#权限与数据去向)
- [更新卸载与恢复](#更新卸载与恢复)
- [常见问题](#常见问题)
- [第三方项目与来源](#第三方项目与来源)
- [开发与验证](#开发与验证)
- [许可与反馈](#许可与反馈)

## 她能做什么

### 沿用默认模型交流

双击角色可以文字聊天，摸头、轻戳、碰裙摆等互动也可以触发模型回应。模型沿用 Harness 的当前默认配置，不需要在插件里重复填写 API Key；更换默认模型后，插件跟随实际的供应商与模型标识。

0.5.1将头部、身体衣物和裙摆作为不同互动传给模型，回应可结合对应部位生成；每次调用还提供实际系统日期、时间与时区，避免把旧截图或记忆里的日期当成现在。

beta3为这三类触碰单独约定自然文本回应，模型从请求开始就被要求生成不超过90个字符的短句，不再先要求JSON后猜测转换。自动观察和手动文字聊天仍按严格JSON协议处理；触碰的空白、超长、控制字符、JSON样式或代码围栏回应仍拒绝，不会从文字推测心情或进食指令，也不自动重试失败调用。

陪伴对白由模型生成。启动说明、权限状态、升级提示等界面信息由本机程序提供。聊天、主动评论和记忆整理会产生正常模型调用费用，使用前可在设置里查看或调整插件自己的日预算。

自动画面、应用和部位短回应的生成上限为2048 token，手动文字聊天为4096；服务端公开配置更低时取较低值。默认模型与Harness选定的推理强度保持原样；达到上限会显示中文原因，不使用截断的半段回复，也不自动重试。

### 根据情境主动说话，也能保持安静

开启观察后，应用切换、明显画面变化、新的视频对白、用户互动和任务事件会成为判断线索。系统结合事件新鲜度、最近是否与她交流、此前发言是否被忽略、会议应用、离开状态和预算，决定是否请求模型回应。

感知采样有检查间隔，主动发言没有“每隔几分钟必须说一句”的循环。模型还可以判断没有值得说的内容。你可以增加安静应用、暂停观察，或临时安静30分钟；手动聊天仍可独立使用，但同样受模型可用性和插件预算限制。

### 看当前画面，结合视频对白理解上下文

画面理解需要你单独开启、同意向当前默认模型发送图片，并授予 macOS 屏幕录制权限。默认模型还须明确支持图片输入，且 Host 附件服务可用。

当前实现优先采样前台应用窗口，必要时退回排除宠物的显示器画面。本机先判断变化，有事件需要理解时才选择最近最多 **3个关键帧**交给模型；默认采样间隔3秒，可设为1–30秒。实际速度还受系统调度、画面捕获和模型响应影响。

“听视频对白”是另一个独立功能：通过 macOS 捕获系统播放声，在本机离线转写，再将可用的短转写交给默认模型。支持选择普通话与美国英语，取决于本机识别资源是否可用。当前没有持续麦克风对话、用户开口打断 AI，或对整段视频逐帧、无延迟的理解能力。

### 在桌面查看真实 Agent 状态

角色顶部与“进度与用量”页显示当前 Host 实际提供的思考、工具执行、等待回答、等待审批、完成和错误状态，并在有数据时展示任务名称、工具、轮次和已观察到的步骤。

进度来自 Harness 会话事件。上游没有提供总步骤或完成率时，界面显示阶段和已知信息，不生成一个看似精确的百分比。当前 Host 的子 Agent 事件可以参与统计；其他应用或其他 Harness 进程不在本插件的监听范围内。

### 身边的零食与温和成长

启用后新上报的真实 token 可以积累为虚拟零食。零食出现在角色左右和脚边，她会根据饱腹、精力、休息和任务状态选择什么时候吃；你也可以点击零食递给她。

成长包括等级、经验、熟悉阶段、饱腹、精力和心情。右侧成长栏默认隐藏，完整信息在设置中查看。日常互动也能获得经验，无需为了成长增加模型消费；当前没有购买、充值、死亡或久别扣除关系等级的机制。详细规则见[零食成长与用量口径](#零食成长与用量口径)。

<a id="q-animation"></a>

### Q 版动作与语音口型〔0.5新增〕

橙发花饰、抱书的 Q 版角色提供 **24类动作 × 每类8个关键姿势，共192帧画稿**：

| 类别 | 动作 |
| --- | --- |
| 日常 | 待机、等待、伸懒腰、哈欠、左右看、招手、睡眠 |
| 任务与交流 | 思考、书写、检索翻书、命令操作、成功、错误、回复、等待审批 |
| 互动 | 拖动、落地、摸头、轻戳、轻扶裙摆、进食 |
| 情绪 | 害羞、关心、俏皮 |

关键姿势采用可变时长播放，并叠加 SpriteKit 的轻微呼吸、头部与发缘网格形变，渲染目标为30fps。192帧是画稿数量，30fps是渲染目标；目前没有分层骨骼、Live2D 模型或 Live2D SDK，不同负载下的帧率和连续动作观感仍以本机实际表现为准。

开启本机朗读后，嘴部跟随 **实际播放的 TTS 音量**开合：由 PCM 的短窗 RMS 和播放器时钟驱动，不依赖文字长度，不使用麦克风，也不判断音素。静态立绘同样支持口型；“减少动态”会同时停止网格微动和嘴部动画。朗读默认关闭，口型开关默认开启，开启口型不会自动播放声音。

[0.4.1布局示意](docs/assets/companion-compact.png)保留用于查看“角色周围零食＋收起成长栏”的布局，图中为旧版角色与合成库存，不能用作新版 Q 版或真实用量的验收证据。动作比较与 Live2D 后续所需条件见[调研记录](docs/research.md)。

## 支持环境

| 项目 | 当前范围 |
| --- | --- |
| 系统与芯片 | Apple Silicon Mac，macOS 14及以上；当前原生组件为 arm64 |
| Harness | 官方桌面版 `0.2.1-rc.5`，插件声明的 Host 版本也为该版本 |
| 安装位置 | 官方桌面版的 `desktop` profile |
| 模型 | Harness 当前默认模型；图片功能另需明确的图片输入能力 |
| 安装工具 | 桌面应用内安装即可，不要求额外安装 Node.js、pnpm、Xcode 或 Swift |
| 尚未验证 | Intel Mac、Windows、Linux、其他 Harness 版本和浏览器 WebUI 配置 |

桌面端与 WebUI 使用不同 profile。在 WebUI 中安装，不会自动装到官方桌面版。客户端清单中的 `platform: web` 表示使用 Host 的共享网页界面模块，本插件的原生角色仍依赖上述 macOS 环境。

本项目是独立社区插件，与 DeepSeek 官方无隶属关系。原生组件使用本地 ad-hoc 签名，尚未做 Developer ID 公证。

## 安装到官方桌面版

### 应用内安装〔推荐〕

1. 打开官方 DeepSeek Harness 桌面应用，点击 **插件 → 添加插件**。
2. 填入本版固定地址：

   ```text
   github:Chertuion/dsh-quiet-companion#v0.5.1-beta.9
   ```

3. 安装后启用插件，按应用提示重新打开 Harness。
4. 打开 **设置 → 安静陪伴**，确认原生组件已连接。

beta7增加Max档生成预算适配和只读画面接收诊断；beta6重启配置保留、自动观察自然回应、错误终态及显式鼠标测试入口继续保留。固定标签与同版Release包对应，历史版本见发行列表。

### 使用 Release 安装包

在对应 [Release](https://github.com/Chertuion/dsh-quiet-companion/releases/tag/v0.5.1-beta.9) 的 **Assets** 中下载 [`dsh-quiet-companion-0.5.1-beta.9.tgz`](https://github.com/Chertuion/dsh-quiet-companion/releases/download/v0.5.1-beta.9/dsh-quiet-companion-0.5.1-beta.9.tgz)，无需解压，把下载文件的完整本机路径填入“添加插件”。GitHub 自动生成的 Source code ZIP/TAR 是源码快照，不是此预编译安装包。GitHub源码拉取停滞时可选择同版已下载的Release安装包；历史版本见 [beta4 Release](https://github.com/Chertuion/dsh-quiet-companion/releases/tag/v0.5.1-beta.4)、[beta3 Release](https://github.com/Chertuion/dsh-quiet-companion/releases/tag/v0.5.1-beta.3)、[beta2 Release](https://github.com/Chertuion/dsh-quiet-companion/releases/tag/v0.5.1-beta.2) 和 [beta1 Release](https://github.com/Chertuion/dsh-quiet-companion/releases/tag/v0.5.1-beta.1)。

### 使用桌面应用自带的 CLI

先启动过一次桌面应用，让它初始化配置；执行命令前完全退出 Harness。下面是默认 macOS 安装路径的例子：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add github:Chertuion/dsh-quiet-companion#v0.5.1-beta.9
```

随后重新打开应用。这里使用的是**桌面应用自带的 CLI**，不要用独立 npm 安装的 `dsh` 去修改桌面端 profile。自定义安装位置请调整路径；参考 [Harness 官方桌面端说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/apps/desktop/README.zh.md)。

## 第一次使用

1. **先试文字交流**：双击角色，确认 Harness 默认模型能正常回应。没有配置模型时，本地角色仍可显示，模型交流需要可用的默认模型。
2. **再开需要的感知**：“感知与陪伴”中开启观察；画面与系统声音各自单独开启，并按需完成确认和系统授权。
3. **调整桌面表现**：“外观与语音”中改变大小、透明度和动态。需要说话声音时再开启朗读，口型有独立开关。
4. **查看成长与记忆**：“成长与零食”里查看库存；“记忆”里查看事实、来源和置顶内容。
5. **选择打扰程度**：增加会议或安静应用；临时不希望采集时使用“暂停观察”或“安静30分钟”。

插件沿用现有 Harness 模型配置，不单独收取模型密钥。画面、系统声音、应用感知、朗读和鼠标互动默认关闭；记忆、成长、零食奖励、自动进食、Agent 提示和动态角色默认开启。

## 日常操作与设置

### 桌面操作

| 操作 | 效果 |
| --- | --- |
| 单击头部、身体或裙摆 | 播放本地互动动作，并可触发模型交流 |
| 双击角色 | 打开文字聊天 |
| 拖动并松开 | 移动、贴边与位置记忆；0.5包含悬空和落地动作，拖动时停止朗读 |
| 点击身边零食 | 未激活窗口时也接收首次点击；递出指定零食，不能吃时即时说明原因，仍遵守本机门禁 |
| 右键角色或菜单栏入口 | 找回角色、聊天、设置、暂停、静音、休息、叫醒或退出 |
| 隐藏成长栏 | 收起右侧数值与库存标签，零食、成长计算和顶部 Agent 状态继续保留 |

beta2为头部、身体衣物与裙摆提供带语义名称的macOS无障碍按钮；零食另有“递给她：食品名”按钮。Press操作走原有部位互动或递食处理，隐藏、不可用或不能递食时拒绝触发，进食规则保持不变。此入口不授予“鼠标撒娇”的辅助功能权限，也不等于已完成真实无障碍工具验收。

### 五个设置分区

| 分区 | 可以调整或查看 |
| --- | --- |
| 感知与陪伴 | 默认模型信息、观察、画面、系统声音、识别语言、采样间隔、安静应用、鼠标撒娇 |
| 外观与语音 | 显示/隐藏、大小、透明度、动态、减少动态、朗读声音与语速；0.5新增语音口型 |
| 成长与零食 | 成长/奖励/自动进食开关、每份零食所需 token、库存、状态、递食与桌面成长栏 |
| 记忆 | 自动记忆开关、置顶编辑、事实与原文来源、单条遗忘和清空 |
| 进度与用量 | 当前 Agent、插件自己的今日用量与预算、费用估算，以及可用的账户余额 |

0.5.1对16个功能开关做了分层回归，覆盖值的开启/关闭、Host回显与授权请求分流。授权中会显示等待状态，错误提示不会再被后台刷新立即清掉；从安静时段恢复观察会清除该次临时暂停。这些检查不等于已实际授予并开启全部系统权限。

### 隐藏、休息和暂停有何区别

| 操作 | 改变什么 |
| --- | --- |
| 隐藏角色 | 隐藏窗口，观察与后台模型判断另行管理；0.5同时停止动画和朗读 |
| 让她休息 | 影响进食/精力，不关闭观察；0.5维持休息标记，朗读时可临时切回复姿势，结束后恢复睡姿，明确叫醒解除 |
| 暂停观察 | 停止新感知、取消插件请求，清理短期画面、转写与应用状态；已有对话历史、记忆和成长保留 |
| 安静30分钟 | 保持观察开关不变，暂缓30分钟；到期后仅仍开启且授权有效的感知继续，已暂停或重启后关闭的感知不会自动开启 |
| 关闭记忆或成长 | 分别暂停相关自动功能，保留旧记录，仍可查看和手动管理 |

完整参数与操作见[使用指南](docs/guide.md)。

## 零食成长与用量口径

### 零食如何产生

默认每 **2000个已上报 token** 奖励一份，可设100–100000。来源是监听启用后**当前 Host** 的 Agent/子 Agent 结算与伙伴自身调用；按事件身份去重，不补算历史，不统计其他应用，缺少完整用量时不猜测发奖。

桌面最多展示8份稳定位置的零食；库存可保留64份具名实体，超出的数量计入储备。桌面看不见的库存仍可在“成长与零食”页查看，状态同步不会让已有零食每次重新排列。

### 她什么时候吃

- 自动进食开启、有库存，且不处于忙碌、等待回答/审批、权限弹窗、休息或低精力状态。
- 普通自动进食要求饱腹不高于60；已有模型交流提出“想吃”时可放宽至75，手动递食可至80。
- 新零食自动进食前至少展示4秒；手动递食可跳过这4秒，但两次进食都至少相隔90秒。
- 安静时段或近期“等一等”的模型意图会暂缓进食。已有交流可以携带吃/等待意图，本机门禁仍作最终判断。

吃一份增加20经验。日常互动也可成长，但有5分钟奖励间隔与重复递减。等级、熟悉阶段、饱腹、精力和心情是角色的游戏数值；跨启动状态最多补算6小时。成长计算、奖励结算与本地自动进食本身不新增模型请求。

### 三种数字分别代表什么

| 显示 | 统计范围与限制 |
| --- | --- |
| 成长累计 token / 零食 | 当前 Host 新上报的 Agent/子 Agent及伙伴调用，用来结算虚拟奖励 |
| 插件今日用量 / 日预算 | 伙伴生成与记忆整理调用；默认日 token 预算100000，费用上限默认不启用。结算后达到预算会阻止后续模型请求，也包括手动回复；最后一次结算可能越过阈值，不能限制整个 Host 的调用 |
| 账户余额 | 只在默认供应商为 `deepseek-account` 且现有账户服务可用时查询；不支持的模型服务显示不可用 |

费用按用户填写的输入/输出单价估算，缺失用量或未配置单价时保持未知，不能当作提供商的完整账单。零食是本地虚拟奖励，没有购买、支付或真实货币兑换。

## 记忆如何工作

记忆使用本机知识图谱和中文词法检索，保留最多 **999条事实与200个文字回合**。手动聊天后，默认模型可以整理偏好、约定和经历；自动事实必须有用户原文证据，助手猜测不会直接成为用户事实。整理可能产生额外模型调用，并纳入本插件预算。

| 想做什么 | 方法 |
| --- | --- |
| 长期保留偏好或约定 | 在“记忆”中手动置顶，或在聊天中明确表达需要记住的内容 |
| 核对一条记忆 | 查看类型、主题键、ID和可用的用户原句来源 |
| 更正 | 明确表达新偏好，或编辑置顶内容；旧主题可单独遗忘 |
| 忘记一条 | 点击“遗忘”，或输入 `/forget 条目ID或主题键或完整事实`、`/忘记 内容` |
| 清空 | 在记忆页清除本插件的事实、回合和当前对话上下文 |
| 暂停自动记忆 | 关闭记忆，停止自动新增和检索；旧内容保留，手动置顶仍可编辑保存 |

遗忘会删除关联的来源回合并取消旧整理任务。当前检索是中文词法检索，不使用额外的向量嵌入服务。

原始图片和音频不写入插件的记忆库。**记忆开启时，手动文字聊天会保存用户与助手的文字回合；如果回应谈到已授权画面或对白，相关派生文字也可能保留。** 当前尚未接入独立日记、纪念日、角色卡导入、多角色人格或无限长期记忆。

## 权限与数据去向

### 开关与授权

| 能力 | 默认 | 开启后使用什么 |
| --- | --- | --- |
| 应用感知 | 关闭 | 前台应用名称、标识与空闲状态；不记录键盘输入或浏览历史 |
| 画面理解 | 关闭 | 独立的模型发送同意＋屏幕录制授权；向当前支持图片的默认模型提交选定关键帧 |
| 系统声音理解 | 关闭 | 独立同意、播放声捕获与 Speech 授权；只使用本机可用的离线转写，不调用麦克风 |
| 本机朗读 | 关闭 | macOS 已安装的系统声音，不增加语音云 API |
| 口型〔0.5〕 | 开关开启 | 只处理插件自己朗读的音量；实际朗读发生时才可见，不新增采集权限 |
| 鼠标撒娇 | 关闭 | 独立同意和辅助功能授权；短暂轻拉指针，不点击或输入 |
| 记忆与成长 | 开启 | 本机文字记忆与虚拟状态；相关摘要可随已有调用进入默认模型上下文 |

**系统权限归属于独立原生组件“安静陪伴”**，通过 LaunchServices 启动；只给 Harness 或终端授权，不代表这个组件已获授权。首次打开系统开关后，当前进程可能仍需重启才读到生效状态。0.5.1会保留本次发送同意并显示等待或重启提示，每个宠物进程最多发起一次相应屏幕/辅助功能系统请求，不会反复弹窗。

此时先在系统设置核对“安静陪伴”，回插件点 **重新检查系统权限**；检查本身不采集、不自动开启。仍提示重启时，点 **重启宠物以应用权限**，再明确开启所需功能；也可用“取消画面/声音/鼠标开启”撤回等待请求。普通设置刷新、重启时模型尚未就绪的初始化，不会抹去此前匹配的同意；没有有效模型时不能新授予发送同意，明确关闭、暂停或实际变更模型仍会取消。完整流程见[授权等待与重启](docs/guide.md#授权后仍显示等待或需要重启)。

鼠标撒娇默认在20分钟未与她互动、且出现新的电脑活动时尝试，两次至少间隔30分钟；可将未互动门槛设为5–120分钟。每次最长1.5秒、轻拉不超过160像素，真实鼠标移动、滚动、按键或 Esc 会立即结束。按住鼠标、拖拽、会议、密码输入、系统确认或等待 Agent 确认等情形下不执行。

### 数据保存与清理

本插件主要状态位于 `$DSH_HOME/quiet-companion/`，未设置 `DSH_HOME` 时为 `~/.dsh/quiet-companion/`，包括设置、文字记忆、用量和成长。目录/文件使用私有权限，内容为本机明文。原生显示位置、大小与部分偏好另由 macOS UserDefaults 保存，系统授权由 macOS 管理。

**选中发送的关键帧会交给 Harness 附件服务，可能持久保存在共享的 `$DSH_HOME/attachments`。插件不承诺自动删除这一共享缓存。** 未选中的短期帧只在插件内存中保留；系统声音不保存原始录音，短转写短期保留后过期。

模型调用通过 Harness 的服务完成，插件不复制或保存模型密钥；选中的文字、相关记忆、图片和转写会发送给当前默认模型服务。变更实际供应商/模型标识后，画面与声音发送同意会撤销，需要重新开启。

暂停会停止新采集并清理短期画面/转写，不删除已有记忆或成长，也不能撤回已发送的内容。清除记忆、卸载插件、删除插件状态目录，均不等于清除 Host 附件缓存、原生偏好、系统授权或模型提供商的记录。更多说明见[数据与权限](docs/guide.md#权限与数据)。

## 更新卸载与恢复

应用内更新按 Harness 提示进行。旧版需要手动替换时，先停用并卸载插件包，再添加目标**已发布版本**；命令行操作前完全退出对应 Host，完成后重新打开。

插件包外的设置、记忆和成长记录不会因正常替换安装主动清除。请勿为更新删除整个 `.dsh`。原生组件退出或“重启宠物”后，应用、画面和声音感知会安全关闭，需要你重新开启；历史记忆与成长继续保留。

回退时使用旧 Release 的固定版本地址或对应 `.tgz`。跨版本数据兼容范围应先看[更新记录](CHANGELOG.md)，不要同时安装不同来源的同名插件。

## 常见问题

| 现象 | 先检查什么 |
| --- | --- |
| 安装后没有角色 | 核对 arm64/macOS/Host版本和 desktop profile；确认插件启用，尝试“显示宠物”或“重启宠物” |
| 设置中没有“安静陪伴” | 确认装在当前官方桌面端，重新打开 Harness，查看安装详情；WebUI配置不自动同步到桌面端 |
| 不主动说话 | 观察、安静时段、会议/安静应用、离开状态、默认模型与预算；没有新事件也可能保持安静 |
| 文字聊天也不回应 | 检查 Harness 默认模型、连接状态和插件日预算；预算会同时限制手动回复 |
| 已达到今天设置的用量预算 | 这是宠物日预算门禁，会停止新模型请求；不据此判断模型故障，也不会自动提高预算或清零用量 |
| 画面开关不可用 | 当前默认模型须声明图片能力，Host附件服务和系统授权也需可用；切换模型后重新同意 |
| 系统已允许，却仍提示授权 | 核对系统列表中的“安静陪伴”，点“重新检查系统权限”；按需重启宠物，再明确开启，勿连续重复申请 |
| 重启后开关已开、CG已授权，文字仍说“画面理解未开启” | beta5仅在Host和原生开关、真实授权、连接均确认且无待授权时，替换精确的旧初始化句；真实错误与未确认状态仍保留 |
| 视频有声音却听不懂 | 检查独立系统声音开关、识别语言和本机离线资源；失败时显示状态，不自动改用联网识别或麦克风 |
| 系统声音显示“已配置；观察已暂停” | 仅表示开关已配置，当前没有捕获；恢复观察后仍须经过等待启动、正在启动与实际运行状态 |
| 聊天问画面却没有附图 | 已有帧须在45秒内且原路由、同意与画面能力仍有效；beta4避免普通设置刷新误清帧，不保证聊天窗口在前台时会新捕一帧 |
| 零食没有出现 | 只计算监听启用后实际已上报的当前Host用量，检查成长/奖励开关和阈值；不会补造历史用量 |
| 有零食但不吃 | 查看休息、饱腹、精力、任务等待、安静时段和90秒冷却；递食请求也受门禁限制 |
| 模型回复格式无效 | beta3触碰使用独立自然文本协议；自动观察和手动聊天仍要求单个合法JSON对象，兼容代码块/说明包装，坏JSON、多个对象或字段错误仍拒绝 |
| 模型生成达到上限 | beta2使用2048/4096有界生成预算并保留更低的服务端配置；显示中文原因，不自动重试或降低Harness推理强度 |
| 0.5口型开启却不动 | 确认安装版本、朗读已启用、声音可用、角色可见，且未开启“减少动态”；口型自身不会开启朗读 |
| 余额/费用显示未知 | 余额仅支持现有DeepSeek账户服务；费用是有单价且有用量时的估算，未知不等于0元 |

**终端可以关吗？** 官方桌面版安装和使用不需要保留终端；Harness 必须继续运行。插件没有额外注册开机登录项或 LaunchAgent，Host 退出后不会独立观察。

完整排错、权限恢复和记忆操作见[使用指南](docs/guide.md#常见问题)。反馈时请附版本、系统/芯片、安装方式、脱敏状态与复现步骤；不要公开模型密钥、完整配置或私人屏幕内容。

## 第三方项目与来源

以下逐项链接当前实际采用的 GitHub 项目，并说明调用、适配与随包来源。**引用链接不替代原许可**；完整版权、许可正文、固定提交与改动范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[许可核查](docs/license-audit.md) 和 [third_party/](third_party/)。

### 直接依赖与提取适配

| 项目与采用版本 | 在本插件中的用途 | 许可记录 |
| --- | --- | --- |
| [MCP Memory · server-memory 2.0.1](https://github.com/modelcontextprotocol/servers/tree/194cc86e3ae6400958555bd4116849d822d69263/src/memory) | 调用知识图谱管理器保存实体、观察与关系；证据核验、置顶、纠正和遗忘由本插件包装 | [完整MCP许可](third_party/MCP-MEMORY-LICENSE.txt)，含Apache过渡及保留MIT说明 |
| [Orama 3.1.18](https://github.com/oramasearch/orama/tree/2fe41e163c2bdd7830eed7496c69134aea8ee3ba/packages/orama) | 本机全文检索，增加中文单字/双字词和近期/重要性排序 | Apache-2.0；[原始声明](third_party/ORAMA-LICENSE.md) |
| [dsh-roleplay-plugin · c2f4844](https://github.com/ajuwm/dsh-roleplay-plugin/tree/c2f4844e8e342c9a0079b7d4df419adb774bccef) | 提取适配4种食品及恢复规则，复用 `axisTier`、`repeatDimOf`；用于熟悉阶段与重复互动递减 | MIT；[完整原文](third_party/ROLEPLAY-GROWTH-LICENSE.txt)、[本地适配文件](third_party/roleplay-game-core.mjs) |

roleplay 的完整角色卡、日记、纪念日、多角色关系、小游戏和 Windows 桌宠服务没有随本项目移植。当前 token 去重、库存、经验、门禁、持久化和 macOS 展示另由本项目实现。

### 间接依赖与 SDK 附带来源

当前插件 lock 图包含2项直接与3项间接 npm 包。SDK另将下列代码编入自己的发布文件，它们不会在本插件 lock 中全部表现为独立节点；声明映射附带的类型文件也单独列出。

| 层级 | 组件与实际版本 | 官方 GitHub 来源 | 完整许可入口 |
| --- | --- | --- | --- |
| 间接 | `@modelcontextprotocol/server@2.4.0` | [typescript-sdk 固定源码](https://github.com/modelcontextprotocol/typescript-sdk/tree/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5) | [SDK原文](third_party/modelcontextprotocol-server-LICENSE) |
| 间接 | `@modelcontextprotocol/core@2.4.0` | [同一SDK固定源码](https://github.com/modelcontextprotocol/typescript-sdk/tree/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5) | [同字节许可](third_party/modelcontextprotocol-server-LICENSE) |
| 间接 | `zod@4.6.7` | [colinhacks/zod](https://github.com/colinhacks/zod/tree/b500a2ee95134f81d74da7911d7378dd2853d042/packages/zod) | [MIT原文](third_party/zod-LICENSE) |
| SDK内嵌 | `ajv-formats@3.0.1` | [ajv-validator/ajv-formats](https://github.com/ajv-validator/ajv-formats/tree/1fb3fa7d967f919ff924bb34aef73a2f39ab0de3) | [MIT原文集合](third_party/SDK-BUNDLED-THIRD-PARTY-LICENSES.txt) |
| SDK内嵌 | `ajv@8.18.0` | [ajv-validator/ajv](https://github.com/ajv-validator/ajv/tree/142ce84b807c4fe66e619c22480a28d0e4bd50fa) | [MIT原文集合](third_party/SDK-BUNDLED-THIRD-PARTY-LICENSES.txt) |
| SDK内嵌 | `@cfworker/json-schema@4.1.1` | [cfworker/cfworker](https://github.com/cfworker/cfworker/tree/5409fdc2bd144f68e8b28c61c71fcb16600000a6) | [MIT原文集合](third_party/SDK-BUNDLED-THIRD-PARTY-LICENSES.txt) |
| SDK内嵌 | `content-type@1.0.5` | [jshttp/content-type](https://github.com/jshttp/content-type/tree/6115a4064e4dfd9845241c3f89c233ee2423deeb) | [MIT原文集合](third_party/SDK-BUNDLED-THIRD-PARTY-LICENSES.txt) |
| SDK内嵌 | `fast-deep-equal@3.1.3` | [epoberezkin/fast-deep-equal](https://github.com/epoberezkin/fast-deep-equal/tree/d807ffc5013e710deb1c63d463a03f729bcd144d) | [MIT原文集合](third_party/SDK-BUNDLED-THIRD-PARTY-LICENSES.txt) |
| SDK内嵌 | `fast-uri@3.1.8` | [fastify/fast-uri](https://github.com/fastify/fast-uri/tree/ead3ab7bb134c989e972c8174632d0670023f269) | [BSD-3-Clause原文集合](third_party/SDK-BUNDLED-THIRD-PARTY-LICENSES.txt) |
| SDK内嵌 | `json-schema-traverse@1.0.0` | [epoberezkin/json-schema-traverse](https://github.com/epoberezkin/json-schema-traverse/tree/6b45983cd76270042cc79527da5c8972f13599ec) | [MIT原文集合](third_party/SDK-BUNDLED-THIRD-PARTY-LICENSES.txt) |
| SDK附带声明 | `json-schema-typed@8.0.2` | [RemyRylan/json-schema-typed](https://github.com/RemyRylan/json-schema-typed/tree/613f3ab84c8e1b14de492534bfcb81d1499610a3) | [BSD-2-Clause原文](third_party/JSON-SCHEMA-TYPED-LICENSE.txt) |

`json-schema-typed` 来自 SDK 的类型声明映射，不是第8个运行时内嵌库。上游最新版许可不能替代已采用的8.0.2许可。本表记录当前核查版本，安装器后续按传递依赖范围重新解析时，仍需复核实际安装图。

### Host、共享界面与开发基础

| 来源 | 使用方式与分发边界 |
| --- | --- |
| [DeepSeek Harness 0.2.1-rc.5](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.5) | 提供插件生命周期、模型、附件、会话事件、账户与设置服务；插件不重新分发整个Host |
| [官方 decoration 模板](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.5/packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration)与[客户端消费示例](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/apps/web/tests/fixtures/plugins/fixture-input-extension/client.js) | 参考模块工厂、共享模块与注册协议；设置页、controller和样式由本项目另写；[Host MIT原文](third_party/DSH-HARNESS-LICENSE.txt)完整保留 |
| [Host UI primitives](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.5/packages/client/ui-primitives)与[settings插槽](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/client/ui-settings/src/client/contract/slots.ts) | 使用Host提供的Button、Switch、connection、locale与设置注册；没有另复制整套界面依赖 |
| [React / ReactDOM / scheduler](https://github.com/react/react/tree/v18.3.1) | 使用Host共享React，Host负责挂载/调度；本次Host中分别为18.3.1/18.3.1/0.23.2，插件未另打包React；ReactDOM也用于本机SSR测试 |
| [clsx 2.1.1](https://github.com/lukeed/clsx/tree/v2.1.1) | Host的Button/Switch使用它合并样式，插件没有单独导入或复制 |
| [Cordis上游](https://github.com/cordiverse/cordis)与[Harness内的fork](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.5/vendor/cordis) | 通过Host的 `@deepseek-ai/cordis@4.0.5` 获得上下文与生命周期；采用fork保留Shigma等原MIT声明，未另打包到插件 |
| [loose-envify 1.4.0](https://github.com/zertosh/loose-envify)、[js-tokens 4.0.0](https://github.com/lydell/js-tokens) | Host共享React发布/构建图中的基础，未由本插件独立调用或打包；生产内联由Host负责 |
| [Node.js](https://github.com/nodejs/node) | 使用Host提供的运行时与内置模块；开发验证使用Node.js 24，无额外Node运行时随包复制 |

原生窗口、捕获、离线识别、网格和播放使用 macOS 的 AppKit、ScreenCaptureKit、Speech、SpriteKit、AVFoundation 等系统框架。没有为这些功能引入第三方动画引擎、口型服务或 Live2D SDK。

### 体验调研、README参考与历史素材

以下链接保留来源，但与上述实际代码使用分开：

| 项目 | 本次参考范围 |
| --- | --- |
| [DSH 大肥鱼](https://github.com/QCYTSN/dsh-dafeiyu) | README的客户端区分、安装、常用设置、平台、排错与素材说明组织 |
| [小鲸鱼记账挂件](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | README的功能分组、数据来源、统计口径与凭据说明组织 |
| [DSH Plugin Hub](https://github.com/dshplugin/dsh-plugin-hub) | README按用户任务配图、安装/更新/反馈入口与社区项目身份说明 |
| [dsh-roleplay-plugin](https://github.com/ajuwm/dsh-roleplay-plugin) | README先讲陪伴体验，再展开机制的结构；实际提取规则已在上表另外列明 |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 视觉与语音伙伴的产品调研，未集成其服务、代码、Live2D或语音管线 |
| [CrossPet](https://github.com/lokicorvus/crosspet/tree/5c64326b6e7fc175eda0360c0bb5c4732541d138) | 桌宠展示与文档调研，未复制图片、配置、提示词或代码 |
| [xp-level-system](https://www.npmjs.com/package/xp-level-system)、[xp-parser](https://www.npmjs.com/package/xp-parser) | 等级方案调研，未安装或打包，当前XP逻辑由本项目实现 |

本次只借鉴文档框架，正文按本插件实现重新编写，没有复制这些项目的截图、宣传结论或角色素材。固定调研版本与采纳说明见[README结构调研](docs/readme-reference.md)。

历史0.2/0.3版本曾使用 [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu/tree/084323845ab82b68d5388d5c638bec09d8544a8a)和 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet/tree/549fff2ea33c2acfb16612c76912c6137da4a758)的旧动作素材，当前橙发版本已替换，旧发布保留当时的来源与许可。当前参考图按用户说明为AI图，Q版立绘与图集由图像工具生成/编辑；来源、提示、散列和嘴框记录见 [ASSET_SOURCE.md](assets/orange-character/ASSET_SOURCE.md)。软件许可不自动覆盖图片，历史动画的MIT也不转授当前素材权利。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run build:client
npm test
./native/build.sh
```

源码开发需要Node.js 24及macOS/Xcode命令行工具。完整SSR测试需要可用的Host React，例如设置 `DSH_HARNESS_DIR=/path/to/deepseek-harness`；未提供时相关检查会跳过。安装发行包无需这些开发工具。

| 路径 | 内容 |
| --- | --- |
| `client/`、`client.js` | 设置界面源码与离线预构建产物，共享Host React/UI |
| `lib/` | 默认模型调用、事件策略、记忆、用量、成长和设置通信 |
| `native/` | macOS原生角色、感知、播放、动作及预编译组件 |
| `assets/orange-character/` | 当前Q版素材、清单、生成来源与口型校准 |
| `third_party/` | 提取适配模块与完整第三方许可 |
| `docs/` | 详细指南、来源、许可审计与分层验证记录 |

**beta5的JavaScript全量检查为180项通过、0失败、0跳过**。公开提交 `5dbd998` 对应包已实际安装，87文件、原生18文件、严格签名及安装瞬间三状态保留均已核对。11月4日锁屏未验后，11月5日实际Host确认CG授权、观察/画面开启和新配置提示，无重复授权；Q版角色、身边零食及隐藏成长栏可见，拉面进食成功、+20XP。今日本机日桶自然切换后未达预算，昨日账保留，没有提高预算或清用量。实际默认模型的裙摆触碰自然回应已显示于聊天窗口；不据此确认画面或回应中其它事实准确。受控OCR、系统音频和鼠标权限未验，详见[最新桌面结果](docs/development.md#beta5-ui-validation)。

**beta4的JavaScript全量检查为178项通过、0失败、0跳过**。公开提交 `221630c` 对应的安装包已实际安装为0.5.1-beta.4，87文件与公开包逐字节匹配、严格签名通过；继续使用同字节0.5.1/build9原生组件。仅移除临时测试安静应用标记，未修改其它设置键；以清理后的状态为安装基线，三状态文件SHA安装前后一致，运行后可正常变化。实际重启后CG仍已授权、画面与观察开关为开；状态文字仍是初始化旧句，beta5针对这项显示不一致做兼容修复。11月4日当时预算到限，未提高预算或清用量，新的模型、裙摆与受控标记未验，不据此判断模型故障。详见[beta4实机记录](docs/development.md#beta4-desktop-validation)。

**beta3的JavaScript全量检查为174项通过、0失败、0跳过**，使用Node.js24.21、实际Host React与合成Unix socket。公开版本对应提交 `805b147`，实际安装87个文件与发行包逐字节匹配，严格签名通过；原生0.5.1/build9的18个bundle文件与beta2一致，不将历史原生检查算作本轮重新执行。安装瞬间设置、成长、用量三个文件字节保留；随后真实互动和模型请求已使成长、用量正常变化，不代表这些文件当前仍与安装前相同。beta3一次身体互动得到自然中文回应；摸头成功属于beta2历史，裙摆复测尚待完成。详见[beta3实机记录](docs/development.md#beta3-desktop-validation)。

已发布的 **0.5.1-beta.1 / build8** 通过165项Node.js 24＋实际Host React测试（0失败、0跳过）、41项权限策略检查及解锁后的完整LaunchServices协议。实际Desktop使用bundled CLI离线安装与公开Release散列一致的包，87个文件匹配、严格签名通过，设置与用量文件逐字节保留，等级/经验/库存及统计保留。重启后真实屏幕权限已就绪，画面开关可开启且不循环确认；该项检查保持观察关闭，不等于已完成画面采集。

同次beta1复核中，Harness默认Flash的一次中文问答返回2026-11-04下午3:39，与当时系统时间一致；通过原生菜单真实递食一份、增加20XP并观察到进食动画。系统声音曾实际开启，屏幕与Speech授权就绪且未崩溃，但观察关闭，未验证转写质量。另一次真实画面请求到达默认模型，因受控窗口未成为采样目标，只证明实际帧到模型链路可达，未完成受控OCR准确性验收。

**beta2通过169项Node.js 24＋实际Host React测试（0失败、0跳过）；最终build9通过构建、严格签名、24动作/192帧解码及完整LaunchServices协议；权限41项、AX对象32项、音频状态15项纯检查通过。** 系统声音状态区分已配置但观察暂停、等待启动、正在启动和实际运行，保留真实失败信息。这些检查本身不证明真实AX树/Press、全部OS能力或理解质量通过；模型格式失败根因也不能由一次成功推定。

**beta2发布后的实际Desktop复核（2026-11-04）：** 安装公开发行包后87个文件一致、严格签名通过，安装前后的设置、成长和用量三个文件逐字节保留。真实点击角色身边的蛋糕卷后进食计数增加1、获得20XP；另一次互动获得5XP，紧接着点另一食物显示53秒冷却。真实摸头得到匹配头顶部位的中文模型回应，并从原生聊天记录确认文本。该次身体互动仍出现一次 `invalid_json`，屏幕预检未授权；beta1曾授权成功的历史记录不代表此次通过。beta2音频状态文案及真实AX操作仍待实际确认。详情见[发布后记录](docs/development.md#beta2-desktop-validation)。

**屏幕权限后续核查：** 用户仅重建“安静陪伴”这一条权限并完成两次系统认证后，重新打开实际Harness，已安装组件的CG预检显示已授权，画面开关可开启且不再重复请求授权；后续观察也已开启。一次自动画面请求识别了当时的前台应用，说明链路可达；受控测试标记的手动回答没有附图，不能记为OCR准确性通过。没有重编或改签名，未确认TCC记录内容，签名身份匹配仍属推断。新系统条目的显示路径也不能用于断言授权记录必然绑定profile路径。详见[核查边界](docs/development.md#screen-permission-followup)。

0.5.0另有一次真实短句PCM播放时钟/RMS测试及20张自有场景嘴框对照：[对照图](docs/assets/q-mouth-qa.png)、[检测摘要](docs/q-mouth-qa.json)。对照图使用合成音量，不是桌面截图；这些历史记录不能代替0.5.1的真实授权或模型验收。

构建与协议命令、测试范围和历史实机证据见[开发与验证](docs/development.md)。

## 许可与反馈

自有代码当前为 **`UNLICENSED`**，仓库没有统一授予MIT许可；第三方部分继续遵守各自原许可。角色素材另见[素材来源](assets/orange-character/ASSET_SOURCE.md)，未随软件许可额外授予再分发权。引用、调研或保留原许可，也不表示获得上游作者的背书。

欢迎通过 [Issues](https://github.com/Chertuion/dsh-quiet-companion/issues) 反馈问题或建议。涉及外部代码、模型或素材的改动，请同时给出来源、具体版本、适用许可和修改范围，便于持续维护完整的归属记录。

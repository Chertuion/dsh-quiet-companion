# beta9 桌面实测截图

这10张图片采集于 **2026-11-05**，对应实际运行的 **安静陪伴0.5.1-beta.9 / DeepSeek Harness0.2.1-rc.5**。来源为 CUA `App.getScreenshot` 的真实应用窗口捕获；发布文件与原始捕获逐字节一致，未重绘、未裁剪、未转码。实际格式为JPEG。

截图展示拍摄时的真实界面与数据，不是默认配置、模拟UI或场景渲染。自有测试卡是受控测试输入；卡片在系统“预览”中显示的窗口仍为实拍。静态截图只证明可见界面，动态行为、模型调用过程与验收条件须结合[开发记录](../../development.md#beta9-validation)。

| 文件 | 实际窗口 | 界面所见与范围 |
| --- | --- | --- |
| [desktop-companion.jpg](desktop-companion.jpg) | 原生桌宠窗口 | 空闲状态；当前橙发Q版角色，8份零食分布在角色左右和脚边。 真实运行窗口；不将静态截图当作动画帧率或进食动作证据。 |
| [growth-and-snacks.jpg](growth-and-snacks.jpg) | 原生“成长与零食”窗口 | Lv.3；本级经验86/150、饱腹74/100、库存119；状态说明先把零食留着。 展示自动进食决策状态，不是一次手动递食被拒绝的结果。成长数值是拍摄时快照，不是初始默认值。 |
| [screen-test-input.jpg](screen-test-input.jpg) | macOS“预览”窗口 | 打开本项目自有受控测试卡：SCREEN TEST、PINE-4926和5个橙色圆。 卡片内容由本项目制作；这是预览窗口的真实截图，不是重新绘制的应用界面。 |
| [screen-understanding-result.jpg](screen-understanding-result.jpg) | 原生“和她说句话”窗口 | 保留的真实手动画面识别回应正确写出PINE-4926和5个橙色圆。 拍摄时仅重新打开上轮真实回应，未重发提问；截图日期不代表新增模型调用时间。 |
| [desktop-perception.jpg](desktop-perception.jpg) | 原生设置·陪伴 | 应用与空闲观察开启；画面间隔3秒；Agent进度显示为空闲。 只表示截图中可见的当时配置和状态，不以开关开启推定所有感知质量通过。 |
| [screen-audio-settings.jpg](screen-audio-settings.jpg) | 原生设置·模型与画面 | 跟随Harness默认模型；画面关键帧分析开启，系统播放声音理解关闭。 这是实际原生设置页；本图不证明音频转写质量或任意画面准确性。 |
| [voice-and-appearance.jpg](voice-and-appearance.jpg) | 原生设置·语音与动作 | 朗读关闭、PCM/RMS口型开关开启、动态角色开启、右侧成长状态栏关闭。 口型开关本身不会播放声音；静态截图不证明口型或动画正在运行。 |
| [proactive-interaction.jpg](proactive-interaction.jpg) | 原生“和她说句话”窗口 | 新自动回应评论预览中的5个橙色圆和PINE-4926。 仅恢复观察触发，未发送手动聊天；受控测试期间临时关闭记忆以隔离个人资料，随后暂停观察。 |
| [agent-progress-thinking.jpg](agent-progress-thinking.jpg) | 原生设置·陪伴 | 真实Agent处于思考中；轮次1、步骤1、进行中1；应用观察关闭。 状态来自真实Host只读系统时间任务，未合成Agent状态；观察开关关闭不影响独立的Agent事件频道。 |
| [agent-progress-completed.jpg](agent-progress-completed.jpg) | 原生桌宠窗口 | 角色顶部显示“已完成”，角色周围仍有零食。 这是同一真实Host任务完成后的窗口，不是任务执行中的截图。 |

## 文件完整性

每项SHA-256均对发布文件与对应原始捕获独立计算并核对一致。完整机器可读字段见[manifest.json](manifest.json)。

| 文件 | 尺寸（像素） | 字节数 | SHA-256 |
| --- | --- | --- | --- |
| desktop-companion.jpg | 640 × 800 | 85885 | `a286f710e4f43035e1820e1081031fe51e5a14e1543145165c14e7023d44c097` |
| growth-and-snacks.jpg | 840 × 954 | 82563 | `65f850fc179dca4d1f36e29f9b226eddd7e8c7f529ff3b7a689f7ce2d5673479` |
| screen-test-input.jpg | 2000 × 1384 | 178486 | `2e095262ab41232e0571f4278dcdf1c495d34578b2140da50cb22fae793cff43` |
| screen-understanding-result.jpg | 900 × 554 | 48728 | `243b8bd07c98552f4287f6e85d3b6b0b8b3a34d4598e96b7cab21b8587d617d6` |
| desktop-perception.jpg | 1360 × 1484 | 194593 | `1176ea62abaf07ea55f3c9ee1814d4af36b734d1b5ee8f73ac51fa3647934d63` |
| screen-audio-settings.jpg | 1360 × 1484 | 192345 | `d357a817bf1c5ffcd1b741f2d1ce41f29b9795d4afcdf65abf000e2c1e38a420` |
| voice-and-appearance.jpg | 1360 × 1484 | 159158 | `00a2021f9d45a1cc61c1c81cebaa2fe2314a5980a486b047719dd0ae0e8b8a19` |
| proactive-interaction.jpg | 900 × 554 | 39545 | `6b21e6874443b456f18f6151fce7826ac4d000226b9ebdacb50740f3e8f27744` |
| agent-progress-thinking.jpg | 1360 × 1484 | 193393 | `b5dd23d01dc3eb68ba770d58d5e2cf2c1b72025b93856ac7e35b9939e10fa51e` |
| agent-progress-completed.jpg | 640 × 800 | 86874 | `ff92b86191b7b3fd1b56d613f72b01321b708af6b3363bec1f14146739ebcad5` |

## 来源与权利

截图仅包含本插件原生AppKit界面、实际Host任务状态及本项目自有测试卡，没有复制第三方截图、图库或图标包，也未引入新的图片、动画或界面依赖。未公开私有绝对路径、用户名、个人对话或用量账目。

截图不新增MIT或其他再分发授权。图中Q版角色仍受现有[素材来源与权利说明](../../../assets/orange-character/ASSET_SOURCE.md)约束；既有AppKit/Host实现及第三方软件归属见[第三方声明](../../../THIRD_PARTY_NOTICES.md)。

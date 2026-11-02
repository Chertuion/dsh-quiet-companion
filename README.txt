安静陪伴 0.4.1-beta.1

DeepSeek Harness 的 macOS 桌面陪伴插件：沿用默认模型聊天，支持记忆、Agent进度、身边零食与成长，以及可选的画面理解、系统声音转写和语音朗读。

适用：Apple Silicon、macOS14+、Harness0.2.1-rc.5。
安装：插件 → 添加插件 → github:Chertuion/dsh-quiet-companion#v0.4.1-beta.1
启用后重新打开 Harness，在“设置 → 安静陪伴”管理。

新零食出现在角色左右和脚边；右侧成长状态栏默认隐藏，可在成长设置或角色右键菜单显示。
观察、画面、系统声音、朗读与鼠标互动默认关闭。无需另填API Key，正常模型调用仍可能产生费用。
选中送给模型的关键帧可能进入Harness本机共享附件缓存；系统音频不保存原始录音。

旧版先停用并卸载，再安装新地址；本插件包外的设置、记忆、等级和库存不会主动清除。
原生组件为本地ad-hoc签名，未做Developer ID公证。

使用方法、预览和常见问题：README.md
详细用法与数据权限：docs/guide.md
第三方实际复用及原始许可：THIRD_PARTY_NOTICES.md、third_party/
许可核查：docs/license-audit.md

角色素材依据用户提供的AI参考图生成，不按第三方软件许可授予图片权利。
自有代码当前UNLICENSED；第三方代码遵循各自许可。

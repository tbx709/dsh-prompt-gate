# dsh-prompt-gate · 提示词闸门

**dsh 动手之前，先把你的话锻造成它能执行的提示词。**

新会话的第一条消息会被自动拦下：改写、给你看、你确认之后才解锁工具。没确认之前，`bash`、`write`、`edit` 一律调不动——这不是提示词要求，是执行层直接拒绝。

English: [README.en.md](README.en.md)

## 它解决什么

新会话里的第一句话通常是一句口语：「帮我看看这个项目」「把这个页面优化一下」。模型拿到它只能猜：猜你要什么、猜做到什么算完、猜能动哪些文件。猜错的代价是返工，而返工比多问一句贵。

提示词闸门把「猜」挪到动手之前，并且**不替你按确认**：

1. 模型先把这句口语改写成一份自包含的任务简报（任务 / 上下文 / 范围与约束 / 交付物与验收 / 建议步骤）；
2. 简报以卡片形式出现在输入框位置；你可以写修改意见让它重写，循环到满意；
3. 你点「确认，开始执行」之后工具才解锁，模型才真的动手。

## 安装

DSH 需要 **>= 0.2.2-alpha.2**（本插件用到的 `sessionProjections`、`tools.guard`、`output.presentationMeta` 契约以该版本为准，更早版本未验证）。

### Plugin Manager

把仓库克隆到本地，在 **Plugins** 页通过 `install_bundle` 安装该目录。

### npm（推荐）

```sh
dsh plugin --profile web add dsh-prompt-gate
```

### 命令行（从 GitHub）

```sh
dsh plugin --profile web add github:tbx709/dsh-prompt-gate
```

安装后如果插件行显示加载失败、或看不到效果，完整重启一次 dsh（换包才会加载新的模块代）。

本插件是 **Host-only** 的：没有浏览器端代码，卡片由 dsh 自带的问答面板渲染，所以**不需要刷新页面**。

## 用起来是什么样

1. 新建会话，发第一条消息（例如「帮我看看这个插件目录」）。
2. 模型不直接干活。它把这句话改写成任务简报，调用 `review_prompt` 给你看。
3. 输入框位置出现卡片：正文就是简报（Markdown），下面两个按钮 + 一个输入框：

   | 你的操作 | 结果 |
   | --- | --- |
   | 点「确认，开始执行」 | 按这份简报开工，工具全部解锁 |
   | 点「用原文执行」 | 放弃强化，直接按你原来的消息做 |
   | 在输入框写修改意见并提交 | 模型改完再弹一次卡片，可反复循环 |

   **为什么没有「继续修改」按钮**：宿主这张问答卡片里选项和文字是互斥的——点选项会清空输入框，输入文字会取消选中。所以卡片只提供两个决定，**写文字本身就是修改请求**。

4. 原始消息本来就足够明确时（目标、范围、验收都清楚），模型会走 `mode="pass"` 直接跳过卡片，不打扰你。

审阅期间模型只能调用只读工具（`read` / `glob` / `grep` / `web_*`）、`skill` 和 `ask_user_question`；`bash`、`write`、`edit` 等一律被拒绝。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖那一行，字段都可以省略：

```yaml
- id: prompt-gate
  config:
    scope: first        # first（默认）| every
    timeoutMs: 900000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后完全不拦截。 |
| `scope` | `first` | `first`：只覆盖会话第一轮，已有对话不会被追溯拦截。`every`：每一条用户消息都要求先审阅。 |
| `timeoutMs` | `900000` | 卡片最长等 15 分钟；超时按「用原文执行」放行，不会挂死回合。`0` 表示不超时。 |
| `forceReview` | `false` | `true` 时禁止 `mode="pass"`，每条都强制过卡片。 |
| `section` | `''` | 追加到内置协议段落末尾的额外指引（例如「提示词里必须带验收命令」）。 |
| `header` / `question` | 中文文案 | 卡片标题与提问。 |
| `approve` / `skip` | 中文文案 | 两个按钮的文案，必须互不相同。 |
| `approveHint` / `skipHint` | 中文文案 | 按钮说明（悬停显示）。 |

> `revise` / `reviseHint` 已移除；配置里还写着它们会在加载时报错并说明原因。

## 它是怎么做到的

没有浏览器代码，也没有自己的状态机——闸门完全从会话日志推导：

| 部件 | 作用 |
| --- | --- |
| `promptGate` session projection | 纯函数折叠四个数字：`firstHuman` / `lastHuman`（人类消息的 seq）、`settled`（本插件结果为 confirmed/skipped 的最新 seq）、`turns`。开闸 = `settled < anchor`（`first` 还要求 `turns <= 1`）。进程重启、会话恢复、插件重载后答案一致。 |
| `systemPrompt.section` | 只在开闸时注入协议段落：先改写、再交审、确认后才执行。 |
| `review_prompt` 工具 | 只在开闸时被准入（注册时的 `when`），负责弹卡片、收决定。 |
| `tools.guard` | 开闸期间拒绝其他工具。guard 是单调的，任何监听器都无法把拒绝改回允许。 |
| `output.presentationMeta` | 把 `{tool, outcome}` 写进 `tool/result.meta`，闸门据此关闭——不靠插件内存。 |
| `ctx.userQuestions.ask` | 复用宿主问答面板渲染卡片；`AbortSignal` 给等待加硬上限。 |

唯一留在内存里的是「模型整轮没走协议」的豁免（安全阀），它同样可以从日志重新推导。

## 验证状态

- **自动化**：`npm test` 用假 Host 驱动 `apply`，覆盖开闸判定（首条 / 逐条 / 老会话不追溯 / 不合格会话）、guard 放行与拒绝、卡片四种回答、超时、`forceReview`、配置校验。
- **人工**：作者在 dsh `0.2.2-alpha.2` + Web 图形界面实测卡片显示、确认、放弃与改写循环。
- **未验证**：更早或更新的 dsh 版本；纯 CLI / headless 环境（没有提问通道时插件自动让路，不拦截）。

## 已知边界

- fork 出来的会话、子代理会话永远不会触发。
- `scope: first` 只覆盖第一轮：跑过两轮以上的会话不会被追溯拦截。
- `scope: every` 对已有会话也生效，但只管装上之后的新消息；一轮进行中插话（steer）同样会要一次审阅。
- 拦截状态来自日志推导，但「协议没走通」的豁免只在当前进程有效，重启后可能再提醒一次。
- 卡片被关闭等同于「用原文执行」。
- 没有可用的提问通道（纯 CLI / headless）时审阅自动让路。

## 开发

纯 JavaScript、零依赖、无构建步骤。

```sh
npm run check   # node --check index.js
npm test        # 假 Host 冒烟测试
```

```
index.js                    Host 插件：配置、投影、提示词段落、guard、review_prompt 工具
cordis.patch.yml            bundle 补丁（插入一行插件）
locale/{zh,en}.json         插件管理页的标题与描述
icon.svg                    图标
test/plugin.test.mjs        假 Cordis 上下文的逻辑测试
```

## License

[MIT](LICENSE)

# dsh-prompt-gate · 提示词闸门

[![npm](https://img.shields.io/npm/v/dsh-prompt-gate)](https://www.npmjs.com/package/dsh-prompt-gate)
[![ci](https://github.com/tbx709/dsh-prompt-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/tbx709/dsh-prompt-gate/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-prompt-gate)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.2--alpha.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

**没人教过你怎么跟 agent 说话。** 你打开新会话，敲一句话，剩下的全让 dsh 去猜。

这个插件不让它猜：第一条消息先被改写成 dsh 真能执行的简报，以卡片交给你确认，**没确认之前它一个工具都动不了**。

[English](README.md)

---

## 第一句话为什么总是害你返工

| 你打的 | dsh 只能猜的 |
| --- | --- |
| 「帮我把登录页改好看点」 | 哪个页面？改到什么程度算好看？能不能动结构？ |
| 「看看这个项目」 | 看哪部分？为了什么？什么算看完了？ |

返工不是模型笨，是**那句话本来就不是一份提示词**。解决办法不是「去学提示词工程」，而是在动手之前多一步。

## 它做了什么

你打：

> 帮我把登录页改好看点

你收到：

```text
## 任务
把 apps/web 的登录页视觉升级，保持现有路由与文案不变。

## 上下文
- apps/web/src/pages/login.tsx，样式在 login.module.css
- 设计 token 在 apps/web/src/styles/tokens.css

## 范围与约束
- 只改样式：不动路由、文案、组件结构
- 复用现有 token，不新增颜色

## 交付物与验收
- 375px 与 1440px 下无横向溢出
- pnpm --filter web test 通过

## 建议步骤
1. 先读 login.module.css 与 tokens.css
2. 先调间距与字号层级，再调颜色
```

下面两个按钮。点「确认，开始执行」就照这份简报干活；想改哪里，直接在输入框写意见，它改完再给你看——
可以反复循环到你满意为止。

审阅期间模型只能调用只读工具（`read` / `glob` / `grep` / `web_*`），加上 `skill` 和 `ask_user_question`。

## 为什么是「闸门」而不只是「改写器」

一个你能随手忽略的改写器只是建议。这是闸门：审阅没结束之前，`tools.guard` 在**执行层**拒绝
`bash`、`write`、`edit` 和其余工具。模型既绕不过你，也没法声称你同意了。

## 安装

DSH 需要 **>= 0.2.2-alpha.2**（本插件用到的 `sessionProjections`、`tools.guard`、`output.presentationMeta`
契约以该版本为准，更早版本未验证）。

```sh
dsh plugin --profile web add dsh-prompt-gate                    # 从 npm
dsh plugin --profile web add github:tbx709/dsh-prompt-gate      # 从 GitHub
```

也可以克隆仓库，在 **Plugins** 页用 `install_bundle` 安装该目录。装完如果插件行显示加载失败、或看不到效果，
完整重启一次 dsh（换包才会加载新的模块代）。

本插件是 **Host-only** 的：没有浏览器端代码，卡片由 dsh 自带的问答面板渲染，所以**不需要刷新页面**。

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

> 卡片上没有「继续修改」按钮，是有意的：宿主问答卡片里选项和文字互斥（点选项会清空输入框，输入文字会取消选中），
> 所以只留两个决定，**写文字本身就是修改请求**。`revise` / `reviseHint` 配置项已移除。

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

- **自动化**：`npm test` 用假 Host 驱动 `apply`，覆盖开闸判定（首条 / 逐条 / 老会话不追溯 / 不合格会话）、
  guard 放行与拒绝、卡片四种回答、超时、`forceReview`、配置校验。
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

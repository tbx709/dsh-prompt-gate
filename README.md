# dsh-prompt-gate

[![npm](https://img.shields.io/npm/v/dsh-prompt-gate)](https://www.npmjs.com/package/dsh-prompt-gate)
[![ci](https://github.com/tbx709/dsh-prompt-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/tbx709/dsh-prompt-gate/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-prompt-gate)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.2--alpha.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

**Nobody teaches you how to talk to an agent.** You open a new session, type one sentence, and dsh
has to guess the rest.

`dsh-prompt-gate` stops the guessing. The first message is rewritten into a brief dsh can actually
execute and shown to you as a card — and **its tools stay locked until you approve**.

[中文](README.zh.md)

---

## Why your first message is the problem

| You type | What dsh has to guess |
| --- | --- |
| "take a look at this project" | which part, for what, and what "done" means |
| "make the login page nicer" | which files, which framework, whether markup is fair game |

That guessing is where rework comes from — not from a weak model, but from a request that was never
a prompt. The answer is not "go learn prompt engineering". It is one step before the work starts.

## What it does

You type:

> make the login page nicer

You get:

```text
## Task
Upgrade the visual design of the login page in apps/web, keeping its route and copy untouched.

## Context
- apps/web/src/pages/login.tsx, styles in login.module.css
- design tokens in apps/web/src/styles/tokens.css

## Scope and constraints
- Styling only: no route, copy, or component-structure changes
- Reuse the existing tokens; introduce no new colors

## Deliverable and acceptance
- Renders at 375px and 1440px with no horizontal overflow
- `pnpm --filter web test` passes

## Suggested steps
1. Read login.module.css and tokens.css
2. Rework spacing and type scale first, then color
```

Two buttons sit under it. **Approve** starts the work under that brief. Type a change request into the
answer field instead, and it rewrites and asks again — as many rounds as you like.

While the review is open, only read-only tools are callable (`read`, `glob`, `grep`, `web_*`), plus
`skill` and `ask_user_question`.

## Why a gate, not just a rewriter

A rewriter you can ignore is a suggestion. This is a gate: until the review settles, a `tools.guard`
denies `bash`, `write`, `edit` and every other tool **at the execution layer**. The model cannot work
around you, and it cannot claim you agreed.

## Install

Requires dsh **>= 0.2.2-alpha.2** (the `sessionProjections`, `tools.guard` and `output.presentationMeta`
contracts this plugin relies on are pinned to that version; older releases are untested).

```sh
dsh plugin --profile web add dsh-prompt-gate                    # from npm
dsh plugin --profile web add github:tbx709/dsh-prompt-gate      # from GitHub
```

Or clone the repository and install the directory from **Plugins → install_bundle**. If the plugin row
reports a load failure after installing, restart dsh once so it loads a fresh module generation.

This bundle is **Host-only**: no browser code, the card is rendered by dsh's own question panel, so no
page refresh is involved.

## Configuration

Override the row in the profile's `cordis.patch.yml`; every field is optional:

```yaml
- id: prompt-gate
  config:
    scope: first        # first (default) | every
    timeoutMs: 900000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `scope` | `first` | `first`: the opening turn only — existing conversations are never gated retroactively. `every`: every user message is reviewed. |
| `timeoutMs` | `900000` | Longest wait for an answer (15 min); on timeout the original message proceeds. `0` disables the timeout. |
| `forceReview` | `false` | Refuse the "already clear, skip the card" path. |
| `section` | `''` | Extra guidance appended to the built-in protocol section. |
| `header` / `question` | Chinese copy | Card heading and question. |
| `approve` / `skip` | Chinese copy | The two button labels; they must differ. |
| `approveHint` / `skipHint` | Chinese copy | Button tooltips. |

## How the gate works

No browser code and no private state machine — the gate is derived from the session log:

- a `promptGate` session projection folds four numbers: first and last human message, the latest
  settled review, and the turn count;
- a `systemPrompt.section` renders the protocol only while a review is open;
- the `review_prompt` tool is admitted only while a review is open (its registration `when`);
- a `tools.guard` denies every other tool meanwhile — monotonic, so no listener can turn a denial back
  into permission;
- `output.presentationMeta` records `{tool, outcome}` in `tool/result.meta`, and that is what closes the
  gate. Restart, resume and plugin reload derive the same answer.

The only process-local state is the waiver for a model that never opens the review at all; it, too, is
re-derived from the log.

## Status

- **Automated**: `npm test` drives `apply` against a fake Cordis host — gate derivation (first message,
  every message, old sessions, ineligible sessions), guard decisions, the four card answers, timeout,
  `forceReview`, config validation.
- **Exercised by hand**: the author on dsh `0.2.2-alpha.2` in the Web UI.
- **Untested**: any other dsh release, and headless/CLI environments (with no question channel the
  plugin steps aside and gates nothing).

## Limits

- Forked sessions and subagent sessions never trigger.
- `scope: first` covers the opening turn only; a conversation already past its second turn is never
  gated retroactively.
- `scope: every` also applies to existing sessions, but only to messages sent after it was enabled.
  Steering mid-turn counts as a message and asks for a review too.
- Closing the card is the same as choosing "use the original".
- There is no question channel in a pure CLI or headless profile, so nothing is gated there.

## Development

Plain JavaScript, no dependencies, no build step.

```sh
npm run check   # node --check index.js
npm test        # fake-host smoke test
```

```
index.js                    host plugin: config, projection, prompt section, guard, review_prompt tool
cordis.patch.yml            bundle patch (inserts one row)
locale/{zh,en}.json         Plugin Manager title and description
icon.svg                    icon
test/plugin.test.mjs        logic test against a fake Cordis context
```

## License

[MIT](LICENSE)

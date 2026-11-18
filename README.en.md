# dsh-prompt-gate

**Forge what you typed into a prompt dsh can actually execute — before it starts working.**

The first message of a new session is held: dsh rewrites it, shows you the result, and only unlocks its tools after you approve. Until then `bash`, `write` and `edit` are refused at the execution layer, not merely discouraged by a prompt.

[中文说明](README.md)

## What it solves

The opening message is usually spoken language — "take a look at this project", "polish that page". The model can only guess what you meant, what "done" means, and which files it may touch. Guesses cost a rework, and rework costs more than one extra question.

This plugin moves the guessing before the work starts, and never presses *approve* on your behalf:

1. The model rewrites the message into a self-contained brief (task / context / scope and constraints / deliverables and acceptance / suggested steps).
2. The brief appears as a card above the composer. Write a change request and it rewrites again — as many rounds as you like.
3. Tools stay locked until you choose **Approve**.

## Install

Requires DSH **>= 0.2.2-alpha.2** (the contracts this plugin relies on — `sessionProjections`, `tools.guard`, `output.presentationMeta` — are pinned to that version; older releases are untested).

```sh
dsh plugin --profile web add dsh-prompt-gate          # from npm
dsh plugin --profile web add github:tbx709/dsh-prompt-gate   # from GitHub
```

Or clone the repository and install the directory from **Plugins → install_bundle**. If the plugin row reports a load failure after install, restart dsh once so it loads a fresh module generation.

This bundle is **Host-only**: there is no browser code, the card is rendered by DSH's own question panel, so no page refresh is involved.

## Using it

1. Open a new session and send a first message ("take a look at this plugin directory").
2. The model does not start working. It calls `review_prompt` with the rewritten brief.
3. A card appears above the composer:

   | Your action | Result |
   | --- | --- |
   | **Approve, start** | work begins under the brief; every tool unlocks |
   | **Use the original** | skip the rewrite and use the message as written |
   | type a change request and submit | reworked brief, new card — repeat as needed |

   There is no separate *revise* button on purpose: DSH's question card treats a choice and a written answer as mutually exclusive (choosing clears the text field, typing clears the choice), so text **is** the change request.

4. When the message is already a complete instruction, the model passes through without showing a card.

While the review is open, only read-only tools (`read`, `glob`, `grep`, `web_*`), `skill` and `ask_user_question` are callable.

## Configuration

Override the row in the profile's `cordis.patch.yml`:

```yaml
- id: prompt-gate
  config:
    scope: first        # first (default) | every
    timeoutMs: 900000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `scope` | `first` | `first`: the opening turn only; existing conversations are never gated retroactively. `every`: every user message is reviewed. |
| `timeoutMs` | `900000` | Longest wait for an answer (15 min); on timeout the review is skipped open. `0` disables the timeout. |
| `forceReview` | `false` | Refuse `mode="pass"`, so every message goes through the card. |
| `section` | `''` | Extra guidance appended to the built-in protocol section. |
| `header` / `question` | Chinese copy | Card heading and question. |
| `approve` / `skip` | Chinese copy | The two button labels; they must differ. |
| `approveHint` / `skipHint` | Chinese copy | Button tooltips. |

## How the gate works

No browser code and no private state machine — the gate is derived from the session log:

- a `promptForge` session projection folds four numbers (`firstHuman`, `lastHuman`, `settled`, `turns`);
- a `systemPrompt.section` renders the protocol only while a review is open;
- the `review_prompt` tool is admitted only while a review is open (`when`);
- a `tools.guard` denies every other tool meanwhile — monotonic, so no listener can turn the denial back into permission;
- `output.presentationMeta` records `{tool, outcome}` in `tool/result.meta`, which is what closes the gate. Restart, resume and plugin reload re-derive the same answer.

## Verification

- **Automated**: `npm test` drives `apply` against a fake Cordis host — gate derivation, guard decisions, the four card answers, timeout, `forceReview`, config validation.
- **Manual**: the author exercised the card, approval, dismissal and rewrite loop on dsh `0.2.2-alpha.2` in the Web UI.
- **Untested**: any other dsh release, and headless/CLI environments (with no question channel the plugin steps aside and does not gate).

## Development

```sh
npm run check   # node --check index.js
npm test        # fake-host smoke test
```

Plain JavaScript, no dependencies, no build step.

## License

[MIT](LICENSE)

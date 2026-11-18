/**
 * dsh-prompt-gate — the first message of a new session (or every message, with
 * `scope: every`) is rewritten into a dsh-ready task brief and shown to the
 * user for approval before any work starts.
 *
 * While a review is open, the `review_prompt` tool is admitted, a policy
 * section explains the protocol, and a per-agent guard denies every other tool.
 * The tool asks through `ctx.userQuestions`, so the browser renders the brief as
 * a review card; the confirmed brief travels back in the tool result as the
 * authoritative instruction.
 *
 * The gate itself is derived from the committed session log by the `promptGate`
 * projection: which human messages exist, which review results settled after
 * them, and how many turns ran. Nothing about the gate lives in plugin memory,
 * so a restart or a resume cannot lose or invent an open review; only the
 * turn-end waiver (the safety valve for a model that never opens the review) is
 * process-local and re-derives itself after a restart.
 *
 * Everything here is dependency-free plain JavaScript: a profile-installed
 * bundle resolves only the modules shipped with it.
 */

export const inject = ['tools', 'systemPrompt', 'sessionProjections', 'agents']

const TOOL_NAME = 'review_prompt'
const QUESTION_ID = 'prompt-review'
/** Projection key and result marker: durable identity of this plugin's review. */
const PROJECTION_KEY = 'promptGate'
const PROJECTION_STATE_VERSION = 1
const RESULT_MARK = 'dsh-prompt-gate'

/** Tools the model may still use while a review is open. */
const UNGATED_TOOLS = new Set([
  'review_prompt',
  'ask_user_question',
  'skill',
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
])

/** Denial text the model reads when it tries to work before the review settles. */
const GATE_DENIAL
  = 'This session is still in prompt review. Rewrite the user\'s message as a task brief and call '
    + 'review_prompt so the user can approve it; every other tool unlocks once the review settles.'

const DEFAULT_CONFIG = {
  enabled: true,
  scope: 'first',
  forceReview: false,
  timeoutMs: 900_000,
  section: '',
  header: '提示词审阅',
  question: '确认后我就按它执行。想改哪里，直接在下面的输入框写修改意见再提交；不想强化就选「用原文执行」。',
  approve: '确认，开始执行',
  approveHint: '按这份提示词开始干活。',
  skip: '用原文执行',
  skipHint: '不要强化，直接按我原来的消息做。',
}

/**
 * Validate one config row. Unknown keys, blank strings, wrong types, and
 * out-of-range numbers fail at plugin load instead of being silently ignored.
 *
 * @param config - raw row config from `cordis.patch.yml`, possibly undefined.
 * @returns A detached config with every default applied.
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('dsh-prompt-gate: config must be an object')
  }
  const removed = ['revise', 'reviseHint'].filter(key => key in raw)
  if (removed.length > 0) {
    throw new Error(`dsh-prompt-gate: config ${removed.join(', ')} no longer exists — the review card has no `
      + 'revise option, because the question card treats a written answer as the change request')
  }
  const unknown = Object.keys(raw).filter(key => !(key in DEFAULT_CONFIG))
  if (unknown.length > 0) {
    throw new Error(`dsh-prompt-gate: unknown config key(s) ${unknown.join(', ')}`)
  }
  const resolved = { ...DEFAULT_CONFIG }
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== typeof fallback) {
      throw new Error(`dsh-prompt-gate: config "${key}" must be a ${typeof fallback}`)
    }
    if (typeof value === 'string' && key !== 'section' && value.trim() === '') {
      throw new Error(`dsh-prompt-gate: config "${key}" must not be blank`)
    }
    resolved[key] = value
  }
  const labels = [resolved.approve, resolved.skip]
  if (new Set(labels).size !== labels.length) {
    throw new Error('dsh-prompt-gate: the approve and skip labels must differ')
  }
  if (resolved.approve.includes('(Recommended)') || resolved.approve.includes('（推荐）')) {
    throw new Error('dsh-prompt-gate: the approve label must not carry a recommendation suffix')
  }
  if (resolved.scope !== 'first' && resolved.scope !== 'every') {
    throw new Error('dsh-prompt-gate: scope must be "first" (new sessions only) or "every" (every message)')
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs < 0 || resolved.timeoutMs > 2_147_483_647) {
    throw new Error('dsh-prompt-gate: timeoutMs must be an integer from 0 (no timeout) to 2147483647')
  }
  return resolved
}

/**
 * Build the model-facing protocol section rendered while a review is open.
 *
 * @param config - resolved plugin config carrying the user's extra guidance.
 * @returns The section markdown.
 */
function sectionText(config) {
  const extra = config.section.trim()
  const every = config.scope === 'every'
  const lifetime = every ? 'this turn' : 'the rest of the session'
  return [
    every ? '## Prompt review before each turn (active)' : '## First-message prompt review (active)',
    '',
    ...(every
      ? [
          'The user just sent a message. Before doing any real work on it, turn it into a task brief this',
          'harness can execute, and get the user\'s approval with `review_prompt`. This deployment reviews',
          'every user message, so do not skip it because an earlier message was already reviewed.',
        ]
      : [
          'This session has no turns yet, so the user\'s first message is still raw. Before doing any real work,',
          'turn it into a task brief this harness can execute, and get the user\'s approval with `review_prompt`.',
        ]),
    '',
    '1. Judge the raw message first.',
    '   - Already a complete, unambiguous instruction (clear goal, scope, and definition of done), or a',
    '     simple one-shot question: call `review_prompt` with `mode="pass"`, then do the task normally.',
    '   - Vague, broad, multi-part, or missing a definition of done: rewrite it.',
    '2. Rewrite it as a self-contained brief that a later step can execute without reading this conversation.',
    '   Use the user\'s language and markdown, with these headings:',
    '   - **任务** — the goal in one sentence.',
    '   - **上下文** — facts from the message, the working directory, and known tools or skills; never invent them.',
    '   - **范围与约束** — what to change, what not to touch, rules to follow.',
    '   - **交付物与验收** — what is delivered and how completion is verified.',
    '   - **建议步骤** — which tools or skills to start with, and the first concrete action.',
    '3. Keep every fact, constraint, and intent the user gave. Add structure, a definition of done, and safe',
    '   assumptions; mark a real unknown as `待确认` instead of guessing, and add no requirement the user did',
    '   not imply.',
    '4. Stay dense: no filler, no restating of tool documentation, and normally under 400 Chinese characters',
    '   or 250 English words.',
    '5. Call `review_prompt` with `mode="review"` and the brief, then follow its result:',
    `   - \`confirmed\` — the returned brief is the task instruction for ${lifetime}; execute it.`,
    '   - `revise` — apply the feedback and call `review_prompt` again; repeat until it is confirmed.',
    '   - `skipped` — carry out the user\'s original message as written.',
    '',
    'Ask a clarifying question with `ask_user_question` only when a single unknowable fact decides the whole',
    'task. Do not start executing before the review settles.',
    ...(extra === '' ? [] : ['', extra]),
  ].join('\n')
}

/**
 * Whether this Agent's Session may ever be gated: a real top-level session of
 * the deployment, neither fork-inherited nor a subagent child.
 *
 * @param session - the Agent's Session.
 * @param config - resolved plugin config.
 * @returns Whether reviews apply to it.
 */
function isEligible(session, config) {
  if (!config.enabled) return false
  const header = session.header
  if (header.isSeeded === true) return false
  if (header.origin === 'subagent') return false
  if ((header.delegationDepth ?? 0) > 0) return false
  return true
}

/** Ordinary top-level sessions only, as a predicate over any projected header. */
function isEligibleHeader(header) {
  return header !== undefined
    && header.isSeeded !== true
    && header.origin !== 'subagent'
    && (header.delegationDepth ?? 0) === 0
}

/**
 * Bound one user-questions wait: the caller's own cancellation plus a hard
 * ceiling. Both Node primitives are feature-checked so an older runtime keeps
 * the caller signal instead of throwing.
 *
 * @param caller - the tool call's own cancellation signal.
 * @param ms - positive timeout in milliseconds.
 * @returns A signal that aborts when either input does.
 */
function waitSignal(caller, ms) {
  if (!(ms > 0) || typeof AbortSignal.timeout !== 'function') return caller
  const timeout = AbortSignal.timeout(ms)
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([caller, timeout]) : timeout
}

/** Whether a value is this plugin's persisted fold state. */
function isReviewState(value) {
  if (typeof value !== 'object' || value === null) return false
  return ['firstHuman', 'lastHuman', 'settled', 'turns'].every(
    key => Number.isSafeInteger(value[key]) && value[key] >= -1,
  )
}

/**
 * The projection's state schema. The registry only ever calls `parse` on it
 * (a JSON-Schema-style validator would work identically), so this dependency-free
 * module declares the one method the runtime needs and rejects anything else.
 */
const reviewStateSchema = {
  parse(value) {
    if (!isReviewState(value)) {
      throw new Error('dsh-prompt-gate: unrecognized projection state; the fold restarts from the log')
    }
    return value
  },
}

/**
 * Pure fold over the committed Session log: where the reviewable human messages
 * are, which of this plugin's results settled after them, and how many turns ran.
 *
 * @param state - state covering every earlier event.
 * @param event - the next committed event.
 * @returns The next state, or the same reference for an event this unit ignores.
 */
function foldReviewState(state, event) {
  if (event.type === 'user/message') {
    if (event.data?.source?.kind !== 'user') return state
    return {
      ...state,
      firstHuman: state.firstHuman < 0 ? event.seq : state.firstHuman,
      lastHuman: event.seq,
    }
  }
  if (event.type === 'turn/start') return { ...state, turns: state.turns + 1 }
  if (event.type === 'tool/result') {
    const meta = event.data?.meta
    if (meta === null || typeof meta !== 'object' || meta.tool !== RESULT_MARK) return state
    if (meta.outcome !== 'confirmed' && meta.outcome !== 'skipped') return state
    return { ...state, settled: event.seq }
  }
  return state
}

/** The projection definition registered under {@link PROJECTION_KEY}. */
const reviewProjection = {
  key: PROJECTION_KEY,
  stateVersion: PROJECTION_STATE_VERSION,
  stateSchema: reviewStateSchema,
  init: () => ({ firstHuman: -1, lastHuman: -1, settled: -1, turns: 0 }),
  apply: foldReviewState,
}

/**
 * Register the review: one projection, one prompt section, one conditional
 * tool, and one per-agent guard.
 *
 * @param ctx - plugin context.
 * @param config - raw row config.
 */
export async function apply(ctx, config) {
  const settings = resolveConfig(config)
  /** Session → anchor seq whose review the turn-end valve waived (process-local). */
  const waived = new WeakMap()
  /** Per-agent guard disposers, released when this plugin unloads. */
  const guardDisposers = new Map()

  // Await the fold before publishing anything that reads it: the section, the
  // tool's admission check, and every guard are consumers of this handle.
  const review = await ctx.sessionProjections.register(reviewProjection)

  ctx.effect(() => () => {
    for (const dispose of guardDisposers.values()) {
      try {
        dispose()
      } catch {
        // The owning Agent is already gone; nothing left to release.
      }
    }
    guardDisposers.clear()
  }, 'dsh-prompt-gate: agent registrations')

  /** The human message this scope reviews: the first ever, or the newest one. */
  const anchorOf = (state) => {
    if (state === undefined || state.lastHuman < 0) return -1
    return settings.scope === 'every' ? state.lastHuman : state.firstHuman
  }

  /**
   * Whether a review is outstanding for this Session right now. Derived from the
   * log alone, so a restart, resume, or reload re-derives the same answer.
   */
  const reviewOpen = (session) => {
    if (session === undefined) return false
    if (!isEligibleHeader(session.header)) return false
    if (!settings.enabled) return false
    if (ctx.get('userQuestions') === undefined) return false
    const state = review.stateOf(session)
    const anchor = anchorOf(state)
    if (anchor < 0) return false
    // `scope: first` reviews the opening message only, so a session that already
    // ran a turn is past it — this keeps installing the plugin from retroactively
    // reviewing old conversations.
    if (settings.scope === 'first' && state.turns > 1) return false
    if (state.settled >= anchor) return false
    return waived.get(session) !== anchor
  }

  let sectionOrder = 500
  try {
    sectionOrder = ctx.systemPrompt.getSectionOrder('PLAN_POLICY')
  } catch {
    // An older or renamed placement table keeps the documented neighborhood.
  }
  ctx.systemPrompt.section({
    name: 'dsh-prompt-gate:first-message',
    order: sectionOrder,
    text: (context) => (reviewOpen(context?.agent?.session) ? sectionText(settings) : ''),
  })

  /** Install the per-agent guard once; executing tools stay denied while a review is open. */
  const installGuard = (agent) => {
    if (guardDisposers.has(agent)) return
    const session = agent.session
    const dispose = agent.ctx.effect(() => agent.ctx.tools.guard((exec) => {
      if (exec.agent?.session !== session) return undefined
      if (!reviewOpen(session)) return undefined
      return UNGATED_TOOLS.has(exec.name) ? undefined : GATE_DENIAL
    }), 'dsh-prompt-gate: review guard')
    guardDisposers.set(agent, dispose)
  }

  // Live Agents created before this generation of the plugin need a guard too,
  // so a reload cannot leave an open review unenforced.
  for (const agent of ctx.agents.list()) {
    if (isEligible(agent.session, settings)) installGuard(agent)
  }

  ctx.on('agent/created', ({ agent }) => {
    if (isEligible(agent.session, settings)) installGuard(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = guardDisposers.get(agent)
    if (dispose === undefined) return
    guardDisposers.delete(agent)
    try {
      dispose()
    } catch {
      // The Agent's own teardown already released the guard.
    }
  })

  // A turn that closes while its review is still open means the model answered
  // in prose instead of following the protocol. Waive that one review so the
  // session is not stranded without its tools; a later message re-opens it,
  // because the anchor moves with the message under `scope: every`.
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const session = agent.session
    if (!reviewOpen(session)) return
    waived.set(session, anchorOf(review.stateOf(session)))
  })

  const definition = {
    name: TOOL_NAME,
    description: 'Present the rewritten user message as a task brief and wait for the user\'s decision. '
      + 'Call it before any other tool while prompt review is active. Returns whether the user confirmed '
      + 'the brief, asked for changes, or skipped the review.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['review', 'pass'],
          description: 'Defaults to "review". Use "pass" only when the original message is already a complete instruction.',
        },
        prompt: {
          type: 'string',
          description: 'The rewritten brief as markdown, in the user\'s language. Required for mode "review"; '
            + 'ignored for "pass".',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: { type: 'string', enum: ['confirmed', 'revise', 'skipped'] },
          prompt: { type: 'string' },
          feedback: { type: 'string' },
        },
        required: ['outcome'],
      },
      // Durable identity of this review: the fold reads it back from the
      // committed `tool/result`, so the gate closes without any plugin memory.
      presentationMeta: (_args, value) => ({
        tool: RESULT_MARK,
        outcome: typeof value?.outcome === 'string' ? value.outcome : 'unknown',
      }),
      render: (_args, value) => {
        if (value.outcome === 'confirmed') {
          const note = value.feedback === undefined
            ? ''
            : `\n\nThe user added this note while approving it:\n${value.feedback}`
          const lifetime = settings.scope === 'every' ? 'this turn' : 'the rest of the session'
          return [{
            type: 'text',
            text: `The user approved this brief. It is the authoritative instruction for ${lifetime}; `
              + `carry it out now.\n\n${value.prompt ?? ''}${note}`,
          }]
        }
        if (value.outcome === 'revise') {
          const feedback = value.feedback === undefined || value.feedback.trim() === ''
            ? 'No explicit feedback was given; tighten the brief and make its definition of done concrete.'
            : `The user's feedback:\n${value.feedback}`
          return [{
            type: 'text',
            text: `The user asked for changes before approving.\n\n${feedback}\n\n`
              + 'Revise the brief and call review_prompt again.',
          }]
        }
        return [{
          type: 'text',
          text: 'No review is pending. Carry out the user\'s original message as written.',
        }]
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Prompt review',
      kind: 'other',
      content: typeof args?.prompt === 'string' && args.prompt.trim() !== ''
        ? [{ type: 'text', text: args.prompt }]
        : [],
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'Prompt review',
      content: result.content,
    }),
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${TOOL_NAME} needs a live agent`)
      const session = agent.session
      if (!reviewOpen(session)) {
        throw new Error(`${TOOL_NAME} is not available: this session has no outstanding prompt review.`)
      }
      const mode = args?.mode === 'pass' ? 'pass' : 'review'
      if (mode === 'pass') {
        if (settings.forceReview) {
          throw new Error('This deployment requires the review: rewrite the message and call '
            + `${TOOL_NAME} with mode="review".`)
        }
        return { outcome: 'skipped' }
      }
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new Error('mode "review" requires the rewritten brief in `prompt`.')
      const questions = ctx.get('userQuestions')
      // The gate admits this tool only where a review channel exists, so a
      // missing service here means the channel went away mid-review: fail open.
      if (questions === undefined) return { outcome: 'skipped' }
      // Bound the wait so a closed browser or a stalled answerer cannot pin the
      // turn forever. A caller abort keeps its own failure; anything else —
      // timeout, dismissal, unavailable card — means the user declined to review.
      const signal = waitSignal(exec.signal, settings.timeoutMs)
      let answer
      try {
        answer = await questions.ask({
          questions: [{
            id: QUESTION_ID,
            header: settings.header,
            question: settings.question,
            detail: prompt,
            // The host's question card treats a choice and a written answer as
            // mutually exclusive: choosing clears the text and typing clears the
            // choice. So the card offers decisions only, and text is the change
            // request — asking for a choice *and* a comment loses one of them.
            options: [
              { label: settings.approve, description: settings.approveHint },
              { label: settings.skip, description: settings.skipHint },
            ],
          }],
          agent,
          signal,
        })
      } catch (error) {
        if (exec.signal?.aborted === true) throw error
        return { outcome: 'skipped' }
      }
      const item = Array.isArray(answer?.answers)
        ? answer.answers.find(entry => entry?.id === QUESTION_ID)
        : undefined
      const selected = Array.isArray(item?.selected) ? item.selected : []
      const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
      if (selected.includes(settings.skip)) return { outcome: 'skipped' }
      if (selected.includes(settings.approve)) return { outcome: 'confirmed', prompt }
      if (custom !== '') return { outcome: 'revise', feedback: custom }
      // The card refuses an empty submission, so this is only reachable through
      // a client that answers with neither a choice nor text.
      return { outcome: 'revise' }
    },
  }

  ctx.tools.register(definition, {
    when: ({ agent }) => reviewOpen(agent?.session),
  })
}

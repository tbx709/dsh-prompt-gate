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
const PROJECTION_STATE_VERSION = 2
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

/**
 * Card copy per language. The plugin picks one from the message it is reviewing,
 * so a Chinese message gets a Chinese card and an English message an English one,
 * with no locale service and no configuration.
 */
const COPY = {
  zh: {
    header: '提示词审阅',
    question: '确认后我就按它执行。想改哪里，直接在下面的输入框写修改意见再提交；不想强化就选「用原文执行」。',
    approve: '确认，开始执行',
    approveHint: '按这份提示词开始干活。',
    skip: '用原文执行',
    skipHint: '不要强化，直接按我原来的消息做。',
  },
  en: {
    header: 'Prompt review',
    question: 'Approve to work from this brief. To change it, type the change in the box below instead; '
      + 'to skip the rewrite, choose "Use the original".',
    approve: 'Approve and start',
    approveHint: 'Work from this brief.',
    skip: 'Use the original',
    skipHint: 'Skip the rewrite; run my message as written.',
  },
}

/** Copy keys a deployment may override; an override applies to every language. */
const COPY_KEYS = ['header', 'question', 'approve', 'approveHint', 'skip', 'skipHint']

/** Steering phrases a `scope: every` review passes over: they steer, they do not ask. */
const DEFAULT_EXEMPT_PHRASES = ['继续', '接着', '好的', '好', '行', '可以', '停', '不用了', '嗯', 'ok', 'go', 'continue']

const DEFAULT_CONFIG = {
  enabled: true,
  scope: 'first',
  forceReview: false,
  timeoutMs: 900_000,
  section: '',
  language: 'auto',
  exemptPhrases: DEFAULT_EXEMPT_PHRASES,
}

/** CJK ranges that make a message read as Chinese without any locale service. */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/gu

/**
 * Guess which language the card should speak, from the message under review.
 * Chinese messages routinely carry English identifiers, so a handful of CJK
 * characters outweighs a lot of Latin text.
 *
 * @param text - the anchor message, as folded from the session log.
 * @returns `zh` or `en`; empty text keeps the historical Chinese default.
 */
function detectLanguage(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') return 'zh'
  const cjk = trimmed.match(CJK_CHAR)?.length ?? 0
  if (cjk === 0) return 'en'
  const latin = trimmed.match(/[A-Za-z]/g)?.length ?? 0
  return cjk >= 2 && cjk * 3 >= latin ? 'zh' : 'en'
}

/** The text of one session event's message, ignoring non-text blocks. */
function messageText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : data?.message?.content
  if (Array.isArray(blocks)) {
    return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n')
  }
  return typeof data?.text === 'string' ? data.text : ''
}

/** Longest message text the fold keeps; card copy and exemptions never need more. */
const TEXT_LIMIT = 280

/** Trim a message to what the fold stores. */
function clipText(text) {
  return text.length <= TEXT_LIMIT ? text : text.slice(0, TEXT_LIMIT)
}

/** The card copy for one language, with the deployment's overrides applied. */
function copyFor(settings, language) {
  return { ...COPY[language === 'en' ? 'en' : 'zh'], ...settings.copy }
}

/** Drop spacing and trailing punctuation so `继续。` and `继续` are the same phrase. */
function normalizePhrase(text) {
  return text.trim().toLowerCase().replace(/[\s。.!！?？,，、~]+/gu, '')
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
  const known = new Set([...Object.keys(DEFAULT_CONFIG), ...COPY_KEYS])
  const unknown = Object.keys(raw).filter(key => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(`dsh-prompt-gate: unknown config key(s) ${unknown.join(', ')}`)
  }
  const resolved = { ...DEFAULT_CONFIG }
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const value = raw[key]
    if (value === undefined) continue
    if (Array.isArray(fallback)) {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`dsh-prompt-gate: config "${key}" must be an array of strings`)
      }
      resolved[key] = value
      continue
    }
    if (typeof value !== typeof fallback) {
      throw new Error(`dsh-prompt-gate: config "${key}" must be a ${typeof fallback}`)
    }
    if (typeof value === 'string' && key !== 'section' && value.trim() === '') {
      throw new Error(`dsh-prompt-gate: config "${key}" must not be blank`)
    }
    resolved[key] = value
  }
  if (resolved.language !== 'auto' && resolved.language !== 'zh' && resolved.language !== 'en') {
    throw new Error('dsh-prompt-gate: language must be "auto", "zh" or "en"')
  }
  const copy = {}
  for (const key of COPY_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new Error(`dsh-prompt-gate: config "${key}" must be a string`)
    }
    if (value.trim() === '') {
      throw new Error(`dsh-prompt-gate: config "${key}" must not be blank`)
    }
    copy[key] = value
  }
  // Every language has to stay clickable: a duplicate pair collapses the card's
  // two decisions into one, and a recommendation suffix biases the user's answer.
  for (const language of ['zh', 'en']) {
    const labels = copyFor({ copy }, language)
    if (labels.approve === labels.skip) {
      throw new Error('dsh-prompt-gate: the approve and skip labels must differ')
    }
    if (/\(Recommended\)|（推荐）/u.test(labels.approve)) {
      throw new Error('dsh-prompt-gate: the approve label must not carry a recommendation suffix')
    }
  }
  if (resolved.scope !== 'first' && resolved.scope !== 'every') {
    throw new Error('dsh-prompt-gate: scope must be "first" (new sessions only) or "every" (every message)')
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs < 0 || resolved.timeoutMs > 2_147_483_647) {
    throw new Error('dsh-prompt-gate: timeoutMs must be an integer from 0 (no timeout) to 2147483647')
  }
  return { ...resolved, copy }
}

/** The brief headings, in the language the card speaks. */
const BRIEF_HEADINGS = {
  zh: [
    '   - **任务** — the goal in one sentence.',
    '   - **上下文** — facts from the message, the working directory, and known tools or skills; never invent them.',
    '   - **范围与约束** — what to change, what not to touch, rules to follow.',
    '   - **交付物与验收** — what is delivered and how completion is verified.',
    '   - **建议步骤** — which tools or skills to start with, and the first concrete action.',
  ],
  en: [
    '   - **Task** — the goal in one sentence.',
    '   - **Context** — facts from the message, the working directory, and known tools or skills; never invent them.',
    '   - **Scope and constraints** — what to change, what not to touch, rules to follow.',
    '   - **Deliverable and acceptance** — what is delivered and how completion is verified.',
    '   - **Suggested steps** — which tools or skills to start with, and the first concrete action.',
  ],
}

/**
 * Build the model-facing protocol section rendered while a review is open.
 *
 * @param config - resolved plugin config carrying the user's extra guidance.
 * @param language - the language the card will speak, so the headings match it.
 * @returns The section markdown.
 */
function sectionText(config, language) {
  const extra = config.section.trim()
  const every = config.scope === 'every'
  const lifetime = every ? 'this turn' : 'the rest of the session'
  const headings = BRIEF_HEADINGS[language === 'en' ? 'en' : 'zh']
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
    ...headings,
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
  const counters = ['firstHuman', 'lastHuman', 'settled', 'turns'].every(
    key => Number.isSafeInteger(value[key]) && value[key] >= -1,
  )
  return counters && typeof value.firstText === 'string' && typeof value.lastText === 'string'
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
    const text = clipText(messageText(event.data))
    return {
      ...state,
      firstHuman: state.firstHuman < 0 ? event.seq : state.firstHuman,
      lastHuman: event.seq,
      firstText: state.firstHuman < 0 ? text : state.firstText,
      lastText: text,
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
  init: () => ({ firstHuman: -1, lastHuman: -1, settled: -1, turns: 0, firstText: '', lastText: '' }),
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

  /** The text of the message this scope reviews, folded from the same log. */
  const anchorTextOf = (state) => {
    if (state === undefined) return ''
    return settings.scope === 'every' ? state.lastText : state.firstText
  }

  /** Steering phrases never open a review under `scope: every`. */
  const exemptPhrases = new Set(settings.exemptPhrases.map(normalizePhrase).filter(phrase => phrase !== ''))

  /**
   * The language the card and the brief headings speak: the deployment's
   * choice, or what the reviewed message looks like.
   */
  const languageOf = (session) => {
    if (settings.language !== 'auto') return settings.language
    return detectLanguage(anchorTextOf(review.stateOf(session)))
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
    // "继续" is a nudge, not a request: reviewing it would charge the user a card
    // for every turn of an ordinary back-and-forth.
    if (settings.scope === 'every' && exemptPhrases.size > 0
      && exemptPhrases.has(normalizePhrase(anchorTextOf(state)))) return false
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
    text: (context) => {
      const session = context?.agent?.session
      return reviewOpen(session) ? sectionText(settings, languageOf(session)) : ''
    },
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
          reason: {
            type: 'string',
            enum: ['pass'],
            description: 'Set when the model reported the message as already complete, so the result can say so '
              + 'instead of looking like a review the user dismissed.',
          },
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
        if (value.reason === 'pass') {
          return [{
            type: 'text',
            text: 'No review was needed: the message is already a complete instruction, so nothing was '
              + 'rewritten. Carry it out as written.',
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
        return { outcome: 'skipped', reason: 'pass' }
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
      // The card speaks the language of the message it is reviewing; a deployment
      // that pinned `language` overrides that choice.
      const copy = copyFor(settings, languageOf(session))
      let answer
      try {
        answer = await questions.ask({
          questions: [{
            id: QUESTION_ID,
            header: copy.header,
            question: copy.question,
            detail: prompt,
            // The host's question card treats a choice and a written answer as
            // mutually exclusive: choosing clears the text and typing clears the
            // choice. So the card offers decisions only, and text is the change
            // request — asking for a choice *and* a comment loses one of them.
            options: [
              { label: copy.approve, description: copy.approveHint },
              { label: copy.skip, description: copy.skipHint },
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
      if (selected.includes(copy.skip)) return { outcome: 'skipped' }
      if (selected.includes(copy.approve)) return { outcome: 'confirmed', prompt }
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

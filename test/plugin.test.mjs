/**
 * Smoke test for the dsh-prompt-gate plugin logic without a real Host.
 *
 * Drives `apply` against a fake Cordis context whose projection registry,
 * prompt section, tool registry, guards, and user-questions channel are all
 * instrumented, then asserts the gate derivation and the tool's outcomes.
 *
 * Run: node test/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { apply, resolveConfig } from '../index.js'

// --- fake host -------------------------------------------------------------

function makeSession({ header = {}, events = [] } = {}) {
  return {
    header: { isSeeded: false, ...header },
    events,
    seq: events.length,
    append(type, data, meta) {
      this.events.push({ type, seq: this.events.length, time: 1, data, ...meta })
      this.seq = this.events.length
      return { seq: this.events.length - 1 }
    },
  }
}

function makeHost({ config, agents = [], userQuestions } = {}) {
  // `userQuestions: null` models a deployment with no review channel.
  const channel = userQuestions === undefined ? { ask: async () => ({ answers: [] }) } : userQuestions
  const host = {
    sections: [],
    tools: [],
    guards: [],
    listeners: [],
    registration: undefined,
    agents,
    userQuestions: channel,
    effects: [],
  }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      host.effects.push(dispose)
      return dispose
    },
    on(event, fn) {
      host.listeners.push({ event, fn })
      return () => {}
    },
    get(name) {
      if (name === 'userQuestions') return host.userQuestions ?? undefined
      return undefined
    },
    systemPrompt: {
      getSectionOrder: () => 500,
      section(definition) {
        host.sections.push(definition)
        return () => {}
      },
    },
    sessionProjections: {
      async register(definition) {
        host.registration = definition
        return {
          stateOf(session) {
            let state = definition.init(session.header, 0)
            for (const event of session.events) state = definition.apply(state, event)
            return state
          },
          async dispose() {},
        }
      },
    },
    agents: { list: () => host.agents },
    tools: {
      register(definition, options) {
        host.tools.push({ definition, options })
        return () => {}
      },
    },
  }
  return { ctx, host }
}

function makeAgent(session) {
  const guards = []
  const agent = {
    session,
    status: 'idle',
    ctx: {
      effect(fn) {
        const dispose = fn()
        return dispose
      },
      tools: {
        guard(fn) {
          guards.push(fn)
          return () => {}
        },
      },
    },
  }
  agent.guards = guards
  return agent
}

async function start({ config, agents = [], userQuestions } = {}) {
  const { ctx, host } = makeHost({ config, agents, userQuestions })
  await apply(ctx, config)
  const section = host.sections[0]
  const tool = host.tools[0]
  const stateOf = host.registration
  return { host, section, tool, stateOf }
}

const sectionTextOf = (host, agent) => host.sections[0].text({ agent })

// --- scenarios -------------------------------------------------------------

{
  // A fresh session with one human message reviews it; tools stay denied.
  const session = makeSession()
  session.append('user/message', { role: 'user', source: { kind: 'user' } })
  session.append('turn/start', { turn: 1 })
  const agent = makeAgent(session)
  const { host, tool, stateOf } = await start({ agents: [agent] })

  assert.equal(agent.guards.length, 1, 'guard installed for the live agent')
  assert.equal(tool.options.when({ agent }), true, 'review_prompt admitted')
  assert.match(sectionTextOf(host, agent), /第一次|first message|no turns yet/i)
  const deny = agent.guards[0]({ agent, name: 'bash' })
  assert.ok(typeof deny === 'string' && deny.length > 0, 'bash denied while review is open')
  assert.equal(agent.guards[0]({ agent, name: 'read' }), undefined, 'read allowed')
  assert.equal(agent.guards[0]({ agent, name: 'review_prompt' }), undefined, 'the review tool allowed')

  // A confirmed result closes it and unlocks everything.
  session.append('tool/result', {
    turn: 1, step: 1, message: { role: 'tool' },
    meta: { tool: 'dsh-prompt-gate', outcome: 'confirmed' },
  })
  assert.equal(tool.options.when({ agent }), false, 'tool withdrawn after confirmation')
  assert.equal(agent.guards[0]({ agent, name: 'bash' }), undefined, 'bash unlocked')
  assert.equal(sectionTextOf(host, agent), '', 'section withdrawn')
}

{
  // scope=every re-opens the gate for each new human message.
  const session = makeSession()
  session.append('user/message', { role: 'user', source: { kind: 'user' } })
  session.append('turn/start', { turn: 1 })
  const agent = makeAgent(session)
  const { tool } = await start({ config: { scope: 'every' }, agents: [agent] })
  assert.equal(tool.options.when({ agent }), true, 'first message reviewed')

  session.append('tool/result', { turn: 1, step: 1, message: {}, meta: { tool: 'dsh-prompt-gate', outcome: 'skipped' } })
  assert.equal(tool.options.when({ agent }), false, 'closed for this turn')

  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('user/message', { role: 'user', source: { kind: 'user' } })
  session.append('turn/start', { turn: 2 })
  assert.equal(tool.options.when({ agent }), true, 'second message reviewed under every')

  // Injected context is not a human message.
  session.append('tool/result', { turn: 2, step: 1, message: {}, meta: { tool: 'dsh-prompt-gate', outcome: 'confirmed' } })
  session.append('user/message', { role: 'user', source: { kind: 'plan-mode' } })
  assert.equal(tool.options.when({ agent }), false, 'injected context does not open a review')
}

{
  // scope=first never retroactively reviews an older conversation.
  const session = makeSession()
  for (let turn = 1; turn <= 3; turn++) {
    session.append('user/message', { role: 'user', source: { kind: 'user' } })
    session.append('turn/start', { turn })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const agent = makeAgent(session)
  const { tool, host } = await start({ agents: [agent] })
  assert.equal(tool.options.when({ agent }), false, 'old session is not gated')
  assert.equal(sectionTextOf(host, agent), '')
}

{
  // Ineligible sessions never get a guard.
  const cases = [
    { origin: 'subagent' },
    { delegationDepth: 2 },
    { isSeeded: true },
  ]
  for (const header of cases) {
    const session = makeSession({ header })
    session.append('user/message', { role: 'user', source: { kind: 'user' } })
    const agent = makeAgent(session)
    const { tool } = await start({ agents: [agent] })
    assert.equal(agent.guards.length, 0, `no guard for ${JSON.stringify(header)}`)
    assert.equal(tool.options.when({ agent }), false)
  }
}

{
  // The turn-end valve waives exactly one outstanding review.
  const session = makeSession()
  session.append('user/message', { role: 'user', source: { kind: 'user' } })
  const agent = makeAgent(session)
  const { host, tool } = await start({ config: { scope: 'every' }, agents: [agent] })
  assert.equal(tool.options.when({ agent }), true)
  for (const listener of host.listeners.filter(entry => entry.event === 'agent/turn-stopping')) {
    listener.fn({ agent, turn: 1 })
  }
  assert.equal(tool.options.when({ agent }), false, 'stale review waived')
  session.append('user/message', { role: 'user', source: { kind: 'user' } })
  assert.equal(tool.options.when({ agent }), true, 'next message opens a fresh review')
}

// --- tool execution --------------------------------------------------------

async function runTool({ config, answers, ask, text }) {
  const session = makeSession()
  session.append('user/message', {
    role: 'user',
    source: { kind: 'user' },
    ...text === undefined ? {} : { content: [{ type: 'text', text }] },
  })
  const agent = makeAgent(session)
  const userQuestions = {
    ask: ask ?? (async () => ({ answers })),
  }
  const result = await start({ config, agents: [agent], userQuestions })
  const execute = result.host.tools[0].definition.execute
  const exec = { agent, signal: new AbortController().signal, callId: 'call-1' }
  return { execute, exec, session, result }
}

{
  const confirmed = await runTool({
    answers: [{ id: 'prompt-review', selected: ['确认，开始执行'] }],
  })
  const value = await confirmed.execute({ mode: 'review', prompt: '## 任务\n做事' }, confirmed.exec)
  assert.deepEqual(value, { outcome: 'confirmed', prompt: '## 任务\n做事' })
  assert.equal(
    confirmed.result.host.tools[0].definition.output.presentationMeta({}, value).outcome,
    'confirmed',
    'meta carries the durable outcome',
  )
}

{
  // Writing into the card's answer field is the change request: the host card
  // clears the choice when text is typed, so text arrives without a selection.
  const revise = await runTool({
    answers: [{ id: 'prompt-review', selected: [], custom: '加上验收命令' }],
  })
  const value = await revise.execute({ mode: 'review', prompt: '草稿' }, revise.exec)
  assert.deepEqual(value, { outcome: 'revise', feedback: '加上验收命令' })
}

{
  // The card offers decisions only — a third "revise" option would fight the
  // card's single-answer model and swallow the typed comment.
  let captured
  const card = await runTool({
    ask: async (request) => {
      captured = request
      return { answers: [{ id: 'prompt-review', selected: [], custom: '改一下' }] }
    },
  })
  await card.execute({ mode: 'review', prompt: '草稿' }, card.exec)
  const question = captured.questions[0]
  assert.deepEqual(question.options.map(option => option.label), ['确认，开始执行', '用原文执行'])
  assert.match(question.question, /输入框/, 'the question must point at the answer field')
  assert.equal(question.id, 'prompt-review')
}

{
  const skip = await runTool({ answers: [{ id: 'prompt-review', selected: ['用原文执行'] }] })
  assert.deepEqual(await skip.execute({ mode: 'review', prompt: '草稿' }, skip.exec), { outcome: 'skipped' })
}

{
  // A pass is a decision the user never saw, so the result says so out loud.
  const pass = await runTool({ answers: [] })
  const value = await pass.execute({ mode: 'pass' }, pass.exec)
  assert.deepEqual(value, { outcome: 'skipped', reason: 'pass' })
  const rendered = pass.result.host.tools[0].definition.output.render({}, value)[0].text
  assert.match(rendered, /No review was needed/, 'the pass explains itself in the transcript')
  assert.equal(
    pass.result.host.tools[0].definition.output.presentationMeta({}, value).outcome,
    'skipped',
    'a pass still closes the gate',
  )
}

{
  // The card follows the language of the message it reviews.
  let captured
  const english = await runTool({
    text: 'make the login page nicer',
    ask: async (request) => {
      captured = request
      return { answers: [{ id: 'prompt-review', selected: ['Approve and start'] }] }
    },
  })
  const value = await english.execute({ mode: 'review', prompt: '## Task\nDo it.' }, english.exec)
  assert.deepEqual(value, { outcome: 'confirmed', prompt: '## Task\nDo it.' })
  const question = captured.questions[0]
  assert.deepEqual(question.options.map(option => option.label), ['Approve and start', 'Use the original'])
  assert.match(question.question, /box below/, 'the English card points at the answer field')
  const section = english.result.host.sections[0].text({ agent: english.exec.agent })
  assert.match(section, /\*\*Task\*\*/, 'the brief headings match the card language')

  // A Chinese message keeps the Chinese card, even with English identifiers in it.
  const chinese = await runTool({
    text: '把 login.tsx 的按钮改成圆角',
    ask: async (request) => {
      captured = request
      return { answers: [] }
    },
  })
  await chinese.execute({ mode: 'review', prompt: '草稿' }, chinese.exec)
  assert.deepEqual(captured.questions[0].options.map(option => option.label), ['确认，开始执行', '用原文执行'])
  assert.match(
    chinese.result.host.sections[0].text({ agent: chinese.exec.agent }),
    /\*\*任务\*\*/,
    'Chinese message, Chinese headings',
  )
}

{
  // scope=every skips steering phrases and still reviews a real request.
  const steer = makeSession()
  steer.append('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续。' }] })
  const agent = makeAgent(steer)
  const { tool } = await start({ config: { scope: 'every' }, agents: [agent] })
  assert.equal(tool.options.when({ agent }), false, 'a nudge does not open a review')

  steer.append('tool/result', { turn: 1, step: 1, message: {}, meta: { tool: 'dsh-prompt-gate', outcome: 'skipped' } })
  steer.append('user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '继续，但按钮也要改' }],
  })
  assert.equal(tool.options.when({ agent }), true, 'a nudge carrying work still reviews')

  const custom = makeSession()
  custom.append('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '好的' }] })
  const customAgent = makeAgent(custom)
  const configured = await start({ config: { scope: 'every', exemptPhrases: ['收到'] }, agents: [customAgent] })
  assert.equal(configured.tool.options.when({ agent: customAgent }), true, 'an overridden list replaces the default')
}

{
  // A dismissed card fails open instead of stranding the turn.
  const dismissed = await runTool({
    ask: async () => { throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' }) },
  })
  assert.deepEqual(await dismissed.execute({ mode: 'review', prompt: '草稿' }, dismissed.exec), { outcome: 'skipped' })
}

{
  // A silent channel times out: timeoutMs bounds the wait. The timer is a
  // real interval because AbortSignal.timeout in Node is unref'd and would not
  // fire in a bare test process that has nothing else keeping the loop alive.
  const keepAlive = setInterval(() => {}, 20)
  const started = Date.now()
  let observedAbort = false
  const timed = await runTool({
    config: { timeoutMs: 30 },
    ask: request => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        observedAbort = true
        reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' }))
      })
    }),
  })
  const value = await timed.execute({ mode: 'review', prompt: '草稿' }, timed.exec)
  assert.deepEqual(value, { outcome: 'skipped' })
  assert.equal(observedAbort, true, 'the wait carried a timeout signal')
  assert.ok(Date.now() - started < 5000, 'timed out promptly')
  clearInterval(keepAlive)
}

{
  // forceReview refuses the silent pass, and an empty brief is rejected.
  const forced = await runTool({ config: { forceReview: true }, answers: [] })
  await assert.rejects(() => forced.execute({ mode: 'pass' }, forced.exec), /requires the review/)
  const empty = await runTool({ answers: [] })
  await assert.rejects(() => empty.execute({ mode: 'review', prompt: '   ' }, empty.exec), /requires the rewritten brief/)
}

// --- config ----------------------------------------------------------------

assert.throws(() => resolveConfig({ scope: 'daily' }), /scope must be/)
assert.throws(() => resolveConfig({ language: 'fr' }), /language must be/)
assert.throws(() => resolveConfig({ exemptPhrases: '继续' }), /array of strings/)
assert.throws(() => resolveConfig({ exemptPhrases: [1] }), /array of strings/)
assert.throws(() => resolveConfig({ approve: '一样', skip: '一样' }), /must differ/)
assert.equal(resolveConfig({ header: 'Review' }).copy.header, 'Review')
assert.throws(() => resolveConfig({ timeoutMs: -1 }), /timeoutMs must be/)
assert.throws(() => resolveConfig({ revise: '继续修改' }), /no longer exists/)
assert.equal(resolveConfig({}).timeoutMs, 900_000)

console.log('dsh-prompt-gate: all fake-host assertions passed')

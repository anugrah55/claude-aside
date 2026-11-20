import type { ModelForkResult, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { AsideJob } from '../types'

const PANE = {
  plugin: 'aside',
  component: 'Pane',
  requestId: 'aside',
  props: {
    title: 'Aside',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const ENGINE = { plugin: 'engine', tier: 'core' } as const

/** What a spawn asked for. The kit hands the hook the Agent tool's input, the engine its own. */
type Spawn = { subagentType: string; prompt: string }

function spawnOf(e: unknown): Spawn {
  const input = e as { subagentType?: string; subagent_type?: string; prompt?: string }

  return { subagentType: input.subagentType ?? input.subagent_type ?? '', prompt: input.prompt ?? '' }
}

/** What else the mocked session answers, and what it records. */
type More = {
  selection?: string
  fork?: { isAnswered: true; text: string } | { isAnswered: false; reason: 'nothing-to-fork' | 'empty-reply' }
  forked?: string[]
  copied?: string[]
  filled?: string[]
}

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/** The session beneath the mod: each hook answers as the engine would. */
function world(on: On, spawned: Spawn[], clipboard = { hasImage: false }, placed: string[] = [], more: More = {}) {
  mock.env(on, { HOME: '/Users/test' })
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'aside' } }))
  on('agent.register', () => ({ value: { agent: 'aside:helper' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.place', (_, e) => {
    placed.push(e.id)

    return { value: { isPlaced: true, requestId: `row-${e.id}` } }
  })
  on('fs.exists', (_, e) => ({ value: e.path === '/Users/test/Desktop/shot.png' }))
  on('session.messages', () => ({ value: [] }))
  on('session.machine', () => ({
    value: { sysname: 'Darwin', release: '25.0.0', machine: 'arm64', packageManagers: [], runtimes: [] },
  }))
  on('process.run', (_, e) => {
    const [program] = e.argv
    const ran = (exitCode: number, stdout = '') => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (program === 'sh' && e.argv.join(' ').includes('mktemp')) {
      return ran(0, '/tmp/aside-test\n')
    }
    if (program === 'osascript') {
      return ran(clipboard.hasImage ? 0 : 1)
    }

    return ran(0)
  })
  on('ui.selection', () => ({ value: more.selection === undefined ? undefined : { text: more.selection } }))
  on('model.fork', (_, e) => {
    more.forked?.push(e.prompt)
    const answer = more.fork ?? { isAnswered: true as const, text: 'instant answer' }
    const value: ModelForkResult = answer.isAnswered
      ? { isAnswered: true, text: answer.text, usage: NO_USAGE }
      : answer.reason === 'nothing-to-fork'
        ? { isAnswered: false, reason: 'nothing-to-fork' }
        : { isAnswered: false, reason: 'empty-reply', usage: NO_USAGE }

    return { value }
  })
  on('ui.copy', (_, e) => {
    more.copied?.push(e.text)

    return { value: { isCopied: true } }
  })
  on('prompt.fill', (_, e) => {
    more.filled?.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  // The kit drops an agent id a test hook answers (only core sets one), so a
  // spawn here starts nothing the mod can follow: what it asked for is the check.
  on('agent.spawn', (_, e) => {
    spawned.push(spawnOf(e))

    return { model: 'test-model' }
  })

  return clock
}

/** The mod's state, seeded and kept here in place of the kit's, with versions. */
function seed(on: On, values: Record<string, unknown>) {
  const kept = new Map<string, { value: unknown; version: number }>()
  for (const [key, value] of Object.entries(values)) {
    kept.set(key, { value, version: 1 })
  }
  on('state.get', (_, e) => ({ value: kept.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const version = kept.get(e.key)?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) {
      return { value: { isSet: false, version } }
    }
    kept.set(e.key, { value: e.value, version: version + 1 })

    return { value: { isSet: true, version: version + 1 } }
  })
}

const RUNNING: AsideJob = {
  id: 'q1',
  question: 'what does this button do? ~/Desktop/shot.png',
  images: [{ path: '/Users/test/Desktop/shot.png', label: 'shot.png' }],
  status: 'thinking',
  agentId: 'agent-1',
  via: 'fork',
  askedAt: 1_000,
}

test('a question with an image path asks for a fork that sees the image; a failed start shows why', async ($, on) => {
  const spawned: Spawn[] = []
  world(on, spawned)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({ command: 'aside', args: 'what does this button do? ~/Desktop/shot.png', ...TYPED })
  expect(ran.text).toBeUndefined()
  expect(spawned[0]?.subagentType).toBe('fork')
  expect(spawned[0]?.prompt).toContain('/Users/test/Desktop/shot.png')
  expect(spawned[0]?.prompt).toContain('what does this button do?')
  // No fork followed, so the fresh helper was asked, with the same image.
  expect(spawned[1]?.subagentType).toBe('aside:helper')
  expect(spawned[1]?.prompt).toContain('/Users/test/Desktop/shot.png')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Could not start a side agent/ })).toBeDefined()
  await ui.unmount()
})

test('a side agent reads but writes nothing, and its answer fills the pane, not the main chat', async ($, on) => {
  const placed: string[] = []
  world(on, [], { hasImage: false }, placed)
  seed(on, {
    jobs: { shape: 'jobs-1', value: [RUNNING] },
    agents: ['agent-1'],
    allowed: ['/Users/test/Desktop/shot.png'],
  })
  on('tool.call', () => ({ result: 'done' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const looked = await $.tool.call({ tool: 'Read', file_path: '/Users/test/Desktop/shot.png', agentId: 'agent-1' })
  expect(JSON.stringify(looked)).not.toContain('read-only')
  const wrote = await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'x', agentId: 'agent-1' })
  expect(JSON.stringify(wrote)).toContain('read-only')
  const main = await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'x' })
  expect(JSON.stringify(main)).not.toContain('read-only')
  const unsafe = await $.tool.call({ tool: 'Bash', command: 'npm --version | tee v.txt', agentId: 'agent-1' })
  expect(JSON.stringify(unsafe)).toContain('refused')
  const chained = await $.tool.call({ tool: 'Bash', command: 'ls && rm -rf build', agentId: 'agent-1' })
  expect(JSON.stringify(chained)).toContain('refused')
  const fetched = await $.tool.call({ tool: 'WebFetch', url: 'https://example.com/?q=secret', prompt: 'x', agentId: 'agent-1' })
  expect(JSON.stringify(fetched)).toContain('not available')
  const mainShell = await $.tool.call({ tool: 'Bash', command: 'npm test > out.txt' })
  expect(JSON.stringify(mainShell)).not.toContain('refused')

  const report = await $.agent.report({
    agentId: 'agent-1',
    subagentType: 'fork',
    provider: ENGINE,
    status: 'completed',
    text: 'It **saves** the draft.',
  })
  expect(report.consumed).toBeDefined()
  // The answer is also placed as a display-only row at the transcript's end.
  expect(placed).toEqual(['q1'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'aside', component: 'Placed', requestId: 'row-q1', surface, props: { id: 'q1', plugin: 'aside' } })
    expect((await row.find({ type: 'Markdown' }))?.props.text).toBe('It **saves** the draft.')
    expect(await row.find({ type: 'Text', text: /not part of the main chat/ })).toBeDefined()
    await row.unmount()
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /what does this button do/ }))?.text).toContain('shot.png')
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('It **saves** the draft.')
    expect(await ui.find({ text: /Thinking/ })).toBeUndefined()
    await ui.unmount()
  }
})

test("another agent's report and turn are left alone", async ($, on) => {
  world(on, [])
  seed(on, { jobs: { shape: 'jobs-1', value: [RUNNING] }, agents: ['agent-1'], allowed: [] })
  on('agent.report', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const report = await $.agent.report({
    agentId: 'someone-else',
    subagentType: 'Explore',
    provider: ENGINE,
    status: 'completed',
    text: 'found it',
  })
  expect(report.text).toBe('found it')

  await $.turn.complete({
    answer: 'The token check runs twice.',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('The token check runs twice.')
  await ui.unmount()
})

test('a follow-up typed in the pane replays the earlier side answers', async ($, on) => {
  const spawned: Spawn[] = []
  world(on, spawned)
  const done: AsideJob = { ...RUNNING, status: 'done', answer: 'It saves the draft.', doneAt: 2_000 }
  seed(on, { jobs: { shape: 'jobs-1', value: [done] }, agents: ['agent-1'], allowed: [] })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'ask', text: 'and where is that code?' })
  await ui.unmount()

  expect(spawned[0]?.subagentType).toBe('fork')
  expect(spawned[0]?.prompt).toContain('It saves the draft.')
  expect(spawned[0]?.prompt).toContain('and where is that code?')
})

test('a pasted image that never arrives: the question starts after a short wait, with a note', async ($, on) => {
  const spawned: Spawn[] = []
  const clock = world(on, spawned)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'aside', args: 'what is wrong here? [Image #1]', ...TYPED })
  expect(spawned).toHaveLength(0)
  await clock.advance(3_000)
  expect(spawned[0]?.subagentType).toBe('fork')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /did not reach the side question/ })).toBeDefined()
  await ui.unmount()
})

test('the command record keeps neither the question nor the image', async ($, on) => {
  const session = mock.session(on)
  world(on, [])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  await $.session.append({
    door: 'command',
    origin: { kind: 'composer' },
    uuid: 'row-1',
    message: {
      type: 'user',
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<command-name>/aside</command-name>\n<command-message>aside</command-message>\n<command-args>is my API key leaking? [Image #1]</command-args>',
        },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      ],
    },
  })
  await $.session.append({
    door: 'command',
    origin: { kind: 'composer' },
    uuid: 'row-2',
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'text', text: '<command-name>/model</command-name>\n<command-args>opus</command-args>' }],
    },
  })

  const [aside, other] = session.appended().slice(-2)
  const kept = JSON.stringify(aside?.message.content)
  expect(kept).not.toContain('API key')
  expect(kept).not.toContain('"image"')
  expect(kept).toContain('Aside pane')
  expect(JSON.stringify(other?.message.content)).toContain('opus')
})

test('/aside clear empties the side chat', async ($, on) => {
  world(on, [])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'aside', args: 'first question', ...TYPED })

  const cleared = await $.command.run({ command: 'aside', args: 'clear', ...TYPED })
  expect(cleared.text).toContain('cleared')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /first question/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Ask a side question/ })).toBeDefined()
  await ui.unmount()
})

test('a pasted image whose row comes after the command reaches the question, and the row is scrubbed', async ($, on) => {
  const session = mock.session(on)
  const spawned: Spawn[] = []
  const clock = world(on, spawned)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'aside', args: 'what is wrong in [Image #1]?', ...TYPED })
  expect(spawned).toHaveLength(0)
  await $.session.append({
    door: 'note',
    origin: { kind: 'engine' },
    uuid: 'row-img',
    message: {
      type: 'user',
      role: 'user',
      isMeta: true,
      content: [{ type: 'text', text: '[Image: source: /Users/test/Desktop/shot.png]' }],
    },
  })
  await clock.advance(10)

  expect(spawned[0]?.subagentType).toBe('fork')
  expect(spawned[0]?.prompt).toContain('/Users/test/Desktop/shot.png')
  expect(spawned[0]?.prompt).toContain('[pasted image 1: /Users/test/Desktop/shot.png]')
  const stored = JSON.stringify(session.appended().find(row => row.uuid === 'row-img')?.message.content)
  expect(stored).not.toContain('shot.png')
  expect(stored).toContain('/aside side question')

  // While another side question waits for its paste, a prompt the person sent
  // with only an image is theirs: neither taken nor scrubbed.
  await $.command.run({ command: 'aside', args: 'and this one? [Image #2]', ...TYPED })
  await $.session.append({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'row-prompt',
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }],
    },
  })
  expect(JSON.stringify(session.appended().find(row => row.uuid === 'row-prompt')?.message.content)).toContain('"image"')
})

test('a reload fails the jobs it interrupted, and leaves running agents alone', async ($, on) => {
  world(on, [])
  const stuck: AsideJob = { id: 'q0', question: 'old [Image #1]', images: [], status: 'waiting', askedAt: 500 }
  seed(on, { jobs: { shape: 'jobs-1', value: [stuck, RUNNING] }, agents: ['agent-1'], allowed: [] })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Interrupted by a reload/ })).toBeDefined()
  // The running agent's question still shows its progress ("Thinking").
  expect(await ui.find({ text: /Thinking/ })).toBeDefined()
  await ui.unmount()
})

test('with no image row (Claude busy), the clipboard image is used and labelled as such', async ($, on) => {
  const spawned: Spawn[] = []
  const clock = world(on, spawned, { hasImage: true })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'aside', args: 'why does this look broken? [Image #1]', ...TYPED })
  await clock.advance(2_000)

  expect(spawned[0]?.subagentType).toBe('fork')
  expect(spawned[0]?.prompt).toMatch(/\/tmp\/aside-test\/clipboard-.+\.png/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /read from the clipboard/ }))?.text).toContain('pasted image 1')
  expect(await ui.find({ type: 'Text', text: /did not reach/ })).toBeUndefined()
  await ui.unmount()
})

test("another plugin's transcript rows are drawn by that plugin, not this one", async ($, on) => {
  world(on, [])
  seed(on, { jobs: { shape: 'jobs-1', value: [RUNNING] }, agents: [], allowed: [] })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>someone else's row</Text>
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const row = await $.ui.mount({ plugin: 'aside', component: 'Placed', requestId: 'r', surface: 'terminal', props: { id: 'q1', plugin: 'other' } })
  expect((await row.find({ type: 'Text' }))?.text).toBe("someone else's row")
  await row.unmount()
})

test('/aside -q answers instantly from the conversation, the /btw way, with no agent', async ($, on) => {
  const spawned: Spawn[] = []
  const forked: string[] = []
  const clock = world(on, spawned, { hasImage: false }, [], { forked, fork: { isAnswered: true, text: 'The codeword is **PELICAN**.' } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({ command: 'aside', args: '-q what was the codeword?', ...TYPED })
  expect(ran.text).toBeUndefined()
  await clock.advance(10)

  expect(spawned).toHaveLength(0)
  expect(forked[0]).toContain('what was the codeword?')
  expect(forked[0]).toContain('no tools')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('The codeword is **PELICAN**.')
    expect(await ui.find({ type: 'Text', text: /⚡ instant/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an instant answer can be copied, sent to the main prompt, or dug into by the full agent', async ($, on) => {
  const spawned: Spawn[] = []
  const copied: string[] = []
  const filled: string[] = []
  const clock = world(on, spawned, { hasImage: false }, [], { copied, filled, fork: { isAnswered: true, text: 'Probably the cart total.' } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'aside', args: '-q why is checkout NaN?', ...TYPED })
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const copy = await ui.find({ type: 'Button', text: /Copy/ })
  const id = String(copy?.key).replace(/^copy-/, '')
  await ui.press({ key: `copy-${id}` })
  expect(copied).toEqual(['Probably the cart total.'])
  await ui.press({ key: `main-${id}` })
  expect(filled[0]).toContain('why is checkout NaN?')
  expect(filled[0]).toContain('> Probably the cart total.')
  await ui.press({ key: `deeper-${id}` })
  await ui.unmount()

  expect(spawned[0]?.subagentType).toBe('fork')
  expect(spawned[0]?.prompt).toContain('why is checkout NaN?')
})

test('with nothing to fork yet, an instant question goes to the agent instead', async ($, on) => {
  const spawned: Spawn[] = []
  const clock = world(on, spawned, { hasImage: false }, [], { fork: { isAnswered: false, reason: 'nothing-to-fork' } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'aside', args: '--quick what is this project?', ...TYPED })
  await clock.advance(10)

  expect(spawned[0]?.subagentType).toBe('fork')
  expect(spawned[0]?.prompt).toContain('what is this project?')
})

test('an instant question with a picture goes to the agent, which can see it', async ($, on) => {
  const spawned: Spawn[] = []
  const forked: string[] = []
  world(on, spawned, { hasImage: false }, [], { forked })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'aside', args: '-q what is this? ~/Desktop/shot.png', ...TYPED })

  expect(forked).toHaveLength(0)
  expect(spawned[0]?.prompt).toContain('/Users/test/Desktop/shot.png')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Pictures need the full side agent/ })).toBeDefined()
  await ui.unmount()
})

test('text selected in the transcript rides along as what "this" means', async ($, on) => {
  const spawned: Spawn[] = []
  world(on, spawned, { hasImage: false }, [], { selection: "TypeError: Cannot read properties of undefined (reading 'qty')" })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'aside', args: 'what does this error mean?', ...TYPED })

  expect(spawned[0]?.prompt).toContain('<selection>')
  expect(spawned[0]?.prompt).toContain("reading 'qty'")
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /about your selection/ })).toBeDefined()
  await ui.unmount()
})

test('/aside help lists what it can do', async ($, on) => {
  world(on, [])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const help = await $.command.run({ command: 'aside', args: 'help', ...TYPED })
  expect(help.text).toContain('/aside -q')
  expect(help.isTextDisplayOnly).toBe(true)
})

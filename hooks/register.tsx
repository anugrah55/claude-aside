// aside: a /btw-style side question that also takes images.
//
// `/aside <question>` runs at once, even while Claude is busy. The question goes
// to a read-only fork of the main conversation (or, where no fork can be made,
// to a fresh read-only helper), which looks at any images with Read and answers
// in the Aside pane. Nothing of it enters the main conversation: the command's
// record is scrubbed, the pasted image's row is scrubbed, the report is taken.
//
// Where an image comes from:
// - a path in the question (typed, or dropped as text);
// - a paste (`[Image #N]`) while Claude is idle: the engine appends the image's
//   source as a row right after the command, which is caught here;
// - a paste while Claude is busy: that row only comes with the next prompt, so
//   the clipboard is read instead (what Ctrl+V just pasted), labelled as such.

import { atom, read, update } from 'claude-code'
import type { AgentSpawnArgs, EngineInterface, PromptSubmitAttachment, Register, RenderSurface } from 'claude-code'

import type { AsideImage, AsideJob } from '../types'
import {
  baseName,
  buildForkPrompt,
  buildHelperPrompt,
  buildQuickPrompt,
  elapsed,
  type Exchange,
  extFor,
  findImagePaths,
  formatForMain,
  HELP_TEXT,
  HELPER_SYSTEM,
  isSafeShell,
  parseAsk,
  pastedRefs,
  resolvePath,
  shorten,
} from './lib'

type Engine = EngineInterface
type AsideSurface = RenderSurface

const PANE = 'aside'
const HELPER = 'aside:helper'
/** How long a question naming a pasted image waits for the engine's image row before reading the clipboard. */
const PASTE_WAIT_MS = 1200
/** How long a pasted image's late row is still taken as this mod's (and scrubbed). */
const LATE_ROW_MS = 30 * 60_000
/** The longest a headless `claude -p "/aside ..."` waits for its answer. */
const HEADLESS_WAIT_MS = 5 * 60_000
/** Side questions kept in the pane, and earlier ones replayed to a new one. */
const KEEP = 30
const HISTORY = 6

// Change the tag when AsideJob's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'aside', key: 'jobs' } as const, [], { shape: 'jobs-1' })
const agents = atom({ plugin: 'aside', key: 'agents' } as const, [])
const allowed = atom({ plugin: 'aside', key: 'allowed' } as const, [])

/**
 * The only tools a side agent may call. No web access: a fork holds the whole
 * conversation, and an image could carry text asking it to send that out.
 * Bash passes only commands isSafeShell vouches for, and tool.check also
 * refuses any call Claude Code can't confirm only reads.
 */
const SIDE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Bash', 'ToolSearch', 'LSP', 'SubagentHandback'])
/** Tools tool.check leaves to the session's own decision (the hand-back carries the answer). */
const CHECK_EXEMPT = new Set(['SubagentHandback', 'ToolSearch'])

const COMMAND_TAG = /<command-name>\/?aside<\/command-name>/
const COMMAND_ARGS = /<command-args>[\s\S]*?<\/command-args>/
const SCRUBBED_ARGS = '<command-args>(a side question, answered in the Aside pane outside this conversation)</command-args>'
const IMAGE_ROW = /^\s*\[Image: source: (.+?)\]\s*$/
const SCRUBBED_IMAGE = '[an image attached to an /aside side question; not part of this conversation]'

const EMPTY_TEXT =
  'Ask a side question with /aside <question>, or /aside -q <question> for an instant answer. Paste a screenshot with Ctrl+V, or put an image path in the question. It runs beside the main chat without interrupting it, and nothing here enters that chat.'

const VIA_LABEL: Record<NonNullable<AsideJob['via']>, string> = {
  quick: '⚡ instant',
  fork: 'side agent',
  helper: 'fresh helper',
}

// The module's own values start over at a reload; session.start sets them again.
let cwd = ''
let home: string | undefined
let isInteractive = true
let sysname = ''
let stagingDir: string | undefined
let seq = 0
/** The file ASIDE_DEBUG_FILE names, when set: a trace for reporting a problem. */
let debugFile: string | undefined
/** Pasted images saved by prompt.submit before their command ran, by the command's text. */
const early = new Map<string, AsideImage[]>()
/** Jobs whose agent is being started, so a timer and a paste never start one twice. */
const starting = new Set<string>()
/** Jobs waiting for their pasted image's row, oldest first. */
const pasteWaiters: string[] = []
/** When a job last stopped waiting for its pasted image's row, by job id: its late row is scrubbed. */
const pasteClosedAt = new Map<string, number>()
// State reads within one dispatch all read one moment, so a dispatch that waits
// (a headless /aside) never sees another hook's write. These maps are the
// module's own memory, shared by every dispatch until a reload; state stays
// the record the pane draws from and what survives a reload.
/** Which job each side agent answers, by agent id. */
const jobOfAgent = new Map<string, string>()
/** Jobs settled since the last reload, by job id. */
const settled = new Map<string, AsideJob>()
/** Jobs being settled now, so a report and a turn's end never settle one twice. */
const settling = new Set<string>()

async function debug($: Engine, line: string): Promise<void> {
  if (debugFile === undefined) {
    return
  }
  try {
    const before = await $.fs.read(debugFile).catch(() => '')
    await $.fs.write(debugFile, `${before}${new Date(await $.clock.now()).toISOString()} ${line}\n`)
  } catch {
    // A trace never breaks the mod.
  }
}

async function newId($: Engine): Promise<string> {
  seq += 1

  return `q${(await $.clock.now()).toString(36)}${seq}`
}

async function setJob($: Engine, id: string, change: (job: AsideJob) => AsideJob): Promise<void> {
  await update($, jobs, list => list.map(job => (job.id === id ? change(job) : job)))
}

async function refreshStatus($: Engine): Promise<void> {
  const list = await read($, jobs)
  const running = list.filter(job => job.status === 'thinking' || job.status === 'waiting').length
  // The engine heads the line with the plugin's name.
  $.ui.status(running === 0 ? undefined : `${running} side question${running === 1 ? '' : 's'} thinking…`)
}

async function openPane($: Engine): Promise<void> {
  try {
    await $.ui.open({ id: PANE, title: 'Aside', columns: 60 })
  } catch {
    // Refused (another plugin holds the id, no surface): the answers still land in state.
  }
}

async function stagingFolder($: Engine): Promise<string> {
  if (stagingDir !== undefined) {
    return stagingDir
  }
  const made = await $.process.run(['sh', '-c', 'd="${TMPDIR:-/tmp}"; mktemp -d "${d%/}/claude-aside.XXXXXX"'])
  const dir = made.stdout.trim()
  if (made.exitCode !== 0 || dir === '') {
    throw new Error(`no folder for pasted images: ${made.stderr.trim()}`)
  }
  stagingDir = dir

  return dir
}

/** Writes base64 image bytes to a file a side agent can Read. */
async function stageBase64($: Engine, base64: string, mediaType: string | undefined, label: string): Promise<AsideImage | undefined> {
  const path = `${await stagingFolder($)}/pasted-${await newId($)}.${extFor(mediaType)}`
  const wrote = await $.process.run(['sh', '-c', 'base64 -d > "$1"', 'sh', path], { stdin: base64 })

  return wrote.exitCode === 0 ? { path, label } : undefined
}

/** Saves one pasted image of the submission in flight (where a host raises prompt.submit for the command). */
async function saveSubmitted($: Engine, attachment: PromptSubmitAttachment, n: number): Promise<AsideImage | undefined> {
  if (attachment.type !== 'image' || attachment.id === undefined) {
    return undefined
  }
  let base64 = ''
  let mediaType = attachment.mediaType
  let offset: number | undefined
  for (let slices = 0; slices < 64; slices += 1) {
    const slice = await $.prompt.media(offset === undefined ? { id: attachment.id } : { id: attachment.id, offset })
    if (slice.deny !== undefined || slice.unreadable !== undefined) {
      await debug($, `prompt.media refused: ${slice.deny ?? slice.unreadable}`)

      return undefined
    }
    base64 += slice.base64
    mediaType = slice.mediaType
    if (slice.next === undefined) {
      break
    }
    offset = slice.next
  }

  return stageBase64($, base64, mediaType, `pasted image ${n}`)
}

/** The image on the clipboard, saved to a file: what a Ctrl+V while Claude was busy pasted. */
async function clipboardImage($: Engine, n: number): Promise<AsideImage | undefined> {
  try {
    const path = `${await stagingFolder($)}/clipboard-${await newId($)}.png`
    const argv =
      sysname === 'Darwin'
        ? [
            'osascript',
            '-e',
            'on run argv',
            '-e',
            'set png to (the clipboard as «class PNGf»)',
            '-e',
            'set f to open for access (POSIX file (item 1 of argv)) with write permission',
            '-e',
            'set eof f to 0',
            '-e',
            'write png to f',
            '-e',
            'close access f',
            '-e',
            'end run',
            path,
          ]
        : sysname === 'Linux'
          ? [
              'sh',
              '-c',
              'if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-paste >/dev/null 2>&1; then wl-paste --type image/png > "$1"; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -t image/png -o > "$1"; else exit 1; fi; [ -s "$1" ]',
              'sh',
              path,
            ]
          : undefined
    if (argv === undefined) {
      return undefined
    }
    const read = await $.process.run(argv, { timeoutMs: 10_000 })
    await debug($, `clipboard read exit=${read.exitCode}`)

    return read.exitCode === 0 ? { path, label: `pasted image ${n} (read from the clipboard)` } : undefined
  } catch (error) {
    await debug($, `clipboard read failed: ${error instanceof Error ? error.message : String(error)}`)

    return undefined
  }
}

async function spawnSafe($: Engine, args: AgentSpawnArgs): Promise<{ agentId?: string; deny?: string }> {
  try {
    const spawned = await $.agent.spawn(args)
    if (spawned.deny !== undefined) {
      return { deny: spawned.deny }
    }

    return spawned.agentId === undefined ? { deny: 'no agent id came back' } : { agentId: spawned.agentId }
  } catch (error) {
    return { deny: error instanceof Error ? error.message : String(error) }
  }
}

/** The recent part of the main conversation, for a helper that is not a fork. */
async function recentConversation($: Engine): Promise<string> {
  try {
    const rows = await $.session.messages({ last: 60 })
    if (!Array.isArray(rows)) {
      return ''
    }
    const text = rows
      .filter(row => row.text.trim() !== '')
      .map(row => `${row.role === 'user' ? 'Person' : 'Claude'}: ${row.text.trim().slice(0, 2000)}`)
      .join('\n\n')

    return text.length > 16_000 ? `…${text.slice(-16_000)}` : text
  } catch {
    return ''
  }
}

function hasPasted(job: AsideJob): boolean {
  return job.images.some(image => image.label.startsWith('pasted image'))
}

/** Starts the side agent for a job; a failure on the way marks the job failed rather than leaving it spinning. */
async function start($: Engine, id: string): Promise<void> {
  if (starting.has(id)) {
    return
  }
  starting.add(id)
  try {
    await startAgent($, id)
  } catch (error) {
    await debug($, `start ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
    try {
      const doneAt = await $.clock.now()
      await setJob($, id, one =>
        one.agentId === undefined ? { ...one, status: 'failed', error: 'The side question could not be started.', doneAt } : one,
      )
      await refreshStatus($)
    } catch {
      // Nothing more to do: the pane keeps what it last had.
    }
  } finally {
    starting.delete(id)
  }
}

/** The work of start: a fork of the main conversation, else a fresh helper. */
async function startAgent($: Engine, id: string): Promise<void> {
  const list = await read($, jobs)
  const job = list.find(one => one.id === id)
  if (job === undefined || job.agentId !== undefined || (job.status !== 'waiting' && job.status !== 'thinking')) {
    return
  }
  await debug($, `start ${id} images=${JSON.stringify(job.images.map(image => image.path))}`)

  const note =
    pastedRefs(job.question).length > 0 && !hasPasted(job)
      ? 'The pasted image did not reach the side question. Copy it to the clipboard and paste it again, or put the image file path in the question.'
      : undefined
  await setJob($, id, one => ({ ...one, status: 'thinking', ...(note === undefined ? {} : { note }) }))
  await refreshStatus($)

  if (job.images.length > 0) {
    const paths = job.images.map(image => image.path)
    await update($, allowed, known => [...new Set([...known, ...paths])].slice(-200))
  }

  const history = historyOf(list, id)
  const description = `aside: ${shorten(job.question, 40)}`

  let via: 'fork' | 'helper' = 'fork'
  let spawned = await spawnSafe($, {
    subagentType: 'fork',
    prompt: buildForkPrompt(job.question, job.images, history, job.selection),
    description,
  })
  if (spawned.agentId === undefined) {
    via = 'helper'
    const digest = await recentConversation($)
    spawned = await spawnSafe($, {
      subagentType: HELPER,
      prompt: buildHelperPrompt(job.question, job.images, history, digest, job.selection),
      description,
    })
  }

  const agentId = spawned.agentId
  if (agentId === undefined) {
    const doneAt = await $.clock.now()
    await setJob($, id, one => ({
      ...one,
      status: 'failed',
      error: `Could not start a side agent: ${spawned.deny ?? 'no reason given'}`,
      doneAt,
    }))
    await refreshStatus($)

    return
  }
  jobOfAgent.set(agentId, id)
  await update($, agents, known => [...known, agentId].slice(-100))
  await setJob($, id, one => ({ ...one, agentId, via }))
}

/** The earlier answered side questions a new one sees, newest last. */
function historyOf(list: readonly AsideJob[], id: string): Exchange[] {
  return list
    .filter(one => one.id !== id && one.status === 'done' && one.answer !== undefined)
    .slice(-HISTORY)
    .map(one => ({ question: one.question, answer: one.answer ?? '' }))
}

/**
 * The instant path, the /btw way: one tool-less reply over the conversation as
 * the main thread last sent it, served from its prompt cache. No effort level is
 * named (a different one would write the whole conversation to the cache again):
 * the prompt asks for haste instead. Nothing to fork yet: the agent answers.
 */
async function startQuick($: Engine, id: string): Promise<void> {
  if (starting.has(id)) {
    return
  }
  starting.add(id)
  let isHandedOn = false
  try {
    const list = await read($, jobs)
    const job = list.find(one => one.id === id)
    if (job === undefined || job.status !== 'thinking') {
      return
    }
    await setJob($, id, one => ({ ...one, via: 'quick' }))
    const result = await $.model.fork({ prompt: buildQuickPrompt(job.question, historyOf(list, id), job.selection) })
    if (!result.isAnswered && result.reason === 'nothing-to-fork') {
      await setJob($, id, one => ({
        ...one,
        mode: 'deep',
        via: 'fork',
        note: 'Nothing to answer from yet in this session, so the full side agent took it.',
      }))
      isHandedOn = true
    } else if (result.isAnswered) {
      await settle($, id, result.text, false)
    } else {
      await settle($, id, '', true, `The instant answer failed (${result.reason}). Ask again, or press Dig deeper.`)
    }
  } catch (error) {
    await settle($, id, '', true, `The instant answer failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    starting.delete(id)
  }
  if (isHandedOn) {
    await start($, id)
  }
}

async function copyAnswer($: Engine, job: AsideJob, surface: AsideSurface): Promise<void> {
  try {
    const copied = await $.ui.copy({ text: job.answer ?? '', surface })
    $.ui.toast(copied.isCopied ? 'Copied the side answer.' : `Could not copy it: ${copied.reason}`)
  } catch {
    $.ui.toast('Could not copy it.')
  }
}

/** Puts the side Q&A in the prompt box as a quote: handing it to the main session is the person's choice. */
async function sendToMain($: Engine, job: AsideJob): Promise<void> {
  try {
    const filled = await $.prompt.fill({ text: formatForMain(job.question, job.answer ?? ''), mode: 'insert' })
    $.ui.toast(
      filled.isFilled
        ? 'The side answer is in your prompt. Add what to do with it, then send.'
        : 'The prompt box could not take it right now.',
    )
  } catch {
    $.ui.toast('The prompt box could not take it right now.')
  }
}

/** " · ⚡ instant · 3s": what answered and how fast, for a settled job. */
function metaOf(job: AsideJob): string {
  const parts = [
    job.via === undefined ? undefined : VIA_LABEL[job.via],
    job.doneAt === undefined ? undefined : elapsed(job.askedAt, job.doneAt),
  ].filter((part): part is string => part !== undefined)

  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`
}

/** Sends a quick question on to the full side agent: tools, code and all. */
async function digDeeper($: Engine, job: AsideJob): Promise<void> {
  await ask($, job.question, { mode: 'deep', ...(job.selection === undefined ? {} : { selection: job.selection }) })
}

async function addImages($: Engine, id: string, images: readonly AsideImage[]): Promise<void> {
  if (images.length > 0) {
    await setJob($, id, job => ({ ...job, images: [...job.images, ...images] }))
  }
}

/**
 * Stops a job waiting for its pasted image's row; true when it was still waiting.
 * `isRowLate`: the row did not come, so a late one is expected and scrubbed.
 */
async function closePaste($: Engine, id: string, isRowLate = false): Promise<boolean> {
  const at = pasteWaiters.indexOf(id)
  if (at < 0) {
    return false
  }
  pasteWaiters.splice(at, 1)
  if (isRowLate) {
    pasteClosedAt.set(id, await $.clock.now())
  }

  return true
}

/** No image row came in time (Claude was busy): take the clipboard's image, then start. */
async function pasteTimedOut($: Engine, id: string): Promise<void> {
  if (!(await closePaste($, id, true))) {
    return
  }
  const job = (await read($, jobs)).find(one => one.id === id)
  const n = pastedRefs(job?.question ?? '')[0] ?? 1
  const image = await clipboardImage($, n)
  if (image !== undefined) {
    await addImages($, id, [image])
  }
  await start($, id)
}

type AskOptions = { mode?: 'deep' | 'quick'; selection?: string }

/** Records a question and starts its side agent (or the instant fork), or waits briefly for its pasted image. */
async function ask($: Engine, typed: string, options: AskOptions = {}): Promise<AsideJob> {
  const question = typed.trim()
  const images: AsideImage[] = [...(early.get(question) ?? [])]
  early.delete(question)

  for (const found of findImagePaths(question)) {
    const path = resolvePath(found.path, home, cwd)
    if (images.some(image => image.path === path)) {
      continue
    }
    const isThere = await $.fs.exists(path).catch(() => false)
    if (isThere) {
      images.push({ path, label: baseName(path) })
    }
  }

  const isWaiting = pastedRefs(question).length > 0 && !images.some(image => image.label.startsWith('pasted image'))
  // The instant path sees no pictures: a question with one goes to the agent.
  const isQuick = options.mode === 'quick' && images.length === 0 && !isWaiting
  const note =
    options.mode === 'quick' && !isQuick
      ? 'Pictures need the full side agent, so this question went to it instead of the instant path.'
      : undefined
  const job: AsideJob = {
    id: await newId($),
    question,
    images,
    status: isWaiting ? 'waiting' : 'thinking',
    mode: isQuick ? 'quick' : 'deep',
    askedAt: await $.clock.now(),
    ...(options.selection === undefined || options.selection.trim() === '' ? {} : { selection: options.selection.slice(0, 4000) }),
    ...(note === undefined ? {} : { note }),
  }
  await update($, jobs, list => [...list, job].slice(-KEEP))
  await refreshStatus($)

  if (isWaiting) {
    pasteWaiters.push(job.id)
    $.clock.after(PASTE_WAIT_MS, () => {
      void pasteTimedOut($, job.id)
    })
  } else if (isQuick) {
    // In a dispatch of its own, so the command returns at once.
    $.clock.after(1, () => {
      void startQuick($, job.id)
    })
  } else {
    await start($, job.id)
  }

  return job
}

async function lastWords($: Engine, agentId: string): Promise<string> {
  try {
    const rows = await $.session.messages({ agentId, last: 10 })
    if (!Array.isArray(rows)) {
      return ''
    }

    return [...rows].reverse().find(row => row.role === 'assistant' && row.text.trim() !== '')?.text.trim() ?? ''
  } catch {
    return ''
  }
}

/** Settles the job a side agent answers, from its report or its turn's end. */
async function finish($: Engine, agentId: string, text: string, hasFailed: boolean): Promise<void> {
  const list = await read($, jobs)
  const id = list.find(one => one.agentId === agentId)?.id ?? jobOfAgent.get(agentId)
  if (id === undefined || settled.has(id)) {
    return
  }
  const answer = text.trim() !== '' ? text.trim() : await lastWords($, agentId)
  await settle($, id, answer, hasFailed)
}

/** Settles a job once, whichever path answered it: state, the pane, the transcript row, a toast. */
async function settle($: Engine, id: string, text: string, hasFailed: boolean, failure?: string): Promise<void> {
  if (settled.has(id) || settling.has(id)) {
    return
  }
  settling.add(id)
  try {
    const job = (await read($, jobs)).find(one => one.id === id)
    if (job !== undefined && (job.status === 'done' || job.status === 'failed')) {
      return
    }
    const answer = text.trim()
    const doneAt = await $.clock.now()
    const outcome: Pick<AsideJob, 'status' | 'answer' | 'error' | 'doneAt'> =
      hasFailed || answer === ''
        ? {
            status: 'failed',
            error:
              failure ??
              (answer === '' ? 'The side agent ended without an answer.' : 'The side agent stopped before it finished.'),
            ...(answer === '' ? {} : { answer }),
            doneAt,
          }
        : { status: 'done', answer, doneAt }
    const question = job?.question ?? 'side question'
    settled.set(id, { id, question, images: job?.images ?? [], askedAt: job?.askedAt ?? doneAt, ...outcome })
    await setJob($, id, one => ({ ...one, ...outcome }))
    await refreshStatus($)
    await announce($, id, question)
  } finally {
    settling.delete(id)
  }
}

async function announce($: Engine, id: string, question: string): Promise<void> {
  // The answer also lands as a display-only row at the transcript's end (the
  // model never reads it): the dock may be showing another pane, such as the
  // engine's own agents panel, which a running fork brings up.
  if (isInteractive) {
    try {
      await $.ui.place({ id })
    } catch {
      // No surface draws rows: the pane still holds the answer.
    }
  }
  try {
    $.ui.toast(`answered: ${shorten(question, 60)}`)
    await $.ui.scroll({ to: { key: id }, in: PANE, block: 'start' })
  } catch {
    // The pane may be closed: the answer waits in it for /aside.
  }
}

/** Whether an agent is one of this mod's side agents. */
async function isSide($: Engine, agentId: string | undefined, origin?: string): Promise<boolean> {
  if (agentId === undefined) {
    return false
  }
  if (jobOfAgent.has(agentId) || origin === 'aside') {
    return true
  }

  return (await read($, agents)).includes(agentId)
}

/** Waits for a job in a headless run: a `$` call's wait costs the hook no budget, a clock sleep would. */
async function waitFor($: Engine, id: string): Promise<AsideJob | undefined> {
  const startedAt = await $.clock.now()
  for (;;) {
    const done = settled.get(id)
    if (done !== undefined) {
      return done
    }
    if ((await $.clock.now()) - startedAt > HEADLESS_WAIT_MS) {
      return (await read($, jobs)).find(one => one.id === id)
    }
    await $.process.run(['sleep', '1']).catch(() => undefined)
  }
}

/** The images a row holds when it is nothing but pasted images: sources named in text, and inline bytes. */
function imagesOfRow(content: readonly { type: string; [field: string]: unknown }[]): {
  paths: string[]
  inline: { base64: string; mediaType: string | undefined }[]
} | undefined {
  const paths: string[] = []
  const inline: { base64: string; mediaType: string | undefined }[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const match = IMAGE_ROW.exec(block.text)
      if (match?.[1] !== undefined) {
        paths.push(match[1])
      } else if (block.text.trim() !== '') {
        return undefined
      }
    } else if (block.type === 'image') {
      const source = block.source as { type?: unknown; data?: unknown; media_type?: unknown } | undefined
      if (source?.type === 'base64' && typeof source.data === 'string') {
        inline.push({ base64: source.data, mediaType: typeof source.media_type === 'string' ? source.media_type : undefined })
      }
    } else {
      return undefined
    }
  }

  return paths.length + inline.length === 0 ? undefined : { paths, inline }
}

/** Takes one expected late image row, oldest first: true when there was one to take. */
async function takeLateRow($: Engine): Promise<boolean> {
  const now = await $.clock.now()
  for (const [id, at] of pasteClosedAt) {
    if (now - at > LATE_ROW_MS) {
      pasteClosedAt.delete(id)
    }
  }
  const oldest = pasteClosedAt.keys().next()
  if (oldest.done === true) {
    return false
  }
  pasteClosedAt.delete(oldest.value)

  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    isInteractive = e.isInteractive
    home = await $.env.get('HOME').catch(() => undefined)
    debugFile = (await $.env.get('ASIDE_DEBUG_FILE').catch(() => undefined)) || undefined
    sysname = (await $.session.machine().catch(() => undefined))?.sysname ?? ''

    // A reload drops the module's timers and memory: a job left waiting for its
    // paste, or never started, would spin forever. Agents already running keep going.
    try {
      const doneAt = await $.clock.now()
      await update($, jobs, list =>
        list.map(
          (job): AsideJob =>
            (job.status === 'waiting' || job.status === 'thinking') && job.agentId === undefined
              ? { ...job, status: 'failed', error: 'Interrupted by a reload of the aside mod. Ask again.', doneAt }
              : job,
        ),
      )
    } catch {
      // The pane shows what it has.
    }

    await $.command.register({
      name: 'aside',
      description:
        'Side question that sees the chat, your code and images (paste a screenshot or add its path); -q for instant. Never touches the main chat',
      argumentHint: '[-q] <question>  (paste an image, or add an image path) · help',
      immediate: true,
    })
    try {
      await $.agent.register({
        name: 'helper',
        description: 'Answers one side question for the /aside command, read-only. Not for general use.',
        prompt: HELPER_SYSTEM,
        tools: ['Read', 'Glob', 'Grep', 'Bash'],
      })
    } catch {
      // The fork works without it; the helper is only the fallback.
    }

    return next(e)
  })

  // The helper is this mod's own; the main model never sees it offered.
  on('agent.offer', { agent: 'aside:helper' }, () => ({ isOffered: false }))

  on('command.run', { command: 'aside' }, async ($, e) => {
    const args = e.args.trim()
    await debug($, `command.run args=${JSON.stringify(args)}`)
    if (args === 'help' || args === '--help' || args === '-h') {
      return { text: HELP_TEXT, isTextDisplayOnly: true }
    }
    if (args === 'clear') {
      await update($, jobs, () => [])
      await refreshStatus($)

      return { text: 'Aside: side chat cleared.', isTextDisplayOnly: true }
    }
    const { question, mode } = parseAsk(args)
    if (question === '' || question === 'open') {
      await openPane($)

      return {}
    }

    if (isInteractive) {
      // Text selected in the transcript is what "this" in the question may mean.
      const selected = await $.ui.selection().catch(() => undefined)
      await openPane($)
      await ask($, question, { mode, ...(selected === undefined ? {} : { selection: selected.text }) })

      return {}
    }

    // Headless (`claude -p "/aside ..."`): wait, and answer as the command's output.
    const job = await ask($, question, { mode })
    const outcome = await waitFor($, job.id)
    if (outcome?.status === 'done') {
      return { text: outcome.answer ?? '', isTextDisplayOnly: true }
    }

    return {
      text:
        outcome?.status === 'failed'
          ? (outcome.error ?? 'The side question failed.')
          : outcome === undefined
            ? 'The side question was cleared.'
            : 'No answer in time.',
      isTextDisplayOnly: true,
      exitCode: 1,
    }
  })

  // Where a host raises prompt.submit for the command, its pasted images ride it.
  on('prompt.submit', async ($, e, next) => {
    const command = e.command
    const attachments = e.attachments ?? []
    if (command?.name !== 'aside' || !attachments.some(item => item.type === 'image')) {
      return next(e)
    }
    const refs = pastedRefs(command.args)
    const images: AsideImage[] = []
    let count = 0
    for (const attachment of attachments) {
      if (attachment.type !== 'image') {
        continue
      }
      const saved = await saveSubmitted($, attachment, refs[count] ?? count + 1).catch(() => undefined)
      count += 1
      if (saved !== undefined) {
        images.push(saved)
      }
    }
    if (images.length === 0) {
      // Nothing read here: the image row or the clipboard may still bring it.
      return next(e)
    }
    const question = parseAsk(command.args).question
    const waiting = (await read($, jobs)).find(job => job.question === question && pasteWaiters.includes(job.id))
    if (waiting === undefined) {
      early.set(question, images)
      pasteClosedAt.set(`early:${question}`, await $.clock.now())
    } else if (await closePaste($, waiting.id, true)) {
      await addImages($, waiting.id, images)
      await start($, waiting.id)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A pasted image comes as a row of its own after the command: hand it to the
  // waiting question, and keep it (and a late one) out of the main conversation.
  on('session.append', async ($, e, next) => {
    // Only the shape the engine gives a command's pasted image: a hidden user
    // row of the main conversation at the note door, made by no plugin, holding
    // nothing but images. A prompt the person typed never matches.
    const isImageRowShape =
      e.agentId === undefined &&
      e.door === 'note' &&
      e.message.type === 'user' &&
      e.message.isMeta === true &&
      e.origin.kind !== 'plugin'
    if (!isImageRowShape) {
      return next(e)
    }
    const found = imagesOfRow(e.message.content)
    if (found === undefined) {
      return next(e)
    }
    const waiter = pasteWaiters[0]
    await debug($, `image row paths=${JSON.stringify(found.paths)} inline=${found.inline.length} waiter=${waiter ?? '-'}`)
    if (waiter === undefined && !(await takeLateRow($))) {
      return next(e)
    }

    if (waiter !== undefined && (await closePaste($, waiter))) {
      const job = (await read($, jobs)).find(one => one.id === waiter)
      const refs = pastedRefs(job?.question ?? '')
      const images: AsideImage[] = []
      let count = 0
      for (const path of found.paths) {
        images.push({ path: resolvePath(path, home, cwd), label: `pasted image ${refs[count] ?? count + 1}` })
        count += 1
      }
      for (const bytes of found.inline) {
        const staged = await stageBase64($, bytes.base64, bytes.mediaType, `pasted image ${refs[count] ?? count + 1}`).catch(
          () => undefined,
        )
        count += 1
        if (staged !== undefined) {
          images.push(staged)
        }
      }
      await addImages($, waiter, images)
      // Started in a dispatch of its own, so storing the row never waits on a spawn.
      $.clock.after(1, () => {
        void start($, waiter)
      })
    }

    return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: SCRUBBED_IMAGE }] } })
  }).catch(($, e, next) => next(e))

  // Keep the question out of the main conversation.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    const blocks = e.message.content
    const isAside = blocks.some(block => typeof block.text === 'string' && COMMAND_TAG.test(block.text))
    if (!isAside) {
      return next(e)
    }
    const content = blocks
      .filter(block => block.type !== 'image')
      .map(block =>
        typeof block.text === 'string' ? { ...block, text: block.text.replace(COMMAND_ARGS, SCRUBBED_ARGS) } : block,
      )

    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => next(e))

  // A side agent's report is shown in the pane and never reaches the main conversation.
  on('agent.report', async ($, e, next) => {
    if (!(await isSide($, e.agentId))) {
      return next(e)
    }
    await finish($, e.agentId, e.text, e.status !== 'completed')

    return { consumed: 'aside: the answer is shown in the Aside pane' }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined && (await isSide($, e.agentId))) {
      await finish($, e.agentId, e.answer, e.reason === 'error' || e.reason === 'refusal' || e.isAborted)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Side agents are read-only: a short list of tools, and nothing that changes state.
  on('tool.call', async ($, e, next) => {
    if (!(await isSide($, e.agentId, next.origin.plugin))) {
      return next(e)
    }
    const tool = String(e.tool)
    if (!SIDE_TOOLS.has(tool)) {
      return { deny: `aside: ${tool} is not available to a side question, which is read-only. Answer from what you can read.` }
    }
    if (tool === 'Bash') {
      const command = (e as { command?: unknown }).command
      if (typeof command !== 'string' || !isSafeShell(command)) {
        return {
          deny: 'aside: refused. A side question runs only plainly read-only shell commands (ls, cat, grep, rg, find, git log, git diff, piped together, with no redirection, chaining or substitution). Use Read for files.',
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    if (!(await isSide($, e.agentId, next.origin.plugin)) || CHECK_EXEMPT.has(e.tool)) {
      return next(e)
    }
    if (e.tool === 'Read') {
      const input = e.input as { file_path?: unknown }
      const known = await read($, allowed)
      if (typeof input.file_path === 'string' && known.includes(input.file_path)) {
        return { decision: 'allow', reason: 'aside: an image the person attached to the side question' }
      }
    }
    if (e.isReadOnly !== true) {
      return {
        decision: 'deny',
        reason:
          'aside: refused because Claude Code could not confirm this call only reads, and side questions are read-only. Read, Grep and Glob always work.',
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The answer's row in the transcript: display only, never read by the model.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== 'aside') {
      return next(e)
    }
    const job = (await read($, jobs)).find(one => one.id === e.props.id)
    if (job === undefined) {
      return next(e)
    }
    const { Box, Text, Markdown, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginY={1}>
        <Text dimColor>aside · side answer, not part of the main chat{metaOf(job)}</Text>
        <Text bold color="claude">
          ❯ {job.question}
        </Text>
        {job.images.length > 0 && <Text dimColor>📎 {job.images.map(image => image.label).join(', ')}</Text>}
        {job.selection !== undefined && <Text dimColor>✂ about your selection: “{shorten(job.selection, 70)}”</Text>}
        {job.note !== undefined && <Text dimColor>{job.note}</Text>}
        {job.status === 'failed' && <Text color="error">{job.error ?? 'The side question failed.'}</Text>}
        {job.answer !== undefined && job.answer !== '' && <Markdown dimColor={job.status === 'failed'} text={job.answer} />}
        {job.status === 'done' && (
          <Box flexDirection="row" gap={1}>
            <Button key={`copy-${job.id}`} label="Copy" onPress={press => void copyAnswer($, job, press.surface)} />
            <Button key={`main-${job.id}`} label="Send to main" onPress={() => void sendToMain($, job)} />
            {job.via === 'quick' && <Button key={`deeper-${job.id}`} label="Dig deeper" onPress={() => void digDeeper($, job)} />}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'aside' }, async ($, e) => {
    const { Box, Text, Markdown, Input, Progress, Button } = $.ui.resolve(e)
    const list = await read($, jobs)
    // The newest answer's buttons answer to keys while the pane has the keyboard: c, m, d.
    const newest = [...list].reverse().find(job => job.status === 'done')?.id

    const view = (job: AsideJob) => {
      const isNewest = job.id === newest

      return (
        <Box key={job.id} flexDirection="column" marginTop={1}>
          <Text bold color="claude">
            ❯ {job.question}
          </Text>
          {job.images.length > 0 && <Text dimColor>📎 {job.images.map(image => image.label).join(', ')}</Text>}
          {job.selection !== undefined && <Text dimColor>✂ about your selection: “{shorten(job.selection, 50)}”</Text>}
          {job.note !== undefined && <Text dimColor>{job.note}</Text>}
          {job.status === 'waiting' && <Progress label="Getting the pasted image" />}
          {job.status === 'thinking' && (
            <Progress
              label={
                job.mode === 'quick'
                  ? 'Answering instantly'
                  : job.via === 'helper'
                    ? 'Thinking (fresh read-only helper)'
                    : 'Thinking (reading what it needs)'
              }
            />
          )}
          {job.status === 'done' && (
            <Markdown text={job.answer === undefined || job.answer === '' ? '(no answer)' : job.answer} />
          )}
          {job.status === 'failed' && <Text color="error">{job.error ?? 'The side question failed.'}</Text>}
          {job.status === 'failed' && job.answer !== undefined && job.answer !== '' && <Markdown dimColor text={job.answer} />}
          {(job.status === 'done' || job.status === 'failed') && <Text dimColor>{metaOf(job).replace(/^ · /, '')}</Text>}
          {job.status === 'done' && (
            <Box flexDirection="row" gap={1}>
              <Button
                key={`copy-${job.id}`}
                label="Copy"
                {...(isNewest ? { hotkey: 'c' } : {})}
                onPress={press => void copyAnswer($, job, press.surface)}
              />
              <Button
                key={`main-${job.id}`}
                label="Send to main"
                {...(isNewest ? { hotkey: 'm' } : {})}
                onPress={() => void sendToMain($, job)}
              />
              {job.via === 'quick' && (
                <Button
                  key={`deeper-${job.id}`}
                  label="Dig deeper"
                  {...(isNewest ? { hotkey: 'd' } : {})}
                  onPress={() => void digDeeper($, job)}
                />
              )}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {list.length === 0 && <Text dimColor>{EMPTY_TEXT}</Text>}
        {list.map(view)}
        <Box marginTop={1}>
          <Input
            key="ask"
            placeholder="Ask a follow-up (-q for instant; add an image path for a picture)"
            submitLabel="ask"
            value=""
            onSubmit={value => {
              const { question, mode } = parseAsk(value)
              if (question !== '') {
                void ask($, question, { mode })
              }
            }}
          />
        </Box>
        <Text dimColor>Read-only side chat · nothing here enters the main chat · /aside help</Text>
      </Box>
    )
  })
}

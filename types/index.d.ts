/** One picture attached to a side question: where it is on disk, and how it is shown. */
export type AsideImage = { path: string; label: string }

/**
 * One side question and its answer.
 *
 * `waiting`: a pasted image is still being saved; `thinking`: the side agent runs;
 * `done` / `failed`: settled.
 */
export type AsideJob = {
  id: string
  question: string
  images: AsideImage[]
  status: 'waiting' | 'thinking' | 'done' | 'failed'
  answer?: string
  error?: string
  /** A dim line under the question, such as a pasted image that could not be read. */
  note?: string
  agentId?: string
  /** `quick`: one instant tool-less reply over the conversation, like /btw; `deep` (the default): a read-only agent. */
  mode?: 'deep' | 'quick'
  /** What answered: an agent forked from the conversation, the fresh helper, or the instant fork. */
  via?: 'fork' | 'helper' | 'quick'
  /** Transcript text the person had selected when asking, which "this" may refer to. */
  selection?: string
  askedAt: number
  doneAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    aside: {
      /** The side chat: questions and answers of this session, oldest first. */
      jobs: Shaped<AsideJob[]>
      /** Ids of the side agents this mod started; their tools are held read-only. */
      agents: string[]
      /** Image files a side agent may Read without a permission prompt (the ones the person attached). */
      allowed: string[]
    }
  }
}

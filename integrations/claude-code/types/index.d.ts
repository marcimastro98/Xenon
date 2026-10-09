export type SendResult = 'ok' | 'unpaired' | 'unreachable' | 'rejected'

// What the band above the prompt shows: the last send's outcome, and the
// approval waiting on the dashboard, if any.
export type Band = {
  result: SendResult | ''
  okAt: number
  waitingTool: string
}

declare module 'claude-code' {
  interface PluginState {
    xenon: { band: Band }
  }
}

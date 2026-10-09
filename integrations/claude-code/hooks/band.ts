import type { Band } from '../types'

export const EMPTY_BAND: Band = { result: '', okAt: 0, waitingTool: '' }

// The status line is shown only when there is something to know. The engine
// already prefixes it with the plugin's name, and a line that is there all the
// time reads as a warning, so "connected" is the absence of a line: /xenon
// gives the detail.
export function statusLine(band: Band): string | undefined {
  if (band.waitingTool) return `${band.waitingTool} is waiting for your answer on the dashboard`
  if (band.result === 'unreachable') return 'Xenon is not reachable, retrying'
  if (band.result === 'rejected') return 'link out of date, connect Claude Code again from the Claude tile in Xenon'
  if (band.result === 'unpaired') return 'not linked, use Connect Claude Code in the Claude tile in Xenon'
  return undefined
}

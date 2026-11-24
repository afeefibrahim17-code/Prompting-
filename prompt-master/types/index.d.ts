export type Question = { question: string; options: string[] }
export type Answer = { question: string; answer: string }

export type Flow = {
  phase: 'idle' | 'reading' | 'asking' | 'writing' | 'result' | 'editing' | 'error'
  original: string
  goal: string
  questions: Question[]
  index: number
  answers: Answer[]
  improved: string
  note: string
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-master': { flow: Shaped<Flow> }
  }
}

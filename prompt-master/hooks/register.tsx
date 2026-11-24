import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Answer, Flow, Question } from '../types'

// Prompt Master: improves a rough prompt before you send it.
// It never submits anything. The most it does is put text in the prompt box.

const MODEL = 'sonnet'
const IDLE: Flow = {
  phase: 'idle',
  original: '',
  goal: '',
  questions: [],
  index: 0,
  answers: [],
  improved: '',
  note: '',
  error: '',
}

const flow = atom({ plugin: 'prompt-master', key: 'flow' } as const, IDLE, {
  shape: 'flow-1',
})

// Bumped on every new run or close, so a slow model reply from an old run is dropped.
let run = 0

// Which apps have asked to draw the button, for /prompt-master with nothing typed.
const seen = new Set<string>()
const LOG = '/tmp/claude-0/-home-user-Prompting-/ccaa8bf0-9048-545a-8d31-554ce9b5298c/scratchpad/prompt-master-surfaces.txt'

const READ_SYSTEM = `You help someone improve a rough prompt they are about to send to Claude.

Read their prompt and work out what they are actually trying to get done.

Then check these three things, in this order:
1. Audience: who is this for, or where will they use it?
2. A great result: an example, a tone, or a goal.
3. Format and length.

Ask about one only if it is important for this task AND the prompt does not already answer it. If the prompt already covers it, or it does not matter for this task, skip it. Asking nothing is fine.

For each question: at most 12 words, plain language, about THIS prompt. Give 3 short likely answers (at most 5 words each) tailored to this prompt.

Reply with JSON only, no other text:
{"goal": "<one sentence: what they are trying to get done>", "questions": [{"question": "...", "options": ["...", "...", "..."]}]}`

const WRITE_SYSTEM = `You rewrite a person's rough prompt into a better prompt they will send to Claude. You write the prompt; you do not answer it.

Use exactly this structure, each heading on its own line followed by its text:
Role: who Claude should act as for this task.
Task: exactly what to do, in one or two clear sentences.
Context: who it is for, the details that matter, and the person's answers to the questions.
Format: length, structure (list, table, steps or paragraphs) and tone.
Quality check: what Claude should double-check before answering.

Rules:
- Keep the person's meaning, and keep their own words where they already work.
- Never invent facts about the person, their business, their numbers, names or dates.
- If something important is still unknown, write it as [fill this in: <what is needed>] so they can see it.
- Write it in the same language as their prompt. Address Claude directly ("You are...").
- Keep it tight: no filler, no headings beyond the five above.

Reply with JSON only, no other text:
{"prompt": "<the improved prompt, with \\n between lines>", "note": "<one line, under 25 words: what you changed and why>"}`

const parseJson = (text: string): unknown => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('The reply was not in the expected form.')
  }

  return JSON.parse(text.slice(start, end + 1))
}

const ask = async ($: EngineInterface, system: string, prompt: string) => {
  const r = await $.model.complete({
    model: MODEL,
    system,
    prompt,
    maxTokens: 2000,
    effort: 'low',
    timeoutMs: 60_000,
  })
  if (!r.isAnswered) {
    throw new Error(
      r.reason === 'aborted' ? 'It took too long. Try again.' : `The model call failed (${r.reason}).`,
    )
  }

  return parseJson(r.text)
}

const fail = async ($: EngineInterface, mine: number, err: unknown) => {
  if (mine !== run) return
  const message = err instanceof Error ? err.message : String(err)
  await update($, flow, (f): Flow => ({ ...f, phase: 'error', error: message }))
}

const close = async ($: EngineInterface) => {
  run += 1
  await update($, flow, () => IDLE)
}

const write = async ($: EngineInterface, mine: number) => {
  const f = await read($, flow)
  await update($, flow, (x): Flow => ({ ...x, phase: 'writing' }))
  const answered = f.answers.filter(a => a.answer !== '')
  const prompt = [
    `Their rough prompt:\n"""\n${f.original}\n"""`,
    f.goal ? `What they seem to be trying to do: ${f.goal}` : '',
    answered.length > 0
      ? `Their answers to your questions:\n${answered.map(a => `- ${a.question} ${a.answer}`).join('\n')}`
      : 'They gave no extra answers.',
    f.answers.some(a => a.answer === '')
      ? `They skipped: ${f.answers.filter(a => a.answer === '').map(a => a.question).join(' / ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  try {
    const out = (await ask($, WRITE_SYSTEM, prompt)) as {
      prompt?: unknown
      note?: unknown
    }
    if (mine !== run) return
    const improved = typeof out.prompt === 'string' ? out.prompt.trim() : ''
    if (improved === '') throw new Error('No improved prompt came back. Try again.')
    const note = typeof out.note === 'string' ? out.note.trim() : ''
    await update($, flow, (x): Flow => ({ ...x, phase: 'result', improved, note }))
  } catch (err) {
    await fail($, mine, err)
  }
}

const start = async ($: EngineInterface, text: string) => {
  const original = text.trim()
  if (original === '') {
    $.ui.toast('Type a rough prompt first, then click ✦ Prompt Master.')
    return
  }
  run += 1
  const mine = run
  await update($, flow, (): Flow => ({ ...IDLE, phase: 'reading', original }))

  try {
    const out = (await ask($, READ_SYSTEM, `Their rough prompt:\n"""\n${original}\n"""`)) as {
      goal?: unknown
      questions?: unknown
    }
    if (mine !== run) return
    const questions: Question[] = (Array.isArray(out.questions) ? out.questions : [])
      .filter(
        (q): q is { question: string; options?: unknown } =>
          typeof q === 'object' && q !== null && typeof (q as { question?: unknown }).question === 'string',
      )
      .slice(0, 3)
      .map(q => ({
        question: q.question,
        options: (Array.isArray(q.options) ? q.options : [])
          .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
          .slice(0, 3),
      }))
    const goal = typeof out.goal === 'string' ? out.goal : ''
    await update($, flow, (f): Flow => ({ ...f, goal, questions, index: 0 }))
    if (questions.length === 0) {
      await write($, mine)
    } else {
      await update($, flow, (f): Flow => ({ ...f, phase: 'asking' }))
    }
  } catch (err) {
    await fail($, mine, err)
  }
}

const answer = async ($: EngineInterface, value: string) => {
  const mine = run
  const f = await read($, flow)
  if (f.phase !== 'asking') return
  const q = f.questions[f.index]
  if (!q) return
  const answers: Answer[] = [...f.answers, { question: q.question, answer: value.trim() }]
  const index = f.index + 1
  await update($, flow, (x): Flow => ({ ...x, answers, index }))
  if (index >= f.questions.length) {
    await write($, mine)
  }
}

const useText = async ($: EngineInterface, text: string) => {
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.toast('Could not reach the prompt box. Close any open dialog and try again.')
    return
  }
  await close($)
  $.ui.toast('Your improved prompt is in the box. Press send when you are ready.')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt-master',
      description: 'Improve a prompt before you send it: /prompt-master <your rough prompt>',
    })

    return next(e)
  })

  on('command.run', { command: 'prompt-master' }, async ($, e) => {
    const text = e.args.trim() !== '' ? e.args : (await $.prompt.read()).text
    if (text.trim() === '') {
      const where = seen.size > 0 ? `The ✦ Prompt Master button is being drawn in: ${[...seen].join(', ')}.` : 'No app has drawn the ✦ Prompt Master button in this session yet.'
      return { text: `${where} Type /prompt-master followed by your rough prompt, e.g. /prompt-master write a post about our launch` }
    }
    void start($, text)

    return { text: '✦ Prompt Master is working on it. Look just above your prompt box. Nothing is sent until you press send.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!seen.has(e.surface)) {
      seen.add(e.surface)
      void $.fs.write(LOG, [...seen].join('\n')).catch(() => undefined)
    }
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const f = await read($, flow)

    if (f.phase === 'idle') {
      return (
        <Box>
          <Button
            key="pm-open"
            label="✦ Prompt Master"
            dimColor
            onPress={async () => start($, (await $.prompt.read()).text)}
          />
        </Box>
      )
    }

    const cancel = <Button key="pm-close" label="Keep mine" role="dismiss" onPress={() => close($)} />

    if (f.phase === 'reading' || f.phase === 'writing') {
      return (
        <Box flexDirection="column">
          <Text bold>✦ Prompt Master</Text>
          <Text dimColor>
            {f.phase === 'reading' ? 'Reading your prompt…' : 'Writing a better prompt…'}
          </Text>
          <Box>{cancel}</Box>
        </Box>
      )
    }

    if (f.phase === 'error') {
      return (
        <Box flexDirection="column">
          <Text bold>✦ Prompt Master</Text>
          <Text>Something went wrong: {f.error}</Text>
          <Box gap={1}>
            <Button key="pm-retry" label="Try again" variant="primary" onPress={() => start($, f.original)} />
            {cancel}
          </Box>
        </Box>
      )
    }

    if (f.phase === 'asking') {
      const q = f.questions[f.index]
      if (!q) return next(e)
      return (
        <Box flexDirection="column">
          <Text bold>
            ✦ Prompt Master · question {f.index + 1} of {f.questions.length}
          </Text>
          <Text>{q.question}</Text>
          <Box gap={1} flexWrap="wrap">
            {q.options.map((o, i) => (
              <Button key={`pm-opt-${f.index}-${i}`} label={o} hotkey={String(i + 1)} onPress={() => answer($, o)} />
            ))}
            <Button key={`pm-skip-${f.index}`} label="Skip" dimColor hotkey="s" onPress={() => answer($, '')} />
          </Box>
          <Input
            key={`pm-own-${f.index}`}
            placeholder="Or type your own answer and press Enter"
            submitLabel="answer"
            onSubmit={value => answer($, value)}
          />
          <Box>{cancel}</Box>
        </Box>
      )
    }

    if (f.phase === 'editing') {
      return (
        <Box flexDirection="column">
          <Text bold>✦ Prompt Master · edit, then press Enter to put it in your prompt box</Text>
          <Input
            key="pm-edit"
            value={f.improved}
            rows={12}
            autoFocus
            submitLabel="use this"
            onSubmit={value => useText($, value)}
          />
          <Box gap={1}>
            <Button
              key="pm-back"
              label="Back"
              dimColor
              onPress={() => update($, flow, (x): Flow => ({ ...x, phase: 'result' }))}
            />
            {cancel}
          </Box>
        </Box>
      )
    }

    // result
    return (
      <Box flexDirection="column">
        <Text bold>✦ Better prompt</Text>
        {f.note !== '' && <Text dimColor>What changed: {f.note}</Text>}
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text wrap="wrap">{f.improved}</Text>
        </Box>
        <Text dimColor>Your original:</Text>
        <Text dimColor wrap="wrap">
          {f.original}
        </Text>
        <Box gap={1}>
          <Button key="pm-use" label="Use this" variant="primary" hotkey="u" onPress={() => useText($, f.improved)} />
          <Button
            key="pm-edit-open"
            label="Edit"
            hotkey="e"
            onPress={() => update($, flow, (x): Flow => ({ ...x, phase: 'editing' }))}
          />
          {cancel}
        </Box>
      </Box>
    )
  })
}

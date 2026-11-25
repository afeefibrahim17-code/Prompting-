import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'prompt-master',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 29 },
    view: {},
  },
} as const

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

test('asks, rewrites, and only fills the box on Use this', async ($, on) => {
  let filled = ''
  let submitted = false
  on('prompt.read', () => ({ value: { text: 'write a post about our launch', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled = e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    submitted = true
    return { text: e.text } as never
  })
  on('model.complete', (_, e) => ({ value: {
    isAnswered: true,
    usage,
    text: String(e.system).includes('rewrite')
      ? '{"prompt":"Role: You are a copywriter.\\nTask: Write a post about our launch.","note":"Added a role and format."}'
      : '{"goal":"a launch post","questions":[{"question":"Who is it for?","options":["Customers","Investors","Team"]}]}',
  } }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'pm-open' })
  expect((await ui.find({ type: 'Text', text: /Who is it for/ }))?.text).toBe('Who is it for?')

  await ui.press({ key: 'pm-opt-0-0' })
  expect((await ui.find({ type: 'Text', text: /copywriter/ }))?.text).toContain('Role:')
  expect(filled).toBe('')

  await ui.press({ key: 'pm-use' })
  expect(filled).toContain('Role: You are a copywriter.')
  expect(submitted).toBe(false)
  expect(await ui.find({ key: 'pm-open' })).toBeDefined()
  await ui.unmount()
})

test('without the band, /prompt-master asks in question cards and fills the box', async ($, on) => {
  let filled = ''
  const logs: string[] = []
  const answers = ['Customers', 'Use this']
  const asked: string[] = []
  on('command.register', () => ({ value: { command: 'prompt-master' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled = e.text
    return { isFilled: true }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    asked.push(q)
    return { result: { questions: [], answers: { [q]: answers.shift() ?? 'Keep mine' } } } as never
  })
  on('model.complete', (_, e) => ({ value: {
    isAnswered: true,
    usage,
    text: String(e.system).includes('rewrite')
      ? '{"prompt":"Role: You are a sales trainer.","note":"Added a role."}'
      : '{"goal":"become a trainer","questions":[{"question":"Who is it for?","options":["Customers","Investors"]}]}',
  } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'prompt-master', args: 'I want to be a trainer' })
  expect(out.text).toContain('question')
  await new Promise(r => setTimeout(r, 50))
  expect(asked[0]).toBe('Who is it for?')
  expect(logs.join('\n')).toContain('Role: You are a sales trainer.')
  expect(filled).toBe('Role: You are a sales trainer.')
})

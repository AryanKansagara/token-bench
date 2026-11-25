import { readFile } from 'node:fs/promises'
import { createBenchmark, expect, FAKE_KEY, tab, test } from './fixtures.ts'

// Provider hosts are never contacted: the tests answer them with page.route, which also lets them
// check exactly what the app would have sent.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' }
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

test.describe('provider presets, with the provider host stubbed', () => {
  test('a hosted preset fills in its documented URL, model and prices, and Test connection sends the key only there', async ({ page }) => {
    const sent: { url: string; auth?: string; body?: { model?: string; stream?: boolean } }[] = []
    await page.route('https://api.groq.com/**', async route => {
      const req = route.request()
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
      sent.push({ url: req.url(), auth: req.headers().authorization, body: req.postDataJSON() })
      return route.fulfill({
        status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' },
        body: sse({ choices: [{ delta: { content: 'ready' } }] }) + sse({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }) + 'data: [DONE]\n\n',
      })
    })
    await createBenchmark(page, 'Groq preset')
    await page.getByRole('button', { name: 'Add endpoint' }).click()
    await page.getByRole('dialog', { name: 'Add an endpoint' }).getByRole('button', { name: /^Groq/ }).click()
    const card = page.locator('.ep-card')
    await expect(card.getByLabel('Base URL')).toHaveValue('https://api.groq.com/openai/v1')
    await expect(card.getByLabel('Model')).toHaveValue('openai/gpt-oss-120b')
    await expect(card.getByLabel('Input $ / 1M')).toHaveValue('0.15')
    await expect(card.getByLabel('Output $ / 1M')).toHaveValue('0.6')

    await card.getByLabel(/^API key/).fill(FAKE_KEY)
    await card.getByRole('button', { name: 'Test connection' }).click()
    await expect(card.getByRole('status')).toContainText('Streaming works')
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(sent[0].auth).toBe(`Bearer ${FAKE_KEY}`)
    expect(sent[0].body).toMatchObject({ model: 'openai/gpt-oss-120b', stream: true })
  })

  test('a blocked provider is explained as a browser problem, with the terminal script as the way out', async ({ page }) => {
    await page.route('https://api.together.xyz/**', route => route.abort('failed'))
    await createBenchmark(page, 'Blocked provider')
    await page.getByRole('button', { name: 'Add endpoint' }).click()
    await page.getByRole('dialog', { name: 'Add an endpoint' }).getByRole('button', { name: /^Together AI/ }).click()
    const card = page.locator('.ep-card')
    await card.getByRole('button', { name: 'Test connection' }).click()
    await expect(card.getByRole('alert')).toBeVisible()
    await expect(card.getByText('The browser blocked this request before the provider answered.')).toBeVisible()
    await expect(card.getByRole('link', { name: 'download the terminal script' })).toBeVisible()
    await tab(page, 'Run').click()
    await expect(page.getByRole('heading', { name: 'Run it from your terminal instead' })).toBeVisible()
  })

  test('the Cerebras model list loads from a stubbed response and fills in the listed price', async ({ page }) => {
    const list = await readFile(new URL('../src/engine/fixtures/cerebras-models-2026-11-13.json', import.meta.url), 'utf8')
    await page.route('https://api.cerebras.ai/public/v1/models', route => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: list }))
    await createBenchmark(page, 'Cerebras models')
    await page.getByRole('button', { name: 'Add endpoint' }).click()
    await page.getByRole('dialog', { name: 'Add an endpoint' }).getByRole('button', { name: /^Cerebras/ }).click()
    const card = page.locator('.ep-card')
    await card.getByRole('button', { name: 'Load model list and prices' }).click()
    await expect(page.getByText(/models loaded from Cerebras/)).toBeVisible()
    await card.getByLabel('Model').fill('qwen-3.8-27b')
    await card.getByLabel('Model').blur()
    await expect(card.getByLabel('Input $ / 1M')).toHaveValue('0.99')
  })

  test('a model list that cannot be loaded says so', async ({ page }) => {
    await page.route('https://openrouter.ai/**', route => route.fulfill({ status: 503, headers: CORS, body: 'down' }))
    await createBenchmark(page, 'No list')
    await page.getByRole('button', { name: 'Add endpoint' }).click()
    await page.getByRole('dialog', { name: 'Add an endpoint' }).getByRole('button', { name: /^OpenRouter/ }).click()
    await page.locator('.ep-card').getByRole('button', { name: 'Load model list and prices' }).click()
    await expect(page.getByText('Could not load the OpenRouter model list: HTTP 503')).toBeVisible()
  })
})

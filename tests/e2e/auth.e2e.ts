import { expect, test, type Page } from '@playwright/test'

async function openAuth(page: Page, scenario: string, lang = 'zh') {
  // Reject all non-loopback browser requests, including accidental real OAuth navigation.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(`/?scenario=${scenario}&lang=${lang}`)
  const label = lang === 'en' ? 'Platform authentication' : '平台认证'
  await page.getByRole('button', { name: label, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: label })
  await expect(dialog).toBeVisible()
  return dialog
}

for (const [scenario, zh, en] of [
  ['gh', 'GitHub CLI（gh）', 'GitHub CLI (gh)'],
  ['oauth', 'GitHub OAuth（设备码登录）', 'GitHub OAuth (device login)'],
  ['ref', '凭据引用（GH_TOKEN / GITHUB_TOKEN）', 'Credential reference (GH_TOKEN / GITHUB_TOKEN)'],
]) {
  test(`reports the ${scenario} source in Chinese and English`, async ({ page }) => {
    for (const [lang, label] of [['zh', zh], ['en', en]]) {
      const dialog = await openAuth(page, scenario!, lang)
      await expect(dialog.getByText(label!, { exact: true })).toBeVisible()
      await expect(dialog.getByText('· fixture-user')).toBeVisible()
      await expect(dialog.getByText(lang === 'en' ? 'Authentication source' : '认证渠道', { exact: true })).toBeVisible()
      expect(await dialog.innerText()).not.toContain('e2e-sentinel-')
    }
  })
}

test('updates the source after helper discovery, retry, sign-out and clearing local grant', async ({ page }) => {
  const dialog = await openAuth(page, 'gh')
  await expect(dialog.getByText('GitHub CLI（gh）')).toBeVisible()
  await dialog.getByRole('button', { name: '使用 Git 凭据', exact: true }).click()
  await expect(dialog.getByText('Git 凭据助手', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '重试凭据发现', exact: true }).click()
  await expect(dialog.getByText('GitHub CLI（gh）')).toBeVisible()
  await dialog.getByRole('button', { name: '登出（停止发现）', exact: true }).click()
  await expect(dialog.getByText('未使用凭据', { exact: true })).toBeVisible()
  await expect(dialog.getByText('GitHub CLI（gh）')).toHaveCount(0)
  await dialog.getByRole('button', { name: '重试凭据发现', exact: true }).click()
  await expect(dialog.getByText('未使用凭据', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '清除本地授权（恢复发现，不撤销服务端令牌）', exact: true }).click()
  await expect(dialog.getByText('GitHub CLI（gh）')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('authentication-source.png') })
})

test('completes device login through the real client and auth engine without exposing a token', async ({ page }) => {
  const wire: Promise<string>[] = []
  page.on('response', response => { if (response.url().endsWith('/__test/rpc')) wire.push(response.text().catch(() => '')) })
  const dialog = await openAuth(page, 'anonymous')
  await expect(dialog.getByText('匿名访问', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '登录 GitHub', exact: true }).click()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('link', { name: '打开 GitHub 并输入代码' })).toHaveAttribute('href', 'https://github.com/login/device')
  const id = await page.getByRole('status', { name: 'Fixture ID' }).textContent()
  await page.request.post('/__test/approve', { data: { id } })
  await expect(dialog.getByText('GitHub OAuth（设备码登录）', { exact: true })).toBeVisible()
  await expect(dialog.getByText('· fixture-user')).toBeVisible()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toHaveCount(0)
  expect((await Promise.all(wire)).join('\n')).not.toContain('e2e-sentinel-')
  expect(await page.locator('body').innerText()).not.toContain('e2e-sentinel-')
})

test('cancelling device login never reports OAuth authentication', async ({ page }) => {
  const dialog = await openAuth(page, 'anonymous')
  await expect(dialog.getByText('匿名访问', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '登录 GitHub', exact: true }).click()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toBeVisible()
  await dialog.getByRole('region', { name: '平台认证' }).getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('GitHub OAuth（设备码登录）')).toHaveCount(0)
  const id = await page.getByRole('status', { name: 'Fixture ID' }).textContent()
  const info = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(info.capability.auth.source).toBeUndefined()
  expect(info.calls).toContain('remote-cancel-login')
})

test('independent browser contexts and fixture stores do not share authentication', async ({ browser }) => {
  const a = await browser.newContext(); const b = await browser.newContext()
  try {
    const pageA = await a.newPage(); const pageB = await b.newPage()
    const dialogA = await openAuth(pageA, 'gh')
    const dialogB = await openAuth(pageB, 'anonymous')
    await expect(dialogA.getByText('GitHub CLI（gh）')).toBeVisible()
    await expect(dialogB.getByText('匿名访问', { exact: true })).toBeVisible()
    await dialogA.getByRole('button', { name: '登出（停止发现）', exact: true }).click()
    await expect(dialogA.getByText('未使用凭据', { exact: true })).toBeVisible()
    await expect(dialogB.getByText('匿名访问', { exact: true })).toBeVisible()
  } finally { await a.close(); await b.close() }
})

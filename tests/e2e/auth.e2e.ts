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
      await expect(dialog.getByText('@fixture-user')).toBeVisible()
      await expect(dialog.getByText(lang === 'en' ? 'Connected to GitHub' : '已连接 GitHub', { exact: true })).toBeVisible()
      const radio = dialog.getByRole('radio', { name: label!, exact: true })
      if (scenario !== 'ref') await expect(radio).toBeChecked()
      else await expect(dialog.getByText(label!, { exact: true }).first()).toBeVisible()
      expect(await dialog.innerText()).not.toContain('e2e-sentinel-')
    }
  })
}

test('offers logout only for saved OAuth and keeps a 440px dialog', async ({ page }) => {
  const dialog = await openAuth(page, 'oauth')
  const cli = dialog.getByRole('radio', { name: 'GitHub CLI（gh）', exact: true })
  await expect(dialog.getByRole('radio', { name: 'GitHub OAuth（设备码登录）', exact: true })).toBeChecked()
  await page.screenshot({ path: test.info().outputPath('auth-dialog.png') })
  expect((await dialog.boundingBox())?.width).toBe(440)
  await dialog.getByRole('button', { name: '退出 OAuth', exact: true }).click()
  await expect(dialog.getByText('已断开连接', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '退出 OAuth', exact: true })).toHaveCount(0)
  await expect(cli).toBeEnabled()
})

test('completes device login through the real client and auth engine without exposing a token', async ({ page }) => {
  const wire: Promise<string>[] = []
  page.on('response', response => { if (response.url().endsWith('/__test/rpc')) wire.push(response.text().catch(() => '')) })
  const dialog = await openAuth(page, 'anonymous')
  await expect(dialog.getByText('未连接', { exact: true })).toBeVisible()
  const oauth = dialog.getByRole('radio', { name: 'GitHub OAuth（设备码登录）', exact: true })
  await oauth.click()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('link', { name: '打开 GitHub 并输入代码' })).toHaveAttribute('href', 'https://github.com/login/device')
  const id = await page.getByRole('status', { name: 'Fixture ID' }).textContent()
  await page.request.post('/__test/approve', { data: { id } })
  await expect(dialog.getByText('GitHub OAuth（设备码登录）', { exact: true })).toBeVisible()
  await expect(dialog.getByText('@fixture-user')).toBeVisible()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toHaveCount(0)
  expect((await Promise.all(wire)).join('\n')).not.toContain('e2e-sentinel-')
  expect(await page.locator('body').innerText()).not.toContain('e2e-sentinel-')
})

test('switches an authenticated CLI user to OAuth and back without hiding either method', async ({ page }) => {
  const dialog = await openAuth(page, 'gh')
  const cli = dialog.getByRole('radio', { name: 'GitHub CLI（gh）', exact: true })
  const oauth = dialog.getByRole('radio', { name: 'GitHub OAuth（设备码登录）', exact: true })
  await expect(cli).toBeChecked()
  await expect(oauth).toBeEnabled()
  await oauth.click()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toBeVisible()
  await expect(cli).toBeDisabled()
  const id = await page.getByRole('status', { name: 'Fixture ID' }).textContent()
  await page.request.post('/__test/approve', { data: { id } })
  await expect(oauth).toBeChecked()
  await expect(cli).toBeEnabled()
  await cli.click()
  await expect(cli).toBeChecked()
  await expect(oauth).toBeEnabled()
  const info = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(info.capability.auth.source).toBe('gh')
  expect(info.calls).not.toContain('remote-clear-grant')
})

test('reuses saved OAuth across CLI selection and Host restart, and OAuth logout preserves CLI', async ({ page }) => {
  let dialog = await openAuth(page, 'gh')
  await expect(dialog.getByRole('button', { name: '退出 OAuth', exact: true })).toHaveCount(0)
  await dialog.getByRole('radio', { name: 'GitHub OAuth（设备码登录）', exact: true }).click()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toBeVisible()
  const id = await page.getByLabel('Fixture ID').textContent()
  await page.request.post('/__test/approve', { data: { id } })
  await expect(dialog.getByRole('radio', { name: 'GitHub OAuth（设备码登录）', exact: true })).toBeChecked()
  await dialog.getByRole('radio', { name: 'GitHub CLI（gh）', exact: true }).click()
  await expect(dialog.getByRole('radio', { name: 'GitHub CLI（gh）', exact: true })).toBeChecked()
  await expect(dialog.getByRole('button', { name: '退出 OAuth', exact: true })).toBeVisible()
  await page.request.post('/__test/restart', { data: { id } })
  await page.goto(`/?scenario=gh&lang=zh&fixture=${id}`)
  await page.getByRole('button', { name: '平台认证', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '平台认证' })
  await expect(dialog.getByRole('radio', { name: 'GitHub CLI（gh）', exact: true })).toBeChecked()
  await dialog.getByRole('radio', { name: 'GitHub OAuth（设备码登录）', exact: true }).click()
  await expect(dialog.getByRole('radio', { name: 'GitHub OAuth（设备码登录）', exact: true })).toBeChecked()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toHaveCount(0)
  await dialog.getByRole('radio', { name: 'GitHub CLI（gh）', exact: true }).click()
  await expect(dialog.getByRole('radio', { name: 'GitHub CLI（gh）', exact: true })).toBeChecked()
  await dialog.getByRole('button', { name: '退出 OAuth', exact: true }).click()
  await expect(dialog.getByRole('radio', { name: 'GitHub CLI（gh）', exact: true })).toBeChecked()
  await expect(dialog.getByRole('button', { name: '退出 OAuth', exact: true })).toHaveCount(0)
  const info = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(info.calls.filter((name: string) => name === 'remote-login')).toHaveLength(1)
  expect(info.calls).not.toContain('remote-clear-grant')
  expect(info.capability.auth.source).toBe('gh')
  expect(info.capability.authSelection.oauthCached).toBe(false)
})

test('cancelling device login never reports OAuth authentication', async ({ page }) => {
  const dialog = await openAuth(page, 'anonymous')
  await expect(dialog.getByText('未连接', { exact: true })).toBeVisible()
  const oauth = dialog.getByRole('radio', { name: 'GitHub OAuth（设备码登录）', exact: true })
  await oauth.click()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toBeVisible()
  // The cancel control lives in the device-login card, distinct from the modal's own close button.
  await dialog.locator('[role="status"]').getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog.getByText('E2E-CODE', { exact: true })).toHaveCount(0)
  await expect(oauth).not.toBeChecked()
  const id = await page.getByRole('status', { name: 'Fixture ID' }).textContent()
  const info = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(info.capability.auth.source).toBeUndefined()
  expect(info.calls).toContain('remote-cancel-login')
})

test('independent browser contexts and fixture stores do not share authentication', async ({ browser }) => {
  const a = await browser.newContext(); const b = await browser.newContext()
  try {
    const pageA = await a.newPage(); const pageB = await b.newPage()
    const dialogA = await openAuth(pageA, 'oauth')
    const dialogB = await openAuth(pageB, 'anonymous')
    await expect(dialogA.getByRole('radio', { name: 'GitHub OAuth（设备码登录）', exact: true })).toBeChecked()
    await expect(dialogB.getByText('未连接', { exact: true })).toBeVisible()
    await dialogA.getByRole('button', { name: '退出 OAuth', exact: true }).click()
    await expect(dialogA.getByText('已断开连接', { exact: true })).toBeVisible()
    await expect(dialogB.getByText('未连接', { exact: true })).toBeVisible()
  } finally { await a.close(); await b.close() }
})


test('retires an orphan GitLab grant only after reviewing its canonical URL', async ({ page }) => {
  const dialog = await openAuth(page, 'gitlab-orphan')
  await expect(dialog.getByLabel('已移除的实例 URL')).toBeHidden()
  await dialog.locator('summary').focus()
  await page.keyboard.press('Enter')
  await dialog.getByLabel('已移除的实例 URL').fill('https://OLD.EXAMPLE:443/')
  const box = await dialog.boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(24)
  expect(box!.y + box!.height).toBeLessThanOrEqual(736)
  await page.screenshot({ path: test.info().outputPath('gitlab-advanced.png') })
  await dialog.getByRole('button', { name: '检查清除内容' }).click()
  await expect(dialog.getByText('https://old.example', { exact: true })).toBeVisible()
  const id = await page.getByRole('status', { name: 'Fixture ID' }).textContent()
  const before = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(before.orphanRetired).toBe(false)
  await dialog.getByRole('button', { name: '确认清除' }).click()
  await expect(dialog.getByText('本地秘密已清除，退出标记已保留。')).toBeVisible()
  const after = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(after.orphanRetired).toBe(true); expect(after.calls).toContain('remote-retire-grant')
  expect(await page.locator('body').innerText()).not.toContain('e2e-sentinel-')
})

test('keeps GitLab maintenance out of GitHub sign-in', async ({ page }) => {
  const dialog = await openAuth(page, 'gh')
  await expect(dialog.getByText('高级', { exact: true })).toHaveCount(0)
})

test('opens platform account settings without repository RPCs', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto('/?scenario=gh&view=settings')
  const accounts = page.getByRole('region', { name: '平台账号' })
  await expect(accounts.getByText('@fixture-user')).toBeVisible()
  await accounts.getByRole('button', { name: '管理登录' }).first().click()
  const dialog = page.getByRole('dialog', { name: '平台认证' })
  await expect(dialog.getByText('@fixture-user')).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'GitHub CLI（gh）', exact: true })).toBeChecked()
  const id = await page.getByLabel('Fixture ID').textContent()
  const info = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(info.calls).toContain('remote-auth-status')
  expect(info.calls).not.toContain('remote-repositories')
  await page.screenshot({ path: test.info().outputPath('settings-accounts.png') })
})

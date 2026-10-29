import { expect, test, type Page } from '@playwright/test'

// A 1x1 PNG served to the avatar <img> through request fulfilment; no network is touched.
const AVATAR = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function openAccounts(page: Page, lang = 'en') {
  // Reject all non-loopback browser requests except the pinned GitHub avatar host,
  // which is fulfilled locally. OAuth navigation or stray remote calls stay blocked.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.route('**/avatars.githubusercontent.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: AVATAR }))
  await page.setViewportSize({ width: 800, height: 700 })
  await page.goto(`/?scenario=accounts&lang=${lang}`)
  await expect(page.getByText(lang === 'en' ? 'Platform accounts' : '平台账号', { exact: true })).toBeVisible()
  await expect(page.getByRole('listitem')).toHaveCount(3)
}

test('lists GitHub, GitLab.com and a labelled self-hosted instance with per-row state', async ({ page }) => {
  await openAccounts(page)
  const rows = page.getByRole('listitem')
  await expect(rows.nth(0).getByText('GitHub', { exact: true })).toBeVisible()
  await expect(rows.nth(0).getByText('@fixture-user · OAuth', { exact: true })).toBeVisible()
  await expect(rows.nth(0).locator('img')).toBeVisible()
  await expect(rows.nth(0).getByRole('button', { name: 'Manage', exact: true })).toBeVisible()
  await expect(rows.nth(1).getByText('GitLab.com', { exact: true })).toBeVisible()
  await expect(rows.nth(1).getByText('Not connected', { exact: true })).toBeVisible()
  await expect(rows.nth(1).getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  await expect(rows.nth(2).getByText('Self-hosted', { exact: true })).toBeVisible()
  await expect(rows.nth(2).getByText('git.example.test/gitlab · Credential expired. Reconnect to continue', { exact: true })).toBeVisible()
  await rows.nth(0).getByRole('button', { name: 'Manage', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('captures the accounts section in light and dark themes and with the dialog open', async ({ page }) => {
  await openAccounts(page, 'zh')
  await expect(page.getByText('@fixture-user · OAuth', { exact: true })).toBeVisible()
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  await page.screenshot({ path: test.info().outputPath('accounts-light.png') })
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark') })
  await page.screenshot({ path: test.info().outputPath('accounts-dark.png') })
  await page.evaluate(() => { document.documentElement.removeAttribute('data-theme') })
  await page.getByRole('listitem').nth(0).getByRole('button', { name: '管理', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  await page.screenshot({ path: test.info().outputPath('accounts-dialog.png') })
})

test('captures the GitLab dialog, the retire modal steps, and the clear button', async ({ page }) => {
  await openAccounts(page, 'zh')
  const settle = () => page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  await settle()
  // The settings section showing the new clear-grant entry under the card.
  await page.screenshot({ path: test.info().outputPath('accounts-clear-button.png') })
  // GitLab self-hosted dialog with the invalid credential and both GitLab notes.
  await page.getByRole('listitem').nth(2).getByRole('button', { name: '连接', exact: true }).click()
  const gitlabDialog = page.getByRole('dialog', { name: 'GitLab 账号' })
  await expect(gitlabDialog).toBeVisible()
  await expect(gitlabDialog.getByText(/凭据已失效|Credential no longer works/)).toBeVisible()
  await expect(gitlabDialog.getByText('通知仅包含待你审阅的合并请求，以及已加载的你创建的合并请求的状态变化')).toBeVisible()
  await settle()
  await page.screenshot({ path: test.info().outputPath('gitlab-dialog-invalid.png') })
  await page.keyboard.press('Escape')
  await expect(gitlabDialog).toBeHidden()
  // Retire modal step 1 with the invalid-URL error, then step 2.
  await page.getByRole('button', { name: '清除已移除实例的登录信息…', exact: true }).click()
  const retire = page.getByRole('dialog', { name: '清除已移除实例的登录信息' })
  await expect(retire).toBeVisible()
  await retire.getByLabel('实例地址').fill('git.example.com')
  await retire.getByRole('button', { name: '下一步' }).click()
  await expect(retire.getByRole('alert')).toBeVisible()
  await settle()
  await page.screenshot({ path: test.info().outputPath('retire-step1-error.png') })
  await retire.getByLabel('实例地址').fill('https://old.example')
  await retire.getByRole('button', { name: '下一步' }).click()
  await expect(retire.getByText('https://old.example', { exact: true })).toBeVisible()
  await settle()
  await page.screenshot({ path: test.info().outputPath('retire-step2.png') })
})

import { expect, test, type Page } from '@playwright/test'

async function openLogin(page: Page, provider: string, options = '') {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(`/?scenario=${provider === 'GitLab' ? 'gitlab-oauth' : 'anonymous'}&lang=en&desktop=${options.includes('desktop=fail') ? 'fail' : 'mock'}${options.replace('&desktop=fail', '')}`)
  if (provider === 'GitLab') await expect(page.getByRole('button', { name: /Fixture merge request/ })).toBeVisible()
  await page.getByRole('button', { name: 'Platform authentication', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `${provider} account` })
  await expect(dialog.getByRole('radio', { name: `${provider} OAuth (device login)` })).toBeEnabled()
  return dialog
}

for (const provider of ['GitHub', 'GitLab']) {
  test(`${provider}: requests a code, opens once, copies, survives dialog reopening and completes login`, async ({ page }) => {
    const dialog = await openLogin(page, provider)
    await dialog.getByRole('radio', { name: `${provider} OAuth (device login)` }).click()
    await expect(dialog.getByText('E2E-CODE', { exact: true })).toBeVisible()
    const url = provider === 'GitLab' ? 'https://git.example.test/gitlab/oauth/device?user_code=E2E-CODE' : 'https://github.com/login/device'
    await expect(page.getByLabel('Native events')).toHaveText(JSON.stringify([`open:${url}`]))
    await dialog.getByRole('button', { name: 'Copy device code' }).click()
    await expect(dialog.getByText('Device code copied.')).toBeVisible()
    await expect(page.getByLabel('Native events')).toHaveText(JSON.stringify([`open:${url}`, 'copy:E2E-CODE']))
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Platform authentication', exact: true }).click()
    await expect(dialog.getByText('E2E-CODE', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Native events')).toHaveText(JSON.stringify([`open:${url}`, 'copy:E2E-CODE']))
    await page.screenshot({ path: test.info().outputPath(`${provider}-device-login.png`), animations: 'disabled' })
    const id = await page.getByLabel('Fixture ID').textContent()
    await page.request.post('/__test/approve', { data: { id } })
    await expect(dialog.getByRole('radio', { name: `${provider} OAuth (device login)` })).toBeChecked()
    await expect(dialog.getByText('E2E-CODE', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('OAuth connected.')).toBeVisible()
    expect(await dialog.innerText()).not.toContain('e2e-sentinel-')
  })
  for (const outcome of ['denied', 'expired']) {
    test(`${provider}: reports ${outcome} and permits an explicit retry`, async ({ page }) => {
      const dialog = await openLogin(page, provider, `&outcome=${outcome}`)
      const oauth = dialog.getByRole('radio', { name: `${provider} OAuth (device login)` })
      await oauth.click()
      await expect(dialog.getByText(outcome === 'denied' ? 'Authorization was declined. Choose OAuth to try again.' : 'The device code expired. Choose OAuth to request a new code.')).toBeVisible()
      await expect(oauth).toBeEnabled()
      await expect(dialog.getByText('E2E-CODE', { exact: true })).toHaveCount(0)
    })
  }
  test(`${provider}: native failures and provider unload preserve manual authorization and cancellation`, async ({ page }) => {
    const dialog = await openLogin(page, provider, '&desktop=fail&clipboard=fail')
    await dialog.getByRole('radio', { name: `${provider} OAuth (device login)` }).click()
    await expect(dialog.getByText('Could not open the browser. Use the link below to continue.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Copy device code' }).click()
    await expect(dialog.getByText('Could not copy. Select and copy the code above.')).toBeVisible()
    // Simulate provider unload outside the modal without navigating or opening a real browser.
    await page.getByRole('button', { name: 'Unload native fixture' }).evaluate((button: HTMLButtonElement) => button.click())
    await expect(dialog.getByRole('link', { name: provider === 'GitLab' ? 'Continue authorization on GitLab' : 'Open GitHub and enter this code' })).toBeVisible()
    await expect(dialog.getByText('Open the authorization page below to continue.')).toBeVisible()
    await dialog.locator('[role="status"]').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog.getByText('Login cancelled.')).toBeVisible()
    await expect(dialog.getByRole('radio', { name: `${provider} OAuth (device login)` })).not.toBeChecked()
  })
}

for (const method of ['cli', 'oauth']) {
  test(`GitLab: restores ${method} from a persisted signed-out marker without a blocking error`, async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.goto('/?scenario=gitlab-com-signed-out&lang=en&desktop=mock')
    await page.getByRole('button', { name: 'Platform authentication', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'GitLab account' })
    await expect(dialog.getByText('Disconnected', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    const radio = dialog.getByRole('radio', { name: method === 'cli' ? 'GitLab CLI (glab)' : 'GitLab OAuth (device login)', exact: true })
    await expect(radio).toBeEnabled()
    await radio.click()
    if (method === 'oauth') {
      await expect(dialog.getByText('E2E-CODE', { exact: true })).toBeVisible()
      const id = await page.getByLabel('Fixture ID').textContent()
      await page.request.post('/__test/approve', { data: { id } })
    }
    await expect(radio).toBeChecked()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: /Fixture merge request/ })).toBeVisible()
  })
}

test('GitLab: OAuth escapes a CLI cooldown, while returning to CLI retains its cooldown', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto('/?scenario=gitlab-com-rate-limit&lang=en')
  await expect(page.getByRole('button', { name: /Fixture merge request/ })).toBeVisible()
  await page.getByRole('button', { name: 'Platform authentication', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'GitLab account' })
  const oauth = dialog.getByRole('radio', { name: 'GitLab OAuth (device login)', exact: true })
  const cli = dialog.getByRole('radio', { name: 'GitLab CLI (glab)', exact: true })
  await expect(oauth).toBeChecked()
  for (let i = 0; i < 2; i++) {
    await cli.click()
    await expect(dialog.getByRole('alert')).toHaveText('git/rate-limited')
    await expect(cli).toBeChecked()
    await oauth.click()
    await expect(oauth).toBeChecked()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(dialog.getByText('E2E-CODE', { exact: true })).toHaveCount(0)
  }
  const id = await page.getByLabel('Fixture ID').textContent()
  const info = await page.request.post('/__test/inspect', { data: { id } }).then(response => response.json())
  expect(info.calls.filter((call: string) => call === 'quota:glab')).toHaveLength(1)
  expect(info.calls).not.toContain('remote-login')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /Fixture merge request/ })).toBeVisible()
})

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

export interface RemoteCreateValues {
  readonly title: string
  readonly body: string
  readonly headOwner: string
  readonly headRepo: string
  readonly headRef: string
  readonly baseRef: string
}

/**
 * Create-PR form: pushed branches only, fork head fields optional. Field
 * state lives here and resets on close; the surface owns the write.
 */
export function RemoteCreateDialog({ open, writable, onSubmit, onClose, t }: {
  readonly open: boolean
  readonly writable: boolean
  readonly onSubmit: (values: RemoteCreateValues) => void
  readonly onClose: () => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [headOwner, setHeadOwner] = useState('')
  const [headRepo, setHeadRepo] = useState('')
  const [headRef, setHeadRef] = useState('')
  const [baseRef, setBaseRef] = useState('main')

  const close = (): void => {
    setTitle(''); setBody(''); setHeadOwner(''); setHeadRepo(''); setHeadRef(''); setBaseRef('main')
    onClose()
  }
  const submit = (): void => {
    if (title.trim() === '' || headRef.trim() === '' || baseRef.trim() === '') return
    onSubmit({ title, body, headOwner, headRepo, headRef, baseRef })
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('remote.createPr')}
      closeLabel={t('branch.cancel')}
      footer={(
        <>
          <Button variant="outline" onClick={close}>{t('branch.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!writable || title.trim() === '' || headRef.trim() === '' || baseRef.trim() === ''}
            onClick={submit}
          >
            {t('remote.createPr')}
          </Button>
        </>
      )}
    >
      <div className={css.createBody}>
        <p className={css.note}>{t('remote.pushedOnly')}</p>
        <label className={css.createField}>
          <span>{t('remote.prTitle')}</span>
          <Input
            required
            value={title}
            aria-label={t('remote.prTitle')}
            onChange={event => { setTitle(event.target.value) }}
          />
        </label>
        <label className={css.createField}>
          <span>{t('remote.headOwner')}</span>
          <Input
            value={headOwner}
            aria-label={t('remote.headOwner')}
            onChange={event => { setHeadOwner(event.target.value) }}
          />
        </label>
        <label className={css.createField}>
          <span>{t('remote.headRepo')}</span>
          <Input
            value={headRepo}
            aria-label={t('remote.headRepo')}
            onChange={event => { setHeadRepo(event.target.value) }}
          />
        </label>
        <label className={css.createField}>
          <span>{t('remote.headRef')}</span>
          <Input
            required
            value={headRef}
            aria-label={t('remote.headRef')}
            onChange={event => { setHeadRef(event.target.value) }}
          />
        </label>
        <label className={css.createField}>
          <span>{t('remote.baseRef')}</span>
          <Input
            required
            value={baseRef}
            aria-label={t('remote.baseRef')}
            onChange={event => { setBaseRef(event.target.value) }}
          />
        </label>
        <label className={css.createField}>
          <span>{t('remote.body')}</span>
          <textarea
            value={body}
            aria-label={t('remote.body')}
            rows={3}
            onChange={event => { setBody(event.target.value) }}
          />
        </label>
      </div>
    </Modal>
  )
}

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { remoteTargetLabel, type RemoteTarget } from './remote-view.ts'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

export interface RemoteCreateValues {
  readonly title: string
  readonly body: string
  readonly headOwner: string
  readonly headRepo: string
  readonly headRef: string
  readonly baseRef: string
  /** GitLab source project (same instance); defaults to the current target. */
  readonly source?: RemoteTarget & { readonly provider: 'gitlab' }
  readonly draft?: boolean
}

/**
 * Create-PR form: pushed branches only, fork head fields optional on GitHub;
 * GitLab targets pick a same-instance source project and may mark the MR draft.
 * Field state lives here and resets on close; the surface owns the write.
 */
export function RemoteCreateDialog({ open, writable, gitlabSources, onSubmit, onClose, t }: {
  readonly open: boolean
  readonly writable: boolean
  /** GitLab remotes sharing the target instance; undefined renders the GitHub fork fields. */
  readonly gitlabSources?: readonly (RemoteTarget & { readonly provider: 'gitlab' })[] | undefined
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
  const [sourceIndex, setSourceIndex] = useState(0)
  const [draft, setDraft] = useState(false)
  const gitlab = gitlabSources !== undefined

  const close = (): void => {
    setTitle(''); setBody(''); setHeadOwner(''); setHeadRepo(''); setHeadRef(''); setBaseRef('main'); setSourceIndex(0); setDraft(false)
    onClose()
  }
  const submit = (): void => {
    if (title.trim() === '' || headRef.trim() === '' || baseRef.trim() === '') return
    const source = gitlab ? gitlabSources[sourceIndex] ?? gitlabSources[0] : undefined
    if (gitlab && source === undefined) return
    onSubmit({ title, body, headOwner, headRepo, headRef, baseRef, ...(source === undefined ? {} : { source }), ...(gitlab ? { draft } : {}) })
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t(gitlab ? 'gitlab.create' : 'remote.createPr')}
      closeLabel={t('branch.cancel')}
      footer={(
        <>
          <Button variant="outline" onClick={close}>{t('branch.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!writable || title.trim() === '' || headRef.trim() === '' || baseRef.trim() === '' || (gitlab && gitlabSources.length === 0)}
            onClick={submit}
          >
            {t(gitlab ? 'gitlab.submit' : 'remote.createPr')}
          </Button>
        </>
      )}
    >
      <div className={css.createBody}>
        <p className={css.note}>{t('remote.pushedOnly')}</p>
        {gitlab && (
          <label className={css.createField}>
            <span>{t('gitlab.source')}</span>
            <select
              value={sourceIndex}
              aria-label={t('gitlab.source')}
              onChange={event => { setSourceIndex(Number(event.target.value)) }}
            >
              {gitlabSources.map((source, index) => (
                <option key={`${source.instance}/${source.path}`} value={index}>{remoteTargetLabel(source)}</option>
              ))}
            </select>
          </label>
        )}
        <label className={css.createField}>
          <span>{t('remote.prTitle')}</span>
          <Input
            required
            value={title}
            aria-label={t('remote.prTitle')}
            onChange={event => { setTitle(event.target.value) }}
          />
        </label>
        {!gitlab && (
          <>
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
          </>
        )}
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
        {gitlab && (
          <label className={css.createField}>
            <span>{t('remote.draft')}</span>
            <input
              type="checkbox"
              checked={draft}
              aria-label={t('remote.draft')}
              onChange={event => { setDraft(event.target.checked) }}
            />
          </label>
        )}
      </div>
    </Modal>
  )
}

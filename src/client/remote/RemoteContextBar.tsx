import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Menu, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutline14 } from '../../compat/dsh-icons.tsx'
import type { BoundRemote } from '../../remote/git.ts'
import type { RemoteRepository } from '../../remote/provider.ts'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

export type RemoteListState = 'open' | 'closed' | 'all'

const LIST_STATES: readonly RemoteListState[] = ['open', 'closed', 'all']

function listStateKey(state: RemoteListState): GitLocaleKey {
  if (state === 'closed') return 'remote.stateClosed'
  if (state === 'all') return 'remote.stateAll'
  return 'remote.stateOpen'
}

/** Remote target selector and the list-state filter. */
export function RemoteContextBar({ remotes, target, listState, busy, onSelect, onListState, t }: {
  readonly remotes: readonly BoundRemote[]
  readonly target: RemoteRepository | undefined
  readonly listState: RemoteListState
  readonly busy: boolean
  readonly onSelect: (remote: BoundRemote) => void
  readonly onListState: (state: RemoteListState) => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const items = useMemo((): readonly MenuEntry[] =>
    remotes.map(remote => ({
      id: remote.name,
      label: `${remote.name} · ${remote.identity.owner}/${remote.identity.repo}`,
    })), [remotes])
  const selected = target === undefined
    ? undefined
    : remotes.find(remote => remote.identity.owner === target.owner && remote.identity.repo === target.repo)
  const chipLabel = selected === undefined
    ? t('remote.repository')
    : `${selected.name} · ${selected.identity.owner}/${selected.identity.repo}`

  const onMenuSelect = (id: string): void => {
    setMenuOpen(false)
    const remote = remotes.find(entry => entry.name === id)
    if (remote !== undefined) onSelect(remote)
  }

  return (
    <div className={css.contextBar}>
      <Menu
        open={menuOpen}
        items={items}
        selectedId={selected?.name}
        onSelect={onMenuSelect}
        onClose={() => { setMenuOpen(false) }}
        anchor={(
          <button
            type="button"
            className={css.repoChip}
            aria-label={t('remote.repository')}
            aria-expanded={menuOpen}
            aria-disabled={busy || remotes.length === 0 || undefined}
            onClick={() => {
              if (busy || remotes.length === 0) return
              setMenuOpen(open => !open)
            }}
          >
            <span className={css.repoChipText}>{chipLabel}</span>
            <span className={css.repoChevron}><IconChevronDownOutline14 size={12} /></span>
          </button>
        )}
      />
      <div className={css.statePills}>
        {LIST_STATES.map(state => (
          <Pill
            key={state}
            active={listState === state}
            disabled={busy}
            onClick={() => { onListState(state) }}
          >
            {t(listStateKey(state))}
          </Pill>
        ))}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useSettingsStore } from '../../stores/settings-store'
import styles from './SettingsPage.module.css'

const defaultDatabaseIds = new Set([
  'crossref',
  'openalex',
  'arxiv',
  'semantic_scholar',
  'europe_pmc',
  'trdizin',
  'duckduckgo',
])

const GITHUB_REPO_URL = 'https://github.com/temasictfic/Atf-I-Memnu'

export default function SettingsPage() {
  const settings = useSettingsStore(s => s.settings)
  const saveStatus = useSettingsStore(s => s.saveStatus)
  const { toggleDatabase, updateSetting, removeDatabase, updateApiKey } = useSettingsStore.getState()
  const [cacheOpenMessage, setCacheOpenMessage] = useState<string | null>(null)

  const tierLabel = (t: number) => t === 2 ? 'Fallback' : `Tier ${t}`

  const handleOpenCacheFolder = async () => {
    try {
      const result = await window.electronAPI.openCacheFolder()
      setCacheOpenMessage(result.ok ? `Opened: ${result.path}` : 'Failed to open cache folder')
      if (!result.ok && result.error) {
        console.error('Failed to open cache folder:', result.error)
      }
    } catch (error) {
      console.error('Failed to open cache folder:', error)
      setCacheOpenMessage('Failed to open cache folder')
    }
  }

  const handleOpenGithubRepo = () => {
    window.open(GITHUB_REPO_URL, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className={styles['settings-page']}>
      <div className={styles['settings-container']}>
        {saveStatus !== 'idle' && (
          <div className={styles['save-toast']}>
            <span className={`${styles['save-toast-inner']} ${styles[`save-toast-inner--${saveStatus}`]}`}>
              {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : 'Save failed'}
            </span>
          </div>
        )}

        <div className={styles['settings-header']}>
          <h1 className={styles['settings-title']}>Settings</h1>
          <button
            type="button"
            className={styles['header-icon-button']}
            onClick={handleOpenGithubRepo}
            title="Open GitHub Repository"
            aria-label="Open GitHub Repository"
          >
            <svg viewBox="0 0 24 24" className={styles['header-icon']} aria-hidden="true">
              <path d="M12 1.5a10.5 10.5 0 0 0-3.32 20.47c.52.09.7-.22.7-.5v-1.93c-2.85.62-3.45-1.2-3.45-1.2-.46-1.18-1.12-1.5-1.12-1.5-.92-.63.07-.62.07-.62 1.02.07 1.56 1.04 1.56 1.04.9 1.54 2.36 1.1 2.94.84.09-.66.35-1.1.64-1.36-2.27-.26-4.66-1.14-4.66-5.05 0-1.12.4-2.03 1.04-2.75-.1-.26-.45-1.32.1-2.75 0 0 .86-.28 2.8 1.05a9.82 9.82 0 0 1 5.1 0c1.95-1.33 2.8-1.05 2.8-1.05.55 1.43.2 2.5.1 2.75.65.72 1.04 1.63 1.04 2.75 0 3.92-2.4 4.78-4.68 5.03.36.32.68.94.68 1.9v2.82c0 .28.18.59.7.5A10.5 10.5 0 0 0 12 1.5Z" />
            </svg>
          </button>
        </div>

        {/* Databases Section */}
        <section className={styles['settings-section']}>
          <h2 className={styles['section-title']}>Search Databases</h2>
          <p className={styles['section-desc']}>Enable or disable databases to search when verifying sources.</p>

          <div className={styles['db-list']}>
            {settings.databases.map(db => (
              <div key={db.id} className={styles['db-row']}>
                <label className={styles['db-toggle']}>
                  <input type="checkbox" checked={db.enabled} onChange={() => toggleDatabase(db.id)} />
                  <span className={styles['toggle-track']}><span className={styles['toggle-thumb']} /></span>
                </label>
                <div className={styles['db-info']}>
                  <span className={styles['db-name']}>{db.name}</span>
                  <span className={styles['db-type']}>API · {tierLabel(db.tier)}</span>
                </div>
                {!defaultDatabaseIds.has(db.id) && (
                  <button className={styles['db-remove']} onClick={() => removeDatabase(db.id)} title="Remove">&#10005;</button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* API Keys Section */}
        <section className={styles['settings-section']}>
          <h2 className={styles['section-title']}>API Keys</h2>
          <p className={styles['section-desc']}>Optional API keys for improved rate limits and access.</p>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>OpenAlex Email</span>
              <span className={styles['setting-desc']}>Optional - registered email for polite pool access</span>
            </div>
            <input
              type="text"
              className={`${styles['setting-input']} ${styles['setting-input-wide']}`}
              value={settings.api_keys?.openalex ?? ''}
              placeholder="Optional"
              onChange={e => updateApiKey('openalex', e.target.value)}
            />
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>Semantic Scholar API Key</span>
              <span className={styles['setting-desc']}>Optional - increases rate limits</span>
            </div>
            <input
              type="password"
              className={`${styles['setting-input']} ${styles['setting-input-wide']}`}
              value={settings.api_keys?.semantic_scholar ?? ''}
              placeholder="Optional"
              onChange={e => updateApiKey('semantic_scholar', e.target.value)}
            />
          </div>
        </section>

        {/* Search Configuration */}
        <section className={styles['settings-section']}>
          <h2 className={styles['section-title']}>Search Configuration</h2>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>Search Timeout (seconds)</span>
              <span className={styles['setting-desc']}>Max time per database per source</span>
            </div>
            <input type="number" className={styles['setting-input']} value={settings.search_timeout}
              onChange={e => updateSetting('search_timeout', Number(e.target.value))} min={5} max={120} />
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>Max Concurrent API Calls</span>
              <span className={styles['setting-desc']}>Parallel API requests limit</span>
            </div>
            <input type="number" className={styles['setting-input']} value={settings.max_concurrent_apis}
              onChange={e => updateSetting('max_concurrent_apis', Number(e.target.value))} min={1} max={20} />
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>Concurrent Sources per PDF</span>
              <span className={styles['setting-desc']}>How many references verify in parallel for one PDF</span>
            </div>
            <input type="number" className={styles['setting-input']} value={settings.max_concurrent_sources_per_pdf}
              onChange={e => updateSetting('max_concurrent_sources_per_pdf', Number(e.target.value))} min={1} max={20} />
          </div>
        </section>

        <section className={styles['settings-section']}>
          <h2 className={styles['section-title']}>Cache</h2>
          <p className={styles['section-desc']}>Open the folder where parsed and verification cache files are stored.</p>

          <div className={styles['action-row']}>
            <button type="button" className={styles['action-button']} onClick={handleOpenCacheFolder}>
              Open Cache Folder
            </button>
            {cacheOpenMessage && <span className={styles['action-message']}>{cacheOpenMessage}</span>}
          </div>
        </section>
      </div>
    </div>
  )
}

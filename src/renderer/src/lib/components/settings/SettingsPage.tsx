import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { defaultDatabaseIds, useSettingsStore } from '../../stores/settings-store'
import styles from './SettingsPage.module.css'
import pkg from '../../../../../../package.json'

const GITHUB_REPO_URL = 'https://github.com/temasictfic/Atf-I-Memnu'

const OPENAIRE_TOKEN_PAGE_URL = 'https://develop.openaire.eu/personal-token'
// OpenAIRE refresh tokens live for 1 month. Surface the warning state a week
// before expiry so the user has a realistic chance to rotate without losing
// the rate-limit boost mid-batch.
const OPENAIRE_TOKEN_LIFETIME_DAYS = 30
const OPENAIRE_WARN_DAYS_BEFORE_EXPIRY = 7

function daysUntilOpenaireExpiry(savedAt: string | undefined): number | null {
  if (!savedAt) return null
  const saved = new Date(savedAt)
  if (Number.isNaN(saved.getTime())) return null
  const expiry = new Date(saved)
  expiry.setUTCDate(expiry.getUTCDate() + OPENAIRE_TOKEN_LIFETIME_DAYS)
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.round((expiry.getTime() - Date.now()) / msPerDay)
}

export default function SettingsPage() {
  const { t } = useTranslation()
  const settings = useSettingsStore(s => s.settings)
  const saveStatus = useSettingsStore(s => s.saveStatus)
  const {
    toggleDatabase,
    updateSetting,
    removeDatabase,
    reorderDatabases,
    updateApiKey,
    connectOpenaire,
    disconnectOpenaire,
  } = useSettingsStore.getState()
  const [cacheOpenMessage, setCacheOpenMessage] = useState<string | null>(null)
  const [scholarSessionMessage, setScholarSessionMessage] = useState<string | null>(null)
  const [scholarSessionBusy, setScholarSessionBusy] = useState(false)
  const [openaireTokenInput, setOpenaireTokenInput] = useState('')
  const [openaireError, setOpenaireError] = useState<string | null>(null)
  const [openaireBusy, setOpenaireBusy] = useState(false)
  const [dragDbId, setDragDbId] = useState<string | null>(null)
  const [dragOverDbId, setDragOverDbId] = useState<string | null>(null)

  const openaireConnected = !!settings.api_keys?.openaire
  const openaireDaysLeft = daysUntilOpenaireExpiry(settings.openaire_token_saved_at)
  const openaireExpiringSoon =
    openaireDaysLeft !== null && openaireDaysLeft <= OPENAIRE_WARN_DAYS_BEFORE_EXPIRY

  const handleOpenaireConnect = async () => {
    const token = openaireTokenInput.trim()
    if (!token) return
    setOpenaireBusy(true)
    setOpenaireError(null)
    const res = await connectOpenaire(token)
    setOpenaireBusy(false)
    if (res.ok) {
      setOpenaireTokenInput('')
    } else {
      setOpenaireError(res.error ?? t('settings.openaire.validationError'))
    }
  }

  const handleOpenairePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      setOpenaireTokenInput(text.trim())
      setOpenaireError(null)
    } catch {
      setOpenaireError(t('settings.openaire.pasteFailed'))
    }
  }

  const handleOpenCacheFolder = async () => {
    try {
      const result = await window.electronAPI.openCacheFolder()
      setCacheOpenMessage(result.ok ? t('settings.cache.openedAt', { path: result.path }) : t('settings.cache.openFailed'))
      if (!result.ok && result.error) {
        console.error('Failed to open cache folder:', result.error)
      }
    } catch (error) {
      console.error('Failed to open cache folder:', error)
      setCacheOpenMessage(t('settings.cache.openFailed'))
    }
  }

  const handleClearScholarSession = async () => {
    setScholarSessionBusy(true)
    setScholarSessionMessage(null)
    try {
      await window.electronAPI.clearScholarSession()
      setScholarSessionMessage(t('settings.cache.scholarSessionCleared'))
    } catch (error) {
      console.error('Failed to clear Scholar session:', error)
      setScholarSessionMessage(t('settings.cache.scholarSessionFailed'))
    } finally {
      setScholarSessionBusy(false)
    }
  }

  const handleOpenGithubRepo = () => {
    window.electronAPI.openExternal(GITHUB_REPO_URL).catch(err => console.error('Failed to open URL:', err))
  }

  const handleOpenExternalLink = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    window.electronAPI.openExternal(url).catch(err => console.error('Failed to open URL:', err))
  }

  return (
    <div className={styles['settings-page']}>
      <div className={styles['settings-container']}>
        <div className={styles['save-toast']}>
          {saveStatus !== 'idle' && (
            <span className={`${styles['save-toast-inner']} ${styles[`save-toast-inner--${saveStatus}`]}`}>
              {saveStatus === 'saving' ? t('settings.save.saving') : saveStatus === 'saved' ? t('settings.save.saved') : t('settings.save.error')}
            </span>
          )}
        </div>

        <div className={styles['settings-header']}>
          <h1 className={styles['settings-title']}>{t('settings.title')}</h1>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className={styles['header-icon-button']}
            onClick={() => updateSetting('language', (settings.language ?? 'tr') === 'tr' ? 'en' : 'tr')}
            title={t('settings.language.label')}
            aria-label={t('settings.language.label')}
            style={{ padding: 0, overflow: 'hidden' }}
          >
            {(settings.language ?? 'tr') === 'tr' ? (
              <svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true">
                <rect width="24" height="16" fill="#e30a17" />
                <circle cx="9" cy="8" r="3.5" fill="#fff" />
                <circle cx="9.9" cy="8" r="2.8" fill="#e30a17" />
                <polygon fill="#fff" points="15,6 15.447,7.385 16.902,7.382 15.723,8.235 16.176,9.618 15,8.76 13.824,9.618 14.277,8.235 13.098,7.382 14.553,7.385" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true">
                <rect width="24" height="16" fill="#012169" />
                <path d="M0,0 L24,16 M24,0 L0,16" stroke="#fff" strokeWidth="3.2" />
                <path d="M0,0 L24,16 M24,0 L0,16" stroke="#c8102e" strokeWidth="1.6" clipPath="inset(0)" />
                <path d="M12,0 V16 M0,8 H24" stroke="#fff" strokeWidth="5.3" />
                <path d="M12,0 V16 M0,8 H24" stroke="#c8102e" strokeWidth="3.2" />
              </svg>
            )}
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ marginRight: 10, color: '#78716c', fontSize: 13, fontWeight: 700 }}>v{pkg.version}</span>
          <button
            type="button"
            className={styles['header-icon-button']}
            onClick={handleOpenGithubRepo}
            title={t('settings.githubRepo')}
            aria-label={t('settings.githubRepo')}
          >
            <svg viewBox="0 0 24 24" className={styles['header-icon']} aria-hidden="true">
              <path d="M12 1.5a10.5 10.5 0 0 0-3.32 20.47c.52.09.7-.22.7-.5v-1.93c-2.85.62-3.45-1.2-3.45-1.2-.46-1.18-1.12-1.5-1.12-1.5-.92-.63.07-.62.07-.62 1.02.07 1.56 1.04 1.56 1.04.9 1.54 2.36 1.1 2.94.84.09-.66.35-1.1.64-1.36-2.27-.26-4.66-1.14-4.66-5.05 0-1.12.4-2.03 1.04-2.75-.1-.26-.45-1.32.1-2.75 0 0 .86-.28 2.8 1.05a9.82 9.82 0 0 1 5.1 0c1.95-1.33 2.8-1.05 2.8-1.05.55 1.43.2 2.5.1 2.75.65.72 1.04 1.63 1.04 2.75 0 3.92-2.4 4.78-4.68 5.03.36.32.68.94.68 1.9v2.82c0 .28.18.59.7.5A10.5 10.5 0 0 0 12 1.5Z" />
            </svg>
          </button>
        </div>

        {/* Databases Section */}
        <section className={styles['settings-section']}>
          <div className={styles['section-header-row']}>
            <div>
              <h2 className={styles['section-title']}>{t('settings.databases.title')}</h2>
              <p className={styles['section-desc']}>{t('settings.databases.description')}</p>
            </div>
          </div>

          <div className={styles['db-list']}>
            {settings.databases.map((db, i) => {
              const rowClass = [
                styles['db-row'],
                dragDbId === db.id ? styles['db-row-dragging'] : '',
                dragOverDbId === db.id && dragDbId !== db.id ? styles['db-row-over'] : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <div
                  key={db.id}
                  className={rowClass}
                  draggable
                  onDragStart={e => {
                    setDragDbId(db.id)
                    e.dataTransfer.effectAllowed = 'move'
                    // Required by Firefox to actually start a drag; the value is unused.
                    e.dataTransfer.setData('text/plain', db.id)
                  }}
                  onDragOver={e => {
                    if (!dragDbId) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragOverDbId !== db.id) setDragOverDbId(db.id)
                  }}
                  onDragLeave={() => {
                    setDragOverDbId(prev => (prev === db.id ? null : prev))
                  }}
                  onDrop={e => {
                    e.preventDefault()
                    if (dragDbId && dragDbId !== db.id) {
                      const from = settings.databases.findIndex(x => x.id === dragDbId)
                      const to = settings.databases.findIndex(x => x.id === db.id)
                      if (from >= 0 && to >= 0) reorderDatabases(from, to)
                    }
                    setDragDbId(null)
                    setDragOverDbId(null)
                  }}
                  onDragEnd={() => {
                    setDragDbId(null)
                    setDragOverDbId(null)
                  }}
                >
                  <span className={styles['db-order']}>{i + 1}</span>
                  <span
                    className={styles['db-drag-handle']}
                    title={t('settings.databases.dragHandle')}
                    aria-label={`${t('settings.databases.dragHandle')}: ${db.name}`}
                  >
                    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
                      <circle cx="3" cy="3" r="1.3" fill="currentColor" />
                      <circle cx="7" cy="3" r="1.3" fill="currentColor" />
                      <circle cx="3" cy="8" r="1.3" fill="currentColor" />
                      <circle cx="7" cy="8" r="1.3" fill="currentColor" />
                      <circle cx="3" cy="13" r="1.3" fill="currentColor" />
                      <circle cx="7" cy="13" r="1.3" fill="currentColor" />
                    </svg>
                  </span>
                  <label className={styles['db-toggle']}>
                    <input type="checkbox" checked={db.enabled} onChange={() => toggleDatabase(db.id)} />
                    <span className={styles['toggle-track']}><span className={styles['toggle-thumb']} /></span>
                  </label>
                  <div className={styles['db-info']}>
                    <span className={styles['db-name']}>{db.name}</span>
                    <span className={styles['db-type']}>
                      {t(`settings.databases.descriptions.${db.id}`, { defaultValue: '' })}
                    </span>
                  </div>
                  {!defaultDatabaseIds.has(db.id) && (
                    <button className={styles['db-remove']} onClick={() => removeDatabase(db.id)} title={t('settings.databases.removeTitle')}>&#10005;</button>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        {/* API Keys Section */}
        <section className={styles['settings-section']}>
          <div className={styles['section-header-row']}>
            <div>
              <h2 className={styles['section-title']}>{t('settings.apiKeys.title')}</h2>
              <p className={styles['section-desc']}>{t('settings.apiKeys.description')}</p>
            </div>
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.apiKeys.politeEmailLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.apiKeys.politeEmailDesc')}</span>
            </div>
            <input
              type="text"
              className={`${styles['setting-input']} ${styles['setting-input-wide']}`}
              value={settings.polite_pool_email ?? ''}
              placeholder={t('settings.apiKeys.politeEmailPlaceholder')}
              onChange={e => updateSetting('polite_pool_email', e.target.value)}
            />
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.apiKeys.semanticScholarLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.apiKeys.semanticScholarDesc')}</span>
            </div>
            <a
              className={styles['request-key-link']}
              href="https://www.semanticscholar.org/product/api#api-key-form"
              onClick={handleOpenExternalLink('https://www.semanticscholar.org/product/api#api-key-form')}
            >
              {t('settings.apiKeys.requestFreeKey')}
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 2h5v5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M7 2L2 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </a>
            <input
              type="password"
              className={`${styles['setting-input']} ${styles['setting-input-wide']}`}
              value={settings.api_keys?.semantic_scholar ?? ''}
              placeholder={t('settings.apiKeys.semanticScholarPlaceholder')}
              onChange={e => updateApiKey('semantic_scholar', e.target.value)}
            />
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.apiKeys.pubmedLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.apiKeys.pubmedDesc')}</span>
            </div>
            <a
              className={styles['request-key-link']}
              href="https://www.ncbi.nlm.nih.gov/account/settings/"
              onClick={handleOpenExternalLink('https://www.ncbi.nlm.nih.gov/account/settings/')}
            >
              {t('settings.apiKeys.requestPubmedKey')}
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 2h5v5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M7 2L2 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </a>
            <input
              type="password"
              className={`${styles['setting-input']} ${styles['setting-input-wide']}`}
              value={settings.api_keys?.pubmed ?? ''}
              placeholder={t('settings.apiKeys.optional')}
              onChange={e => updateApiKey('pubmed', e.target.value)}
            />
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.apiKeys.baseLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.apiKeys.baseDesc')}</span>
            </div>
            <a
              className={styles['request-key-link']}
              href="https://www.base-search.net/about/en/contact.php"
              onClick={handleOpenExternalLink('https://www.base-search.net/about/en/contact.php')}
            >
              {t('settings.apiKeys.requestBaseAccess')}
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 2h5v5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M7 2L2 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </a>
            <input
              type="password"
              className={`${styles['setting-input']} ${styles['setting-input-wide']}`}
              value={settings.api_keys?.base ?? ''}
              placeholder={t('settings.apiKeys.basePlaceholder')}
              onChange={e => updateApiKey('base', e.target.value)}
            />
          </div>

        </section>

        {/* OpenAIRE Connection */}
        <section className={styles['settings-section']}>
          <div className={styles['section-header-row']}>
            <div>
              <h2 className={styles['section-title']}>{t('settings.openaire.title')}</h2>
              <p className={styles['section-desc']}>{t('settings.openaire.description')}</p>
            </div>
            {!openaireConnected && (
              <button
                type="button"
                className={`${styles['action-button']} ${styles['action-button-portal']}`}
                onClick={() =>
                  window.electronAPI
                    .openExternal(OPENAIRE_TOKEN_PAGE_URL)
                    .catch(err => console.error('Failed to open URL:', err))
                }
              >
                {t('settings.openaire.openTokenPage')}
              </button>
            )}
          </div>

          <div className={styles['openaire-card']}>
            {openaireConnected ? (
              <div
                className={`${styles['openaire-status-row']} ${openaireExpiringSoon ? styles['openaire-status-row--warn'] : ''}`}
              >
                <svg
                  className={styles['openaire-status-check']}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414L8.414 15 3.293 9.879a1 1 0 011.414-1.414L8.414 12.17l6.879-6.878a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
                <span className={styles['openaire-status-text']}>
                  <strong>{t('settings.openaire.connected')}</strong>
                  {openaireDaysLeft !== null && (
                    <span className={styles['openaire-status-hint']}>
                      {openaireExpiringSoon
                        ? t('settings.openaire.expiresSoon', { days: Math.max(openaireDaysLeft, 0) })
                        : t('settings.openaire.autoRenews', { days: openaireDaysLeft })}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className={styles['openaire-disconnect']}
                  onClick={() => {
                    setOpenaireError(null)
                    disconnectOpenaire()
                  }}
                >
                  {t('settings.openaire.disconnect')}
                </button>
              </div>
            ) : (
              <>
                <p className={styles['openaire-step-hint']}>{t('settings.openaire.stepHint')}</p>

                <div className={styles['openaire-input-row']}>
                  <input
                    type="password"
                    className={styles['openaire-input']}
                    value={openaireTokenInput}
                    placeholder={t('settings.openaire.tokenPlaceholder')}
                    onChange={e => {
                      setOpenaireTokenInput(e.target.value)
                      if (openaireError) setOpenaireError(null)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && openaireTokenInput.trim() && !openaireBusy) {
                        handleOpenaireConnect()
                      }
                    }}
                    disabled={openaireBusy}
                  />
                  <button
                    type="button"
                    className={styles['openaire-paste-btn']}
                    onClick={handleOpenairePaste}
                    disabled={openaireBusy}
                    title={t('settings.openaire.pasteButton')}
                  >
                    📋 {t('settings.openaire.pasteButton')}
                  </button>
                  <button
                    type="button"
                    className={styles['action-button']}
                    onClick={handleOpenaireConnect}
                    disabled={openaireBusy || !openaireTokenInput.trim()}
                  >
                    {openaireBusy
                      ? t('settings.openaire.connecting')
                      : t('settings.openaire.connectButton')}
                  </button>
                </div>

                {openaireError && (
                  <p className={styles['openaire-error']}>{openaireError}</p>
                )}
              </>
            )}
          </div>
        </section>

        {/* Web of Science */}
        <section className={styles['settings-section']}>
          <div className={styles['section-header-row']}>
            <div>
              <h2 className={styles['section-title']}>{t('settings.wos.title')}</h2>
              <p className={styles['section-desc']}>{t('settings.wos.description')}</p>
            </div>
            <button
              type="button"
              className={`${styles['action-button']} ${styles['action-button-portal']}`}
              onClick={() =>
                window.electronAPI
                  .openExternal('https://developer.clarivate.com/')
                  .catch(err => console.error('Failed to open URL:', err))
              }
            >
              {t('settings.wos.requestKey')}
            </button>
          </div>

          <div className={styles['setting-row']} style={{ gap: 8, borderBottom: 'none' }}>
            <span className={styles['setting-desc']} style={{ flex: 1 }}>
              {t('settings.wos.tierDesc')}
            </span>
            <select
              className={`${styles['setting-input']} ${styles['setting-input-wide']}`}
              value={settings.api_keys?.wos_tier ?? 'starter_free'}
              onChange={e => updateApiKey('wos_tier', e.target.value)}
            >
              <option value="starter_free">{t('settings.wos.tierStarterFree')}</option>
              <option value="starter_institutional">{t('settings.wos.tierStarterInstitutional')}</option>
            </select>
            <input
              type="password"
              className={`${styles['setting-input']} ${styles['setting-input-wide']}`}
              value={settings.api_keys?.wos ?? ''}
              placeholder={t('settings.wos.keyPlaceholder')}
              onChange={e => updateApiKey('wos', e.target.value)}
            />
          </div>
        </section>

        {/* Search Configuration */}
        <section className={styles['settings-section']}>
          <div className={styles['section-header-row']}>
            <div>
              <h2 className={styles['section-title']}>{t('settings.search.title')}</h2>
            </div>
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.search.timeoutLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.search.timeoutDesc')}</span>
            </div>
            <input type="number" className={styles['setting-input']} value={settings.search_timeout}
              onChange={e => updateSetting('search_timeout', Number(e.target.value))} min={5} max={120} />
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.search.maxApisLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.search.maxApisDesc')}</span>
            </div>
            <input type="number" className={styles['setting-input']} value={settings.max_concurrent_apis}
              onChange={e => updateSetting('max_concurrent_apis', Number(e.target.value))} min={1} max={20} />
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.search.concurrentSourcesLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.search.concurrentSourcesDesc')}</span>
            </div>
            <input type="number" className={styles['setting-input']} value={settings.max_concurrent_sources_per_pdf}
              onChange={e => updateSetting('max_concurrent_sources_per_pdf', Number(e.target.value))} min={1} max={20} />
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.search.autoScholarLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.search.autoScholarDesc')}</span>
            </div>
            <label className={styles['db-toggle']}>
              <input type="checkbox" checked={settings.auto_scholar_after_verify ?? true}
                onChange={e => updateSetting('auto_scholar_after_verify', e.target.checked)} />
              <span className={styles['toggle-track']}>
                <span className={styles['toggle-thumb']} />
              </span>
            </label>
          </div>
        </section>

        {/* Notes */}
        <section className={styles['settings-section']}>
          <div className={styles['section-header-row']}>
            <div>
              <h2 className={styles['section-title']}>{t('settings.notes.title')}</h2>
            </div>
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.notes.annotatedPdfLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.notes.annotatedPdfDesc')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                className={`${styles['setting-input']} ${styles['setting-input-wide']}`}
                value={settings.annotated_pdf_dir ?? ''}
                placeholder={t('settings.notes.annotatedPdfPlaceholder')}
                onChange={e => updateSetting('annotated_pdf_dir', e.target.value)}
              />
              <button
                type="button"
                className={styles['action-button']}
                onClick={async () => {
                  const dir = await window.electronAPI.selectDirectory()
                  if (dir) updateSetting('annotated_pdf_dir', dir)
                }}
              >
                {t('common.browse')}
              </button>
            </div>
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.notes.reportBibliographicLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.notes.reportBibliographicDesc')}</span>
            </div>
            <label className={styles['db-toggle']}>
              <input type="checkbox" checked={settings.report_include_bibliographic ?? true}
                onChange={e => updateSetting('report_include_bibliographic', e.target.checked)} />
              <span className={styles['toggle-track']}>
                <span className={styles['toggle-thumb']} />
              </span>
            </label>
          </div>
        </section>

        <section className={styles['settings-section']}>
          <div className={styles['section-header-row']}>
            <div>
              <h2 className={styles['section-title']}>{t('settings.cache.title')}</h2>
            </div>
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.cache.folderLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.cache.folderDesc')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {cacheOpenMessage && <span className={styles['action-message']}>{cacheOpenMessage}</span>}
              <button type="button" className={styles['action-button']} onClick={handleOpenCacheFolder}>
                {t('common.open')}
              </button>
            </div>
          </div>

          <div className={styles['setting-row']}>
            <div className={styles['setting-info']}>
              <span className={styles['setting-label']}>{t('settings.cache.scholarSessionLabel')}</span>
              <span className={styles['setting-desc']}>{t('settings.cache.scholarSessionDesc')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {scholarSessionMessage && <span className={styles['action-message']}>{scholarSessionMessage}</span>}
              <button
                type="button"
                className={styles['action-button']}
                onClick={handleClearScholarSession}
                disabled={scholarSessionBusy}
              >
                {t('settings.cache.clear')}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

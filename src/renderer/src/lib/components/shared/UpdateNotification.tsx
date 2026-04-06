import { useEffect, useMemo, useState } from 'react'
import styles from './UpdateNotification.module.css'

type UpdateStage = 'hidden' | 'available' | 'downloading' | 'ready' | 'error'

interface UpdateAvailablePayload {
  version: string
  releaseNotes?: unknown
}

interface UpdateProgressPayload {
  percent: number
}

function formatReleaseNotes(notes: unknown): string {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    const textItems = notes
      .map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'note' in item) {
          return String((item as { note?: unknown }).note ?? '')
        }
        return ''
      })
      .filter(Boolean)
    return textItems.join('\n')
  }
  return String(notes)
}

export default function UpdateNotification() {
  const [stage, setStage] = useState<UpdateStage>('hidden')
  const [visible, setVisible] = useState(false)
  const [version, setVersion] = useState('')
  const [releaseNotes, setReleaseNotes] = useState('')
  const [progressPercent, setProgressPercent] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    const offAvailable = window.electronAPI.onUpdateAvailable((info: UpdateAvailablePayload) => {
      setVersion(info.version)
      setReleaseNotes(formatReleaseNotes(info.releaseNotes))
      setProgressPercent(0)
      setErrorMessage('')
      setStage('available')
      setVisible(true)
    })

    const offProgress = window.electronAPI.onUpdateProgress((progress: UpdateProgressPayload) => {
      setProgressPercent(Math.max(0, Math.min(100, Number(progress.percent || 0))))
      setErrorMessage('')
      setStage('downloading')
      setVisible(true)
    })

    const offDownloaded = window.electronAPI.onUpdateDownloaded(() => {
      setStage('ready')
      setVisible(true)
    })

    const offError = window.electronAPI.onUpdateError((message: string) => {
      setErrorMessage(message || 'Update failed.')
      setStage('error')
      setVisible(true)
    })

    return () => {
      offAvailable()
      offProgress()
      offDownloaded()
      offError()
    }
  }, [])

  const progressWidth = useMemo(() => `${progressPercent.toFixed(1)}%`, [progressPercent])

  if (!visible || stage === 'hidden') {
    return null
  }

  return (
    <aside className={styles['update-card']}>
      <button
        type="button"
        className={styles['close-btn']}
        aria-label="Dismiss update notification"
        onClick={() => setVisible(false)}
      >
        ×
      </button>

      <div className={styles['title-row']}>
        <h4 className={styles['title']}>Update Available</h4>
        {version && <span className={styles['version-tag']}>v{version}</span>}
      </div>

      {stage === 'available' && (
        <>
          <p className={styles['body']}>
            A new version is available. Download now and restart when ready.
          </p>
          {releaseNotes && <pre className={styles['release-notes']}>{releaseNotes}</pre>}
          <button
            type="button"
            className={styles['primary-btn']}
            onClick={() => {
              setStage('downloading')
              window.electronAPI.downloadUpdate()
            }}
          >
            Download
          </button>
        </>
      )}

      {stage === 'downloading' && (
        <>
          <p className={styles['body']}>Downloading update...</p>
          <div className={styles['progress-track']}>
            <div className={styles['progress-fill']} style={{ width: progressWidth }} />
          </div>
          <p className={styles['progress-text']}>{progressPercent.toFixed(1)}%</p>
        </>
      )}

      {stage === 'ready' && (
        <>
          <p className={styles['body']}>Update downloaded. Restart the app to install it.</p>
          <button
            type="button"
            className={styles['primary-btn']}
            onClick={() => window.electronAPI.installUpdate()}
          >
            Restart
          </button>
        </>
      )}

      {stage === 'error' && (
        <>
          <p className={styles['body']}>Update error: {errorMessage}</p>
          <button
            type="button"
            className={styles['secondary-btn']}
            onClick={() => {
              setErrorMessage('')
              setStage('available')
              window.electronAPI.downloadUpdate()
            }}
          >
            Retry Download
          </button>
        </>
      )}
    </aside>
  )
}

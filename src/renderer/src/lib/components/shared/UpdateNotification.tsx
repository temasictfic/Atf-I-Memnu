import { useEffect, useMemo, useState } from 'react'
import styles from './UpdateNotification.module.css'

type UpdateStage = 'hidden' | 'available' | 'downloading' | 'ready' | 'error'

interface UpdateAvailablePayload {
  version: string
}

interface UpdateProgressPayload {
  percent: number
}

export default function UpdateNotification() {
  const [stage, setStage] = useState<UpdateStage>('hidden')
  const [visible, setVisible] = useState(false)
  const [version, setVersion] = useState('')
  const [progressPercent, setProgressPercent] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    const offAvailable = window.electronAPI.onUpdateAvailable((info: UpdateAvailablePayload) => {
      setVersion(info.version)
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

  const message = useMemo(() => {
    if (stage === 'available') {
      return version ? `v${version} is available.` : 'A new version is available.'
    }
    if (stage === 'downloading') {
      return `Downloading update: ${progressPercent.toFixed(1)}%`
    }
    if (stage === 'ready') {
      return 'Update is ready to install.'
    }
    if (stage === 'error') {
      return errorMessage || 'Update failed.'
    }
    return ''
  }, [errorMessage, progressPercent, stage, version])

  if (!visible || stage === 'hidden') {
    return null
  }

  return (
    <aside className={styles['update-card']} role="status" aria-live="polite">
      <span className={`${styles['status-dot']} ${styles[`dot-${stage}`]}`} aria-hidden="true" />
      <p className={styles['message']}>{message}</p>

      {stage === 'available' && (
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
      )}

      {stage === 'ready' && (
        <button
          type="button"
          className={styles['primary-btn']}
          onClick={() => window.electronAPI.installUpdate()}
        >
          Restart
        </button>
      )}

      {stage === 'error' && (
        <button
          type="button"
          className={styles['secondary-btn']}
          onClick={() => {
            setErrorMessage('')
            setVisible(false)
            setStage('hidden')
          }}
        >
          Dismiss
        </button>
      )}

      <button
        type="button"
        className={styles['close-btn']}
        aria-label="Dismiss update notification"
        onClick={() => {
          if (stage === 'downloading') {
            window.electronAPI.cancelUpdate()
          }
          setVisible(false)
          setStage('hidden')
        }}
      >
        ×
      </button>
    </aside>
  )
}

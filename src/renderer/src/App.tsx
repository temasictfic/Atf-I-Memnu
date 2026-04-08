import { useState, useEffect } from 'react'
import { wsClient } from './lib/api/ws-client'
import { initPdfListeners } from './lib/stores/pdf-store'
import { initVerificationListeners } from './lib/stores/verification-store'
import { useSettingsStore } from './lib/stores/settings-store'
import ParsingPage from './lib/components/parsing/ParsingPage'
import VerificationPage from './lib/components/verification/VerificationPage'
import SettingsPage from './lib/components/settings/SettingsPage'
import UpdateNotification from './lib/components/shared/UpdateNotification'
import iconUrl from './assets/icon.png'
import headerLogoUrl from './assets/atfımemnu-header.png'
import styles from './App.module.css'

type TabId = 'parsing' | 'verification' | 'settings'

interface Tab {
  id: TabId
  label: string
  icon: string
}

const tabs: Tab[] = [
  { id: 'parsing', label: 'Parsing', icon: '\u25E7' },
  { id: 'verification', label: 'Verification', icon: '\u25C9' },
  { id: 'settings', label: 'Settings', icon: '\u2699' },
]

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('parsing')

  // Initialize WebSocket, listeners, and settings on mount
  useEffect(() => {
    wsClient.connect()
    const cleanupPdf = initPdfListeners()
    const cleanupVerify = initVerificationListeners()
    useSettingsStore.getState().loadSettings()
    return () => {
      cleanupPdf()
      cleanupVerify()
      wsClient.disconnect()
    }
  }, [])

  return (
    <div className={styles['app-shell']}>
      {/* Header */}
      <header className={styles['header-bar']}>
        <div className={styles['header-inner']}>
          {/* Brand */}
          <div className={styles['brand']}>
            <img src={headerLogoUrl} alt="Atf-ı Memnu" className={styles['brand-image']} />
          </div>

          {/* Tabs */}
          <nav className={styles['tab-nav']}>
            {tabs.map(tab => (
              <button
                key={tab.id}
                className={`${styles['tab-btn']} ${activeTab === tab.id ? styles['tab-active'] : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className={styles['tab-icon']}>{tab.icon}</span>
                <span>{tab.label}</span>
                {activeTab === tab.id && <div className={styles['tab-indicator']} />}
              </button>
            ))}
          </nav>

          {/* Status */}
          <div className={styles['header-status']}>
            <UpdateNotification />
            <div className={styles['status-icon-ring']}>
              <img src={iconUrl} alt="App icon" className={styles['status-icon']} />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className={styles['main-content']}>
        <div style={{ display: activeTab === 'parsing' ? 'contents' : 'none' }}>
          <ParsingPage />
        </div>
        <div style={{ display: activeTab === 'verification' ? 'contents' : 'none' }}>
          <VerificationPage />
        </div>
        {activeTab === 'settings' && <SettingsPage />}
      </main>

      <footer className={styles['footer-bar']}>
        <button
          className={styles['scroll-top-btn']}
          onClick={() => {
            document.querySelectorAll('[data-scrollable]').forEach(el => {
              el.scrollTo({ top: 0, behavior: 'smooth' })
            })
          }}
          title="Scroll to top"
          aria-label="Scroll to top"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 12V4" />
            <path d="M4 7l4-4 4 4" />
          </svg>
        </button>
      </footer>
    </div>
  )
}

import { create } from 'zustand'
import type { AppSettings, DatabaseConfig } from '../api/types'
import { api } from '../api/rest-client'
import {
  SETTINGS_ERROR_FLASH_MS,
  SETTINGS_SAVED_FLASH_MS,
} from '../constants/timings'
import i18n from '../i18n'

const defaultDatabases: DatabaseConfig[] = [
  { id: 'crossref', name: 'Crossref', enabled: true },
  { id: 'openalex', name: 'OpenAlex', enabled: true },
  { id: 'openaire', name: 'OpenAIRE', enabled: true },
  { id: 'europe_pmc', name: 'Europe PMC', enabled: true },
  { id: 'arxiv', name: 'arXiv', enabled: true },
  { id: 'pubmed', name: 'PubMed', enabled: true },
  { id: 'semantic_scholar', name: 'Semantic Scholar', enabled: true },
  { id: 'trdizin', name: 'TRDizin', enabled: true },
  { id: 'open_library', name: 'Open Library', enabled: true },
]

interface SettingsState {
  settings: AppSettings
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  loadSettings: () => Promise<void>
  saveSettings: (s: AppSettings) => Promise<void>
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  toggleDatabase: (dbId: string) => void
  addDatabase: (db: DatabaseConfig) => void
  removeDatabase: (dbId: string) => void
  moveDatabase: (dbId: string, direction: 'up' | 'down') => void
  updateApiKey: (key: string, value: string) => void
  connectOpenaire: (refreshToken: string) => Promise<{ ok: boolean; error?: string }>
  disconnectOpenaire: () => Promise<void>
}

// Auto-save settings to backend after a short debounce
let _saveTimer: ReturnType<typeof setTimeout> | null = null
let _savedTimer: ReturnType<typeof setTimeout> | null = null
function _debouncedSave(get: () => SettingsState) {
  if (_saveTimer) clearTimeout(_saveTimer)
  if (_savedTimer) clearTimeout(_savedTimer)
  useSettingsStore.setState({ saveStatus: 'saving' })
  _saveTimer = setTimeout(async () => {
    try {
      const s = await api.updateSettings(get().settings)
      useSettingsStore.setState({ settings: s, saveStatus: 'saved' })
      _savedTimer = setTimeout(() => useSettingsStore.setState({ saveStatus: 'idle' }), SETTINGS_SAVED_FLASH_MS)
    } catch (e) {
      console.error('Failed to auto-save settings:', e)
      useSettingsStore.setState({ saveStatus: 'error' })
      _savedTimer = setTimeout(() => useSettingsStore.setState({ saveStatus: 'idle' }), SETTINGS_ERROR_FLASH_MS)
    }
  }, 500)
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  saveStatus: 'idle' as const,
  settings: {
    annotated_pdf_dir: '',
    databases: defaultDatabases,
    api_keys: {},
    polite_pool_email: '',
    search_timeout: 30,
    max_concurrent_apis: 5,
    max_concurrent_sources_per_pdf: 3,
    language: 'tr',
    auto_callout_text_fabricated: 'Literatürde bulunmamaktadır.',
    auto_callout_text_citation:
      'Künye bilgilerinde eksik/hatalı bilgiler bulunmaktadır.',
  },

  loadSettings: async () => {
    try {
      const s = await api.getSettings()
      set({ settings: s })
      if (s.language && i18n.language !== s.language) {
        i18n.changeLanguage(s.language)
      }
    } catch {
      // Use defaults
    }
  },

  saveSettings: async (newSettings: AppSettings) => {
    try {
      const s = await api.updateSettings(newSettings)
      set({ settings: s })
    } catch (e) {
      console.error('Failed to save settings:', e)
    }
  },

  updateSetting: (key, value) => {
    set(state => ({ settings: { ...state.settings, [key]: value } }))
    if (key === 'language' && typeof value === 'string') {
      i18n.changeLanguage(value)
    }
    _debouncedSave(get)
  },

  toggleDatabase: (dbId: string) => {
    set(state => ({
      settings: {
        ...state.settings,
        databases: state.settings.databases.map(db =>
          db.id === dbId ? { ...db, enabled: !db.enabled } : db
        ),
      },
    }))
    _debouncedSave(get)
  },

  addDatabase: (db: DatabaseConfig) => {
    set(state => ({
      settings: {
        ...state.settings,
        databases: [...state.settings.databases, db],
      },
    }))
    _debouncedSave(get)
  },

  removeDatabase: (dbId: string) => {
    set(state => ({
      settings: {
        ...state.settings,
        databases: state.settings.databases.filter(db => db.id !== dbId),
      },
    }))
    _debouncedSave(get)
  },

  moveDatabase: (dbId: string, direction: 'up' | 'down') => {
    set(state => {
      const dbs = [...state.settings.databases]
      const idx = dbs.findIndex(db => db.id === dbId)
      if (idx < 0) return state
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1
      if (targetIdx < 0 || targetIdx >= dbs.length) return state
      ;[dbs[idx], dbs[targetIdx]] = [dbs[targetIdx], dbs[idx]]
      return { settings: { ...state.settings, databases: dbs } }
    })
    _debouncedSave(get)
  },

  updateApiKey: (key: string, value: string) => {
    set(state => ({
      settings: {
        ...state.settings,
        api_keys: { ...(state.settings.api_keys || {}), [key]: value },
      },
    }))
    _debouncedSave(get)
  },

  connectOpenaire: async (refreshToken: string) => {
    // The OpenAIRE exchange is authoritative: we only persist a token that
    // already traded for an access token, so a successful return means the
    // user is truly connected and the backend has the rotated value.
    try {
      const res = await api.validateOpenaireToken(refreshToken)
      if (res.valid && res.settings) {
        set({ settings: res.settings })
        return { ok: true }
      }
      return { ok: false, error: res.error ?? 'Validation failed.' }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Network error.',
      }
    }
  },

  disconnectOpenaire: async () => {
    try {
      const updated = await api.disconnectOpenaire()
      set({ settings: updated })
    } catch (err) {
      console.error('Failed to disconnect OpenAIRE:', err)
    }
  },
}))

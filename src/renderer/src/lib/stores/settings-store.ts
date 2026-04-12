import { create } from 'zustand'
import type { AppSettings, DatabaseConfig } from '../api/types'
import { api } from '../api/rest-client'

const defaultDatabases: DatabaseConfig[] = [
  { id: 'crossref', name: 'Crossref', enabled: true, tier: 1, type: 'api' },
  { id: 'arxiv', name: 'arXiv', enabled: true, tier: 1, type: 'api' },
  { id: 'semantic_scholar', name: 'Semantic Scholar', enabled: true, tier: 1, type: 'api' },
  { id: 'openalex', name: 'OpenAlex', enabled: true, tier: 1, type: 'api' },
  { id: 'pubmed', name: 'PubMed', enabled: true, tier: 1, type: 'api' },
  { id: 'europe_pmc', name: 'Europe PMC', enabled: true, tier: 1, type: 'api' },
  { id: 'plos', name: 'PLOS', enabled: true, tier: 1, type: 'api' },
  { id: 'open_library', name: 'Open Library', enabled: true, tier: 1, type: 'api' },
  { id: 'trdizin', name: 'TRDizin', enabled: true, tier: 1, type: 'api' },
  { id: 'core', name: 'CORE', enabled: false, tier: 1, type: 'api' },
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
  addInstance: (engine: string, url: string) => void
  removeInstance: (engine: string, url: string) => void
  reorderInstances: (engine: string, urls: string[]) => void
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
      _savedTimer = setTimeout(() => useSettingsStore.setState({ saveStatus: 'idle' }), 2000)
    } catch (e) {
      console.error('Failed to auto-save settings:', e)
      useSettingsStore.setState({ saveStatus: 'error' })
      _savedTimer = setTimeout(() => useSettingsStore.setState({ saveStatus: 'idle' }), 3000)
    }
  }, 500)
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  saveStatus: 'idle' as const,
  settings: {
    last_directory: '',
    annotated_pdf_dir: '',
    databases: defaultDatabases,
    api_keys: {},
    search_timeout: 30,
    max_concurrent_apis: 5,
    max_concurrent_sources_per_pdf: 3,
    max_concurrent_pdfs: 2,
  },

  loadSettings: async () => {
    try {
      const s = await api.getSettings()
      set({ settings: s })
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

  addInstance: () => {
    // Deprecated: instance lists were removed from persisted settings.
  },

  removeInstance: () => {
    // Deprecated: instance lists were removed from persisted settings.
  },

  reorderInstances: () => {
    // Deprecated: instance lists were removed from persisted settings.
  },
}))

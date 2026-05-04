import { create } from 'zustand'
import type { AppSettings, DatabaseConfig } from '../api/types'
import { api } from '../api/rest-client'
import {
  SETTINGS_ERROR_FLASH_MS,
  SETTINGS_SAVED_FLASH_MS,
} from '../constants/timings'
import i18n from '../i18n'

// Must mirror backend `AppSettings.default().databases` in
// `backend/models/settings.py`. The backend is authoritative — these are
// only the seed values shown until the initial /settings GET resolves.
export const defaultDatabases: DatabaseConfig[] = [
  { id: 'crossref', name: 'Crossref', enabled: true },
  { id: 'openalex', name: 'OpenAlex', enabled: true },
  { id: 'openaire', name: 'OpenAIRE', enabled: true },
  { id: 'europe_pmc', name: 'Europe PMC', enabled: true },
  { id: 'arxiv', name: 'arXiv', enabled: true },
  { id: 'pubmed', name: 'PubMed', enabled: true },
  { id: 'semantic_scholar', name: 'Semantic Scholar', enabled: true },
  { id: 'trdizin', name: 'TRDizin', enabled: true },
  { id: 'open_library', name: 'Open Library', enabled: true },
  { id: 'base', name: 'BASE', enabled: false },
  { id: 'wos', name: 'Web of Science', enabled: false },
]

export const defaultDatabaseIds: ReadonlySet<string> = new Set(
  defaultDatabases.map(db => db.id),
)

interface SettingsState {
  settings: AppSettings
  // True once loadSettings has finished (success or failure). Mutators
  // gate the autosave on this flag so user edits made before the initial
  // load resolves don't get persisted as partial-defaults; the load's
  // set() will overwrite with server values, and from then on edits
  // autosave normally.
  settingsLoaded: boolean
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  loadSettings: () => Promise<void>
  saveSettings: (s: AppSettings) => Promise<void>
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  toggleDatabase: (dbId: string) => void
  addDatabase: (db: DatabaseConfig) => void
  removeDatabase: (dbId: string) => void
  reorderDatabases: (fromIdx: number, toIdx: number) => void
  updateApiKey: (key: string, value: string) => void
  connectOpenaire: (refreshToken: string) => Promise<{ ok: boolean; error?: string }>
  disconnectOpenaire: () => Promise<void>
}

// Auto-save debounce. Two durations: a short one for cheap, idempotent
// settings (database toggles, dropdowns) where the user wants quick
// feedback, and a longer one for api_keys / secrets where each keystroke
// would otherwise persist a half-typed token to disk + trigger an OpenAIRE
// cache invalidation. Timer is single-shot — the most recent caller's
// requested delay wins, which is the behaviour we want (a secret edit
// resets the cooldown to the longer interval).
const SETTINGS_AUTOSAVE_DEBOUNCE_MS = 500
const SECRETS_AUTOSAVE_DEBOUNCE_MS = 1500

let _saveTimer: ReturnType<typeof setTimeout> | null = null
let _savedTimer: ReturnType<typeof setTimeout> | null = null
function _debouncedSave(
  get: () => SettingsState,
  delayMs: number = SETTINGS_AUTOSAVE_DEBOUNCE_MS,
) {
  // Skip autosave entirely until the initial load has resolved. Without
  // this, a user edit made during the load's in-flight window would race
  // with the load's set({ settings: s }) and the server's response could
  // either overwrite the user's edit (if it lands second) or persist a
  // mostly-default settings object (if the save fires first).
  if (!get().settingsLoaded) return

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
  }, delayMs)
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  saveStatus: 'idle' as const,
  settingsLoaded: false,
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
    // Idempotent: subsequent calls after the first successful load are
    // no-ops. Stops a remount or duplicate caller from clobbering live
    // user edits with a stale server snapshot.
    if (get().settingsLoaded) return
    try {
      const s = await api.getSettings()
      set({ settings: s, settingsLoaded: true })
      if (s.language && i18n.language !== s.language) {
        i18n.changeLanguage(s.language)
      }
    } catch {
      // Mark loaded anyway so autosave can fire — otherwise a one-time
      // backend hiccup leaves the form silently un-savable.
      set({ settingsLoaded: true })
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

  reorderDatabases: (fromIdx: number, toIdx: number) => {
    set(state => {
      const dbs = [...state.settings.databases]
      if (
        fromIdx < 0 ||
        toIdx < 0 ||
        fromIdx >= dbs.length ||
        toIdx >= dbs.length ||
        fromIdx === toIdx
      ) {
        return state
      }
      const [moved] = dbs.splice(fromIdx, 1)
      dbs.splice(toIdx, 0, moved)
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
    // Longer debounce on secrets so a typing burst doesn't persist a
    // dozen partial-key states to disk (and, for OpenAIRE, doesn't keep
    // re-invalidating the access-token cache between keystrokes).
    _debouncedSave(get, SECRETS_AUTOSAVE_DEBOUNCE_MS)
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

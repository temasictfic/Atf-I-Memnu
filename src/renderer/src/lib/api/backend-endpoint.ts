let backendPort: number | null = null
let backendPortPromise: Promise<number> | null = null

export async function getBackendPort(): Promise<number> {
  if (backendPort !== null) {
    return backendPort
  }

  if (!backendPortPromise) {
    backendPortPromise = (async () => {
      if (!window.electronAPI?.getBackendPort) {
        throw new Error('Backend port is not discoverable in this renderer context')
      }

      const discoveredPort = await window.electronAPI.getBackendPort()
      backendPort = discoveredPort
      return discoveredPort
    })()
  }

  return backendPortPromise
}

export function getBackendPortSync(): number | null {
  return backendPort
}

export async function getBackendBaseUrl(): Promise<string> {
  const port = await getBackendPort()
  return `http://localhost:${port}`
}

export function getBackendBaseUrlSync(): string | null {
  const port = getBackendPortSync()
  if (port === null) return null
  return `http://localhost:${port}`
}

export async function getBackendWsUrl(): Promise<string> {
  const port = await getBackendPort()
  return `ws://localhost:${port}/api/ws`
}

export async function initializeBackendEndpoint(): Promise<void> {
  await getBackendPort()
}

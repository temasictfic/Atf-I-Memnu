import { spawn, execSync, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createServer } from 'net'

let pythonProcess: ChildProcess | null = null
let backendPort: number | null = null
const HEALTH_CHECK_INTERVAL = 2000
const MAX_HEALTH_RETRIES = 30
let healthCheckTimer: ReturnType<typeof setInterval> | null = null

function getBackendPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'backend')
  }
  return join(__dirname, '../../backend')
}

async function findAvailablePort(): Promise<number> {
  // NOTE: there is an inherent TOCTOU window between `server.close()` and
  // uvicorn binding to the same port — the OS can reallocate it to another
  // process in between. In practice this is extremely rare on a desktop
  // app, but when it does happen the health-check loop times out after
  // ~60 s with a confusing error. We accept the race here; the real fix
  // is a socket-FD handoff which requires changes on the Python side too.
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to resolve an available backend port'))
        return
      }

      const port = address.port
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve(port)
      })
    })
  })
}

function getBackendLaunchCommand(port: number): { command: string, args: string[] } {
  if (app.isPackaged) {
    const backendExe = join(getBackendPath(), 'atfi-memnu-backend.exe')
    if (!existsSync(backendExe)) {
      throw new Error(`Bundled backend executable not found: ${backendExe}`)
    }
    return {
      command: backendExe,
      args: ['--port', String(port)]
    }
  }

  const mainPy = join(getBackendPath(), 'main.py')
  const venvPython = join(getBackendPath(), '.venv', 'Scripts', 'python.exe')
  if (!existsSync(venvPython)) {
    throw new Error(
      `Backend venv not found at ${venvPython}. Run "uv sync" inside backend/.`
    )
  }
  return {
    command: venvPython,
    args: ['-u', '-X', 'utf8', mainPy, '--port', String(port)]
  }
}

export async function startPythonBackend(): Promise<void> {
  backendPort = await findAvailablePort()
  const backendPath = getBackendPath()
  const launch = getBackendLaunchCommand(backendPort)
  const backendExecutablePath = launch.command
  const outputDir = join(app.getPath('userData'), 'output')
  const packagedKaynaklarDir = join(process.resourcesPath, 'kaynaklar')
  const devKaynaklarDir = join(__dirname, '../../kaynaklar')
  const envVars: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    ATFI_PORT: String(backendPort),
    ATFI_OUTPUT_DIR: outputDir
  }

  if (app.isPackaged && existsSync(packagedKaynaklarDir)) {
    envVars.ATFI_KAYNAKLAR_DIR = packagedKaynaklarDir
  } else if (existsSync(devKaynaklarDir)) {
    envVars.ATFI_KAYNAKLAR_DIR = devKaynaklarDir
  }

  console.log(`Starting backend from: ${launch.command}`)
  console.log(`Assigned backend port: ${backendPort}`)

  pythonProcess = spawn(launch.command, launch.args, {
    cwd: backendPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: envVars
  })

  pythonProcess.on('error', (error) => {
    console.error('[Python SPAWN ERROR]', error)
  })

  pythonProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[Python STDOUT] ${data.toString().trim()}`)
  })

  pythonProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[Python STDERR] ${data.toString().trim()}`)
  })

  pythonProcess.on('exit', (code) => {
    console.log(`Python backend exited with code ${code}`)
    pythonProcess = null
    backendPort = null
  })

  // Wait for backend to be healthy
  await waitForHealth(backendPort)

  // Health can be green while process exits immediately afterward.
  if (!pythonProcess || backendPort === null) {
    throw new Error(`Backend process exited during startup: ${backendExecutablePath}`)
  }
}

async function waitForHealth(port: number): Promise<void> {
  let lastError: unknown = null
  for (let i = 0; i < MAX_HEALTH_RETRIES; i++) {
    // Bail immediately if the subprocess has already exited — no point
    // polling for a health endpoint on a dead process. This turns the
    // "failed health check within timeout" error (up to 60 s of waiting)
    // into an immediate, accurate "process exited on startup" error.
    if (!pythonProcess || pythonProcess.exitCode !== null) {
      throw new Error(
        `Python backend exited during startup (exit code ${pythonProcess?.exitCode ?? 'unknown'}).`
          + ' Check [Python STDERR] logs above for the failure reason'
          + ' (port collision, missing DLL, LFS pointer file, etc.).'
      )
    }
    try {
      const response = await fetch(`http://localhost:${port}/api/health`)
      if (response.ok) {
        console.log('Python backend is healthy')
        return
      }
    } catch (err) {
      lastError = err
      // Backend not ready yet — keep polling
    }
    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL))
  }
  throw new Error(
    `Python backend failed health check within ${MAX_HEALTH_RETRIES * HEALTH_CHECK_INTERVAL / 1000}s on port ${port}`
      + (lastError instanceof Error ? ` (last error: ${lastError.message})` : '')
  )
}

export function getPythonBackendPort(): number | null {
  return backendPort
}

/**
 * Synchronously kill the backend process tree.
 *
 * Electron does NOT await async event handlers (window-all-closed,
 * before-quit), so any async cleanup gets interrupted when the app
 * exits.  This function uses synchronous taskkill to guarantee the
 * process tree is dead before Electron shuts down.
 */
export function stopPythonBackend(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }

  if (!pythonProcess?.pid) return

  const pid = pythonProcess.pid
  console.log(`Stopping Python backend (PID ${pid})…`)

  try {
    execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 })
    console.log(`Force-killed process tree for PID ${pid}`)
  } catch {
    // Process may have already exited
  }

  pythonProcess = null
  backendPort = null
}

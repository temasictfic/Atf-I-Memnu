import { spawn, execSync, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createServer } from 'net'

let pythonProcess: ChildProcess | null = null
let backendPort: number | null = null
const HEALTH_CHECK_INTERVAL = 2000
const MAX_HEALTH_RETRIES = 30
// /api/ready waits for the NER preload to resolve (~3-15 s cold, up to
// ~30 s on slow disks after an auto-update). Give it a bigger retry
// budget than the liveness check so we don't give up mid-init.
const MAX_READY_RETRIES = 60
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
  // Always pass --host 127.0.0.1 explicitly so the backend default and the
  // launcher agree, even if someone changes the default later. This is a
  // desktop companion backend; it should never bind beyond loopback.
  if (app.isPackaged) {
    const backendExe = join(getBackendPath(), 'atfi-memnu-backend.exe')
    if (!existsSync(backendExe)) {
      throw new Error(`Bundled backend executable not found: ${backendExe}`)
    }
    return {
      command: backendExe,
      args: ['--host', '127.0.0.1', '--port', String(port)]
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
    args: ['-u', '-X', 'utf8', mainPy, '--host', '127.0.0.1', '--port', String(port)]
  }
}

export async function startPythonBackend(): Promise<void> {
  backendPort = await findAvailablePort()
  const backendPath = getBackendPath()
  const launch = getBackendLaunchCommand(backendPort)
  const backendExecutablePath = launch.command
  const outputDir = join(app.getPath('userData'), 'output')
  const envVars: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    ATFI_PORT: String(backendPort),
    ATFI_OUTPUT_DIR: outputDir
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

  // Phase 1: liveness — uvicorn is up.
  await waitForHealth(backendPort)

  // Health can be green while process exits immediately afterward.
  if (!pythonProcess || backendPort === null) {
    throw new Error(`Backend process exited during startup: ${backendExecutablePath}`)
  }

  // Phase 2: readiness — NER preload has finished (either loaded the
  // model or committed to regex fallback). Blocks the UI until this
  // resolves so the user can't hit Verify while NER would silently
  // fall through to regex on garbage queries — the symptom we've seen
  // on the first launch after an auto-update.
  await waitForReady(backendPort)
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

async function waitForReady(port: number): Promise<void> {
  for (let i = 0; i < MAX_READY_RETRIES; i++) {
    if (!pythonProcess || pythonProcess.exitCode !== null) {
      throw new Error(
        `Python backend exited during NER preload (exit code ${pythonProcess?.exitCode ?? 'unknown'}).`
          + ' Check [Python STDERR] logs above for the failure reason.'
      )
    }
    try {
      const response = await fetch(`http://localhost:${port}/api/ready`)
      if (response.ok) {
        const body = await response.json().catch(() => ({ ner: 'unknown' }))
        console.log(`Python backend ready (NER: ${body.ner ?? 'unknown'})`)
        return
      }
      // 503 = still initializing; keep polling silently
    } catch {
      // Connection dropped mid-poll — keep trying
    }
    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL))
  }
  // Readiness never flipped — log a warning but continue anyway.
  // /api/ready failing doesn't mean verification is broken; regex
  // fallback still works. We'd rather let the user in with a degraded
  // experience than hang forever at a splash screen.
  console.warn(
    `Python backend /api/ready did not return 200 within ${MAX_READY_RETRIES * HEALTH_CHECK_INTERVAL / 1000}s — continuing with degraded NER`
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

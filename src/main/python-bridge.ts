import { spawn, execSync, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

let pythonProcess: ChildProcess | null = null
const BACKEND_PORT = 18765
const HEALTH_CHECK_INTERVAL = 2000
const MAX_HEALTH_RETRIES = 30
let healthCheckTimer: ReturnType<typeof setInterval> | null = null

function getBackendPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'backend')
  }
  return join(__dirname, '../../backend')
}

function getBackendLaunchCommand(): { command: string, args: string[] } {
  if (app.isPackaged) {
    const backendExe = join(getBackendPath(), 'atfi-memnu-backend.exe')
    if (!existsSync(backendExe)) {
      throw new Error(`Bundled backend executable not found: ${backendExe}`)
    }
    return {
      command: backendExe,
      args: ['--port', String(BACKEND_PORT)]
    }
  }

  const mainPy = join(getBackendPath(), 'main.py')
  return {
    command: 'uv',
    args: [
      'run', 'python',
      '-u',
      '-X', 'utf8',
      mainPy,
      '--port', String(BACKEND_PORT)
    ]
  }
}

function killStaleBackend(): void {
  try {
    // Find and kill any process using our port (Windows)
    const result = execSync(
      `netstat -ano | findstr :${BACKEND_PORT} | findstr LISTENING`,
      { encoding: 'utf-8', timeout: 5000 }
    )
    const lines = result.trim().split('\n')
    const pids = new Set<string>()
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      const pid = parts[parts.length - 1]
      if (pid && pid !== '0') pids.add(pid)
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 })
        console.log(`Killed stale process on port ${BACKEND_PORT} (PID ${pid})`)
      } catch { /* already dead */ }
    }
  } catch {
    // No process on that port — good
  }
}

export async function startPythonBackend(): Promise<void> {
  killStaleBackend()

  const backendPath = getBackendPath()
  const launch = getBackendLaunchCommand()
  const outputDir = join(app.getPath('userData'), 'output')
  const packagedKaynaklarDir = join(process.resourcesPath, 'kaynaklar')
  const devKaynaklarDir = join(__dirname, '../../kaynaklar')
  const envVars: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    ATFI_PORT: String(BACKEND_PORT),
    ATFI_OUTPUT_DIR: outputDir
  }

  if (app.isPackaged && existsSync(packagedKaynaklarDir)) {
    envVars.ATFI_KAYNAKLAR_DIR = packagedKaynaklarDir
  } else if (existsSync(devKaynaklarDir)) {
    envVars.ATFI_KAYNAKLAR_DIR = devKaynaklarDir
  }

  console.log(`Starting backend from: ${launch.command}`)

  pythonProcess = spawn(launch.command, launch.args, {
    cwd: backendPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: envVars
  })

  pythonProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[Python] ${data.toString().trim()}`)
  })

  pythonProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[Python ERR] ${data.toString().trim()}`)
  })

  pythonProcess.on('exit', (code) => {
    console.log(`Python backend exited with code ${code}`)
    pythonProcess = null
  })

  // Wait for backend to be healthy
  await waitForHealth()
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < MAX_HEALTH_RETRIES; i++) {
    try {
      const response = await fetch(`http://localhost:${BACKEND_PORT}/api/health`)
      if (response.ok) {
        console.log('Python backend is healthy')
        return
      }
    } catch {
      // Backend not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL))
  }
  console.error('Python backend failed to start within timeout')
}

export async function stopPythonBackend(): Promise<void> {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }

  if (!pythonProcess) return

  const pid = pythonProcess.pid
  console.log('Stopping Python backend...')

  // Phase 1: Graceful shutdown via HTTP endpoint
  // Triggers lifespan teardown and uvicorn graceful stop
  try {
    await fetch(`http://localhost:${BACKEND_PORT}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000)
    })
    console.log('Shutdown endpoint called successfully')

    // Wait up to 5 seconds for the process to exit gracefully
    const exited = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000)
      if (pythonProcess) {
        pythonProcess.on('exit', () => {
          clearTimeout(timeout)
          resolve(true)
        })
      } else {
        clearTimeout(timeout)
        resolve(true)
      }
    })

    if (exited) {
      console.log('Python backend stopped gracefully')
      pythonProcess = null
      return
    }
    console.log('Graceful shutdown timed out, proceeding to force kill')
  } catch {
    console.log('Graceful shutdown request failed, proceeding to force kill')
  }

  // Phase 2: Force-kill the entire process tree
  // taskkill /F /T /PID kills the process and ALL its descendants
  if (pid) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 })
      console.log(`Force-killed process tree for PID ${pid}`)
    } catch {
      // Process may have already exited
    }
  }

  pythonProcess = null
}

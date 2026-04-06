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
  return {
    command: 'uv',
    args: [
      'run', 'python',
      '-u',
      '-X', 'utf8',
      mainPy,
      '--port', String(port)
    ]
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
  for (let i = 0; i < MAX_HEALTH_RETRIES; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`)
      if (response.ok) {
        console.log('Python backend is healthy')
        return
      }
    } catch {
      // Backend not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL))
  }
  throw new Error(`Python backend failed health check within timeout on port ${port}`)
}

export function getPythonBackendPort(): number | null {
  return backendPort
}

export async function stopPythonBackend(): Promise<void> {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }

  if (!pythonProcess) return

  const pid = pythonProcess.pid
  const port = backendPort
  console.log('Stopping Python backend...')

  // Phase 1: Graceful shutdown via HTTP endpoint
  // Triggers lifespan teardown and uvicorn graceful stop
  if (port !== null) {
    try {
      await fetch(`http://localhost:${port}/api/shutdown`, {
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
        backendPort = null
        return
      }
      console.log('Graceful shutdown timed out, proceeding to force kill')
    } catch {
      console.log('Graceful shutdown request failed, proceeding to force kill')
    }
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
  backendPort = null
}

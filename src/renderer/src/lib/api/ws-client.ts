import type { WsEvent } from './types'

type WsHandler = (data: Record<string, unknown>) => void

class WebSocketClient {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<WsHandler>>()
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private url = 'ws://localhost:18765/api/ws'
  private _connected = false

  get connected(): boolean {
    return this._connected
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return

    try {
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        console.log('%c[WS] Connected to', 'color: #22c55e; font-weight: bold', this.url)
        this._connected = true
        this.reconnectDelay = 1000
        this.emit('ws:connected', {})
      }

      this.ws.onmessage = (event) => {
        try {
          const msg: WsEvent = JSON.parse(event.data)
          this.emit(msg.type, msg.data)
        } catch (e) {
          console.error('[WS] Parse error:', e)
        }
      }

      this.ws.onclose = (ev) => {
        console.log('%c[WS] Disconnected', 'color: #ef4444; font-weight: bold', `code=${ev.code}`)
        this._connected = false
        this.emit('ws:disconnected', {})
        this.scheduleReconnect()
      }

      this.ws.onerror = (err) => {
        console.error('%c[WS] Error:', 'color: #ef4444; font-weight: bold', err)
        this._connected = false
      }
    } catch (e) {
      console.error('[WS] Connection failed:', e)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
      this.connect()
    }, this.reconnectDelay)
  }

  on(event: string, handler: WsHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)
    return () => {
      this.handlers.get(event)?.delete(handler)
    }
  }

  private emit(event: string, data: Record<string, unknown>): void {
    this.handlers.get(event)?.forEach(handler => {
      try {
        handler(data)
      } catch (e) {
        console.error(`[WS] Handler error for ${event}:`, e)
      }
    })
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this._connected = false
  }

  send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }
}

export const wsClient = new WebSocketClient()

import { createRoot } from 'react-dom/client'
import App from './App'
import './app.css'
import { initializeBackendEndpoint } from './lib/api/backend-endpoint'

createRoot(document.getElementById('app')!).render(<App />)

void initializeBackendEndpoint().catch((error) => {
  console.error('[Startup] Backend initialization failed:', error)
})

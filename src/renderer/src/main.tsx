import { createRoot } from 'react-dom/client'
import App from './App'
import './app.css'
import { initializeBackendEndpoint } from './lib/api/backend-endpoint'

async function bootstrap(): Promise<void> {
	await initializeBackendEndpoint()
	createRoot(document.getElementById('app')!).render(<App />)
}

void bootstrap()

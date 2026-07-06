import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import './styles.css'

// Register the service worker in production only (mirrors the reference). The dev
// server runs without a SW; use `yarn build && yarn preview` to exercise offline.
if (import.meta.env.PROD) {
  void import('./service-worker-registration').then((m) => m.registerServiceWorker())
}

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

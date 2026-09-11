import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App'
import { useDocumentStore } from './state/documentStore'
import { applyTheme, readTheme } from './state/theme'
import { useUiStore } from './state/uiStore'
import './styles/global.css'

// The kept palette goes on before anything is drawn, so a light choice does
// not flash dark on the way in.
applyTheme(readTheme(window.localStorage))

// Dev-only handles, beside the canvas's own: for inspecting the stores from
// the console without guessing at what a click did.
if (import.meta.env.DEV) {
  ;(window as unknown as { __stores?: unknown }).__stores = { ui: useUiStore, doc: useDocumentStore }
}

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

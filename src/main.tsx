import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App'
import { applyTheme, readTheme } from './state/theme'
import './styles/global.css'

// The kept palette goes on before anything is drawn, so a light choice does
// not flash dark on the way in.
applyTheme(readTheme(window.localStorage))

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

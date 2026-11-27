import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/source-sans-3/400.css'
import '@fontsource/source-code-pro/300.css'
import '@fontsource/source-serif-4/500.css'
import { App } from './App.tsx'
import { loadPreferences } from './prefs.ts'
import { installSounds } from './sounds.ts'
import { applyTheme } from './theme.ts'
import './themes.css'
import './styles.css'

applyTheme(loadPreferences().theme)
installSounds()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

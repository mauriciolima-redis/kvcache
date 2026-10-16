import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Analysis from './Analysis.tsx'

// Two pages, no router: /analyse (optionally under /pt-br or /en-us) is the comparison view.
const isAnalysis = /^(\/[a-z]{2}-[a-z]{2})?\/analyse\/?$/i.test(window.location.pathname)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isAnalysis ? <Analysis /> : <App />}</StrictMode>,
)

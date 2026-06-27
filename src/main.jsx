import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ToastProvider } from './Toast.jsx'

// Reference-counted serial polling pause.
// Prevents M114 polling from interfering with G28 homing on RAMPS v1.4.
window._pollPauseCount = 0;
Object.defineProperty(window, 'pauseSerialPolling', {
  get() { return window._pollPauseCount > 0; },
  set(v) {
    if (v) { window._pollPauseCount++; }
    else { window._pollPauseCount = Math.max(0, window._pollPauseCount - 1); }
  },
  configurable: true,
});

createRoot(document.getElementById('root')).render(
    <ToastProvider>
      <App />
    </ToastProvider>
)

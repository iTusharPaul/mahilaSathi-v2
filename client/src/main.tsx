import { registerServiceWorker } from './features/notifications/usePush';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { bindThemeToDocument } from './stores/themeStore';
import './styles/index.css';

bindThemeToDocument();

void registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

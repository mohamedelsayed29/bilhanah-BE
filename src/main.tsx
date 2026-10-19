import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/noto-sans-arabic';
import '@fontsource-variable/manrope';
import { LanguageProvider } from './lib/language';
import { App } from './app/App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider><App /></LanguageProvider>
  </React.StrictMode>,
);

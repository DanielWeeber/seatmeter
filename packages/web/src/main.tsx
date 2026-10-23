import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import plugins from 'virtual:seatmeter-web-plugins';
import { erstelleQueryClient } from './api/client';
import { App } from './App';
import { eeAktiv } from './navigation';
import './index.css';

const wurzel = document.getElementById('root');
if (!wurzel) throw new Error('Element #root fehlt');

createRoot(wurzel).render(
  <StrictMode>
    <BrowserRouter>
      <App
        queryClient={erstelleQueryClient()}
        mitEe={eeAktiv() || plugins.length > 0}
        plugins={plugins}
      />
    </BrowserRouter>
  </StrictMode>,
);

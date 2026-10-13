import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Providers } from './Providers.tsx';
import './styles.css';

const Agentation = import.meta.env.DEV ? lazy(() => import('agentation').then(m => ({ default: m.Agentation }))) : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
    {Agentation && (
      <Suspense>
        <Agentation />
      </Suspense>
    )}
  </StrictMode>
);

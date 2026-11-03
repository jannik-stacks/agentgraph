import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { readChanged } from './state.ts';
import './styles.css';

const Agentation = import.meta.env.DEV ? lazy(() => import('agentation').then(m => ({ default: m.Agentation }))) : null;

import.meta.hot?.on('agi:changed', ({ topics }: { topics: string[] }) => readChanged(topics));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {Agentation && (
      <Suspense>
        <Agentation />
      </Suspense>
    )}
  </StrictMode>
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={(import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || ""}>
      <App />
    </GoogleOAuthProvider>
  </StrictMode>,
);
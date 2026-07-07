import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import App from './App.tsx';
import { OverlayProvider } from './components/ui/overlay';
import './index.css';

const clientIDFromEnv = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || "";
const googleClientId = clientIDFromEnv.includes(".apps.googleusercontent.com")
  ? clientIDFromEnv
  : "1234567890-mockclientid.apps.googleusercontent.com";

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={googleClientId}>
      <OverlayProvider>
        <App />
      </OverlayProvider>
    </GoogleOAuthProvider>
  </StrictMode>,
);
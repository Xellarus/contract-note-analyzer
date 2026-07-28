import React, { useState } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { PortfolioUser } from '../types';
import { persistGoogleToken } from '../lib/googleAuth';
import blackSpinnSvg from '../assets/black-spinn.svg?url';

interface LoginProps {
  onLoginSuccess: (user: PortfolioUser) => void;
}

const GoogleGLogo = () => (
  <svg className="w-5 h-5" viewBox="0 0 48 48">
    <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
    <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
    <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
    <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
  </svg>
);

export default function Login({ onLoginSuccess }: LoginProps) {
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Single combined flow: one popup grants identity (email/profile) AND Sheets access,
  // so the user never has to "Connect Sheets" separately afterwards.
  const login = useGoogleLogin({
    scope: 'openid email profile https://www.googleapis.com/auth/spreadsheets',
    onSuccess: async (tokenResponse) => {
      try {
        persistGoogleToken(tokenResponse as any);

        const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        if (!resp.ok) throw new Error(`userinfo fetch failed (${resp.status})`);
        const profile = await resp.json();

        const user: PortfolioUser = {
          email: profile.email,
          name: profile.name || profile.email,
          picture: profile.picture,
          given_name: profile.given_name,
          family_name: profile.family_name,
        };
        onLoginSuccess(user);
      } catch (e: any) {
        console.error('Post-login profile fetch failed:', e);
        setLoginError('Signed in, but could not load your Google profile. Please try again.');
      } finally {
        setIsSigningIn(false);
      }
    },
    onError: () => {
      setIsSigningIn(false);
      setLoginError('Google Authentication failed. Please try again.');
    },
  });

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans flex flex-col justify-between relative overflow-hidden">
      {/* Soft elegant glowing geometric backgrounds */}
      <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-900/40 via-slate-900 to-slate-950 z-0" />
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-500/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-emerald-500/5 blur-[100px] pointer-events-none" />

      {/* Animated "Black Spinn" backdrop — large, centered, behind all content (z-0 < z-10 header/card) */}
      <img
        src={blackSpinnSvg}
        alt=""
        aria-hidden="true"
        className="pointer-events-none select-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[130vmin] h-[130vmin] max-w-none z-0 opacity-90"
      />

      {/* Main Content Card Box */}
      <div className="relative z-10 flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm bg-white/5 border border-white/10 rounded-3xl p-8 backdrop-blur-xl shadow-2xl flex flex-col items-center">

          {/* Logo illustration */}
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-indigo-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/25 mb-5">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>

          {/* Brand */}
          <span className="font-black text-[11px] text-indigo-300 tracking-[0.25em] uppercase mb-1.5">Backoffice</span>

          {/* Typography */}
          <h2 className="text-xl font-black tracking-tight text-white text-center font-sans">
            Portfolio & Ledger Control
          </h2>

          <div className="w-full h-px bg-white/10 my-6" />

          {/* Interactive Elements / Sign In Button */}
          <div className="w-full space-y-3">
            <button
              onClick={() => { setLoginError(null); setIsSigningIn(true); login(); }}
              disabled={isSigningIn}
              className="btn-press w-full flex items-center justify-center gap-3 rounded-xl bg-white text-slate-800 font-bold text-sm p-3 shadow cursor-pointer disabled:opacity-60 disabled:cursor-wait"
            >
              {isSigningIn ? <Loader2 className="w-5 h-5 animate-spin" /> : <GoogleGLogo />}
              {isSigningIn ? 'Signing in…' : 'Sign in with Google'}
            </button>

            {loginError && (
              <p className="text-[11px] text-rose-400 text-center font-semibold">{loginError}</p>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

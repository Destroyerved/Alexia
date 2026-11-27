import React, { useState, useEffect } from 'react';
import { Fingerprint, KeyRound, Lock, LogOut, ShieldCheck, Smartphone, Copy, CheckCircle2, X } from 'lucide-react';
import { apiClient, OperatorSessionInfo } from '../../lib/api';

export interface AuthModalProps {
  isOpen: boolean;
  mode: 'login' | 'step-up';
  title?: string;
  description?: string;
  isDemoMode?: boolean;
  sessionInfo?: OperatorSessionInfo | null;
  actionId?: string;
  onClose: () => void;
  onLoginSuccess?: () => void;
  onStepUpVerified?: (stepUpToken: string) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  mode,
  title,
  description,
  isDemoMode = true,
  sessionInfo,
  actionId,
  onClose,
  onLoginSuccess,
  onStepUpVerified,
}) => {
  const [username, setUsername] = useState(sessionInfo?.username || (isDemoMode ? 'demo' : 'admin'));
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState('Operator Console');
  const [totpCode, setTotpCode] = useState('');
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setStatusMsg(null);
      setTotpCode('');
      if (sessionInfo?.username && sessionInfo.username !== 'local_operator') {
        setUsername(sessionInfo.username);
      }
    }
  }, [isOpen, sessionInfo]);

  if (!isOpen) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const platform = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Mobile PWA' : 'Web Console';
    const res = await apiClient.login(username.trim(), password, deviceName.trim() || 'Operator Console', platform);
    setBusy(false);
    if (!res.success) {
      setError(res.error || 'Authentication failed');
      return;
    }
    setPassword('');
    setStatusMsg(`Signed in as ${res.username} (${res.role || 'admin'})`);
    onLoginSuccess?.();
  };

  const handleLogout = async () => {
    setBusy(true);
    await apiClient.logout();
    setBusy(false);
    setStatusMsg('Signed out of operator session.');
    onLoginSuccess?.();
  };

  const handleLoadTotpSetup = async () => {
    const info = await apiClient.getTotpSetup(username || 'operator');
    if (info) {
      setTotpSetup(info);
    } else {
      setError('Sign in first to view TOTP provisioning secret.');
    }
  };

  const handleRegisterPasskey = async () => {
    setBusy(true);
    setError(null);
    const res = await apiClient.registerPasskey(username || 'operator', deviceName || 'Operator Passkey');
    setBusy(false);
    if (res.success) {
      setStatusMsg(res.message);
    } else {
      setError(res.message);
    }
  };

  const handleVerifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (totpCode.trim().length !== 6) return;
    setBusy(true);
    setError(null);
    const res = await apiClient.stepUp(totpCode.trim(), username || 'demo', actionId);
    setBusy(false);
    if (res.token) {
      onStepUpVerified?.(res.token);
      onClose();
    } else {
      setError(res.error || 'Invalid TOTP verification code');
    }
  };

  const handleVerifyPasskey = async () => {
    setBusy(true);
    setError(null);
    const res = await apiClient.stepUpWithPasskey(username || 'demo', actionId);
    setBusy(false);
    if (res.token) {
      onStepUpVerified?.(res.token);
      onClose();
    } else {
      setError(res.error || 'Passkey verification failed');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-label={title || (mode === 'step-up' ? 'Step-Up Verification' : 'Operator Authentication')}
    >
      <div
        className="w-full max-w-md p-6 rounded-2xl border shadow-2xl relative space-y-4 max-h-[90vh] overflow-y-auto"
        style={{
          backgroundColor: 'var(--surface-primary)',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-primary)',
        }}
      >
        <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-[var(--accent-muted)] text-[var(--accent-primary)] border border-[var(--border-highlight)]">
              {mode === 'step-up' ? <Fingerprint size={18} /> : <Lock size={18} />}
            </div>
            <div>
              <h3 className="font-bold text-base">
                {title || (mode === 'step-up' ? 'Step-Up Verification' : 'Operator Session & Security')}
              </h3>
              <p className="text-[11px] text-[var(--text-secondary)]">
                {description ||
                  (mode === 'step-up'
                    ? 'Confirm identity via Passkey / Biometric or 6-digit TOTP'
                    : 'Manage operator session, TOTP authenticator, and passkeys')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 cursor-pointer"
            aria-label="Close authentication modal"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="p-2.5 rounded-lg text-xs bg-[var(--status-critical-bg)] text-[var(--status-critical)] border border-[var(--status-critical-border)]">
            {error}
          </div>
        )}

        {statusMsg && (
          <div className="p-2.5 rounded-lg text-xs bg-[var(--status-success-bg)] text-[var(--status-success)] border border-[var(--status-success-border)] flex items-center gap-2">
            <CheckCircle2 size={14} />
            <span>{statusMsg}</span>
          </div>
        )}

        {mode === 'step-up' ? (
          <div className="space-y-4">
            <button
              type="button"
              disabled={busy}
              onClick={handleVerifyPasskey}
              className="web-btn-secondary w-full py-2.5 text-xs justify-center border-[var(--border-highlight)] text-[var(--accent-primary)]"
            >
              <Fingerprint size={16} />
              <span>Verify with Passkey / Biometric</span>
            </button>

            <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] font-mono uppercase">
              <div className="flex-1 h-px bg-[var(--border-subtle)]" />
              <span>or 6-digit TOTP code</span>
              <div className="flex-1 h-px bg-[var(--border-subtle)]" />
            </div>

            <form onSubmit={handleVerifyTotp} className="space-y-3">
              <div>
                <label htmlFor="modal-totp-input" className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                  Authenticator Code {isDemoMode ? '(Demo: 123456)' : ''}
                </label>
                <input
                  id="modal-totp-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder={isDemoMode ? '123456' : '000000'}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  className="web-input w-full text-sm font-mono tracking-widest text-center"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button type="button" onClick={onClose} className="web-btn-secondary text-xs">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || totpCode.length !== 6}
                  className="web-btn-primary text-xs disabled:opacity-50"
                >
                  <ShieldCheck size={14} />
                  <span>{busy ? 'Verifying...' : 'Confirm Step-Up'}</span>
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="space-y-4">
            {sessionInfo?.authenticated && sessionInfo.username && sessionInfo.username !== 'local_operator' && (
              <div className="p-3 rounded-xl bg-[var(--surface-hover)] border border-[var(--border-subtle)] text-xs flex items-center justify-between">
                <div>
                  <span className="text-[var(--text-muted)] block text-[10px] font-mono">ACTIVE SESSION</span>
                  <span className="font-semibold text-[var(--text-primary)] font-mono">
                    {sessionInfo.username} ({sessionInfo.role || 'admin'})
                  </span>
                </div>
                <button type="button" onClick={handleLogout} className="web-btn-secondary text-xs py-1 px-2.5">
                  <LogOut size={13} />
                  <span>Sign Out</span>
                </button>
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label htmlFor="auth-username" className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                  Operator Username / Email
                </label>
                <input
                  id="auth-username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="web-input w-full text-xs font-mono"
                />
              </div>

              <div>
                <label htmlFor="auth-password" className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                  Password {isDemoMode ? '(Demo: alexiaguardian2026)' : ''}
                </label>
                <input
                  id="auth-password"
                  type="password"
                  autoComplete="current-password"
                  placeholder={isDemoMode ? 'alexiaguardian2026' : '••••••••••••'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="web-input w-full text-xs font-mono"
                />
              </div>

              <div>
                <label htmlFor="auth-device" className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                  Device Label
                </label>
                <input
                  id="auth-device"
                  type="text"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  className="web-input w-full text-xs"
                />
              </div>

              <button
                type="submit"
                disabled={busy || !username.trim() || !password}
                className="web-btn-primary w-full text-xs py-2 disabled:opacity-50"
              >
                <KeyRound size={14} />
                <span>{busy ? 'Signing in...' : 'Sign In as Operator'}</span>
              </button>
            </form>

            <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2.5">
              <span className="text-[11px] font-semibold text-[var(--text-secondary)] block">
                Step-Up Authenticator & Passkey Enrollment
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleRegisterPasskey}
                  className="web-btn-secondary text-xs justify-center"
                >
                  <Fingerprint size={14} />
                  <span>Enroll Passkey</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleLoadTotpSetup}
                  className="web-btn-secondary text-xs justify-center"
                >
                  <Smartphone size={14} />
                  <span>TOTP Secret</span>
                </button>
              </div>

              {totpSetup && (
                <div className="p-3 rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2 text-xs font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[var(--text-muted)]">BASE32 TOTP SECRET</span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(totpSetup.secret);
                        setStatusMsg('Copied TOTP secret to clipboard.');
                      }}
                      className="text-[11px] text-[var(--accent-primary)] inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Copy size={11} />
                      <span>Copy</span>
                    </button>
                  </div>
                  <div className="text-[var(--accent-primary)] font-bold tracking-wider break-all">
                    {totpSetup.secret}
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] break-all">{totpSetup.otpauth_uri}</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

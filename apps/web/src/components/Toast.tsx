import {
  createContext, useContext, useState, useCallback, useMemo, useRef, type ReactNode,
} from 'react';

/**
 * One transient confirmation surface, shared by every screen.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 *
 * Ten screens each declared their own `flash` state, set it on success, and
 * never cleared it — so a green "Order placed" sat on the page through every
 * unrelated action that followed, and equally-weighty acts on other screens
 * confirmed nothing at all. A confirmation is by nature transient: it says a
 * thing happened, then gets out of the way. That is a toast, and there should
 * be exactly one of them.
 *
 * A success clears itself; an error lingers longer, because it may need
 * reading or acting on, and both can be dismissed by hand. Errors that belong
 * to a specific field or dialog are NOT toasts — they stay where the mistake
 * is; this is for page-level "it happened" / "it could not happen" feedback.
 */

type ToastKind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: ToastKind; message: string; }

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: number) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastCtx);
  if (!api) throw new Error('useToast must be used within a ToastProvider');
  return api;
}

const TTL: Record<ToastKind, number> = { success: 4500, info: 5500, error: 9000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = (seq.current += 1);
    setToasts((ts) => [...ts, { id, kind, message }]);
    window.setTimeout(() => dismiss(id), TTL[kind]);
  }, [dismiss]);

  // Stable across renders (push/dismiss are stable), so the context value never
  // changes — `children` keeps its element reference and does NOT re-render when
  // a toast is added or removed; only the viewport below does.
  const api = useMemo<ToastApi>(() => ({
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-viewport">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}
                 role={t.kind === 'error' ? 'alert' : 'status'}>
              <span className="toast-msg">{t.message}</span>
              <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
            </div>
          ))}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

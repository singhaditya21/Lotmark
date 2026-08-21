import { useRef, useEffect, type ReactNode } from 'react';

/**
 * A modal built on the native <dialog>.
 *
 * Native gives focus trapping, Escape-to-close and inertness of the page behind
 * for free — all things a hand-rolled overlay gets subtly wrong, and all things
 * a keyboard user notices immediately.
 */
export function Dialog({
  open, title, lede, onClose, children, footer,
}: {
  open: boolean; title: string; lede?: string | undefined;
  onClose: () => void; children: ReactNode; footer: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog className="modal wide" ref={ref} onCancel={onClose} aria-label={title}>
      <div className="body">
        <h1>{title}</h1>
        {lede && <p className="lede" style={{ marginBottom: 16 }}>{lede}</p>}
        {children}
        <div className="row" style={{ marginTop: 16 }}>{footer}</div>
      </div>
    </dialog>
  );
}

export function Field({
  label, hint, error, children,
}: { label: string; hint?: string | undefined; error?: string | undefined; children: ReactNode }) {
  return (
    <label className="f">
      <span>{label}{hint && <em className="muted"> — {hint}</em>}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/** Field-level errors from an RFC 9457 problem, keyed for inline display. */
export function useFieldErrors(problem: { errors?: Array<{ field: string; message: string }> } | null) {
  const map = new Map<string, string>();
  for (const e of problem?.errors ?? []) map.set(e.field, e.message);
  return map;
}

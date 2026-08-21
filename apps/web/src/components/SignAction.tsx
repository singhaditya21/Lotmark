import { useRef, useEffect, useState } from 'react';
import { ALL_MEANINGS, type Meaning } from '../lib/meanings';

/**
 * Collecting the MEANING of a signature — 21 CFR 11 §11.50(a)(3).
 *
 * The meaning is chosen by the signer and never inferred from context. A system
 * that decides on their behalf that clicking "Sign" meant "approval" has
 * recorded its own assumption, not the person's intent.
 */
export function SignAction({
  open, title, description, busy, error, onCancel, onSign,
}: {
  open: boolean;
  title: string;
  description: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSign: (meaning: Meaning, reason: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [meaning, setMeaning] = useState<Meaning>('approval');
  const [reason, setReason] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog className="modal" ref={ref} onCancel={onCancel} aria-label={title}>
      <div className="body">
        <h1>{title}</h1>
        <p className="lede" style={{ marginBottom: 14 }}>{description}</p>

        <label className="f">
          <span>Meaning of this signature</span>
          <select className="t" value={meaning} onChange={(e) => setMeaning(e.target.value as Meaning)}>
            {ALL_MEANINGS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>

        <label className="f">
          <span>Reason <span className="muted">(optional; recorded with the act)</span></span>
          <input className="t" value={reason} onChange={(e) => setReason(e.target.value)}
                 placeholder="Results reviewed and accepted" />
        </label>

        {error && <div className="note deny">{error}</div>}

        <div className="note info">
          This signature will be bound to the record's content. Altering the
          record afterwards will make it fail verification.
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => onSign(meaning, reason)} disabled={busy}>
            {busy ? 'Signing…' : 'Sign'}
          </button>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    </dialog>
  );
}

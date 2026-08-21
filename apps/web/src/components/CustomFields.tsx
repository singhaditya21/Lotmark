import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Dialog, Field } from './Dialog';
import { offered, stillNeeded, toInstant, type Option } from '../lib/custom-fields';

/**
 * The form a tenant designed, rendered.
 *
 * ── The server is the only validator ────────────────────────────────────────
 *
 * This app has no zod and deliberately no dependency on @lotmark/domain —
 * `surfaces.test.ts` re-declares permissions as literal strings rather than
 * importing them, and says why. So the definitions arrive as plain JSON and the
 * only client-side gate is presence: everything else — type, range, pattern,
 * picklist membership, unknown keys — is decided by the server against the same
 * definitions. Nothing is duplicated here, so nothing can drift.
 *
 * ── Retired options ─────────────────────────────────────────────────────────
 *
 * A retired picklist value is not offered, EXCEPT when this record already
 * holds it. Dropping it silently would render a stored value as a blank select,
 * and the next save would quietly lose it.
 */

type FieldType =
  | 'text' | 'textarea' | 'number' | 'integer' | 'boolean'
  | 'date' | 'datetime' | 'select' | 'multiselect';

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  helpText?: string;
  picklistKey?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  onCertificate: boolean;
}

interface Placement { field: FieldDef; span: number; readOnly: boolean }
interface Section { title: string; columns: number; collapsed: boolean; fields: Placement[] }

interface RecordFields {
  form: { layoutKey: string | null; sections: Section[]; picklists: Record<string, Option[]> };
  values: Record<string, unknown>;
  revision: number;
  recordedBy: string | null;
  recordedAt: string | null;
  frozen: boolean;
  parentState: string | null;
}

export function CustomFieldsDialog({
  entity, recordId, label, canWrite, onClose,
}: {
  entity: string;
  recordId: string;
  /** What to call the record in the heading, e.g. a lot code. */
  label: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const key = ['custom-fields', entity, recordId];

  const loaded = useQuery({
    queryKey: key,
    queryFn: () => api.get<RecordFields>(`/custom-fields/${entity}/${recordId}`),
  });

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Seeded from the server, and re-seeded whenever the revision moves — which
  // is what makes "reload and try again" after a conflict actually work.
  useEffect(() => {
    if (loaded.data) setValues(loaded.data.values);
  }, [loaded.data?.revision, loaded.data]);

  const save = useMutation({
    mutationFn: () => api.put<{ revision: number }>(`/custom-fields/${entity}/${recordId}`, {
      values,
      basedOnRevision: loaded.data?.revision ?? 0,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }),
    onSuccess: (r) => {
      setError(null);
      setReason('');
      setFlash(`Saved as revision ${r.revision}.`);
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (e) => {
      setFlash(null);
      setError(e instanceof ApiError ? e.problem.detail : 'Could not save.');
      // A conflict means somebody else moved the record on. Refetching is what
      // lets the person see their changes before deciding what to do.
      if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: key });
    },
  });

  const form = loaded.data?.form;
  const frozen = loaded.data?.frozen ?? false;
  const editable = canWrite && !frozen;

  const missing = stillNeeded(form?.sections ?? [], values);

  return (
    <Dialog
      open
      title={`Additional information · ${label}`}
      lede={
        form?.layoutKey
          ? undefined
          : 'No layout has been designed for this record type, so every field is shown in one section.'
      }
      onClose={onClose}
      footer={<>
        {editable && (
          <button className="btn" disabled={save.isPending || missing.length > 0}
                  title={missing.length > 0 ? `Still needed: ${missing.join(', ')}` : undefined}
                  onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>Close</button>
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }}
                onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? 'Hide history' : 'History'}
        </button>
      </>}
    >
      {loaded.isLoading && <div className="spinner">Loading…</div>}

      {form && form.sections.length === 0 && (
        <div className="note">
          Nobody has designed any custom fields for this record type yet. An administrator
          can add them under Configuration.
        </div>
      )}

      {frozen && (
        <div className="note warn">
          This record is <b>{loaded.data?.parentState}</b> and no longer accepts changes.
          Its values are part of a record somebody has attested to, so they are shown as they
          stand.
        </div>
      )}

      {!frozen && !canWrite && form && form.sections.length > 0 && (
        <div className="note">You can see these values but not change them.</div>
      )}

      {form?.sections.map((section) => (
        <fieldset key={section.title} style={{ border: 0, padding: 0, margin: '0 0 18px' }}>
          <legend style={{
            fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px',
            color: 'var(--muted)', padding: 0, marginBottom: 8,
          }}>
            {section.title}
          </legend>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${section.columns}, minmax(0, 1fr))`,
            gap: '0 14px',
          }}>
            {section.fields.map((placed) => (
              <div key={placed.field.key}
                   style={{ gridColumn: `span ${Math.min(placed.span, section.columns)}` }}>
                <Control
                  def={placed.field}
                  options={placed.field.picklistKey
                    ? form.picklists[placed.field.picklistKey] ?? [] : []}
                  value={values[placed.field.key]}
                  disabled={!editable || placed.readOnly}
                  onChange={(v) => setValues((prev) => ({ ...prev, [placed.field.key]: v }))}
                />
              </div>
            ))}
          </div>
        </fieldset>
      ))}

      {editable && form && form.sections.length > 0 && (
        <Field label="Why is this changing?" hint="optional; kept with the revision">
          <input className="t" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}

      {flash && <div className="note okbox">{flash}</div>}
      {error && <div className="note deny">{error}</div>}

      {loaded.data && loaded.data.revision > 0 && (
        <div className="note" style={{ marginTop: 12 }}>
          Revision {loaded.data.revision}
          {loaded.data.recordedBy && <> · recorded by {loaded.data.recordedBy}</>}
          {loaded.data.recordedAt && <> · {loaded.data.recordedAt.slice(0, 16).replace('T', ' ')}</>}
        </div>
      )}

      {showHistory && <History entity={entity} recordId={recordId} />}
    </Dialog>
  );
}

/** One control, chosen by the type the tenant configured. */
function Control({
  def, options, value, disabled, onChange,
}: {
  def: FieldDef;
  options: Option[];
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const hint = [
    def.helpText,
    def.required ? 'required' : undefined,
    def.onCertificate ? 'appears on the certificate' : undefined,
  ].filter(Boolean).join(' · ') || undefined;

  const common = { className: 't', disabled };

  switch (def.type) {
    case 'textarea':
      return (
        <Field label={def.label} hint={hint}>
          <textarea {...common} rows={3} maxLength={def.maxLength}
                    value={asText(value)} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );

    case 'number':
    case 'integer':
      return (
        <Field label={def.label} hint={hint}>
          <input {...common} type="number" inputMode={def.type === 'integer' ? 'numeric' : 'decimal'}
                 step={def.type === 'integer' ? 1 : 'any'} min={def.min} max={def.max}
                 value={value === undefined || value === null ? '' : String(value)}
                 onChange={(e) => onChange(
                   // '' means "cleared", which is absent — not zero.
                   e.target.value === '' ? undefined : Number(e.target.value))} />
        </Field>
      );

    case 'boolean':
      return (
        <Field label={def.label} hint={hint}>
          <label className="inline">
            <input type="checkbox" disabled={disabled} checked={value === true}
                   onChange={(e) => onChange(e.target.checked)} />
            <span>{def.helpText ?? 'Yes'}</span>
          </label>
        </Field>
      );

    case 'date':
      return (
        <Field label={def.label} hint={hint}>
          <input {...common} type="date" value={asText(value)}
                 onChange={(e) => onChange(e.target.value || undefined)} />
        </Field>
      );

    case 'datetime':
      return (
        <Field label={def.label} hint={hint}>
          {/*
            The control gives local time with no offset; the server wants an
            instant. Converting here rather than accepting both means there is
            one representation stored, and it is unambiguous.
          */}
          <input {...common} type="datetime-local"
                 value={asText(value).slice(0, 16)}
                 onChange={(e) => onChange(toInstant(e.target.value))} />
        </Field>
      );

    case 'select':
      return (
        <Field label={def.label} hint={hint}>
          <select {...common} value={asText(value)}
                  onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">Choose…</option>
            {offered(options, value).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}{o.retired ? ' (retired)' : ''}
              </option>
            ))}
          </select>
        </Field>
      );

    case 'multiselect': {
      const held = Array.isArray(value) ? (value as string[]) : [];
      return (
        <Field label={def.label} hint={hint}>
          <div className="picker">
            {offered(options, value).map((o) => (
              <label key={o.value} className={`pick ${held.includes(o.value) ? 'on' : ''}`}>
                <input type="checkbox" disabled={disabled} checked={held.includes(o.value)}
                       onChange={(e) => onChange(e.target.checked
                         ? [...held, o.value]
                         : held.filter((v) => v !== o.value))} />
                <span>{o.label}{o.retired ? ' (retired)' : ''}</span>
              </label>
            ))}
          </div>
        </Field>
      );
    }

    default:
      return (
        <Field label={def.label} hint={hint}>
          <input {...common} type="text" maxLength={def.maxLength} value={asText(value)}
                 onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
  }
}

function asText(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

function History({ entity, recordId }: { entity: string; recordId: string }) {
  const history = useQuery({
    queryKey: ['custom-fields', entity, recordId, 'history'],
    queryFn: () => api.get<{
      revisions: Array<{
        revision: number; values: Record<string, unknown>;
        recordedByName: string; recordedAt: string; reason: string | null;
      }>;
    }>(`/custom-fields/${entity}/${recordId}/history`),
  });

  if (history.isLoading) return <div className="spinner">Loading…</div>;
  const revisions = [...(history.data?.revisions ?? [])].reverse();

  return (
    <div className="preview" style={{ marginTop: 12 }}>
      <div className="lab">Every revision — newest first</div>
      {revisions.length === 0 ? (
        <div className="muted">Nothing has been recorded yet.</div>
      ) : revisions.map((r) => (
        <div key={r.revision} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12 }}>
            <b>Revision {r.revision}</b> · {r.recordedByName} ·{' '}
            <span className="mono">{r.recordedAt.slice(0, 16).replace('T', ' ')}</span>
            {r.reason && <> · {r.reason}</>}
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {Object.entries(r.values).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ') || '—'}
          </div>
        </div>
      ))}
    </div>
  );
}

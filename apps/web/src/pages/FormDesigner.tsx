import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast';
import { api, ApiError, type ConfigOverview, type ConfigVersionDetail, type ConfigReview } from '../lib/api';
import { Dialog, Field, useFieldErrors } from '../components/Dialog';
import { FormPreview, type Section } from '../components/CustomFields';
import type { Option } from '../lib/custom-fields';

/**
 * The form designer.
 *
 * ── Everything happens inside a draft ───────────────────────────────────────
 *
 * There is no "save" here that changes what anybody sees. A field is an entry
 * in a configuration DRAFT, and it reaches users only when that draft is
 * reviewed and published — under an electronic signature, because a field is a
 * behaviour change. That is not ceremony bolted onto a form builder; it is the
 * same path every other configuration change takes, and the reason this screen
 * sends you to Configuration to finish rather than publishing for you.
 *
 * ── The preview is the real renderer ────────────────────────────────────────
 *
 * The server resolves the draft's own entries through the runtime resolver and
 * this draws them with the runtime's controls. A preview assembled here from a
 * second copy of those rules could be right about a form the runtime renders
 * differently, which is worse than showing no preview.
 */

const ENTITIES = [
  'project', 'study', 'property_value', 'lot', 'order', 'entitlement', 'capa',
] as const;

/** The nine types that work end to end. The other three are refused on publish. */
const TYPES = [
  ['text', 'Short text'], ['textarea', 'Long text'], ['number', 'Number'],
  ['integer', 'Whole number'], ['boolean', 'Yes / no'], ['date', 'Date'],
  ['datetime', 'Date and time'], ['select', 'Choose one'], ['multiselect', 'Choose several'],
] as const;

/**
 * The optionals are written `?: T | undefined` deliberately.
 *
 * Under `exactOptionalPropertyTypes` a plain `?: T` accepts the key being
 * ABSENT but not the key being present and undefined — and the save below sets
 * them to undefined explicitly, to clear a value that no longer applies once
 * the type changes. Declaring the union is what says "absent and cleared are
 * the same thing here", which is exactly what the payload means.
 */
interface FieldPayload {
  key: string; entity: string; label: string; type: string;
  helpText?: string | undefined; required: boolean; picklistKey?: string | undefined;
  min?: number | undefined; max?: number | undefined;
  maxLength?: number | undefined; pattern?: string | undefined;
  onCertificate: boolean; sortOrder: number;
}
interface PicklistPayload {
  key: string; name: string;
  values: Array<{ value: string; label: string; retired: boolean; sortOrder: number }>;
}
interface LayoutPayload {
  key: string; entity: string; name: string; roles: string[];
  sections: Array<{
    title: string; columns: number; collapsed: boolean;
    fields: Array<{ field: string; span: number; readOnly: boolean }>;
  }>;
}

export function FormDesigner() {
  const qc = useQueryClient();
  const [entity, setEntity] = useState<string>('lot');
  const [reason, setReason] = useState('');
  const [editingField, setEditingField] = useState<FieldPayload | null>(null);
  const [editingList, setEditingList] = useState<PicklistPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<ApiError['problem'] | null>(null);
  const toast = useToast();

  const overview = useQuery({
    queryKey: ['config'], queryFn: () => api.get<ConfigOverview>('/admin/config'),
  });
  const draftId = overview.data?.draftId ?? null;

  const draft = useQuery({
    queryKey: ['config-version', draftId],
    queryFn: () => api.get<ConfigVersionDetail>(`/admin/config/${draftId}`),
    enabled: draftId !== null,
  });

  const review = useQuery({
    queryKey: ['config-review', draftId],
    queryFn: () => api.get<ConfigReview>(`/admin/config/draft/${draftId}/review`),
    enabled: draftId !== null,
  });

  const preview = useQuery({
    queryKey: ['draft-form', draftId, entity],
    queryFn: () => api.get<{ form: { sections: Section[]; picklists: Record<string, Option[]> } }>(
      `/admin/config/draft/${draftId}/form/${entity}`),
    enabled: draftId !== null,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['config'] });
    void qc.invalidateQueries({ queryKey: ['config-version', draftId] });
    void qc.invalidateQueries({ queryKey: ['config-review', draftId] });
    void qc.invalidateQueries({ queryKey: ['draft-form', draftId] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };

  const openDraft = useMutation({
    mutationFn: () => api.post<{ id: string }>('/admin/config/draft', { changeReason: reason }),
    onSuccess: () => { setReason(''); toast.success('Draft opened. Nothing you do here is live until it is published.'); refresh(); },
    onError: (e) => setError(e instanceof ApiError ? e.problem.detail : 'Could not open a draft.'),
  });

  const putEntry = useMutation({
    mutationFn: (v: { kind: string; key: string; payload: unknown }) =>
      api.put(`/admin/config/draft/${draftId}/entry`, v),
    onSuccess: () => { setEditingField(null); setEditingList(null); setError(null); setProblem(null); refresh(); },
    onError: (e) => {
      if (e instanceof ApiError) { setProblem(e.problem); setError(e.problem.detail); }
      else setError('Could not save that.');
    },
  });

  const removeEntry = useMutation({
    mutationFn: (v: { kind: string; key: string }) =>
      api.del(`/admin/config/draft/${draftId}/entry/${v.kind}/${v.key}`),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.problem.detail : 'Could not remove that.'),
  });

  const entries = draft.data?.entries ?? [];
  const fields = entries.filter((e) => e.kind === 'field')
    .map((e) => e.payload as FieldPayload)
    .filter((f) => f.entity === entity)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
  const picklists = entries.filter((e) => e.kind === 'picklist')
    .map((e) => e.payload as PicklistPayload);
  const layout = entries.filter((e) => e.kind === 'layout')
    .map((e) => e.payload as LayoutPayload)
    .find((l) => l.entity === entity) ?? null;

  /* ── No draft: the one thing to do ──────────────────────────────────────── */

  if (overview.isLoading) return <div className="spinner">Loading…</div>;

  if (!draftId) {
    return (
      <>
        <h1>Form designer</h1>
        <p className="lede">
          Fields, option lists and layouts are configuration, so they are designed in a draft and
          take effect when that draft is published under signature. Nothing here is live until
          then.
        </p>
        <div className="card pad" style={{ maxWidth: 560 }}>
          <h2 className="card-title">Open a draft to begin</h2>
          <Field label="Why is this changing?"
                 hint="required; it becomes the version’s permanent explanation">
            <input className="t" value={reason} onChange={(e) => setReason(e.target.value)}
                   placeholder="Add a filling record to lots" />
          </Field>
          {error && <div className="note deny">{error}</div>}
          <button className="btn" disabled={openDraft.isPending || !reason.trim()}
                  onClick={() => openDraft.mutate()}>
            {openDraft.isPending ? 'Opening…' : 'Open a draft'}
          </button>
        </div>
      </>
    );
  }

  /* ── The designer ───────────────────────────────────────────────────────── */

  const problems = review.data?.problems ?? [];

  return (
    <>
      <h1>Form designer</h1>
      <p className="lede">
        Everything here is edited in draft {draft.data?.version.number} and reaches people only
        when it is published. Go to <b>Configuration</b> to review and sign it.
      </p>

      {error && <div className="note deny">{error}</div>}

      {problems.length > 0 && (
        <div className="note deny">
          <b>This draft cannot be published yet.</b>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      <div className="row" style={{ margin: '14px 0' }}>
        {ENTITIES.map((e) => (
          <button key={e} className={`btn sm ${e === entity ? '' : 'ghost'}`}
                  onClick={() => setEntity(e)}>
            {e.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      <div className="grid2" style={{ alignItems: 'start', gap: 14 }}>
        <div>
          {/* ── Fields ──────────────────────────────────────────────────── */}
          <div className="card">
            <div className="pad" style={{ paddingBottom: 8 }}>
              <div className="row">
                <h2 className="card-title">Fields on {entity.replace(/_/g, ' ')}</h2>
                <button className="btn sm" style={{ marginLeft: 'auto' }}
                        onClick={() => setEditingField({
                          key: '', entity, label: '', type: 'text',
                          required: false, onCertificate: false,
                          sortOrder: (fields[fields.length - 1]?.sortOrder ?? 0) + 1,
                        })}>
                  Add a field
                </button>
              </div>
            </div>
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>Key</th><th>Label</th><th>Type</th><th>Required</th><th /></tr>
                </thead>
                <tbody>
                  {fields.length === 0 ? (
                    <tr><td colSpan={5} className="muted">No fields yet.</td></tr>
                  ) : fields.map((f) => (
                    <tr key={f.key}>
                      <td className="mono">{f.key}</td>
                      <td>{f.label}{f.onCertificate && (
                        <span className="chip warn" style={{ marginLeft: 6 }}>on certificate</span>
                      )}</td>
                      <td className="muted">{TYPES.find((t) => t[0] === f.type)?.[1] ?? f.type}</td>
                      <td>{f.required ? 'yes' : '—'}</td>
                      <td>
                        <button className="btn ghost sm" onClick={() => setEditingField(f)}>Edit</button>
                        <button className="btn ghost sm" style={{ marginLeft: 6 }}
                                onClick={() => removeEntry.mutate({ kind: 'field', key: f.key })}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Option lists ────────────────────────────────────────────── */}
          <div className="card">
            <div className="pad" style={{ paddingBottom: 8 }}>
              <div className="row">
                <h2 className="card-title">Option lists</h2>
                <button className="btn sm" style={{ marginLeft: 'auto' }}
                        onClick={() => setEditingList({
                          key: '', name: '',
                          values: [{ value: '', label: '', retired: false, sortOrder: 1 }],
                        })}>
                  Add a list
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
                Shared across every record type. Retiring a value stops it being offered and
                leaves the records that already hold it alone.
              </p>
            </div>
            <div className="scroll">
              <table>
                <thead><tr><th>Key</th><th>Name</th><th>Values</th><th /></tr></thead>
                <tbody>
                  {picklists.length === 0 ? (
                    <tr><td colSpan={4} className="muted">No option lists yet.</td></tr>
                  ) : picklists.map((l) => (
                    <tr key={l.key}>
                      <td className="mono">{l.key}</td>
                      <td>{l.name}</td>
                      <td className="muted">
                        {l.values.filter((v) => !v.retired).length} live
                        {l.values.some((v) => v.retired) &&
                          ` · ${l.values.filter((v) => v.retired).length} retired`}
                      </td>
                      <td>
                        <button className="btn ghost sm" onClick={() => setEditingList(l)}>Edit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <LayoutEditor
            entity={entity}
            layout={layout}
            fields={fields}
            onSave={(payload) => putEntry.mutate({ kind: 'layout', key: payload.key, payload })}
            onRemove={(key) => removeEntry.mutate({ kind: 'layout', key })}
            busy={putEntry.isPending}
          />
        </div>

        {/* ── Preview ───────────────────────────────────────────────────── */}
        <div className="card pad" style={{ position: 'sticky', top: 12 }}>
          <h2 className="card-title">Preview</h2>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            Drawn by the same renderer the record screens use, from this draft.
          </p>
          {preview.isLoading ? <div className="spinner">Loading…</div> : (
            <FormPreview
              sections={preview.data?.form.sections ?? []}
              picklists={preview.data?.form.picklists ?? {}}
            />
          )}
        </div>
      </div>

      {editingField && (
        <FieldDialog
          value={editingField}
          picklists={picklists}
          problem={problem}
          busy={putEntry.isPending}
          onCancel={() => { setEditingField(null); setProblem(null); setError(null); }}
          onSave={(f) => putEntry.mutate({ kind: 'field', key: f.key, payload: f })}
        />
      )}

      {editingList && (
        <PicklistDialog
          value={editingList}
          problem={problem}
          busy={putEntry.isPending}
          onCancel={() => { setEditingList(null); setProblem(null); setError(null); }}
          onSave={(l) => putEntry.mutate({ kind: 'picklist', key: l.key, payload: l })}
        />
      )}
    </>
  );
}

/* ── Defining one field ───────────────────────────────────────────────────── */

function FieldDialog({
  value, picklists, problem, busy, onSave, onCancel,
}: {
  value: FieldPayload;
  picklists: PicklistPayload[];
  problem: ApiError['problem'] | null;
  busy: boolean;
  onSave: (f: FieldPayload) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<FieldPayload>(value);
  const errors = useFieldErrors(problem);
  const set = (patch: Partial<FieldPayload>) => setF((prev) => ({ ...prev, ...patch }));
  const needsList = f.type === 'select' || f.type === 'multiselect';
  const numeric = f.type === 'number' || f.type === 'integer';
  const textual = f.type === 'text' || f.type === 'textarea';

  const ready = f.key.trim() !== '' && f.label.trim() !== '' && (!needsList || !!f.picklistKey);

  return (
    <Dialog
      open
      title={value.key ? `Field · ${value.key}` : 'A new field'}
      lede="The key is how the value is stored, and it cannot be changed once records hold values under it."
      onClose={onCancel}
      footer={<>
        <button className="btn" disabled={busy || !ready}
                onClick={() => onSave({
                  ...f,
                  key: f.key.trim(),
                  label: f.label.trim(),
                  // Omitted rather than sent empty, so the payload says what it means.
                  ...(f.helpText?.trim() ? { helpText: f.helpText.trim() } : { helpText: undefined }),
                  ...(needsList ? {} : { picklistKey: undefined }),
                  ...(numeric ? {} : { min: undefined, max: undefined }),
                  ...(textual ? {} : { maxLength: undefined, pattern: undefined }),
                })}>
          {busy ? 'Saving…' : 'Save to the draft'}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </>}
    >
      <div className="grid2">
        <Field label="Key" hint="lower-case letters, digits, hyphen or underscore"
               error={errors.get('key')}>
          <input className="t mono" value={f.key} disabled={value.key !== ''}
                 onChange={(e) => set({ key: e.target.value })} placeholder="batch_origin" />
        </Field>
        <Field label="Label" hint="what a person reads" error={errors.get('label')}>
          <input className="t" value={f.label} onChange={(e) => set({ label: e.target.value })}
                 placeholder="Batch origin" />
        </Field>
      </div>

      <div className="grid2">
        <Field label="Type">
          <select className="t" value={f.type} disabled={value.key !== ''}
                  onChange={(e) => set({ type: e.target.value })}>
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Order" hint="lower numbers first">
          <input className="t" type="number" value={f.sortOrder}
                 onChange={(e) => set({ sortOrder: Number(e.target.value) })} />
        </Field>
      </div>

      {value.key !== '' && (
        <div className="note">
          The key and the type are fixed once a field exists. Changing a type would reinterpret
          what records already hold under it — add a new field instead.
        </div>
      )}

      <Field label="Help text" hint="optional; shown beside the label">
        <input className="t" value={f.helpText ?? ''}
               onChange={(e) => set({ helpText: e.target.value })} />
      </Field>

      {needsList && (
        <Field label="Option list" hint="required for a choice field" error={errors.get('picklistKey')}>
          <select className="t" value={f.picklistKey ?? ''}
                  onChange={(e) => set({ picklistKey: e.target.value || undefined })}>
            <option value="">Choose…</option>
            {picklists.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}
          </select>
        </Field>
      )}

      {numeric && (
        <div className="grid2">
          <Field label="Smallest allowed" hint="optional">
            <input className="t" type="number" value={f.min ?? ''}
                   onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </Field>
          <Field label="Largest allowed" hint="optional">
            <input className="t" type="number" value={f.max ?? ''}
                   onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </Field>
        </div>
      )}

      {textual && (
        <div className="grid2">
          <Field label="Longest allowed" hint="optional, in characters">
            <input className="t" type="number" value={f.maxLength ?? ''}
                   onChange={(e) => set({ maxLength: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </Field>
          <Field label="Must match" hint="optional; a regular expression" error={errors.get('pattern')}>
            <input className="t mono" value={f.pattern ?? ''}
                   onChange={(e) => set({ pattern: e.target.value || undefined })} />
          </Field>
        </div>
      )}

      <Field label="Required">
        <label className="inline">
          <input type="checkbox" checked={f.required}
                 onChange={(e) => set({ required: e.target.checked })} />
          <span>A record cannot be saved without it. Every layout must place it somewhere.</span>
        </label>
      </Field>

      <Field label="On the certificate">
        <label className="inline">
          <input type="checkbox" checked={f.onCertificate}
                 onChange={(e) => set({ onCertificate: e.target.checked })} />
          <span>Print this value on the issued certificate.</span>
        </label>
      </Field>

      {problem && <div className="note deny">{problem.detail}</div>}
    </Dialog>
  );
}

/* ── Defining one option list ─────────────────────────────────────────────── */

function PicklistDialog({
  value, problem, busy, onSave, onCancel,
}: {
  value: PicklistPayload;
  problem: ApiError['problem'] | null;
  busy: boolean;
  onSave: (l: PicklistPayload) => void;
  onCancel: () => void;
}) {
  const [l, setL] = useState<PicklistPayload>(value);
  const ready = l.key.trim() !== '' && l.name.trim() !== ''
    && l.values.length > 0 && l.values.every((v) => v.value.trim() && v.label.trim());

  const setValue = (i: number, patch: Partial<PicklistPayload['values'][number]>) =>
    setL((prev) => ({
      ...prev,
      values: prev.values.map((v, n) => (n === i ? { ...v, ...patch } : v)),
    }));

  return (
    <Dialog
      open
      title={value.key ? `Option list · ${value.key}` : 'A new option list'}
      lede="Retire a value rather than deleting it: records that already hold it keep it, and it stops being offered."
      onClose={onCancel}
      footer={<>
        <button className="btn" disabled={busy || !ready}
                onClick={() => onSave({ ...l, key: l.key.trim(), name: l.name.trim() })}>
          {busy ? 'Saving…' : 'Save to the draft'}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </>}
    >
      <div className="grid2">
        <Field label="Key" hint="lower-case slug">
          <input className="t mono" value={l.key} disabled={value.key !== ''}
                 onChange={(e) => setL({ ...l, key: e.target.value })} placeholder="packaging" />
        </Field>
        <Field label="Name">
          <input className="t" value={l.name} onChange={(e) => setL({ ...l, name: e.target.value })}
                 placeholder="Packaging" />
        </Field>
      </div>

      <Field label="Values" hint="the stored value, and what a person reads">
        <div className="picker" style={{ maxHeight: 260 }}>
          {l.values.map((v, i) => (
            <div key={i} className="row" style={{ gap: 6, padding: '4px 0' }}>
              <input className="t mono" style={{ width: 130 }} value={v.value}
                     placeholder="ampoule_2ml"
                     onChange={(e) => setValue(i, { value: e.target.value })} />
              <input className="t" style={{ flex: 1 }} value={v.label}
                     placeholder="2 mL amber ampoule"
                     onChange={(e) => setValue(i, { label: e.target.value })} />
              <label className="inline" title="Retired values stay on records that hold them">
                <input type="checkbox" checked={v.retired}
                       onChange={(e) => setValue(i, { retired: e.target.checked })} />
                <span style={{ fontSize: 12 }}>retired</span>
              </label>
              <button className="btn ghost sm"
                      onClick={() => setL({ ...l, values: l.values.filter((_, n) => n !== i) })}>
                ×
              </button>
            </div>
          ))}
        </div>
      </Field>

      <button className="btn ghost sm"
              onClick={() => setL({
                ...l,
                values: [...l.values, {
                  value: '', label: '', retired: false, sortOrder: l.values.length + 1,
                }],
              })}>
        Add a value
      </button>

      {problem && <div className="note deny" style={{ marginTop: 10 }}>{problem.detail}</div>}
    </Dialog>
  );
}

/* ── Arranging them ───────────────────────────────────────────────────────── */

function LayoutEditor({
  entity, layout, fields, onSave, onRemove, busy,
}: {
  entity: string;
  layout: LayoutPayload | null;
  fields: FieldPayload[];
  onSave: (l: LayoutPayload) => void;
  onRemove: (key: string) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<LayoutPayload | null>(null);
  const working = draft ?? layout;

  const placed = new Set((working?.sections ?? []).flatMap((s) => s.fields.map((f) => f.field)));
  const unplaced = fields.filter((f) => !placed.has(f.key));

  const start = (): LayoutPayload => ({
    key: `${entity}_form`, entity, name: `${entity.replace(/_/g, ' ')} form`, roles: [],
    sections: [{
      title: 'Additional information', columns: 2, collapsed: false,
      fields: fields.map((f) => ({ field: f.key, span: 1, readOnly: false })),
    }],
  });

  return (
    <div className="card">
      <div className="pad" style={{ paddingBottom: 8 }}>
        <div className="row">
          <h2 className="card-title">Layout</h2>
          {!working && (
            <button className="btn sm" style={{ marginLeft: 'auto' }}
                    disabled={fields.length === 0}
                    title={fields.length === 0 ? 'Add a field first' : undefined}
                    onClick={() => setDraft(start())}>
              Arrange these fields
            </button>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
          {working
            ? 'A layout decides what is shown and where. Once one exists it is authoritative — a field it does not place is not rendered.'
            : 'Without a layout every field is shown in one section, ordered by its number. That is often enough.'}
        </p>
      </div>

      {working && (
        <div className="pad" style={{ paddingTop: 0 }}>
          {working.sections.map((section, si) => (
            <div key={si} className="preview" style={{ marginBottom: 10 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <input className="t" style={{ flex: 1 }} value={section.title}
                       onChange={(e) => setDraft({
                         ...working,
                         sections: working.sections.map((s, n) =>
                           n === si ? { ...s, title: e.target.value } : s),
                       })} />
                <select className="t" style={{ width: 110 }} value={section.columns}
                        onChange={(e) => setDraft({
                          ...working,
                          sections: working.sections.map((s, n) =>
                            n === si ? { ...s, columns: Number(e.target.value) } : s),
                        })}>
                  {[1, 2, 3, 4].map((c) => <option key={c} value={c}>{c} column{c > 1 ? 's' : ''}</option>)}
                </select>
                <button className="btn ghost sm"
                        onClick={() => setDraft({
                          ...working,
                          sections: working.sections.filter((_, n) => n !== si),
                        })}>
                  Remove section
                </button>
              </div>

              {section.fields.map((p, fi) => (
                <div key={p.field} className="row" style={{ gap: 6, padding: '2px 0' }}>
                  <span className="mono" style={{ flex: 1, fontSize: 12.5 }}>{p.field}</span>
                  <select className="t" style={{ width: 96 }} value={p.span}
                          onChange={(e) => setDraft({
                            ...working,
                            sections: working.sections.map((s, n) => n === si ? {
                              ...s,
                              fields: s.fields.map((q, m) =>
                                m === fi ? { ...q, span: Number(e.target.value) } : q),
                            } : s),
                          })}>
                    {[1, 2, 3, 4].map((c) => <option key={c} value={c}>span {c}</option>)}
                  </select>
                  <label className="inline">
                    <input type="checkbox" checked={p.readOnly}
                           onChange={(e) => setDraft({
                             ...working,
                             sections: working.sections.map((s, n) => n === si ? {
                               ...s,
                               fields: s.fields.map((q, m) =>
                                 m === fi ? { ...q, readOnly: e.target.checked } : q),
                             } : s),
                           })} />
                    <span style={{ fontSize: 12 }}>read-only</span>
                  </label>
                  <button className="btn ghost sm"
                          onClick={() => setDraft({
                            ...working,
                            sections: working.sections.map((s, n) => n === si
                              ? { ...s, fields: s.fields.filter((_, m) => m !== fi) } : s),
                          })}>
                    ×
                  </button>
                </div>
              ))}

              {unplaced.length > 0 && (
                <select className="t" style={{ marginTop: 6 }} value=""
                        onChange={(e) => e.target.value && setDraft({
                          ...working,
                          sections: working.sections.map((s, n) => n === si ? {
                            ...s,
                            fields: [...s.fields, { field: e.target.value, span: 1, readOnly: false }],
                          } : s),
                        })}>
                  <option value="">Place a field here…</option>
                  {unplaced.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              )}
            </div>
          ))}

          <div className="row">
            <button className="btn ghost sm"
                    onClick={() => setDraft({
                      ...working,
                      sections: [...working.sections, {
                        title: 'New section', columns: 2, collapsed: false, fields: [],
                      }],
                    })}>
              Add a section
            </button>
            <button className="btn sm" disabled={busy || draft === null}
                    onClick={() => { onSave(working); setDraft(null); }}>
              {busy ? 'Saving…' : 'Save the layout'}
            </button>
            {draft && (
              <button className="btn ghost sm" onClick={() => setDraft(null)}>Discard changes</button>
            )}
            {layout && !draft && (
              <button className="btn ghost sm" onClick={() => onRemove(layout.key)}>
                Remove the layout
              </button>
            )}
          </div>

          {unplaced.length > 0 && (
            <div className="note warn" style={{ marginTop: 10 }}>
              Not placed anywhere: {unplaced.map((f) => f.label).join(', ')}. A layout is
              authoritative, so these will not be rendered — and a <b>required</b> field left out
              cannot be published.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

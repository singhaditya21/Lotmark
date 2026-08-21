import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api, ApiError,
  type ConfigOverview, type ConfigVersionDetail, type ConfigReview, type ConfigChange,
} from '../lib/api';
import { Dialog, Field } from '../components/Dialog';
import { StepUp } from '../components/StepUp';
import { ALL_MEANINGS, type Meaning } from '../lib/meanings';

/**
 * Configuration administration.
 *
 * The configuration model has been enforced since the first migration and there
 * has never been a way to use it: every role, workflow and numbering template
 * came from the seed. "Everything is configurable" described the schema and not
 * the product.
 *
 * ── The one rule this screen has to make obvious ────────────────────────────
 *
 * A published version is never edited. Editing means opening a NEW draft based
 * on it and publishing that. The screen shows the published versions as
 * read-only history and puts every edit inside the draft, so the rule is
 * visible in the layout rather than discovered through an error message.
 */

const RISK_TONE: Record<string, string> = {
  security: 'bad', behaviour: 'warn', presentation: 'grey',
};

export function Configuration() {
  const qc = useQueryClient();
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState(false);
  const [reason, setReason] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [meaning, setMeaning] = useState<Meaning>('approval');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [stepUpFor, setStepUpFor] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ConfigOverview>('/admin/config'),
  });

  const detail = useQuery({
    queryKey: ['config-version', openVersion],
    enabled: openVersion !== null,
    queryFn: () => api.get<ConfigVersionDetail>(`/admin/config/${openVersion}`),
  });

  const draftId = overview.data?.draftId ?? null;

  const review = useQuery({
    queryKey: ['config-review', draftId],
    enabled: draftId !== null && reviewing,
    queryFn: () => api.get<ConfigReview>(`/admin/config/draft/${draftId}/review`),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['config'] });
    void qc.invalidateQueries({ queryKey: ['config-review'] });
    void qc.invalidateQueries({ queryKey: ['config-version'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };

  const fail = (e: unknown, purpose: string) => {
    if (e instanceof ApiError && e.needsStepUp) { setStepUpFor(purpose); return; }
    setError(e instanceof ApiError ? e.problem.detail : 'That could not be completed.');
  };

  const open = useMutation({
    mutationFn: () => api.post<{ id: string; number: number }>('/admin/config/draft', { changeReason: reason }),
    onSuccess: (r) => {
      setNewDraft(false); setReason(''); setError(null);
      setFlash(`Draft version ${r.number} is open. Nothing changes until you publish it.`);
      refresh();
    },
    onError: (e) => fail(e, 'open a configuration draft'),
  });

  const publish = useMutation({
    mutationFn: () =>
      api.post<{ number: number; changes: ConfigChange[]; signed: boolean }>(
        `/admin/config/draft/${draftId}/publish`, { meaning },
      ),
    onSuccess: (r) => {
      setReviewing(false); setError(null);
      setFlash(
        `Version ${r.number} is now active — ${r.changes.length} change(s), ` +
        `${r.signed ? 'signed' : 'presentation only, so unsigned'}.`,
      );
      refresh();
    },
    onError: (e) => fail(e, 'publish a configuration version'),
  });

  const discard = useMutation({
    mutationFn: () => api.del(`/admin/config/draft/${draftId}`),
    onSuccess: () => {
      setReviewing(false); setError(null);
      setFlash('The draft was discarded. The active configuration is unchanged.');
      refresh();
    },
    onError: (e) => fail(e, 'discard a draft'),
  });

  return (
    <>
      <h1>Configuration</h1>
      <p className="lede">
        Roles, workflows, numbering and every other configurable artefact live in
        a VERSION. A published version is never edited — changing anything means
        opening a draft based on it, which is what makes "under what rules was
        this certificate issued" answerable years later.
      </p>

      {flash && <div className="note okbox">{flash}</div>}
      {error && <div className="note deny">{error}</div>}

      <div className="row" style={{ margin: '12px 0' }}>
        {draftId ? (
          <>
            <button className="btn" onClick={() => { setReviewing(true); setError(null); }}>
              Review and publish the draft
            </button>
            <button className="btn ghost" onClick={() => discard.mutate()} disabled={discard.isPending}>
              Discard the draft
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => { setNewDraft(true); setError(null); }}>
            Open a draft
          </button>
        )}
      </div>

      {draftId && (
        <div className="note info">
          A draft is open. It changes nothing until it is published, and only one
          can exist at a time — two would be a fork, and whichever published
          second would silently discard the other's changes.
        </div>
      )}

      <div className="card" style={{ marginTop: 13 }}>
        <div className="pad" style={{ paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Versions</h2>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Version</th><th>Status</th><th>Changes</th><th>Signed</th><th>Published</th><th>Reason</th><th /></tr>
            </thead>
            <tbody>
              {(overview.data?.versions ?? []).map((v) => (
                <tr key={v.id}>
                  <td className="mono"><b>{v.number}</b></td>
                  <td>
                    <span className={`chip ${v.status === 'active' ? 'ok' : v.status === 'draft' ? 'warn' : 'grey'}`}>
                      {v.status}
                    </span>
                  </td>
                  <td className="mono">{v.changeCount || '—'}</td>
                  <td>
                    {/*
                      Three different facts, and only one of them is "unsigned
                      because the change was cosmetic". The seeded first version
                      has no diff at all — calling that "presentation only"
                      describes a decision nobody made.
                    */}
                    {v.status === 'draft' ? <span className="muted">—</span>
                      : v.signed ? <span className="chip ok">signed</span>
                      : v.changeCount === 0 ? <span className="muted">initial version</span>
                      : <span className="muted">presentation only</span>}
                  </td>
                  <td className="mono muted">{v.publishedAt ? String(v.publishedAt).slice(0, 10) : '—'}</td>
                  <td className="muted">{v.reason}</td>
                  <td>
                    <button className="btn ghost sm" onClick={() => setOpenVersion(v.id)}>Entries</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 13 }}>
        <h2 style={{ marginTop: 0 }}>What needs a signature</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Security and behaviour changes require an electronic signature to
          publish. Presentation changes are audited but unsigned, because
          demanding a signature to move a field on a form trains people to sign
          without reading — which is worse than not asking.
        </p>
        <div className="row">
          {Object.entries(overview.data?.kinds ?? {}).map(([kind, k]) => (
            <span key={kind} className={`chip ${RISK_TONE[k.risk] ?? 'grey'}`} title={`${k.risk}${k.signed ? ' — needs a signature' : ''}`}>
              {kind}
            </span>
          ))}
        </div>
      </div>

      {/* ── Opening a draft ─────────────────────────────────────────────── */}
      <Dialog
        open={newDraft}
        title="Open a configuration draft"
        lede="The draft starts as a copy of the active version. Nothing changes for anybody until it is published."
        onClose={() => setNewDraft(false)}
        footer={<>
          <button className="btn" disabled={open.isPending || reason.trim().length === 0}
                  onClick={() => open.mutate()}>
            {open.isPending ? 'Opening…' : 'Open draft'}
          </button>
          <button className="btn ghost" onClick={() => setNewDraft(false)}>Cancel</button>
        </>}
      >
        <Field label="Why is this changing?" hint="required; it is the version's permanent explanation">
          <textarea className="t" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="Add a Senior Scientist role so section leads can authorise values" />
        </Field>
      </Dialog>

      {/* ── Reviewing and publishing ────────────────────────────────────── */}
      <Dialog
        open={reviewing}
        title="Publish this configuration"
        lede="Everything that would stop this publishing is listed at once, rather than one at a time."
        onClose={() => setReviewing(false)}
        footer={<>
          <button className="btn"
                  disabled={publish.isPending || !review.data?.publishable}
                  title={review.data?.publishable ? '' : 'Resolve the problems below first'}
                  onClick={() => publish.mutate()}>
            {publish.isPending ? 'Publishing…' : review.data?.needsSignature ? 'Sign and publish' : 'Publish'}
          </button>
          <button className="btn ghost" onClick={() => setReviewing(false)}>Cancel</button>
        </>}
      >
        {review.isLoading && <p className="muted">Checking…</p>}

        {(review.data?.problems ?? []).length > 0 && (
          <div className="note deny">
            <b>This cannot be published yet.</b>
            <ul className="plain">
              {review.data!.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )}

        {review.data && review.data.changes.length === 0 && (
          <div className="note warn">
            This draft changes nothing. Publishing it would add a version to the
            history that no record was ever created under.
          </div>
        )}

        {(review.data?.changes ?? []).length > 0 && (
          <>
            <h2 style={{ fontSize: 15 }}>{review.data!.changes.length} change(s)</h2>
            <div className="scroll">
              <table>
                <thead><tr><th>Kind</th><th>Key</th><th>Change</th><th>Risk</th></tr></thead>
                <tbody>
                  {review.data!.changes.map((c) => (
                    <tr key={`${c.kind}:${c.key}`}>
                      <td className="mono">{c.kind}</td>
                      <td className="mono">{c.key}</td>
                      <td>{c.change}</td>
                      <td><span className={`chip ${RISK_TONE[c.risk] ?? 'grey'}`}>{c.risk}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {review.data?.needsSignature && (
          <>
            <Field label="Meaning of this signature">
              <select className="t" value={meaning} onChange={(e) => setMeaning(e.target.value as Meaning)}>
                {ALL_MEANINGS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </Field>
            <div className="note info">
              Your signature covers the change list above — not the configuration
              as a whole, so it still means something after an unrelated entry
              moves.
            </div>
          </>
        )}
      </Dialog>

      {/* ── One version's entries ───────────────────────────────────────── */}
      {openVersion && (
        <Dialog
          open
          title={detail.data ? `Version ${detail.data.version.number} · ${detail.data.version.status}` : 'Version'}
          lede={detail.data?.version.reason}
          onClose={() => setOpenVersion(null)}
          footer={<button className="btn ghost" onClick={() => setOpenVersion(null)}>Close</button>}
        >
          {detail.data?.version.status !== 'draft' && (
            <div className="note info">
              Published configuration is read-only. To change any of this, open a
              draft — the version a record was created under has to stay exactly
              as it was.
            </div>
          )}
          <div className="scroll">
            <table>
              <thead><tr><th>Kind</th><th>Key</th><th>Summary</th></tr></thead>
              <tbody>
                {(detail.data?.entries ?? []).map((e) => (
                  <tr key={`${e.kind}:${e.key}`}>
                    <td className="mono">{e.kind}</td>
                    <td className="mono">{e.key}</td>
                    <td className="muted">{summarise(e.payload)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Dialog>
      )}

      <StepUp
        open={stepUpFor !== null}
        purpose={stepUpFor ?? ''}
        onClose={() => setStepUpFor(null)}
        onUnlocked={() => { setStepUpFor(null); setFlash('Signing session open. Try again.'); }}
      />
    </>
  );
}

/** A one-line description of an entry, without dumping raw JSON at the reader. */
function summarise(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return String(payload);
  const p = payload as Record<string, unknown>;
  if (Array.isArray(p['permissions'])) {
    return `${p['name'] ?? ''} — ${(p['permissions'] as unknown[]).length} permission(s)`;
  }
  if (Array.isArray(p['transitions'])) {
    return `${p['name'] ?? ''} — ${(p['transitions'] as unknown[]).length} transition(s)`;
  }
  if (typeof p['template'] === 'string') return String(p['template']);
  if (typeof p['name'] === 'string') return p['name'];
  return Object.keys(p).slice(0, 4).join(', ');
}

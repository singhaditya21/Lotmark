import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api, ApiError,
  type CertificateDetail, type CertificateIssue, type HoldersResponse,
  type ReissueResult, type WithdrawResult, type NotifiedParty,
} from '../lib/api';
import { sig } from '../lib/format';
import { Dialog, Field } from './Dialog';
import { StepUp } from './StepUp';
import { ALL_MEANINGS, type Meaning } from '../lib/meanings';

/**
 * The certificate issue history, and the two acts that change it.
 *
 * Reissue and withdrawal were reachable only through the API. That put the
 * product's most consequential path — the one taken when a certified value
 * turns out to be wrong — behind a curl command, and left the Technical
 * Manager who is authorised to perform it with no way to do so.
 *
 * Three things this screen insists on:
 *
 *  1. The holders are shown BEFORE the act, not after. Nobody should withdraw a
 *     document without seeing which laboratories are relying on it.
 *  2. "You may not see the holders" is never rendered as "there are no
 *     holders". Those are opposite facts and confusing them on this screen
 *     would be the worst possible place to do it.
 *  3. Notified and unreachable are reported as two lists and never summed. A
 *     notice that reached nobody, presented as delivered, is exactly the
 *     failure a withdrawal exists to prevent.
 */

type Mode = { kind: 'view' } | { kind: 'reissue' } | { kind: 'withdraw'; issue: number };

export function CertificatePanel({
  certificateId, canReissue, onClose,
}: {
  certificateId: string;
  canReissue: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [reason, setReason] = useState('');
  const [meaning, setMeaning] = useState<Meaning>('approval');
  const [error, setError] = useState<string | null>(null);
  const [stepUpFor, setStepUpFor] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<
    | { kind: 'reissued'; result: ReissueResult }
    | { kind: 'withdrawn'; result: WithdrawResult }
    | null
  >(null);

  const detail = useQuery({
    queryKey: ['certificate', certificateId],
    queryFn: () => api.get<CertificateDetail>(`/certificates/${certificateId}`),
  });

  const cert = detail.data;
  // Holders are previewed for the issue the act concerns: the one being
  // withdrawn, or — for a reissue — the current issue whose holders are the
  // people who must be told to replace it.
  const previewIssue = mode.kind === 'withdraw' ? mode.issue : cert?.currentIssue ?? null;

  const holders = useQuery({
    queryKey: ['holders', certificateId, previewIssue],
    enabled: previewIssue !== null && mode.kind !== 'view',
    retry: false,
    queryFn: () =>
      api.get<HoldersResponse>(`/certificates/${certificateId}/issues/${previewIssue}/holders`),
  });

  const done = () => {
    void qc.invalidateQueries({ queryKey: ['certificate', certificateId] });
    void qc.invalidateQueries({ queryKey: ['lots'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
    setMode({ kind: 'view' });
    setReason('');
    setError(null);
  };

  const onFailure = (e: unknown, purpose: string) => {
    if (e instanceof ApiError && e.needsStepUp) {
      // Not a failure: the act is legitimate and the session simply has not
      // been stepped up. Ask for the components and let them retry.
      setStepUpFor(purpose);
      return;
    }
    setError(e instanceof ApiError ? e.problem.detail : 'The action could not be completed.');
  };

  const reissue = useMutation({
    mutationFn: () =>
      api.post<ReissueResult>(`/certificates/${certificateId}/reissue`, { meaning, reason }),
    onSuccess: (result) => { setOutcome({ kind: 'reissued', result }); done(); },
    onError: (e) => onFailure(e, `Reissue ${cert?.certificate.code ?? 'certificate'}`),
  });

  const withdraw = useMutation({
    mutationFn: (issue: number) =>
      api.post<WithdrawResult>(`/certificates/${certificateId}/issues/${issue}/withdraw`, { reason }),
    onSuccess: (result) => { setOutcome({ kind: 'withdrawn', result }); done(); },
    onError: (e) => onFailure(e, `Withdraw ${cert?.certificate.code ?? 'certificate'}`),
  });

  const busy = reissue.isPending || withdraw.isPending;

  return (
    <>
      <Dialog
        open
        title={cert ? `${cert.certificate.code} · lot ${cert.certificate.lotCode}` : 'Certificate'}
        lede={
          cert
            ? cert.currentIssue === null
              ? 'This certificate has no current issue — its latest issue has been withdrawn.'
              : `Issue #${cert.currentIssue} is current. Earlier issues remain verifiable forever; a reissue never overwrites one.`
            : undefined
        }
        onClose={onClose}
        footer={
          mode.kind === 'view' ? (
            <>
              {canReissue && cert && cert.currentIssue !== null && (
                <>
                  <button className="btn" onClick={() => { setMode({ kind: 'reissue' }); setError(null); }}>
                    Reissue…
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => { setMode({ kind: 'withdraw', issue: cert.currentIssue! }); setError(null); }}
                  >
                    Withdraw issue #{cert.currentIssue}…
                  </button>
                </>
              )}
              <button className="btn ghost" onClick={onClose}>Close</button>
            </>
          ) : (
            <>
              <button
                className={mode.kind === 'withdraw' ? 'btn danger' : 'btn'}
                disabled={busy || reason.trim().length === 0}
                title={reason.trim().length === 0 ? 'A reason is required' : ''}
                onClick={() =>
                  mode.kind === 'withdraw' ? withdraw.mutate(mode.issue) : reissue.mutate()
                }
              >
                {busy
                  ? 'Working…'
                  : mode.kind === 'withdraw'
                    ? `Withdraw issue #${mode.issue}`
                    : 'Sign and reissue'}
              </button>
              <button className="btn ghost" disabled={busy}
                      onClick={() => { setMode({ kind: 'view' }); setReason(''); setError(null); }}>
                Back
              </button>
            </>
          )
        }
      >
        {error && <div className="note deny">{error}</div>}

        {detail.isLoading && <p className="muted">Loading…</p>}
        {detail.error && <div className="note deny">This certificate could not be loaded.</div>}

        {mode.kind === 'view' && cert && <IssueHistory cert={cert} />}

        {mode.kind !== 'view' && cert && (
          <>
            {mode.kind === 'withdraw' ? (
              <div className="note deny">
                <b>Withdrawal tells every holder not to rely on this certificate.</b> The lot
                is removed from the catalogue at the same time. Issue #{mode.issue} stays
                verifiable, and the verification page will report it as withdrawn.
              </div>
            ) : (
              <div className="note info">
                A reissue creates issue #{(cert.currentIssue ?? 0) + 1} from the currently
                authorised value. Issue #{cert.currentIssue} is not altered — holders are told
                to replace it.
              </div>
            )}

            <HolderPreview
              query={holders}
              verb={mode.kind === 'withdraw' ? 'be told not to rely on it' : 'be told to replace it'}
            />

            <Field
              label={mode.kind === 'withdraw' ? 'Why is this being withdrawn?' : 'Why is this being reissued?'}
              hint="required; printed on the notice holders receive"
            >
              <textarea
                className="t" rows={3} value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  mode.kind === 'withdraw'
                    ? 'Homogeneity re-assessment invalidated the assigned value'
                    : 'Characterisation re-run after an interlaboratory outlier was withdrawn'
                }
              />
            </Field>

            {mode.kind === 'reissue' && (
              <>
                <Field label="Meaning of this signature">
                  <select className="t" value={meaning}
                          onChange={(e) => setMeaning(e.target.value as Meaning)}>
                    {ALL_MEANINGS.map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </Field>
                <div className="note info">
                  This signature will be bound to the new issue's content, and your competence
                  to issue certificates is frozen onto it as it stands today.
                </div>
              </>
            )}
          </>
        )}
      </Dialog>

      {outcome && (
        <NotificationOutcome outcome={outcome} onClose={() => setOutcome(null)} />
      )}

      <StepUp
        open={stepUpFor !== null}
        purpose={stepUpFor ?? ''}
        onClose={() => setStepUpFor(null)}
        onUnlocked={() => setStepUpFor(null)}
      />
    </>
  );
}

function IssueHistory({ cert }: { cert: CertificateDetail }) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Issue</th><th>Issued</th><th>By</th><th>Value</th><th>State</th><th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {cert.issues.map((i) => (
            <tr key={i.number}>
              <td className="mono"><b>#{i.number}</b></td>
              <td className="mono muted">{String(i.issuedAt).slice(0, 10)}</td>
              <td>{i.issuedBy ?? '—'}</td>
              <td className="mono">
                {sig(i.assignedValue, 7)} ± {sig(i.expandedUncertainty, 4)} {i.unit}
              </td>
              <td><IssueState issue={i} current={cert.currentIssue} /></td>
              <td className="muted">{i.withdrawnReason ?? i.reissueReason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IssueState({ issue, current }: { issue: CertificateIssue; current: number | null }) {
  if (issue.withdrawn) return <span className="chip bad">withdrawn</span>;
  if (issue.number === current) return <span className="chip ok">current</span>;
  return <span className="chip grey">superseded</span>;
}

/**
 * Who is relying on this, shown before the act rather than after it.
 *
 * The 403 branch matters more than the happy path. A caller who may not read
 * the holder list must be told that, not shown an empty table — "nobody holds
 * this" and "you cannot see who holds this" would look identical, and on this
 * screen that mistake ends with somebody withdrawing a certificate believing it
 * affects no one.
 */
function HolderPreview({
  query, verb,
}: {
  query: { isLoading: boolean; data?: HoldersResponse | undefined; error: unknown };
  verb: string;
}) {
  if (query.isLoading) return <p className="muted">Checking who holds this…</p>;

  if (query.error) {
    const forbidden = query.error instanceof ApiError && query.error.isForbidden;
    return (
      <div className="note warn">
        {forbidden
          ? 'You are not permitted to see the holder list, so it is not shown. ' +
            'This does NOT mean there are no holders — everyone holding this issue will ' +
            'still be notified.'
          : 'The holder list could not be loaded. Holders will still be notified.'}
      </div>
    );
  }

  const holders = query.data?.holders ?? [];
  if (holders.length === 0) {
    return (
      <div className="note">
        No holder of this issue is on record — no order line and no self-declared vault
        holding. Nobody will be notified.
      </div>
    );
  }

  const unreachable = query.data?.unreachableCount ?? 0;

  return (
    <>
      <div className="note info">
        <b>{holders.length} organisation{holders.length === 1 ? '' : 's'}</b> will {verb}.
      </div>
      {unreachable > 0 && (
        /* Said BEFORE the act, while it is still something the operator can do
           something about, rather than only in the report afterwards. */
        <div className="note warn">
          <b>{unreachable} of them {unreachable === 1 ? 'has' : 'have'} nobody to address a
          notice to.</b> A record will be written, but they will not be told. Plan to reach
          them another way.
        </div>
      )}
      <div className="scroll">
        <table>
          <thead><tr><th>Organisation</th><th>Units</th><th>Known through</th><th>Notice</th></tr></thead>
          <tbody>
            {holders.map((h) => (
              <tr key={h.organisationId}>
                <td>{h.organisation}</td>
                <td className="mono">{h.quantity}</td>
                <td className="muted">{h.basis}</td>
                <td>
                  {h.reachable
                    ? <span className="chip ok">will be notified</span>
                    : <span className="chip bad">nobody to notify</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {query.data?.contactsVisible === false && (
        <p className="muted" style={{ fontSize: 12 }}>
          Who exactly will be written to is withheld — that needs the customer-contact
          permission, which this act does not require. Whether they will be reached is shown
          above regardless, because that is what changes the decision.
        </p>
      )}
    </>
  );
}

/**
 * What actually happened, with the two outcomes kept apart.
 *
 * `notified` and `unreachable` are never added together and the unreachable
 * list is never collapsed into a count alone: an organisation with nobody to
 * address the notice to has to be chased by other means, and the operator is
 * the only one who can do that.
 */
function NotificationOutcome({
  outcome, onClose,
}: {
  outcome:
    | { kind: 'reissued'; result: ReissueResult }
    | { kind: 'withdrawn'; result: WithdrawResult };
  onClose: () => void;
}) {
  const r = outcome.result;
  const unreachable: NotifiedParty[] = r.unreachable;

  return (
    <Dialog
      open
      title={
        outcome.kind === 'reissued'
          ? `${r.certificate} reissued as #${(r as ReissueResult).issue.number}`
          : `${r.certificate} issue #${(r as WithdrawResult).issue} withdrawn`
      }
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      {outcome.kind === 'reissued' && (
        <>
          <div className="note okbox">
            {(outcome.result).changed.length > 0
              ? `Changed: ${outcome.result.changeSummary}`
              : 'The certified figures did not change.'}
          </div>
          <Field label="Verification address">
            <input className="t mono" readOnly value={outcome.result.document.verifyUrl} />
          </Field>
        </>
      )}

      <h2 style={{ fontSize: 15 }}>Notified · {r.notified.length}</h2>
      {r.notified.length === 0 ? (
        <p className="muted">No holder was on record.</p>
      ) : (
        <ul className="plain">
          {r.notified.map((h) => (
            <li key={h.organisation}>{h.organisation} <span className="muted">— {h.basis}</span></li>
          ))}
        </ul>
      )}

      {unreachable.length > 0 && (
        <>
          <h2 style={{ fontSize: 15 }}>Unreachable · {unreachable.length}</h2>
          <div className="note deny">
            <b>These organisations have no active user to address the notice to.</b> A record
            was written for each, but nobody has been told. Reach them another way and note
            how in the CAPA raised for this.
          </div>
          <ul className="plain">
            {unreachable.map((h) => (
              <li key={h.organisation}>{h.organisation} <span className="muted">— {h.basis}</span></li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

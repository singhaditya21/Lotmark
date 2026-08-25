import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Capa, type CapaState } from '../lib/api';
import { CAPA_STATE_LABEL, CAPA_STEP_PROMPT, missingToClose } from '../lib/capa';
import { Dialog, Field } from './Dialog';
import { useToast } from './Toast';

/**
 * Advancing a nonconformity.
 *
 * Deliberately not a state dropdown and not a comment box. ISO 17034 7.11 wants
 * the reasoning recorded, so each move asks for the field that step is actually
 * about — a root cause when determining one, a corrective action when agreeing
 * one. The moves themselves come from the server's declared machine; the
 * console does not decide what may follow what.
 *
 * CLOSING IS DIFFERENT. The server refuses to close without a root cause and a
 * corrective action. An earlier version of this dialog offered only a
 * *preventive* action field, so a user told "you need a corrective action" had
 * nowhere to type one — a dead end where the rule was enforced but unsatisfiable.
 * The close step therefore surfaces both required fields, pre-filled with
 * whatever the CAPA already carries.
 */
export function CapaTransition({
  capa, to, onClose,
}: { capa: Capa | null; to: CapaState | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [corrective, setCorrective] = useState('');
  const [problem, setProblem] = useState<ApiError['problem'] | null>(null);

  const closing = to === 'closed';
  const prompt = to ? CAPA_STEP_PROMPT[to] : undefined;

  useEffect(() => {
    if (!capa || !to) return;
    setReason('');
    setDetail('');
    setProblem(null);
    // Pre-filled, not blank: the point is to let the person complete what is
    // missing, not retype what is already recorded.
    setRootCause(capa.root_cause ?? '');
    setCorrective(capa.corrective_action ?? '');
  }, [capa, to]);

  const move = useMutation({
    mutationFn: () => api.post(`/capa/${capa!.id}/transition`, {
      to,
      reason,
      ...(prompt && detail ? { [prompt.field]: detail } : {}),
      ...(closing && rootCause ? { rootCause } : {}),
      ...(closing && corrective ? { correctiveAction: corrective } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['capa'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
      toast.success(closing
        ? `${capa?.code ?? 'CAPA'} closed — the reasoning is recorded.`
        : `${capa?.code ?? 'CAPA'} moved to ${to ? CAPA_STATE_LABEL[to] : 'the next step'}.`);
      onClose();
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.problem : null),
  });

  if (!capa || !to) return null;

  // Everything the server will require before it accepts a close. Shared with
  // the tests, so the fields this dialog OFFERS cannot drift out of step with
  // the fields it demands — which is precisely how the close path became a
  // dead end.
  const missing = closing
    ? missingToClose({ rootCause, correctiveAction: corrective })
    : [];
  const blocked = reason.trim().length === 0 || missing.length > 0;

  return (
    <Dialog
      open
      title={`${capa.code} → ${CAPA_STATE_LABEL[to]}`}
      lede={
        closing
          ? 'Closing records that this nonconformity is resolved. It is not deleted — a register you can delete from is not a register.'
          : `Moving from ${CAPA_STATE_LABEL[capa.state]}. Every move is recorded with its reason.`
      }
      onClose={onClose}
      footer={<>
        <button className="btn" disabled={move.isPending || blocked}
                onClick={() => { setProblem(null); move.mutate(); }}>
          {move.isPending ? 'Recording…' : closing ? 'Close this CAPA' : `Move to ${CAPA_STATE_LABEL[to]}`}
        </button>
        <button className="btn ghost" onClick={onClose} disabled={move.isPending}>Cancel</button>
      </>}
    >
      {closing ? (
        <>
          <Field label="Root cause" hint="required — what actually caused it">
            <textarea className="t" rows={2} value={rootCause} spellCheck
                      placeholder="If it was raised in error, say so — that is a legitimate root cause"
                      onChange={(e) => setRootCause(e.target.value)} />
          </Field>
          <Field label="Corrective action" hint="required — what was done about this occurrence">
            <textarea className="t" rows={2} value={corrective} spellCheck
                      placeholder="Constraint changed; idempotency verified over three consecutive runs"
                      onChange={(e) => setCorrective(e.target.value)} />
          </Field>
          <Field label="Preventive action" hint="optional — what stops the next one">
            <textarea className="t" rows={2} value={detail} spellCheck
                      placeholder="Every notice-sending job now asserts idempotency in its test"
                      onChange={(e) => setDetail(e.target.value)} />
          </Field>
        </>
      ) : prompt && (
        <Field label={prompt.label} hint={prompt.hint}>
          <textarea className="t" rows={3} value={detail} spellCheck
                    placeholder={prompt.placeholder}
                    onChange={(e) => setDetail(e.target.value)} />
        </Field>
      )}

      <Field label="Reason for this move" hint="recorded in the ledger against your account">
        <input className="t" value={reason} autoFocus
               onChange={(e) => setReason(e.target.value)}
               placeholder={closing ? 'Effectiveness confirmed at the September review' : 'Assigned to the Organics section'} />
      </Field>

      {/* Say what is still needed BEFORE the attempt, not after it is rejected.
          The server enforces the same rule; this exists so nobody has to
          discover it by being refused. */}
      {missing.length > 0 && (
        <div className="note">
          Still needed to close: <b>{missing.join(' and ')}</b>. A CAPA closed
          without them tends to return next quarter with a new number.
        </div>
      )}

      {problem && (
        <div className="note deny" role="alert">
          {problem.detail}
          {problem.auditSeq && (
            <div className="muted" style={{ fontSize: 12, marginTop: 5 }}>
              Recorded in the ledger as entry #{problem.auditSeq}.
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

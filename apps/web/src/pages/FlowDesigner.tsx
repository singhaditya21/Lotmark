import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api, ApiError, type ConfigOverview, type ConfigVersionDetail, type ConfigReview,
} from '../lib/api';
import { Dialog, Field } from '../components/Dialog';
import { ALL_MEANINGS } from '../lib/meanings';
import { GUARD_FACTS } from '../lib/guard-facts';

/**
 * The flow designer.
 *
 * ── What a workflow is here ─────────────────────────────────────────────────
 *
 * A transition table, not a drawing. Every lifecycle in the product is an
 * explicit list of "from this state, to that state, and you must hold this
 * permission" — which is what lets an assessor be shown the permitted moves
 * directly, and what lets the API, the console and the audit ledger agree about
 * what happened.
 *
 * So this screen edits the table and DRAWS the consequence, rather than
 * offering a canvas whose arrows then have to be translated into rules. The
 * drawing is generated from the machine the server resolved, so it cannot show
 * a move the runtime would not make.
 *
 * ── One machine at a time, and what that costs ──────────────────────────────
 *
 * The published version governs every record of an entity. That means removing
 * a state records are sitting in would strand them, so publication refuses it
 * and this screen shows the refusal while the change is being made rather than
 * at the signature.
 */

const ENTITIES = [
  'project', 'study', 'property_value', 'lot', 'order', 'entitlement', 'capa',
] as const;

interface TransitionPayload {
  from: string; to: string; requires: string; action: string;
  requiresSignature: boolean; signatureMeanings: string[];
  requiresCompetence?: string | undefined;
  requiresReason: boolean; guards: string[]; systemInitiated: boolean;
}
interface WorkflowPayload {
  key: string; name: string; entity: string;
  states: Array<{ key: string; name: string; colour?: string | undefined }>;
  initial: string; terminal: string[];
  transitions: TransitionPayload[];
}

interface ResolvedWorkflow {
  entity: string; states: string[]; initial: string; terminal: string[];
  transitions: Array<{
    from: string; to: string; action: string; requires: string; systemInitiated: boolean;
  }>;
}

export function FlowDesigner() {
  const qc = useQueryClient();
  const [entity, setEntity] = useState<string>('capa');
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState<{ index: number; value: TransitionPayload } | null>(null);
  const [addingState, setAddingState] = useState(false);
  const [stateKey, setStateKey] = useState('');
  const [stateName, setStateName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

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
  const resolved = useQuery({
    queryKey: ['draft-workflows', draftId],
    queryFn: () => api.get<{ workflows: ResolvedWorkflow[]; dropped: string[] }>(
      `/admin/config/draft/${draftId}/workflows`),
    enabled: draftId !== null,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['config'] });
    void qc.invalidateQueries({ queryKey: ['config-version', draftId] });
    void qc.invalidateQueries({ queryKey: ['config-review', draftId] });
    void qc.invalidateQueries({ queryKey: ['draft-workflows', draftId] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };

  const openDraft = useMutation({
    mutationFn: () => api.post<{ id: string }>('/admin/config/draft', { changeReason: reason }),
    onSuccess: () => { setReason(''); setFlash('Draft opened. Nothing here is live until it is published.'); refresh(); },
    onError: (e) => setError(e instanceof ApiError ? e.problem.detail : 'Could not open a draft.'),
  });

  const save = useMutation({
    mutationFn: (wf: WorkflowPayload) =>
      api.put(`/admin/config/draft/${draftId}/entry`, { kind: 'workflow', key: wf.key, payload: wf }),
    onSuccess: () => { setEditing(null); setAddingState(false); setError(null); refresh(); },
    onError: (e) => setError(e instanceof ApiError ? e.problem.detail : 'Could not save that.'),
  });

  const workflow = (draft.data?.entries ?? [])
    .filter((e) => e.kind === 'workflow')
    .map((e) => e.payload as WorkflowPayload)
    .find((w) => w.entity === entity) ?? null;

  const machine = resolved.data?.workflows.find((w) => w.entity === entity) ?? null;

  if (overview.isLoading) return <div className="spinner">Loading…</div>;

  if (!draftId) {
    return (
      <>
        <h1>Flow designer</h1>
        <p className="lede">
          A workflow decides what may follow what, and who may make each move. It is
          configuration, so it is designed in a draft and takes effect when that draft is
          published under signature.
        </p>
        <div className="card pad" style={{ maxWidth: 560 }}>
          <h2 style={{ marginTop: 0, fontSize: 15 }}>Open a draft to begin</h2>
          <Field label="Why is this changing?" hint="required; the version’s permanent explanation">
            <input className="t" value={reason} onChange={(e) => setReason(e.target.value)}
                   placeholder="Let a CAPA be closed without a corrective action" />
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

  const problems = review.data?.problems ?? [];
  const dropped = resolved.data?.dropped ?? [];

  const patch = (change: Partial<WorkflowPayload>) => {
    if (!workflow) return;
    save.mutate({ ...workflow, ...change });
  };

  return (
    <>
      <h1>Flow designer</h1>
      <p className="lede">
        Edited in draft {draft.data?.version.number}. Go to <b>Configuration</b> to review and
        sign it — a workflow decides what the system does, so publishing one needs a signature.
      </p>

      {flash && <div className="note okbox">{flash}</div>}
      {error && <div className="note deny">{error}</div>}

      {problems.length > 0 && (
        <div className="note deny">
          <b>This draft cannot be published yet.</b>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      {dropped.length > 0 && (
        <div className="note warn">
          <b>Some configuration could not be read, and is not in the diagram.</b>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {dropped.map((d) => <li key={d}>{d}</li>)}
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

      {!workflow ? (
        <div className="card pad">
          <div className="empty">
            <b>No workflow configured for {entity.replace(/_/g, ' ')}</b>
            The built-in machine governs it. Copying that machine into this draft is how you
            start changing it.
          </div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn" disabled={!machine || save.isPending}
                    onClick={() => machine && save.mutate({
                      key: entity, name: entity.replace(/_/g, ' '), entity,
                      states: machine.states.map((k) => ({ key: k, name: titleise(k) })),
                      initial: machine.initial, terminal: [...machine.terminal],
                      transitions: machine.transitions.map((t) => ({
                        from: t.from, to: t.to, requires: t.requires, action: t.action,
                        requiresSignature: false, signatureMeanings: [],
                        requiresReason: false, guards: [],
                        systemInitiated: t.systemInitiated,
                      })),
                    })}>
              Start from the built-in machine
            </button>
          </div>
        </div>
      ) : (
        <div className="grid2" style={{ alignItems: 'start', gap: 14 }}>
          <div>
            {/* ── States ──────────────────────────────────────────────────── */}
            <div className="card">
              <div className="pad" style={{ paddingBottom: 8 }}>
                <div className="row">
                  <h2 style={{ margin: 0, fontSize: 15 }}>States</h2>
                  <button className="btn sm" style={{ marginLeft: 'auto' }}
                          onClick={() => { setAddingState(true); setStateKey(''); setStateName(''); }}>
                    Add a state
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
                  One is where records start; any number are ends, from which nothing follows.
                </p>
              </div>
              <div className="scroll">
                <table>
                  <thead><tr><th>Key</th><th>Name</th><th>Role</th><th /></tr></thead>
                  <tbody>
                    {workflow.states.map((st) => (
                      <tr key={st.key}>
                        <td className="mono">{st.key}</td>
                        <td>{st.name}</td>
                        <td>
                          {workflow.initial === st.key && <span className="chip ok">start</span>}
                          {workflow.terminal.includes(st.key) && (
                            <span className="chip grey" style={{ marginLeft: 4 }}>end</span>
                          )}
                        </td>
                        <td>
                          {workflow.initial !== st.key && (
                            <button className="btn ghost sm"
                                    onClick={() => patch({ initial: st.key })}>
                              Make the start
                            </button>
                          )}
                          <button className="btn ghost sm" style={{ marginLeft: 6 }}
                                  onClick={() => patch({
                                    terminal: workflow.terminal.includes(st.key)
                                      ? workflow.terminal.filter((t) => t !== st.key)
                                      : [...workflow.terminal, st.key],
                                  })}>
                            {workflow.terminal.includes(st.key) ? 'Not an end' : 'Make an end'}
                          </button>
                          <button className="btn ghost sm" style={{ marginLeft: 6 }}
                                  title="Every move into or out of it goes too"
                                  onClick={() => patch({
                                    states: workflow.states.filter((s) => s.key !== st.key),
                                    terminal: workflow.terminal.filter((t) => t !== st.key),
                                    transitions: workflow.transitions.filter(
                                      (t) => t.from !== st.key && t.to !== st.key),
                                  })}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Moves ───────────────────────────────────────────────────── */}
            <div className="card">
              <div className="pad" style={{ paddingBottom: 8 }}>
                <div className="row">
                  <h2 style={{ margin: 0, fontSize: 15 }}>Moves</h2>
                  <button className="btn sm" style={{ marginLeft: 'auto' }}
                          disabled={workflow.states.length < 2}
                          onClick={() => setEditing({
                            index: -1,
                            value: {
                              from: workflow.states[0]!.key, to: workflow.states[1]!.key,
                              requires: 'capa:manage', action: '',
                              requiresSignature: false, signatureMeanings: [],
                              requiresReason: false, guards: [], systemInitiated: false,
                            },
                          })}>
                    Add a move
                  </button>
                </div>
              </div>
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>From</th><th>To</th><th>Wording</th><th>Needs</th><th /></tr>
                  </thead>
                  <tbody>
                    {workflow.transitions.length === 0 ? (
                      <tr><td colSpan={5} className="muted">No moves. Records could never leave the start.</td></tr>
                    ) : workflow.transitions.map((t, i) => (
                      <tr key={`${t.from}->${t.to}-${i}`}>
                        <td className="mono">{t.from}</td>
                        <td className="mono">{t.to}</td>
                        <td>{t.action}</td>
                        <td style={{ fontSize: 12 }}>
                          <span className="mono">{t.requires}</span>
                          {t.requiresSignature && <span className="chip warn" style={{ marginLeft: 4 }}>signature</span>}
                          {t.requiresReason && <span className="chip grey" style={{ marginLeft: 4 }}>reason</span>}
                          {t.systemInitiated && <span className="chip ok" style={{ marginLeft: 4 }}>system may</span>}
                        </td>
                        <td>
                          <button className="btn ghost sm"
                                  onClick={() => setEditing({ index: i, value: t })}>Edit</button>
                          <button className="btn ghost sm" style={{ marginLeft: 6 }}
                                  onClick={() => patch({
                                    transitions: workflow.transitions.filter((_, n) => n !== i),
                                  })}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── The diagram ───────────────────────────────────────────────── */}
          <div className="card pad" style={{ position: 'sticky', top: 12 }}>
            <h2 style={{ marginTop: 0, fontSize: 15 }}>The machine</h2>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
              Drawn from what the server resolved out of this draft, so it cannot show a move
              the runtime would not make.
            </p>
            {machine ? <Diagram machine={machine} /> : <div className="muted">Nothing resolved yet.</div>}
          </div>
        </div>
      )}

      {addingState && workflow && (
        <Dialog
          open
          title="A new state"
          lede="A state nothing can reach is refused: it would be a place records could never arrive at."
          onClose={() => setAddingState(false)}
          footer={<>
            <button className="btn" disabled={save.isPending || !stateKey.trim() || !stateName.trim()}
                    onClick={() => patch({
                      states: [...workflow.states, { key: stateKey.trim(), name: stateName.trim() }],
                    })}>
              {save.isPending ? 'Saving…' : 'Add it'}
            </button>
            <button className="btn ghost" onClick={() => setAddingState(false)}>Cancel</button>
          </>}
        >
          <div className="grid2">
            <Field label="Key" hint="lower-case slug; stored on every record">
              <input className="t mono" value={stateKey}
                     onChange={(e) => setStateKey(e.target.value)} placeholder="peer_review" />
            </Field>
            <Field label="Name" hint="what a person reads">
              <input className="t" value={stateName}
                     onChange={(e) => setStateName(e.target.value)} placeholder="Peer review" />
            </Field>
          </div>
          <div className="note">
            Add a move into it in the same draft. Until something reaches it, the draft cannot
            be published.
          </div>
        </Dialog>
      )}

      {editing && workflow && (
        <MoveDialog
          value={editing.value}
          states={workflow.states}
          entity={entity}
          busy={save.isPending}
          onCancel={() => setEditing(null)}
          onSave={(t) => patch({
            transitions: editing.index === -1
              ? [...workflow.transitions, t]
              : workflow.transitions.map((old, n) => (n === editing.index ? t : old)),
          })}
        />
      )}
    </>
  );
}

function titleise(s: string): string {
  return s.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The machine, drawn as states and what leaves them.
 *
 * Deliberately not a canvas with draggable nodes. A transition table IS the
 * machine — an assessor is shown the permitted moves, not a picture of them —
 * and a layout algorithm would add a second thing that can be wrong. Each state
 * lists what leaves it, which is the question somebody actually has.
 */
function Diagram({ machine }: { machine: ResolvedWorkflow }) {
  const unreachable = new Set(machine.states);
  unreachable.delete(machine.initial);
  for (const t of machine.transitions) unreachable.delete(t.to);

  return (
    <div>
      {machine.states.map((state) => {
        const out = machine.transitions.filter((t) => t.from === state);
        const isEnd = machine.terminal.includes(state);
        return (
          <div key={state} className="preview" style={{ marginBottom: 8 }}>
            <div className="row" style={{ marginBottom: out.length ? 6 : 0 }}>
              <span className="mono" style={{ fontWeight: 650 }}>{state}</span>
              {machine.initial === state && <span className="chip ok">start</span>}
              {isEnd && <span className="chip grey">end</span>}
              {unreachable.has(state) && <span className="chip bad">nothing reaches this</span>}
            </div>
            {out.length === 0 ? (
              !isEnd && (
                <div className="muted" style={{ fontSize: 12 }}>
                  Nothing leaves this, and it is not marked as an end — records would stop here.
                </div>
              )
            ) : out.map((t) => (
              <div key={`${t.to}-${t.action}`} style={{ fontSize: 12.5, padding: '2px 0' }}>
                <span className="muted">→</span> <span className="mono">{t.to}</span>
                <span className="muted"> · {t.action} · </span>
                <span className="mono" style={{ fontSize: 11.5 }}>{t.requires}</span>
                {t.systemInitiated && (
                  <span className="chip ok" style={{ marginLeft: 6 }}>system may</span>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/* ── One move ─────────────────────────────────────────────────────────────── */

const PERMISSIONS = [
  'project:read', 'project:manage', 'study:run', 'study:sign', 'value:assign',
  'value:authorise', 'lot:create', 'lot:release', 'cert:issue', 'cert:reissue',
  'catalogue:manage', 'order:create', 'order:advance', 'order:refund',
  'entitlement:claim', 'entitlement:decide', 'capa:manage', 'user:manage',
] as const;

function MoveDialog({
  value, states, entity, busy, onSave, onCancel,
}: {
  value: TransitionPayload;
  states: Array<{ key: string; name: string }>;
  entity: string;
  busy: boolean;
  onSave: (t: TransitionPayload) => void;
  onCancel: () => void;
}) {
  const [t, setT] = useState<TransitionPayload>(value);
  const set = (patch: Partial<TransitionPayload>) => setT((prev) => ({ ...prev, ...patch }));
  const ready = t.from !== t.to && t.action.trim() !== '';

  return (
    <Dialog
      open
      title="A move"
      lede="What may follow what, who may do it, and what the ledger will call it."
      onClose={onCancel}
      footer={<>
        <button className="btn" disabled={busy || !ready}
                onClick={() => onSave({ ...t, action: t.action.trim() })}>
          {busy ? 'Saving…' : 'Save to the draft'}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </>}
    >
      <div className="grid2">
        <Field label="From">
          <select className="t" value={t.from} onChange={(e) => set({ from: e.target.value })}>
            {states.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="To" error={t.from === t.to ? 'A move must go somewhere else.' : undefined}>
          <select className="t" value={t.to} onChange={(e) => set({ to: e.target.value })}>
            {states.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Wording in the audit ledger" hint="past tense, what happened">
        <input className="t" value={t.action} onChange={(e) => set({ action: e.target.value })}
               placeholder="Investigation opened" />
      </Field>

      <Field label="Permission required"
             hint="configuration composes capabilities; it cannot invent one">
        <select className="t" value={t.requires} onChange={(e) => set({ requires: e.target.value })}>
          {PERMISSIONS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </Field>

      {/* Enforced — the move is refused without a signature carrying one of the
          meanings chosen below, and a refused signing rolls the move back. */}
      <Field label="Needs an electronic signature">
        <label className="inline">
          <input type="checkbox" checked={t.requiresSignature}
                 onChange={(e) => set({
                   requiresSignature: e.target.checked,
                   signatureMeanings: e.target.checked ? t.signatureMeanings : [],
                 })} />
          <span>The person must re-authenticate and state what their signature means.</span>
        </label>
      </Field>

      {t.requiresSignature && (
        <Field label="Meanings the signer may choose"
               hint="21 CFR 11 §11.50 — the meaning is chosen, never inferred; at least one">
          <div className="picker">
            {ALL_MEANINGS.map(([key, label]) => (
              <label key={key} className={`pick ${t.signatureMeanings.includes(key) ? 'on' : ''}`}>
                <input type="checkbox" checked={t.signatureMeanings.includes(key)}
                       onChange={(e) => set({
                         signatureMeanings: e.target.checked
                           ? [...t.signatureMeanings, key]
                           : t.signatureMeanings.filter((m) => m !== key),
                       })} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </Field>
      )}

      {/* Enforced — the move is refused without one, and it is checked before
          the signature so a missing reason does not cost a step-up. */}
      <Field label="Needs a stated reason">
        <label className="inline">
          <input type="checkbox" checked={t.requiresReason}
                 onChange={(e) => set({ requiresReason: e.target.checked })} />
          <span>Kept on the transition and shown in the ledger.</span>
        </label>
      </Field>

      <Field label="Conditions"
             hint="all must hold, or the move is refused; checked before the reason and the signature">
        <div className="picker" style={{ maxHeight: 150 }}>
          {t.guards.length === 0 ? (
            <span className="muted" style={{ fontSize: 12.5, padding: '4px 8px' }}>
              No conditions. The move is permitted whenever the state allows it.
            </span>
          ) : t.guards.map((g, i) => (
            <div key={i} className="row" style={{ gap: 6, padding: '3px 0' }}>
              <input className="t mono" style={{ flex: 1, fontSize: 12 }} value={g}
                     onChange={(e) => set({
                       guards: t.guards.map((q, n) => (n === i ? e.target.value : q)),
                     })} />
              <button className="btn ghost sm"
                      onClick={() => set({ guards: t.guards.filter((_, n) => n !== i) })}>
                ×
              </button>
            </div>
          ))}
        </div>
      </Field>

      <div className="row">
        <button className="btn ghost sm"
                onClick={() => set({ guards: [...t.guards, ''] })}>
          Add a condition
        </button>
      </div>

      {/*
        The vocabulary, shown rather than documented elsewhere. A condition
        naming something absent is refused at publication, and being told what
        IS available at the moment of writing beats being told afterwards.
      */}
      <div className="note">
        A condition reads facts about the record being moved and nothing else — not the
        database, not other records, not the clock, and not who is acting. Available on{' '}
        <b>{entity.replace(/_/g, ' ')}</b>:{' '}
        {(GUARD_FACTS[entity] ?? []).map((f) => (
          <span key={f} className="mono" style={{ fontSize: 11.5 }}>record.{f} </span>
        ))}
        and <span className="mono" style={{ fontSize: 11.5 }}>custom.&lt;field&gt;</span> for any
        custom field on it.
        <div style={{ marginTop: 6 }}>
          Compare with <span className="mono">== != &lt; &lt;= &gt; &gt;=</span>, combine with{' '}
          <span className="mono">and or not</span> and brackets, and ask whether something was
          filled in with <span className="mono">is empty</span> /{' '}
          <span className="mono">is not empty</span>. For example:{' '}
          <span className="mono" style={{ fontSize: 11.5 }}>
            record.severity != 'Major' or record.preventive_action is not empty
          </span>
        </div>
      </div>

      {/* Enforced — `assertSystemTransition` refuses a job any move without it. */}
      <Field label="Scheduled work may make this move">
        <label className="inline">
          <input type="checkbox" checked={t.systemInitiated}
                 onChange={(e) => set({ systemInitiated: e.target.checked })} />
          <span>
            A job holds no authority and cannot satisfy the permission above, so it may only
            make moves marked here. Leave it off unless a job is meant to.
          </span>
        </label>
      </Field>
    </Dialog>
  );
}

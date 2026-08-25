import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast';
import { api, ApiError, type Directory, type NewUserResult } from '../lib/api';
import { Dialog, Field } from '../components/Dialog';

/**
 * People: who exists, what they may do, where they belong, and what they are
 * competent to perform.
 *
 * ── Three things this screen keeps apart ────────────────────────────────────
 *
 * They are routinely confused, and each confusion is a way somebody ends up
 * able to do something nobody decided they could:
 *
 *   TEAM MEMBERSHIP  belonging. Grants nothing.
 *   ROLE ASSIGNMENT  authority, at a scope, optionally time-boxed.
 *   COMPETENCE       ISO 17034 6.3 — authorisation to PERFORM an activity on a
 *                    given date. Holding the permission is necessary and not
 *                    sufficient.
 *
 * A person can be in a team and hold nothing in it. A person can hold a role
 * across the tenant and be in no team. A person can hold `study:sign` and still
 * be unable to sign a study, because their competence lapsed yesterday.
 */
export function People() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [newUser, setNewUser] = useState(false);
  const [created, setCreated] = useState<NewUserResult | null>(null);
  const [grantFor, setGrantFor] = useState<string | null>(null);
  const [competenceFor, setCompetenceFor] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState(false);

  const [form, setForm] = useState({ email: '', displayName: '', code: '', organisationId: '' });
  const [grant, setGrant] = useState({ roleKey: '', teamId: '', validTo: '', reason: '' });
  const [comp, setComp] = useState({ activity: '', validFrom: '', validTo: '', basis: '' });
  const [team, setTeam] = useState({ key: '', name: '', description: '' });

  const dir = useQuery({
    queryKey: ['people'],
    queryFn: () => api.get<Directory>('/admin/people'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['people'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };
  const onError = (e: unknown) =>
    setError(e instanceof ApiError ? e.problem.detail : 'That could not be completed.');

  const createUser = useMutation({
    mutationFn: () => api.post<NewUserResult>('/admin/users', form),
    onSuccess: (r) => {
      setNewUser(false); setError(null); setCreated(r);
      setForm({ email: '', displayName: '', code: '', organisationId: '' });
      refresh();
    },
    onError,
  });

  const grantRole = useMutation({
    mutationFn: () => api.post(`/admin/users/${grantFor}/roles`, {
      roleKey: grant.roleKey,
      teamId: grant.teamId || null,
      validFrom: null,
      validTo: grant.validTo || null,
      reason: grant.reason,
    }),
    onSuccess: () => {
      setGrantFor(null); setError(null);
      setGrant({ roleKey: '', teamId: '', validTo: '', reason: '' });
      toast.success('Role granted. It takes effect on their next request.');
      refresh();
    },
    onError,
  });

  const revoke = useMutation({
    mutationFn: (a: { userId: string; id: string }) =>
      api.del(`/admin/users/${a.userId}/roles/${a.id}`),
    onSuccess: () => { setError(null); toast.success('Role revoked.'); refresh(); },
    onError,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/deactivate`),
    onSuccess: () => {
      setError(null);
      toast.success('Account deactivated: sessions ended and role assignments revoked.');
      refresh();
    },
    onError,
  });

  const addCompetence = useMutation({
    mutationFn: () => api.post('/admin/competence', { userId: competenceFor, ...comp }),
    onSuccess: () => {
      setCompetenceFor(null); setError(null);
      setComp({ activity: '', validFrom: '', validTo: '', basis: '' });
      toast.success('Competence authorisation recorded.');
      refresh();
    },
    onError,
  });

  const createTeam = useMutation({
    mutationFn: () => api.post('/admin/teams', {
      key: team.key, name: team.name, description: team.description || undefined,
    }),
    onSuccess: () => {
      setNewTeam(false); setError(null); setTeam({ key: '', name: '', description: '' });
      toast.success('Team created. Membership grants nothing on its own — assign a role scoped to it.');
      refresh();
    },
    onError,
  });

  const d = dir.data;
  const rolesOf = (userId: string) => (d?.assignments ?? []).filter((a) => a.user_id === userId);
  const competenceOf = (userId: string) => (d?.competence ?? []).filter((c) => c.user_id === userId);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <h1>People</h1>
      <p className="lede">
        Membership is belonging. A role is authority, at a scope. Competence is
        authorisation to perform an activity on a given day. All three are
        needed, and none of them implies another.
      </p>

      {/* A dialog's own failure is shown inside it (below); on the page body it
          would sit behind the backdrop, unseen, while the user re-clicks. */}
      {error && !(newUser || grantFor !== null || competenceFor !== null || newTeam) && (
        <div className="note deny" role="alert">{error}</div>
      )}

      <div className="row" style={{ margin: '12px 0' }}>
        <button className="btn" onClick={() => { setNewUser(true); setError(null); }}>Add a person</button>
        <button className="btn ghost" onClick={() => { setNewTeam(true); setError(null); }}>Create a team</button>
      </div>

      <div className="card">
        <div className="pad" style={{ paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Accounts</h2>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Name</th><th>Organisation</th><th>Roles held</th><th>Competent for</th><th /></tr>
            </thead>
            <tbody>
              {(d?.users ?? []).map((u) => (
                <tr key={u.id} style={u.deactivated_at ? { opacity: 0.5 } : undefined}>
                  <td>
                    <b>{u.display_name}</b>
                    <div className="muted mono" style={{ fontSize: 11.5 }}>{u.email}</div>
                    {u.deactivated_at && <span className="chip bad">deactivated</span>}
                  </td>
                  <td>
                    {u.organisation_name}
                    <span className={`chip ${u.organisation_kind === 'producer' ? 'grey' : 'warn'}`}
                          style={{ marginLeft: 6 }}>
                      {u.organisation_kind}
                    </span>
                  </td>
                  <td>
                    {rolesOf(u.id).length === 0 ? (
                      <span className="muted">none — they can sign in and will see nothing</span>
                    ) : rolesOf(u.id).map((a) => (
                      <div key={a.id} style={{ marginBottom: 3 }}>
                        <span className="chip ok">{a.role_key}</span>{' '}
                        <span className="muted">
                          {a.team_name ? `in ${a.team_name}` : 'tenant-wide'}
                          {a.valid_to ? ` · until ${a.valid_to}` : ''}
                        </span>{' '}
                        {!u.deactivated_at && (
                          <button className="btn ghost sm"
                                  onClick={() => revoke.mutate({ userId: u.id, id: a.id })}>
                            revoke
                          </button>
                        )}
                      </div>
                    ))}
                  </td>
                  <td>
                    {competenceOf(u.id).length === 0
                      ? <span className="muted">—</span>
                      : competenceOf(u.id).map((c) => (
                        <div key={c.id}>
                          <span className={`chip ${c.valid_to >= today && c.valid_from <= today ? 'ok' : 'bad'}`}>
                            {c.activity}
                          </span>{' '}
                          <span className="muted mono" style={{ fontSize: 11 }}>
                            {c.valid_from} → {c.valid_to}
                          </span>
                        </div>
                      ))}
                  </td>
                  <td>
                    {!u.deactivated_at && (
                      <div className="row">
                        <button className="btn sm" onClick={() => { setGrantFor(u.id); setError(null); }}>
                          Grant role
                        </button>
                        <button className="btn ghost sm" onClick={() => { setCompetenceFor(u.id); setError(null); }}>
                          Competence
                        </button>
                        <button className="btn ghost sm" onClick={() => deactivate.mutate(u.id)}>
                          Deactivate
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-gap">
        <div className="pad" style={{ paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Teams</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Teams own records and are the scope a role can be granted in. Being in
            one grants nothing by itself.
          </p>
        </div>
        <div className="scroll">
          <table>
            <thead><tr><th>Team</th><th>Key</th><th>Members</th><th>Description</th></tr></thead>
            <tbody>
              {(d?.teams ?? []).map((t) => (
                <tr key={t.id}>
                  <td><b>{t.name}</b>{t.archived_at && <span className="chip grey" style={{ marginLeft: 6 }}>archived</span>}</td>
                  <td className="mono">{t.key}</td>
                  <td className="mono">{t.members}</td>
                  <td className="muted">{t.description ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add a person ────────────────────────────────────────────────── */}
      <Dialog
        open={newUser}
        title="Add a person"
        lede="They will be able to sign in immediately and will see nothing until a role is granted."
        onClose={() => setNewUser(false)}
        footer={<>
          <button className="btn"
                  disabled={createUser.isPending || !form.email || !form.displayName || !form.code || !form.organisationId}
                  onClick={() => createUser.mutate()}>
            {createUser.isPending ? 'Creating…' : 'Create account'}
          </button>
          <button className="btn ghost" onClick={() => setNewUser(false)}>Cancel</button>
        </>}
      >
        <div className="grid2">
          <Field label="Full name">
            <input className="t" value={form.displayName}
                   onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </Field>
          <Field label="Email address">
            <input className="t" type="email" value={form.email}
                   onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Code" hint="lowercase, for identifiers">
            <input className="t mono" value={form.code}
                   onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="a-nair" />
          </Field>
          <Field label="Organisation">
            <select className="t" value={form.organisationId}
                    onChange={(e) => setForm({ ...form, organisationId: e.target.value })}>
              <option value="">Choose…</option>
              {(d?.organisations ?? []).map((o) => (
                <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>
              ))}
            </select>
          </Field>
        </div>
        {error && <div className="note deny" role="alert">{error}</div>}
      </Dialog>

      {/* ── The credential, shown once ──────────────────────────────────── */}
      {created && (
        <Dialog
          open
          title="Account created"
          lede="These are shown once and cannot be recovered. They are deliberately not written to the audit ledger."
          onClose={() => setCreated(null)}
          footer={<button className="btn" onClick={() => setCreated(null)}>I have copied these</button>}
        >
          <Field label="Initial password">
            <input className="t mono" readOnly value={created.initialPassword} />
          </Field>
          <Field label="Authenticator enrolment">
            <input className="t mono" readOnly value={created.enrolment} />
          </Field>
          <div className="note info">
            This is an <b>enrolment</b> credential, not a standing one. The account
            can sign in and must then set its own password before it can do
            anything else — until it does, every other screen refuses it.
          </div>
        </Dialog>
      )}

      {/* ── Grant a role ────────────────────────────────────────────────── */}
      <Dialog
        open={grantFor !== null}
        title="Grant a role"
        lede="Scope it to a team unless the authority genuinely spans the whole producer."
        onClose={() => setGrantFor(null)}
        footer={<>
          <button className="btn" disabled={grantRole.isPending || !grant.roleKey || !grant.reason}
                  onClick={() => grantRole.mutate()}>
            {grantRole.isPending ? 'Granting…' : 'Grant'}
          </button>
          <button className="btn ghost" onClick={() => setGrantFor(null)}>Cancel</button>
        </>}
      >
        <Field label="Role" hint="from the active configuration, not from code">
          <select className="t" value={grant.roleKey}
                  onChange={(e) => setGrant({ ...grant, roleKey: e.target.value })}>
            <option value="">Choose…</option>
            {(d?.roles ?? []).map((r) => (
              <option key={r.key} value={r.key}>
                {r.name} ({r.kind}) — {r.permissions.length} permission(s)
              </option>
            ))}
          </select>
        </Field>
        <div className="grid2">
          <Field label="Scope">
            <select className="t" value={grant.teamId}
                    onChange={(e) => setGrant({ ...grant, teamId: e.target.value })}>
              <option value="">Tenant-wide</option>
              {(d?.teams ?? []).filter((t) => !t.archived_at).map((t) => (
                <option key={t.id} value={t.id}>Only in {t.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Until" hint="optional; leave empty for open-ended">
            <input className="t mono" type="date" value={grant.validTo}
                   onChange={(e) => setGrant({ ...grant, validTo: e.target.value })} />
          </Field>
        </div>
        <Field label="Why?" hint="required; recorded with the grant">
          <input className="t" value={grant.reason}
                 onChange={(e) => setGrant({ ...grant, reason: e.target.value })}
                 placeholder="Covering the section lead's leave until 30 September" />
        </Field>
        <div className="note info">
          A dated grant expires on its own. That is the point: leave cover that
          depends on somebody remembering to revoke it usually is not revoked.
        </div>
        {error && <div className="note deny" role="alert">{error}</div>}
      </Dialog>

      {/* ── Record competence ───────────────────────────────────────────── */}
      <Dialog
        open={competenceFor !== null}
        title="Record a competence authorisation"
        lede="ISO 17034 6.3. Holding the permission is necessary and not sufficient — the person must be authorised for the activity on the day they perform it."
        onClose={() => setCompetenceFor(null)}
        footer={<>
          <button className="btn"
                  disabled={addCompetence.isPending || !comp.activity || !comp.validFrom || !comp.validTo || !comp.basis}
                  onClick={() => addCompetence.mutate()}>
            {addCompetence.isPending ? 'Recording…' : 'Record'}
          </button>
          <button className="btn ghost" onClick={() => setCompetenceFor(null)}>Cancel</button>
        </>}
      >
        <Field label="Activity">
          <select className="t" value={comp.activity}
                  onChange={(e) => setComp({ ...comp, activity: e.target.value })}>
            <option value="">Choose…</option>
            {(d?.competenceActivities ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <div className="grid2">
          <Field label="Valid from">
            <input className="t mono" type="date" value={comp.validFrom}
                   onChange={(e) => setComp({ ...comp, validFrom: e.target.value })} />
          </Field>
          <Field label="Valid to">
            <input className="t mono" type="date" value={comp.validTo}
                   onChange={(e) => setComp({ ...comp, validTo: e.target.value })} />
          </Field>
        </div>
        <Field label="Evidence" hint="training record, assessment, witnessed demonstration">
          <input className="t" value={comp.basis}
                 onChange={(e) => setComp({ ...comp, basis: e.target.value })}
                 placeholder="Witnessed demonstration, 12 March; assessment record TR-118" />
        </Field>
        {error && <div className="note deny" role="alert">{error}</div>}
      </Dialog>

      {/* ── Create a team ───────────────────────────────────────────────── */}
      <Dialog
        open={newTeam}
        title="Create a team"
        onClose={() => setNewTeam(false)}
        footer={<>
          <button className="btn" disabled={createTeam.isPending || !team.key || !team.name}
                  onClick={() => createTeam.mutate()}>
            {createTeam.isPending ? 'Creating…' : 'Create'}
          </button>
          <button className="btn ghost" onClick={() => setNewTeam(false)}>Cancel</button>
        </>}
      >
        <div className="grid2">
          <Field label="Name">
            <input className="t" value={team.name} onChange={(e) => setTeam({ ...team, name: e.target.value })} />
          </Field>
          <Field label="Key" hint="lowercase, stable">
            <input className="t mono" value={team.key} onChange={(e) => setTeam({ ...team, key: e.target.value })}
                   placeholder="inorganics" />
          </Field>
        </div>
        <Field label="Description" hint="optional">
          <input className="t" value={team.description}
                 onChange={(e) => setTeam({ ...team, description: e.target.value })} />
        </Field>
        {error && <div className="note deny" role="alert">{error}</div>}
      </Dialog>
    </>
  );
}

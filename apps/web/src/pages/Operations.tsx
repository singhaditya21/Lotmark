import { useQuery } from '@tanstack/react-query';
import { api, type OpsReport, type JobStatus } from '../lib/api';
import { when } from '../lib/format';

/**
 * Whether the unattended half of the system is working.
 *
 * Four jobs run overnight. Their runs have always been recorded and their
 * failures always logged, and nothing ever surfaced them — so a job that had
 * failed every night for a week looked exactly like one that had never run,
 * which looked exactly like one with nothing to do. One of them is what tells a
 * laboratory its material is about to expire.
 */

const STATE_TONE: Record<string, string> = {
  healthy: 'ok', running: 'grey', failing: 'bad', stale: 'warn', never_run: 'bad',
};

const STATE_LABEL: Record<string, string> = {
  healthy: 'healthy', running: 'running', failing: 'failing',
  stale: 'overdue', never_run: 'never run',
};

export function Operations() {
  const ops = useQuery({
    queryKey: ['ops'],
    queryFn: () => api.get<OpsReport>('/ops'),
    // Health is only useful if it is current.
    refetchInterval: 30_000,
  });

  const jobs = ops.data?.jobs ?? [];
  const attention = jobs.filter((j) => (ops.data?.attention ?? []).includes(j.name));

  return (
    <>
      <h1>Operations</h1>
      <p className="lede">
        The scheduled work nobody watches, and the rehearsed restores that turn
        "we have backups" into a dated claim with evidence behind it.
      </p>

      {ops.isLoading && <div className="spinner">Checking…</div>}

      {attention.length > 0 ? (
        <div className="note deny">
          <b>{attention.length} job{attention.length === 1 ? '' : 's'} need attention.</b>
          <ul className="plain">
            {attention.map((j) => <li key={j.name}><span className="mono">{j.name}</span> — {j.advice}</li>)}
          </ul>
        </div>
      ) : jobs.length > 0 && (
        <div className="note okbox">Every scheduled job has succeeded within its expected window.</div>
      )}

      <div className="card" style={{ marginTop: 13 }}>
        <div className="pad" style={{ paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Scheduled jobs</h2>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Job</th><th>State</th><th>Last success</th><th>Failures since</th><th>Schedule</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => <JobRow key={j.name} job={j} />)}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 13 }}>
        <div className="pad" style={{ paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Disaster recovery drills</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            A backup that has never been restored is a hypothesis. Each drill
            restores one into a scratch database and checks what it actually
            proved — run <span className="mono">pnpm --filter @lotmark/api dr:drill</span>.
          </p>
        </div>
        {(ops.data?.drills ?? []).length === 0 ? (
          <div className="pad">
            <div className="note warn">
              No drill has ever been run. Whether these backups restore is
              currently unknown.
            </div>
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>When</th><th>Backup set</th><th>Outcome</th><th>Checks</th></tr></thead>
              <tbody>
                {ops.data!.drills.map((d) => (
                  <tr key={d.id}>
                    <td className="mono muted">{when(d.startedAt)}</td>
                    <td className="mono">{d.source}</td>
                    <td>
                      <span className={`chip ${d.outcome === 'passed' ? 'ok' : d.outcome === 'failed' ? 'bad' : 'grey'}`}>
                        {d.outcome ?? 'incomplete'}
                      </span>
                    </td>
                    <td className="muted">
                      {d.checks.filter((c) => c.ok).length}/{d.checks.length} passed
                      {d.checks.some((c) => !c.ok) && (
                        <div className="mono" style={{ fontSize: 11.5 }}>
                          {d.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(ops.data?.limits ?? []).length > 0 && (
        <div className="card pad" style={{ marginTop: 13 }}>
          <h2 style={{ marginTop: 0, fontSize: 15 }}>What this page cannot tell you</h2>
          <ul className="plain">
            {ops.data!.limits.map((l) => <li key={l} className="muted">{l}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

function JobRow({ job }: { job: JobStatus }) {
  return (
    <tr>
      <td>
        <b className="mono">{job.name}</b>
        <div className="muted" style={{ fontSize: 12 }}>{job.description}</div>
        {job.advice && <div className="note warn" style={{ marginTop: 6 }}>{job.advice}</div>}
      </td>
      <td><span className={`chip ${STATE_TONE[job.state] ?? 'grey'}`}>{STATE_LABEL[job.state]}</span></td>
      <td className="mono muted">
        {job.lastSuccessAt ? when(job.lastSuccessAt) : 'never'}
        {job.hoursSinceSuccess !== null && (
          <div style={{ fontSize: 11.5 }}>{job.hoursSinceSuccess} h ago</div>
        )}
      </td>
      <td className="mono">{job.consecutiveFailures || '—'}</td>
      <td className="mono muted">
        {job.cron}
        <div style={{ fontSize: 11.5 }}>expected every {job.expectedEveryHours} h</div>
      </td>
    </tr>
  );
}

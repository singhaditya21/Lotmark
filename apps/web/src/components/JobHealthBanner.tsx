import { useQuery } from '@tanstack/react-query';
import { api, type OpsReport } from '../lib/api';

/**
 * A failing scheduled job, visible from wherever you are.
 *
 * The Operations page is only useful to somebody who opens it, and nobody opens
 * it on a normal day. One of these jobs is what tells a laboratory its material
 * is about to expire; another raises the CAPA for overdue stability monitoring.
 * Neither failing is something to discover a fortnight later.
 *
 * Shows nothing while loading. On error it does NOT stay silent — a silent
 * banner is indistinguishable from a healthy one, and this banner exists
 * precisely so a failure is not mistaken for health; it shows a quiet, distinct
 * "couldn't check" state instead. It still never shouts because one request
 * failed transiently: react-query keeps the last good data, so `isError` here
 * means the check is failing, not flickering.
 */
export function JobHealthBanner({ onOpen }: { onOpen: () => void }) {
  const ops = useQuery({
    queryKey: ['ops'],
    queryFn: () => api.get<OpsReport>('/ops'),
    retry: false,
    refetchInterval: 60_000,
  });

  if (ops.isError && !ops.data) {
    return (
      <div className="note warn" style={{ margin: '0 0 12px' }} role="status">
        Job health could not be checked — treat as unknown, not healthy.{' '}
        <button className="btn ghost sm" onClick={onOpen}>Open Operations</button>
      </div>
    );
  }

  const attention = ops.data?.attention ?? [];
  if (attention.length === 0) return null;

  return (
    <div className="note deny" style={{ margin: '0 0 12px' }} role="alert">
      <b>
        {attention.length} scheduled job{attention.length === 1 ? '' : 's'} need
        attention.
      </b>{' '}
      <span className="mono">{attention.join(', ')}</span>{' '}
      <button className="btn ghost sm" onClick={onOpen}>Open Operations</button>
    </div>
  );
}

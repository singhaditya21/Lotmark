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
 * Deliberately shows nothing while loading and nothing on error. A banner that
 * flickers on every page load, or that shouts because a request failed once, is
 * a banner people learn to ignore — and then it is worse than absent.
 */
export function JobHealthBanner({ onOpen }: { onOpen: () => void }) {
  const ops = useQuery({
    queryKey: ['ops'],
    queryFn: () => api.get<OpsReport>('/ops'),
    retry: false,
    refetchInterval: 60_000,
  });

  const attention = ops.data?.attention ?? [];
  if (attention.length === 0) return null;

  return (
    <div className="note deny" style={{ margin: '0 0 12px' }}>
      <b>
        {attention.length} scheduled job{attention.length === 1 ? '' : 's'} need
        attention.
      </b>{' '}
      <span className="mono">{attention.join(', ')}</span>{' '}
      <button className="btn ghost sm" onClick={onOpen}>Open Operations</button>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { api, type HomeView, type HomeItem } from '../lib/api';

/**
 * The landing surface: what is waiting on this person, and a way straight to it.
 *
 * Producers used to land on a raw project table with no sense of what needed
 * doing. This reads one endpoint — scoped server-side to what the caller can
 * act on — and turns it into counts you can click and a list you can work down.
 */

const KIND_TONE: Record<HomeItem['kind'], string> = {
  study: 'grey', value: 'warn', lot: 'ok', capa: 'warn', order: 'warn',
};

export function Home({ name, onGo }: { name: string; onGo: (surface: string) => void }) {
  const home = useQuery({ queryKey: ['home'], queryFn: () => api.get<HomeView>('/home') });

  if (home.isLoading) return <div className="spinner">Gathering what needs you…</div>;
  if (home.isError || !home.data) {
    return (
      <div className="note deny" role="alert">
        Your home could not be loaded.{' '}
        <button className="btn ghost sm" onClick={() => void home.refetch()}>Retry</button>
      </div>
    );
  }

  const { attention, summary } = home.data;
  const cards = [
    { n: summary.studiesToSign, label: 'Studies to sign', surface: 'projects' },
    { n: summary.valuesToAuthorise, label: 'Values to authorise', surface: 'projects' },
    { n: summary.lotsToCertify, label: 'Lots to certify', surface: 'projects' },
    { n: summary.capaOpen, label: 'Open CAPA', surface: 'capa', overdue: summary.capaOverdue },
    { n: summary.ordersToDispatch, label: 'Orders to dispatch', surface: 'orders' },
  ];

  return (
    <>
      <h1>Home</h1>
      <p className="lede">
        {attention.length > 0
          ? `${name.split(' ')[0]}, ${attention.length} thing${attention.length === 1 ? '' : 's'} `
            + 'need you. Everything here is scoped to what you can act on.'
          : `${name.split(' ')[0]}, nothing needs you right now.`}
      </p>

      <div className="kpis" style={{ marginTop: 4 }}>
        {cards.map((c) => (
          <button key={c.label} className="kpi" disabled={c.n === 0}
                  style={{ font: 'inherit', textAlign: 'left', cursor: c.n > 0 ? 'pointer' : 'default' }}
                  onClick={() => onGo(c.surface)}>
            <div className="k">{c.label}</div>
            <div className="v mono">
              {c.n}
              {'overdue' in c && c.overdue ? (
                <span className="chip bad" style={{ marginLeft: 8, fontSize: 10.5 }}>{c.overdue} overdue</span>
              ) : null}
            </div>
          </button>
        ))}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="pad" style={{ paddingBottom: 8 }}>
          <h2 style={{ marginTop: 0, marginBottom: 0 }}>Waiting on you · {attention.length}</h2>
        </div>
        {attention.length === 0 ? (
          <div className="empty">
            <b>You are all caught up.</b>
            Nothing across the platform is waiting on you right now.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <tbody>
                {attention.map((i, idx) => (
                  <tr key={`${i.kind}:${i.code}:${idx}`} className="click"
                      role="button" tabIndex={0}
                      aria-label={`${i.title} — ${i.code}. Go to ${i.surface}.`}
                      onClick={() => onGo(i.surface)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onGo(i.surface); }
                      }}>
                    <td style={{ width: 72 }}>
                      <span className={`chip ${i.overdue ? 'bad' : KIND_TONE[i.kind]}`}>{i.kind}</span>
                    </td>
                    <td className="mono" style={{ width: 130 }}><b>{i.code}</b></td>
                    <td>
                      {i.title}
                      <div className="muted" style={{ fontSize: 12 }}>{i.detail}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

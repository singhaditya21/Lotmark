/**
 * The API client.
 *
 * Everything goes through the same-origin `/api` proxy, so the session cookie
 * travels without any SameSite relaxation and development behaves the way
 * production will.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  /** The ledger entry that recorded this refusal, where one was written. */
  auditSeq?: string;
  /** Field-level detail, for inline display on a form. */
  errors?: Array<{ field: string; message: string }>;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly problem: Problem) {
    super(problem.detail);
    this.name = 'ApiError';
  }

  /** The server is asking for a step-up before this act may proceed. */
  get needsStepUp(): boolean {
    return this.status === 401 && this.problem.title === 'step_up_required';
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** Field-level errors, for rendering inline on a form. */
  get fieldErrors(): Array<{ field: string; message: string }> {
    return this.problem.errors ?? [];
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init.headers },
  });

  if (!res.ok) {
    let problem: Problem = {
      type: 'about:blank', title: String(res.status), status: res.status,
      detail: res.statusText, code: 'unknown',
    };
    try {
      const body = await res.json();
      if (body && typeof body === 'object' && 'detail' in body) problem = body as Problem;
      else if (body && typeof body === 'object' && 'message' in body) {
        problem = {
          type: 'about:blank', title: String(res.status), status: res.status,
          detail: String(body.message), code: 'unknown',
        };
      }
    } catch { /* the body was not JSON; the status line is all we have */ }
    throw new ApiError(res.status, problem);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
};

/* ── Shapes returned by the API ─────────────────────────────────────────── */

export interface Me {
  user: { id: string; name: string; email: string };
  teams: Array<{ id: string; key: string; name: string }>;
  permissions: string[];
  permissionsByTeam: Record<string, string[]>;
  secondFactorSatisfied: boolean;
}

export interface Project {
  id: string; code: string; material: string;
  cas: string | null; sku: string; stage: string; team: string | null;
}

export interface Study {
  id: string; code: string; type: string; state: string;
  uncertainty: number | null; signedOn: string | null;
}

export interface PropertyValue {
  id: string; code: string; property_name: string; unit: string; state: string;
  assigned_value: number | null; expanded_uncertainty: number | null;
  coverage_factor: number; assigned_by: string | null; authorised_by: string | null;
}

export interface Lot {
  id: string; lot_code: string; state: string; expiry_date: string;
  stock_units: number; storage_condition: string; cold_chain: boolean;
  supersedes: string | null; certificate_code: string | null;
}

export interface BudgetComponent {
  studyId: string; studyType: string; symbol: string; value: number; basis: string;
}

export interface Budget {
  project: { id: string; code: string };
  assignedValue: number | null;
  budget: {
    uBb: number | null; uLts: number | null; uChar: number | null;
    uCombined: number | null; complete: boolean;
    expanded: number | null; coverageFactor: number;
  };
  components: BudgetComponent[];
}

export interface AuditEntry {
  seq: string; occurred_at: string; actor_label: string; actor_role_id: string;
  kind: string; action: string; detail: string; time_source: string; region: string;
}

export interface ChainResult {
  ok: boolean; entries: number; brokenAt: number | null; reason: string | null;
}

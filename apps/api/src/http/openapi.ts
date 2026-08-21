import { OPERATIONS, type Operation } from './operations';
import { PROBLEM_BASE } from './problem';

/**
 * The OpenAPI 3.1 document, built from the operation registry.
 *
 * Generated rather than written, so it cannot disagree with the registry — and
 * the registry cannot disagree with the server, because `openapi.test.ts`
 * compares it against the route table Fastify actually built. The chain is
 * server → registry → document, with a test at the only join that could slip.
 *
 * ── What it deliberately does not contain ───────────────────────────────────
 *
 * Request and response schemas. Those are validated by zod at each route, and
 * a second copy here would be exactly the drift this file exists to prevent —
 * on a scale no test could check. What the document does carry is what an API
 * description is actually read for: what each operation is for, who may call
 * it, and what the errors look like.
 */

export interface OpenApiParameter {
  name: string;
  in: 'path';
  required: true;
  schema: { type: 'string' };
  description: string;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters?: OpenApiParameter[];
  security?: Array<Record<string, string[]>>;
  responses: Record<string, { description: string; content?: unknown }>;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  components: Record<string, unknown>;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const TAG_DESCRIPTIONS: Record<string, string> = {
  Public: 'Reachable without a session, each for a stated reason.',
  Authentication: 'Establishing and elevating a session.',
  Production: 'Projects, studies, property values and lots.',
  Certificates: 'Issuing, reissuing and withdrawing certificates.',
  Quality: 'Complaints, CAPAs and the audit ledger.',
  Commerce: 'Catalogue, orders, dispatch, price tiers and the laboratory vault.',
  Administration: 'Configuration versions, users, roles, teams and competence.',
  Operations: 'Scheduled job health and disaster-recovery drills.',
};

/** Fastify writes `/a/:id`; OpenAPI writes `/a/{id}`. */
function toOpenApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function parametersFor(url: string): OpenApiParameter[] {
  return [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
    name: m[1]!,
    in: 'path' as const,
    required: true as const,
    schema: { type: 'string' as const },
    description: m[1] === 'n' ? 'The issue number.' : `The ${m[1]}.`,
  }));
}

/**
 * A stable operationId.
 *
 * Generated clients name their methods from this, so it has to be derived from
 * something that does not change for cosmetic reasons — the method and path,
 * not the summary.
 */
function operationId(op: Operation): string {
  const parts = op.url
    .replace(/^\/api\/v1\//, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.startsWith(':') ? `By${cap(segment.slice(1))}` : cap(segment));
  return op.method.toLowerCase() + parts.join('');
}

const cap = (s: string) =>
  s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^./, (c) => c.toUpperCase());

export function buildOpenApi(): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  for (const op of OPERATIONS) {
    const path = toOpenApiPath(op.url);
    const parameters = parametersFor(op.url);

    const description = [
      op.note,
      op.permission ? `Requires \`${op.permission}\`.` : null,
    ].filter(Boolean).join(' ');

    const responses: OpenApiOperation['responses'] = {
      '200': { description: 'The request succeeded.' },
      '400': { description: 'The request was malformed. RFC 9457 problem details.' },
    };
    if (op.requiresSession) {
      responses['401'] = {
        description:
          'Not authenticated, the second factor is outstanding, or a signing ' +
          'step-up is required. The `code` distinguishes them.',
      };
    }
    if (op.permission !== null) {
      responses['403'] = {
        description:
          'Refused. `code` names the reason — permission_denied, ' +
          'segregation_of_duties, competence_missing or competence_expired — and ' +
          '`auditSeq` points at the ledger entry that recorded the refusal.',
      };
    }

    paths[path] ??= {};
    paths[path][op.method.toLowerCase()] = {
      operationId: operationId(op),
      summary: op.summary,
      ...(description ? { description } : {}),
      tags: [op.tag],
      ...(parameters.length > 0 ? { parameters } : {}),
      // An empty array means "no authentication required" in OpenAPI. Driven
      // by requiresSession, NOT by whether a permission is named — a route can
      // need a session and no permission.
      security: op.requiresSession ? [{ sessionCookie: [] }] : [],
      responses,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Lotmark',
      version: '1',
      description:
        'ISO 17034 reference material producer platform.\n\n' +
        'Errors are RFC 9457 problem details. The `code` field is the ' +
        'machine-readable one; `title` is that code humanised for display and ' +
        'must not be branched on. Where a refusal was recorded, `auditSeq` ' +
        'points at the ledger entry.\n\n' +
        'This document is generated from a registry that a test compares ' +
        'against the routes the server actually registered, in both ' +
        'directions. It cannot describe an endpoint that does not exist, and ' +
        'an endpoint cannot exist without appearing here.',
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
    tags: Object.entries(TAG_DESCRIPTIONS).map(([name, description]) => ({ name, description })),
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'lotmark_session',
          description:
            'An opaque server-side session. Cookies rather than a bearer token ' +
            'because this domain needs IMMEDIATE revocation — a locked account, ' +
            'an idle timeout, a withdrawn competence — and a stateless token ' +
            'cannot be withdrawn before it expires.',
        },
      },
      schemas: {
        Problem: {
          type: 'object',
          description: `RFC 9457 problem details. \`type\` is \`${PROBLEM_BASE}/{code}\`.`,
          required: ['type', 'title', 'status', 'detail', 'code'],
          properties: {
            type: { type: 'string' },
            title: { type: 'string', description: 'For display. Do not branch on it.' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string', description: 'The machine-readable classification.' },
            auditSeq: { type: 'string', description: 'The ledger entry recording this refusal.' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: { field: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    paths,
  };
}

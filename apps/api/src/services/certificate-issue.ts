import { signPayload } from '@lotmark/security';
import type { Sql } from '../db';
import type { ActiveKey } from './keys';
import { DocumentStore, mintVerificationToken } from './documents';
import {
  renderCertificate, snapshotDigest, RENDERER_VERSION, TEMPLATE_KEY, TEMPLATE_VERSION,
  type CertificateSnapshot,
} from './certificate-pdf';

/**
 * Rendering, signing and storing a certificate issue.
 *
 * Extracted because issuing and REISSUING must produce documents by the same
 * path. Two copies would eventually differ, and a reissue that renders
 * differently from the original it replaces is exactly the discrepancy a
 * customer would notice and nobody could explain.
 */
export interface IssueRenderInput {
  readonly tenantId: string;
  readonly issueId: string;
  readonly certificateCode: string;
  readonly issueNumber: number;
  readonly lotId: string;
  readonly projectId: string;
  readonly value: {
    propertyName: string; assignedValue: number;
    expandedUncertainty: number; coverageFactor: number; unit: string;
    components: ReadonlyArray<{ symbol: string; value: number; basis: string }>;
  };
  readonly issuedByName: string;
  readonly signedAt: string;
  readonly signatureMeaning: string;
  readonly key: ActiveKey;
  readonly reissueReason: string | null;
}

export interface RenderedIssue {
  readonly sha256: string;
  readonly bytes: number;
  readonly verificationToken: string;
  readonly snapshot: CertificateSnapshot;
}

export async function renderAndStoreIssue(
  tx: Sql, documents: DocumentStore, input: IssueRenderInput,
): Promise<RenderedIssue> {
  const [projectRow] = await tx`
    SELECT p.material_name, p.cas_number, t.name AS producer_name,
           t.conformance_frame, o.accreditation
    FROM lotmark.projects p
    JOIN lotmark.tenants t ON t.id = p.tenant_id
    LEFT JOIN lotmark.organisations o ON o.tenant_id = t.id AND o.kind = 'producer'
    WHERE p.id = ${input.projectId} LIMIT 1`;
  const meta = projectRow as {
    material_name: string; cas_number: string | null; producer_name: string;
    conformance_frame: string; accreditation: string | null;
  };

  const [lotRow] = await tx`
    SELECT l.lot_code, l.expiry_date, l.storage_condition, prev.lot_code AS previous_lot_code
    FROM lotmark.lots l
    LEFT JOIN lotmark.lots prev ON prev.id = l.previous_lot_id
    WHERE l.id = ${input.lotId}`;
  const lot = lotRow as {
    lot_code: string; expiry_date: string; storage_condition: string;
    previous_lot_code: string | null;
  };

  const verificationToken = mintVerificationToken();

  const snapshot: CertificateSnapshot = {
    producerName: meta.producer_name,
    producerAccreditation: meta.accreditation,
    certificateCode: input.certificateCode,
    issueNumber: input.issueNumber,
    issuedAt: input.signedAt,
    lotCode: lot.lot_code,
    previousLotCode: lot.previous_lot_code,
    materialName: meta.material_name,
    casNumber: meta.cas_number,
    propertyName: input.value.propertyName,
    assignedValue: input.value.assignedValue,
    expandedUncertainty: input.value.expandedUncertainty,
    coverageFactor: input.value.coverageFactor,
    unit: input.value.unit,
    expiryDate: lot.expiry_date,
    storageCondition: lot.storage_condition,
    transportCondition: null,
    components: input.value.components.map((c) => ({ ...c })),
    issuedByName: input.issuedByName,
    signedAt: input.signedAt,
    signatureMeaning: input.signatureMeaning,
    keyVersion: input.key.keyVersion,
    keyCustody: input.key.custody,
    verificationToken,
    reissueReason: input.reissueReason,
    conformanceFrame: meta.conformance_frame,
  };

  const pdf = await renderCertificate(snapshot);
  const stored = documents.put(pdf);
  const documentSignature = signPayload(Buffer.from(pdf).toString('base64'), input.key.privateKey);

  await tx`
    UPDATE lotmark.certificate_issues
    SET document_sha256 = ${stored.sha256}, document_path = ${stored.relativePath},
        document_bytes = ${stored.bytes},
        data_snapshot = ${tx.json(snapshot as never)},
        data_snapshot_digest = ${snapshotDigest(snapshot)},
        template_key = ${TEMPLATE_KEY}, template_version = ${TEMPLATE_VERSION},
        renderer_version = ${RENDERER_VERSION},
        document_signature = ${documentSignature},
        document_key_version = ${input.key.keyVersion},
        rendered_at = now(), verification_token = ${verificationToken}
    WHERE id = ${input.issueId}`;

  return { sha256: stored.sha256, bytes: stored.bytes, verificationToken, snapshot };
}

export interface Holder {
  organisation_id: string; organisation_name: string;
  quantity: string; basis: string; contact_user_id: string | null;
}

/**
 * Notify every holder of an issue.
 *
 * The holder set is order lines UNION self-declared vault holdings, because not
 * every vial arrives through an order. A notice is keyed per
 * (certificate, issue, organisation) so acknowledging one issue cannot mark
 * another as seen — the prototype keyed on (order, certificate) and did exactly
 * that.
 */
export async function notifyHolders(
  tx: Sql,
  args: {
    tenantId: string; certificateId: string; issueNumber: number;
    subject: string; body: string; kind: 'reissue' | 'withdrawal';
  },
): Promise<Holder[]> {
  const holders = (await tx`
    SELECT * FROM lotmark.certificate_holders(${args.certificateId}, ${args.issueNumber})`
  ) as unknown as Holder[];

  for (const h of holders) {
    // A holder with no named contact still gets a notification row: the
    // organisation must appear in the notification report even when the
    // producer has to reach them another way.
    const [recipient] = await tx`
      SELECT id FROM lotmark.users
      WHERE tenant_id = ${args.tenantId} AND organisation_id = ${h.organisation_id}
        AND deactivated_at IS NULL
      ORDER BY created_at LIMIT 1`;
    const recipientId = h.contact_user_id ?? (recipient as { id: string } | undefined)?.id;
    if (!recipientId) continue;

    await tx`
      INSERT INTO lotmark.notifications
        (tenant_id, recipient_user_id, subject, body, subject_table, subject_id,
         certificate_id, issue_number, organisation_id)
      VALUES (${args.tenantId}, ${recipientId}, ${args.subject}, ${args.body},
              ${args.kind}, ${args.certificateId},
              ${args.certificateId}, ${args.issueNumber}, ${h.organisation_id})
      ON CONFLICT DO NOTHING`;
  }
  return holders;
}

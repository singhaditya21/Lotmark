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

export interface NotificationOutcome {
  /** Holders who now have a notification addressed to a person. */
  readonly notified: readonly Holder[];
  /**
   * Holders recorded but with nobody to address it to.
   *
   * Reported separately and never counted as notified. A withdrawal notice
   * that reached nobody, recorded as delivered, is precisely the failure a
   * withdrawal exists to prevent.
   */
  readonly unreachable: readonly Holder[];
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
/**
 * Who a notice for this holder would actually be addressed to.
 *
 * Extracted so that the screen PREVIEWING a reissue and the code SENDING it
 * cannot disagree. The rule is not simply "does the holder have a named
 * contact": an organisation with no contact on the order is still reachable if
 * anyone there has an active account. A preview that used the narrower rule
 * would tell the operator that laboratories are unreachable when they are
 * about to be told perfectly well — and on this screen a wrong reachability
 * count is the number somebody acts on.
 *
 * Returns null only when there is genuinely nobody to address.
 */
export async function resolveRecipient(
  tx: Sql,
  tenantId: string,
  holder: { organisation_id: string; contact_user_id: string | null },
): Promise<string | null> {
  if (holder.contact_user_id) return holder.contact_user_id;
  const [row] = await tx`
    SELECT id FROM lotmark.users
    WHERE tenant_id = ${tenantId} AND organisation_id = ${holder.organisation_id}
      AND deactivated_at IS NULL
    ORDER BY created_at LIMIT 1`;
  return (row as { id: string } | undefined)?.id ?? null;
}

export async function notifyHolders(
  tx: Sql,
  args: {
    tenantId: string; certificateId: string; issueNumber: number;
    subject: string; body: string; kind: 'reissue' | 'withdrawal';
  },
): Promise<NotificationOutcome> {
  const holders = (await tx`
    SELECT * FROM lotmark.certificate_holders(${args.certificateId}, ${args.issueNumber})`
  ) as unknown as Holder[];

  const notified: Holder[] = [];
  const unreachable: Holder[] = [];

  for (const h of holders) {
    // The SAME resolution the preview screen uses. Two copies of this rule
    // would drift, and the drift would show up as an operator being told a
    // laboratory is unreachable moments before it is successfully notified.
    const recipientId = await resolveRecipient(tx, args.tenantId, h);

    /**
     * A holder with nobody to address still gets a row.
     *
     * The previous version said exactly this in a comment and then `continue`d,
     * so the organisation vanished from the notification report while the
     * caller went on to record "N holder(s) notified" counting it. That is a
     * false statement in the ledger, on the withdrawal path.
     */
    await tx`
      INSERT INTO lotmark.notifications
        (tenant_id, recipient_user_id, subject, body, subject_table, subject_id,
         certificate_id, issue_number, organisation_id, unreachable_reason)
      VALUES (${args.tenantId}, ${recipientId}, ${args.subject}, ${args.body},
              ${args.kind}, ${args.certificateId},
              ${args.certificateId}, ${args.issueNumber}, ${h.organisation_id},
              ${recipientId ? null : 'no active user at this organisation'})
      ON CONFLICT DO NOTHING`;

    (recipientId ? notified : unreachable).push(h);
  }
  return { notified, unreachable };
}

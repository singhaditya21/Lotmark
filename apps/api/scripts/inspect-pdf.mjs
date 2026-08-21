/** Inspect the structural properties of a rendered certificate. */
import { renderCertificate } from '../src/services/certificate-pdf.ts';

const snapshot = {
  producerName: 'IPC', producerAccreditation: null, certificateCode: 'CRT-1', issueNumber: 1,
  issuedAt: '2026-08-21T09:15:00Z', lotCode: 'L1', previousLotCode: null,
  materialName: 'Paracetamol', casNumber: null, propertyName: 'Assay',
  assignedValue: 99.6, expandedUncertainty: 0.5, coverageFactor: 2, unit: '%',
  expiryDate: '2028-03-31', storageCondition: '2-8C', transportCondition: null,
  components: [], issuedByName: 'A', signedAt: '2026-08-21T09:15:00Z',
  signatureMeaning: 'approval', keyVersion: 'v1', keyCustody: 'dev_file',
  verificationToken: 'tok', reissueReason: null, conformanceFrame: 'ISO 17034',
};

const t = Buffer.from(await renderCertificate(snapshot)).toString('latin1');
console.log('BaseFont   :', [...t.matchAll(/\/BaseFont\s*\/([^\s\/\]>]+)/g)].map((m) => m[1]).join(', ') || '(none)');
console.log('FontFile2  :', /\/FontFile2/.test(t));
console.log('Subtypes   :', [...new Set([...t.matchAll(/\/Subtype\s*\/(\w+)/g)].map((m) => m[1]))].join(', '));
console.log('base14 leak:', ['/Helvetica', '/Times-Roman', '/Courier'].filter((f) => t.includes(f)).join(', ') || 'none');
console.log('Metadata   :', /\/Metadata/.test(t), '· XMP:', t.includes('<x:xmpmeta'));

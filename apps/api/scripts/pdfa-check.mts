import { renderCertificate, type CertificateSnapshot } from '../src/services/certificate-pdf';
import { checkPdfA2b, formatReport } from '../src/services/pdfa';

const S: CertificateSnapshot = {
  producerName: 'Indian Pharmacopoeia Commission', producerAccreditation: 'NABL RMP-0042',
  certificateCode: 'CRT-2051', issueNumber: 1, issuedAt: '2026-08-21T09:15:00Z',
  lotCode: 'IPRSPARA0004', previousLotCode: null, materialName: 'Paracetamol', casNumber: '103-90-2',
  propertyName: 'Assay (as is)', assignedValue: 99.6734, expandedUncertainty: 0.5335,
  coverageFactor: 2, unit: '% w/w', expiryDate: '2028-03-31', storageCondition: '2-8 C',
  transportCondition: null,
  components: [{ symbol: 'u(bb)', value: 0.1, basis: 'ANOVA' }],
  issuedByName: 'Dr. Asha Pillai', signedAt: '2026-08-21T09:15:00Z', signatureMeaning: 'approval',
  keyVersion: 'v1', keyCustody: 'dev_file', verificationToken: 'k3nQ8vRtY2wPzL9mA4xB6dF1',
  reissueReason: null, conformanceFrame: 'ISO 17034',
};
console.log(formatReport(await checkPdfA2b(await renderCertificate(S))));

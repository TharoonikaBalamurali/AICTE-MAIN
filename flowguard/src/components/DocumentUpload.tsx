import { useState, type FormEvent } from 'react';
import type { DocMetaKey, DocumentRequirement } from '../../server/catalogue/types';
import { api } from '../lib/api';
import { Alert, Button, inputCls, Label, Modal } from './ui';

const META_LABEL: Record<DocMetaKey, string> = {
  issueDate: 'Issue / execution date',
  expiryDate: 'Expiry date (as printed on the document)',
  issuer: 'Issuing authority',
  signatory: 'Signatory',
  referenceNumber: 'Reference / certificate number',
  financialYear: 'Financial year covered (YYYY-YY)',
  dscDeclared: 'DSC',
};

export function DocumentUploadModal({
  open,
  onClose,
  appId,
  doc,
  deficiencyId,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  appId: string;
  doc: Pick<DocumentRequirement, 'id' | 'name' | 'metadata' | 'validity' | 'aphReference' | 'issuer' | 'format' | 'authentication'> | null;
  deficiencyId?: string;
  onUploaded: (msg: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [dsc, setDsc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!doc) return null;
  const needIssue = doc.validity.kind === 'FIXED_PERIOD_FROM_ISSUE';
  const needFy = doc.validity.kind === 'PERIOD_COVERED';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) return setError('Choose a PDF, JPG or PNG file.');
    if (file.size > 10 * 1024 * 1024) return setError('The file exceeds 10 MB.');
    if (needIssue && !meta.issueDate) return setError('The issue date is needed to check the validity period.');
    if (needFy && !meta.financialYear) return setError('State the financial year covered.');
    if (!dsc) return setError('You must declare the file is digitally signed (DSC) before uploading.');
    const fd = new FormData();
    fd.append('requirementId', doc!.id);
    if (deficiencyId) fd.append('deficiencyId', deficiencyId);
    const m: Record<string, unknown> = { dscDeclared: dsc };
    for (const [k, v] of Object.entries(meta)) if (v.trim()) m[k] = v.trim();
    fd.append('metadata', JSON.stringify(m));
    fd.append('file', file);
    setBusy(true);
    try {
      const r = await api.upload(`/api/applications/${appId}/documents`, fd);
      onUploaded(r.confirmation);
      setFile(null);
      setMeta({});
      setDsc(false);
      onClose();
    } catch (err: any) {
      setError(err.body?.details?.map((d: any) => `${d.path}: ${d.message}`).join('; ') || err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Upload document">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <div className="font-semibold text-slate-900">{doc.name}</div>
          <div className="mt-1 space-y-0.5 text-xs text-slate-500">
            {doc.issuer && <div>Issuer / signatory: {doc.issuer}</div>}
            {doc.format && <div>Format: {doc.format}</div>}
            {doc.authentication && <div>Authentication: {doc.authentication}</div>}
            <div>Validity: {doc.validity.description}</div>
          </div>
        </div>
        <div>
          <Label htmlFor="file" required>
            File
          </Label>
          <input id="file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" className={inputCls} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p className="mt-1 text-xs text-slate-500">PDF, JPG or PNG, max 10 MB. The type is verified from the file content.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {doc.metadata
            .filter((k) => k !== 'dscDeclared')
            .map((k) => (
              <div key={k}>
                <Label htmlFor={`m-${k}`} required={(k === 'issueDate' && needIssue) || (k === 'financialYear' && needFy)}>
                  {META_LABEL[k]}
                </Label>
                <input
                  id={`m-${k}`}
                  type={k.endsWith('Date') ? 'date' : 'text'}
                  className={inputCls}
                  placeholder={k === 'financialYear' ? '2025-26' : undefined}
                  value={meta[k] ?? ''}
                  onChange={(e) => setMeta((m) => ({ ...m, [k]: e.target.value }))}
                />
              </div>
            ))}
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" required className="mt-1" checked={dsc} onChange={(e) => setDsc(e.target.checked)} />
          <span>
            <span className="text-rose-600">*</span> I declare this file is digitally signed with a valid DSC. The portal records this declaration; the signature is verified by an authorised reviewer.
          </span>
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!dsc} loading={busy}>
            Upload
          </Button>
        </div>
      </form>
    </Modal>
  );
}

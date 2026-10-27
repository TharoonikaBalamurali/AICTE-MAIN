import { ExternalLink, FileText } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Button, inputCls, Label, Modal, type Tone } from '../../components/ui';

export const FINDING_TONE: Record<string, Tone> = {
  PASS: 'green',
  DISCREPANCY_DETECTED: 'red',
  UNABLE_TO_VERIFY: 'amber',
  HUMAN_REVIEW_REQUIRED: 'violet',
  NOT_APPLICABLE: 'slate',
};
export const FINDING_LABEL: Record<string, string> = {
  PASS: 'Pass',
  DISCREPANCY_DETECTED: 'Discrepancy detected',
  UNABLE_TO_VERIFY: 'Unable to verify',
  HUMAN_REVIEW_REQUIRED: 'Human review required',
  NOT_APPLICABLE: 'Not applicable',
};
export function FindingPill({ status }: { status: string }) {
  return <Badge t={FINDING_TONE[status] ?? 'slate'}>{FINDING_LABEL[status] ?? status}</Badge>;
}

export const ASSESSMENT_TONE: Record<string, Tone> = { RESOLVED: 'green', UNRESOLVED: 'red', PARTIALLY_RESOLVED: 'amber', HUMAN_REVIEW_REQUIRED: 'violet' };

export const WORKSPACE_TITLE: Record<string, string> = {
  SCRUTINY_OFFICIAL: 'Scrutiny workspace',
  RE_SCRUTINY_OFFICIAL: 'Re-scrutiny workspace',
  REGIONAL_OFFICER: 'EVC coordination',
  EVC_MEMBER: 'Expert Visit Committee',
  SHC_MEMBER: 'Standing Hearing Committee',
  DECISION_AUTHORITY: 'Administrative authority',
  SAC_MEMBER: 'Standing Appellate Committee',
  EC_OFFICIAL: 'Executive Committee',
  COUNCIL_OFFICIAL: 'Council',
  SUPERVISOR: 'Operations oversight',
  REGULATION_BUREAU: 'Regulation Bureau',
  SYSTEM_ADMIN: 'Administration',
};

/** Opens an uploaded document inline (PDF / image) for review. */
export function DocViewer({ doc, label }: { doc: { id: string; file_name?: string; fileName?: string; documentId?: string; version?: number }; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = doc.documentId ?? doc.id;
  const name = doc.file_name ?? doc.fileName ?? 'document';
  const src = `/api/documents/${id}/download?inline=1`;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 text-left text-brand-600 hover:underline">
        <FileText className="h-3.5 w-3.5 shrink-0" /> {label ?? `${name}${doc.version ? ` · v${doc.version}` : ''}`}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={name} wide>
        <div className="mb-2 flex justify-end">
          <a href={src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600">
            Open in new tab <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        {/\.(png|jpe?g)$/i.test(name) ? (
          <img src={src} alt={name} className="max-h-[70vh] w-full object-contain" />
        ) : (
          <iframe title={name} src={src} className="h-[70vh] w-full rounded border border-slate-200" />
        )}
        <p className="mt-2 text-xs text-slate-500">Viewing a file does not establish its authenticity. Verify signatures and issuers against the source.</p>
      </Modal>
    </>
  );
}

/** A reasoned action: material officer actions must carry a note that is stored in the audit trail. */
export function ReasonAction({
  label,
  hint,
  onSubmit,
  busy,
  variant = 'primary',
  disabled,
  disabledReason,
}: {
  label: string;
  hint?: string;
  onSubmit: (reason: string) => void;
  busy?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'dark';
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      {!open ? (
        <>
          <Button variant={variant} className="w-full" disabled={disabled} onClick={() => setOpen(true)}>
            {label}
          </Button>
          {disabled && disabledReason && <p className="mt-1.5 text-xs text-slate-500">{disabledReason}</p>}
        </>
      ) : (
        <div className="space-y-2">
          <Label required>{label} — reason / supporting note</Label>
          {hint && <p className="text-xs text-slate-500">{hint}</p>}
          <textarea rows={3} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant={variant} loading={busy} disabled={reason.trim().length < 5} onClick={() => onSubmit(reason.trim())}>
              Confirm
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

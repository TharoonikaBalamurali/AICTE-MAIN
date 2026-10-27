import { useState } from 'react';
import { Badge, outcomeTone } from './ui';

export interface FindingView {
  ruleId?: string;
  rule_id?: string;
  ruleVersion?: number;
  rule_version?: number;
  outcome: 'PASS' | 'FAIL' | 'WARNING' | 'HUMAN_REVIEW';
  blocking: boolean;
  targetLabel?: string;
  target_label?: string;
  aphReference?: string | null;
  aph_reference?: string | null;
  explanation: string;
  correctiveAction?: string;
  corrective_action?: string;
}

const LABEL = { PASS: 'Pass', FAIL: 'Fail', WARNING: 'Warning', HUMAN_REVIEW: 'Human review' } as const;

export function Findings({ findings, showPassed = false }: { findings: FindingView[]; showPassed?: boolean }) {
  const [all, setAll] = useState(showPassed);
  const order = { FAIL: 0, WARNING: 1, HUMAN_REVIEW: 2, PASS: 3 };
  const sorted = [...findings].sort((a, b) => Number(b.blocking) - Number(a.blocking) || order[a.outcome] - order[b.outcome]);
  const visible = all ? sorted : sorted.filter((f) => f.outcome !== 'PASS');
  const passed = findings.filter((f) => f.outcome === 'PASS').length;
  return (
    <div>
      {visible.length === 0 && <div className="py-4 text-sm text-emerald-700">All evaluated requirements passed.</div>}
      <ul className="divide-y divide-slate-100">
        {visible.map((f, i) => (
          <li key={i} className="flex gap-3 py-3">
            <div className="w-28 shrink-0">
              <Badge t={outcomeTone(f.outcome)}>{f.blocking ? 'Blocking' : LABEL[f.outcome]}</Badge>
            </div>
            <div className="min-w-0 text-sm">
              <div className="font-semibold text-slate-800">{f.targetLabel ?? f.target_label}</div>
              <div className="text-slate-600">{f.explanation}</div>
              {(f.correctiveAction ?? f.corrective_action) && <div className="mt-0.5 text-xs text-slate-500">Action: {f.correctiveAction ?? f.corrective_action}</div>}
              <div className="mt-0.5 font-mono text-[10px] text-slate-400">
                {f.ruleId ?? f.rule_id} v{f.ruleVersion ?? f.rule_version}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {passed > 0 && (
        <button className="mt-2 text-xs font-semibold text-brand-600" onClick={() => setAll((a) => !a)}>
          {all ? 'Hide passed checks' : `Show ${passed} passed check${passed === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}

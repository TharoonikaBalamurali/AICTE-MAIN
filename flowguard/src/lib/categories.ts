import { useEffect, useState } from 'react';
import { api } from './api';

export interface CategorySummary {
  code: string;
  menuNumber: number;
  title: string;
  shortTitle: string;
  keywords: string[];
  aphReferences: string;
  summary: string;
  subtypes: Array<{ value: string; label: string; aphReference?: string }>;
  subtypeLabel: string | null;
  route: { scrutiny: boolean; evc: 'YES' | 'NO'; shc: string; processingPeriod: string; aphReference: string; notes?: string };
  stages: Array<{ key: string; label: string }>;
  fieldCount: number;
  mandatoryFieldCount: number;
  documentCount: number;
  mandatoryDocumentCount: number;
  conditionalDocumentCount: number;
  submissionEnabled: boolean;
  verificationStatus: string;
  verificationNotes: string[];
}

let cache: Promise<CategorySummary[]> | null = null;
export function loadCategories() {
  cache ??= api.get('/api/categories').then((r) => r.categories as CategorySummary[]);
  return cache;
}
export function useCategories() {
  const [cats, setCats] = useState<CategorySummary[] | null>(null);
  useEffect(() => {
    loadCategories().then(setCats).catch(() => setCats([]));
  }, []);
  return cats;
}

export const STAGE_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  SCRUTINY: 'Scrutiny',
  EVC: 'EVC',
  SHC: 'SHC',
  DECISION: 'Decision',
  APPEAL: 'Appeal',
  CLOSED: 'Closed',
};

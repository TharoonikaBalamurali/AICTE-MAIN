import type { Discrepancy } from './types.ts';

/**
 * Differences found between the APH Document Requirements Matrix and the APH text,
 * or inside the APH itself. None is silently resolved — each records how FlowGuard handles it.
 */
export const DISCREPANCIES: Discrepancy[] = [
  {
    id: 'D01',
    categories: ['CLOSURE_OF_INSTITUTION'],
    matrixStatement: 'Matrix row 18 cites "Chapter II §2.7" for Closure of Institution.',
    aphStatement: 'In the APH, §2.7 is "To Start New Programme(s)/Level"; Closure of Institution is §2.21. Annexure 2 §2.7 is the closure checklist.',
    handling: 'The portal cites Ch. II §2.21 and Annexure 2 §2.7.',
  },
  {
    id: 'D02',
    categories: ['NEW_PROGRAMME_LEVEL', 'LEVEL_CONVERSION'],
    matrixStatement: 'Matrix rows 4 and 8 cite "Chapter II §2.3" for conversion and new programme/level.',
    aphStatement: 'Ch. II §2.3 is "Submission of Application for EoA". Conversion is §2.14, new programme/level is §2.7. The document list is Annexure 2 §2.3.',
    handling: 'The portal cites §2.14 / §2.7 for the process and Annexure 2 §2.3 for documents.',
  },
  {
    id: 'D03',
    categories: ['BREAK_RESTORATION_HIBERNATION'],
    matrixStatement: 'Matrix row 10 cites "Chapter II §§2.15–2.16".',
    aphStatement: '§2.15 is Women’s ↔ Co-ed conversion; break/hibernation/restoration is §2.16 only.',
    handling: 'The portal cites §2.16.',
  },
  {
    id: 'D04',
    categories: ['EOA_SELF_DISCLOSURE', 'BREAK_RESTORATION_HIBERNATION'],
    matrixStatement: 'Matrix cites Ch. VI §6.17(g) for Occupancy/Completion certificates.',
    aphStatement: 'Annexure 2 §2.1(iii) says "As per Clause 7.17"; the relevant text is in Ch. VI §6.17(g) (Ch. VII is penal action).',
    handling: 'The portal cites both Annexure 2 §2.1(iii) and Ch. VI §6.17(g); the "7.17" reference is treated as an APH typographical error pending verification.',
  },
  {
    id: 'D05',
    categories: ['MERGER_OF_INSTITUTIONS'],
    matrixStatement: 'Matrix row 9 repeats "except institutions fulfilling Chapter II Clause 2.10.2(b)".',
    aphStatement: 'Annexure 2 §2.4(i) refers to Clause 2.10.2(b), which does not exist in the 2024-27 APH (Merger is §2.13; §2.10 is Integrated/Dual Degree).',
    handling: 'The "All Annexure 2 documents" item is optional and NEEDS_VERIFICATION; it is never enforced.',
  },
  {
    id: 'D06',
    categories: ['FN_OCI_GULF_SEATS'],
    matrixStatement: 'Matrix row 11 lists the documents "At EVC".',
    aphStatement: 'Annexure 2 §2.5 lists them "at the time of Expert Visit Committee", but Table 2.3 shows no EVC for this category, and §2.9(a) allows Study-in-India institutions without EVC.',
    handling: 'Documents are collected at submission and the hostel / OIA items are marked NEEDS_VERIFICATION. The workflow follows Table 2.3 (Scrutiny only).',
  },
  {
    id: 'D07',
    categories: ['NEW_TECHNICAL_INSTITUTION', 'CHANGE_OF_SITE'],
    matrixStatement: 'Matrix: "live lease covering at least 5 years of programme duration at application time".',
    aphStatement:
      'Annexure 1 §1.1(xii) states a live lease of 5 years; Ch. VI §6.17(a) states the live lease must be at least equal to the maximum programme duration; Ch. II §2.1(e) withholds EoA when live lease equals the maximum course duration.',
    handling: 'Both checks run (≥ 5 years and ≥ maximum programme duration). They do not conflict; the stricter one governs.',
  },
  {
    id: 'D08',
    categories: ['NEW_TECHNICAL_INSTITUTION', 'CHANGE_OF_SITE'],
    matrixStatement: 'Matrix lists "land-use/conversion certificate" for new institutions generally.',
    aphStatement: 'Annexure 1 lists the Land Conversion Certificate under Private Lease of Land and Land Use Certificate under Private Lease of Building; Ch. VI §6.17(e) states it shall be obtained generally.',
    handling: 'Enforced as conditional for private leases (Annexure 1); for other tenures the reviewer confirms under §6.17(e).',
  },
  {
    id: 'D09',
    categories: ['NEW_TECHNICAL_INSTITUTION', 'CHANGE_OF_SITE'],
    matrixStatement: 'Matrix does not itemise Annexure 1 pp. 78-79 items (vii)-(xiii).',
    aphStatement: 'Items (vii)-(xiii) (floor plans, working capital, 3-year accounts, minority certificate, DPR, HT-line undertaking, Govt building letter) are printed under "Private Lease of Building"; their general applicability is ambiguous in the text.',
    handling: 'Offered as optional uploads marked NEEDS_VERIFICATION.',
  },
  {
    id: 'D10',
    categories: ['*'],
    matrixStatement: 'Matrix "Validity and Deadlines": appeal "Within 7 days from date decision is uploaded" (Ch. II §2.24(a)).',
    aphStatement: 'For existing institutions (Ch. II §2.24(a)) the trigger is the date of uploading of the EC decision. For new institutions (Ch. I §1.11(a)) the trigger is the date of issue of the Letter of Deficiency (LoD).',
    handling: 'The portal uses the chapter-specific trigger. Day-count convention (7 × 24 hours from the recorded timestamp) is a SYSTEM_POLICY interpretation pending verification.',
  },
  {
    id: 'D11',
    categories: ['*'],
    matrixStatement: 'Matrix row 23 and Table 2.3 show "SAC/SHC" as one column.',
    aphStatement: 'SHC verifies compliance before the EC decision (Ch. II §2.23.3); SAC hears appeals after the EC decision (§2.24(b)). For new institutions only SAC is described (Ch. I §1.11).',
    handling: 'SHC and SAC are separate workflow stages; appeals route only to SAC.',
  },
  {
    id: 'D12',
    categories: ['COURSE_CHANGES', 'PROGRAMME_COURSE_CLOSURE'],
    matrixStatement: 'Matrix row 15 groups closure with name change/merger/reduction.',
    aphStatement: 'Table 2.2 lists Closure of Programme(s)/Course(s) as year-round (Category 2) and the other course actions per Public Notice (Category 1).',
    handling: 'Both menu categories exist; the closure subtype in category 12 uses the same checklist as category 17.',
  },
  {
    id: 'D13',
    categories: ['INSTITUTION_NAME_CHANGE'],
    matrixStatement: 'Matrix row 6 (Change in name of affiliating University/Board) exists.',
    aphStatement: 'Annexure 2 §2.11 provides that checklist.',
    handling: 'Not one of the 22 requested menu categories; recorded here for completeness and not exposed in the selector.',
  },
];

/**
 * Deterministic EVC composition checks — APH 2024-27 Annexure 16 §16.5 and the Note under §16.6.
 *
 * §16.5 Expert Visit Committee — composition:
 *  1. An academician not below the level of Professor in a field of Technical Education, selected from the
 *     panel of Experts approved by the Executive Committee, AICTE.                         → seat ACADEMICIAN
 *  2. One Expert member, not below the level of Associate Professor, or an Industry expert (minimum 5 years
 *     of experience), selected from the panel of Experts.                                   → seat EXPERT
 *  3. Architect registered with Council of Architecture or CPWD, NBCC, DRDO, CSIR, or Professor / Associate
 *     Professor of Civil Engineering (Structural) / Assistant Professor of Architecture, or Professor /
 *     Associate Professor of Planning.                                                      → seat ARCHITECT_PLANNING
 * Note: a State Government / UT / affiliating University / Board representative not below Associate Professor
 *  may be co-opted (CO_OPTED); the EVC "may" comprise one academician specialised in the programme offered and
 *  another in Engineering & Technology (advisory); for Institutions Deemed to be Universities, a Vice Chancellor /
 *  Former Vice Chancellor / Director of IIT / NIT nominated by AICTE shall be the Chairman.
 *
 * Nothing here selects members. The checks only explain whether a proposed committee satisfies the stated
 * composition; anything the text does not settle is HUMAN_REVIEW_REQUIRED, and unverified records are never
 * treated as eligible.
 */

export const SEATS = ['ACADEMICIAN', 'EXPERT', 'ARCHITECT_PLANNING', 'CO_OPTED', 'CHAIRMAN_DEEMED_UNIVERSITY'] as const;
export type Seat = (typeof SEATS)[number];
export const REQUIRED_SEATS: Seat[] = ['ACADEMICIAN', 'EXPERT', 'ARCHITECT_PLANNING'];

export const SEAT_LABEL: Record<Seat, string> = {
  ACADEMICIAN: 'Academician (not below Professor, EC-approved panel)',
  EXPERT: 'Expert member (not below Associate Professor, or industry expert with 5+ years; panel)',
  ARCHITECT_PLANNING: 'Architect / Civil (Structural) / Architecture / Planning member',
  CO_OPTED: 'Co-opted member (State / UT / University / Board representative)',
  CHAIRMAN_DEEMED_UNIVERSITY: 'Chairman for an Institution Deemed to be University',
};

export interface Expert {
  id: string;
  member_code: string;
  user_id: string | null;
  full_name: string;
  designation_level: string;
  discipline: string;
  organisation_type: string;
  experience_years: number | string | null;
  coa_registration_no: string | null;
  panel_status: string;
  verification_status: string;
  active: boolean;
}

export type Outcome = 'PASS' | 'FAIL' | 'WARNING' | 'HUMAN_REVIEW_REQUIRED' | 'NOT_APPLICABLE';
export interface Finding {
  id: string;
  outcome: Outcome;
  blocking: boolean;
  message: string;
  reference: string;
  expertId?: string;
  seat?: Seat;
}

const REF = 'APH 2024-27 Annexure 16 §16.5';
const NOTE_REF = 'APH 2024-27 Annexure 16, Note under §16.6';
const AT_LEAST_PROFESSOR = ['VICE_CHANCELLOR', 'DIRECTOR_IIT_NIT', 'PROFESSOR'];
const AT_LEAST_ASSOCIATE = [...AT_LEAST_PROFESSOR, 'ASSOCIATE_PROFESSOR'];
const GOVT_BODIES = ['CPWD', 'NBCC', 'DRDO', 'CSIR'];

/** Whether one expert can occupy one seat. Unverified / inactive records never pass. */
export function seatEligibility(e: Expert, seat: Seat): { outcome: Outcome; reasons: string[] } {
  const reasons: string[] = [];
  if (!e.active) return { outcome: 'FAIL', reasons: ['The registry record is inactive.'] };
  if (e.verification_status === 'REJECTED') return { outcome: 'FAIL', reasons: ['The qualification record was rejected on verification.'] };
  if (e.verification_status !== 'VERIFIED') return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['Qualifications are not yet verified (NEEDS_VERIFICATION).'] };
  const years = e.experience_years === null || e.experience_years === '' ? null : Number(e.experience_years);
  const onPanel = e.panel_status === 'ON_APPROVED_PANEL';
  const panelUnknown = e.panel_status === 'NEEDS_VERIFICATION';
  switch (seat) {
    case 'ACADEMICIAN': {
      if (!AT_LEAST_PROFESSOR.includes(e.designation_level)) return { outcome: 'FAIL', reasons: ['Must be an academician not below the level of Professor.'] };
      if (e.discipline === 'OTHER') return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['Field must be one of Technical Education; the recorded discipline is "other".'] };
      if (panelUnknown) return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['Membership of the EC-approved panel of Experts is not verified.'] };
      if (!onPanel) return { outcome: 'FAIL', reasons: ['Must be selected from the panel of Experts approved by the Executive Committee.'] };
      return { outcome: 'PASS', reasons };
    }
    case 'EXPERT': {
      const academic = AT_LEAST_ASSOCIATE.includes(e.designation_level);
      const industry = e.designation_level === 'INDUSTRY_EXPERT';
      if (!academic && !industry) return { outcome: 'FAIL', reasons: ['Must be not below Associate Professor, or an industry expert.'] };
      if (industry && years === null) return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['Industry experience is not recorded (minimum 5 years).'] };
      if (industry && years !== null && years < 5) return { outcome: 'FAIL', reasons: [`Industry expert has ${years} year(s) of experience; minimum 5 years.`] };
      if (panelUnknown) return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['Membership of the panel of Experts is not verified.'] };
      if (!onPanel) return { outcome: 'FAIL', reasons: ['Must be selected from the panel of Experts.'] };
      return { outcome: 'PASS', reasons };
    }
    case 'ARCHITECT_PLANNING': {
      const lvl = e.designation_level;
      if (lvl === 'ARCHITECT' && e.coa_registration_no) return { outcome: 'PASS', reasons };
      if (['ARCHITECT', 'GOVT_TECHNICAL_OFFICER'].includes(lvl) && GOVT_BODIES.includes(e.organisation_type))
        return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['"Architect registered with Council of Architecture or CPWD, NBCC, DRDO, CSIR" — whether this member qualifies through CPWD/NBCC/DRDO/CSIR needs authorised interpretation.'] };
      if (lvl === 'ARCHITECT') return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['Council of Architecture registration number is not recorded.'] };
      if (['PROFESSOR', 'ASSOCIATE_PROFESSOR'].includes(lvl) && ['CIVIL_STRUCTURAL', 'PLANNING'].includes(e.discipline)) return { outcome: 'PASS', reasons };
      if (lvl === 'ASSISTANT_PROFESSOR' && e.discipline === 'ARCHITECTURE') return { outcome: 'PASS', reasons };
      if (['PROFESSOR', 'ASSOCIATE_PROFESSOR'].includes(lvl) && e.discipline === 'ARCHITECTURE')
        return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['§16.5 names "Assistant Professor of Architecture"; a Professor / Associate Professor of Architecture is not named literally.'] };
      return { outcome: 'FAIL', reasons: ['Does not match any of the qualifications listed for this seat.'] };
    }
    case 'CO_OPTED':
      if (AT_LEAST_ASSOCIATE.includes(e.designation_level)) return { outcome: 'PASS', reasons: ['Co-option is optional; record which State / UT / University / Board the member represents.'] };
      return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['A co-opted State / UT / University / Board representative should be not below Associate Professor; other additional experts (Ch. I §1.9(b)) need authorised confirmation.'] };
    case 'CHAIRMAN_DEEMED_UNIVERSITY':
      if (['VICE_CHANCELLOR', 'DIRECTOR_IIT_NIT'].includes(e.designation_level))
        return { outcome: 'HUMAN_REVIEW_REQUIRED', reasons: ['Designation fits; nomination by AICTE must be confirmed by an authorised official.'] };
      return { outcome: 'FAIL', reasons: ['Must be a Vice Chancellor / Former Vice Chancellor / Director of IIT / NIT nominated by AICTE.'] };
  }
}

export interface Proposed {
  expert: Expert;
  seat: Seat;
}

/**
 * Validates a proposed committee. `deemedUniversity` must come from the application record; when it cannot be
 * determined the Chairman requirement is reported for human review.
 */
export function validateComposition(members: Proposed[], ctx: { deemedUniversity: boolean | null; conflicts?: Array<{ expertId: string; message: string }> }): { valid: boolean; findings: Finding[] } {
  const f: Finding[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.expert.id)) f.push({ id: 'DUPLICATE_MEMBER', outcome: 'FAIL', blocking: true, message: `${m.expert.full_name} is proposed more than once.`, reference: REF, expertId: m.expert.id });
    seen.add(m.expert.id);
    if (!m.expert.user_id)
      f.push({ id: 'NO_ACCOUNT', outcome: 'FAIL', blocking: true, message: `${m.expert.full_name} has no portal account linked, so the assignment cannot be acknowledged or reported.`, reference: 'Portal system policy', expertId: m.expert.id });
    const el = seatEligibility(m.expert, m.seat);
    const optional = m.seat === 'CO_OPTED';
    f.push({
      id: `SEAT_${m.seat}`,
      outcome: el.outcome === 'HUMAN_REVIEW_REQUIRED' && optional ? 'WARNING' : el.outcome,
      blocking: el.outcome === 'FAIL' || (el.outcome === 'HUMAN_REVIEW_REQUIRED' && !optional),
      message: `${m.expert.full_name} → ${SEAT_LABEL[m.seat]}: ${el.outcome === 'PASS' ? 'meets the stated qualification.' : el.reasons.join(' ')}`,
      reference: m.seat === 'CO_OPTED' || m.seat === 'CHAIRMAN_DEEMED_UNIVERSITY' ? NOTE_REF : REF,
      expertId: m.expert.id,
      seat: m.seat,
    });
  }
  for (const seat of REQUIRED_SEATS) {
    const n = members.filter((m) => m.seat === seat).length;
    if (n === 0) f.push({ id: `MISSING_${seat}`, outcome: 'FAIL', blocking: true, message: `No member proposed for: ${SEAT_LABEL[seat]}.`, reference: REF, seat });
    if (n > 1) f.push({ id: `EXTRA_${seat}`, outcome: 'FAIL', blocking: true, message: `§16.5 lists one member for: ${SEAT_LABEL[seat]}. Record additional members as co-opted.`, reference: REF, seat });
  }
  const chair = members.filter((m) => m.seat === 'CHAIRMAN_DEEMED_UNIVERSITY');
  if (ctx.deemedUniversity === true && chair.length === 0)
    f.push({ id: 'DEEMED_CHAIRMAN', outcome: 'FAIL', blocking: true, message: 'For an Institution Deemed to be University, a VC / Former VC / Director of IIT / NIT nominated by AICTE shall be the Chairman.', reference: NOTE_REF });
  if (ctx.deemedUniversity === null)
    f.push({ id: 'DEEMED_STATUS', outcome: 'HUMAN_REVIEW_REQUIRED', blocking: false, message: 'Confirm whether the institution is Deemed to be University; if so, the Chairman requirement of the Note applies.', reference: NOTE_REF });
  if (ctx.deemedUniversity === false && chair.length) f.push({ id: 'CHAIRMAN_NOT_APPLICABLE', outcome: 'WARNING', blocking: false, message: 'A Deemed-University Chairman is proposed for an institution not recorded as Deemed to be University.', reference: NOTE_REF });
  f.push({
    id: 'PROGRAMME_SPECIALISATION',
    outcome: 'HUMAN_REVIEW_REQUIRED',
    blocking: false,
    message: 'Advisory: the EVC may comprise one academician specialised in the programme offered and another in Engineering & Technology. Confirm the specialisations suit the programmes to be visited.',
    reference: NOTE_REF,
  });
  for (const c of ctx.conflicts ?? []) f.push({ id: 'SCHEDULE_CONFLICT', outcome: 'WARNING', blocking: false, message: c.message, reference: 'Portal operational check', expertId: c.expertId });
  return { valid: !f.some((x) => x.blocking), findings: f };
}

import { AlertTriangle, ArrowLeft, ArrowRight, CalendarClock, Check, ChevronRight, Clock, Send, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, cx, Empty, inputCls, KV, Label, Modal, PageHeader, PageNote, Spinner, Table, tdCls, TextLink, Timeline, type Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, useApi } from '../../lib/hooks';
import { addDays, coordination, fromIST, istDay, istHHMM, istLongDate, istRange, modeLabel, responsePill } from './evcCoord';
import { SEAT_SHORT } from './EvcMember';

type Seat = string;
interface PanelEntry {
  expertId: string;
  seat: Seat;
}
interface Official {
  id: string;
  member_code: string;
  full_name: string;
  designation_level: string;
  discipline: string;
  organisation: string | null;
  experience_years: number | null;
  status: 'AVAILABLE' | 'BUSY' | 'UNAVAILABLE' | 'INACTIVE' | 'NOT_VERIFIED' | 'NO_ACCOUNT';
  reason: string | null;
  dayAssignments: Array<{ referenceNo: string | null; start: string; end: string; responseStatus: string | null }>;
  seatEligibility: Record<Seat, { outcome: string; reasons: string[] }>;
}
interface Live {
  officials: Official[];
  capacity: { satisfiable: boolean; bySeat: Record<Seat, number>; message: string | null };
  alternatives: Array<{ start: string; end: string; panelAvailable: boolean; basis: string }>;
  panelStatus: Array<PanelEntry & { status: string; reason: string }>;
  panelConflict: boolean;
  message: string | null;
}

const REQUIRED: Seat[] = ['ACADEMICIAN', 'EXPERT', 'ARCHITECT_PLANNING'];
const OPTIONAL: Seat[] = ['CO_OPTED'];
const human = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');
const AVAIL: Record<string, { label: string; tone: Tone }> = {
  AVAILABLE: { label: 'Available', tone: 'green' },
  BUSY: { label: 'Conflict', tone: 'red' },
  UNAVAILABLE: { label: 'Unavailable', tone: 'red' },
  INACTIVE: { label: 'Inactive', tone: 'slate' },
  NOT_VERIFIED: { label: 'Not verified', tone: 'violet' },
  NO_ACCOUNT: { label: 'No account', tone: 'slate' },
};
const samePanel = (a: PanelEntry[], b: PanelEntry[]) => a.length === b.length && a.every((x) => b.some((y) => y.expertId === x.expertId && y.seat === x.seat));

/** Next weekday at least `n` days ahead (IST) — the default date of a new proposal. */
function defaultDay(n = 3) {
  let d = addDays(istDay(new Date()), n);
  while ([0, 6].includes(new Date(`${d}T12:00:00+05:30`).getUTCDay())) d = addDays(d, 1);
  return d;
}

export function EvcScheduleVisit() {
  const { applicationId = '' } = useParams();
  const nav = useNavigate();
  const ctx = useApi<any>(`/api/evc/scheduler/applications/${applicationId}`);
  const c = ctx.data;
  const v = c?.visit ?? null;
  const sent = !!v?.invitations_sent_at;
  const seatLabel = useCallback((s: Seat) => SEAT_SHORT[s] ?? human(s), []);
  const seatFull = (s: Seat) => c?.seats?.find((x: any) => x.seat === s)?.label ?? seatLabel(s);

  // ------------------------------------------------------------------ form state (initialised from the saved visit)
  const [day, setDay] = useState('');
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('12:00');
  const [mode, setMode] = useState<'ONLINE' | 'PHYSICAL'>('ONLINE');
  const [link, setLink] = useState('');
  const [location, setLocation] = useState('');
  const [offline, setOffline] = useState('');
  const [note, setNote] = useState('');
  const [panel, setPanel] = useState<PanelEntry[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!c) return;
    const key = `${v?.id ?? 'new'}:${v?.updated_at ?? ''}:${v?.invitations_sent_at ?? ''}:${c.members?.length ?? 0}:${c.assignmentStatus}`;
    if (loadedFor === key) return;
    setDay(v ? istDay(v.scheduled_start) : defaultDay());
    setStart(v ? istHHMM(v.scheduled_start) : '10:00');
    setEnd(v?.scheduled_end ? istHHMM(v.scheduled_end) : '12:00');
    setMode(v?.mode ?? 'ONLINE');
    setLink(v?.meeting_link ?? '');
    setLocation(v?.location ?? '');
    setOffline(v?.offline_justification ?? '');
    setNote(v?.instructions ?? '');
    setPanel(c.panel ?? []);
    setLoadedFor(key);
  }, [c, v, loadedFor]);

  const startISO = day && start ? fromIST(day, start) : null;
  const endISO = day && end ? fromIST(day, end) : null;
  const rangeOk = !!startISO && !!endISO && new Date(endISO) > new Date(startISO);
  const timeChanged = !!v && rangeOk && (new Date(v.scheduled_start).getTime() !== new Date(startISO!).getTime() || new Date(v.scheduled_end ?? 0).getTime() !== new Date(endISO!).getTime());
  const panelChanged = !samePanel(panel, c?.panel ?? []);
  const detailsChanged = !!v && (mode !== v.mode || link !== (v.meeting_link ?? '') || location !== (v.location ?? '') || note !== (v.instructions ?? ''));
  const dirty = !v || timeChanged || panelChanged || detailsChanged;

  // ------------------------------------------------------------------ live availability for the slot being edited
  const [live, setLive] = useState<Live | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!rangeOk) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      api
        .post<Live>('/api/evc/scheduler/availability', { start: startISO, end: endISO, visitId: v?.id, panel })
        .then((r) => n === seq.current && (setLive(r), setLiveErr(null)))
        .catch((e) => n === seq.current && setLiveErr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [startISO, endISO, rangeOk, v?.id, panel]);

  const official = (id: string) => live?.officials.find((o) => o.id === id) ?? c?.availability?.officials?.find((o: Official) => o.id === id);
  const memberRow = (expertId: string) => c?.members?.find((m: any) => m.expert_id === expertId && m.active);
  const declined = (c?.members ?? []).filter((m: any) => m.active && ['REJECTED', 'CONFLICT_REPORTED', 'WITHDRAWAL_REQUESTED'].includes(m.response_status));
  const removed = (c?.members ?? []).filter((m: any) => !m.active);
  const panelIssues = (live?.panelStatus ?? []).filter((p) => p.status !== 'AVAILABLE');
  const vacant = REQUIRED.filter((s) => !panel.some((p) => p.seat === s));
  const conflict = panelIssues.length > 0 || declined.length > 0;
  const editable = !!c?.canEdit && ['AWAITING_EVC_SCHEDULING', 'EVC_SCHEDULED'].includes(c?.application?.status) && !['IN_PROGRESS', 'REPORTS_PENDING', 'COMPLETED'].includes(c?.assignmentStatus);

  // ------------------------------------------------------------------ actions (each confirmed by the server before any success message)
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'warn'; text: string; details?: string[] } | null>(null);
  const [editSeat, setEditSeat] = useState<Seat | 'ALL' | null>(null);
  const [fillNote, setFillNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setFillNote(null), [startISO, endISO]);
  const [ask, setAsk] = useState<null | { kind: 'RESCHEDULE' | 'CANCEL' | 'REPLACE'; text: string }>(null);
  const act = (action: string, body: object = {}) => api.post(`/api/official/applications/${applicationId}/actions/${action}`, body);
  const proposal = () => ({
    mode,
    scheduledStart: startISO,
    scheduledEnd: endISO,
    timeZone: 'Asia/Kolkata',
    ...(link.trim() ? { meetingLink: link.trim() } : {}),
    ...(mode === 'PHYSICAL' ? { location: location.trim(), offlineJustification: offline.trim() } : {}),
    ...(note.trim() ? { instructions: note.trim() } : {}),
    panel,
  });
  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setMsg(null);
    try {
      const text = await fn();
      setMsg({ kind: 'success', text });
      await ctx.reload();
    } catch (e: any) {
      const d = e.body?.details;
      const details = Array.isArray(d) ? d.map((x: any) => (typeof x === 'string' ? x : x.message ?? x.reason ?? `${x.name ?? x.id}: ${x.reason ?? ''}`)) : undefined;
      setMsg({ kind: 'error', text: e.message, details });
      await ctx.reload();
    } finally {
      setBusy(null);
    }
  }
  const save = () =>
    run('save', async () => {
      await act('PROPOSE_EVC_DATE', proposal());
      return vacant.length
        ? `Proposal saved as a draft. Members are not notified yet — assign ${vacant.map(seatLabel).join(', ')} and send invitations.`
        : 'Proposal saved as a draft. Members are notified only when you send invitations.';
    });
  /** Proposes, for each vacant required seat, the first verified official who is free and eligible. Nothing is sent. */
  const declinedIds: string[] = timeChanged ? [] : (c?.members ?? []).filter((m: any) => m.response_status === 'REJECTED').map((m: any) => m.expert_id);
  const fillVacant = () => {
    const next = [...panel];
    for (const seat of vacant) {
      const o = live?.officials.find((x) => x.status === 'AVAILABLE' && x.seatEligibility?.[seat]?.outcome === 'PASS' && !next.some((p) => p.expertId === x.id) && !declinedIds.includes(x.id));
      if (o) next.push({ expertId: o.id, seat });
    }
    const filled = next.length - panel.length;
    setPanel(next);
    setFillNote(
      filled === vacant.length
        ? { ok: true, text: `${filled} seat(s) filled with available, eligible officials. Review the panel, then send invitations.` }
        : { ok: false, text: `${filled ? `${filled} seat(s) filled; ` : ''}no free, eligible official for ${vacant.length - filled} seat(s) at this time. Use an alternative slot.` },
    );
  };
  const send = (reason?: string) =>
    run('send', async () => {
      if (!sent || detailsChanged || (!timeChanged && dirty)) await act('PROPOSE_EVC_DATE', proposal());
      const r = await act('ASSIGN_EVC_MEMBERS', { members: panel, ...(reason ? { reason } : {}) });
      return sent
        ? `Committee updated: ${r.invited} invitation(s) sent${r.removed ? `, ${r.removed} member(s) released` : ''}. The visit is confirmed only after every member accepts.`
        : `Invitations sent to ${r.invited} member(s). Their time is now held; the visit is confirmed after everyone accepts.`;
    });
  const confirmVisit = () =>
    run('confirm', async () => {
      await act('CONFIRM_EVC');
      return 'Visit confirmed. The institution and the committee have been notified.';
    });
  const reschedule = (reason: string) =>
    run('reschedule', async () => {
      await act('RESCHEDULE_EVC', { scheduledStart: startISO, scheduledEnd: endISO, reason, ...(link.trim() ? { meetingLink: link.trim() } : {}), ...(mode === 'PHYSICAL' && location.trim() ? { location: location.trim() } : {}) });
      return 'Visit moved. Every member was notified and asked to accept the new time.';
    });
  const cancel = (reason: string) =>
    run('cancel', async () => {
      await act('CANCEL_EVC', { reason });
      return 'Visit cancelled; the committee’s time has been released.';
    });

  if (ctx.loading && !c) return <Spinner />;
  if (ctx.error && !c) return <Alert kind="error">{ctx.error}</Alert>;
  if (!c) return null;

  const step = ['NOT_SCHEDULED', 'DRAFT'].includes(c.assignmentStatus) ? 0 : c.assignmentStatus === 'AWAITING_CONFIRMATION' ? 3 : ['PENDING_RESPONSES', 'PARTIALLY_ACCEPTED', 'RESCHEDULING_REQUIRED'].includes(c.assignmentStatus) ? 2 : 4;
  const accepted = (c.members ?? []).filter((m: any) => m.active && m.response_status === 'ACCEPTED').length;
  const holding = (c.members ?? []).filter((m: any) => m.active && ['INVITED', 'ACCEPTED'].includes(m.response_status)).length;
  const summary = !sent
    ? conflict
      ? { label: 'Not sent · Conflict unresolved', tone: 'red' as Tone }
      : vacant.length
        ? { label: 'Not sent · Panel incomplete', tone: 'amber' as Tone }
        : { label: 'Not sent · Ready to send', tone: 'slate' as Tone }
    : coordination(c.assignmentStatus, c.conflicts);
  const canSend = editable && rangeOk && vacant.length === 0 && panelIssues.length === 0 && live?.panelConflict === false && (!sent || panelChanged) && !(sent && timeChanged);
  const sendBlocker = !rangeOk
    ? 'Set a valid time range first.'
    : vacant.length
      ? `Assign: ${vacant.map(seatLabel).join(', ')}.`
      : panelIssues.length
        ? 'Resolve the panel conflict first — pick an alternative slot or edit the panel.'
        : sent && timeChanged
          ? 'The time changed after invitations were sent — use Reschedule so everyone is re-asked.'
          : sent && !panelChanged
            ? 'Invitations already sent for this committee.'
            : null;
  const rescheduleNeeded = sent && timeChanged;
  const banner = live && !live.capacity.satisfiable ? live.message ?? live.capacity.message : null;

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'EVC scheduling', 'Schedule visit']}
        title="Schedule EVC visit"
        subtitle={
          <>
            <span className="font-mono font-semibold text-brand-600">{c.application.reference_no}</span> · {c.institution?.name}
            {c.institution?.district && ` · ${c.institution.district}, ${c.institution.state}`}
          </>
        }
        action={
          <Button variant="secondary" onClick={() => nav('/official/evc')}>
            <ArrowLeft className="h-4 w-4" /> EVC scheduling
          </Button>
        }
      />

      {conflict && (
        <div role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Scheduling conflict detected</div>
            <ul className="mt-0.5 space-y-0.5 opacity-90">
              {panelIssues.map((p) => (
                <li key={p.expertId}>
                  {official(p.expertId)?.full_name ?? 'A panel member'} ({seatLabel(p.seat)}) — {p.reason}
                </li>
              ))}
              {declined.map((m: any) => (
                <li key={m.user_id}>
                  {m.full_name} ({seatLabel(m.seat)}) {responsePill(m.response_status).label.toLowerCase()}
                  {m.rejection_reason || m.conflict_note ? `: “${m.rejection_reason ?? m.conflict_note}”` : ''}
                </li>
              ))}
            </ul>
            <div className="mt-1 text-[13px] opacity-80">Choose an alternative slot or edit the panel. Nothing changes until you act.</div>
          </div>
        </div>
      )}
      {banner && !conflict && (
        <div className="mb-5">
          <Alert kind="error" title="No committee can be formed for this slot">{banner}</Alert>
        </div>
      )}
      {msg && (
        <div className="mb-5">
          <Alert kind={msg.kind}>
            {msg.text}
            {msg.details?.length ? (
              <ul className="mt-1 list-disc pl-5 text-[13px]">
                {msg.details.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            ) : null}
          </Alert>
        </div>
      )}
      {liveErr && <div className="mb-5"><Alert kind="warn">{liveErr}</Alert></div>}
      {!c.canEdit && <div className="mb-5"><Alert kind="info">Read-only view. Only the Regional Officer of this region schedules visits.</Alert></div>}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {/* ---------------------------------------------------------------- visit details */}
          <Card>
            <CardHeader title="Visit details" subtitle="All times in India Standard Time" divided />
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <Label htmlFor="d" required>Proposed date</Label>
                <input id="d" type="date" className={inputCls} value={day} min={istDay(new Date())} disabled={!editable} onChange={(e) => setDay(e.target.value)} />
              </div>
              <div>
                <Label>Time zone</Label>
                <div className={cx(inputCls, 'bg-slate-50 text-slate-600')}>IST (UTC+05:30)</div>
              </div>
              <div>
                <Label htmlFor="m" required>Mode</Label>
                <select id="m" className={inputCls} value={mode} disabled={!editable || sent} onChange={(e) => setMode(e.target.value as 'ONLINE' | 'PHYSICAL')}>
                  <option value="ONLINE">Virtual</option>
                  <option value="PHYSICAL">Physical (extraordinary circumstances)</option>
                </select>
              </div>
              <div>
                <Label htmlFor="s" required>Start time</Label>
                <input id="s" type="time" step={900} className={inputCls} value={start} disabled={!editable} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="e" required>End time</Label>
                <input id="e" type="time" step={900} className={cx(inputCls, !rangeOk && 'border-rose-400')} value={end} disabled={!editable} onChange={(e) => setEnd(e.target.value)} />
                {!rangeOk && <p className="mt-1 text-xs text-rose-600">End must be after start.</p>}
              </div>
              <div>
                <Label htmlFor="l">{mode === 'ONLINE' ? 'Meeting link' : 'Location'}</Label>
                {mode === 'ONLINE' ? (
                  <input id="l" className={inputCls} placeholder="Add after slot confirmation" value={link} disabled={!editable} onChange={(e) => setLink(e.target.value)} />
                ) : (
                  <input id="l" className={inputCls} placeholder="Campus address" value={location} disabled={!editable} onChange={(e) => setLocation(e.target.value)} />
                )}
              </div>
              {mode === 'PHYSICAL' && (
                <div className="sm:col-span-2 lg:col-span-3">
                  <Label htmlFor="o" required hint="EVCs are online unless extraordinary circumstances apply">Extraordinary circumstance</Label>
                  <textarea id="o" rows={2} className={inputCls} value={offline} disabled={!editable} onChange={(e) => setOffline(e.target.value)} placeholder="e.g. Court direction (reference)" />
                </div>
              )}
              <div className="sm:col-span-2 lg:col-span-3">
                <Label htmlFor="n" hint="Shared with invited members">Coordination note</Label>
                <textarea id="n" rows={2} className={inputCls} value={note} disabled={!editable} onChange={(e) => setNote(e.target.value)} placeholder="Agenda timing, documents to keep ready, contact person…" />
              </div>
            </div>
          </Card>

          {/* ---------------------------------------------------------------- proposed panel */}
          <Card>
            <CardHeader
              title="Proposed panel"
              subtitle={rangeOk ? `Availability for ${istLongDate(startISO!)}, ${istRange(startISO!, endISO)}` : 'Set a time range to check availability'}
              action={editable && <TextLink onClick={() => setEditSeat('ALL')}>Edit panel →</TextLink>}
            />
            <Table head={['Member', 'Visit responsibility', 'Availability', sent ? 'Response' : '', '']}>
              {[...REQUIRED, ...OPTIONAL.filter((s) => panel.some((p) => p.seat === s))].map((seat) => {
                const p = panel.find((x) => x.seat === seat);
                const o = p ? official(p.expertId) : undefined;
                const ps = p ? live?.panelStatus.find((x) => x.expertId === p.expertId) : undefined;
                const st = ps?.status ?? o?.status;
                const m = p ? memberRow(p.expertId) : undefined;
                return (
                  <tr key={seat} className={cx(st && st !== 'AVAILABLE' && 'bg-rose-50/40')}>
                    <td className={`${tdCls} min-w-[190px]`}>
                      {o ? (
                        <>
                          <div className="font-medium text-slate-900">{o.full_name}</div>
                          <div className="text-xs text-slate-500">
                            <span className="font-mono">{o.member_code}</span> · {human(o.designation_level)}
                          </div>
                        </>
                      ) : (
                        <span className="text-sm text-slate-400 italic">Vacant</span>
                      )}
                    </td>
                    <td className={`${tdCls} text-[13px] text-slate-700`} title={seatFull(seat)}>
                      {seatLabel(seat)}
                      {!REQUIRED.includes(seat) && <span className="ml-1 text-xs text-slate-400">(optional)</span>}
                    </td>
                    <td className={tdCls}>
                      {p && st ? (
                        <span title={ps?.reason ?? o?.reason ?? undefined}>
                          <Badge t={AVAIL[st]?.tone ?? 'slate'}>{AVAIL[st]?.label ?? st}</Badge>
                        </span>
                      ) : p ? (
                        <span className="text-xs text-slate-400">Checking…</span>
                      ) : (
                        <Badge t="amber">Assign a member</Badge>
                      )}
                      {p && st && st !== 'AVAILABLE' && <div className="mt-1 max-w-[260px] text-xs text-rose-700">{ps?.reason ?? o?.reason}</div>}
                    </td>
                    <td className={tdCls}>{sent && m && <Badge t={responsePill(m.response_status).tone}>{responsePill(m.response_status).label}</Badge>}</td>
                    <td className={`${tdCls} text-right`}>{editable && <TextLink onClick={() => setEditSeat(seat)}>{p ? 'Change' : 'Assign'}</TextLink>}</td>
                  </tr>
                );
              })}
              {[...declined, ...removed].map((m: any) => (
                <tr key={`${m.user_id}-${m.seat}-x`} className="bg-slate-50/60 text-slate-500">
                  <td className={tdCls}>
                    <div className="font-medium line-through decoration-slate-300">{m.full_name}</div>
                    <div className="text-xs">{m.member_code}</div>
                  </td>
                  <td className={`${tdCls} text-[13px]`}>{seatLabel(m.seat)}</td>
                  <td className={tdCls} colSpan={2}>
                    <Badge t={m.active ? responsePill(m.response_status).tone : 'slate'}>{m.active ? responsePill(m.response_status).label : 'Released'}</Badge>
                    {(m.rejection_reason || m.conflict_note || m.removed_reason) && <div className="mt-1 max-w-[300px] text-xs">“{m.rejection_reason ?? m.conflict_note ?? m.removed_reason}”</div>}
                  </td>
                  <td className={`${tdCls} text-right`}>{editable && m.active && <TextLink onClick={() => setEditSeat(m.seat)}>Replace</TextLink>}</td>
                </tr>
              ))}
            </Table>
            {c.composition && !c.composition.valid && (
              <div className="border-t border-slate-100 px-5 py-3">
                <Alert kind="warn" title="Committee composition">
                  <ul className="list-disc pl-5 text-[13px]">
                    {c.composition.findings.filter((f: any) => f.blocking).map((f: any) => <li key={f.id + (f.expertId ?? '')}>{f.message}</li>)}
                  </ul>
                </Alert>
              </div>
            )}
          </Card>

          {c.history?.length > 0 && (
            <Card>
              <CardHeader title="Schedule history" subtitle="Append-only record of every change" divided />
              <div className="pt-4">
                <Timeline
                  items={c.history.map((h: any) => ({
                    id: h.id,
                    title: `${human(h.new_status)} · v${h.schedule_version}${h.new_start ? ` · ${istLongDate(h.new_start)}, ${istRange(h.new_start, h.new_end)}` : ''}`,
                    meta: `${h.actor_name ?? 'System'} · ${fmtDateTime(h.created_at)}`,
                    body: h.reason,
                    tone: h.new_status === 'CANCELLED' ? 'warn' : 'done',
                  }))}
                />
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {/* ---------------------------------------------------------------- alternatives */}
          <Card>
            <CardHeader title="Alternative slots" subtitle={panel.length ? 'Where your whole panel is free' : 'Where the required seats can be staffed'} divided />
            <div className="divide-y divide-slate-100">
              {!live ? (
                <p className="px-5 py-4 text-sm text-slate-500">{rangeOk ? 'Checking availability…' : 'Set a valid time range.'}</p>
              ) : live.alternatives.length === 0 ? (
                <Empty icon={<CalendarClock className="h-5 w-5" />} title="No alternative found">No free slot of this length in the search window. Try another date or edit the panel.</Empty>
              ) : (
                live.alternatives.map((a) => (
                  <div key={a.start} className="flex items-center justify-between gap-3 px-5 py-3.5">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900">{istLongDate(a.start)}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-slate-600">
                        <Clock className="h-3.5 w-3.5 text-slate-400" /> {istRange(a.start, a.end)}
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
                        <Check className="h-3.5 w-3.5" /> {a.basis}
                      </div>
                    </div>
                    {editable && (
                      <TextLink
                        onClick={() => {
                          setDay(istDay(a.start));
                          setStart(istHHMM(a.start));
                          setEnd(istHHMM(a.end));
                          setMsg(null);
                        }}
                      >
                        Use this slot →
                      </TextLink>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* ---------------------------------------------------------------- invitation summary */}
          <Card>
            <CardHeader title="Invitation summary" divided />
            <div className="space-y-4 p-5">
              <KV k="Application" v={<span className="font-mono text-brand-600">{c.application.reference_no}</span>} />
              <KV k="Slot" v={rangeOk ? `${istLongDate(startISO!)} · ${istRange(startISO!, endISO)} · ${modeLabel(mode)}` : '—'} />
              <KV
                k="Recipients"
                v={
                  panel.length ? (
                    <ul className="space-y-0.5">
                      {panel.map((p) => (
                        <li key={p.expertId} className="flex items-center gap-1.5">
                          <Users className="h-3.5 w-3.5 text-slate-400" /> {official(p.expertId)?.full_name ?? '—'} <span className="text-xs text-slate-500">· {seatLabel(p.seat)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    'No members selected'
                  )
                }
              />
              <div>
                <div className="text-xs text-slate-500">Status</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Badge t={summary.tone}>{summary.label}</Badge>
                  {sent && <span className="text-xs text-slate-500">{accepted}/{holding || panel.length} accepted</span>}
                </div>
              </div>
              {c.handoff && <KV k="Forwarded by" v={`${c.handoff.forwarded_by} · ${fmtDate(c.handoff.created_at)}`} />}

              {editable && (!sent || panelChanged) && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-[13px] font-semibold text-slate-900">Before invitations can be sent</div>
                  <ul className="mt-2 space-y-1.5 text-[13px]">
                    {[
                      { ok: rangeOk, text: 'Valid date and time range' },
                      ...REQUIRED.map((s) => ({ ok: panel.some((p) => p.seat === s), text: `${seatLabel(s)} assigned` })),
                      { ok: panel.length > 0 && panelIssues.length === 0 && live?.panelConflict === false, text: 'Every panel member free for this slot' },
                    ].map((x) => (
                      <li key={x.text} className={cx('flex items-center gap-2', x.ok ? 'text-emerald-700' : 'text-slate-600')}>
                        {x.ok ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5 rounded-full border border-slate-300" />} {x.text}
                      </li>
                    ))}
                  </ul>
                  {vacant.length > 0 && live && (
                    <Button variant="secondary" className="mt-3 w-full" onClick={fillVacant}>
                      <Users className="h-4 w-4" /> Fill vacant seats
                    </Button>
                  )}
                  {fillNote && <p className={cx('mt-2 text-xs', fillNote.ok ? 'text-emerald-700' : 'text-rose-700')}>{fillNote.text}</p>}
                  {banner && <p className="mt-2 text-xs text-rose-700">{banner}</p>}
                  <p className="mt-2 text-xs text-slate-500">Members are not notified while the proposal is a draft.</p>
                </div>
              )}

              {editable && (
                <div className="space-y-2 border-t border-slate-100 pt-4">
                  {!sent && (
                    <Button variant="secondary" className="w-full" loading={busy === 'save'} disabled={!rangeOk || !dirty} onClick={save}>
                      Save proposal
                    </Button>
                  )}
                  {rescheduleNeeded ? (
                    <Button className="w-full" loading={busy === 'reschedule'} disabled={!rangeOk || panelIssues.length > 0} onClick={() => setAsk({ kind: 'RESCHEDULE', text: '' })}>
                      <CalendarClock className="h-4 w-4" /> Reschedule & re-invite
                    </Button>
                  ) : (
                    <Button className="w-full" loading={busy === 'send'} disabled={!canSend} onClick={() => (sent && c.assignmentStatus === 'CONFIRMED' ? setAsk({ kind: 'REPLACE', text: '' }) : send())}>
                      <Send className="h-4 w-4" /> {sent ? 'Send updated invitations' : 'Send invitations'}
                    </Button>
                  )}
                  {c.assignmentStatus === 'AWAITING_CONFIRMATION' && !dirty && (
                    <Button variant="dark" className="w-full" loading={busy === 'confirm'} onClick={confirmVisit}>
                      <Check className="h-4 w-4" /> Confirm visit
                    </Button>
                  )}
                  {v && (
                    <Button variant="ghost" className="w-full text-rose-700 hover:bg-rose-50" onClick={() => setAsk({ kind: 'CANCEL', text: '' })}>
                      <X className="h-4 w-4" /> Cancel visit
                    </Button>
                  )}
                  <p className="text-xs text-slate-500">
                    {sendBlocker && !rescheduleNeeded && !(sent && !panelChanged) ? <span className="text-amber-700">{sendBlocker} </span> : null}
                    Sending reserves each member’s time immediately. The visit is confirmed only after every member accepts; the institution is told only then.
                  </p>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* ---------------------------------------------------------------- coordination flow */}
      <Card className="mt-6">
        <div className="px-5 py-4">
          <div className="mb-3 text-[11px] font-semibold tracking-[0.12em] text-slate-500 uppercase">Coordination flow</div>
          <ol className="flex flex-wrap items-center gap-2">
            {['Proposal', 'Invitations sent', 'Awaiting responses', 'Confirmed'].map((s, i) => {
              const done = i < step;
              const current = i === step;
              return (
                <li key={s} className="flex items-center gap-2">
                  <span
                    className={cx(
                      'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium',
                      done ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : current ? (conflict ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-brand-200 bg-brand-50 text-brand-700') : 'border-slate-200 bg-white text-slate-400',
                    )}
                  >
                    <span className={cx('flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold', done ? 'bg-emerald-600 text-white' : current ? (conflict ? 'bg-rose-600 text-white' : 'bg-brand-600 text-white') : 'bg-slate-200 text-slate-500')}>
                      {done ? <Check className="h-3 w-3" /> : i + 1}
                    </span>
                    {s}
                  </span>
                  {i < 3 && <ChevronRight className="h-4 w-4 text-slate-300" />}
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs text-slate-500">
            {step === 0 && 'Save the proposal, resolve any conflict, then send invitations.'}
            {step === 2 && `Waiting for the committee: ${accepted} of ${holding || panel.length} accepted. Declined seats must be replaced or the visit rescheduled.`}
            {step === 3 && 'Every member accepted. Confirm the visit to notify the institution.'}
            {step >= 4 && `Visit ${coordination(c.assignmentStatus).label.toLowerCase()}.`}
          </p>
        </div>
      </Card>
      <PageNote>Availability is computed from recorded assignments and unavailability; overlapping bookings are refused by the database. Scheduling never grants approval.</PageNote>

      {editSeat && (
        <PanelEditor
          open
          seats={editSeat === 'ALL' ? [...REQUIRED, ...OPTIONAL] : [editSeat]}
          seatLabel={seatLabel}
          officials={live?.officials ?? c.availability?.officials ?? []}
          declined={declinedIds}
          panel={panel}
          slot={rangeOk ? `${istLongDate(startISO!)}, ${istRange(startISO!, endISO)}` : ''}
          onClose={() => setEditSeat(null)}
          onApply={(next) => {
            setPanel(next);
            setEditSeat(null);
          }}
        />
      )}
      <Modal open={!!ask} onClose={() => setAsk(null)} title={ask?.kind === 'CANCEL' ? 'Cancel visit' : ask?.kind === 'RESCHEDULE' ? 'Reschedule visit' : 'Replace committee member'}>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {ask?.kind === 'CANCEL' && 'Every member’s reservation is released and the institution is told. This is recorded in the history.'}
            {ask?.kind === 'RESCHEDULE' && `The visit moves to ${rangeOk ? `${istLongDate(startISO!)}, ${istRange(startISO!, endISO)}` : ''}. Availability is re-checked and every member is asked to accept again.`}
            {ask?.kind === 'REPLACE' && 'The visit is confirmed; changing its committee needs a recorded reason. The released member is notified.'}
          </p>
          <Label htmlFor="why" required>Reason</Label>
          <textarea id="why" rows={3} className={inputCls} value={ask?.text ?? ''} onChange={(e) => ask && setAsk({ ...ask, text: e.target.value })} />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setAsk(null)}>Back</Button>
            <Button
              variant={ask?.kind === 'CANCEL' ? 'danger' : 'primary'}
              disabled={(ask?.text.trim().length ?? 0) < 5}
              onClick={() => {
                const a = ask!;
                setAsk(null);
                if (a.kind === 'CANCEL') cancel(a.text.trim());
                else if (a.kind === 'RESCHEDULE') reschedule(a.text.trim());
                else send(a.text.trim());
              }}
            >
              {ask?.kind === 'CANCEL' ? 'Cancel visit' : ask?.kind === 'RESCHEDULE' ? 'Reschedule' : 'Send updated invitations'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/** Choose officials per seat. Only verified, eligible officials free for the whole slot can be picked; everyone else shows why. */
function PanelEditor({ open, seats, seatLabel, officials, declined, panel, slot, onClose, onApply }: { open: boolean; seats: Seat[]; seatLabel: (s: Seat) => string; officials: Official[]; declined: string[]; panel: PanelEntry[]; slot: string; onClose: () => void; onApply: (p: PanelEntry[]) => void }) {
  const [draft, setDraft] = useState<PanelEntry[]>(panel);
  const [seat, setSeat] = useState<Seat>(seats[0]);
  const [q, setQ] = useState('');
  const chosen = draft.find((d) => d.seat === seat);
  const rows = useMemo(
    () =>
      officials
        .filter((o) => !q || `${o.full_name} ${o.member_code} ${o.discipline} ${o.organisation}`.toLowerCase().includes(q.toLowerCase()))
        .map((o) => {
          const elig = o.seatEligibility?.[seat];
          const elsewhere = draft.find((d) => d.expertId === o.id && d.seat !== seat);
          const why = declined.includes(o.id) ? 'Declined this slot — reschedule to invite again' : o.status !== 'AVAILABLE' ? o.reason : elig?.outcome !== 'PASS' ? (elig?.reasons?.[0] ?? `Not eligible for ${seatLabel(seat)}`) : elsewhere ? `Already on the panel as ${seatLabel(elsewhere.seat)}` : null;
          return { o, elig, why, selectable: !why };
        })
        .sort((a, b) => Number(b.selectable) - Number(a.selectable)),
    [officials, q, seat, draft, seatLabel, declined],
  );
  const pick = (id: string) => setDraft([...draft.filter((d) => d.seat !== seat), { expertId: id, seat }]);
  return (
    <Modal open={open} onClose={onClose} title="Edit panel" wide>
      <div className="space-y-4">
        <p className="text-[13px] text-slate-600">
          Officials from the EVC registry, with their availability for <span className="font-semibold text-slate-800">{slot || 'the selected slot'}</span>. Members are invited only when you send invitations.
        </p>
        {seats.length > 1 && (
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
            {seats.map((s) => (
              <button key={s} onClick={() => setSeat(s)} className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium', s === seat ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
                {seatLabel(s)}
                {draft.some((d) => d.seat === s) && <Check className="ml-1 inline h-3.5 w-3.5 text-emerald-600" />}
              </button>
            ))}
          </div>
        )}
        <input className={inputCls} placeholder="Search name, ID, discipline or organisation" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-slate-50">
              <tr className="border-b border-slate-200 text-[11px] font-semibold tracking-[0.06em] text-slate-500 uppercase">
                <th className="px-3 py-2">Official</th>
                <th className="px-3 py-2">Category & qualification</th>
                <th className="px-3 py-2">Availability</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ o, elig, why, selectable }) => (
                <tr key={o.id} className={cx(!selectable && 'bg-slate-50/60 text-slate-500', chosen?.expertId === o.id && 'bg-brand-50/60')}>
                  <td className="px-3 py-2.5 align-top">
                    <div className={cx('font-medium', selectable ? 'text-slate-900' : 'text-slate-600')}>{o.full_name}</div>
                    <div className="font-mono text-xs text-slate-500">{o.member_code}</div>
                  </td>
                  <td className="px-3 py-2.5 align-top text-[13px]">
                    <div>{human(o.designation_level)} · {human(o.discipline)}</div>
                    <div className="text-xs text-slate-500">
                      {o.organisation ?? '—'}
                      {o.experience_years != null && ` · ${o.experience_years} yrs`}
                    </div>
                    <div className="mt-0.5 text-xs">
                      {seatLabel(seat)}: <span className={elig?.outcome === 'PASS' ? 'text-emerald-700' : elig?.outcome === 'FAIL' ? 'text-rose-700' : 'text-violet-700'}>{human(elig?.outcome)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    <Badge t={AVAIL[o.status]?.tone ?? 'slate'}>{AVAIL[o.status]?.label ?? o.status}</Badge>
                    <div className="mt-1 text-xs text-slate-500">{o.dayAssignments?.length ? `${o.dayAssignments.length} assignment(s) that day` : 'No assignments that day'}</div>
                    {o.dayAssignments?.map((d, i) => (
                      <div key={i} className="text-[11px] text-slate-500">
                        {d.referenceNo} · {istRange(d.start, d.end)}
                      </div>
                    ))}
                    {why && <div className="mt-1 max-w-[220px] text-xs text-rose-700">{why}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-right align-top">
                    {chosen?.expertId === o.id ? (
                      <Badge t="blue">Selected</Badge>
                    ) : (
                      <Button variant="secondary" className="px-3 py-1 text-xs" disabled={!selectable} onClick={() => pick(o.id)}>
                        Select
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-slate-500">{draft.length} member(s) on the panel</div>
          <div className="flex gap-2">
            {chosen && !REQUIRED.includes(seat) && (
              <Button variant="ghost" onClick={() => setDraft(draft.filter((d) => d.seat !== seat))}>
                Remove {seatLabel(seat)}
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => onApply(draft)}>
              Apply panel <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

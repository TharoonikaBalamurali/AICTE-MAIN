import {
  AlertTriangle,
  Bell,
  CalendarDays,
  ChevronDown,
  ChevronsUpDown,
  ClipboardCheck,
  FilePlus2,
  FilePen,
  Files,
  ClipboardList,
  MailCheck,
  UserX,
  FileSearch,
  Inbox,
  Gavel,
  HelpCircle,
  LayoutGrid,
  ListChecks,
  LogOut,
  Menu,
  Scale,
  Search,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  UserCheck,
  BarChart3,
  User,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import aicteLogo from '../assets/aicte-logo.png';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { initialsOf, WORKSPACE_NAME } from '../lib/roles';
import { cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  end?: boolean;
  badge?: number;
  /** Query string (e.g. "?status=SUBMITTED") for entries that open a filtered view of an existing page. */
  search?: string;
  /** Other paths that belong to this entry (e.g. a page reached from it). */
  also?: RegExp;
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

export function BrandMark({ dark = true }: { dark?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <img src={aicteLogo} alt="AICTE" className="h-9 w-9 shrink-0 object-contain" />
      <div className="leading-tight">
        <div className={cx('text-[10px] font-semibold tracking-[0.18em] uppercase', dark ? 'text-slate-400' : 'text-slate-500')}>AICTE</div>
        <div className={cx('text-[16px] font-bold', dark ? 'text-white' : 'text-navy-900')}>Approval Portal</div>
      </div>
    </div>
  );
}

function useCounts(institution: boolean) {
  const [counts, setCounts] = useState({ unread: 0, deficiencies: 0 });
  const loc = useLocation();
  useEffect(() => {
    let alive = true;
    Promise.all([api.get('/api/notifications').catch(() => null), institution ? api.get('/api/dashboard').catch(() => null) : null]).then(([n, d]) => {
      if (alive) setCounts({ unread: n?.unread ?? 0, deficiencies: d?.kpis?.openDeficiencies ?? 0 });
    });
    return () => {
      alive = false;
    };
  }, [loc.pathname, institution]);
  return counts;
}

/** Open EVC invitations for the member's sidebar badge. */
function useInviteCount(enabled: boolean) {
  const [n, setN] = useState(0);
  const loc = useLocation();
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .get('/api/evc/my-assignments')
      .then((d) => alive && setN((d.assignments ?? []).filter((a: any) => a.active && a.response_status === 'INVITED' && ['PROPOSED', 'SCHEDULED', 'RESCHEDULED'].includes(a.visit_status)).length))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, loc.pathname]);
  return n;
}

function WorkspaceSwitcher({ homePath }: { homePath: string }) {
  const { user, switchRole } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const roles = user?.roles ?? [];
  const multi = roles.length > 1;
  return (
    <div className="relative px-4 pt-4">
      <button
        type="button"
        disabled={!multi}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cx('w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-left', multi && 'hover:bg-white/[0.08]')}
      >
        <div className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase">Current workspace</div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-white">{WORKSPACE_NAME[user?.activeRole ?? ''] ?? user?.activeRole}</span>
          {multi && <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" />}
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">{multi ? `${roles.length} authorised workspaces` : 'Assigned access only'}</div>
      </button>
      {open && (
        <div role="menu" className="absolute right-4 left-4 z-40 mt-1 rounded-lg border border-white/10 bg-navy-800 p-1 shadow-xl" onMouseLeave={() => setOpen(false)}>
          {roles.map((r) => (
            <button
              key={r}
              role="menuitem"
              className={cx('w-full rounded-md px-3 py-2 text-left text-sm', r === user?.activeRole ? 'bg-white/10 font-semibold text-white' : 'text-slate-300 hover:bg-white/5')}
              onClick={async () => {
                setOpen(false);
                if (r !== user?.activeRole) {
                  await switchRole(r);
                  nav(homePath);
                }
              }}
            >
              {WORKSPACE_NAME[r] ?? r}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({ groups, homePath, onNavigate }: { groups: NavGroup[]; homePath: string; onNavigate?: () => void }) {
  const { logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const all = groups.flatMap((g) => g.items);
  // Several entries may open the same page with different filters; the one whose query matches is active.
  const active = (i: NavItem) => {
    if (i.also?.test(loc.pathname)) return true;
    const onPath = i.end ? loc.pathname === i.to : loc.pathname === i.to || loc.pathname.startsWith(`${i.to}/`);
    if (!onPath) return false;
    if (i.search) return loc.search === i.search;
    return !all.some((o) => o !== i && o.to === i.to && o.search && o.search === loc.search);
  };
  const link = (i: NavItem) => {
    const on = active(i);
    return (
      <Link
        key={i.to + (i.search ?? '')}
        to={i.to + (i.search ?? '')}
        onClick={onNavigate}
        aria-current={on ? 'page' : undefined}
        className={cx('mb-0.5 flex items-center gap-3 rounded-lg px-3 py-[7px] text-sm transition', on ? 'bg-navy-700 font-semibold text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white')}
      >
        <i.icon className="h-[17px] w-[17px] shrink-0" />
        <span className="flex-1 truncate">{i.label}</span>
        {!!i.badge && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-slate-200">{i.badge}</span>}
      </Link>
    );
  };
  return (
    <>
      <div className="px-5 pt-5">
        <BrandMark />
      </div>
      <WorkspaceSwitcher homePath={homePath} />
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pt-4 pb-2">
        {groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <div key={g.title} className="mb-3">
              <div className="mb-1.5 px-3 text-[10px] font-semibold tracking-[0.16em] text-slate-500 uppercase">{g.title}</div>
              {g.items.map(link)}
            </div>
          ))}
      </nav>
      <div className="px-3 pb-4">
        {link({ to: '/help', label: 'Help & support', icon: HelpCircle, end: true })}
        <button
          type="button"
          onClick={async () => {
            await logout();
            nav('/login');
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-[17px] w-[17px]" /> Sign out
        </button>
        <div className="mx-3 mt-3 border-t border-white/10 pt-3 text-[11px] text-slate-500">AICTE Approval Portal</div>
      </div>
    </>
  );
}

function TopBar({ onMenu, unread, searchPath }: { onMenu: () => void; unread: number; searchPath: string }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const institution = user?.activeRole === 'INSTITUTION_APPLICANT';
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-8">
      <button aria-label="Open menu" className="rounded-md p-2 text-slate-600 lg:hidden" onClick={onMenu}>
        <Menu className="h-5 w-5" />
      </button>
      <form
        role="search"
        className="relative hidden w-full max-w-md sm:block"
        onSubmit={(e) => {
          e.preventDefault();
          nav(`${searchPath}?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          ref={ref}
          aria-label="Search applications"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search applications by ID or institution…"
          className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pr-14 pl-9 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100 focus:outline-none"
        />
        <kbd className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[10px] font-semibold text-slate-400">Ctrl K</kbd>
      </form>
      <div className="flex-1" />
      <span className="hidden text-[13px] text-slate-500 md:block">{today} · IST</span>
      <button aria-label={`Notifications (${unread} unread)`} onClick={() => nav('/notifications')} className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100">
        <Bell className="h-5 w-5" />
        {unread > 0 && <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white" />}
      </button>
      <div className="relative">
        <button onClick={() => setMenu((m) => !m)} className="flex items-center gap-2.5 rounded-lg py-1 pr-1.5 pl-1 hover:bg-slate-50" aria-haspopup="menu" aria-expanded={menu}>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-navy-900 text-xs font-semibold text-white">{initialsOf(user?.fullName)}</span>
          <span className="hidden text-left md:block">
            <span className="block text-sm leading-tight font-semibold text-slate-900">{user?.fullName}</span>
            <span className="block text-xs text-slate-500">{institution ? 'Institution account' : 'Authorised official'}</span>
          </span>
          <ChevronDown className="h-4 w-4 text-slate-400" />
        </button>
        {menu && (
          <div role="menu" className="absolute right-0 mt-2 w-60 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg" onMouseLeave={() => setMenu(false)}>
            <div className="border-b border-slate-100 px-3 pt-1.5 pb-2.5 text-xs text-slate-500">
              Signed in as <span className="font-semibold text-slate-700">{user?.loginId}</span>
              {user?.designation && <div className="mt-0.5">{user.designation}</div>}
            </div>
            {institution && (
              <button role="menuitem" className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { setMenu(false); nav('/profile'); }}>
                <User className="h-4 w-4 text-slate-400" /> Institution profile
              </button>
            )}
            <button
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50"
              onClick={async () => {
                await logout();
                nav('/login');
              }}
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function Shell({ groups, children, homePath, searchPath, unread }: { groups: NavGroup[]; children?: ReactNode; homePath: string; searchPath: string; unread: number }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div className="min-h-screen lg:pl-[248px]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col bg-navy-900 lg:flex">
        <Sidebar groups={groups} homePath={homePath} />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-slate-900/50" />
          <aside className="absolute inset-y-0 left-0 flex w-[260px] flex-col bg-navy-900" onClick={(e) => e.stopPropagation()}>
            <button aria-label="Close menu" className="absolute top-5 right-3 text-slate-300" onClick={() => setOpen(false)}>
              <X className="h-5 w-5" />
            </button>
            <Sidebar groups={groups} homePath={homePath} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <TopBar onMenu={() => setOpen(true)} unread={unread} searchPath={searchPath} />
      <main className="mx-auto max-w-[1360px] px-4 py-7 sm:px-8">{children ?? <Outlet />}</main>
    </div>
  );
}

export function InstitutionLayout() {
  const counts = useCounts(true);
  const groups: NavGroup[] = [
    {
      title: 'Workspace',
      items: [
        { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
        { to: '/applications', label: 'Applications', icon: Files, end: true },
        { to: '/applications/new', label: 'New application', icon: FilePlus2 },
      ],
    },
    {
      title: 'Actions',
      items: [
        { to: '/respond', label: 'Respond to notice', icon: FilePen, badge: counts.deficiencies, also: /^\/applications\/[^/]+\/respond$/ },
        { to: '/deficiencies', label: 'Correction items', icon: AlertTriangle },
        { to: '/evc', label: 'EVC schedule', icon: CalendarDays },
        { to: '/decisions', label: 'Decisions & appeals', icon: Gavel },
        { to: '/compliance', label: 'Compliance', icon: ClipboardCheck },
      ],
    },
    { title: 'Updates', items: [{ to: '/notifications', label: 'Notifications', icon: Bell, badge: counts.unread }] },
  ];
  return <Shell groups={groups} homePath="/" searchPath="/applications" unread={counts.unread} />;
}

const COMMITTEE_ROLES = ['EC_OFFICIAL', 'SHC_MEMBER', 'SAC_MEMBER', 'COUNCIL_OFFICIAL'];

export function OfficialLayout() {
  const { user } = useAuth();
  const counts = useCounts(false);
  const role = user?.activeRole ?? '';
  const is = (...r: string[]) => r.includes(role);
  const reviewer = !is('RULES_GOVERNANCE', 'SYSTEM_ADMIN');
  const invites = useInviteCount(role === 'EVC_MEMBER');
  const q = (search: string) => ({ to: '/official/queue', search });
  const groups: NavGroup[] = [
    {
      title: 'Workspace',
      items: [
        ...(reviewer ? [{ to: '/official', label: COMMITTEE_ROLES.includes(role) ? 'Committee desk' : 'Overview', icon: LayoutGrid, end: true }] : []),
        ...(reviewer && !is('EVC_MEMBER') ? [{ to: '/official/queue', label: 'Review queue', icon: ListChecks, end: true }] : []),
        { to: '/notifications', label: 'Notifications', icon: Bell, badge: counts.unread },
      ],
    },
    {
      title: 'Scrutiny',
      items: is('SCRUTINY_OFFICIAL')
        ? [
            { ...q('?status=SUBMITTED'), label: 'New submissions', icon: Inbox },
            { ...q('?status=UNDER_SCRUTINY'), label: 'Under scrutiny', icon: FileSearch },
            { ...q('?scope=all&status=DEFICIENCY_RAISED'), label: 'Corrections requested', icon: AlertTriangle },
          ]
        : is('RE_SCRUTINY_OFFICIAL')
          ? [
              { ...q('?status=READY_FOR_RE_SCRUTINY'), label: 'Resubmissions ready', icon: Inbox },
              { ...q('?status=UNDER_RE_SCRUTINY'), label: 'Under re-scrutiny', icon: FileSearch },
              { ...q('?scope=all&status=CORRECTION_IN_PROGRESS'), label: 'Awaiting institution', icon: AlertTriangle },
            ]
          : [],
    },
    {
      title: 'Expert visits',
      items: [
        ...(is('EVC_MEMBER') ? [{ to: '/official/evc/invitations', label: 'Invitations', icon: MailCheck, badge: invites }] : []),
        ...(is('REGIONAL_OFFICER', 'EVC_MEMBER', 'SUPERVISOR', 'REGULATION_BUREAU') ? [{ to: '/official/evc', label: is('EVC_MEMBER') ? 'My schedule' : 'EVC schedule', icon: CalendarDays, end: is('EVC_MEMBER') }] : []),
        ...(is('EVC_MEMBER') ? [{ to: '/official/evc/reports', label: 'Inspection reports', icon: ClipboardList }, { to: '/official/evc/unavailability', label: 'Unavailability', icon: UserX }] : []),
        ...(is('REGIONAL_OFFICER', 'REGULATION_BUREAU', 'SUPERVISOR', 'SYSTEM_ADMIN') ? [{ to: '/official/registry', label: 'EVC registry', icon: UserCheck }] : []),
        ...(is('REGULATION_BUREAU', 'SUPERVISOR') ? [{ to: '/official/bureau/escalations', label: 'EVC escalations', icon: ShieldAlert }] : []),
      ],
    },
    {
      title: 'Oversight',
      items: [
        ...(is('REGIONAL_OFFICER', 'REGULATION_BUREAU', 'SUPERVISOR', 'DECISION_AUTHORITY') ? [{ to: '/official/reports', label: 'Reports', icon: BarChart3 }] : []),
        ...(is('DECISION_AUTHORITY', 'REGULATION_BUREAU', 'SUPERVISOR') ? [{ to: '/official/compliance', label: 'Compliance', icon: ClipboardCheck }] : []),
        ...(is('SUPERVISOR') ? [{ to: '/official/escalations', label: 'Deadline escalations', icon: ShieldCheck }] : []),
      ],
    },
    {
      title: 'Administration',
      items: [
        ...(is('SUPERVISOR') ? [{ to: '/official/people', label: 'People & permissions', icon: Users }] : []),
        ...(is('SYSTEM_ADMIN') ? [{ to: '/official/admin', label: 'Notifications & jobs', icon: Bell }] : []),
        ...(is('SYSTEM_ADMIN', 'SUPERVISOR', 'REGULATION_BUREAU') ? [{ to: '/official/policies', label: 'Operational settings', icon: SlidersHorizontal }] : []),
      ],
    },
    { title: 'Governance', items: [{ to: '/official/rules', label: 'Regulatory rules', icon: Scale }] },
  ];
  const home = role === 'RULES_GOVERNANCE' ? '/official/rules' : role === 'SYSTEM_ADMIN' ? '/official/admin' : '/official';
  return <Shell groups={groups} homePath={home} searchPath="/official/queue" unread={counts.unread} />;
}

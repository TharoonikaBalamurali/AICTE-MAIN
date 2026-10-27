import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { InstitutionLayout, OfficialLayout } from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import ApplicationDetail from './pages/ApplicationDetail';
import Applications from './pages/Applications';
import ApplicationWizard from './pages/ApplicationWizard';
import RespondNotice from './pages/RespondNotice';
import RespondHub from './pages/RespondHub';
import Dashboard from './pages/Dashboard';
import Help from './pages/Help';
import Login from './pages/Login';
import { ComplianceReview, RulesGovernance } from './pages/official/Governance';
import { EvcSchedule } from './pages/official/EvcSchedule';
import { EvcScheduleVisit } from './pages/official/EvcScheduleVisit';
import { CommitteeCase } from './pages/official/CommitteeDesk';
import { MemberInvitations, MemberReports, MemberUnavailability } from './pages/official/EvcMemberPages';
import { EscalationDetail, EscalationQueue } from './pages/official/Bureau';
import { VisitWorkspace } from './pages/official/EvcMember';
import { OperationalPolicies, PendencyReport } from './pages/official/PendencyReport';
import { ExpertRegistry } from './pages/official/Registry';
import { OfficialQueue, ReviewQueue } from './pages/official/Home';
import { AdminConsole, Escalations, PeoplePermissions } from './pages/official/Oversight';
import { OfficialApplication } from './pages/official/Workspace';
import { Compliance, Decisions, Deficiencies, EvcVisits, Notifications } from './pages/Processing';
import Profile from './pages/Profile';

export default function App() {
  const { user, workspace, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Spinner label="Checking your session…" />;
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: loc.pathname }} />} />
      </Routes>
    );
  }
  if (workspace === 'INSTITUTION') {
    return (
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route element={<InstitutionLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="applications" element={<Applications />} />
          <Route path="applications/new" element={<ApplicationWizard key="new" />} />
          <Route path="applications/:id/edit" element={<ApplicationWizard />} />
          <Route path="applications/:id" element={<ApplicationDetail />} />
          <Route path="applications/:id/respond" element={<RespondNotice />} />
          <Route path="respond" element={<RespondHub />} />
          <Route path="deficiencies" element={<Deficiencies />} />
          <Route path="evc" element={<EvcVisits />} />
          <Route path="decisions" element={<Decisions />} />
          <Route path="compliance" element={<Compliance />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="profile" element={<Profile />} />
          <Route path="help" element={<Help />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    );
  }
  const home = workspace === 'GOVERNANCE' ? '/official/rules' : user.activeRole === 'SYSTEM_ADMIN' ? '/official/admin' : '/official';
  return (
    <Routes>
      <Route element={<OfficialLayout />}>
        <Route path="official" element={workspace === 'GOVERNANCE' ? <Navigate to="/official/rules" replace /> : user.activeRole === 'SYSTEM_ADMIN' ? <Navigate to="/official/admin" replace /> : <OfficialQueue />} />
        <Route path="official/queue" element={<ReviewQueue />} />
        <Route path="official/evc" element={<EvcSchedule />} />
        <Route path="official/evc/schedule/:applicationId" element={<EvcScheduleVisit />} />
        <Route path="official/committee/:id" element={<CommitteeCase />} />
        <Route path="official/evc/invitations" element={<MemberInvitations />} />
        <Route path="official/evc/reports" element={<MemberReports />} />
        <Route path="official/evc/unavailability" element={<MemberUnavailability />} />
        <Route path="official/visits/:visitId" element={<VisitWorkspace />} />
        <Route path="official/registry" element={<ExpertRegistry />} />
        <Route path="official/bureau/escalations" element={<EscalationQueue />} />
        <Route path="official/bureau/escalations/:id" element={<EscalationDetail />} />
        <Route path="official/reports" element={<PendencyReport />} />
        <Route path="official/policies" element={<OperationalPolicies />} />
        <Route path="official/people" element={<PeoplePermissions />} />
        <Route path="official/escalations" element={<Escalations />} />
        <Route path="official/admin" element={<AdminConsole />} />
        <Route path="official/applications/:id" element={<OfficialApplication />} />
        <Route path="official/rules" element={<RulesGovernance />} />
        <Route path="official/compliance" element={<ComplianceReview />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="help" element={<Help />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Route>
    </Routes>
  );
}

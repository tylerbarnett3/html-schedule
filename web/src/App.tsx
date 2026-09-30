import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { codeLoaded, reloadOnceForNewBuild } from "./app/staleBuild";
import { Spinner } from "./components/Spinner";
import { LoginPage } from "./features/auth/LoginPage";
import { NoAccess } from "./features/auth/NoAccess";
import { ProfileError } from "./features/auth/ProfileError";
import { SchedulePage } from "./features/schedule/SchedulePage";
import { useAuth, type AuthState } from "./lib/auth";

// The admin screens are their own download; employees never load them. The preload and the
// routes share one import, so a failed preload is what the route sees (and reloads for).
let adminImport: Promise<typeof import("./features/admin/adminRoutes")> | undefined;
const importAdmin = () => (adminImport ??= import("./features/admin/adminRoutes"));
const loadAdmin = () =>
  importAdmin().then((m) => {
    codeLoaded();
    return m;
  }, reloadOnceForNewBuild);
const AdminLayout = lazy(() => loadAdmin().then((m) => ({ default: m.AdminLayout })));
const AdminSchedulePage = lazy(() => loadAdmin().then((m) => ({ default: m.AdminSchedulePage })));
const PayrollPage = lazy(() => loadAdmin().then((m) => ({ default: m.PayrollPage })));

function AppLoading() {
  return (
    <div className="app-loading">
      <Spinner size="lg" label="Loading..." showLabel />
    </div>
  );
}

/** What a signed-in-only route shows before its page: the login redirect or an account problem. */
function gate(auth: AuthState): ReactNode | null {
  switch (auth.status) {
    case "signed-out":
      return <Navigate to="/login" replace />;
    case "no-access":
      return <NoAccess />;
    case "error":
      return <ProfileError onRetry={auth.retry} />;
    default:
      return null;
  }
}

export default function App() {
  const auth = useAuth();
  const isAdmin = auth.status === "signed-in" && auth.profile.isAdmin;

  // Start the admin download as soon as an admin is known, before any redirect needs it. A
  // failure is dealt with when the admin route opens.
  useEffect(() => {
    if (isAdmin) importAdmin().catch(() => {});
  }, [isAdmin]);

  if (auth.status === "loading") return <AppLoading />;

  const profile = auth.status === "signed-in" ? auth.profile : null;

  // An admin with no employee record has no schedule of their own, so "/" is the admin page
  // for them. An admin who is also an employee sees their schedule, with a link to /admin (AM2).
  const home =
    gate(auth) ?? (profile?.isAdmin && !profile.employee ? <Navigate to="/admin" replace /> : <SchedulePage />);

  // Everyone else goes back to their own schedule. The admin layout has its own loading
  // boundary: navigations run as transitions, which would otherwise keep showing the
  // previous (possibly blank) screen until the admin download finishes.
  const admin =
    gate(auth) ??
    (profile?.isAdmin ? (
      <Suspense fallback={<AppLoading />}>
        <AdminLayout />
      </Suspense>
    ) : (
      <Navigate to="/" replace />
    ));

  return (
    <div className="app-frame">
      <Suspense fallback={<AppLoading />}>
        <Routes>
          <Route path="/login" element={auth.status === "signed-out" ? <LoginPage /> : <Navigate to="/" replace />} />
          <Route path="/" element={home} />
          <Route path="/admin" element={admin}>
            <Route index element={<AdminSchedulePage />} />
            <Route path="payroll" element={<PayrollPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}

import { Navigate, Route, Routes } from "react-router";
import { Spinner } from "./components/Spinner";
import { LoginPage } from "./features/auth/LoginPage";
import { NoAccess } from "./features/auth/NoAccess";
import { ProfileError } from "./features/auth/ProfileError";
import { SchedulePage } from "./features/schedule/SchedulePage";
import { useAuth } from "./lib/auth";

export default function App() {
  const auth = useAuth();

  if (auth.status === "loading") {
    return (
      <div className="app-loading">
        <Spinner size="lg" label="Loading..." showLabel />
      </div>
    );
  }

  const home =
    auth.status === "signed-out" ? (
      <Navigate to="/login" replace />
    ) : auth.status === "no-access" ? (
      <NoAccess />
    ) : auth.status === "error" ? (
      <ProfileError onRetry={auth.retry} />
    ) : (
      <SchedulePage />
    );

  return (
    <div className="app-frame">
      <Routes>
        <Route path="/login" element={auth.status === "signed-out" ? <LoginPage /> : <Navigate to="/" replace />} />
        <Route path="/" element={home} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

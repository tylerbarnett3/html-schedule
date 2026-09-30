import { Outlet } from "react-router";
import { AppHeader } from "../../app/AppHeader";
import { AdminToolbar } from "./AdminToolbar";
import { AdminViewProvider } from "./AdminViewProvider";
import { UndoProvider } from "./undo/UndoProvider";
import "./AdminLayout.css";

/**
 * Shell for /admin and /admin/payroll. The view state and the undo history sit above the
 * routes, so they survive switching between the two (both go on reload or sign-out).
 */
export function AdminLayout() {
  return (
    <AdminViewProvider>
      <UndoProvider>
        <AppHeader />
        <AdminToolbar />
        <Outlet />
      </UndoProvider>
    </AdminViewProvider>
  );
}

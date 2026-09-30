// The admin screens as one module, so App.tsx can load them on demand in a single chunk
// and employees never download them.
export { AdminLayout } from "./AdminLayout";
export { AdminSchedulePage } from "./schedule/AdminSchedulePage";
export { PayrollPage } from "./payroll/PayrollPage";

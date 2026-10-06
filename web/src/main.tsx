import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
// Tokens, the theme's palette (the class on <html> names it), the color roles built on it and
// the base styles load before any component CSS.
import "./styles/tokens.css";
import "./styles/themes/earth.css";
import "./styles/roles.css";
import "./styles/base.css";
import App from "./App";
import { AppCrash } from "./app/AppCrash";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { ToastProvider } from "./components/Toast";
import { queryClient } from "./data/queryClient";
import { AuthProvider } from "./lib/AuthProvider";

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing the #root element.");

// A data router (not <BrowserRouter>) so Payroll can use useBlocker to guard unsaved work.
// App keeps its own <Routes> under this one catch-all route.
const router = createBrowserRouter([{ path: "*", element: <App />, errorElement: <AppCrash /> }]);

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);

import { useEffect, useId, useRef } from "react";
import { Button } from "../components/Button";
import "../features/auth/AuthPage.css";

/**
 * The router's error screen: shown when a page throws, or when the admin screens' code
 * can't be downloaded (offline, or a new deploy removed the old files). React caches the
 * failed download, so only a full reload can retry.
 */
export function AppCrash() {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <div className="app-frame">
      <main className="auth-main">
        <section className="auth-card" aria-labelledby={titleId}>
          <h2 id={titleId} ref={titleRef} className="auth-title" tabIndex={-1}>
            This page couldn't load
          </h2>
          <p className="auth-message">Check your connection, then reload the page.</p>
          <div className="auth-actions">
            <Button variant="primary" className="auth-submit" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}

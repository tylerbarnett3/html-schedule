import { useEffect, useId, useRef } from "react";
import { AppHeader } from "../../app/AppHeader";
import { useSignOut } from "../../app/useSignOut";
import { Button } from "../../components/Button";
import "./AuthPage.css";

/** Shown to a login that is neither an admin nor linked to an employee (decision 18). */
export function NoAccess() {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { signingOut, signOut } = useSignOut();

  // The page replaced whatever had focus; start keyboard and screen reader users here.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <>
      <AppHeader />
      <main className="auth-main">
        <section className="auth-card" aria-labelledby={titleId}>
          <h2 id={titleId} ref={titleRef} className="auth-title" tabIndex={-1}>
            No schedule access
          </h2>
          <p className="auth-message">This login isn't linked to an employee. Ask your manager.</p>
          <Button variant="primary" className="auth-submit" onClick={signOut} disabled={signingOut}>
            Sign out
          </Button>
        </section>
      </main>
    </>
  );
}

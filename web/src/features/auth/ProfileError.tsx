import { useEffect, useId, useRef } from "react";
import { AppHeader } from "../../app/AppHeader";
import { useSignOut } from "../../app/useSignOut";
import { Button } from "../../components/Button";
import "./AuthPage.css";

export interface ProfileErrorProps {
  onRetry(): void;
}

/** Signed in, but loading the login's employee record failed (e.g. offline). */
export function ProfileError({ onRetry }: ProfileErrorProps) {
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
            Unable to load your account
          </h2>
          <p className="auth-message">Check your connection and try again.</p>
          <div className="auth-actions">
            <Button variant="primary" className="auth-submit" onClick={onRetry}>
              Retry
            </Button>
            <Button variant="secondary" className="auth-submit" onClick={signOut} disabled={signingOut}>
              Sign out
            </Button>
          </div>
        </section>
      </main>
    </>
  );
}

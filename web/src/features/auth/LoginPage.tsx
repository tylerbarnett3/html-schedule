import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "../../app/AppHeader";
import { Button } from "../../components/Button";
import { Spinner } from "../../components/Spinner";
import { signIn } from "../../lib/auth";
import "./AuthPage.css";

export function LoginPage() {
  const id = useId();
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const errorId = `${id}-error`;

  // Arriving here (first visit or after Sign out) leaves focus on the page body; the
  // username is the only thing to do on this page.
  useEffect(() => {
    usernameRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      (username.trim() ? passwordRef : usernameRef).current?.focus();
      return;
    }

    setError(null);
    setSubmitting(true);
    let message: string | null;
    try {
      message = await signIn(username, password);
    } catch {
      message = "Couldn't sign in. Check your connection and try again.";
    }
    // On success this page is replaced once the profile loads, so keep showing "Signing in".
    if (message) {
      setError(message);
      setSubmitting(false);
      passwordRef.current?.select();
    }
  };

  return (
    <>
      <AppHeader />
      <main className="auth-main">
        <form className="auth-card" onSubmit={(event) => void handleSubmit(event)} noValidate aria-labelledby={`${id}-title`}>
          <h2 id={`${id}-title`} className="auth-title">
            Sign in
          </h2>

          <div className="auth-field">
            <label className="auth-label" htmlFor={`${id}-username`}>
              Username
            </label>
            <input
              ref={usernameRef}
              id={`${id}-username`}
              className="auth-input"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor={`${id}-password`}>
              Password
            </label>
            <div className="auth-password">
              <input
                ref={passwordRef}
                id={`${id}-password`}
                className="auth-input auth-input-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              />
              <button
                type="button"
                className="auth-reveal"
                aria-controls={`${id}-password`}
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((shown) => !shown)}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {error ? (
            <p id={errorId} className="auth-error" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" className="auth-submit" disabled={submitting}>
            {submitting ? (
              <>
                <Spinner size="sm" decorative className="auth-submit-spinner" />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </Button>

          <p className="auth-help">Ask your manager if you don't have a login.</p>
        </form>
      </main>
    </>
  );
}

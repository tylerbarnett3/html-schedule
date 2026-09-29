import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/** Without a validator, stored data must at least have the same shape as the initial value. */
function sameShape(value: unknown, initial: unknown): boolean {
  if (Array.isArray(initial)) return Array.isArray(value);
  if (initial === null) return true;
  if (typeof initial === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return typeof value === typeof initial;
}

function read<T>(key: string, initial: T, isValid?: (value: unknown) => value is T): T {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return initial;
    const value: unknown = JSON.parse(stored);
    if (isValid ? isValid(value) : sameShape(value, initial)) return value as T;
  } catch {
    // Storage can be unavailable (private browsing, blocked cookies) or hold bad JSON.
  }
  return initial;
}

/**
 * useState that survives reloads by saving JSON to localStorage under `key`. Missing,
 * unreadable or invalid data falls back to `initial`. Pass `isValid` to check stored
 * values more strictly than "same shape as initial".
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  isValid?: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => read(key, initial, isValid));
  const [loadedKey, setLoadedKey] = useState(key);

  if (loadedKey !== key) {
    setLoadedKey(key);
    setValue(read(key, initial, isValid));
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Out of quota or storage disabled: keep working with in-memory state.
    }
  }, [key, value]);

  return [value, setValue];
}

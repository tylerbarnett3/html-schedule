import { useEffect, useState } from "react";
import { todayInZone } from "../lib/dates";
import type { ISODate } from "../lib/types";

/**
 * Today's date in the business's time zone. Rechecks every minute and when the tab comes
 * back into view, so a page left open overnight moves on to the new day.
 */
export function useBusinessToday(): ISODate {
  const [today, setToday] = useState<ISODate>(() => todayInZone());

  useEffect(() => {
    // Setting the same string again doesn't re-render.
    const update = () => setToday(todayInZone());
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") update();
    };
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return today;
}

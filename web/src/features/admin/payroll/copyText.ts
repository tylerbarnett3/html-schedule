/**
 * Puts text on the clipboard. Falls back to a hidden textarea and execCommand("copy") where
 * the Clipboard API is missing or refused (older Safari, some embedded browsers). Throws
 * when neither works.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Try the fallback below.
    }
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  focused?.focus();
  if (!copied) throw new Error("Clipboard unavailable");
}

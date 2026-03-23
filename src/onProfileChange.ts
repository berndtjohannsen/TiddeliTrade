/**
 * Callback when IG profile (demo/live) is switched. Used to clear session.
 */
let listener: (() => void) | null = null;

export function setOnProfileChangeListener(fn: () => void): void {
  listener = fn;
}

export function notifyProfileChange(): void {
  if (listener) listener();
}

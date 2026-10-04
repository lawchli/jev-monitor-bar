export function recordCleanupFailure(current: string | undefined, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`jev-monitor: session cleanup failed: ${message}`);
  return current ? `${current}; ${message}` : message;
}

export function armQuit(
  event: {preventDefault(): void},
  closing: {current: boolean; pending?: boolean},
  closeServer: (() => Promise<void>) | undefined,
  quit: () => void,
  onCleanupError?: (error: unknown) => void,
) {
  if (closing.current) {
    if (closing.pending) event.preventDefault();
    return;
  }
  if (!closeServer) return;
  event.preventDefault();
  closing.current = true;
  closing.pending = true;
  let cleanup: Promise<void>;
  try {
    cleanup = closeServer();
  } catch (error) {
    cleanup = Promise.reject(error);
  }
  void cleanup
    .catch(error => {
      try {
        onCleanupError?.(error);
      } catch (callbackError) {
        console.warn(
          `jev-monitor: session cleanup reporter failed: ${
            callbackError instanceof Error ? callbackError.message : String(callbackError)
          }`,
        );
      }
    })
    .finally(() => {
      // The intentional quit emits before-quit again; allow it only after cleanup settles.
      closing.pending = false;
      quit();
    });
}

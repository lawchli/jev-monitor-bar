export function recordCleanupFailure(current: string | undefined, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`jev-monitor: session cleanup failed: ${message}`);
  return current ? `${current}; ${message}` : message;
}

export function armQuit(
  event: {preventDefault(): void},
  closing: {current: boolean},
  closeServer: (() => Promise<void>) | undefined,
  quit: () => void,
  onCleanupError?: (error: unknown) => void,
) {
  if (closing.current || !closeServer) return;
  event.preventDefault();
  closing.current = true;
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
    .finally(quit);
}

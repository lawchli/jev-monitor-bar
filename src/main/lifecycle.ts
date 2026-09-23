export function armQuit(
  event: {preventDefault(): void},
  closing: {current: boolean},
  closeServer: (() => Promise<void>) | undefined,
  quit: () => void,
) {
  if (closing.current || !closeServer) return;
  event.preventDefault();
  closing.current = true;
  void closeServer().finally(quit);
}

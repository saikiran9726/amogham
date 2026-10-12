export function useRegisterSW(options?: {
  onRegistered?: (r: unknown) => void;
  onRegisterError?: (error: unknown) => void;
}) {
  return {
    needRefresh: [false, () => {}] as [boolean, (val: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (val: boolean) => void],
    updateServiceWorker: async () => {},
  };
}

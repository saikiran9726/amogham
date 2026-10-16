import { create } from 'zustand';
import type { UserProfile } from '@restaurant-os/shared';

import { API_BASE_URL } from '../config/api-base.js';

interface AuthState {
  user: UserProfile | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isSessionExpiredModalOpen: boolean;

  // Actions
  setSession: (user: UserProfile, accessToken: string) => void;
  clearSession: () => void;
  setSessionExpiredModalOpen: (open: boolean) => void;
  initSession: () => Promise<boolean>;
  login: (credentials: {
    username: string;
    credentialType: 'password' | 'pin';
    password?: string;
    pin?: string;
    deviceLabel?: string;
  }) => Promise<UserProfile>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
}

// Shared cross-tab and in-flight refresh coordination
let inFlightRefreshPromise: Promise<boolean> | null = null;
let lastRefreshedAt = 0;

const authChannel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('restaurant_os_auth_sync')
    : null;

if (authChannel) {
  authChannel.onmessage = (event) => {
    if (event.data?.type === 'AUTH_REFRESHED' && event.data.user && event.data.accessToken) {
      lastRefreshedAt = event.data.timestamp || Date.now();
      useAuthStore.getState().setSession(event.data.user, event.data.accessToken);
    } else if (event.data?.type === 'AUTH_LOGOUT') {
      useAuthStore.getState().clearSession();
    }
  };
}

async function doRefreshHttp(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!res.ok) {
      return false;
    }

    const data = await res.json();
    useAuthStore.getState().setSession(data.user, data.accessToken);
    lastRefreshedAt = Date.now();

    if (authChannel) {
      authChannel.postMessage({
        type: 'AUTH_REFRESHED',
        user: data.user,
        accessToken: data.accessToken,
        timestamp: lastRefreshedAt,
      });
    }

    return true;
  } catch {
    return false;
  }
}

export async function requestExclusiveRefresh(): Promise<boolean> {
  if (inFlightRefreshPromise) {
    return inFlightRefreshPromise;
  }

  inFlightRefreshPromise = (async () => {
    try {
      // 1. Cross-tab lock if supported
      if (
        typeof navigator !== 'undefined' &&
        'locks' in navigator &&
        navigator.locks &&
        typeof navigator.locks.request === 'function'
      ) {
        return await navigator.locks.request('restaurant_os_auth_refresh', async () => {
          // If another tab refreshed within the last 3 seconds, reuse existing refreshed state
          if (Date.now() - lastRefreshedAt < 3000 && useAuthStore.getState().accessToken) {
            return true;
          }
          return await doRefreshHttp();
        });
      }

      // 2. Fallback: single-tab HTTP refresh (broadcasts to peers via BroadcastChannel)
      return await doRefreshHttp();
    } finally {
      inFlightRefreshPromise = null;
    }
  })();

  return inFlightRefreshPromise;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  isAuthenticated: false,
  isLoading: true,
  isSessionExpiredModalOpen: false,

  setSession: (user, accessToken) => {
    set({
      user,
      accessToken,
      isAuthenticated: true,
      isLoading: false,
      isSessionExpiredModalOpen: false,
    });
  },

  clearSession: () => {
    set({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,
    });
  },

  setSessionExpiredModalOpen: (open) => {
    set({ isSessionExpiredModalOpen: open });
  },

  initSession: async () => {
    set({ isLoading: true });
    try {
      const refreshed = await get().refresh();
      return refreshed;
    } catch {
      get().clearSession();
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  login: async (credentials) => {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(credentials),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error?.message || 'Failed to authenticate');
    }

    get().setSession(data.user, data.accessToken);
    return data.user;
  },

  logout: async () => {
    try {
      await fetch(`${API_BASE_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Ignore network errors on logout
    } finally {
      get().clearSession();
      // Purge customer PII and receipt data on logout
      try {
        const { purgeCustomerPiiAndReceipts } = await import('../db/dexie.js');
        await purgeCustomerPiiAndReceipts({ purgeAll: true });
      } catch (err) {
        console.warn('Failed to purge customer PII on logout:', err);
      }
      if (authChannel) {
        authChannel.postMessage({ type: 'AUTH_LOGOUT' });
      }
    }
  },

  refresh: async () => {
    return await requestExclusiveRefresh();
  },
}));

if (
  typeof window !== 'undefined' &&
  (import.meta.env.DEV || (import.meta.env as unknown as { VITE_E2E?: string }).VITE_E2E === 'true')
) {
  (window as unknown as { __AUTH_STORE__?: typeof useAuthStore }).__AUTH_STORE__ = useAuthStore;
}

// Re-export unified apiFetch and ApiError for backwards-compatibility
export { apiFetch, ApiError, type ApiFetchOptions } from '../api/client.js';

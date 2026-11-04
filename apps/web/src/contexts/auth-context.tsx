import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Role } from '@shipline/shared';
import { useMe } from '@/services/auth/auth.hooks';
import { AuthService } from '@/services/auth/auth.service';
import { CurrentUser } from '@/services/auth/auth.types';

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  isAuthenticated: boolean;
  setToken: (token: string) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  rolesIn: (projectId: string) => Role[];
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [hasToken, setHasToken] = useState(() => !!localStorage.getItem('auth_token'));
  const me = useMe(hasToken);

  const setToken = useCallback((token: string) => {
    localStorage.setItem('auth_token', token);
    setHasToken(true);
  }, []);

  const logout = useCallback(async () => {
    await AuthService.logout().catch(() => undefined);
    localStorage.removeItem('auth_token');
    setHasToken(false);
    qc.clear();
  }, [qc]);

  const refreshUser = useCallback(async () => {
    await me.refetch();
  }, [me]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: hasToken ? (me.data ?? null) : null,
      loading: hasToken && me.isPending,
      isAuthenticated: hasToken && !!me.data,
      setToken,
      logout,
      refreshUser,
      rolesIn: (projectId) => me.data?.memberships.find((m) => m.projectId === projectId)?.roles ?? [],
    }),
    [hasToken, me.data, me.isPending, setToken, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

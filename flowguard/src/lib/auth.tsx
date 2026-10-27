import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface SessionUser {
  id: string;
  loginId: string;
  fullName: string;
  email: string;
  designation: string | null;
  roles: string[];
  activeRole: string;
}
type Workspace = 'INSTITUTION' | 'OFFICIAL' | 'GOVERNANCE';

interface AuthState {
  user: SessionUser | null;
  workspace: Workspace | null;
  ready: boolean;
  login: (loginId: string, password: string) => Promise<Workspace>;
  logout: () => Promise<void>;
  switchRole: (role: string) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api
      .get('/api/auth/me')
      .then((r) => {
        setUser(r.user);
        setWorkspace(r.workspace);
      })
      .catch(() => undefined)
      .finally(() => setReady(true));
    const onUnauth = () => {
      setUser(null);
      setWorkspace(null);
    };
    window.addEventListener('fg:unauthenticated', onUnauth);
    return () => window.removeEventListener('fg:unauthenticated', onUnauth);
  }, []);

  const login = useCallback(async (loginId: string, password: string) => {
    const r = await api.post('/api/auth/login', { loginId, password });
    setUser(r.user);
    setWorkspace(r.workspace);
    return r.workspace as Workspace;
  }, []);
  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setUser(null);
    setWorkspace(null);
  }, []);
  const switchRole = useCallback(async (role: string) => {
    const r = await api.post('/api/auth/switch-role', { role });
    setUser(r.user);
    setWorkspace(r.workspace);
  }, []);

  return <Ctx.Provider value={{ user, workspace, ready, login, logout, switchRole }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

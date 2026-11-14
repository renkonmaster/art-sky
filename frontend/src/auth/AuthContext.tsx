import type { Me } from "@art-sky/api";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { callApi } from "../api/client.ts";

interface AuthState {
  /** 最初の確認が終わるまで true。 */
  loading: boolean;
  /** ログインしていなければ null。 */
  user: Me | null;
  /** ログイン状態を取り直す。登録や設定変更のあとに呼ぶ。 */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<Me | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUser((await callApi("getMe")).user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    // ログアウトは JSON を返さない API なので、直接呼ぶ（docs/api.md の「認証」）。
    await fetch("/oauth/logout", { method: "POST", credentials: "same-origin" });
    setUser(null);
  }, []);

  const value = useMemo(() => ({ loading, user, refresh, logout }), [loading, user, refresh, logout]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider の外で useAuth を呼んでいます");
  return value;
}

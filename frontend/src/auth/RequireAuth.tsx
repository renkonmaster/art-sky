import type { Me } from "@art-sky/api";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { Loading } from "../components/States.tsx";
import { useAuth } from "./AuthContext.tsx";

interface Props {
  /** true なら、初回登録が済んでいない人を登録画面へ送る。 */
  registered?: boolean;
  children: (user: Me) => ReactNode;
}

/** ログインが必要な画面を囲む。未ログインならログイン画面へ送り、ログイン後に元の画面へ戻す。 */
export function RequireAuth({ registered = false, children }: Props) {
  const { loading, user } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (registered && !user.registered) return <Navigate to="/register" replace />;
  return <>{children(user)}</>;
}

import { Link, NavLink, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthContext.tsx";
import { Avatar } from "./components/Avatar.tsx";
import { ActorPage } from "./pages/ActorPage.tsx";
import { ArtworkPage } from "./pages/ArtworkPage.tsx";
import { GalleryPage } from "./pages/GalleryPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { ManagePage } from "./pages/ManagePage.tsx";
import { RegisterPage } from "./pages/RegisterPage.tsx";

export function App() {
  return (
    <AuthProvider>
      <Header />
      <main className="site-main">
        <Routes>
          <Route path="/" element={<GalleryPage />} />
          <Route path="/u/:actor" element={<ActorPage />} />
          <Route path="/u/:did/:rkey" element={<ArtworkPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/manage" element={<ManagePage />} />
          <Route path="*" element={<p className="state">ページが見つかりません。</p>} />
        </Routes>
      </main>
    </AuthProvider>
  );
}

function Header() {
  const { loading, user } = useAuth();
  return (
    <header className="site-header">
      <Link className="site-title" to="/">
        art-sky
      </Link>
      <nav className="site-nav" aria-label="メニュー">
        <NavLink to="/" end>
          ギャラリー
        </NavLink>
        {user?.registered ? (
          <>
            <NavLink to={`/u/${encodeURIComponent(user.handle)}`}>自分の作品</NavLink>
            <NavLink to="/manage">管理</NavLink>
          </>
        ) : null}
        {user && !user.registered ? <NavLink to="/register">はじめる</NavLink> : null}
      </nav>
      <div className="site-account">
        {loading ? null : user ? (
          <Link className="account" to={user.registered ? "/manage" : "/register"} title={`@${user.handle}`}>
            <Avatar author={user} size={28} />
            <span className="account-name">@{user.handle}</span>
          </Link>
        ) : (
          <Link className="button primary" to="/login">
            ログイン
          </Link>
        )}
      </div>
    </header>
  );
}

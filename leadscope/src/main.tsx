import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./lib/api";
import Login from "./pages/Login";
import NewSearch from "./pages/NewSearch";
import Results from "./pages/Results";
import LeadCard from "./pages/LeadCard";
import Settings from "./pages/Settings";
import "./styles.css";

function App() {
  const [session, setSession] = useState<{ email: string } | null | undefined>(undefined);
  useEffect(() => { api.session().then(setSession); }, []);
  if (session === undefined) return <p className="container">Ładowanie…</p>;
  if (!session) return <Login onLoggedIn={() => api.session().then(setSession)} />;
  return (
    <>
      <header className="topbar no-print">
        <Link to="/" className="brand">LeadScope</Link>
        <nav>
          <Link to="/">Nowe wyszukiwanie</Link>
          <Link to="/settings">Ustawienia i koszty</Link>
          <button className="link" onClick={async () => { await api.signOut(); setSession(null); }}>Wyloguj ({session.email})</button>
        </nav>
      </header>
      {api.mode === "mock" && <div className="demo-banner no-print">TRYB DEMO — dane fikcyjne, bez połączenia z Supabase i zewnętrznymi API.</div>}
      <main className="container">
        <Routes>
          <Route path="/" element={<NewSearch />} />
          <Route path="/results/:searchId" element={<Results />} />
          <Route path="/lead/:leadId" element={<LeadCard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter><App /></BrowserRouter>
  </StrictMode>,
);

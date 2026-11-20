import { useState } from "react";
import { api } from "../lib/api";

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(kind: "in" | "up") {
    setError(null);
    try {
      if (kind === "in") { await api.signIn(email, password); onLoggedIn(); }
      else { await api.signUp(email, password); setInfo("Konto utworzone. Jeśli wymagane jest potwierdzenie e-mail — sprawdź skrzynkę, potem zaloguj się."); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <main className="container narrow">
      <h1>LeadScope</h1>
      <p>Zaloguj się, aby wyszukiwać firmy, które mogą kupić Twój produkt.</p>
      <label>E-mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Hasło<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <div className="row">
        <button onClick={() => submit("in")}>Zaloguj</button>
        <button className="secondary" onClick={() => submit("up")}>Załóż konto</button>
      </div>
      {error && <p className="error">{error}</p>}
      {info && <p className="info">{info}</p>}
    </main>
  );
}

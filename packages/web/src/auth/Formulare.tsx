// Anmeldung (lokales Konto) und Ersteinrichtung mit dem Einrichtungs-Token aus dem Server-Log.
import { useMutation, useQuery } from '@tanstack/react-query';
import { PROJEKTWAHL_PFAD_PRAEFIX } from '@seatmeter/shared';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ApiFehler, useApi } from '../api/client';
import { authAnbieterSchema } from '../api/typen';

export const PASSWORT_MINDESTLAENGE = 12;

export function Rahmen({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-slate-50 p-4 md:items-center">
      <section className="w-full max-w-sm rounded border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-lg font-bold">seatmeter</p>
        <h1 className="mt-2 text-xl font-semibold">{titel}</h1>
        {children}
      </section>
    </main>
  );
}

export function Feld({
  name,
  beschriftung,
  typ = 'text',
  wert,
  onAendern,
  autocomplete,
  hilfe,
  nurLesen,
}: {
  name: string;
  beschriftung: string;
  typ?: string;
  wert: string;
  onAendern: (wert: string) => void;
  autocomplete?: string;
  hilfe?: string;
  nurLesen?: boolean;
}) {
  const id = useId();
  return (
    <div className="mt-4">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {beschriftung}
      </label>
      <input
        id={id}
        name={name}
        type={typ}
        value={wert}
        required
        readOnly={nurLesen}
        autoComplete={autocomplete}
        aria-describedby={hilfe ? `${id}-hilfe` : undefined}
        onChange={(e) => onAendern(e.target.value)}
        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
      />
      {hilfe && (
        <p id={`${id}-hilfe`} className="mt-1 text-xs text-slate-500">
          {hilfe}
        </p>
      )}
    </div>
  );
}

export function Meldung({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
      {text}
    </p>
  );
}

function fehlerBeiAnmeldung(fehler: unknown): string {
  if (fehler instanceof ApiFehler) {
    if (fehler.status === 401) return 'Login oder Passwort ist falsch.';
    if (fehler.status === 429) return 'Zu viele Versuche. Bitte später erneut versuchen.';
    if (fehler.art === 'netz') return 'Der Server ist nicht erreichbar.';
  }
  return 'Die Anmeldung ist fehlgeschlagen.';
}

function fehlerBeiEinrichtung(fehler: unknown): string {
  if (fehler instanceof ApiFehler) {
    if (fehler.status === 401 || fehler.status === 403)
      return 'Das Einrichtungs-Token ist ungültig oder abgelaufen.';
    if (fehler.status === 409) return 'Die Einrichtung ist bereits abgeschlossen.';
    if (fehler.status === 400) return `Eingaben ungültig: ${fehler.message}`;
    if (fehler.art === 'netz') return 'Der Server ist nicht erreichbar.';
  }
  return 'Die Einrichtung ist fehlgeschlagen.';
}

export const knopf =
  'mt-6 w-full rounded bg-slate-900 px-3 py-2 font-medium text-white hover:bg-slate-700 disabled:opacity-50';

/** Nach der SSO-Anmeldung zurück zur Projektwahl (Link des Hooks); sonst wie bisher zur Startseite. */
export function ssoStart(start: string, pfad: string): string {
  if (!pfad.startsWith(PROJEKTWAHL_PFAD_PRAEFIX)) return start;
  return `${start}${start.includes('?') ? '&' : '?'}ziel=${encodeURIComponent(pfad)}`;
}

/** Knöpfe der Plugin-Anbieter (ee: „Mit weeberwrk SSO anmelden“) aus `GET /api/v1/auth/anbieter`. */
function SsoKnoepfe() {
  const api = useApi();
  const { pathname } = useLocation();
  const anbieter = useQuery({
    queryKey: ['auth', 'anbieter'],
    retry: false,
    queryFn: () => api.get('/api/v1/auth/anbieter', authAnbieterSchema),
  });
  const sso = (anbieter.data?.anbieter ?? []).filter((a) => a.start !== null);
  if (sso.length === 0) return null;
  return (
    <div className="mt-4 space-y-2">
      {sso.map((a) => (
        <a
          key={a.name}
          href={a.start ? ssoStart(a.start, pathname) : '#'}
          className="block w-full rounded border border-slate-900 px-3 py-2 text-center font-medium hover:bg-slate-100"
        >
          {a.titel}
        </a>
      ))}
      <p className="pt-2 text-center text-xs text-slate-500">oder mit lokalem Konto</p>
    </div>
  );
}

const linkKnopf = 'mt-4 block text-sm text-slate-600 underline hover:text-slate-900';

type OidcTreffer = { bezeichnung: string; start_url: string };
type Schritt = 'eingabe' | 'oidc' | 'passwort' | 'kuerzel';

const TEXT_ZU_VIELE = 'Zu viele Versuche. Bitte später erneut versuchen.';
const TEXT_KEIN_KUERZEL = 'Für dieses Kürzel ist keine SSO-Anmeldung eingerichtet.';

/**
 * Anmeldung, E-Mail zuerst: Eine E-Mail-Adresse wird gegen die verifizierten Domains der Mandanten
 * geprüft (`GET /auth/anbieter?email=`); gibt es SSO, führt der Weg dorthin, sonst zum Passwort. Reine
 * Logins (ohne „@“) und Server ohne SSO je Mandant gehen direkt zum Passwort. Die Texte verraten
 * nie, ob ein Konto existiert.
 */
export function Anmeldung({ onErfolg }: { onErfolg: () => void }) {
  const api = useApi();
  const { pathname } = useLocation();
  const [schritt, setSchritt] = useState<Schritt>('eingabe');
  const [login, setLogin] = useState('');
  const [passwort, setPasswort] = useState('');
  const [kuerzel, setKuerzel] = useState('');
  const [oidc, setOidc] = useState<OidcTreffer | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);

  const anmelden = useMutation({
    mutationFn: () => api.post('/api/v1/auth/login', { login, passwort }),
    onSuccess: onErfolg,
  });

  const nachEmail = useMutation({
    mutationFn: (eingabe: string) =>
      api.get(`/api/v1/auth/anbieter?email=${encodeURIComponent(eingabe)}`, authAnbieterSchema),
    onSuccess: (antwort) => {
      setHinweis(null);
      if (antwort.oidc) {
        setOidc(antwort.oidc);
        setSchritt('oidc');
      } else setSchritt('passwort');
    },
    onError: (fehler) => {
      if (fehler instanceof ApiFehler && fehler.status === 429) setHinweis(TEXT_ZU_VIELE);
      else {
        // Alter Server oder Netzfehler: wie bisher mit Passwort weiter.
        setHinweis(null);
        setSchritt('passwort');
      }
    },
  });

  const nachKuerzel = useMutation({
    mutationFn: (slug: string) =>
      api.get(`/api/v1/auth/anbieter?mandant=${encodeURIComponent(slug)}`, authAnbieterSchema),
    onSuccess: (antwort) => {
      if (antwort.oidc) {
        setOidc(antwort.oidc);
        setHinweis(null);
        setSchritt('oidc');
      } else setHinweis(TEXT_KEIN_KUERZEL);
    },
    onError: (fehler) =>
      setHinweis(
        fehler instanceof ApiFehler && fehler.status === 429 ? TEXT_ZU_VIELE : TEXT_KEIN_KUERZEL,
      ),
  });

  const weiter = (e: FormEvent) => {
    e.preventDefault();
    const eingabe = login.trim();
    if (!eingabe) return;
    setLogin(eingabe);
    setHinweis(null);
    if (eingabe.includes('@')) nachEmail.mutate(eingabe);
    else setSchritt('passwort');
  };

  const zurueck = () => {
    setSchritt('eingabe');
    setPasswort('');
    setHinweis(null);
    setOidc(null);
  };

  if (schritt === 'oidc' && oidc) {
    return (
      <Rahmen titel="Anmelden">
        <a
          href={ssoStart(oidc.start_url, pathname)}
          className="mt-6 block w-full rounded bg-slate-900 px-3 py-2 text-center font-medium text-white hover:bg-slate-700"
        >
          Weiter zu {oidc.bezeichnung}
        </a>
        <button type="button" className={linkKnopf} onClick={() => setSchritt('passwort')}>
          Stattdessen mit Passwort anmelden
        </button>
        <button type="button" className={linkKnopf} onClick={zurueck}>
          Zurück
        </button>
      </Rahmen>
    );
  }

  if (schritt === 'kuerzel') {
    return (
      <Rahmen titel="Anmelden">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (kuerzel.trim()) nachKuerzel.mutate(kuerzel.trim());
          }}
        >
          <Feld
            name="kuerzel"
            beschriftung="Mandanten-Kürzel"
            wert={kuerzel}
            onAendern={setKuerzel}
            autocomplete="organization"
          />
          <Meldung text={hinweis} />
          <button type="submit" className={knopf} disabled={nachKuerzel.isPending}>
            {nachKuerzel.isPending ? 'Prüfe …' : 'Weiter'}
          </button>
        </form>
        <button type="button" className={linkKnopf} onClick={zurueck}>
          Zurück
        </button>
      </Rahmen>
    );
  }

  if (schritt === 'passwort') {
    return (
      <Rahmen titel="Anmelden">
        <SsoKnoepfe />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            anmelden.mutate();
          }}
          noValidate
        >
          <Feld
            name="login"
            beschriftung="Login"
            wert={login}
            onAendern={setLogin}
            autocomplete="username"
            nurLesen
          />
          <Feld
            name="passwort"
            beschriftung="Passwort"
            typ="password"
            wert={passwort}
            onAendern={setPasswort}
            autocomplete="current-password"
          />
          <Meldung text={anmelden.isError ? fehlerBeiAnmeldung(anmelden.error) : null} />
          <button type="submit" className={knopf} disabled={anmelden.isPending}>
            {anmelden.isPending ? 'Melde an …' : 'Anmelden'}
          </button>
        </form>
        <button type="button" className={linkKnopf} onClick={zurueck}>
          Zurück
        </button>
      </Rahmen>
    );
  }

  return (
    <Rahmen titel="Anmelden">
      <form onSubmit={weiter} noValidate>
        <Feld
          name="login"
          beschriftung="E-Mail-Adresse oder Login"
          wert={login}
          onAendern={setLogin}
          autocomplete="username"
        />
        <Meldung text={hinweis} />
        <button type="submit" className={knopf} disabled={nachEmail.isPending}>
          {nachEmail.isPending ? 'Prüfe …' : 'Weiter'}
        </button>
      </form>
      <button
        type="button"
        className={linkKnopf}
        onClick={() => {
          setHinweis(null);
          setSchritt('kuerzel');
        }}
      >
        Anmeldung über Mandanten-Kürzel
      </button>
    </Rahmen>
  );
}

export function Einrichtung({ onErfolg }: { onErfolg: () => void }) {
  const api = useApi();
  const [token, setToken] = useState('');
  const [login, setLogin] = useState('');
  const [passwort, setPasswort] = useState('');
  const [wiederholung, setWiederholung] = useState('');
  const [pruefung, setPruefung] = useState<string | null>(null);
  const einrichten = useMutation({
    mutationFn: () => api.post('/api/v1/auth/setup', { token: token.trim(), login, passwort }),
    onSuccess: onErfolg,
  });

  const absenden = (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || !login.trim()) {
      setPruefung('Bitte Einrichtungs-Token und Login angeben.');
      return;
    }
    if (passwort.length < PASSWORT_MINDESTLAENGE) {
      setPruefung(`Das Passwort braucht mindestens ${PASSWORT_MINDESTLAENGE} Zeichen.`);
      return;
    }
    if (passwort !== wiederholung) {
      setPruefung('Die Passwörter stimmen nicht überein.');
      return;
    }
    setPruefung(null);
    einrichten.mutate();
  };

  return (
    <Rahmen titel="Ersteinrichtung">
      <p className="mt-2 text-sm text-slate-600">
        Lege das erste Administratorkonto an. Das Einrichtungs-Token steht beim ersten Start im
        Server-Log.
      </p>
      <form onSubmit={absenden} noValidate>
        <Feld
          name="token"
          beschriftung="Einrichtungs-Token"
          wert={token}
          onAendern={setToken}
          autocomplete="off"
        />
        <Feld
          name="login"
          beschriftung="Login"
          wert={login}
          onAendern={setLogin}
          autocomplete="username"
        />
        <Feld
          name="passwort"
          beschriftung="Passwort"
          typ="password"
          wert={passwort}
          onAendern={setPasswort}
          autocomplete="new-password"
          hilfe={`Mindestens ${PASSWORT_MINDESTLAENGE} Zeichen.`}
        />
        <Feld
          name="wiederholung"
          beschriftung="Passwort wiederholen"
          typ="password"
          wert={wiederholung}
          onAendern={setWiederholung}
          autocomplete="new-password"
        />
        <Meldung
          text={pruefung ?? (einrichten.isError ? fehlerBeiEinrichtung(einrichten.error) : null)}
        />
        <button type="submit" className={knopf} disabled={einrichten.isPending}>
          {einrichten.isPending ? 'Richte ein …' : 'Konto anlegen'}
        </button>
      </form>
    </Rahmen>
  );
}

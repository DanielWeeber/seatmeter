// Rahmen des Dashboards (Navigation nach Rollen, Architektur §2.4):
//   Kopfzeile: aktiver Mandant (Wechsel), Anmeldename · Rolle, Link „Plattform-Bereich“ nur für
//              Plattform-Admins, Abmelden.
//   Layout: Seitenleiste mit den Gruppen Auswertung (alle) und Einrichtung (Mandanten-Admin, Plattform-Admin).
//   PlattformLayout: eigener Bereich `/plattform` mit Unternavigation und Link zurück ins Dashboard.
// Die Sichtbarkeit kommt aus `/me`; der Server prüft jeden Zugriff selbst.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useSearchParams } from 'react-router';
import { NAV_GRUPPEN, type NavEintrag } from '@seatmeter/shared';
import { useApi } from './api/client';
import { authMeSchema } from './api/typen';
import { AnmeldeBanner, LizenzBanner, useAuth } from './auth/AuthTor';
import { istMonat, MONATS_SEITEN } from './monat';
import { gruppeSichtbar, navRechte, rollenText } from './navigation';

const SYSTEM: NavEintrag = { pfad: '/system', titel: 'Systemzustand', gruppe: 'auswertung' };

const knopf =
  'rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-50';

/** Mandantenwechsel über `POST /api/v1/auth/mandant`; danach laden alle Abfragen neu. */
function MandantWahl() {
  const { me } = useAuth();
  const api = useApi();
  const queryClient = useQueryClient();
  const wechseln = useMutation({
    mutationFn: (mandantId: string) =>
      api.post('/api/v1/auth/mandant', { mandant_id: mandantId }, authMeSchema),
    onSuccess: (neu) => {
      api.merkeCsrf(neu.csrf);
      void queryClient.invalidateQueries();
    },
  });
  if (!me) return null;
  if (me.mandanten.length < 2)
    return me.mandant ? (
      <span>
        Mandant <span className="font-medium text-slate-900">{me.mandant.name}</span>
      </span>
    ) : (
      <span>Kein Mandant</span>
    );
  return (
    <label className="flex items-center gap-2">
      Mandant
      <select
        aria-label="Aktiver Mandant"
        value={me.mandant_id ?? ''}
        disabled={wechseln.isPending}
        onChange={(e) => wechseln.mutate(e.target.value)}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900"
      >
        {!me.mandant_id && <option value="">– wählen –</option>}
        {me.mandanten.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {wechseln.isError && (
        <span role="alert" className="text-red-700">
          Wechsel fehlgeschlagen.
        </span>
      )}
    </label>
  );
}

function Kopfzeile({ bereich }: { bereich: 'dashboard' | 'plattform' }) {
  const { me, istPlattformAdmin, kannAbmelden, abmelden, abmeldenLaeuft } = useAuth();
  const rolle = me ? rollenText(me.rollen) : '';
  return (
    <header
      aria-label="Kopfzeile"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 text-sm text-slate-600"
    >
      <Link to="/" className="text-lg font-bold text-slate-900">
        seatmeter
      </Link>
      <MandantWahl />
      {me && (
        <div role="group" aria-label="Angemeldet als">
          <span className="font-medium text-slate-900">{me.benutzer.benutzername}</span>
          {rolle && <span> · {rolle}</span>}
          {istPlattformAdmin && ' '}
          {istPlattformAdmin && (
            <span className="ml-1 rounded bg-slate-900 px-1.5 py-0.5 text-xs text-white">
              Plattform
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 md:ml-auto">
        {bereich === 'dashboard' && istPlattformAdmin && (
          <Link to="/plattform" className={knopf}>
            Plattform-Bereich
          </Link>
        )}
        {bereich === 'plattform' && (
          <Link to="/" className={knopf}>
            Zurück zum Dashboard
          </Link>
        )}
        {kannAbmelden && (
          <button type="button" onClick={abmelden} disabled={abmeldenLaeuft} className={knopf}>
            Abmelden
          </button>
        )}
      </div>
    </header>
  );
}

function NavListe({
  id,
  titel,
  eintraege,
  ziel,
}: {
  id: string;
  titel: string;
  eintraege: NavEintrag[];
  ziel: (pfad: string) => string;
}) {
  return (
    <div className="mb-4">
      <p id={id} className="mb-1 px-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        {titel}
      </p>
      <ul aria-labelledby={id} className="flex flex-wrap gap-2 md:flex-col md:gap-1">
        {eintraege.map((e) => (
          <li key={e.pfad}>
            <NavLink
              to={ziel(e.pfad)}
              end={e.pfad === '/'}
              className={({ isActive }) =>
                `block rounded px-2 py-1 ${isActive ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`
              }
            >
              {e.titel}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Inhalt({ children }: { children: ReactNode }) {
  return (
    <main className="min-w-0 flex-1 p-4 md:p-8">
      <AnmeldeBanner />
      <LizenzBanner />
      {children}
    </main>
  );
}

/** Dashboard eines Mandanten: Seitenleiste mit den Gruppen, die die Rolle sehen darf. */
export function Layout({ eintraege }: { eintraege: NavEintrag[] }) {
  const { me } = useAuth();
  const rechte = navRechte(me);
  const [parameter] = useSearchParams();
  const monat = parameter.get('monat');
  const ziel = (pfad: string) =>
    istMonat(monat) && MONATS_SEITEN.includes(pfad) ? `${pfad}?monat=${monat}` : pfad;
  const gruppen = NAV_GRUPPEN.filter(
    (g) => g.gruppe !== 'plattform' && gruppeSichtbar(g.gruppe, rechte),
  )
    .map((g) => ({
      ...g,
      eintraege: [
        ...eintraege.filter((e) => e.gruppe === g.gruppe),
        ...(g.gruppe === 'auswertung' ? [SYSTEM] : []),
      ],
    }))
    .filter((g) => g.eintraege.length > 0);

  return (
    <div className="flex min-h-screen flex-col">
      <Kopfzeile bereich="dashboard" />
      <div className="flex flex-1 flex-col md:flex-row">
        <nav
          aria-label="Hauptnavigation"
          className="border-b border-slate-200 bg-white p-4 md:w-60 md:border-r md:border-b-0"
        >
          {gruppen.map((g) => (
            <NavListe
              key={g.gruppe}
              id={`nav-gruppe-${g.gruppe}`}
              titel={g.titel}
              eintraege={g.eintraege}
              ziel={ziel}
            />
          ))}
        </nav>
        <Inhalt>
          <Outlet />
        </Inhalt>
      </div>
    </div>
  );
}

/** Plattform-Bereich (`/plattform/…`, nur Plattform-Admin): eigene Unternavigation statt Seitenleiste. */
export function PlattformLayout({ eintraege }: { eintraege: NavEintrag[] }) {
  const { istPlattformAdmin } = useAuth();
  return (
    <div className="flex min-h-screen flex-col">
      <Kopfzeile bereich="plattform" />
      {istPlattformAdmin ? (
        <>
          <nav
            aria-label="Plattform-Navigation"
            className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2"
          >
            <span className="mr-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Plattform
            </span>
            {eintraege.map((e) => (
              <NavLink
                key={e.pfad}
                to={e.pfad}
                className={({ isActive }) =>
                  `rounded px-2 py-1 ${isActive ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`
                }
              >
                {e.titel}
              </NavLink>
            ))}
          </nav>
          <Inhalt>
            <Outlet />
          </Inhalt>
        </>
      ) : (
        <Inhalt>
          <h1 className="text-2xl font-semibold">Plattform</h1>
          <p className="mt-2 text-slate-700">
            Der Plattform-Bereich steht nur Plattform-Admins offen.{' '}
            <Link to="/" className="underline">
              Zurück zum Dashboard
            </Link>
          </p>
        </Inhalt>
      )}
    </div>
  );
}

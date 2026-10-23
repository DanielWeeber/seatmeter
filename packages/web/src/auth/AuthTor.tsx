// Anmelde-Tor um das Dashboard (Architektur §6):
//   200 auf /auth/me → Dashboard (auch Proxy-Header-Modus hinter Authelia, dann ohne Anmeldeseite);
//                       `csrf` aus der Antwort merkt sich der Client für POST/PUT/DELETE
//   401 → /auth/setup: noetig → Einrichtung, sonst Anmeldung
//   404 oder Netzfehler → Dashboard mit Hinweis „Anmeldung im Server noch nicht aktiv“
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { z } from 'zod';
import { ApiFehler, ME_PFAD, useApi } from '../api/client';
import { authMeSchema, setupStatusSchema, type AuthMe, type Rolle } from '../api/typen';
import { Fehlermeldung, Laden } from '../komponenten/Abfrage';
import { Einladung, EINLADUNG_PFAD } from './Einladung';
import { Anmeldung, Einrichtung } from './Formulare';

/** Rolle mit Schreibrecht auf Preise, Sitzkosten und Rechner (server: requireRolle('mandanten_admin')). */
export const ADMIN_ROLLE: Rolle = 'mandanten_admin';

export type AuthStand =
  { art: 'angemeldet'; me: AuthMe } | { art: 'nicht_angemeldet' } | { art: 'inaktiv' };

export interface AuthWert {
  /** `null`, solange das Auth-Modul im Server fehlt. */
  me: AuthMe | null;
  istAdmin: boolean;
  /** ee: Plattform-Admin (`plattform_admin` in `/me`); sieht Einrichtung und Plattform-Bereich. */
  istPlattformAdmin: boolean;
  /**
   * Verwaltung (Preise, Sitzkosten, Rechner) anzeigen: für Admins und solange das Auth-Modul fehlt
   * (dann schützt Authelia davor, und der Server entscheidet selbst).
   */
  darfVerwalten: boolean;
  /** Abmelden ist nur bei lokaler Anmeldung sinnvoll (beim Proxy-Header-Modus meldet der Proxy ab). */
  kannAbmelden: boolean;
  abmelden: () => void;
  abmeldenLaeuft: boolean;
}

const AuthKontext = createContext<AuthWert>({
  me: null,
  istAdmin: false,
  istPlattformAdmin: false,
  darfVerwalten: false,
  kannAbmelden: false,
  abmelden: () => undefined,
  abmeldenLaeuft: false,
});

export function useAuth(): AuthWert {
  return useContext(AuthKontext);
}

/** Warnhinweis der ee-Lizenz (Kulanzzeit, baldiger Ablauf, ungültig) aus `/me`. */
export function LizenzBanner() {
  const { me } = useAuth();
  const warnung = me?.ee?.warnung;
  if (!warnung) return null;
  return (
    <p
      role="alert"
      className="mb-4 rounded border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900"
    >
      {warnung}
    </p>
  );
}

export function AnmeldeBanner() {
  const { me } = useAuth();
  if (me) return null;
  return (
    <p
      role="status"
      className="mb-4 rounded border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-900"
    >
      Anmeldung im Server noch nicht aktiv.
    </p>
  );
}

export function AuthTor({ children }: { children: ReactNode }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { pathname } = useLocation();

  const stand = useQuery({
    queryKey: ['auth', 'me'],
    retry: false,
    queryFn: async (): Promise<AuthStand> => {
      try {
        const me = await api.get(ME_PFAD, authMeSchema);
        api.merkeCsrf(me.csrf);
        return { art: 'angemeldet', me };
      } catch (fehler) {
        if (fehler instanceof ApiFehler) {
          if (fehler.art === 'http' && fehler.status === 401) return { art: 'nicht_angemeldet' };
          if ((fehler.art === 'http' && fehler.status === 404) || fehler.art === 'netz')
            return { art: 'inaktiv' };
        }
        throw fehler;
      }
    },
  });

  const setup = useQuery({
    queryKey: ['auth', 'setup'],
    enabled: stand.data?.art === 'nicht_angemeldet',
    retry: false,
    queryFn: async () => {
      try {
        return await api.get('/api/v1/auth/setup', setupStatusSchema);
      } catch {
        // Ohne Auskunft über die Einrichtung gilt die normale Anmeldung.
        return { noetig: false };
      }
    },
  });

  const abmelden = useMutation({
    mutationFn: async () => {
      // OIDC (ee): eigene Abmeldung, danach ggf. zum Provider (end_session), sonst nur lokal.
      if (stand.data?.art === 'angemeldet' && stand.data.me.provider === 'oidc') {
        const { weiter } = await api.post(
          '/api/v1/auth/oidc/logout',
          {},
          z.object({ weiter: z.string().nullable() }),
        );
        if (weiter?.startsWith('http')) window.location.assign(weiter);
        return;
      }
      await api.post('/api/v1/auth/logout');
    },
    onSettled: () => queryClient.resetQueries(),
  });

  const angemeldetNeu = () => queryClient.invalidateQueries({ queryKey: ['auth'] });

  // Einladung annehmen: ohne Anmeldung erreichbar, bewusst vor der Anmeldeprüfung.
  const einladungToken = EINLADUNG_PFAD.exec(pathname)?.[1];
  if (einladungToken) return <Einladung key={einladungToken} token={einladungToken} />;

  if (stand.isPending) return <Laden text="Prüfe Anmeldung …" />;
  if (stand.isError)
    return (
      <main className="mx-auto max-w-md p-8">
        <Fehlermeldung fehler={stand.error} erneut={() => void stand.refetch()} />
      </main>
    );

  if (stand.data.art === 'nicht_angemeldet') {
    if (setup.isPending) return <Laden text="Prüfe Anmeldung …" />;
    return setup.data?.noetig ? (
      <Einrichtung onErfolg={angemeldetNeu} />
    ) : (
      <Anmeldung onErfolg={angemeldetNeu} />
    );
  }

  const me = stand.data.art === 'angemeldet' ? stand.data.me : null;
  const istAdmin = !!me && me.rollen.includes(ADMIN_ROLLE);
  const wert: AuthWert = {
    me,
    istAdmin,
    istPlattformAdmin: me?.plattform_admin === true,
    darfVerwalten: istAdmin || stand.data.art === 'inaktiv',
    kannAbmelden: !!me && (me.provider === 'lokal' || me.provider === 'oidc'),
    abmelden: () => abmelden.mutate(),
    abmeldenLaeuft: abmelden.isPending,
  };
  return <AuthKontext.Provider value={wert}>{children}</AuthKontext.Provider>;
}

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { istPlattformPfad, PLATTFORM_PFAD, PROJEKTWAHL_PFAD_PRAEFIX } from '@seatmeter/shared';
import { ApiProvider, type FetchFunktion } from './api/client';
import { AuthTor } from './auth/AuthTor';
import { Layout, PlattformLayout } from './Layout';
import { navigation, UMLEITUNGEN } from './navigation';
import { mitPluginNavigation, PluginProvider, pluginSeiten, type WebPlugin } from './plugins';
import { Abgleich } from './seiten/abgleich/Abgleich';
import { Ausrollen } from './seiten/Ausrollen';
import { Berichte } from './seiten/Berichte';
import { Budgets } from './seiten/budgets/Budgets';
import { Datenqualitaet } from './seiten/Datenqualitaet';
import { Einstellungen } from './seiten/Einstellungen';
import { Hinweise } from './seiten/hinweise/Hinweise';
import { Jira } from './seiten/jira/Jira';
import { JiraKosten } from './seiten/jira/JiraKosten';
import { Mandant } from './seiten/mandant/Mandant';
import { Personen } from './seiten/Personen';
import { Platzhalter } from './seiten/Platzhalter';
import { Preise } from './seiten/Preise';
import { ProjektDetail } from './seiten/ProjektDetail';
import { Projekte } from './seiten/Projekte';
import { Projektkatalog } from './seiten/projektkatalog/Projektkatalog';
import { ProjektKosten } from './seiten/projektkatalog/ProjektKosten';
import { Projektwahl } from './seiten/projektkatalog/Projektwahl';
import { Projektpreise } from './seiten/Projektpreise';
import { Rechner } from './seiten/Rechner';
import { SsoUndKonten } from './seiten/sso/SsoUndKonten';
import { Systemzustand } from './seiten/Systemzustand';
import { Uebersicht } from './seiten/Uebersicht';

/** Fertige Kernseiten; Plugin-Seiten (ee) kommen dazu, alle übrigen Einträge bleiben Platzhalter. */
const SEITEN: Record<string, ReactElement> = {
  '/': <Uebersicht />,
  '/projekte': <Projekte />,
  '/projektpreise': <Projektpreise />,
  '/personen': <Personen />,
  '/preise': <Preise />,
  '/rechner': <Rechner />,
  '/ausrollen': <Ausrollen />,
  '/datenqualitaet': <Datenqualitaet />,
  '/berichte': <Berichte />,
  '/einstellungen': <Einstellungen />,
  '/budgets': <Budgets />,
  '/hinweise': <Hinweise />,
  '/abgleich': <Abgleich />,
  '/einrichtung/jira': <Jira />,
  '/jira-kosten': <JiraKosten />,
  '/einrichtung/projektkatalog': <Projektkatalog />,
  '/projektkosten': <ProjektKosten />,
  '/mandant': <Mandant />,
  '/einrichtung/sso': <SsoUndKonten />,
};

/** Leitet einen alten Pfad um; `:name` kommt aus dem alten Pfad, Suchparameter bleiben. */
function Umleitung({ nach }: { nach: string }) {
  const parameter = useParams();
  const { search } = useLocation();
  const ziel = nach.replace(/:(\w+)/g, (_, name: string) =>
    encodeURIComponent(parameter[name] ?? ''),
  );
  return <Navigate to={`${ziel}${search}`} replace />;
}

export function App({
  queryClient,
  plugins = [],
  fetch,
}: {
  queryClient: QueryClient;
  /** Web-Plugins (ee) aus `virtual:seatmeter-web-plugins`; im Kern leer. */
  plugins?: readonly WebPlugin[];
  /** Nur für Tests: ersetzt `fetch` für alle API-Aufrufe. */
  fetch?: FetchFunktion;
}) {
  const eintraege = mitPluginNavigation(navigation(), plugins);
  const dashboard = eintraege.filter((e) => e.gruppe !== 'plattform');
  const plattform = eintraege.filter((e) => e.gruppe === 'plattform');
  const zusatz = pluginSeiten(plugins);
  const seite = (pfad: string, titel: string): ReactElement => {
    if (SEITEN[pfad]) return SEITEN[pfad];
    const Komponente = zusatz[pfad];
    return Komponente ? <Komponente /> : <Platzhalter titel={titel} />;
  };
  const ohneEintrag = Object.keys(zusatz).filter((pfad) => !eintraege.some((e) => e.pfad === pfad));
  const route = (pfad: string, titel: string) => (
    <Route key={pfad} path={pfad} element={seite(pfad, titel)} />
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider fetch={fetch}>
        <PluginProvider plugins={plugins}>
          <AuthTor>
            <Routes>
              <Route path={`${PROJEKTWAHL_PFAD_PRAEFIX}:token`} element={<Projektwahl />} />
              <Route element={<PlattformLayout eintraege={plattform} />}>
                <Route
                  path={PLATTFORM_PFAD}
                  element={
                    plattform[0] ? (
                      <Navigate to={plattform[0].pfad} replace />
                    ) : (
                      <Platzhalter titel="Plattform" />
                    )
                  }
                />
                {plattform.map((e) => route(e.pfad, e.titel))}
                {ohneEintrag.filter(istPlattformPfad).map((pfad) => route(pfad, ''))}
                <Route
                  path={`${PLATTFORM_PFAD}/*`}
                  element={<Platzhalter titel="Seite nicht gefunden" />}
                />
              </Route>
              <Route element={<Layout eintraege={dashboard} />}>
                {dashboard.map((e) => route(e.pfad, e.titel))}
                {ohneEintrag
                  .filter((pfad) => !istPlattformPfad(pfad))
                  .map((pfad) => route(pfad, ''))}
                {Object.entries(UMLEITUNGEN)
                  .filter(([alt]) => !eintraege.some((e) => e.pfad === alt) && !zusatz[alt])
                  .map(([alt, neu]) => (
                    <Route key={alt} path={alt} element={<Umleitung nach={neu} />} />
                  ))}
                <Route path="/projekte/:id" element={<ProjektDetail />} />
                <Route path="/system" element={<Systemzustand />} />
                <Route path="*" element={<Platzhalter titel="Seite nicht gefunden" />} />
              </Route>
            </Routes>
          </AuthTor>
        </PluginProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}

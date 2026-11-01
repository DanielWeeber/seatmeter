// Ausrollen (Architektur §10): Schnipsel für Quelle A (OpenTelemetry aus Claude Code) und Quelle B
// (lokaler Agent) aus den Werten des Mandanten (`GET /api/v1/ausrollen`, nur Mandanten-Admins).
// Tokens: Die Konfiguration enthält keins. Ein hier neu erzeugtes Mandanten-Token und ein Einmalcode
// leben nur im React-Zustand dieser Seite (nie im Browser-Speicher, nie im Log) und sind nach dem
// Verlassen der Seite weg.
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useAusrollen, useEinmalcodeErzeugen, useMandantenTokenErzeugen } from '../api/abfragen';
import { istApiFehler, istCsrfFehler, TEXT_CSRF } from '../api/client';
import {
  AGENT_STANDARD_PFAD,
  type AusrollenKonfiguration,
  type Einmalcode,
  type MandantenTokenAntwort,
} from '../api/typen';
import { Abfrage, Hinweis } from '../komponenten/Abfrage';
import { Abschnitt, Seitenkopf, Werte } from '../komponenten/Bausteine';
import { datumZeit } from '../format';
import { Codeblock } from './ausrollen/Codeblock';
import {
  agentInstallBefehl,
  benutzerEinstellungen,
  enrollBefehl,
  installHooksBefehl,
  installSweeperBefehl,
  managedSettings,
  pfadeLesen,
  serverManagedSettings,
  startWrapper,
  statusBefehl,
  STANDARD_PFADE,
  TOKEN_PLATZHALTER,
  type KopfzeilenArt,
  type SchnipselOptionen,
} from './ausrollen/schnipsel';

type ReiterId = 'mdm' | 'server' | 'benutzer' | 'wrapper' | 'agent';

const REITER: { id: ReiterId; titel: string }[] = [
  { id: 'mdm', titel: 'Managed Settings (MDM)' },
  { id: 'server', titel: 'Server-Managed Settings (Team/Enterprise)' },
  { id: 'benutzer', titel: 'Benutzer-Einstellungen' },
  { id: 'wrapper', titel: 'Start-Wrapper (Shell)' },
  { id: 'agent', titel: 'Agent installieren' },
];

const PLAN_NAMEN: Record<AusrollenKonfiguration['mandant']['plan'], string> = {
  team: 'Team',
  enterprise: 'Enterprise',
  max_pilot: 'Max (Pilot)',
};

const knopf =
  'rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50';
const warnung = 'rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900';

function meldung(fehler: unknown, wofuer: string): string {
  if (istCsrfFehler(fehler)) return TEXT_CSRF;
  if (istApiFehler(fehler, 403)) return 'Dafür fehlt die Berechtigung.';
  if (istApiFehler(fehler, 404)) return `${wofuer} kann der Server noch nicht.`;
  return `${wofuer} fehlgeschlagen.`;
}

function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-slate-100 px-1 text-[0.85em]">{children}</code>;
}

function Punkte({ children }: { children: ReactNode }) {
  return <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">{children}</ul>;
}

function Einleitung() {
  return (
    <div className="mt-4 max-w-3xl space-y-2 text-sm text-slate-700">
      <p>
        Hier entstehen die Bausteine, mit denen die Rechner Ihrer Firma Nutzungsdaten an seatmeter
        liefern:
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Quelle A</strong> – OpenTelemetry direkt aus Claude Code (Managed Settings,
          Benutzer-Einstellungen oder Start-Wrapper).
        </li>
        <li>
          <strong>Quelle B</strong> – der lokale seatmeter-Agent; er liefert außerdem den
          Rechner-Token für die Kopfzeilen von Quelle A.
        </li>
      </ul>
      <p>
        Alle Werte (Ingest-Adresse, Organisationen) stammen aus Ihrem Mandanten. Tokens zeigt diese
        Seite nie an – außer einem Mandanten-Token, das Sie hier neu erzeugen; es erscheint genau
        einmal.
      </p>
    </div>
  );
}

function MandantWerte({ k }: { k: AusrollenKonfiguration }) {
  return (
    <>
      <Werte
        eintraege={[
          ['Mandant', `${k.mandant.name} (${k.mandant.slug})`],
          ['Plan', PLAN_NAMEN[k.mandant.plan] ?? k.mandant.plan],
          ['Ingest-Adresse', <C>{k.ingest_url}</C>],
          ['OTLP-Endpunkt', <C>{k.otlp_endpoint}</C>],
          [
            'Organisationen',
            k.orgs.length === 0 ? (
              'keine hinterlegt'
            ) : (
              <ul className="space-y-0.5">
                {k.orgs.map((o) => (
                  <li key={o.org_uuid}>
                    {o.bezeichnung ?? 'ohne Bezeichnung'} <C>{o.org_uuid}</C>
                    {o.plan ? ` (${o.plan})` : ''}
                  </li>
                ))}
              </ul>
            ),
          ],
          ['Server-Version', k.agent.server_version],
        ]}
      />
      {k.ingest_url_quelle === 'anfrage' && (
        <div className={`mt-3 ${warnung}`}>
          Die Ingest-Adresse ist aus der Anfrage an das Dashboard abgeleitet. Läuft das Dashboard
          intern, erreichen die Rechner diese Adresse womöglich nicht: auf dem Server{' '}
          <C>SEATMETER_INGEST_URL</C> setzen, damit die Schnipsel den öffentlichen Ingest-Host
          enthalten.
        </div>
      )}
    </>
  );
}

function FesterToken({
  token,
  setToken,
}: {
  token: MandantenTokenAntwort | null;
  setToken: (t: MandantenTokenAntwort | null) => void;
}) {
  const erzeugen = useMandantenTokenErzeugen();
  return (
    <div className="mt-3 space-y-3">
      <div className={warnung}>
        <p className="font-medium">Fester Token nur, wenn der Agent nicht überall laufen kann:</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>
            Wer die Einstellungsdatei oder die Prozessumgebung lesen kann, kann den Token lesen.
          </li>
          <li>
            Alle Rechner teilen sich einen Token: Ein Widerruf heißt, überall einen neuen Token
            auszurollen.
          </li>
          <li>
            Wenn möglich den otelHeadersHelper verwenden (eigenes Rechner-Token je Rechner über den
            Agenten).
          </li>
        </ul>
      </div>
      <button
        type="button"
        className={knopf}
        disabled={erzeugen.isPending}
        onClick={() =>
          erzeugen.mutate(undefined, {
            // Nur in den React-Zustand übernehmen; der Mutation-Cache gibt das Ergebnis frei.
            onSuccess: (neu) => {
              setToken(neu);
              erzeugen.reset();
            },
          })
        }
      >
        Neues Mandanten-Token erzeugen
      </button>
      {erzeugen.isError && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {meldung(erzeugen.error, 'Mandanten-Token erzeugen')}
        </p>
      )}
      {token ? (
        <div
          role="status"
          className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900"
        >
          <p className="font-medium">Nur jetzt sichtbar – sofort in die Verteilung übernehmen.</p>
          <p className="mt-1">
            Das neue Token (Präfix <C>{token.praefix}</C>, erzeugt {datumZeit(token.erstellt)})
            steht jetzt in den Schnipseln. Nach dem Verlassen der Seite lässt es sich nicht mehr
            anzeigen.
          </p>
          <button
            type="button"
            onClick={() => setToken(null)}
            className="mt-2 rounded px-2 py-0.5 text-sm hover:underline"
          >
            Token ausblenden
          </button>
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          Ohne neues Token steht der Platzhalter <C>{TOKEN_PLATZHALTER}</C> in den Schnipseln.
        </p>
      )}
    </div>
  );
}

function Optionen({
  k,
  kopfzeilen,
  setKopfzeilen,
  token,
  setToken,
  agentPfad,
  setAgentPfad,
  orgFestlegen,
  setOrgFestlegen,
  projektwahl,
  setProjektwahl,
}: {
  k: AusrollenKonfiguration;
  kopfzeilen: KopfzeilenArt;
  setKopfzeilen: (a: KopfzeilenArt) => void;
  token: MandantenTokenAntwort | null;
  setToken: (t: MandantenTokenAntwort | null) => void;
  agentPfad: string;
  setAgentPfad: (p: string) => void;
  orgFestlegen: boolean;
  setOrgFestlegen: (b: boolean) => void;
  projektwahl: boolean;
  setProjektwahl: (b: boolean) => void;
}) {
  const name = useId();
  const ohneOrgs = k.orgs.length === 0;
  const art = (wert: KopfzeilenArt, text: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="radio"
        name={name}
        value={wert}
        checked={kopfzeilen === wert}
        onChange={() => setKopfzeilen(wert)}
        className="mt-1"
      />
      <span>{text}</span>
    </label>
  );
  return (
    <div className="space-y-4 rounded border border-slate-200 bg-white p-4">
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-slate-700">Kopfzeilen-Art</legend>
        <div className="space-y-1">
          {art('helper', 'Rechner-Token über den Agenten (otelHeadersHelper, empfohlen)')}
          {art('fest', 'Fester Mandanten-Token (OTEL_EXPORTER_OTLP_HEADERS)')}
        </div>
        {kopfzeilen === 'fest' && <FesterToken token={token} setToken={setToken} />}
      </fieldset>
      <div className="text-sm">
        <label htmlFor={`${name}-pfad`} className="block font-medium text-slate-700">
          Agent-Pfad
        </label>
        <input
          id={`${name}-pfad`}
          value={agentPfad}
          onChange={(e) => setAgentPfad(e.target.value)}
          spellCheck={false}
          placeholder={AGENT_STANDARD_PFAD}
          aria-describedby={`${name}-pfad-hinweis`}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono"
        />
        <p id={`${name}-pfad-hinweis`} className="mt-1 text-xs text-slate-500">
          Claude Code führt den Helper als Befehlszeile aus. Für MDM einen festen absoluten Pfad
          verwenden, der auf allen Rechnern gilt.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={orgFestlegen && !ohneOrgs}
          disabled={ohneOrgs}
          onChange={(e) => setOrgFestlegen(e.target.checked)}
          className="mt-1"
        />
        <span>
          Anmeldung auf die Org festlegen (forceLoginMethod/forceLoginOrgUUID)
          <span className="block text-xs text-slate-500">
            {ohneOrgs
              ? 'Im Mandanten ist keine Organisation hinterlegt.'
              : `Alle ${k.orgs.length} Organisation(en) des Mandanten; wirkt nur in den Managed Settings (MDM).`}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={projektwahl}
          onChange={(e) => setProjektwahl(e.target.checked)}
          className="mt-1"
        />
        <span>
          Hook für die erzwungene Projektwahl aufnehmen
          <span className="block text-xs text-slate-500">
            Nur in den verwalteten Einstellungen (Tabs MDM und Server). Der Hook blockiert den
            Prompt in Repos ohne Projekt, sobald unter Einrichtung → Projektkatalog das Erzwingen
            eingeschaltet und der Katalog gefüllt ist. Er sendet nur Sitzungs-ID und Repo-URL, nie
            den Prompt. Beim ersten Start bestätigt jede Person den Hook einmal; wer ablehnt,
            beendet Claude Code.
          </span>
        </span>
      </label>
    </div>
  );
}

function Reiterleiste({
  aktiv,
  setAktiv,
  basis,
}: {
  aktiv: ReiterId;
  setAktiv: (r: ReiterId) => void;
  basis: string;
}) {
  const knoepfe = useRef<(HTMLButtonElement | null)[]>([]);
  const tasten = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = REITER.length;
    const ziele: Record<string, number> = {
      ArrowRight: (i + 1) % n,
      ArrowLeft: (i - 1 + n) % n,
      Home: 0,
      End: n - 1,
    };
    const ziel = ziele[e.key];
    const reiter = ziel === undefined ? undefined : REITER[ziel];
    if (ziel === undefined || !reiter) return;
    e.preventDefault();
    setAktiv(reiter.id);
    knoepfe.current[ziel]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Ausroll-Varianten"
      className="flex flex-wrap gap-1 border-b border-slate-200"
    >
      {REITER.map((r, i) => {
        const gewaehlt = r.id === aktiv;
        return (
          <button
            key={r.id}
            ref={(el) => {
              knoepfe.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${basis}-reiter-${r.id}`}
            aria-selected={gewaehlt}
            aria-controls={`${basis}-inhalt-${r.id}`}
            tabIndex={gewaehlt ? 0 : -1}
            onClick={() => setAktiv(r.id)}
            onKeyDown={(e) => tasten(e, i)}
            className={`-mb-px rounded-t border px-3 py-1.5 text-sm ${
              gewaehlt
                ? 'border-slate-200 border-b-white bg-white font-medium text-slate-900'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            {r.titel}
          </button>
        );
      })}
    </div>
  );
}

function ReiterMdm({ k, o }: { k: AusrollenKonfiguration; o: SchnipselOptionen }) {
  return (
    <>
      <Codeblock id="mdm" beschriftung="managed-settings.json" inhalt={managedSettings(k, o)} />
      <Punkte>
        <li>
          Ablage: macOS <C>/Library/Application Support/ClaudeCode/managed-settings.json</C>, Linux{' '}
          <C>/etc/claude-code/managed-settings.json</C>, Windows{' '}
          <C>C:\Program Files\ClaudeCode\managed-settings.json</C>.
        </li>
        <li>
          Stärkste Bindung: Die Werte gehen allen anderen vor, Nutzer können sie nicht ändern.
        </li>
        <li>
          Die Zeilen <C>OTEL_LOG_*=0</C> sperren das Protokollieren von Inhalten (Prompts,
          Antworten, Werkzeugdetails, API-Rohdaten).
        </li>
        {o.kopfzeilen === 'helper' && (
          <li>
            Der otelHeadersHelper setzt voraus, dass der Agent auf jedem Rechner installiert und
            registriert ist (Reiter „Agent installieren“).
          </li>
        )}
        <li>
          Eine <C>.claude/settings.json</C> im Repository wird für die OTEL-Exporter-Variablen nicht
          beachtet.
        </li>
      </Punkte>
    </>
  );
}

function ReiterServer({ k, o }: { k: AusrollenKonfiguration; o: SchnipselOptionen }) {
  return (
    <>
      {o.kopfzeilen === 'helper' ? (
        <div className={`mt-3 ${warnung}`}>
          Mit dem otelHeadersHelper nur, wenn der Agent auf allen Rechnern der Organisation
          ausgerollt ist – sonst liefern Rechner ohne Agent nichts. Andernfalls hier den festen
          Mandanten-Token verwenden.
        </div>
      ) : null}
      <Codeblock
        id="server"
        beschriftung="Managed settings (claude.ai)"
        inhalt={serverManagedSettings(k, o)}
      />
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700">
        <li>
          Als Owner oder Admin in claude.ai: Admin-Einstellungen → Claude Code → Managed settings.
        </li>
        <li>JSON einfügen und speichern.</li>
      </ol>
      <Punkte>
        <li>Gilt einheitlich für alle Mitglieder der Organisation (keine Gruppen).</li>
        <li>
          Vor dem Wirksamwerden sehen Nutzer einmal je Konto und Organisation einen Freigabedialog
          für den Telemetrie-Endpunkt – vorher ankündigen.
        </li>
        <li>
          forceLoginMethod/forceLoginOrgUUID wirken nur je Gerät über die Managed Settings (MDM) und
          stehen deshalb hier nicht im JSON.
        </li>
        <li>Wirksam beim nächsten Start von Claude Code.</li>
      </Punkte>
    </>
  );
}

function ReiterBenutzer({ k, o }: { k: AusrollenKonfiguration; o: SchnipselOptionen }) {
  return (
    <>
      <Codeblock
        id="benutzer"
        beschriftung="~/.claude/settings.json"
        inhalt={benutzerEinstellungen(k, o)}
      />
      <Punkte>
        <li>
          In <C>~/.claude/settings.json</C> der Person mit vorhandenen Einträgen zusammenführen.
        </li>
        <li>Nicht gesperrt: Die Person kann die Werte jederzeit ändern oder entfernen.</li>
        <li>
          Nie einen festen Token eintragen, wenn die Datei synchronisiert wird oder in Dotfiles
          liegt.
        </li>
      </Punkte>
    </>
  );
}

function ReiterWrapper({
  k,
  agentPfad,
  pfadeText,
  setPfadeText,
  kopfzeilen,
}: {
  k: AusrollenKonfiguration;
  agentPfad: string;
  pfadeText: string;
  setPfadeText: (t: string) => void;
  kopfzeilen: KopfzeilenArt;
}) {
  const id = useId();
  const { pfade, fehler } = pfadeLesen(pfadeText);
  const wrapper = startWrapper(k, agentPfad, pfade);
  return (
    <>
      <label htmlFor={id} className="mt-3 block text-sm font-medium text-slate-700">
        Pfade (einer je Zeile)
      </label>
      <textarea
        id={id}
        value={pfadeText}
        onChange={(e) => setPfadeText(e.target.value)}
        rows={3}
        spellCheck={false}
        aria-invalid={fehler.length > 0 || pfade.length === 0 ? true : undefined}
        className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-sm"
      />
      {fehler.length > 0 && (
        <ul role="alert" className="mt-1 text-xs text-red-700">
          {fehler.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {wrapper ? (
        <Codeblock id="wrapper" beschriftung="~/.zshrc bzw. ~/.bashrc" inhalt={wrapper} />
      ) : (
        <Hinweis>Mindestens einen gültigen Pfad angeben.</Hinweis>
      )}
      <Punkte>
        <li>Nur Sitzungen, die unter diesen Pfaden starten, senden Telemetrie.</li>
        <li>
          Der Token kommt vom Agenten (Schlüsselbund des Betriebssystems), nie aus der Shell; der
          Wrapper nutzt deshalb immer den otelHeadersHelper
          {kopfzeilen === 'fest' ? ', auch wenn oben der feste Token gewählt ist' : ''}.
        </li>
        <li>
          Mit dem Agent-Modus „nur Sweeper“ und denselben Pfaden als <C>--include</C> kombinieren
          (Reiter „Agent installieren“).
        </li>
        <li>
          In <C>~/.zshrc</C> bzw. <C>~/.bashrc</C> einfügen und eine neue Shell öffnen.{' '}
          <C>command claude</C> ruft das Programm aus dem PATH auf; einen Alias <C>claude</C> vorher
          entfernen.
        </li>
      </Punkte>
    </>
  );
}

function ReiterAgent({
  k,
  agentPfad,
  pfadeText,
  einmalcode,
  setEinmalcode,
}: {
  k: AusrollenKonfiguration;
  agentPfad: string;
  pfadeText: string;
  einmalcode: Einmalcode | null;
  setEinmalcode: (c: Einmalcode | null) => void;
}) {
  const bezeichnungId = useId();
  const [bezeichnung, setBezeichnung] = useState('');
  const erzeugen = useEinmalcodeErzeugen();
  const install = agentInstallBefehl(k);
  const { pfade } = pfadeLesen(pfadeText);
  const schritt = 'mt-6 text-base font-semibold first:mt-3';
  return (
    <>
      <h3 className={schritt}>1. Agent installieren</h3>
      {install ? (
        <>
          <Codeblock id="agent-install" beschriftung="Installation" inhalt={`${install}\n`} />
          <Punkte>
            <li>
              Bei einem privaten Forgejo zusätzlich <C>SEATMETER_DOWNLOAD_TOKEN=&lt;token&gt;</C>{' '}
              (Token mit Leserecht) setzen; den Token nie in Chat oder Tickets einfügen.
            </li>
            <li>Voraussetzung: Node.js ab Version 22.</li>
            <li>
              Die Agent-Version sollte zur Server-Version <C>{k.agent.server_version}</C> passen.
            </li>
          </Punkte>
        </>
      ) : (
        <div className={`mt-3 ${warnung}`}>
          Auf dem Server ist <C>SEATMETER_AGENT_RELEASE_URL</C> nicht gesetzt; ohne sie lässt sich
          kein Installationsbefehl erzeugen.
        </div>
      )}

      <h3 className={schritt}>2. Rechner registrieren</h3>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setEinmalcode(null);
          erzeugen.mutate(bezeichnung, {
            onSuccess: (neu) => {
              setEinmalcode(neu);
              setBezeichnung('');
              erzeugen.reset();
            },
          });
        }}
      >
        <label htmlFor={bezeichnungId} className="block flex-1 text-sm">
          <span className="block font-medium text-slate-700">Bezeichnung (optional)</span>
          <input
            id={bezeichnungId}
            value={bezeichnung}
            onChange={(e) => setBezeichnung(e.target.value)}
            placeholder="z. B. Notebook Entwicklung"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button type="submit" disabled={erzeugen.isPending} className={knopf}>
          Einmalcode erzeugen
        </button>
      </form>
      {erzeugen.isError && (
        <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {meldung(erzeugen.error, 'Einmalcode erzeugen')}
        </p>
      )}
      <Codeblock
        id="agent-enroll"
        beschriftung="Registrierung"
        inhalt={`${enrollBefehl(k, agentPfad, einmalcode?.code ?? null)}\n`}
      />
      {einmalcode ? (
        <p role="status" className="mt-2 text-sm text-green-900">
          Einmalcode – nur jetzt sichtbar, einmal verwendbar, gültig bis{' '}
          {datumZeit(einmalcode.laeuft_ab)}.{' '}
          <button
            type="button"
            onClick={() => setEinmalcode(null)}
            className="rounded px-1 hover:underline"
          >
            Ausblenden
          </button>
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          Der Einmalcode gilt 24 Stunden und nur für einen Rechner.
        </p>
      )}

      <h3 className={schritt}>3. Modus wählen</h3>
      <p className="mt-2 text-sm text-slate-700">
        Nur Sweeper (passend zum Start-Wrapper, Pfade aus dem Reiter „Start-Wrapper“):
      </p>
      <Codeblock
        id="agent-sweeper"
        beschriftung="Installation nur Sweeper"
        inhalt={`${installSweeperBefehl(agentPfad, pfade)}\n`}
      />
      <p className="mt-3 text-sm text-slate-700">Oder mit Hooks für alle Sitzungen:</p>
      <Codeblock
        id="agent-hooks"
        beschriftung="Installation mit Hooks"
        inhalt={`${installHooksBefehl(agentPfad)}\n`}
      />
      <Punkte>
        <li>
          Bei <C>install</C> zusätzlich <C>--projekt-pfad &lt;pfad&gt;=&lt;name&gt;</C> (mehrfach
          möglich): Sitzungen ohne Git-Remote unter diesem Pfad zählen für das benannte Projekt
          statt für „unzugeordnet“.
        </li>
      </Punkte>

      <h3 className={schritt}>4. Prüfen</h3>
      <Codeblock id="agent-status" beschriftung="Status" inhalt={`${statusBefehl(agentPfad)}\n`} />
    </>
  );
}

function Inhalt({ k }: { k: AusrollenKonfiguration }) {
  const basis = useId();
  const [kopfzeilen, setKopfzeilen] = useState<KopfzeilenArt>('helper');
  const [token, setToken] = useState<MandantenTokenAntwort | null>(null);
  const [agentPfadEingabe, setAgentPfad] = useState(AGENT_STANDARD_PFAD);
  const [orgFestlegen, setOrgFestlegen] = useState(k.orgs.length > 0);
  const [projektwahl, setProjektwahl] = useState(false);
  const [aktiv, setAktiv] = useState<ReiterId>('mdm');
  const [pfadeText, setPfadeText] = useState(STANDARD_PFADE);
  const [einmalcode, setEinmalcode] = useState<Einmalcode | null>(null);

  const agentPfad = agentPfadEingabe.trim() || AGENT_STANDARD_PFAD;
  const o: SchnipselOptionen = {
    kopfzeilen,
    token: kopfzeilen === 'fest' ? (token?.token ?? null) : null,
    agentPfad,
    orgFestlegen,
    projektwahl,
  };

  return (
    <>
      <Abschnitt titel="Werte des Mandanten">
        <MandantWerte k={k} />
      </Abschnitt>
      <Abschnitt titel="Gemeinsame Einstellungen">
        <Optionen
          k={k}
          kopfzeilen={kopfzeilen}
          setKopfzeilen={setKopfzeilen}
          token={token}
          setToken={setToken}
          agentPfad={agentPfadEingabe}
          setAgentPfad={setAgentPfad}
          orgFestlegen={orgFestlegen}
          setOrgFestlegen={setOrgFestlegen}
          projektwahl={projektwahl}
          setProjektwahl={setProjektwahl}
        />
      </Abschnitt>
      <Abschnitt titel="Varianten">
        <Reiterleiste aktiv={aktiv} setAktiv={setAktiv} basis={basis} />
        <div
          role="tabpanel"
          id={`${basis}-inhalt-${aktiv}`}
          aria-labelledby={`${basis}-reiter-${aktiv}`}
          className="pb-2"
        >
          {aktiv === 'mdm' && <ReiterMdm k={k} o={o} />}
          {aktiv === 'server' && <ReiterServer k={k} o={o} />}
          {aktiv === 'benutzer' && <ReiterBenutzer k={k} o={o} />}
          {aktiv === 'wrapper' && (
            <ReiterWrapper
              k={k}
              agentPfad={agentPfad}
              pfadeText={pfadeText}
              setPfadeText={setPfadeText}
              kopfzeilen={kopfzeilen}
            />
          )}
          {aktiv === 'agent' && (
            <ReiterAgent
              k={k}
              agentPfad={agentPfad}
              pfadeText={pfadeText}
              einmalcode={einmalcode}
              setEinmalcode={setEinmalcode}
            />
          )}
        </div>
      </Abschnitt>
    </>
  );
}

export function Ausrollen() {
  const abfrage = useAusrollen();
  return (
    <section>
      <Seitenkopf titel="Ausrollen" />
      <Einleitung />
      {abfrage.isError && istApiFehler(abfrage.error, 403) ? (
        <Hinweis>
          Das Ausrollen können nur Mandanten-Admins vorbereiten (Rolle mandanten_admin).
        </Hinweis>
      ) : (
        <Abfrage abfrage={abfrage}>{(k) => <Inhalt k={k} />}</Abfrage>
      )}
    </section>
  );
}

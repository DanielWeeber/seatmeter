// Formular für Alarmkanäle (POST bzw. PUT /api/v1/alarmkanal). Das Geheimnis (Bearer-Token,
// SMTP-Passwort, Relay-Token) ist nur beschreibbar: leer = unverändert, nie angezeigt.
import {
  KANAL_TYPEN,
  kanalEingabeSchema,
  kanalSchema,
  type Kanal,
  type KanalTyp,
} from '@seatmeter/shared';
import { ApiFehler, useApi } from '../../api/client';
import { Auswahl, Eingabe, Formular, Kontrollkaestchen } from '../../komponenten/Formular';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { listeAus } from '../../format';
import {
  GEHEIMNIS_LEER,
  Geheimnisfeld,
  geheimnisFuerRequest,
  type GeheimnisWert,
} from '../../komponenten/Geheimnisfeld';
import { KNOPF } from '../../komponenten/knoepfe';
import { speicherFehler } from '../../komponenten/Zugriff';

export const KANAL_TYP_TEXT: Record<KanalTyp, string> = {
  webhook: 'Webhook',
  smtp: 'E-Mail (SMTP)',
  'weeberwrk-relay': 'weeberwrk-Relay',
};

const GEHEIMNIS_TEXT: Record<KanalTyp, string> = {
  webhook: 'Bearer-Token (optional)',
  smtp: 'Passwort',
  'weeberwrk-relay': 'Relay-Token',
};

const FELD_TEXT: Record<string, string> = {
  bezeichnung: 'Bitte eine Bezeichnung angeben.',
  'konfig.url': 'Bitte eine gültige URL mit http:// oder https:// angeben.',
  'konfig.host': 'Bitte den Mailserver angeben.',
  'konfig.port': 'Der Port liegt zwischen 1 und 65535.',
  'konfig.von': 'Bitte eine gültige Absenderadresse angeben.',
  'konfig.an': 'Mindestens eine gültige Empfängeradresse angeben (durch Komma getrennt).',
  'konfig.benutzer': 'Der Benutzername ist zu lang.',
  'konfig.bot': 'Bot-Name: nur Kleinbuchstaben, Ziffern und Bindestrich.',
  geheimnis: 'Das Geheimnis ist leer oder zu lang.',
};

const text = (w: unknown): string => (typeof w === 'string' ? w : '');

/** Schlüssel für Feldfehler: Pfad bis zur zweiten Ebene (`konfig.url`, `bezeichnung`). */
const pfadSchluessel = (pfad: readonly PropertyKey[]): string =>
  pfad
    .slice(0, pfad[0] === 'konfig' ? 2 : 1)
    .map(String)
    .join('.');

export function KanalFormular({
  kanal,
  onFertig,
  onAbbrechen,
}: {
  /** `null` = neuer Kanal. */
  kanal: Kanal | null;
  onFertig: (erfolg: string) => void;
  onAbbrechen: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const k = kanal?.konfig ?? {};
  const [typ, setTyp] = useState<KanalTyp>(kanal?.typ ?? 'webhook');
  const [bezeichnung, setBezeichnung] = useState(kanal?.bezeichnung ?? '');
  const [aktiv, setAktiv] = useState(kanal?.aktiv ?? true);
  const [url, setUrl] = useState(text(k.url));
  const [host, setHost] = useState(text(k.host));
  const [port, setPort] = useState(k.port == null ? '587' : String(k.port));
  const [secure, setSecure] = useState(k.secure === true);
  const [benutzer, setBenutzer] = useState(text(k.benutzer));
  const [von, setVon] = useState(text(k.von));
  const [an, setAn] = useState(Array.isArray(k.an) ? k.an.map(text).join(', ') : '');
  const [pfad, setPfad] = useState(text(k.pfad) || '/dm');
  const [prio, setPrio] = useState(text(k.prio) || 'normal');
  const [bot, setBot] = useState(text(k.bot));
  const [geheimnis, setGeheimnis] = useState<GeheimnisWert>(GEHEIMNIS_LEER);
  const [feldFehler, setFeldFehler] = useState<Record<string, string>>({});
  const [meldung, setMeldung] = useState<string | null>(null);

  const speichern = useMutation({
    mutationFn: (koerper: unknown) =>
      kanal
        ? api.put(`/api/v1/alarmkanal/${encodeURIComponent(kanal.id)}`, koerper, kanalSchema)
        : api.post('/api/v1/alarmkanal', koerper, kanalSchema),
    onSuccess: async () => {
      setGeheimnis(GEHEIMNIS_LEER);
      await queryClient.invalidateQueries({ queryKey: ['alarmkanal'] });
      onFertig(kanal ? 'Alarmkanal gespeichert.' : 'Alarmkanal angelegt.');
    },
    onError: (fehler) => {
      if (fehler instanceof ApiFehler && fehler.status === 400) {
        const je: Record<string, string> = {};
        for (const d of fehler.details) {
          if (d.feld && d.feld in FELD_TEXT && !je[d.feld]) je[d.feld] = d.meldung;
        }
        setFeldFehler(je);
      }
      setMeldung(speicherFehler(fehler));
    },
  });

  const absenden = () => {
    setMeldung(null);
    const konfig =
      typ === 'webhook'
        ? { url: url.trim() }
        : typ === 'smtp'
          ? {
              host: host.trim(),
              port: Number(port),
              secure,
              benutzer: benutzer.trim() === '' ? null : benutzer.trim(),
              von: von.trim(),
              an: listeAus(an),
            }
          : { url: url.trim(), pfad, prio, bot: bot.trim() === '' ? null : bot.trim() };
    const ergebnis = kanalEingabeSchema.safeParse({
      typ,
      bezeichnung: bezeichnung.trim(),
      aktiv,
      konfig,
      ...geheimnisFuerRequest(geheimnis),
    });
    if (!ergebnis.success) {
      const je: Record<string, string> = {};
      for (const issue of ergebnis.error.issues) {
        const schluessel = pfadSchluessel(issue.path);
        if (!je[schluessel]) je[schluessel] = FELD_TEXT[schluessel] ?? issue.message;
      }
      setFeldFehler(je);
      setMeldung('Bitte die markierten Felder prüfen.');
      return;
    }
    setFeldFehler({});
    speichern.mutate(ergebnis.data);
  };

  return (
    <>
      <Formular
        titel={kanal ? 'Alarmkanal bearbeiten' : 'Neuer Alarmkanal'}
        onAbsenden={absenden}
        laeuft={speichern.isPending}
        meldung={meldung}
      >
        <Auswahl
          beschriftung="Typ"
          wert={typ}
          // Der Typ eines bestehenden Kanals bleibt fest (anderer Typ = anderer Kanal).
          onAendern={(w) => {
            if (!kanal) setTyp(w as KanalTyp);
          }}
          optionen={(kanal ? [kanal.typ] : KANAL_TYPEN).map((t) => [t, KANAL_TYP_TEXT[t]] as const)}
        />
        <Eingabe
          beschriftung="Bezeichnung"
          wert={bezeichnung}
          onAendern={setBezeichnung}
          fehler={feldFehler.bezeichnung}
        />
        {typ !== 'smtp' && (
          <Eingabe
            beschriftung="URL"
            typ="url"
            wert={url}
            onAendern={setUrl}
            fehler={feldFehler['konfig.url']}
          />
        )}
        {typ === 'smtp' && (
          <>
            <Eingabe
              beschriftung="Mailserver (Host)"
              wert={host}
              onAendern={setHost}
              fehler={feldFehler['konfig.host']}
            />
            <Eingabe
              beschriftung="Port"
              wert={port}
              onAendern={setPort}
              fehler={feldFehler['konfig.port']}
            />
            <Kontrollkaestchen
              beschriftung="TLS ab Verbindungsbeginn (Port 465)"
              wert={secure}
              onAendern={setSecure}
            />
            <Eingabe
              beschriftung="Benutzer (optional)"
              wert={benutzer}
              onAendern={setBenutzer}
              fehler={feldFehler['konfig.benutzer']}
            />
            <Eingabe
              beschriftung="Absender"
              wert={von}
              onAendern={setVon}
              fehler={feldFehler['konfig.von']}
            />
            <Eingabe
              beschriftung="Empfänger (durch Komma getrennt)"
              wert={an}
              onAendern={setAn}
              fehler={feldFehler['konfig.an']}
            />
          </>
        )}
        {typ === 'weeberwrk-relay' && (
          <>
            <Auswahl
              beschriftung="Pfad"
              wert={pfad}
              onAendern={setPfad}
              optionen={[
                ['/dm', '/dm (Direktnachricht)'],
                ['/alert', '/alert (Vorfall)'],
              ]}
            />
            <Auswahl
              beschriftung="Priorität"
              wert={prio}
              onAendern={setPrio}
              optionen={[
                ['normal', 'normal'],
                ['critical', 'kritisch'],
              ]}
            />
            <Eingabe
              beschriftung="Bot (optional)"
              wert={bot}
              onAendern={setBot}
              fehler={feldFehler['konfig.bot']}
            />
          </>
        )}
        <Geheimnisfeld
          beschriftung={GEHEIMNIS_TEXT[typ]}
          gesetzt={kanal?.geheimnis_gesetzt ?? false}
          wert={geheimnis}
          onAendern={setGeheimnis}
          fehler={feldFehler.geheimnis}
        />
        <Kontrollkaestchen beschriftung="Aktiv" wert={aktiv} onAendern={setAktiv} />
      </Formular>
      <button type="button" className={`mt-2 ${KNOPF}`} onClick={onAbbrechen}>
        Abbrechen
      </button>
    </>
  );
}

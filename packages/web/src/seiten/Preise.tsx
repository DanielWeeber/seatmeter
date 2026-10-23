// Preistabelle, Sitzkosten und Wechselkurs. Zeilen sind versioniert (neue Zeile mit `gueltig_ab`),
// nie überschrieben. Formulare nur für Mandanten-Admins, alle anderen sehen die Tabellen nur lesend.
// Preise: POST /api/v1/preise (PreisEingabe); Sitzkosten: PUT /api/v1/sitzkosten (Upsert je Typ und
// Tag); Kurs: GET /api/v1/kurse, PUT /api/v1/kurs?monat= (manuell), POST /api/v1/jobs/kurs/ezb.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useKurse, usePreise, useSitzkosten } from '../api/abfragen';
import { useApi } from '../api/client';
import {
  ABRECHNUNGEN,
  ezbErgebnisSchema,
  kursEingabeSchema,
  kursSchema,
  preisEingabeSchema,
  SITZ_TYP_NAMEN,
  SITZ_TYPEN,
  sitzkostenEingabeSchema,
  type Kurs,
  type PreisDto,
  type SitzkostenZeile,
} from '../api/typen';
import { useAuth } from '../auth/AuthTor';
import { Abfrage } from '../komponenten/Abfrage';
import { Abschnitt, Seitenkopf, Tabelle } from '../komponenten/Bausteine';
import { Auswahl, Eingabe, fehlerBeimSpeichern, Formular } from '../komponenten/Formular';
import { alsZahl, datum, datumZeit, geld, kurszahl } from '../format';
import { aktuellerMonat, monatsname } from '../monat';
import { KURS_QUELLEN_TEXT } from '../texte';

const SITZ_NAMEN: Record<string, string> = SITZ_TYP_NAMEN;
const ABRECHNUNG_NAMEN: Record<string, string> = { monatlich: 'monatlich', jaehrlich: 'jährlich' };

const satz = (w: number) => geld(w, 'USD', 4);

function heute(): string {
  return new Date().toISOString().slice(0, 10);
}

const SATZ_FELDER = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cache_read', 'Cache lesen'],
  ['cache_write_5m', 'Cache schreiben 5 min'],
  ['cache_write_1h', 'Cache schreiben 1 h'],
] as const;
type SatzFeld = (typeof SATZ_FELDER)[number][0];

function PreisFormular() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [praefix, setPraefix] = useState('');
  const [gueltigAb, setGueltigAb] = useState(heute());
  const [saetze, setSaetze] = useState<Record<SatzFeld, string>>({
    input: '',
    output: '',
    cache_read: '',
    cache_write_5m: '',
    cache_write_1h: '',
  });
  const [quelle, setQuelle] = useState('');
  const [geprueftAm, setGeprueftAm] = useState(heute());
  const [pruefung, setPruefung] = useState<string | null>(null);

  const speichern = useMutation({
    mutationFn: (koerper: unknown) => api.post('/api/v1/preise', koerper),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['preise'] }),
  });

  const absenden = () => {
    const ergebnis = preisEingabeSchema.safeParse({
      modell_praefix: praefix.trim().toLowerCase(),
      gueltig_ab: gueltigAb,
      saetze: Object.fromEntries(SATZ_FELDER.map(([f]) => [f, alsZahl(saetze[f])])),
      quelle_url: quelle.trim(),
      geprueft_am: geprueftAm,
    });
    if (!ergebnis.success) {
      setPruefung(
        'Bitte alle Felder ausfüllen: Modell-Präfix, Datumsangaben, alle Sätze als Zahl ≥ 0 und eine gültige Quell-URL.',
      );
      return;
    }
    setPruefung(null);
    speichern.mutate(ergebnis.data);
  };

  return (
    <Formular
      titel="Neue Preiszeile"
      onAbsenden={absenden}
      laeuft={speichern.isPending}
      meldung={pruefung ?? (speichern.isError ? fehlerBeimSpeichern(speichern.error) : null)}
    >
      <Eingabe beschriftung="Modell-Präfix" wert={praefix} onAendern={setPraefix} />
      <Eingabe beschriftung="Gültig ab" typ="date" wert={gueltigAb} onAendern={setGueltigAb} />
      {SATZ_FELDER.map(([feld, name]) => (
        <Eingabe
          key={feld}
          beschriftung={`${name} (USD je MTok)`}
          wert={saetze[feld]}
          dezimal
          onAendern={(w) => setSaetze((alt) => ({ ...alt, [feld]: w }))}
        />
      ))}
      <Eingabe beschriftung="Quelle (URL)" typ="url" wert={quelle} onAendern={setQuelle} />
      <Eingabe beschriftung="Geprüft am" typ="date" wert={geprueftAm} onAendern={setGeprueftAm} />
      {speichern.isSuccess && (
        <p role="status" className="self-end text-sm text-green-800">
          Gespeichert.
        </p>
      )}
    </Formular>
  );
}

function SitzkostenFormular() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [sitzTyp, setSitzTyp] = useState<string>('standard');
  const [gueltigAb, setGueltigAb] = useState(heute());
  const [preis, setPreis] = useState('');
  const [waehrung, setWaehrung] = useState('USD');
  const [abrechnung, setAbrechnung] = useState<string>('jaehrlich');
  const [pruefung, setPruefung] = useState<string | null>(null);

  const speichern = useMutation({
    mutationFn: (koerper: unknown) => api.put('/api/v1/sitzkosten', koerper),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sitzkosten'] }),
  });

  const absenden = () => {
    const ergebnis = sitzkostenEingabeSchema.safeParse({
      sitz_typ: sitzTyp,
      gueltig_ab: gueltigAb,
      preis_monat: alsZahl(preis),
      waehrung,
      abrechnung,
    });
    if (!ergebnis.success) {
      setPruefung('Bitte Sitztyp, Gültig ab und einen Preis ≥ 0 angeben.');
      return;
    }
    setPruefung(null);
    speichern.mutate(ergebnis.data);
  };

  return (
    <Formular
      titel="Neue Sitzkosten"
      onAbsenden={absenden}
      laeuft={speichern.isPending}
      meldung={pruefung ?? (speichern.isError ? fehlerBeimSpeichern(speichern.error) : null)}
    >
      <Auswahl
        beschriftung="Sitztyp"
        wert={sitzTyp}
        onAendern={setSitzTyp}
        optionen={SITZ_TYPEN.map((t) => [t, SITZ_NAMEN[t] ?? t])}
      />
      <Eingabe beschriftung="Gültig ab" typ="date" wert={gueltigAb} onAendern={setGueltigAb} />
      <Eingabe beschriftung="Preis je Monat" wert={preis} dezimal onAendern={setPreis} />
      <Auswahl
        beschriftung="Währung"
        wert={waehrung}
        onAendern={setWaehrung}
        optionen={[
          ['USD', 'USD'],
          ['EUR', 'EUR'],
        ]}
      />
      <Auswahl
        beschriftung="Abrechnung"
        wert={abrechnung}
        onAendern={setAbrechnung}
        optionen={ABRECHNUNGEN.map((a) => [a, ABRECHNUNG_NAMEN[a] ?? a])}
      />
    </Formular>
  );
}

function KursFormular() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [monat, setMonat] = useState(aktuellerMonat());
  const [kurs, setKurs] = useState('');
  const [pruefung, setPruefung] = useState<string | null>(null);

  const speichern = useMutation({
    mutationFn: ({ m, usd_eur }: { m: string; usd_eur: number }) =>
      api.put(`/api/v1/kurs?monat=${encodeURIComponent(m)}`, { usd_eur }, kursSchema),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['kurse'] });
      await queryClient.invalidateQueries({ queryKey: ['kalkulation'] });
    },
  });

  const absenden = () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monat)) {
      setPruefung('Bitte einen Monat wählen.');
      return;
    }
    const ergebnis = kursEingabeSchema.safeParse({ usd_eur: alsZahl(kurs) });
    if (!ergebnis.success) {
      setPruefung(ergebnis.error.issues[0]?.message ?? 'Bitte einen Kurs angeben.');
      return;
    }
    setPruefung(null);
    speichern.mutate({ m: monat, usd_eur: ergebnis.data.usd_eur });
  };

  return (
    <Formular
      titel="Kurs manuell setzen"
      onAbsenden={absenden}
      laeuft={speichern.isPending}
      meldung={pruefung ?? (speichern.isError ? fehlerBeimSpeichern(speichern.error) : null)}
      erfolg={speichern.isSuccess ? 'Kurs gespeichert; er geht dem EZB-Wert vor.' : null}
    >
      <Eingabe beschriftung="Monat" typ="month" wert={monat} onAendern={setMonat} />
      <Eingabe beschriftung="Kurs (EUR je USD)" wert={kurs} dezimal onAendern={setKurs} />
    </Formular>
  );
}

function EzbAbruf() {
  const api = useApi();
  const queryClient = useQueryClient();
  const abruf = useMutation({
    mutationFn: () => api.post('/api/v1/jobs/kurs/ezb', {}, ezbErgebnisSchema),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['kurse'] });
      await queryClient.invalidateQueries({ queryKey: ['kalkulation'] });
    },
  });
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => abruf.mutate()}
        disabled={abruf.isPending}
        className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
      >
        {abruf.isPending ? 'Rufe ab …' : 'EZB-Kurs abrufen'}
      </button>
      {abruf.isSuccess && (
        <span role="status" className="text-sm text-green-800">
          EZB-Kurse aktualisiert ({abruf.data.monate} Monate).
        </span>
      )}
      {abruf.isError && (
        <span role="alert" className="text-sm text-red-800">
          {fehlerBeimSpeichern(abruf.error).replace('Speichern', 'Abruf')}
        </span>
      )}
    </div>
  );
}

const KURS_SPALTEN = [
  { titel: 'Monat', wert: (k: Kurs) => monatsname(k.monat) },
  { titel: 'Kurs (EUR je USD)', wert: (k: Kurs) => kurszahl(k.usd_eur), zahl: true },
  {
    titel: 'Quelle',
    wert: (k: Kurs) => (k.quelle ? (KURS_QUELLEN_TEXT[k.quelle] ?? k.quelle) : '—'),
  },
  { titel: 'Stand', wert: (k: Kurs) => (k.vorlaeufig ? 'vorläufig' : 'endgültig') },
  { titel: 'Aktualisiert', wert: (k: Kurs) => datumZeit(k.aktualisiert) },
];

function sortierePreise(zeilen: PreisDto[]): PreisDto[] {
  return [...zeilen].sort(
    (a, b) =>
      a.modell_praefix.localeCompare(b.modell_praefix) || b.gueltig_ab.localeCompare(a.gueltig_ab),
  );
}

export function Preise() {
  const { darfVerwalten } = useAuth();
  const preise = usePreise();
  const sitzkosten = useSitzkosten();
  const kurse = useKurse();

  return (
    <section>
      <Seitenkopf titel="Preise & Sitzkosten" />
      {!darfVerwalten && (
        <p className="mt-2 text-sm text-slate-600">
          Nur lesend. Änderungen nehmen Mandanten-Admins vor.
        </p>
      )}

      <Abschnitt titel="API-Listenpreise (USD je 1 Mio. Tokens)">
        <Abfrage
          abfrage={preise}
          istLeer={(d) => d.zeilen.length === 0}
          leerText="Noch keine Preiszeilen vorhanden."
        >
          {(d) => (
            <Tabelle<PreisDto>
              beschriftung="Preistabelle"
              zeilen={sortierePreise(d.zeilen)}
              schluessel={(p) => p.id}
              spalten={[
                {
                  titel: 'Modell-Präfix',
                  wert: (p) => (
                    <>
                      <code className="text-xs">{p.modell_praefix}</code>
                      {p.herkunft === 'mandant' && (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs text-slate-600">
                          eigene Zeile
                        </span>
                      )}
                      {!p.aktiv && (
                        <span
                          className="ml-2 rounded bg-amber-50 px-1.5 text-xs text-amber-900"
                          title="Eine eigene Zeile des Mandanten mit gleichem Präfix geht vor."
                        >
                          überschrieben
                        </span>
                      )}
                    </>
                  ),
                },
                { titel: 'Gültig ab', wert: (p) => datum(p.gueltig_ab) },
                ...SATZ_FELDER.map(([feld, name]) => ({
                  titel: name,
                  wert: (p: PreisDto) => satz(p.saetze[feld]),
                  zahl: true,
                })),
                {
                  titel: 'Quelle',
                  wert: (p) => (
                    <a
                      href={p.quelle_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-slate-300 hover:decoration-slate-900"
                    >
                      Quelle
                    </a>
                  ),
                },
                { titel: 'Geprüft am', wert: (p) => datum(p.geprueft_am) },
              ]}
            />
          )}
        </Abfrage>
        {darfVerwalten && <PreisFormular />}
      </Abschnitt>

      <Abschnitt titel="Sitzkosten">
        <p className="mb-3 text-sm text-slate-600">
          Jeder Mandant startet mit den Listenpreisen für Claude Max: Max 5x 100 $ und Max 20x 200 $
          je Monat. Abweichende Preise als neue Zeile mit eigenem „Gültig ab“ eintragen.
        </p>
        <Abfrage
          abfrage={sitzkosten}
          istLeer={(d) => d.zeilen.length === 0}
          leerText="Noch keine Sitzkosten hinterlegt."
        >
          {(d) => (
            <Tabelle<SitzkostenZeile>
              beschriftung="Sitzkosten"
              zeilen={d.zeilen}
              schluessel={(s) => `${s.sitz_typ}:${s.gueltig_ab}`}
              spalten={[
                { titel: 'Sitztyp', wert: (s) => SITZ_NAMEN[s.sitz_typ] ?? s.sitz_typ },
                { titel: 'Gültig ab', wert: (s) => datum(s.gueltig_ab) },
                {
                  titel: 'Preis je Monat',
                  wert: (s) => geld(s.preis_monat, s.waehrung),
                  zahl: true,
                },
                {
                  titel: 'Abrechnung',
                  wert: (s) => ABRECHNUNG_NAMEN[s.abrechnung] ?? s.abrechnung,
                },
              ]}
            />
          )}
        </Abfrage>
        {darfVerwalten && <SitzkostenFormular />}
      </Abschnitt>

      <Abschnitt titel="Wechselkurs (EUR je USD)">
        <p className="mb-2 text-sm text-slate-600">
          Monatsmittel der EZB; im laufenden Monat das Mittel der bisherigen Tageskurse (vorläufig).
          Ein manuell gesetzter Kurs geht dem EZB-Wert vor.
        </p>
        <Abfrage
          abfrage={kurse}
          istLeer={(d) => d.zeilen.length === 0}
          leerText="Noch keine Kurse vorhanden."
        >
          {(d) => (
            <Tabelle<Kurs>
              beschriftung="Wechselkurse je Monat"
              zeilen={d.zeilen}
              schluessel={(k) => k.monat}
              spalten={KURS_SPALTEN}
            />
          )}
        </Abfrage>
        {darfVerwalten && (
          <>
            <EzbAbruf />
            <KursFormular />
          </>
        )}
      </Abschnitt>
    </section>
  );
}

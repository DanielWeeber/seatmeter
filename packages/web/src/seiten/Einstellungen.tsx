// Einstellungen: Mandant (Name, Plan, Aufbewahrung, lesend), Kalkulation und Datenschutz
// (GET/PUT /api/v1/mandant/einstellungen; ändern nur Mandanten-Admins, der Server protokolliert jede
// Änderung) und Anmeldestatus.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useMandant, useMandantEinstellungen } from '../api/abfragen';
import { ApiFehler, useApi } from '../api/client';
import {
  CACHE_WRITE_ANNAHMEN,
  mandantEinstellungenSchema,
  SITZKOSTEN_VERTEILUNGEN,
  WAEHRUNGEN,
  type Mandant,
  type MandantEinstellungen,
  type Rolle,
} from '../api/typen';
import { useAuth } from '../auth/AuthTor';
import { Abfrage } from '../komponenten/Abfrage';
import { Abschnitt, Seitenkopf, Werte } from '../komponenten/Bausteine';
import {
  Auswahl,
  Eingabe,
  fehlerBeimSpeichern,
  Formular,
  Kontrollkaestchen,
} from '../komponenten/Formular';
import { alsEingabe, alsZahl, dezimalzahl, LEER, prozent, zahl } from '../format';
import { CACHE_ANNAHME_TEXT, STUFEN_TEXT, VERTEILUNG_TEXT } from '../texte';

const PLAENE: Record<string, string> = {
  team: 'Team',
  enterprise: 'Enterprise',
  max_pilot: 'Max (Pilot)',
};
/** Anmeldewege laut `AuthMe.provider` (server auth/kontext.ts); Plugin-Provider zeigen ihren Namen. */
const PROVIDER: Record<string, string> = {
  lokal: 'Lokales Konto',
  remote_user: 'Vertrauenswürdiger Proxy',
  oidc: 'Single Sign-on (OIDC)',
};
const ROLLEN: Record<Rolle, string> = {
  mandanten_admin: 'Mandanten-Admin',
  projektleiter: 'Projektleitung',
  controller: 'Controller/Leser',
  betriebsrat: 'Betriebsrat',
};

type Feld = keyof MandantEinstellungen;

function aufbewahrung(m: Mandant): [string, ReactNode][] {
  const eintraege: [string, ReactNode][] = [];
  if (m.aufbewahrung_anfrage_tage != null)
    eintraege.push(['Einzelanfragen', `${zahl(m.aufbewahrung_anfrage_tage)} Tage`]);
  if (m.aufbewahrung_aggregat_monate != null)
    eintraege.push(['Tagesaggregate', `${zahl(m.aufbewahrung_aggregat_monate)} Monate`]);
  if (m.aufbewahrung_abschluss_monate != null)
    eintraege.push(['Monatsabschlüsse', `${zahl(m.aufbewahrung_abschluss_monate)} Monate`]);
  return eintraege;
}

function Anmeldestatus() {
  const { me, kannAbmelden, abmelden, abmeldenLaeuft } = useAuth();
  if (!me)
    return (
      <p className="rounded border border-slate-200 bg-white p-4 text-slate-700">
        Die Anmeldung ist im Server noch nicht aktiv; den Zugang schützt derzeit der vorgeschaltete
        Proxy.
      </p>
    );
  return (
    <>
      <Werte
        eintraege={[
          ['Angemeldet als', me.benutzer.benutzername],
          ['Rollen', me.rollen.length ? me.rollen.map((r) => ROLLEN[r]).join(', ') : LEER],
          ['Anmeldeart', PROVIDER[me.provider] ?? me.provider],
          ...(me.mandant ? ([['Mandant', me.mandant.name]] as [string, string][]) : []),
        ]}
      />
      {kannAbmelden && (
        <button
          type="button"
          onClick={abmelden}
          disabled={abmeldenLaeuft}
          className="mt-3 rounded border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-100 disabled:opacity-50"
        >
          Abmelden
        </button>
      )}
    </>
  );
}

function EinstellungenLesend({ e }: { e: MandantEinstellungen }) {
  return (
    <Werte
      eintraege={[
        ['Auswertungsstufe', STUFEN_TEXT[e.auswertungsstufe] ?? String(e.auswertungsstufe)],
        ['Klarnamen', e.klarnamen_aktiv ? 'aktiv' : 'aus'],
        ['Zeitzone', e.zeitzone],
        ['Währung', e.waehrung],
        [
          'Sitzkosten-Verteilung',
          VERTEILUNG_TEXT[e.sitzkosten_verteilung] ?? e.sitzkosten_verteilung,
        ],
        ['Code-Anteil am Sitz', prozent(e.code_anteil_sitz * 100)],
        ['Schattenfaktor', dezimalzahl(e.schatten_faktor)],
        ['Cache-Annahme', CACHE_ANNAHME_TEXT[e.cache_write_annahme] ?? e.cache_write_annahme],
      ]}
    />
  );
}

interface FormWerte {
  zeitzone: string;
  waehrung: string;
  sitzkosten_verteilung: string;
  code_anteil_sitz: string;
  schatten_faktor: string;
  cache_write_annahme: string;
  auswertungsstufe: string;
  klarnamen_aktiv: boolean;
}

function formAus(e: MandantEinstellungen): FormWerte {
  return {
    zeitzone: e.zeitzone,
    waehrung: e.waehrung,
    sitzkosten_verteilung: e.sitzkosten_verteilung,
    code_anteil_sitz: alsEingabe(e.code_anteil_sitz),
    schatten_faktor: alsEingabe(e.schatten_faktor),
    cache_write_annahme: e.cache_write_annahme,
    auswertungsstufe: String(e.auswertungsstufe),
    klarnamen_aktiv: e.klarnamen_aktiv,
  };
}

/** Nur die geänderten Felder (PUT nimmt Teilmengen an). */
function aenderungen(
  neu: MandantEinstellungen,
  alt: MandantEinstellungen,
): Partial<MandantEinstellungen> {
  const aus: Record<string, unknown> = {};
  for (const feld of Object.keys(neu) as Feld[]) {
    if (neu[feld] !== alt[feld]) aus[feld] = neu[feld];
  }
  return aus as Partial<MandantEinstellungen>;
}

function EinstellungenFormular({ daten }: { daten: MandantEinstellungen }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [f, setF] = useState<FormWerte>(() => formAus(daten));
  const [feldFehler, setFeldFehler] = useState<Partial<Record<Feld, string>>>({});
  const [meldung, setMeldung] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState<string | null>(null);

  const speichern = useMutation({
    mutationFn: (koerper: Partial<MandantEinstellungen>) =>
      api.put('/api/v1/mandant/einstellungen', koerper, mandantEinstellungenSchema),
    onSuccess: async (neu) => {
      queryClient.setQueryData(['mandant', 'einstellungen'], neu);
      setErfolg('Gespeichert.');
      await queryClient.invalidateQueries({ queryKey: ['kalkulation'] });
      await queryClient.invalidateQueries({ queryKey: ['auth', 'mandant'] });
    },
    onError: (fehler) => {
      if (fehler instanceof ApiFehler && fehler.status === 400 && fehler.details.length > 0) {
        const je: Partial<Record<Feld, string>> = {};
        for (const d of fehler.details) {
          if (d.feld && d.feld in daten && !je[d.feld as Feld]) je[d.feld as Feld] = d.meldung;
        }
        setFeldFehler(je);
      }
      setMeldung(fehlerBeimSpeichern(fehler));
    },
  });

  const setze = <K extends keyof FormWerte>(feld: K, wert: FormWerte[K]) => {
    setF((alt) => ({ ...alt, [feld]: wert }));
    setErfolg(null);
  };

  const absenden = () => {
    setErfolg(null);
    setMeldung(null);
    const ergebnis = mandantEinstellungenSchema.safeParse({
      zeitzone: f.zeitzone,
      waehrung: f.waehrung,
      sitzkosten_verteilung: f.sitzkosten_verteilung,
      code_anteil_sitz: alsZahl(f.code_anteil_sitz),
      schatten_faktor: alsZahl(f.schatten_faktor),
      cache_write_annahme: f.cache_write_annahme,
      auswertungsstufe: Number(f.auswertungsstufe),
      klarnamen_aktiv: f.klarnamen_aktiv,
    });
    if (!ergebnis.success) {
      const je: Partial<Record<Feld, string>> = {};
      for (const issue of ergebnis.error.issues) {
        const feld = issue.path[0];
        if (typeof feld === 'string' && !je[feld as Feld]) je[feld as Feld] = issue.message;
      }
      setFeldFehler(je);
      setMeldung('Bitte die markierten Felder prüfen.');
      return;
    }
    setFeldFehler({});
    const patch = aenderungen(ergebnis.data, daten);
    if (Object.keys(patch).length === 0) {
      setErfolg('Keine Änderung.');
      return;
    }
    speichern.mutate(patch);
  };

  const heikel =
    (f.klarnamen_aktiv && !daten.klarnamen_aktiv) ||
    (f.auswertungsstufe === '3' && daten.auswertungsstufe !== 3);

  return (
    <Formular
      titel="Einstellungen ändern"
      onAbsenden={absenden}
      laeuft={speichern.isPending}
      meldung={meldung}
      erfolg={erfolg}
    >
      <Eingabe
        beschriftung="Zeitzone"
        wert={f.zeitzone}
        onAendern={(w) => setze('zeitzone', w)}
        fehler={feldFehler.zeitzone}
      />
      <Auswahl
        beschriftung="Währung"
        wert={f.waehrung}
        onAendern={(w) => setze('waehrung', w)}
        optionen={WAEHRUNGEN.map((w) => [w, w] as const)}
        fehler={feldFehler.waehrung}
      />
      <Auswahl
        beschriftung="Sitzkosten-Verteilung"
        wert={f.sitzkosten_verteilung}
        onAendern={(w) => setze('sitzkosten_verteilung', w)}
        optionen={SITZKOSTEN_VERTEILUNGEN.map((v) => [v, VERTEILUNG_TEXT[v] ?? v] as const)}
        fehler={feldFehler.sitzkosten_verteilung}
      />
      <Eingabe
        beschriftung="Code-Anteil am Sitz (0 bis 1)"
        wert={f.code_anteil_sitz}
        dezimal
        onAendern={(w) => setze('code_anteil_sitz', w)}
        fehler={feldFehler.code_anteil_sitz}
      />
      <Eingabe
        beschriftung="Schattenfaktor"
        wert={f.schatten_faktor}
        dezimal
        onAendern={(w) => setze('schatten_faktor', w)}
        fehler={feldFehler.schatten_faktor}
      />
      <Auswahl
        beschriftung="Cache-Annahme (ohne 5m/1h-Aufteilung)"
        wert={f.cache_write_annahme}
        onAendern={(w) => setze('cache_write_annahme', w)}
        optionen={CACHE_WRITE_ANNAHMEN.map((c) => [c, CACHE_ANNAHME_TEXT[c] ?? c] as const)}
        fehler={feldFehler.cache_write_annahme}
      />
      <Auswahl
        beschriftung="Auswertungsstufe"
        wert={f.auswertungsstufe}
        onAendern={(w) => setze('auswertungsstufe', w)}
        optionen={[0, 1, 2, 3].map((s) => [String(s), STUFEN_TEXT[s] ?? String(s)] as const)}
        fehler={feldFehler.auswertungsstufe}
      />
      <Kontrollkaestchen
        beschriftung="Klarnamen aktiv"
        wert={f.klarnamen_aktiv}
        onAendern={(w) => setze('klarnamen_aktiv', w)}
      />
      {heikel && (
        <p className="text-sm text-amber-900 sm:col-span-2 lg:col-span-4">
          Klarnamen und Stufe 3 nur mit Betriebsvereinbarung bzw. Zustimmung des Betriebsrats; die
          Änderung wird protokolliert und erscheint im Betriebsrats-Bericht.
        </p>
      )}
    </Formular>
  );
}

export function Einstellungen() {
  const { darfVerwalten } = useAuth();
  const mandant = useMandant();
  const einstellungen = useMandantEinstellungen();
  return (
    <section>
      <Seitenkopf titel="Einstellungen" />
      <Abschnitt titel="Mandant">
        <Abfrage abfrage={mandant}>
          {(m) => (
            <>
              <Werte
                eintraege={[
                  ['Name', m.name ?? LEER],
                  ['Plan', m.plan ? (PLAENE[m.plan] ?? m.plan) : LEER],
                ]}
              />
              {aufbewahrung(m).length > 0 && (
                <div className="mt-4">
                  <h3 className="mb-2 font-semibold">Aufbewahrung</h3>
                  <Werte eintraege={aufbewahrung(m)} />
                </div>
              )}
            </>
          )}
        </Abfrage>
      </Abschnitt>
      <Abschnitt titel="Kalkulation und Datenschutz">
        <Abfrage abfrage={einstellungen}>
          {(e) =>
            darfVerwalten ? (
              <EinstellungenFormular daten={e} />
            ) : (
              <>
                <EinstellungenLesend e={e} />
                <p className="mt-2 text-sm text-slate-600">
                  Nur lesend. Änderungen nehmen Mandanten-Admins vor.
                </p>
              </>
            )
          }
        </Abfrage>
      </Abschnitt>
      <Abschnitt titel="Anmeldung">
        <Anmeldestatus />
      </Abschnitt>
    </section>
  );
}

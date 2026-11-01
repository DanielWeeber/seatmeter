// Seiten „Projektkatalog“ (Einrichtung), „Projektkosten“ (Auswertung) und die Auswahlseite hinter dem Link des
// Hooks mit Fixture-Antworten; dazu die Hinweisseite für Konten, die nur Projekte wählen dürfen.
import {
  katalogEinstellungSchema,
  katalogKostenAntwortSchema,
  katalogListeSchema,
  katalogBaumBauen,
  katalogZuordnungAntwortSchema,
  projektwahlAntwortSchema,
  type KatalogEinstellung,
  type KatalogKostenAntwort,
  type KatalogKurz,
  type KatalogListe,
  type KatalogToken,
  type KatalogZuordnungAntwort,
  type ProjektwahlAntwort,
} from '@seatmeter/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { TEXT_NUR_PROJEKTWAHL } from '../../auth/AuthTor';
import { ssoStart } from '../../auth/Formulare';
import { json, kennzahlen, ME_ADMIN, ME_LESER, MONAT, rendereApp } from '../../test/index';
import { AUSWAHL_MAX_TREFFER, filtereBaum, ProjektAuswahl, projektText } from './ProjektAuswahl';
import {
  TEXT_BREMSE,
  TEXT_DEAKTIVIERUNG_UEBERSPRUNGEN,
  TEXT_NICHT_ERREICHBAR,
  TEXT_SYNC_VERALTET,
} from './Projektkatalog';
import { TEXT_ZURUECK } from './Projektwahl';

const K1 = '00000000-0000-4000-8000-000000000a01';
const K2 = '00000000-0000-4000-8000-000000000a02';
const K3 = '00000000-0000-4000-8000-000000000a03';
const R1 = '00000000-0000-4000-8000-000000000b01';
const R2 = '00000000-0000-4000-8000-000000000b02';

const kurz = (
  id: string,
  nummer: string,
  name: string,
  kunde: string | null,
  extra: Partial<KatalogKurz> = {},
): KatalogKurz => ({
  id,
  externe_id: nummer,
  nummer,
  name,
  pfad: name,
  parent_externe_id: null,
  kunde,
  aktiv: true,
  ...extra,
});

const KURZ: KatalogKurz[] = [
  kurz(K1, 'P-100', 'Webshop', 'Muster AG'),
  kurz(K2, 'P-200', 'Portal', 'Beispiel GmbH'),
  kurz(K3, 'P-300', 'Interne Werkzeuge', null),
];

const LISTE = {
  projekte: KURZ.map((p) => ({
    ...p,
    status: null,
    quelle: 'csv',
    zuletzt_gesehen: '2026-10-30T08:00:00.000Z',
  })),
} satisfies KatalogListe;

const EINSTELLUNG = {
  stufe: 'aus',
  kontakt: null,
  hinderung: null,
  auswahl_erreichbar: true,
  inaktiv_status: ['closed', 'archived'],
  sync: {
    status: 'ok',
    zuletzt_sync: '2026-10-30T08:00:00.000Z',
    warnung_stunden: 48,
    deaktivieren_tage: null,
    deaktivieren_max_prozent: 25,
    bremse_aktiv: false,
    tage: [{ tag: '2026-10-30', neu: 1, aktualisiert: 2, unveraendert: 30, abgelehnt: 4 }],
  },
  zuletzt_import: '2026-10-30T08:00:00.000Z',
  import_quelle: 'csv',
  projekte_aktiv: 3,
  projekte_gesamt: 4,
} satisfies KatalogEinstellung;

const ZUORDNUNG = {
  zuordnung: [
    { projekt_id: R1, projekt_name: 'firma/shop', katalog: KURZ[0] ?? null },
    { projekt_id: R2, projekt_name: 'firma/portal', katalog: null },
  ],
} satisfies KatalogZuordnungAntwort;

const IMPORT_TOKEN = {
  id: K1,
  bezeichnung: 'Nachtlauf',
  praefix: 'smk_abcd1234',
  scope: 'katalog_api',
  erstellt: '2026-10-30T08:00:00.000Z',
  zuletzt_genutzt: null,
  widerrufen: null,
} satisfies KatalogToken;

const NULLEN = kennzahlen({ input: 0, output: 0, cache_read: 0, cache_write: 0 }, 0, 0);
const KOSTEN = {
  monat: MONAT,
  quelle: 'live',
  projekte: [
    {
      externe_id: 'P-100',
      nummer: 'P-100',
      name: 'Webshop',
      pfad: 'Webshop',
      kunde: 'Muster AG',
      repos: [
        {
          id: R1,
          name: 'firma/shop',
          ...kennzahlen({ input: 900, output: 0, cache_read: 0, cache_write: 0 }, 2, 30_000_000),
        },
      ],
      ohne_repo: kennzahlen({ input: 100, output: 0, cache_read: 0, cache_write: 0 }, 1, 5_000_000),
      sitzungen_ohne_repo: 1,
      ...kennzahlen({ input: 1000, output: 0, cache_read: 0, cache_write: 0 }, 3, 35_000_000),
    },
  ],
  offen: {
    repos: [
      {
        id: R2,
        name: 'firma/portal',
        ...kennzahlen({ input: 50, output: 0, cache_read: 0, cache_write: 0 }, 1, 1_000_000),
      },
    ],
    ohne_repo: NULLEN,
  },
} satisfies KatalogKostenAntwort;

const WAHL = {
  ziel: { art: 'repo', name: 'firma/shop' },
  gueltig_bis: '2026-11-01T12:00:00.000Z',
  projekte: KURZ,
  zugeordnet: null,
} satisfies ProjektwahlAntwort;

const TOKEN = 'abc.def';
const WAHL_PFAD = `/api/v1/projektwahl?token=${TOKEN}`;
const ME_ENTWICKLER = {
  ...ME_LESER,
  rollen: ['entwickler'],
  mandanten: [{ id: 'm-1', name: 'Beispiel GmbH', slug: 'beispiel', rollen: ['entwickler'] }],
};

describe('Fixtures erfüllen den Vertrag', () => {
  it('alle Antworten', () => {
    expect(katalogListeSchema.parse(LISTE)).toEqual(LISTE);
    expect(katalogEinstellungSchema.parse(EINSTELLUNG)).toEqual(EINSTELLUNG);
    expect(katalogZuordnungAntwortSchema.parse(ZUORDNUNG)).toEqual(ZUORDNUNG);
    expect(katalogKostenAntwortSchema.parse(KOSTEN)).toEqual(KOSTEN);
    expect(projektwahlAntwortSchema.parse(WAHL)).toEqual(WAHL);
  });
});

describe('Projektliste als Baum', () => {
  const K4 = '00000000-0000-4000-8000-000000000a04';
  const K5 = '00000000-0000-4000-8000-000000000a05';
  const K6 = '00000000-0000-4000-8000-000000000a06';
  const BAUM: KatalogKurz[] = [
    // Absichtlich Kind vor Elternprojekt.
    kurz(K2, 'W-1', 'AP Login', 'Muster AG', {
      parent_externe_id: 'W',
      pfad: 'Webshop › AP Login',
    }),
    kurz(K1, 'W', 'Webshop', 'Muster AG'),
    kurz(K3, 'W-1-1', 'Passwort', 'Muster AG', {
      parent_externe_id: 'W-1',
      pfad: 'Webshop › AP Login › Passwort',
    }),
    kurz(K4, 'A', 'Archiv', null, { aktiv: false }),
    kurz(K5, 'A-1', 'Nachlauf', null, { parent_externe_id: 'A', pfad: 'Archiv › Nachlauf' }),
    kurz(K6, 'Z', 'Zentrale', 'Beispiel GmbH'),
  ];

  function Rahmen({ onWahl = () => undefined }: { onWahl?: (id: string) => void }) {
    const [gewaehlt, setGewaehlt] = useState<string | null>(null);
    return (
      <ProjektAuswahl
        projekte={BAUM}
        gewaehlt={gewaehlt}
        onWahl={(id) => {
          setGewaehlt(id);
          onWahl(id);
        }}
      />
    );
  }

  const zeilenTexte = (feld: HTMLElement) =>
    [...feld.children].filter((k) => k.tagName !== 'LEGEND').map((k) => k.textContent ?? '');

  it('zeigt Baumreihenfolge mit Einrückung; jede Ebene ist wählbar, inaktive Vorfahren nicht', () => {
    render(<Rahmen />);
    const feld = screen.getByRole('group', { name: 'Projekte' });
    expect(zeilenTexte(feld)).toEqual([
      'A – Archiv (inaktiv)',
      'A-1 – Nachlauf',
      'W – Webshop (Muster AG)',
      'W-1 – AP Login (Muster AG)',
      'W-1-1 – Passwort (Muster AG)',
      'Z – Zentrale (Beispiel GmbH)',
    ]);
    // Alle aktiven haben ein Optionsfeld, auch Eltern; das inaktive Archiv hat keins.
    expect(within(feld).getAllByRole('radio')).toHaveLength(5);
    expect(within(feld).getByLabelText('W – Webshop (Muster AG)')).toBeTruthy();
    expect(within(feld).queryByLabelText(/Archiv/)).toBeNull();
    expect(
      within(feld)
        .getByText(/Archiv/)
        .getAttribute('aria-disabled'),
    ).toBe('true');
    const einzug = (t: string) =>
      Number.parseFloat(within(feld).getByText(t).closest('label')?.style.paddingLeft ?? '0');
    expect(einzug('W – Webshop (Muster AG)')).toBeLessThan(einzug('W-1 – AP Login (Muster AG)'));
    expect(einzug('W-1 – AP Login (Muster AG)')).toBeLessThan(
      einzug('W-1-1 – Passwort (Muster AG)'),
    );
    // Gezählt wird, was wählbar ist.
    expect(screen.getByText(/5 von 5 Projekten/)).toBeTruthy();
  });

  it('die Suche behält die Vorfahren und zeigt aktive Nachfahren eines Treffers', () => {
    render(<Rahmen />);
    const feld = screen.getByRole('group', { name: 'Projekte' });
    const suche = screen.getByLabelText('Projekt suchen');
    fireEvent.change(suche, { target: { value: 'passwort' } });
    expect(zeilenTexte(feld)).toEqual([
      'W – Webshop (Muster AG)',
      'W-1 – AP Login (Muster AG)',
      'W-1-1 – Passwort (Muster AG)',
    ]);
    expect(screen.getByText(/1 von 5 Projekten/)).toBeTruthy();
    fireEvent.change(suche, { target: { value: 'webshop' } });
    expect(zeilenTexte(feld)).toEqual([
      'W – Webshop (Muster AG)',
      'W-1 – AP Login (Muster AG)',
      'W-1-1 – Passwort (Muster AG)',
    ]);
    expect(within(feld).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByText(/3 von 5 Projekten/)).toBeTruthy();
    // Aktives Kind unter inaktivem Elternprojekt bleibt wählbar, der Vorfahre steht deaktiviert dabei.
    fireEvent.change(suche, { target: { value: 'nachlauf' } });
    expect(zeilenTexte(feld)).toEqual(['A – Archiv (inaktiv)', 'A-1 – Nachlauf']);
    expect(within(feld).getAllByRole('radio')).toHaveLength(1);
    // Suche nach dem geschlossenen Projekt: ausgegraut, das offene Arbeitspaket darunter wählbar.
    fireEvent.change(suche, { target: { value: 'archiv' } });
    expect(zeilenTexte(feld)).toEqual(['A – Archiv (inaktiv)', 'A-1 – Nachlauf']);
    expect(within(feld).getAllByRole('radio')).toHaveLength(1);
    expect(within(feld).queryByLabelText(/Archiv/)).toBeNull();
    expect(screen.getByText(/1 von 5 Projekten/)).toBeTruthy();
  });

  it('inaktiv ohne Aktives darunter: weder in der Standardansicht noch in der Suche', () => {
    const projekte = [
      kurz('z1', 'Z', 'Sackgasse', null, { aktiv: false, externe_id: 'z' }),
      kurz('z2', 'Z-1', 'Auch zu', null, {
        aktiv: false,
        externe_id: 'z-1',
        parent_externe_id: 'z',
      }),
      kurz('o1', 'O', 'Offen', null, { externe_id: 'o' }),
    ];
    render(<ProjektAuswahl projekte={projekte} gewaehlt={null} onWahl={() => undefined} />);
    const feld = screen.getByRole('group', { name: 'Projekte' });
    expect(zeilenTexte(feld)).toEqual(['O – Offen']);
    const suche = screen.getByLabelText('Projekt suchen');
    fireEvent.change(suche, { target: { value: 'sackgasse' } });
    expect(zeilenTexte(feld)).toEqual(['Kein Projekt gefunden.']);
    fireEvent.change(suche, { target: { value: 'auch zu' } });
    expect(zeilenTexte(feld)).toEqual(['Kein Projekt gefunden.']);
  });

  it('der Kundenfilter nimmt Nachfahren ohne eigenen Kunden mit, solche mit anderem Kunden nicht', () => {
    const projekte = [
      kurz('p1', 'P', 'Oben', 'Muster AG', { externe_id: 'p' }),
      kurz('p2', 'P-1', 'Ohne Kunde', null, { externe_id: 'p-1', parent_externe_id: 'p' }),
      kurz('p3', 'P-2', 'Fremd', 'Beispiel GmbH', { externe_id: 'p-2', parent_externe_id: 'p' }),
    ];
    render(<ProjektAuswahl projekte={projekte} gewaehlt={null} onWahl={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Kunde'), { target: { value: 'Muster AG' } });
    const feld = screen.getByRole('group', { name: 'Projekte' });
    expect(zeilenTexte(feld)).toEqual(['P – Oben (Muster AG)', 'P-1 – Ohne Kunde']);
  });

  it('10 000 Einträge, drei Viertel inaktiv: höchstens 100 Zeilen mit Hinweis, Rendern und Suche messbar klein', () => {
    const viele: KatalogKurz[] = Array.from({ length: 10_000 }, (_, i) =>
      kurz(`id-${i}`, `P-${i}`, `Projekt ${i}`, `Kunde ${i % 50}`, {
        externe_id: `e-${i}`,
        parent_externe_id: i % 4 === 0 ? `nie-${i}` : `e-${i - (i % 4)}`,
        aktiv: i % 4 === 3,
      }),
    );
    const a = performance.now();
    render(<ProjektAuswahl projekte={viele} gewaehlt={null} onWahl={() => undefined} />);
    const b = performance.now();
    fireEvent.change(screen.getByLabelText('Projekt suchen'), { target: { value: 'projekt 1' } });
    const c = performance.now();
    console.log(
      `Auswahl 10000 (75 % inaktiv): erstes Rendern ${(b - a).toFixed(0)} ms, Suche ${(c - b).toFixed(0)} ms`,
    );
    expect(screen.getAllByRole('radio').length).toBeLessThanOrEqual(AUSWAHL_MAX_TREFFER);
    expect(screen.getByText(/bitte Suche eingrenzen/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Projekt suchen'), {
      target: { value: 'projekt 9996' },
    });
    // Die geschlossene Wurzel 9996 führt zum offenen Kind 9999.
    const feld = screen.getByRole('group', { name: 'Projekte' });
    expect(zeilenTexte(feld)).toEqual([
      'P-9996 – Projekt 9996 (Kunde 46) (inaktiv)',
      'P-9999 – Projekt 9999 (Kunde 49)',
    ]);
  });

  it('der Kundenfilter wirkt mit Vorfahren; die Wahl zeigt den vollen Pfad', () => {
    const gewaehlt: string[] = [];
    render(<Rahmen onWahl={(id) => gewaehlt.push(id)} />);
    fireEvent.change(screen.getByLabelText('Kunde'), { target: { value: 'Muster AG' } });
    const feld = screen.getByRole('group', { name: 'Projekte' });
    expect(within(feld).getAllByRole('radio')).toHaveLength(3);
    fireEvent.click(within(feld).getByLabelText('W-1 – AP Login (Muster AG)'));
    expect(gewaehlt).toEqual([K2]);
    expect(screen.getByRole('status').textContent).toBe(
      'Gewählt: W-1 – Webshop › AP Login (Muster AG)',
    );
  });

  it('bleibt am Limit von 20 000 Projekten bedienbar: höchstens 100 Zeilen im DOM', () => {
    const viele: KatalogKurz[] = Array.from({ length: 20_000 }, (_, i) =>
      kurz(`id-${i}`, `P-${i}`, `Projekt ${i}`, `Kunde ${i % 50}`, {
        externe_id: `e-${i}`,
        parent_externe_id: i % 4 === 0 ? null : `e-${i - 1}`,
      }),
    );
    const a = performance.now();
    render(<ProjektAuswahl projekte={viele} gewaehlt={null} onWahl={() => undefined} />);
    const b = performance.now();
    fireEvent.change(screen.getByLabelText('Projekt suchen'), {
      target: { value: 'projekt 19999' },
    });
    const c = performance.now();
    console.log(
      `Auswahl 20000: erstes Rendern ${(b - a).toFixed(0)} ms, Suche ${(c - b).toFixed(0)} ms`,
    );
    expect(screen.getAllByRole('radio').length).toBeLessThanOrEqual(AUSWAHL_MAX_TREFFER);
    expect(screen.getByText(/1 von 20000 Projekten/)).toBeTruthy();
  });

  it('die Bestätigung nennt den Pfad', () => {
    expect(projektText(BAUM[2] as KatalogKurz)).toBe(
      'W-1-1 – Webshop › AP Login › Passwort (Muster AG)',
    );
  });
});

describe('Suche in der Projektliste', () => {
  it('findet über Nummer, Name und Kunde, alle Wörter müssen passen', () => {
    const treffer = (s: string, k = '') =>
      filtereBaum(katalogBaumBauen(KURZ), s, k).map((z) => z.projekt.nummer);
    // Wurzeln nach Name.
    expect(treffer('')).toEqual(['P-300', 'P-200', 'P-100']);
    expect(treffer('p-2')).toEqual(['P-200']);
    expect(treffer('webshop')).toEqual(['P-100']);
    expect(treffer('muster web')).toEqual(['P-100']);
    expect(treffer('muster portal')).toEqual([]);
    expect(treffer('', 'Beispiel GmbH')).toEqual(['P-200']);
  });

  describe('„ral“ mitten im Wort', () => {
    const LISTE_RAL = [
      kurz('r1', 'Z-1', 'Zentrale Dienste', null),
      kurz('r2', 'G-1', 'GENERAL Portal', null),
      kurz('r3', 'RAL-7', 'Nummer passt', null),
      kurz('r4', 'K-1', 'Kunde passt', 'Mineralwerk AG'),
      kurz('r5', 'X-1', 'Ohne Bezug', 'Beispiel GmbH'),
    ];
    const treffer = (s: string) =>
      filtereBaum(katalogBaumBauen(LISTE_RAL), s, '').map((z) => z.projekt.nummer);

    it('findet in Nummer, Name und Kunde, Groß-/Kleinschreibung egal; ohne die Zeichenfolge nicht', () => {
      expect(treffer('ral').sort()).toEqual(['G-1', 'K-1', 'RAL-7', 'Z-1']);
      expect(treffer('RAL').sort()).toEqual(['G-1', 'K-1', 'RAL-7', 'Z-1']);
      expect(treffer('rAl')).not.toContain('X-1');
    });

    it('zwei Wörter in umgekehrter Reihenfolge, auch über Felder hinweg', () => {
      expect(treffer('dienste zentrale')).toEqual(['Z-1']);
      expect(treffer('PORTAL ral')).toEqual(['G-1']);
      expect(treffer('werk k-1')).toEqual(['K-1']);
      expect(treffer('bezug ral')).toEqual([]);
    });

    it('in der Oberfläche: Eingabe zeigt genau diese Zeilen', () => {
      render(<ProjektAuswahl projekte={LISTE_RAL} gewaehlt={null} onWahl={() => undefined} />);
      fireEvent.change(screen.getByLabelText('Projekt suchen'), { target: { value: 'ral' } });
      const feld = screen.getByRole('group', { name: 'Projekte' });
      expect(within(feld).getAllByRole('radio')).toHaveLength(4);
      expect(within(feld).getByLabelText('Z-1 – Zentrale Dienste')).toBeTruthy();
      expect(within(feld).getByLabelText('G-1 – GENERAL Portal')).toBeTruthy();
      expect(within(feld).queryByText(/Ohne Bezug/)).toBeNull();
    });
  });
});

describe('Seite Projektkatalog (Einrichtung)', () => {
  const routen = {
    '/api/v1/projektkatalog/einstellung': json(EINSTELLUNG),
    '/api/v1/projektkatalog/zuordnung': json(ZUORDNUNG),
    '/api/v1/projektkatalog/projekte': json(LISTE),
    '/api/v1/projektkatalog/tokens': json({ tokens: [] }),
  };

  it('zeigt Stand, Zuordnung und ist nicht im Menü für Leser', async () => {
    rendereApp('/einrichtung/projektkatalog', routen);
    const tabelle = await screen.findByRole('table', { name: 'Zuordnung Repo zu Projekt' });
    expect(within(tabelle).getByText('firma/shop')).toBeTruthy();
    expect(within(tabelle).getByText('P-100 – Webshop (Muster AG)')).toBeTruthy();
    expect(within(tabelle).getByText('nicht zugeordnet')).toBeTruthy();
    expect(screen.getByText('Aktive Projekte')).toBeTruthy();
  });

  it('ordnet ein Repo über die durchsuchbare Liste zu, ohne Eintrag „Kein Projekt“', async () => {
    const { aufrufe } = rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      'PUT /api/v1/projektkatalog/zuordnung': json({ geaendert: 1 }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Projekt für firma/portal ändern' }));
    const suche = await screen.findByLabelText('Projekt suchen');
    await waitFor(() => expect(screen.getByRole('radio', { name: /P-200/ })).toBeTruthy());
    expect(screen.queryByRole('radio', { name: /Kein Projekt/ })).toBeNull();
    fireEvent.change(suche, { target: { value: 'portal' } });
    expect(screen.queryByRole('radio', { name: /P-100/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /P-200/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => {
      const r = aufrufe.find((a) => a.methode === 'PUT');
      expect(r?.body).toEqual({
        zuordnung: [{ projekt_id: R2, katalog_projekt_id: K2 }],
      });
    });
  });

  it('schaltet die Stufe und warnt bei leerem Katalog', async () => {
    const { aufrufe } = rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      '/api/v1/projektkatalog/einstellung': json({
        ...EINSTELLUNG,
        stufe: 'warnen',
        projekte_aktiv: 0,
      }),
      'PUT /api/v1/projektkatalog/einstellung': json({ ...EINSTELLUNG, stufe: 'blockieren' }),
    });
    expect(await screen.findByText(/Der Katalog ist leer/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Stufe der Projektwahl'), {
      target: { value: 'blockieren' },
    });
    await waitFor(() => {
      const r = aufrufe.find((a) => a.methode === 'PUT');
      expect(r?.body).toEqual({ stufe: 'blockieren' });
    });
  });

  it('zeigt die letzte Synchronisation, Zähler und warnt, wenn sie ausbleibt', async () => {
    const { aufrufe } = rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      '/api/v1/projektkatalog/einstellung': json({
        ...EINSTELLUNG,
        sync: { ...EINSTELLUNG.sync, status: 'veraltet', bremse_aktiv: true },
      }),
      'PUT /api/v1/projektkatalog/einstellung': json(EINSTELLUNG),
    });
    expect(await screen.findByText(TEXT_SYNC_VERALTET)).toBeTruthy();
    expect(screen.getByText(TEXT_BREMSE)).toBeTruthy();
    expect(screen.getByText('1 neu, 2 aktualisiert, 30 unverändert, 4 abgelehnt')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Warnen nach Stunden/), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText(/Höchstens .* der aktiven gesendeten Projekte/), {
      target: { value: '40' },
    });
    fireEvent.change(screen.getByLabelText(/Status, die ein Projekt inaktiv machen/), {
      target: { value: 'Closed, erledigt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Synchronisation speichern' }));
    await waitFor(() => {
      expect(aufrufe.find((a) => a.methode === 'PUT')?.body).toEqual({
        sync_warnung_stunden: 12,
        sync_deaktivieren_tage: null,
        sync_deaktivieren_max_prozent: 40,
        inaktiv_status: ['Closed', 'erledigt'],
      });
    });
  });

  it('zeigt den rohen Status in der Projektübersicht', async () => {
    rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      '/api/v1/projektkatalog/projekte?aktiv=0': json({
        projekte: [{ ...LISTE.projekte[0], status: 'In Klärung' }],
      }),
    });
    const t = await screen.findByRole('table', { name: 'Projekte im Katalog' });
    expect(within(t).getByText('In Klärung')).toBeTruthy();
  });

  it('zeigt die Hinderung, bietet nur noch „Aus“ an und warnt, wenn niemand die Auswahl erreicht', async () => {
    rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      '/api/v1/projektkatalog/einstellung': json({
        ...EINSTELLUNG,
        hinderung: 'auto_rolle',
        auswahl_erreichbar: false,
      }),
    });
    expect(await screen.findByText(/SEATMETER_AUTO_ROLLE=entwickler/)).toBeTruthy();
    expect(screen.getByText(TEXT_NICHT_ERREICHBAR)).toBeTruthy();
    const auswahl = screen.getByLabelText<HTMLSelectElement>('Stufe der Projektwahl');
    expect([...auswahl.options].map((o) => o.value)).toEqual(['aus']);
  });

  it('speichert den Kontakt und zeigt die Ablehnung des Servers', async () => {
    const { aufrufe } = rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      'PUT /api/v1/projektkatalog/einstellung': json({ ...EINSTELLUNG, kontakt: 'IT-Hotline' }),
    });
    fireEvent.change(await screen.findByLabelText(/Kontakt bei fehlendem Zugang/), {
      target: { value: ' IT-Hotline ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kontakt speichern' }));
    await waitFor(() => {
      expect(aufrufe.find((a) => a.methode === 'PUT')?.body).toEqual({
        stufe: 'aus',
        kontakt: 'IT-Hotline',
      });
    });
  });

  it('importiert eine CSV-Datei und zeigt die Fehlermeldung des Servers', async () => {
    const { aufrufe } = rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      'POST /api/v1/projektkatalog/import/csv': json(
        { fehler: 'Die Datei enthält ungültige Zeilen. Zeile 2: Nummer fehlt.' },
        400,
      ),
    });
    const datei = await screen.findByLabelText('CSV-Datei wählen');
    fireEvent.change(datei, {
      target: { files: [new File(['Nummer;Name\n;x\n'], 'projekte.csv', { type: 'text/csv' })] },
    });
    await screen.findByText(/projekte\.csv/);
    fireEvent.click(screen.getByRole('button', { name: 'Importieren' }));
    expect(await screen.findByText(/Zeile 2: Nummer fehlt/)).toBeTruthy();
    const r = aufrufe.find((a) => a.methode === 'POST');
    expect(r?.body).toEqual({
      csv: 'Nummer;Name\n;x\n',
      vollstaendig: true,
      trockenlauf: false,
      trennzeichen: ';',
    });
  });

  it('lehnt eine Datei in Windows-1252 schon beim Laden ab, statt Umlaute zu verfälschen', async () => {
    rendereApp('/einrichtung/projektkatalog', routen);
    const datei = await screen.findByLabelText('CSV-Datei wählen');
    const bytes = Uint8Array.of(0x53, 0x74, 0x72, 0x61, 0xdf, 0x65);
    fireEvent.change(datei, {
      target: { files: [new File([bytes], 'alt.csv', { type: 'text/csv' })] },
    });
    expect(await screen.findByText(/nicht UTF-8-kodiert/)).toBeTruthy();
    expect(screen.queryByText(/alt\.csv/)).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Importieren' }).disabled).toBe(
      true,
    );
  });

  it('übersprungenes Deaktivieren ohne abgelehnte Zeile: Der Hinweis behauptet keine Ablehnung', async () => {
    rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      'POST /api/v1/projektkatalog/import/csv': json({
        neu: 1,
        aktualisiert: 0,
        unveraendert: 0,
        deaktiviert: 0,
        abgelehnt: 0,
        aktiv_gesamt: 1,
        abgelehnte_zeilen: [],
        hinweise: [
          'Zeile 2: Mehrzeiliger Text mit Trennzeichen, womöglich sind Zeilen verschluckt.',
        ],
        deaktivierung_uebersprungen: true,
        trockenlauf: false,
      }),
    });
    const datei = await screen.findByLabelText('CSV-Datei wählen');
    fireEvent.change(datei, {
      target: { files: [new File(['ID;Name\nP-1;Eins\n'], 'p.csv', { type: 'text/csv' })] },
    });
    await screen.findByText(/p\.csv/);
    fireEvent.click(screen.getByRole('button', { name: 'Importieren' }));
    expect(await screen.findByText(TEXT_DEAKTIVIERUNG_UEBERSPRUNGEN)).toBeTruthy();
    expect(TEXT_DEAKTIVIERUNG_UEBERSPRUNGEN).not.toMatch(/abgelehnt/i);
    expect(screen.getByText(/Zeile 2: Mehrzeiliger Text/)).toBeTruthy();
  });

  it('prüft ohne zu speichern, zeigt alle Zähler und lässt die Datei geladen', async () => {
    const { aufrufe } = rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      'POST /api/v1/projektkatalog/import/csv': json({
        neu: 1,
        aktualisiert: 2,
        unveraendert: 3,
        deaktiviert: 4,
        abgelehnt: 1,
        aktiv_gesamt: 6,
        abgelehnte_zeilen: ['Zeile 3: Nummer fehlt oder ist zu lang.'],
        hinweise: [
          'Zeile 5: Mehrzeiliger Text mit Trennzeichen, womöglich sind Zeilen verschluckt.',
        ],
        deaktivierung_uebersprungen: true,
        trockenlauf: true,
      }),
    });
    const datei = await screen.findByLabelText('CSV-Datei wählen');
    fireEvent.change(datei, {
      target: { files: [new File(['Kennung,Titel\nP-1,Eins\n'], 'p.csv', { type: 'text/csv' })] },
    });
    await screen.findByText(/p\.csv/);
    fireEvent.change(screen.getByLabelText('Trennzeichen'), { target: { value: ',' } });
    fireEvent.change(screen.getByLabelText('Spalte externe ID'), { target: { value: 'Kennung' } });
    expect(await screen.findByText(/Externe ID und Name sind Pflicht/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Spalte Name'), { target: { value: 'Titel' } });
    fireEvent.click(screen.getByLabelText('Nur prüfen, nichts speichern'));
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    expect(
      await screen.findByText(
        /Nur geprüft, nichts gespeichert: 1 neu, 2 aktualisiert, 3 unverändert, 4 deaktiviert, 1 abgelehnt; 6 aktive/,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Zeile 3: Nummer fehlt oder ist zu lang.')).toBeTruthy();
    expect(screen.getByText(/wurde in diesem Lauf nichts deaktiviert/)).toBeTruthy();
    expect(screen.getByText(/p\.csv/)).toBeTruthy();
    const r = aufrufe.find((a) => a.methode === 'POST');
    expect(r?.body).toEqual({
      csv: 'Kennung,Titel\nP-1,Eins\n',
      vollstaendig: true,
      trockenlauf: true,
      trennzeichen: ',',
      spalten: { id: 'Kennung', name: 'Titel' },
    });
  });

  it('Token-Zweck: auch nur den Sync-Status lesen lässt sich wählen', async () => {
    const { aufrufe } = rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      'POST /api/v1/projektkatalog/tokens': json(
        { ...IMPORT_TOKEN, scope: 'sync_status', token: `smk_${'x'.repeat(20)}` },
        201,
      ),
    });
    fireEvent.change(await screen.findByLabelText('Bezeichnung'), {
      target: { value: 'Monitoring' },
    });
    fireEvent.change(screen.getByLabelText('Zweck'), { target: { value: 'sync_status' } });
    fireEvent.click(screen.getByRole('button', { name: 'Token erzeugen' }));
    await waitFor(() => {
      expect(aufrufe.find((a) => a.methode === 'POST')?.body).toEqual({
        bezeichnung: 'Monitoring',
        scope: 'sync_status',
      });
    });
  });

  it('Import-Token: Klartext nur einmal, Liste ohne Klartext, Widerruf mit Rückfrage', async () => {
    const klartext = `smk_${'x'.repeat(20)}`;
    const { aufrufe } = rendereApp('/einrichtung/projektkatalog', {
      ...routen,
      '/api/v1/projektkatalog/tokens': json({ tokens: [IMPORT_TOKEN] }),
      'POST /api/v1/projektkatalog/tokens': json({ ...IMPORT_TOKEN, id: K2, token: klartext }, 201),
      [`DELETE /api/v1/projektkatalog/tokens/${K1}`]: { status: 204 },
    });
    expect(await screen.findByText('Nachtlauf')).toBeTruthy();
    expect(screen.queryByText(klartext)).toBeNull();
    fireEvent.change(screen.getByLabelText('Bezeichnung'), { target: { value: 'Nachtlauf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Token erzeugen' }));
    expect(await screen.findByText(klartext)).toBeTruthy();
    expect(aufrufe.find((a) => a.methode === 'POST')?.body).toEqual({
      bezeichnung: 'Nachtlauf',
      scope: 'katalog_api',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Token smk_abcd1234 widerrufen' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Token smk_abcd1234 endgültig widerrufen' }),
    );
    await waitFor(() => expect(aufrufe.some((a) => a.methode === 'DELETE')).toBe(true));
  });
});

describe('Seite Projektkosten (Auswertung)', () => {
  const routen = {
    [`/api/v1/projektkatalog/kosten?monat=${MONAT}`]: json(KOSTEN),
    '/api/v1/projektkatalog/zuordnung': json(ZUORDNUNG),
    '/api/v1/projektkatalog/projekte': json(LISTE),
  };

  it('zeigt Projekt mit Repos, Sitzungen ohne Repo, Offenes und den Export', async () => {
    rendereApp(`/projektkosten?monat=${MONAT}`, routen);
    expect(await screen.findByText('P-100 – Webshop')).toBeTruthy();
    expect(screen.getByText(/Ohne Repo: 1 Sitzungen/)).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Repos ohne Projekt' })).toBeTruthy();
    const csv = screen.getByRole('link', { name: 'Projektkosten als CSV herunterladen' });
    expect(csv.getAttribute('href')).toContain('format=csv');
  });

  it('nennt abgeschlossene Monate und blendet die Zuordnung für Leser aus', async () => {
    rendereApp(`/projektkosten?monat=${MONAT}`, {
      ...routen,
      '/api/v1/auth/me': json(ME_LESER),
      [`/api/v1/projektkatalog/kosten?monat=${MONAT}`]: json({
        ...KOSTEN,
        quelle: 'monatsabschluss',
      }),
    });
    expect(await screen.findByText(/Monat abgeschlossen/)).toBeTruthy();
    expect(screen.queryByText('Zuordnung Repo zu Projekt')).toBeNull();
  });
});

describe('Auswahlseite hinter dem Link', () => {
  const routen = { '/api/v1/auth/me': json(ME_ENTWICKLER), [WAHL_PFAD]: json(WAHL) };

  it('nur Entwicklung: wählt ein Projekt, sendet Link und Auswahl, sagt, wie es weitergeht', async () => {
    const { aufrufe } = rendereApp(`/projektwahl/${TOKEN}`, {
      ...routen,
      'POST /api/v1/projektwahl': json({ zugeordnet: KURZ[1] }),
    });
    expect(await screen.findByText('firma/shop')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
    const knopf = screen.getByRole('button', { name: 'Projekt zuordnen' }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /P-200/ }));
    fireEvent.click(knopf);
    expect(await screen.findByText(TEXT_ZURUECK)).toBeTruthy();
    expect(screen.getByText(/Zugeordnet zu P-200/)).toBeTruthy();
    const r = aufrufe.find((a) => a.methode === 'POST');
    expect(r?.body).toEqual({ token: TOKEN, katalog_projekt_id: K2 });
  });

  it('Ordner ohne Repo: Wahl gilt nur für die Sitzung', async () => {
    rendereApp(`/projektwahl/${TOKEN}`, {
      ...routen,
      [WAHL_PFAD]: json({ ...WAHL, ziel: { art: 'sitzung' } }),
    });
    expect(await screen.findByText(/Die Wahl gilt nur für diese Sitzung/)).toBeTruthy();
  });

  it('schon vergeben: zeigt die erste Wahl statt einer Auswahl', async () => {
    rendereApp(`/projektwahl/${TOKEN}`, {
      ...routen,
      [WAHL_PFAD]: json({ ...WAHL, zugeordnet: KURZ[0] }),
    });
    expect(await screen.findByText(/Zugeordnet zu P-100/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Projekt zuordnen' })).toBeNull();
  });

  it('abgelaufener oder fremder Link: Meldung des Servers', async () => {
    rendereApp(`/projektwahl/${TOKEN}`, {
      ...routen,
      [WAHL_PFAD]: json({ code: 'link_abgelaufen', fehler: 'Der Link ist abgelaufen.' }, 410),
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Der Link ist abgelaufen.')).toBeTruthy();
  });

  it('Mandanten-Admin kann die Seite ebenfalls nutzen', async () => {
    rendereApp(`/projektwahl/${TOKEN}`, { ...routen, '/api/v1/auth/me': json(ME_ADMIN) });
    expect(await screen.findByRole('button', { name: 'Projekt zuordnen' })).toBeTruthy();
  });

  it('kürzt lange Listen auf die ersten Treffer und nennt die Zahl', async () => {
    const viele: KatalogKurz[] = Array.from({ length: AUSWAHL_MAX_TREFFER + 5 }, (_, i) =>
      kurz(
        `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        `N-${i}`,
        `Projekt ${i}`,
        null,
      ),
    );
    rendereApp(`/projektwahl/${TOKEN}`, {
      ...routen,
      [WAHL_PFAD]: json({ ...WAHL, projekte: viele }),
    });
    expect(await screen.findByText(/die ersten 100 Zeilen angezeigt/)).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(AUSWAHL_MAX_TREFFER);
  });
});

describe('Konto nur mit Rolle Entwicklung', () => {
  it('sieht statt des Dashboards nur den Hinweis', async () => {
    rendereApp('/', { '/api/v1/auth/me': json(ME_ENTWICKLER) });
    expect(await screen.findByText(TEXT_NUR_PROJEKTWAHL)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
    expect(screen.queryByLabelText('Aktiver Mandant')).toBeNull();
  });

  it('mit mehreren Mandanten zeigt der Hinweis den Wechsel, sonst säße das Konto fest', async () => {
    const { aufrufe } = rendereApp('/', {
      '/api/v1/auth/me': json({
        ...ME_ENTWICKLER,
        mandanten: [
          ...ME_ENTWICKLER.mandanten,
          { id: 'm-2', name: 'Andere AG', slug: 'andere', rollen: ['mandanten_admin'] },
        ],
      }),
      'POST /api/v1/auth/mandant': json(ME_ADMIN),
    });
    const wahl = await screen.findByLabelText('Aktiver Mandant');
    fireEvent.change(wahl, { target: { value: 'm-2' } });
    await waitFor(() => {
      expect(aufrufe.find((a) => a.pfad === '/api/v1/auth/mandant')?.body).toEqual({
        mandant_id: 'm-2',
      });
    });
  });
});

describe('Rückweg nach der SSO-Anmeldung', () => {
  it('führt nur vom Link der Projektwahl zurück auf die Auswahlseite', () => {
    expect(ssoStart('/api/v1/auth/oidc/start', '/')).toBe('/api/v1/auth/oidc/start');
    expect(ssoStart('/api/v1/auth/oidc/start', '/projektkosten')).toBe('/api/v1/auth/oidc/start');
    expect(ssoStart('/api/v1/auth/oidc/start', '/projektwahl/a.b')).toBe(
      '/api/v1/auth/oidc/start?ziel=%2Fprojektwahl%2Fa.b',
    );
    expect(ssoStart('/api/v1/auth/oidc/start?mandant=x', '/projektwahl/a.b')).toBe(
      '/api/v1/auth/oidc/start?mandant=x&ziel=%2Fprojektwahl%2Fa.b',
    );
  });
});

// Seiten „Jira“ (Einrichtung) und „Jira-Kosten“ (Auswertung) mit Fixture-Antworten.
import {
  jiraKostenAntwortSchema,
  jiraVerbindungSchema,
  jiraZuordnungAntwortSchema,
  type JiraKostenAntwort,
  type JiraProjekteAntwort,
  type JiraVerbindung,
  type JiraZuordnungAntwort,
} from '@seatmeter/shared';
import { json, kennzahlen, MONAT, rendereApp } from '../../test/index';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const P1 = '00000000-0000-4000-8000-000000000101';
const P2 = '00000000-0000-4000-8000-000000000102';

const VERBINDUNG = {
  eingerichtet: true,
  basis_url: 'https://firma.atlassian.example',
  art: 'cloud',
  benutzer_email: 'jira-bot@example.com',
  token_gesetzt: true,
  aktiv: true,
  nur_zugeordnete: false,
  zuletzt_geprueft: '2026-10-23T08:00:00.000Z',
  fehler: null,
} satisfies JiraVerbindung;

const LEER = {
  ...VERBINDUNG,
  eingerichtet: false,
  basis_url: null,
  art: null,
  benutzer_email: null,
  token_gesetzt: false,
  aktiv: false,
  zuletzt_geprueft: null,
} satisfies JiraVerbindung;

const ZUORDNUNG = {
  zuordnung: [
    {
      projekt_id: P1,
      projekt_name: 'kunde/shop',
      jira_projekt_schluessel: 'ABC',
      jira_projekt_name: 'Alpha',
    },
    {
      projekt_id: P2,
      projekt_name: 'kunde/portal',
      jira_projekt_schluessel: null,
      jira_projekt_name: null,
    },
  ],
  issue_praefixe: null,
} satisfies JiraZuordnungAntwort;

const PROJEKTE = {
  projekte: [
    { schluessel: 'ABC', name: 'Alpha' },
    { schluessel: 'XYZ', name: 'Xylo' },
  ],
} satisfies JiraProjekteAntwort;

const KOSTEN = {
  monat: MONAT,
  jira_projekte: [
    {
      schluessel: 'ABC',
      name: 'Alpha',
      seatmeter_projekte: [{ id: P1, name: 'kunde/shop' }],
      ...kennzahlen({ input: 1500, output: 0, cache_read: 0, cache_write: 0 }, 3, 105_000_000),
      ohne_issue: kennzahlen(
        { input: 500, output: 0, cache_read: 0, cache_write: 0 },
        1,
        50_000_000,
      ),
      issues: [
        {
          schluessel: 'ABC-1',
          titel: 'Login reparieren',
          status: 'In Arbeit',
          gefunden: true,
          sitzungen: 3,
          ...kennzahlen({ input: 900, output: 0, cache_read: 0, cache_write: 0 }, 1, 45_000_000),
        },
        {
          schluessel: 'ABC-2',
          titel: null,
          status: null,
          gefunden: false,
          sitzungen: 1,
          ...kennzahlen({ input: 100, output: 0, cache_read: 0, cache_write: 0 }, 1, 10_000_000),
        },
      ],
    },
  ],
  titel: { nachgeladen: 0, offen: 1, fehler: 'Jira antwortet mit HTTP 500' },
} satisfies JiraKostenAntwort;

describe('Fixtures erfüllen den Vertrag', () => {
  it('Verbindung, Zuordnung, Kosten', () => {
    expect(jiraVerbindungSchema.parse(VERBINDUNG)).toEqual(VERBINDUNG);
    expect(jiraZuordnungAntwortSchema.parse(ZUORDNUNG)).toEqual(ZUORDNUNG);
    expect(jiraKostenAntwortSchema.parse(KOSTEN)).toEqual(KOSTEN);
  });
});

describe('Seite Jira (Einrichtung)', () => {
  const routen = {
    '/api/v1/jira/verbindung': json(VERBINDUNG),
    '/api/v1/jira/zuordnung': json(ZUORDNUNG),
    '/api/v1/jira/projekte': json(PROJEKTE),
  };

  it('zeigt Stand, Hinweis zur Schlüsselerkennung und nie das Token', async () => {
    rendereApp('/einrichtung/jira', routen);
    expect(await screen.findByText('aktiv')).toBeTruthy();
    expect(screen.getByText(/nie der Branch-Name/)).toBeTruthy();
    const token = screen.getByLabelText('API-Token') as HTMLInputElement;
    expect(token.value).toBe('');
    expect(token.placeholder).toBe('unverändert');
  });

  it('speichert die Verbindung ohne Token, wenn das Feld leer bleibt', async () => {
    const { aufrufe } = rendereApp('/einrichtung/jira', {
      ...routen,
      'PUT /api/v1/jira/verbindung': json({ ...VERBINDUNG, nur_zugeordnete: true }),
    });
    await screen.findByText('aktiv');
    fireEvent.click(screen.getByLabelText('Nur Schlüssel zugeordneter Jira-Projekte speichern'));
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung ändern' }));
    await waitFor(() => expect(aufrufe.find((a) => a.methode === 'PUT')).toBeTruthy());
    expect(aufrufe.find((a) => a.methode === 'PUT')?.body).toEqual({
      basis_url: 'https://firma.atlassian.example',
      art: 'cloud',
      benutzer_email: 'jira-bot@example.com',
      aktiv: true,
      nur_zugeordnete: true,
    });
  });

  it('prüft die Verbindung und zeigt das Ergebnis', async () => {
    rendereApp('/einrichtung/jira', {
      ...routen,
      'POST /api/v1/jira/verbindung/pruefen': json({
        ok: false,
        konto: null,
        fehler: 'Jira lehnt den Zugang ab (Token und Rechte prüfen)',
        zuletzt_geprueft: '2026-10-23T09:00:00.000Z',
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Verbindung prüfen' }));
    expect(
      await screen.findByText(/Prüfung fehlgeschlagen: Jira lehnt den Zugang ab/),
    ).toBeTruthy();
  });

  it('ordnet Projekte über das Dropdown aus den Jira-Projekten zu', async () => {
    const { aufrufe } = rendereApp('/einrichtung/jira', {
      ...routen,
      'PUT /api/v1/jira/zuordnung': json({ geaendert: 2, issue_praefixe: null }),
    });
    const auswahl = (await screen.findByLabelText(
      'Jira-Projekt für kunde/portal',
    )) as HTMLSelectElement;
    await waitFor(() => expect(within(auswahl).getByText('XYZ – Xylo')).toBeTruthy());
    fireEvent.change(auswahl, { target: { value: 'XYZ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zuordnung speichern' }));
    await waitFor(() =>
      expect(
        aufrufe.find((a) => a.methode === 'PUT' && a.pfad === '/api/v1/jira/zuordnung'),
      ).toBeTruthy(),
    );
    expect(
      aufrufe.find((a) => a.pfad === '/api/v1/jira/zuordnung' && a.methode === 'PUT')?.body,
    ).toEqual({
      zuordnung: [
        { projekt_id: P1, jira_projekt_schluessel: 'ABC', jira_projekt_name: 'Alpha' },
        { projekt_id: P2, jira_projekt_schluessel: 'XYZ', jira_projekt_name: 'Xylo' },
      ],
    });
    expect(await screen.findByText('Zuordnung gespeichert.')).toBeTruthy();
  });

  it('ohne Verbindung: Formular zum Einrichten, keine Projektabfrage', async () => {
    const { aufrufe } = rendereApp('/einrichtung/jira', {
      ...routen,
      '/api/v1/jira/verbindung': json(LEER),
    });
    expect(await screen.findByText('nicht eingerichtet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verbindung speichern' })).toBeTruthy();
    await screen.findByLabelText('Jira-Projekt für kunde/shop');
    expect(aufrufe.some((a) => a.pfad === '/api/v1/jira/projekte')).toBe(false);
  });
});

describe('Seite Jira-Kosten (Auswertung)', () => {
  it('zeigt Kosten je Jira-Projekt, Issues aufklappbar, Titelhinweis und CSV', async () => {
    rendereApp(`/jira-kosten?monat=${MONAT}`, {
      [`/api/v1/jira/kosten?monat=${MONAT}`]: json(KOSTEN),
    });
    expect(await screen.findByText('ABC – Alpha')).toBeTruthy();
    expect(screen.getByText('105,00 $')).toBeTruthy();
    const tabelle = screen.getByRole('table', { name: 'Issues ABC', hidden: true });
    expect(within(tabelle).getByText('Login reparieren')).toBeTruthy();
    expect(within(tabelle).getByText('in Jira nicht gefunden')).toBeTruthy();
    expect(
      screen.getByText(/1 Titel noch offen \(Jira: Jira antwortet mit HTTP 500\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Ohne Issue-Schlüssel/)).toBeTruthy();
    const csv = screen.getByRole('link', { name: 'Jira-Kosten als CSV herunterladen' });
    expect(csv.getAttribute('href')).toBe(`/api/v1/jira/kosten?monat=${MONAT}&format=csv`);
  });

  it('zeigt den Leertext ohne Daten', async () => {
    rendereApp(`/jira-kosten?monat=${MONAT}`, {
      [`/api/v1/jira/kosten?monat=${MONAT}`]: json({ ...KOSTEN, jira_projekte: [] }),
    });
    expect(
      await screen.findByText(/keine Issue-Schlüssel und keine zugeordneten Projekte/),
    ).toBeTruthy();
  });
});

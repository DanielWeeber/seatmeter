// Übersichts-Kachel „Budget-Prognose“ (Kern): Prognose gegen das mandantenweite Budget, Zählung, 403, leer.
import { json, ME_ADMIN, MONAT, rendereApp, UEBERSICHT } from '../../test/index';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BUDGETS, BUDGETS_LEER, BUDGETS_OHNE_GESAMT } from '../../test/fixtures-module';

const q = `?monat=${MONAT}`;
const budgetsPfad = `/api/v1/budgets${q}`;

function rendereUebersicht(budgets: ReturnType<typeof json>) {
  return rendereApp(`/${q}`, {
    [`/api/v1/uebersicht${q}`]: json(UEBERSICHT),
    [budgetsPfad]: budgets,
  });
}

/** Wartet, bis die Übersicht und der Budget-Aufruf fertig sind; danach kann die Kachel nicht mehr kommen. */
async function warteAufBudgets(aufrufe: { pfad: string }[]) {
  await screen.findByText('1.234');
  await waitFor(() => expect(aufrufe.some((a) => a.pfad === budgetsPfad)).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
}

describe('Kachel Budget-Prognose', () => {
  it('zeigt die Prognose gegen das mandantenweite Budget', async () => {
    rendereUebersicht(json(BUDGETS));
    expect(await screen.findByText('Budget-Prognose')).toBeTruthy();
    expect(screen.getByText('570 € von 600 €')).toBeTruthy();
    expect(screen.getByText('95 % zum Monatsende')).toBeTruthy();
  });

  it('zählt ohne mandantenweites Budget die Budgets über Prognose', async () => {
    rendereUebersicht(json(BUDGETS_OHNE_GESAMT));
    expect(await screen.findByText('1 von 2')).toBeTruthy();
    expect(screen.getByText(/Budgets über Prognose/)).toBeTruthy();
    expect(screen.queryByText(/zum Monatsende$/)).toBeNull();
  });

  it('erscheint auch ohne ee (me ohne ee-Block)', async () => {
    rendereApp(`/${q}`, {
      '/api/v1/auth/me': json(ME_ADMIN),
      [`/api/v1/uebersicht${q}`]: json(UEBERSICHT),
      [budgetsPfad]: json(BUDGETS),
    });
    expect(await screen.findByText('Budget-Prognose')).toBeTruthy();
  });

  it('bleibt bei 403 weg', async () => {
    const { aufrufe } = rendereUebersicht(json({ fehler: 'keine Berechtigung' }, 403));
    await warteAufBudgets(aufrufe);
    expect(screen.queryByText('Budget-Prognose')).toBeNull();
  });

  it('bleibt ohne Budgets weg', async () => {
    const { aufrufe } = rendereUebersicht(json(BUDGETS_LEER));
    await warteAufBudgets(aufrufe);
    expect(screen.queryByText('Budget-Prognose')).toBeNull();
  });
});

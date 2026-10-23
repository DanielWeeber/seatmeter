// Einfacher Fehlversuchs-Zähler im Speicher (je Prozess) für Anmeldung und Einrichtung.
// Schlüssel sind Benutzernamen bzw. Adressen; sie werden nie geloggt.

interface Eintrag {
  anzahl: number;
  bis: number;
}

export class Ratenbegrenzer {
  private readonly eintraege = new Map<string, Eintrag>();

  constructor(
    private readonly grenze: number,
    private readonly fensterMs: number,
    private readonly jetzt: () => number = Date.now,
  ) {}

  gesperrt(schluessel: string): boolean {
    const e = this.eintraege.get(schluessel);
    if (!e) return false;
    if (e.bis <= this.jetzt()) {
      this.eintraege.delete(schluessel);
      return false;
    }
    return e.anzahl >= this.grenze;
  }

  fehlschlag(schluessel: string): void {
    const jetzt = this.jetzt();
    const e = this.eintraege.get(schluessel);
    if (!e || e.bis <= jetzt)
      this.eintraege.set(schluessel, { anzahl: 1, bis: jetzt + this.fensterMs });
    else e.anzahl += 1;
    // Speicher begrenzen: abgelaufene Einträge gelegentlich entfernen.
    if (this.eintraege.size > 10_000) {
      for (const [k, v] of this.eintraege) if (v.bis <= jetzt) this.eintraege.delete(k);
    }
  }

  zuruecksetzen(schluessel: string): void {
    this.eintraege.delete(schluessel);
  }
}

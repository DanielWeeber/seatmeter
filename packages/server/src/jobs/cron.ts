// Minimaler Cron-Ausdruck (5 Felder, UTC): Minute Stunde Tag Monat Wochentag.
// Unterstützt `*`, Zahlen, Listen `a,b`, Bereiche `a-b` und Schritte `*/n` bzw. `a-b/n`.

interface Feld {
  min: number;
  max: number;
}

const FELDER: Feld[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

export interface Cron {
  ausdruck: string;
  werte: Set<number>[];
  /** Tag und Wochentag eingeschränkt: dann reicht einer von beiden (wie Vixie-Cron). */
  tagOderWochentag: boolean;
}

function teil(text: string, feld: Feld): number[] {
  const [bereich = '', schrittText] = text.split('/');
  const schritt = schrittText === undefined ? 1 : Number(schrittText);
  if (!Number.isInteger(schritt) || schritt < 1) throw new Error(`Ungültiger Schritt: ${text}`);
  let von = feld.min;
  let bis = feld.max;
  if (bereich !== '*') {
    const [a, b] = bereich.split('-');
    von = Number(a);
    bis = b === undefined ? (schrittText === undefined ? von : feld.max) : Number(b);
  }
  if (
    !Number.isInteger(von) ||
    !Number.isInteger(bis) ||
    von < feld.min ||
    bis > feld.max ||
    von > bis
  ) {
    throw new Error(`Ungültiger Wert: ${text}`);
  }
  const aus: number[] = [];
  for (let i = von; i <= bis; i += schritt) aus.push(i);
  return aus;
}

export function parseCron(ausdruck: string): Cron {
  const felder = ausdruck.trim().split(/\s+/);
  if (felder.length !== 5) throw new Error(`Cron braucht 5 Felder: ${ausdruck}`);
  const werte = felder.map((f, i) => {
    const feld = FELDER[i] as Feld;
    return new Set(f.split(',').flatMap((t) => teil(t, feld)));
  });
  // Wochentag 7 = Sonntag = 0.
  const wochentag = werte[4] as Set<number>;
  if (wochentag.has(7)) wochentag.add(0);
  return { ausdruck, werte, tagOderWochentag: felder[2] !== '*' && felder[4] !== '*' };
}

/** Passt der Zeitpunkt (Minute, UTC) zum Ausdruck? */
export function passt(cron: Cron, zeit: Date): boolean {
  const [minute, stunde, tag, monat, wochentag] = cron.werte as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (!minute.has(zeit.getUTCMinutes()) || !stunde.has(zeit.getUTCHours())) return false;
  if (!monat.has(zeit.getUTCMonth() + 1)) return false;
  const tagOk = tag.has(zeit.getUTCDate());
  const wtOk = wochentag.has(zeit.getUTCDay());
  return cron.tagOderWochentag ? tagOk || wtOk : tagOk && wtOk;
}

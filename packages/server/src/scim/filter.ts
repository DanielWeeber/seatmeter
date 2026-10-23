// Kleiner SCIM-Filter-Parser (RFC 7644 §3.4.2.2) ohne Abhängigkeiten: Vergleiche (eq ne co sw ew gt ge lt le),
// `pr`, `and`/`or`/`not`, Klammern und Wertpfade wie `members[value eq "…"]` oder `emails[type eq "work"]`.
// Ausgewertet wird im Speicher gegen die SCIM-Darstellung einer Ressource (je Mandant wenige Tausend Konten).
// Dazu Pfade für PATCH (§3.5.2): `attr`, `attr.sub`, `attr[filter]`, `attr[filter].sub`.

export class ScimFilterFehler extends Error {}

type Wert = string | number | boolean | null;
type Op = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'ge' | 'lt' | 'le';
const OPS = new Set<string>(['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'ge', 'lt', 'le']);

export type Filter =
  | { art: 'vergleich'; pfad: string[]; op: Op; wert: Wert }
  | { art: 'vorhanden'; pfad: string[] }
  | { art: 'und' | 'oder'; links: Filter; rechts: Filter }
  | { art: 'nicht'; filter: Filter }
  | { art: 'wertpfad'; attr: string; filter: Filter };

type Token = { t: 'wort'; w: string } | { t: 'text'; w: string } | { t: '(' | ')' | '[' | ']' };

/** Schema-URN vor dem Attribut (`urn:…:User:userName`) entfernen. */
function ohneUrn(attr: string): string {
  if (!attr.toLowerCase().startsWith('urn:')) return attr;
  const i = attr.lastIndexOf(':');
  return attr.slice(i + 1);
}

function zerlegen(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const z = text[i]!;
    if (/\s/.test(z)) {
      i++;
    } else if (z === '(' || z === ')' || z === '[' || z === ']') {
      tokens.push({ t: z });
      i++;
    } else if (z === '"') {
      let w = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          w += text[i + 1];
          i += 2;
        } else w += text[i++];
      }
      if (text[i] !== '"') throw new ScimFilterFehler('Zeichenkette nicht geschlossen');
      i++;
      tokens.push({ t: 'text', w });
    } else {
      let w = '';
      while (i < text.length && !/[\s()[\]"]/.test(text[i]!)) w += text[i++];
      tokens.push({ t: 'wort', w });
    }
  }
  return tokens;
}

class Leser {
  i = 0;
  constructor(private readonly tokens: Token[]) {}
  sehen(): Token | undefined {
    return this.tokens[this.i];
  }
  nehmen(): Token {
    const t = this.tokens[this.i++];
    if (!t) throw new ScimFilterFehler('Filter unvollständig');
    return t;
  }
  wort(w: string): boolean {
    const t = this.sehen();
    if (t?.t === 'wort' && t.w.toLowerCase() === w) {
      this.i++;
      return true;
    }
    return false;
  }
  ende(): boolean {
    return this.i >= this.tokens.length;
  }
}

function pfadTeile(attr: string): string[] {
  return ohneUrn(attr)
    .split('.')
    .map((t) => t.trim())
    .filter(Boolean);
}

function wertLesen(l: Leser): Wert {
  const t = l.nehmen();
  if (t.t === 'text') return t.w;
  if (t.t !== 'wort') throw new ScimFilterFehler('Vergleichswert fehlt');
  const w = t.w.toLowerCase();
  if (w === 'true') return true;
  if (w === 'false') return false;
  if (w === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t.w)) return Number(t.w);
  throw new ScimFilterFehler(`Ungültiger Vergleichswert: ${t.w}`);
}

function einfach(l: Leser): Filter {
  if (l.wort('not')) {
    const t = l.nehmen();
    if (t.t !== '(') throw new ScimFilterFehler('„not“ erwartet „(“');
    const f = oder(l);
    if (l.nehmen().t !== ')') throw new ScimFilterFehler('„)“ fehlt');
    return { art: 'nicht', filter: f };
  }
  const t = l.nehmen();
  if (t.t === '(') {
    const f = oder(l);
    if (l.nehmen().t !== ')') throw new ScimFilterFehler('„)“ fehlt');
    return f;
  }
  if (t.t !== 'wort') throw new ScimFilterFehler('Attribut erwartet');
  if (l.sehen()?.t === '[') {
    l.nehmen();
    const f = oder(l);
    if (l.nehmen().t !== ']') throw new ScimFilterFehler('„]“ fehlt');
    return { art: 'wertpfad', attr: ohneUrn(t.w), filter: f };
  }
  const pfad = pfadTeile(t.w);
  const opToken = l.nehmen();
  if (opToken.t !== 'wort') throw new ScimFilterFehler('Operator erwartet');
  const op = opToken.w.toLowerCase();
  if (op === 'pr') return { art: 'vorhanden', pfad };
  if (!OPS.has(op)) throw new ScimFilterFehler(`Unbekannter Operator: ${opToken.w}`);
  return { art: 'vergleich', pfad, op: op as Op, wert: wertLesen(l) };
}

function und(l: Leser): Filter {
  let f = einfach(l);
  while (l.wort('and')) f = { art: 'und', links: f, rechts: einfach(l) };
  return f;
}

function oder(l: Leser): Filter {
  let f = und(l);
  while (l.wort('or')) f = { art: 'oder', links: f, rechts: und(l) };
  return f;
}

export function filterLesen(text: string): Filter {
  if (text.length > 2000) throw new ScimFilterFehler('Filter zu lang');
  const l = new Leser(zerlegen(text));
  const f = oder(l);
  if (!l.ende()) throw new ScimFilterFehler('Unerwartetes Ende des Filters');
  return f;
}

/** Attribut eines Objekts ohne Beachtung der Groß-/Kleinschreibung. */
export function attribut(obj: unknown, name: string): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const n = name.toLowerCase();
  for (const [k, v] of Object.entries(obj)) if (k.toLowerCase() === n) return v;
  return undefined;
}

function werteAm(obj: unknown, pfad: string[]): unknown[] {
  let aktuell: unknown[] = [obj];
  for (const teil of pfad) {
    const naechste: unknown[] = [];
    for (const o of aktuell) {
      const v = attribut(o, teil);
      if (Array.isArray(v)) naechste.push(...v);
      else if (v !== undefined) naechste.push(v);
    }
    aktuell = naechste;
  }
  // Mehrwertige Attribute ohne Unterattribut (z. B. `emails eq "…"`) vergleichen `value`.
  return aktuell.map((v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? attribut(v, 'value') : v,
  );
}

const GENAU = new Set(['id', 'externalid']);

function vergleiche(ist: unknown, op: Op, soll: Wert, genau: boolean): boolean {
  if (soll === null) return op === 'eq' ? ist === null || ist === undefined : ist != null;
  if (typeof soll === 'boolean') {
    const b = typeof ist === 'string' ? ist.toLowerCase() === 'true' : ist;
    return op === 'eq' ? b === soll : op === 'ne' ? b !== soll : false;
  }
  if (typeof soll === 'number') {
    const n = Number(ist);
    if (Number.isNaN(n)) return false;
    return (
      { eq: n === soll, ne: n !== soll, gt: n > soll, ge: n >= soll, lt: n < soll, le: n <= soll }[
        op as 'eq'
      ] ?? false
    );
  }
  if (ist === null || ist === undefined) return op === 'ne';
  const a = genau ? String(ist) : String(ist).toLowerCase();
  const b = genau ? soll : soll.toLowerCase();
  switch (op) {
    case 'eq':
      return a === b;
    case 'ne':
      return a !== b;
    case 'co':
      return a.includes(b);
    case 'sw':
      return a.startsWith(b);
    case 'ew':
      return a.endsWith(b);
    case 'gt':
      return a > b;
    case 'ge':
      return a >= b;
    case 'lt':
      return a < b;
    case 'le':
      return a <= b;
  }
}

export function passt(f: Filter, obj: unknown): boolean {
  switch (f.art) {
    case 'und':
      return passt(f.links, obj) && passt(f.rechts, obj);
    case 'oder':
      return passt(f.links, obj) || passt(f.rechts, obj);
    case 'nicht':
      return !passt(f.filter, obj);
    case 'vorhanden':
      return werteAm(obj, f.pfad).some((v) => v !== null && v !== undefined && v !== '');
    case 'wertpfad': {
      const v = attribut(obj, f.attr);
      const liste = Array.isArray(v) ? v : v === undefined ? [] : [v];
      return liste.some((e) => passt(f.filter, e));
    }
    case 'vergleich': {
      const genau = GENAU.has(f.pfad[f.pfad.length - 1]?.toLowerCase() ?? '');
      const werte = werteAm(obj, f.pfad);
      if (f.op === 'ne') return werte.every((w) => vergleiche(w, 'ne', f.wert, genau));
      return werte.some((w) => vergleiche(w, f.op, f.wert, genau));
    }
  }
}

/** PATCH-Pfad: Attribut, optional Wertfilter in eckigen Klammern und Unterattribut. */
export interface PatchPfad {
  attr: string;
  filter: Filter | null;
  sub: string | null;
}

export function pfadLesen(text: string): PatchPfad {
  const t = text.trim();
  const klammer = t.indexOf('[');
  if (klammer < 0) {
    const teile = pfadTeile(t);
    if (teile.length === 0 || teile.length > 2) throw new ScimFilterFehler('Ungültiger Pfad');
    return { attr: teile[0]!, filter: null, sub: teile[1] ?? null };
  }
  const zu = t.lastIndexOf(']');
  if (zu < klammer) throw new ScimFilterFehler('„]“ fehlt im Pfad');
  const attr = ohneUrn(t.slice(0, klammer).trim());
  const filter = filterLesen(t.slice(klammer + 1, zu));
  const rest = t.slice(zu + 1).trim();
  if (rest && !rest.startsWith('.')) throw new ScimFilterFehler('Ungültiger Pfad');
  return { attr, filter, sub: rest ? rest.slice(1) : null };
}

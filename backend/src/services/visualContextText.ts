/**
 * Il contesto visivo come testo: quanto puo' essere lungo, e come si toglie
 * quello che non serve.
 *
 * Vive fuori da ollamaClient perche' non riguarda il trasporto verso il
 * modello ma la forma del testo, e perche' lo usano tre chiamanti diversi: chi
 * la vision la calcola, chi decide se riusarla, e il merge che la salva.
 */
/**
 * Quanto puo' essere lungo il contesto visivo finale.
 *
 * Non e' un testo che qualcuno legge da solo: finisce dentro il prompt di
 * analisi, dove ogni carattere in piu' diluisce caption e trascrizione. Cinque
 * descrizioni concatenate facevano 2300 caratteri per raccontare la stessa
 * scena cinque volte — piu' lunghe della caption che dovevano accompagnare.
 */
const MAX_VISUAL_CONTEXT_CHARS = 600;

/**
 * Quanti caratteri iniziali bastano a riconoscere due descrizioni della stessa
 * scena. Moondream apre sempre allo stesso modo («The image features a woman
 * with long brown hair...») e diverge solo in fondo, quindi il confronto sta
 * davanti: fotogrammi consecutivi di un video sono quasi sempre la stessa
 * inquadratura con una posa leggermente diversa.
 */
const SIMILI_PRIME_LETTERE = 60;

export function normalizza(testo: string): string {
  return testo.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ');
}

/**
 * Da cinque descrizioni quasi uguali a un contesto visivo utile.
 *
 * Toglie le ripetizioni — prima quelle identiche, poi quelle che cominciano
 * allo stesso modo — e taglia il risultato alla fine di una frase, perche' un
 * testo troncato a meta' parola nel prompt e' rumore travestito da contenuto.
 */
/** Taglia al tetto, preferendo la fine di una frase. */
function tagliaAlTetto(testo: string): string {
  if (testo.length <= MAX_VISUAL_CONTEXT_CHARS) return testo;
  const tagliato = testo.slice(0, MAX_VISUAL_CONTEXT_CHARS);
  const ultimaFrase = Math.max(tagliato.lastIndexOf('. '), tagliato.lastIndexOf('! '), tagliato.lastIndexOf('? '));
  return ultimaFrase > MAX_VISUAL_CONTEXT_CHARS / 3
    ? tagliato.slice(0, ultimaFrase + 1)
    : `${tagliato.trimEnd()}…`;
}

/** Toglie i doppioni mantenendo l'ordine; due voci che cominciano uguali sono la stessa. */
function togliSimili(parti: string[]): string[] {
  const viste = new Set<string>();
  const uniche: string[] = [];
  for (const p of parti) {
    const piatta = normalizza(p);
    if (!piatta) continue;
    const chiave = piatta.slice(0, SIMILI_PRIME_LETTERE);
    if (viste.has(chiave)) continue;
    viste.add(chiave);
    uniche.push(p.trim());
  }
  return uniche;
}

/**
 * Condensa un contesto visivo gia' salvato su un'entry.
 *
 * Serve perche' una seconda passata **riusa** il contesto che trova invece di
 * rifare la vision — giustamente, e' lavoro gia' fatto — quindi le 2312
 * battute di ripetizioni scritte prima di questo fix resterebbero li' per
 * sempre, e continuerebbero a diluire ogni analisi successiva. Applicandola
 * anche al riuso, le entry vecchie si sistemano da sole al primo passaggio,
 * senza una migrazione.
 *
 * Qui i doppioni si cercano frase per frase: quello che e' salvato e' un blocco
 * unico, non piu' la lista di descrizioni da cui era nato.
 */
export function condensaContestoVisivo(testo: string | null): string | null {
  if (!testo) return testo;
  const frasi = testo.split(/(?<=[.!?])\s+/).filter((f) => f.trim().length);
  const condensato = tagliaAlTetto(togliSimili(frasi).join(' '));
  return condensato.length ? condensato : null;
}

export function condensaDescrizioni(descrizioni: string[]): string {
  return tagliaAlTetto(togliSimili(descrizioni).join(' '));
}


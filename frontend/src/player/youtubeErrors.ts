/**
 * YouTube IFrame API onError codes → car-friendly Italian copy.
 * https://developers.google.com/youtube/iframe_api_reference#onError
 */
export function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'Uffa — errore 2: id video non valido';
    case 5:
      return 'Uffa — errore 5: riproduzione HTML5 fallita (browser auto / Tesla)';
    case 100:
      return 'Uffa — errore 100: video non trovato o privato';
    case 101:
    case 150:
      return 'Uffa — errore 101: embed disabilitato dall’autore';
    default:
      return `Uffa — errore ${code}: YouTube non riproducibile`;
  }
}

/** Fatal for this video — skip to next rather than leave the car stuck. */
export function youtubeErrorShouldSkip(code: number): boolean {
  return code === 2 || code === 5 || code === 100 || code === 101 || code === 150;
}

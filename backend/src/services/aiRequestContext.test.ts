import { describe, it, expect } from 'vitest';
import { isQueuedMode, runWithAiRequestMode, setAiRequestMode } from './aiRequestContext';

/**
 * Il contesto esiste perché le chiamate a ollama sono sparse su otto punti fra
 * route, analisi, slide e vision: passarsi un parametro fino in fondo avrebbe
 * toccato tutte le firme per un dato che riguarda la richiesta, non la
 * funzione.
 */
describe('modalità della richiesta AI', () => {
  // Il default conta: script e hook di arricchimento non sanno niente di
  // questa modalità e devono restare sincroni come prima.
  it('fuori da una richiesta è sincrona', () => {
    expect(isQueuedMode()).toBe(false);
  });

  it('dentro un contesto batch è accodata', () => {
    runWithAiRequestMode({ queued: true }, () => {
      expect(isQueuedMode()).toBe(true);
    });
  });

  it('non sopravvive alla fine del contesto', () => {
    runWithAiRequestMode({ queued: true }, () => undefined);
    expect(isQueuedMode()).toBe(false);
  });

  // Il caso che conta davvero: le chiamate vere sono dentro await annidati.
  it('attraversa gli await', async () => {
    await runWithAiRequestMode({ queued: true }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      const annidata = async () => {
        await new Promise((r) => setTimeout(r, 1));
        return isQueuedMode();
      };
      expect(await annidata()).toBe(true);
    });
  });

  it('due contesti non si mescolano', async () => {
    const [batch, interattiva] = await Promise.all([
      runWithAiRequestMode({ queued: true }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return isQueuedMode();
      }),
      runWithAiRequestMode({ queued: false }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return isQueuedMode();
      }),
    ]);
    expect(batch).toBe(true);
    expect(interattiva).toBe(false);
  });

  // La route la dichiara sempre, anche a false: così nessuna richiesta eredita
  // la modalità di quella prima.
  it('setAiRequestMode vale per il seguito del contesto', async () => {
    await runWithAiRequestMode({ queued: false }, async () => {
      setAiRequestMode({ queued: true });
      await new Promise((r) => setTimeout(r, 1));
      expect(isQueuedMode()).toBe(true);
    });
  });
});

import type { HomeSectionId, UiPrefs, WebHomeSection } from '../types';

/**
 * The sections of the Home view as they are drawn: the ones the server sent, in the order of the configuration of the user, without the ones
 * the user switched off (docs/ui-prefs.md). A section of the configuration that the server did not send (not built yet, empty, failed) and a
 * section the configuration does not know are skipped; one sent twice is drawn once. Without a configuration (the server could not be asked)
 * the page takes the sections as the server sent them: it has no table of its own (rule P).
 */
export function orderHomeSections(config: UiPrefs['home']['sections'] | null, sent: readonly WebHomeSection[]): WebHomeSection[] {
  const byId = new Map<HomeSectionId, WebHomeSection>();
  for (const section of sent) if (!byId.has(section.id)) byId.set(section.id, section);
  if (!config) return [...byId.values()];
  const out: WebHomeSection[] = [];
  for (const { id, visible } of config) {
    const section = byId.get(id);
    if (visible && section) out.push(section);
  }
  return out;
}

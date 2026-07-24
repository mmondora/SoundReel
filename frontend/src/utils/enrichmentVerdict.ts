import type { EnrichmentVerdictLabel } from '../types';

export const VERDICT_TONE: Record<EnrichmentVerdictLabel, 'safe' | 'warning' | 'danger'> = {
  vero: 'safe',
  sicuro: 'safe',
  dubbio: 'warning',
  sospetto: 'warning',
  falso: 'danger',
  'ai-generated': 'danger',
  phishing: 'danger',
};

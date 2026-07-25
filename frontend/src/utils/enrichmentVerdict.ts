import type { EnrichmentVerdictLabel, EnrichmentCategory } from '../types';

export const VERDICT_TONE: Record<EnrichmentVerdictLabel, 'safe' | 'warning' | 'danger'> = {
  vero: 'safe',
  sicuro: 'safe',
  dubbio: 'warning',
  sospetto: 'warning',
  falso: 'danger',
  'ai-generated': 'danger',
  phishing: 'danger',
};

export const VERDICT_ICON: Record<EnrichmentVerdictLabel, string> = {
  vero: '✅',
  sicuro: '🛡️',
  dubbio: '❓',
  sospetto: '⚠️',
  falso: '❌',
  'ai-generated': '🤖',
  phishing: '🎣',
};

export const CATEGORY_ICON: Record<EnrichmentCategory, string | null> = {
  tech: '💻',
  security: '🔒',
  claim: '📰',
  generic: null,
};

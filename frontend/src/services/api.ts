const FUNCTIONS_BASE_URL = import.meta.env.VITE_FUNCTIONS_URL || '';

// Debug: log the base URL on load
console.log('[SoundReel API] FUNCTIONS_BASE_URL:', FUNCTIONS_BASE_URL || '(empty - will use relative URLs)');

export interface AnalyzeResponse {
  success: boolean;
  entryId: string;
  existing?: boolean;
  error?: string;
}

export async function analyzeUrl(url: string): Promise<AnalyzeResponse> {
  const endpoint = `${FUNCTIONS_BASE_URL}/analyzeUrl`;
  console.log('[SoundReel API] Calling analyzeUrl:', endpoint);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url })
    });

    console.log('[SoundReel API] Response status:', response.status);

    if (!response.ok) {
      const error = await response.text();
      console.error('[SoundReel API] Error response:', error);
      throw new Error(error || 'Errore durante l\'analisi');
    }

    const data = await response.json();
    console.log('[SoundReel API] Success:', data);
    return data;
  } catch (err) {
    console.error('[SoundReel API] Fetch error:', err);
    throw err;
  }
}

export async function deleteEntry(entryId: string): Promise<{ success: boolean }> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/deleteEntry`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ entryId })
  });

  if (!response.ok) {
    throw new Error('Errore durante l\'eliminazione');
  }

  return response.json();
}

export async function retryEntry(entryId: string, sourceUrl: string): Promise<AnalyzeResponse> {
  await deleteEntry(entryId);
  return analyzeUrl(sourceUrl);
}

export async function enrichEntry(entryId: string): Promise<{ success: boolean; enrichments: unknown[] }> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/enrichEntry`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ entryId })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || 'Errore durante l\'enrichment');
  }

  return response.json();
}

export async function deleteAllEntries(): Promise<{ success: boolean; deleted: number }> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/deleteAllEntries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error('Errore durante l\'eliminazione');
  }

  return response.json();
}

export interface FeaturesConfig {
  cobaltEnabled: boolean;
  allowDuplicateUrls: boolean;
}

export async function getFeatures(): Promise<FeaturesConfig> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/getFeatures`);

  if (!response.ok) {
    throw new Error('Errore durante il caricamento delle impostazioni');
  }

  return response.json();
}

export async function updateFeatures(updates: Partial<FeaturesConfig>): Promise<{ success: boolean; config: FeaturesConfig }> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/updateFeatures`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });

  if (!response.ok) {
    throw new Error('Errore durante l\'aggiornamento delle impostazioni');
  }

  return response.json();
}

export interface InstagramConfigResponse {
  sessionId: string | null;
  csrfToken: string | null;
  dsUserId: string | null;
  enabled: boolean;
  hasCredentials: boolean;
}

export async function getInstagramConfig(): Promise<InstagramConfigResponse> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/getInstagramCookies`);

  if (!response.ok) {
    throw new Error('Errore durante il caricamento della configurazione Instagram');
  }

  return response.json();
}

export interface PerplexityConfigResponse {
  apiKey: string | null;
  enabled: boolean;
  hasKey: boolean;
}

export async function getPerplexityConfig(): Promise<PerplexityConfigResponse> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/getPerplexity`);

  if (!response.ok) {
    throw new Error('Errore durante il caricamento della configurazione Perplexity');
  }

  return response.json();
}

export async function updatePerplexityConfig(updates: {
  apiKey?: string;
  enabled?: boolean;
}): Promise<{ success: boolean; config: PerplexityConfigResponse }> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/updatePerplexity`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });

  if (!response.ok) {
    throw new Error('Errore durante l\'aggiornamento della configurazione Perplexity');
  }

  return response.json();
}

export async function updateInstagramConfig(updates: {
  sessionId?: string;
  csrfToken?: string;
  dsUserId?: string;
  enabled?: boolean;
}): Promise<{ success: boolean; config: InstagramConfigResponse }> {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/updateInstagramCookies`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });

  if (!response.ok) {
    throw new Error('Errore durante l\'aggiornamento della configurazione Instagram');
  }

  return response.json();
}

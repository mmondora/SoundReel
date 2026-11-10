import { useMemo } from 'react';
import { interpolate, useLanguage } from '../i18n';
import type { RuleLabels } from '../utils/dynamicRule';

/** The translated words a rule summary is built from. */
export function useRuleLabels(): RuleLabels {
  const { t } = useLanguage();
  return useMemo<RuleLabels>(() => ({
    orders: { most_played: t.dynOrderMost, least_played: t.dynOrderLeast, recent: t.dynOrderRecent, never_played: t.dynOrderNever, newest: t.dynOrderNewest },
    lastDays: (n) => interpolate(t.dynPeriodDays, { n }),
    allTime: t.dynPeriodAll,
    daysShort: t.dynDaysShort,
    family: t.dynFamily,
    max: (n) => interpolate(t.dynMax, { n }),
    downloadedOnly: t.dynDownloadedShort,
    midnight: t.dynMidnightShort,
  }), [t]);
}

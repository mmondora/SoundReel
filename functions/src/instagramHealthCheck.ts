import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { getInstagramConfig, updateInstagramConfig } from './utils/firestore';

const telegramBotToken = defineSecret('TELEGRAM_BOT_TOKEN');
const telegramChatId = defineSecret('TELEGRAM_CHAT_ID');

const INSTAGRAM_API_URL = 'https://i.instagram.com/api/v1/accounts/current_user/';

async function sendTelegramMessage(chatId: string, text: string, token: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    })
  });
}

async function checkCookieValidity(config: { sessionId: string; csrfToken: string; dsUserId: string }): Promise<{ valid: boolean; status: number; detail?: string }> {
  const cookieHeader = `sessionid=${config.sessionId}; csrftoken=${config.csrfToken}; ds_user_id=${config.dsUserId}`;

  const response = await fetch(INSTAGRAM_API_URL, {
    method: 'GET',
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100)',
      'X-CSRFToken': config.csrfToken,
      'X-IG-App-ID': '936619743392459'
    }
  });

  if (response.ok) {
    const data = await response.json() as Record<string, unknown>;
    if (data.user) {
      return { valid: true, status: response.status };
    }
    // Got 200 but no user — might be a login redirect
    if ((data as Record<string, unknown>).message === 'login_required') {
      return { valid: false, status: response.status, detail: 'login_required' };
    }
  }

  return { valid: false, status: response.status, detail: `HTTP ${response.status}` };
}

const EXPIRY_MESSAGE = `⚠️ <b>SoundReel — Cookie Instagram scaduti</b>

I cookie di sessione Instagram non sono più validi.
Le analisi Instagram non funzioneranno fino all'aggiornamento.

<b>Come aggiornare:</b>
1. Apri Instagram nel browser (loggato)
2. DevTools → Application → Cookies
3. Copia: sessionid, csrftoken, ds_user_id
4. Vai in Settings → Instagram Cookies e aggiornali`;

export const instagramHealthCheck = onSchedule(
  {
    schedule: 'every 12 hours',
    region: 'europe-west1',
    timeZone: 'Europe/Rome',
    secrets: [telegramBotToken, telegramChatId]
  },
  async () => {
    // Random delay 0–60 min to avoid fixed schedule pattern
    const delayMs = Math.floor(Math.random() * 60 * 60 * 1000);
    console.log(`Instagram cookie health check — waiting ${Math.round(delayMs / 60000)} min random delay...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));

    console.log('Instagram cookie health check starting...');

    const config = await getInstagramConfig();

    if (!config.enabled) {
      console.log('Instagram cookies disabled, skipping health check');
      return;
    }

    if (!config.sessionId || !config.csrfToken || !config.dsUserId) {
      console.log('Instagram cookies not configured, skipping health check');
      return;
    }

    try {
      const result = await checkCookieValidity({
        sessionId: config.sessionId,
        csrfToken: config.csrfToken,
        dsUserId: config.dsUserId
      });

      if (result.valid) {
        console.log('Instagram cookies are valid');
        return;
      }

      console.warn('Instagram cookies expired', { status: result.status, detail: result.detail });

      // Disable cookies to avoid useless calls
      await updateInstagramConfig({ enabled: false });
      console.log('Instagram cookies disabled in Firestore');

      // Notify via Telegram
      const token = telegramBotToken.value();
      const chatId = telegramChatId.value();

      if (token && chatId) {
        await sendTelegramMessage(chatId, EXPIRY_MESSAGE, token);
        console.log('Telegram notification sent');
      } else {
        console.warn('Telegram credentials missing, cannot send notification');
      }
    } catch (error) {
      console.error('Instagram health check failed:', error);
    }
  }
);

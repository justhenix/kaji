import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

if (!process.env.ELEVENLABS_API_KEY) throw new Error('Load the CLI-created .env.local when running this account check');
const client = new ElevenLabsClient();
const [subscription, models, voiceList] = await Promise.all([
  client.user.subscription.get(),
  client.models.list(),
  client.voices.search({ voiceType: 'default', pageSize: 100, includeTotalCount: false }),
]);
const field = (value, camel, snake) => value?.[camel] ?? value?.[snake];
const voices = voiceList.voices.map(voice => ({
  id: field(voice, 'voiceId', 'voice_id'), name: voice.name, category: voice.category,
  tiers: field(voice, 'availableForTiers', 'available_for_tiers'),
  freeUsersAllowed: field(voice.sharing, 'freeUsersAllowed', 'free_users_allowed'),
}));
console.log(JSON.stringify({
  tier: subscription.tier, status: subscription.status,
  used: field(subscription, 'characterCount', 'character_count'),
  limit: field(subscription, 'characterLimit', 'character_limit'),
  canExtend: field(subscription, 'canExtendCharacterLimit', 'can_extend_character_limit'),
  extension: field(subscription, 'maxCreditLimitExtension', 'max_credit_limit_extension'),
  currentOverage: field(subscription, 'currentOverage', 'current_overage'),
  modelAvailable: models.some(model => field(model, 'modelId', 'model_id') === 'eleven_v4_turbo'),
  voices,
}, null, 2));

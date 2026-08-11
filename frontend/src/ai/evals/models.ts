/**
 * `npm run ai:models` — asks each provider which models your key can actually use, and
 * checks the registry in `ai/providers.ts` against the answer.
 *
 * Why this exists: model ids get retired. When one does, the request fails with a bare
 * 404 that looks like a broken endpoint or a bad key, and the natural next move is to
 * guess replacement names — which wastes time and often guesses wrong. This asks.
 *
 * Your key is read from the environment and used only to call the provider's own
 * list-models endpoint. Nothing is written anywhere.
 *
 * Usage:
 *   GOOGLE_API_KEY=...  npm run ai:models
 *   GROQ_API_KEY=... GOOGLE_API_KEY=...  npm run ai:models
 *   npm run ai:models -- --provider google --all      # every model, not just chat ones
 *   npm run ai:models -- --verify                     # actually call each registry model
 *
 * Being listed is NOT the same as being usable: Google lists models that are closed to new
 * keys and 404 on first use. --verify sends a one-token request to each registry entry to
 * find out which genuinely work. It is paced to stay under free-tier rate limits.
 */

import { MODEL_OPTIONS } from '../providers';

interface ProviderProbe {
  name: string;
  envVar: string;
  /** OpenAI-compatible list endpoint for all of these. */
  url: string;
  headers: (key: string) => Record<string, string>;
  /** Which registry entries belong to this provider. */
  owns: (modelId: string) => boolean;
  console: string;
}

const PROVIDERS: ProviderProbe[] = [
  {
    name: 'google',
    envVar: 'GOOGLE_API_KEY',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    headers: k => ({ Authorization: `Bearer ${k}` }),
    owns: id => id.startsWith('gemini-'),
    console: 'https://aistudio.google.com',
  },
  {
    name: 'groq',
    envVar: 'GROQ_API_KEY',
    url: 'https://api.groq.com/openai/v1/models',
    headers: k => ({ Authorization: `Bearer ${k}` }),
    owns: id => id.startsWith('llama-') || id.startsWith('mixtral-') || id.startsWith('gemma-'),
    console: 'https://console.groq.com',
  },
  {
    name: 'openai',
    envVar: 'OPENAI_API_KEY',
    url: 'https://api.openai.com/v1/models',
    headers: k => ({ Authorization: `Bearer ${k}` }),
    owns: id => id.startsWith('gpt-') || id.startsWith('o1-') || id.startsWith('o3-'),
    console: 'https://platform.openai.com',
  },
  {
    name: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    url: 'https://api.anthropic.com/v1/models',
    headers: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
    owns: id => id.startsWith('claude-'),
    console: 'https://console.anthropic.com',
  },
  {
    name: 'mistral',
    envVar: 'MISTRAL_API_KEY',
    url: 'https://api.mistral.ai/v1/models',
    headers: k => ({ Authorization: `Bearer ${k}` }),
    owns: id => id.startsWith('mistral-') || id.startsWith('codestral-'),
    console: 'https://console.mistral.ai',
  },
  {
    name: 'together',
    envVar: 'TOGETHER_API_KEY',
    url: 'https://api.together.xyz/v1/models',
    headers: k => ({ Authorization: `Bearer ${k}` }),
    owns: id => id.startsWith('meta-llama/'),
    console: 'https://api.together.xyz',
  },
];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const showAll = process.argv.includes('--all');
const onlyProvider = arg('provider');
const verify = process.argv.includes('--verify');
/** Free tiers meter per minute; 15s keeps a verify pass under ~4 requests/min. */
const verifyDelayMs = Number(arg('verify-delay', '15000'));

/** Providers return either {data:[{id}]} or {models:[{name}]}; normalise both. */
function extractIds(payload: unknown): string[] {
  const p = payload as { data?: { id?: string }[]; models?: { name?: string; id?: string }[] };
  const raw = p.data ?? p.models ?? [];
  return raw
    .map(m => (m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? '')
    .map(id => id.replace(/^models\//, '')) // Google returns "models/gemini-…"
    .filter(Boolean)
    .sort();
}

/**
 * Filters to models that can plausibly serve a tool-calling chat completion.
 *
 * Providers return their whole catalogue: embeddings, image and music generation,
 * robotics, live-audio, computer-use. None of those work here, and listing them buries
 * the handful of ids that do. `--all` bypasses this.
 */
const NOT_CHAT = new RegExp(
  [
    'embedding', 'embed', 'aqa', 'rerank', 'moderation', 'guard',
    'imagen', 'veo', 'dall-e', 'nano-banana', 'image',          // image generation
    'lyria', 'music', 'tts', 'whisper', 'audio', 'voice',       // audio
    'live', 'realtime', 'streaming',                            // streaming-only transports
    'robotics', 'computer-use',                                 // embodied / agentic special-purpose
  ].join('|'),
  'i',
);

function looksLikeChatModel(id: string): boolean {
  return !NOT_CHAT.test(id);
}

async function probe(p: ProviderProbe): Promise<void> {
  const key = process.env[p.envVar];
  if (!key) return;

  process.stdout.write(`\n── ${p.name} ${'─'.repeat(Math.max(0, 60 - p.name.length))}\n`);

  let ids: string[];
  try {
    const response = await fetch(p.url, { headers: p.headers(key) });
    if (!response.ok) {
      const body = await response.text();
      console.log(`  ✗ ${response.status} listing models from ${p.url}`);
      console.log(`    ${body.slice(0, 300).replace(/\n/g, ' ')}`);
      if (response.status === 401 || response.status === 403) {
        console.log(`    The key in ${p.envVar} was rejected. Check it at ${p.console}`);
      }
      return;
    }
    ids = extractIds(await response.json());
  } catch (e) {
    console.log(`  ✗ Could not reach ${p.url}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const chat = showAll ? ids : ids.filter(looksLikeChatModel);
  console.log(`  ${ids.length} model(s) available to this key${showAll ? '' : `, ${chat.length} usable for chat`}:\n`);
  for (const id of chat) console.log(`    ${id}`);

  // The point of the exercise: which registry entries still exist.
  const registered = MODEL_OPTIONS.filter(m => p.owns(m.id));
  if (registered.length === 0) return;

  console.log('\n  HyQSim registry (frontend/src/ai/providers.ts):');
  let missing = 0;
  for (const m of registered) {
    const listed = ids.includes(m.id);
    if (!listed) missing++;
    console.log(`    ${listed ? '✓ listed' : '✗ NOT LISTED'}  ${m.id}`);
  }
  if (missing > 0) {
    console.log(
      `\n  ${missing} registry entr${missing === 1 ? 'y is' : 'ies are'} not in the catalogue at all — ` +
      `replace ${missing === 1 ? 'it' : 'them'} with an id from the list above.`,
    );
  }

  if (!verify) {
    console.log('\n  NOTE: being listed does NOT mean your key can use it. Google in particular');
    console.log('  lists models that are closed to new keys and 404 on first use. To find out');
    console.log('  which ones actually work:  npm run ai:models -- --verify');
    return;
  }

  await verifyModels(p, key, registered.map(m => m.id));
}

/**
 * Sends a one-token completion to each model to find out which are genuinely usable.
 *
 * The catalogue is not an availability list: `gemini-2.5-flash` was listed for a new key
 * and then returned "no longer available to new users" on first use. Only a real request
 * settles it.
 *
 * Paced deliberately: free tiers meter requests per minute, and hammering them turns every
 * later answer into a 429 that says nothing about the model.
 */
async function verifyModels(p: ProviderProbe, key: string, ids: string[]): Promise<void> {
  const chatUrl = p.url.replace(/\/models$/, '/chat/completions');
  console.log(`\n  Verifying ${ids.length} model(s) with a 1-token request each`);
  console.log(`  (${(verifyDelayMs / 1000).toFixed(0)}s apart to stay under free-tier rate limits — about ` +
    `${Math.ceil((ids.length * verifyDelayMs) / 60000)} min)\n`);

  const usable: string[] = [];

  for (const [i, id] of ids.entries()) {
    process.stdout.write(`    ${id.padEnd(34)}`);
    try {
      const response = await fetch(chatUrl, {
        method: 'POST',
        headers: { ...p.headers(key), 'content-type': 'application/json' },
        body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });

      if (response.ok) {
        console.log('✓ usable');
        usable.push(id);
      } else {
        const text = await response.text();
        let detail = text;
        try { detail = JSON.parse(text).error?.message ?? text; } catch { /* raw */ }
        detail = String(detail).replace(/\s+/g, ' ');
        // A 429 means the model was never evaluated — do not mark it unusable.
        const label = response.status === 429 ? '⏳ rate limited (not tested)' : `✗ ${response.status}`;
        console.log(label);
        console.log(`      ${detail.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`✗ network: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (i < ids.length - 1) await new Promise(r => setTimeout(r, verifyDelayMs));
  }

  console.log('');
  if (usable.length > 0) {
    console.log(`  Usable with this key: ${usable.join(', ')}`);
  } else {
    console.log('  None verified usable — you may have hit the rate limit. Re-run with a');
    console.log('  longer gap:  npm run ai:models -- --verify --verify-delay 30000');
  }
}

async function main() {
  const targets = onlyProvider ? PROVIDERS.filter(p => p.name === onlyProvider) : PROVIDERS;
  const withKeys = targets.filter(p => process.env[p.envVar]);

  if (withKeys.length === 0) {
    console.log('\nNo API keys found in the environment. Set at least one of:\n');
    for (const p of targets) console.log(`  ${p.envVar.padEnd(20)} ${p.console}`);
    console.log('\ne.g.  GOOGLE_API_KEY=AIza... npm run ai:models\n');
    process.exit(1);
  }

  console.log('\nHyQSim — provider model check');
  console.log('Keys are read from the environment and used only to list models.');

  for (const p of withKeys) await probe(p);
  console.log('');
}

main();

/**
 * SentimentService — v4 (Live X Search via Grok)
 *
 * Four live data sources fed into xAI Grok for BTC and ETH directional signals:
 *
 *  1. xAI Grok LIVE X search  — real-time X/Twitter posts searched by Grok natively
 *  2. StockTwits live posts   — trader Bullish/Bearish labels on BTC.X / ETH.X (fallback)
 *  3. News RSS feeds          — CoinDesk, CoinTelegraph, Bitcoin Mag, Decrypt, The Block
 *  4. Fear & Greed Index      — Alternative.me 0–100
 *
 * Cache TTL: 5 minutes per coin
 */

import OpenAI from 'openai';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SentimentDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type SentimentCoin      = 'BTC' | 'ETH';

export interface FearGreedData {
  value:          number;
  classification: string;
  updatedAt:      number;
}

export interface SentimentResult {
  coin:           SentimentCoin;
  direction:      SentimentDirection;
  confidence:     number;
  reasoning:      string;
  xSummary:       string;    // what X is saying right now
  xPostsFound:    number;
  fearGreed:      FearGreedData;
  headlines:      string[];
  socialBullish:  number;
  socialBearish:  number;
  socialNeutral:  number;
  model:          string;
  fetchedAt:      number;
  usedLiveX:      boolean;   // true = Grok searched X live
}

export interface CombinedSignal {
  direction:      'UP' | 'DOWN' | 'NEUTRAL';
  confidence:     number;
  momentumScore:  number;
  sentimentScore: number;
  fearGreedScore: number;
  weightedTotal:  number;
  sentiment:      SentimentResult;
}

// ─── SentimentService ─────────────────────────────────────────────────────────

export class SentimentService {
  private client:  OpenAI;
  private cache    = new Map<SentimentCoin, SentimentResult>();
  private cacheTs  = new Map<SentimentCoin, number>();
  private readonly TTL = 5 * 60 * 1000;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  async getSentiment(coin: SentimentCoin = 'BTC'): Promise<SentimentResult> {
    const ts = this.cacheTs.get(coin) ?? 0;
    if (this.cache.has(coin) && Date.now() - ts < this.TTL) return this.cache.get(coin)!;

    const [stocktwits, headlines, fearGreed] = await Promise.all([
      this.fetchStockTwits(coin),
      this.fetchNewsHeadlines(coin),
      this.fetchFearGreed(),
    ]);

    // Try live X search first — fall back to StockTwits-only if it fails
    let result: SentimentResult;
    try {
      result = await this.analyzeWithLiveX(coin, headlines, stocktwits, fearGreed);
    } catch (err) {
      console.warn(`[Sentiment] Live X search failed (${(err as any).message?.slice(0, 50)}), falling back to StockTwits`);
      result = await this.analyzeWithStockTwits(coin, headlines, stocktwits, fearGreed);
    }

    this.cache.set(coin, result);
    this.cacheTs.set(coin, Date.now());
    return result;
  }

  combinedSignal(
    momentumDir: 'UP' | 'DOWN' | 'NEUTRAL',
    _changePct:  number,
    sentiment:   SentimentResult,
    threshold    = 0.15,
  ): CombinedSignal {
    const momentumScore =
      momentumDir === 'UP'   ?  1 :
      momentumDir === 'DOWN' ? -1 : 0;

    const sentimentScore =
      sentiment.direction === 'BULLISH' ?  sentiment.confidence :
      sentiment.direction === 'BEARISH' ? -sentiment.confidence : 0;

    const fg = sentiment.fearGreed.value;
    const fearGreedScore =
      fg >= 70 ?  0.8 : fg >= 55 ?  0.4 :
      fg <= 25 ? -0.8 : fg <= 40 ? -0.4 : 0;

    const weightedTotal =
      momentumScore  * 0.40 +
      sentimentScore * 0.40 +
      fearGreedScore * 0.20;

    const direction: 'UP' | 'DOWN' | 'NEUTRAL' =
      weightedTotal >  threshold ? 'UP'   :
      weightedTotal < -threshold ? 'DOWN' : 'NEUTRAL';

    return { direction, confidence: Math.abs(weightedTotal), momentumScore, sentimentScore, fearGreedScore, weightedTotal, sentiment };
  }

  // ─── Grok-4.3 with Agent Tools pattern (live social data via StockTwits) ──
  // xAI deprecated search_parameters. New pattern: function calling where Grok
  // requests what to search, we provide real StockTwits posts as results.

  private async analyzeWithLiveX(
    coin:      SentimentCoin,
    headlines: string[],
    social:    { bullish: number; bearish: number; neutral: number; samples: string[] },
    fearGreed: FearGreedData,
  ): Promise<SentimentResult> {
    const model  = 'grok-4.3';
    const ticker = coin === 'BTC' ? 'Bitcoin' : 'Ethereum';

    const tools: any[] = [{
      type: 'function',
      function: {
        name: 'get_social_posts',
        description: `Get live social media posts about ${ticker} from traders right now`,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
          required: ['query'],
        },
      },
    }];

    // Step 1: ask Grok to request social data
    const step1 = await (this.client.chat.completions.create as Function)({
      model,
      messages: [{
        role: 'user',
        content: `You are analyzing SHORT-TERM (5–15 min) ${ticker} price direction.
Use get_social_posts to fetch live trader posts about ${ticker} right now.
Fear & Greed Index: ${fearGreed.value}/100 "${fearGreed.classification}"
News: ${headlines.slice(0, 3).join(' | ') || 'none'}`,
      }],
      tools,
      tool_choice: 'auto',
      max_tokens: 200,
    }) as any;

    const toolCall = step1.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error('no tool call from grok-4.3');

    // Step 2: provide real StockTwits posts as the search result
    const postData = social.samples.map((s, i) => ({
      id:        i + 1,
      platform:  'StockTwits',
      text:      s,
      sentiment: s.startsWith('[Bullish]') ? 'Bullish' : s.startsWith('[Bearish]') ? 'Bearish' : 'Neutral',
    }));
    const summary = `${social.bullish} Bullish / ${social.bearish} Bearish / ${social.neutral} Neutral out of ${social.bullish + social.bearish + social.neutral} posts`;

    const step2Messages: any[] = [
      { role: 'user', content: step1.choices[0].message.content ?? '' },
      step1.choices[0].message,
      {
        role:         'tool',
        tool_call_id: toolCall.id,
        content:      JSON.stringify({ posts: postData, summary, coin, fetchedAt: new Date().toISOString() }),
      },
      {
        role: 'user',
        content: `Based on those live posts + the Fear & Greed index + news, give your verdict.
Return JSON only:
{
  "direction": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": <0.0–1.0>,
  "x_posts_found": <number>,
  "x_summary": "<1–2 sentences on what traders are saying>",
  "reasoning": "<max 80 words citing specific posts, ratios, headlines>"
}`,
      },
    ];

    const step2 = await (this.client.chat.completions.create as Function)({
      model,
      messages: step2Messages,
      max_tokens: 400,
      temperature: 0.1,
    }) as any;

    const raw = step2.choices[0]?.message?.content ?? '{}';
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch {} }
    }

    const dir  = (['BULLISH', 'BEARISH', 'NEUTRAL'] as const).find(d => d === parsed.direction) ?? 'NEUTRAL';
    const conf = Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.3));

    return {
      coin, direction: dir, confidence: conf,
      reasoning:     (parsed.reasoning ?? '').slice(0, 300),
      xSummary:      (parsed.x_summary ?? summary).slice(0, 200),
      xPostsFound:   parseInt(parsed.x_posts_found, 10) || (social.bullish + social.bearish + social.neutral),
      fearGreed, headlines: headlines.slice(0, 8),
      socialBullish: social.bullish,
      socialBearish: social.bearish,
      socialNeutral: social.neutral,
      model: `${model}+tools`,
      fetchedAt: Date.now(),
      usedLiveX: true,
    };
  }

  // ─── Fallback: Grok analysis on StockTwits only (no live X search) ────────

  private async analyzeWithStockTwits(
    coin:      SentimentCoin,
    headlines: string[],
    social:    { bullish: number; bearish: number; neutral: number; samples: string[] },
    fearGreed: FearGreedData,
  ): Promise<SentimentResult> {
    const model   = 'grok-3-fast';
    const ticker  = coin === 'BTC' ? 'Bitcoin' : 'Ethereum';
    const totalST = social.bullish + social.bearish + social.neutral || 1;
    const bullPct = Math.round(social.bullish / totalST * 100);
    const bearPct = Math.round(social.bearish / totalST * 100);

    const prompt = `You are a professional crypto market analyst. Assess SHORT-TERM (next 5–15 minutes) ${ticker} price direction.

## Fear & Greed Index: ${fearGreed.value}/100 — "${fearGreed.classification}"

## StockTwits ${coin} (last 30 posts)
Bullish: ${social.bullish} (${bullPct}%) | Bearish: ${social.bearish} (${bearPct}%) | Neutral: ${social.neutral}
Sample posts:
${social.samples.map((s, i) => `${i + 1}. ${s}`).join('\n') || 'No samples.'}

## Latest Headlines
${headlines.length > 0 ? headlines.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'No headlines.'}

Return JSON only:
{
  "direction": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": <0.0–1.0>,
  "x_posts_found": ${totalST},
  "x_summary": "<what StockTwits traders are saying right now>",
  "reasoning": "<max 80 words>"
}`;

    const completion = await this.client.chat.completions.create({
      model,
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0.1,
      max_tokens:      400,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch {}

    const dir  = (['BULLISH', 'BEARISH', 'NEUTRAL'] as const).find(d => d === parsed.direction) ?? 'NEUTRAL';
    const conf = Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.3));

    return {
      coin, direction: dir, confidence: conf,
      reasoning:     (parsed.reasoning ?? '').slice(0, 300),
      xSummary:      (parsed.x_summary ?? '').slice(0, 200),
      xPostsFound:   social.bullish + social.bearish + social.neutral,
      fearGreed, headlines: headlines.slice(0, 8),
      socialBullish: social.bullish,
      socialBearish: social.bearish,
      socialNeutral: social.neutral,
      model,
      fetchedAt: Date.now(),
      usedLiveX: false,
    };
  }

  // ─── StockTwits ───────────────────────────────────────────────────────────

  private async fetchStockTwits(coin: SentimentCoin): Promise<{ bullish: number; bearish: number; neutral: number; samples: string[] }> {
    const sym = coin === 'BTC' ? 'BTC.X' : 'ETH.X';
    try {
      const r = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${sym}.json?limit=30`, {
        signal: AbortSignal.timeout(6000),
      });
      const d: any = await r.json();
      const msgs: any[] = d.messages ?? [];
      let bullish = 0, bearish = 0, neutral = 0;
      const samples: string[] = [];
      for (const m of msgs) {
        const sent = m.entities?.sentiment?.basic ?? 'None';
        if (sent === 'Bullish') bullish++;
        else if (sent === 'Bearish') bearish++;
        else neutral++;
        if (samples.length < 5) {
          const body = (m.body ?? '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
          samples.push(`[${sent}] ${body}`);
        }
      }
      return { bullish, bearish, neutral, samples };
    } catch {
      return { bullish: 0, bearish: 0, neutral: 0, samples: [] };
    }
  }

  // ─── RSS ──────────────────────────────────────────────────────────────────

  private async fetchNewsHeadlines(coin: SentimentCoin): Promise<string[]> {
    const feeds = [
      'https://www.coindesk.com/arc/outboundfeeds/rss/',
      'https://cointelegraph.com/rss',
      'https://bitcoinmagazine.com/feed',
      'https://decrypt.co/feed',
      'https://www.theblock.co/rss.xml',
    ];
    const results = await Promise.allSettled(feeds.map(url => this.fetchRSS(url)));
    const all: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value);
    }
    const keyword   = coin === 'BTC' ? /bitcoin|btc/i : /ethereum|eth\b/i;
    const coinFirst = all.filter(h => keyword.test(h));
    const coinOther = all.filter(h => !keyword.test(h));
    const seen = new Set<string>();
    return [...coinFirst, ...coinOther].filter(h => {
      const k = h.slice(0, 40).toLowerCase();
      return seen.has(k) ? false : (seen.add(k), true);
    }).slice(0, 12);
  }

  private async fetchRSS(url: string): Promise<string[]> {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; polymarket-bot/1.0)', Accept: 'application/rss+xml,text/xml' },
        signal: AbortSignal.timeout(6000),
      });
      const xml = await r.text();
      return [...xml.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)]
        .map(m => m[1].trim()
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&#[0-9]+;/g, ' ').replace(/\s+/g, ' '))
        .filter(t => t.length > 25 && t.length < 220)
        .slice(1, 6);
    } catch { return []; }
  }

  // ─── Fear & Greed ─────────────────────────────────────────────────────────

  private async fetchFearGreed(): Promise<FearGreedData> {
    try {
      const r = await fetch('https://api.alternative.me/fng/?limit=1&format=json', { signal: AbortSignal.timeout(5000) });
      const d: any = await r.json();
      const e = d.data?.[0];
      if (!e) throw new Error('empty');
      return { value: parseInt(e.value, 10), classification: e.value_classification, updatedAt: Date.now() };
    } catch {
      return { value: 50, classification: 'Neutral', updatedAt: Date.now() };
    }
  }
}

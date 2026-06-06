/**
 * SentimentService — v3 (Multi-Source Social + News)
 *
 * Four live data sources fed into xAI Grok for BTC and ETH directional signals:
 *
 *  1. StockTwits live posts  — real trader Bullish/Bearish labels on BTC.X / ETH.X
 *  2. News RSS feeds         — CoinDesk, CoinTelegraph, Bitcoin Mag, Decrypt, The Block
 *  3. Fear & Greed Index     — Alternative.me 0–100
 *  4. xAI Grok analysis      — fuses all signals into directional verdict + reasoning
 *
 * NOTE: xAI search_parameters with type:"x" returned 410 (deprecated).
 *       StockTwits is used instead — it IS what traders on social media are saying,
 *       with explicit Bullish/Bearish labels per post.
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
  xPostsFound:    number;    // kept for interface compatibility (StockTwits count)
  fearGreed:      FearGreedData;
  headlines:      string[];
  socialBullish:  number;
  socialBearish:  number;
  socialNeutral:  number;
  model:          string;
  fetchedAt:      number;
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
  private client: OpenAI;
  private cache   = new Map<SentimentCoin, SentimentResult>();
  private cacheTs = new Map<SentimentCoin, number>();
  private readonly TTL = 5 * 60 * 1000;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  async getSentiment(coin: SentimentCoin = 'BTC'): Promise<SentimentResult> {
    const ts = this.cacheTs.get(coin) ?? 0;
    if (this.cache.has(coin) && Date.now() - ts < this.TTL) return this.cache.get(coin)!;

    const [headlines, social, fearGreed] = await Promise.all([
      this.fetchNewsHeadlines(coin),
      this.fetchStockTwits(coin),
      this.fetchFearGreed(),
    ]);

    const result = await this.analyzeWithGrok(coin, headlines, social, fearGreed);
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

  // ─── xAI Grok analysis ───────────────────────────────────────────────────

  private async analyzeWithGrok(
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
(0=Extreme Fear, 100=Extreme Greed)

## StockTwits ${coin} Social Sentiment — what traders are saying RIGHT NOW (last 20 posts)
Bullish: ${social.bullish} (${bullPct}%) | Bearish: ${social.bearish} (${bearPct}%) | Neutral: ${social.neutral}
Sample posts:
${social.samples.map((s, i) => `${i + 1}. ${s}`).join('\n') || 'No samples.'}

## Latest Crypto News Headlines
${headlines.length > 0
  ? headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')
  : 'No headlines available.'}

## Analysis Rules
- BULLISH only if trader posts + headlines + fear/greed clearly favor upside
- BEARISH only if they clearly favor downside
- NEUTRAL when signals conflict or insufficient
- Extreme Fear (≤25) = selling pressure but watch for short squeezes
- Be conservative: wrong direction worse than NEUTRAL
- confidence 0.3–0.4 = mixed, 0.6–0.8 = clear signal, 0.9+ = extremely clear
- Reference StockTwits posts and headlines in your reasoning

Reply with JSON only:
{
  "direction": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": <0.0–1.0>,
  "social_posts_analyzed": ${social.bullish + social.bearish + social.neutral},
  "reasoning": "<max 80 words — cite specific posts, headlines, or data points>"
}`;

    try {
      const completion = await this.client.chat.completions.create({
        model,
        messages:        [{ role: 'user', content: prompt }],
        temperature:     0.1,
        max_tokens:      400,
        response_format: { type: 'json_object' },
      });

      const raw    = completion.choices[0]?.message?.content ?? '{}';
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { /* keep defaults */ }

      const dir  = (['BULLISH', 'BEARISH', 'NEUTRAL'] as const).find(d => d === parsed.direction) ?? 'NEUTRAL';
      const conf = Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.3));

      return {
        coin, direction: dir, confidence: conf,
        reasoning:     (parsed.reasoning ?? '').slice(0, 300),
        xPostsFound:   parseInt(parsed.social_posts_analyzed, 10) || (social.bullish + social.bearish + social.neutral),
        fearGreed,
        headlines:     headlines.slice(0, 8),
        socialBullish: social.bullish,
        socialBearish: social.bearish,
        socialNeutral: social.neutral,
        model,
        fetchedAt:     Date.now(),
      };
    } catch (err) {
      return {
        coin, direction: 'NEUTRAL', confidence: 0,
        reasoning:     `xAI unavailable: ${(err as any).message?.slice(0, 60)}`,
        xPostsFound:   social.bullish + social.bearish + social.neutral,
        fearGreed, headlines,
        socialBullish: social.bullish, socialBearish: social.bearish, socialNeutral: social.neutral,
        model, fetchedAt: Date.now(),
      };
    }
  }

  // ─── StockTwits — live trader posts with Bullish/Bearish labels ──────────

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

  // ─── News: multi-source RSS ───────────────────────────────────────────────

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

    const keyword    = coin === 'BTC' ? /bitcoin|btc/i : /ethereum|eth\b/i;
    const coinFirst  = all.filter(h => keyword.test(h));
    const coinOther  = all.filter(h => !keyword.test(h));

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

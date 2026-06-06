import 'dotenv/config';
import { SentimentService } from './src/services/sentiment-service.js';

async function main() {
  const key = process.env.XAI_API_KEY;
  if (!key) { console.log('XAI_API_KEY not set in .env'); process.exit(1); }

  const svc = new SentimentService(key);

  for (const coin of ['BTC', 'ETH'] as const) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Testing ${coin} sentiment (X live search)...\n`);

    const result = await svc.getSentiment(coin);

    console.log(`Direction:      ${result.direction}`);
    console.log(`Confidence:     ${(result.confidence * 100).toFixed(0)}%`);
    console.log(`X posts found:  ${result.xPostsFound}`);
    console.log(`Reasoning:      ${result.reasoning}`);
    console.log(`Fear/Greed:     ${result.fearGreed.value}/100 — "${result.fearGreed.classification}"`);
    console.log(`StockTwits:     ${result.socialBullish}B / ${result.socialBearish}Br / ${result.socialNeutral}N`);
    console.log(`Model:          ${result.model}`);
    console.log(`Headlines (top 3):`);
    result.headlines.slice(0, 3).forEach((h, i) => console.log(`  ${i+1}. ${h}`));

    const signal = svc.combinedSignal('UP', 0.05, result);
    console.log(`\nCombined signal → ${signal.direction}`);
    console.log(`  Momentum:    ${signal.momentumScore >= 0 ? '+' : ''}${signal.momentumScore.toFixed(2)}`);
    console.log(`  Sentiment:   ${signal.sentimentScore >= 0 ? '+' : ''}${signal.sentimentScore.toFixed(2)}`);
    console.log(`  Fear/Greed:  ${signal.fearGreedScore >= 0 ? '+' : ''}${signal.fearGreedScore.toFixed(2)}`);
    console.log(`  Weighted:    ${signal.weightedTotal >= 0 ? '+' : ''}${signal.weightedTotal.toFixed(3)}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

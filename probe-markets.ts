import 'dotenv/config';
import { PolymarketSDK } from './src/index.js';

async function main() {
  const sdk = new PolymarketSDK({ privateKey: process.env.POLYMARKET_PRIVATE_KEY! });
  
  // Try BTC 5m
  try {
    const m5 = await sdk.dipArb.scanUpcomingMarkets({ coin: 'BTC', duration: '5m', minMinutesUntilEnd: 1, maxMinutesUntilEnd: 120, limit: 10 });
    console.log('BTC 5m:', m5.length, 'markets');
    for (const m of m5.slice(0,3)) {
      const et = m.endTime instanceof Date ? m.endTime : new Date((m.endTime as any)*1000);
      console.log(' -', m.name, '| T-', ((et.getTime()-Date.now())/60000).toFixed(1), 'min');
      console.log('   UP:', m.upTokenId, 'DOWN:', m.downTokenId);
    }
  } catch(e) { console.log('BTC 5m error:', (e as any).message); }
  
  // Try BTC 15m
  try {
    const m15 = await sdk.dipArb.scanUpcomingMarkets({ coin: 'BTC', duration: '15m', minMinutesUntilEnd: 1, maxMinutesUntilEnd: 120, limit: 5 });
    console.log('BTC 15m:', m15.length, 'markets');
  } catch(e) { console.log('BTC 15m error:', (e as any).message); }
  
  // Try ETH
  try {
    const eth = await sdk.dipArb.scanUpcomingMarkets({ coin: 'ETH', duration: '5m', minMinutesUntilEnd: 1, maxMinutesUntilEnd: 120, limit: 5 });
    console.log('ETH 5m:', eth.length, 'markets');
  } catch(e) { console.log('ETH 5m error:', (e as any).message); }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

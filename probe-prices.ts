import 'dotenv/config';
import { PolymarketSDK } from './src/index.js';

async function getMid(tokenId: string): Promise<number> {
  const r = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
  const d: any = await r.json();
  return parseFloat(d.mid ?? '0');
}

async function getBook(tokenId: string): Promise<any> {
  const r = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  return r.json();
}

async function main() {
  const sdk = new PolymarketSDK({ privateKey: process.env.POLYMARKET_PRIVATE_KEY! });
  
  const markets = await sdk.dipArb.scanUpcomingMarkets({ 
    coin: 'BTC', duration: '5m', minMinutesUntilEnd: 3, maxMinutesUntilEnd: 30, limit: 5 
  });
  
  console.log(`Found ${markets.length} BTC 5m markets`);
  
  for (const m of markets.slice(0, 4)) {
    const et = m.endTime instanceof Date ? m.endTime : new Date((m.endTime as any)*1000);
    const mins = ((et.getTime()-Date.now())/60000).toFixed(1);
    
    const upMid  = await getMid(m.upTokenId);
    const downMid = await getMid(m.downTokenId);
    const sum = upMid + downMid;
    
    console.log(`\n${m.name}`);
    console.log(`  Ends in: ${mins} min`);
    console.log(`  UP mid:   ${upMid.toFixed(4)}`);
    console.log(`  DOWN mid: ${downMid.toFixed(4)}`);
    console.log(`  SUM:      ${sum.toFixed(4)}  ${sum < 0.98 ? '⭐ ARBIRAGE POSSIBLE' : sum < 1.00 ? '✓ slight gap' : '✗ no arb'}`);
  }
  
  // Also check ETH
  const ethMarkets = await sdk.dipArb.scanUpcomingMarkets({ 
    coin: 'ETH', duration: '5m', minMinutesUntilEnd: 3, maxMinutesUntilEnd: 30, limit: 3 
  });
  console.log(`\nETH 5m: ${ethMarkets.length} markets`);
  for (const m of ethMarkets.slice(0, 2)) {
    const et = m.endTime instanceof Date ? m.endTime : new Date((m.endTime as any)*1000);
    const mins = ((et.getTime()-Date.now())/60000).toFixed(1);
    const upMid  = await getMid(m.upTokenId);
    const downMid = await getMid(m.downTokenId);
    const sum = upMid + downMid;
    console.log(`${m.name} | T-${mins}m | UP=${upMid.toFixed(4)} DOWN=${downMid.toFixed(4)} SUM=${sum.toFixed(4)}`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

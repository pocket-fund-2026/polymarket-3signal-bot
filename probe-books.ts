import 'dotenv/config';
import { PolymarketSDK } from './src/index.js';

async function getBook(tokenId: string): Promise<{bestBid:number, bestAsk:number, midpoint:number}> {
  const r = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  const d: any = await r.json();
  const bids = (d.bids || []).sort((a:any,b:any) => b.price - a.price);
  const asks = (d.asks || []).sort((a:any,b:any) => a.price - b.price);
  const bestBid = bids.length ? parseFloat(bids[0].price) : 0;
  const bestAsk = asks.length ? parseFloat(asks[0].price) : 1;
  return { bestBid, bestAsk, midpoint: (bestBid + bestAsk) / 2 };
}

async function main() {
  const sdk = new PolymarketSDK({ privateKey: process.env.POLYMARKET_PRIVATE_KEY! });
  
  const markets = await sdk.dipArb.scanUpcomingMarkets({ 
    coin: 'BTC', duration: '5m', minMinutesUntilEnd: 3, maxMinutesUntilEnd: 60, limit: 6 
  });
  
  console.log('Market | T-left | UP bid/ask | DOWN bid/ask | BID-SUM | ASK-SUM | arb?');
  console.log('─'.repeat(100));
  
  for (const m of markets.slice(0, 5)) {
    const et = m.endTime instanceof Date ? m.endTime : new Date((m.endTime as any)*1000);
    const mins = ((et.getTime()-Date.now())/60000).toFixed(1);
    
    const [up, dn] = await Promise.all([getBook(m.upTokenId), getBook(m.downTokenId)]);
    
    const bidSum = up.bestBid + dn.bestBid;  // if we were SELLING both: get this
    const askSum = up.bestAsk + dn.bestAsk;  // if we were BUYING both: pay this
    
    const name = m.name.replace('Bitcoin Up or Down - June 6, ', '').replace(' ET', '');
    console.log(
      `${name.padEnd(18)} T-${mins.padStart(4)}m ` +
      `UP: ${up.bestBid.toFixed(3)}/${up.bestAsk.toFixed(3)} ` +
      `DN: ${dn.bestBid.toFixed(3)}/${dn.bestAsk.toFixed(3)} ` +
      `bidSum=${bidSum.toFixed(4)} askSum=${askSum.toFixed(4)} ` +
      (askSum < 1.00 ? `⭐ ARB +${((1-askSum)*100).toFixed(2)}%` : askSum < 1.02 ? `✓ close` : `✗`)
    );
  }
  
  // Also check ETH and SOL
  for (const coin of ['ETH', 'SOL'] as const) {
    const ms = await sdk.dipArb.scanUpcomingMarkets({ 
      coin, duration: '5m', minMinutesUntilEnd: 3, maxMinutesUntilEnd: 30, limit: 3
    });
    if (ms.length) {
      const m = ms[1] || ms[0]; // prefer one with some time left
      const et = m.endTime instanceof Date ? m.endTime : new Date((m.endTime as any)*1000);
      const mins = ((et.getTime()-Date.now())/60000).toFixed(1);
      const [up, dn] = await Promise.all([getBook(m.upTokenId), getBook(m.downTokenId)]);
      const askSum = up.bestAsk + dn.bestAsk;
      const name = `${coin} ${m.name.slice(-25)}`;
      console.log(
        `${name.padEnd(18)} T-${mins.padStart(4)}m ` +
        `UP: ${up.bestBid.toFixed(3)}/${up.bestAsk.toFixed(3)} ` +
        `DN: ${dn.bestBid.toFixed(3)}/${dn.bestAsk.toFixed(3)} ` +
        `askSum=${askSum.toFixed(4)} ` +
        (askSum < 1.00 ? `⭐ ARB` : `✗`)
      );
    }
  }
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

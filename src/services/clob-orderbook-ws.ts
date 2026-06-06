/**
 * Direct WebSocket client for Polymarket's CLOB orderbook feed.
 *
 * Polymarket deprecated `clob_market` messages on wss://ws-live-data.polymarket.com
 * in 2025. Orderbook data now lives on a dedicated endpoint:
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market
 *
 * This class connects to that endpoint, normalises messages into the same
 * OrderbookSnapshot shape the rest of the bot already expects, and emits them
 * via a simple callback so dip-arb-service needs no changes.
 */

import WebSocket from 'isomorphic-ws';
import type { OrderbookSnapshot } from './realtime-service-v2.js';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;
const PING_INTERVAL_MS = 10000;

type OrderbookHandler = (book: OrderbookSnapshot) => void;

interface ClobLevel {
  price: string;
  size: string;
}

interface ClobBookMessage {
  event_type: 'book';
  asset_id: string;
  market: string;
  hash?: string;
  timestamp?: string;
  bids: ClobLevel[];
  asks: ClobLevel[];
}

interface ClobPriceChangeMessage {
  event_type: 'price_change';
  asset_id: string;
  market?: string;
  changes: Array<{ side: 'BUY' | 'SELL'; price: string; size: string }>;
}

type ClobMessage = ClobBookMessage | ClobPriceChangeMessage | { event_type: string };

export class ClobOrderbookWS {
  private ws: WebSocket | null = null;
  private subscribedTokens: Set<string> = new Set();
  private handlers: Map<string, OrderbookHandler[]> = new Map();
  private bookCache: Map<string, OrderbookSnapshot> = new Map();
  private reconnectDelay = RECONNECT_DELAY_MS;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  /** Subscribe to orderbook updates for a token. Returns unsubscribe fn. */
  subscribe(tokenId: string, handler: OrderbookHandler): () => void {
    if (!this.handlers.has(tokenId)) this.handlers.set(tokenId, []);
    this.handlers.get(tokenId)!.push(handler);

    if (!this.subscribedTokens.has(tokenId)) {
      this.subscribedTokens.add(tokenId);
      this.sendSubscription([tokenId]);
    }

    return () => {
      const list = this.handlers.get(tokenId) ?? [];
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  connect(): void {
    if (this.destroyed) return;
    try {
      this.ws = new WebSocket(CLOB_WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectDelay = RECONNECT_DELAY_MS;
      console.log('[ClobWS] Connected to', CLOB_WS_URL);
      // Re-subscribe all tracked tokens
      const all = [...this.subscribedTokens];
      if (all.length) this.sendSubscription(all);
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        // Server sends arrays of messages
        const parsed: ClobMessage | ClobMessage[] = JSON.parse(raw);
        const msgs = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of msgs) this.handleMessage(msg);
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onerror = (err) => {
      console.warn('[ClobWS] Error:', (err as any).message ?? err);
    };

    this.ws.onclose = () => {
      console.warn('[ClobWS] Disconnected — reconnecting in', this.reconnectDelay, 'ms');
      this.stopPing();
      this.scheduleReconnect();
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  // --------------------------------------------------------------------------

  private handleMessage(msg: ClobMessage): void {
    if (msg.event_type === 'book') {
      const m = msg as ClobBookMessage;
      const snapshot = this.buildSnapshot(m);
      this.bookCache.set(m.asset_id, snapshot);
      this.emit(m.asset_id, snapshot);
    } else if (msg.event_type === 'price_change') {
      const m = msg as ClobPriceChangeMessage;
      const cached = this.bookCache.get(m.asset_id);
      if (!cached) return; // wait for initial book snapshot
      const updated = this.applyPriceChange(cached, m);
      this.bookCache.set(m.asset_id, updated);
      this.emit(m.asset_id, updated);
    }
  }

  private buildSnapshot(m: ClobBookMessage): OrderbookSnapshot {
    return {
      tokenId: m.asset_id,
      assetId: m.asset_id,
      market: m.market ?? '',
      hash: m.hash ?? '',
      tickSize: '0.01',
      minOrderSize: '5',
      timestamp: m.timestamp ? parseInt(m.timestamp, 10) : Date.now(),
      bids: (m.bids ?? []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
                           .filter(l => l.price > 0)
                           .sort((a, b) => b.price - a.price),
      asks: (m.asks ?? []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
                           .filter(l => l.price > 0)
                           .sort((a, b) => a.price - b.price),
    };
  }

  private applyPriceChange(base: OrderbookSnapshot, m: ClobPriceChangeMessage): OrderbookSnapshot {
    const bids = [...base.bids];
    const asks = [...base.asks];

    for (const change of m.changes) {
      const price = parseFloat(change.price);
      const size  = parseFloat(change.size);
      const levels = change.side === 'BUY' ? bids : asks;
      const idx = levels.findIndex(l => l.price === price);

      if (size === 0) {
        if (idx !== -1) levels.splice(idx, 1);
      } else if (idx !== -1) {
        levels[idx] = { price, size };
      } else {
        levels.push({ price, size });
      }
    }

    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    return { ...base, bids, asks, timestamp: Date.now() };
  }

  private emit(tokenId: string, book: OrderbookSnapshot): void {
    for (const handler of this.handlers.get(tokenId) ?? []) {
      try { handler(book); } catch { /* never crash the feed */ }
    }
  }

  private sendSubscription(tokenIds: string[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({ assets_ids: tokenIds, type: 'market' });
    this.ws.send(msg);
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping');
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

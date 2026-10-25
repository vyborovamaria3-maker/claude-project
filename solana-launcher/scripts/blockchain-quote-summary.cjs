"use strict";
// Settlement totals are denominated in each quote token. Incomplete inventory
// and absent FX evidence cannot produce a SOL PnL contribution.
function summarizeQuotes(trades) {
  const groups=new Map();
  for(const t of trades) {
    if(!t.trader || !t.quoteMint || !['buy','sell'].includes(t.type)
      || !Number.isInteger(t.quoteDecimals) || t.quoteDecimals<0 || t.quoteDecimals>18
      || !/^[0-9]+$/.test(t.quoteAmountRaw||'') || BigInt(t.quoteAmountRaw)<=0n) throw Error('Invalid quote settlement evidence');
    const key=JSON.stringify([t.trader,t.quoteMint]), prior=groups.get(key);
    if(prior && prior.quoteDecimals!==t.quoteDecimals) throw Error('Conflicting quote decimals');
    const g=prior||{address:t.trader,quoteMint:t.quoteMint,quoteDecimals:t.quoteDecimals,buys:0,sells:0,buyQuoteRaw:0n,sellQuoteRaw:0n};
    if(t.type==='buy'){g.buys++;g.buyQuoteRaw+=BigInt(t.quoteAmountRaw)}else{g.sells++;g.sellQuoteRaw+=BigInt(t.quoteAmountRaw)}
    groups.set(key,g);
  }
  return [...groups.values()].map(g=>({...g,buyQuoteRaw:String(g.buyQuoteRaw),sellQuoteRaw:String(g.sellQuoteRaw),realizedPnl:null,pnlStatus:'unavailable_incomplete_inventory'}));
}
function rebuildQuoteSummary(db,mint,trades) {
  const rows=summarizeQuotes(trades);
  db.transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS chain_trade_quote_summary (
      mint TEXT NOT NULL,address TEXT NOT NULL,quote_mint TEXT NOT NULL,quote_decimals INTEGER NOT NULL,
      buys INTEGER NOT NULL,sells INTEGER NOT NULL,buy_quote_raw TEXT NOT NULL,sell_quote_raw TEXT NOT NULL,
      realized_pnl REAL,pnl_status TEXT NOT NULL,updated_at INTEGER NOT NULL,
      PRIMARY KEY(mint,address,quote_mint))`);
    db.prepare('DELETE FROM chain_trade_quote_summary WHERE mint=?').run(mint);
    const put=db.prepare('INSERT INTO chain_trade_quote_summary VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for(const r of rows)put.run(mint,r.address,r.quoteMint,r.quoteDecimals,r.buys,r.sells,r.buyQuoteRaw,r.sellQuoteRaw,r.realizedPnl,r.pnlStatus,Date.now());
  })();
  return rows;
}
// Legacy SOL cache columns are NOT NULL. Zero is only the unvalued
// contribution placeholder; the explicit status prevents treating it as a
// calculated break-even result. Quote PnL remains NULL in the quote cache.
function markSolPnlUnavailable(db,mint,addresses) {
  db.transaction(()=>{
    for(const table of ['wallet_token_stats','wallet_stats']) {
      if(!db.pragma('table_info('+table+')').some(c=>c.name==='pnl_status'))
        db.exec('ALTER TABLE '+table+" ADD COLUMN pnl_status TEXT NOT NULL DEFAULT 'legacy_diagnostic'");
    }
    db.prepare("UPDATE wallet_token_stats SET pnl_status='unavailable_incomplete_inventory' WHERE mint=?").run(mint);
    const update=db.prepare("UPDATE wallet_stats SET pnl_status='partial_non_sol_or_inventory' WHERE address=?");
    for(const address of addresses) update.run(address);
  })();
}
module.exports={summarizeQuotes,rebuildQuoteSummary,markSolPnlUnavailable};

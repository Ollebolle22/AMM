/**
 * Gunbot Derivatives Grid MM – robust, role-based (LONG/SHORT)
 * - Fungerar även utan candles-historik
 * - Inventory- & margin-aware
 * - Recenter + skew mot motsatt håll
 * - Städar felplacerade ordrar, throttlar orderläggning
 * - Failsafe för prisdata, fri marginal, openOrders-API (med backoff)
 * - Utökade metrics i sidopanelen: Unrealized/Realized PnL, ROE, CAGR, MaxDD,
 *   HODL-jämförelse (USDT/COIN), % till likvid/BE, approx MM% m.m.
 * Node 14.4. Ingen ||=.
 */

(async () => {
  // ==== Grundkrav ====
  if (!gb || !gb.data || !gb.data.pairLedger) { console.log('[GRID] missing gb.data'); return; }
  if (!gb.data.pairLedger.customStratStore || typeof gb.data.pairLedger.customStratStore !== 'object') {
    gb.data.pairLedger.customStratStore = {};
  }
  const S = gb.data.pairLedger.customStratStore;

  // ==== Defaults (ändra i runtime via customStratStore) ====
  if (typeof S.role !== 'string') S.role = 'long';            // 'long' eller 'short'
  if (typeof S.gridStepPct !== 'number') S.gridStepPct = 0.003; // 0.3%
  if (typeof S.levelsPerSide !== 'number') S.levelsPerSide = 6;
  if (typeof S.allocPct !== 'number') S.allocPct = 0.25;        // andel av fri marginal att lägga ut
  if (typeof S.invMaxPct !== 'number') S.invMaxPct = 0.12;      // max inventory vs equity
  if (typeof S.skewK !== 'number') S.skewK = 0.8;               // styrka för inventory-skew
  if (typeof S.recenterEveryMs !== 'number') S.recenterEveryMs = 60_000;
  if (typeof S.cancelTolerancePct !== 'number') S.cancelTolerancePct = 0.20 / 100; // 0.20%
  if (typeof S.cooldownMs !== 'number') S.cooldownMs = 8000;
  if (typeof S.maxActiveOrders !== 'number') S.maxActiveOrders = 50;
  if (typeof S.minBaseAmt !== 'number') S.minBaseAmt = 1e-9;
  if (typeof S.usePostOnly !== 'boolean') S.usePostOnly = false;
  if (typeof S.trimInsidePct !== 'number') S.trimInsidePct = 0.25; // liten trim nära center

  // Valfria steg för avrundning (fyll rätt steg för paret vid behov)
  if (typeof S.qtyStep !== 'number') S.qtyStep = 0;    // t.ex. 0.1 DOGE, 0 = ingen avrundning
  if (typeof S.priceStep !== 'number') S.priceStep = 0; // t.ex. 0.0001 USDT, 0 = ingen avrundning

  // Failsafe
  if (typeof S.failsafeEnabled !== 'boolean') S.failsafeEnabled = true;
  if (typeof S.maxStaleMs !== 'number') S.maxStaleMs = 30_000;
  if (typeof S.minFreeMarginPct !== 'number') S.minFreeMarginPct = 0.00;
  if (typeof S.paused !== 'boolean') S.paused = false;
  if (typeof S.lastPauseReason !== 'string') S.lastPauseReason = '';
  if (typeof S.lastGoodTs !== 'number') S.lastGoodTs = 0;

  // Extra failsafe-state
  if (typeof S.openOrdersFailSince !== 'number') S.openOrdersFailSince = 0;
  if (typeof S.apiBackoffUntil !== 'number') S.apiBackoffUntil = 0; // epoch ms
  if (typeof S.apiBackoffMs !== 'number') S.apiBackoffMs = 0;       // senaste backoffvärde
  if (typeof S.apiBackoffMax !== 'number') S.apiBackoffMax = 120_000; // max 2m backoff

  // Manuell center-reset flag
  if (typeof S.resetCenter !== 'boolean') S.resetCenter = false;

  // Metrics state (egna beräkningar)
  if (typeof S.startTs !== 'number') S.startTs = 0;
  if (typeof S.startEquity !== 'number') S.startEquity = 0;
  if (typeof S.startPrice !== 'number') S.startPrice = 0;
  if (typeof S.hodlQty !== 'number') S.hodlQty = 0;     // HODL_COINS: hur många coins vid start
  if (!Array.isArray(S.eqHist)) S.eqHist = [];           // [{t, eq, p}]
  if (typeof S.eqPeak !== 'number') S.eqPeak = 0;
  if (typeof S.maxDD !== 'number') S.maxDD = 0;          // i %
  if (typeof S.realizedPnL !== 'number') S.realizedPnL = 0; // proxy
  if (typeof S.lastFlatEq !== 'number') S.lastFlatEq = 0;   // equity när vi senast var helt flat
  if (typeof S.wasFlat !== 'boolean') S.wasFlat = true;     // var vi flat förra cykeln?

  // State
  const now = Date.now();
  if (typeof S.center !== 'number') S.center = 0;
  if (typeof S.lastCycleTs !== 'number') S.lastCycleTs = 0;
  if (typeof S.lastRecenterTs !== 'number') S.lastRecenterTs = 0;

  // ==== Miljödata ====
  const pair = gb.data.pairName || '';
  const ex = gb.data.exchangeName || '';

  const bid = Number.isFinite(gb.data.bid) ? gb.data.bid : 0;
  const ask = Number.isFinite(gb.data.ask) ? gb.data.ask : 0;
  const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : Math.max(bid, ask);
  const priceOk = (bid > 0 && ask > 0 && ask >= bid);
  if (priceOk) S.lastGoodTs = now;
  if (!(price > 0)) {
    // Pris saknas. Visa status men lägg inte ordrar.
    S.paused = true; S.lastPauseReason = 'Price data missing';
  }

  // Derivatdata
  const wallet = Number.isFinite(gb.data.walletBalance) ? gb.data.walletBalance : 0; // quote
  const qty = Number.isFinite(gb.data.currentQty) ? gb.data.currentQty : 0;          // base (+ long, - short)
  const breakEven = Number.isFinite(gb.data.breakEven) ? gb.data.breakEven : 0;     // 0 om okänt
  const liq = Number.isFinite(gb.data.liquidationPrice) ? gb.data.liquidationPrice : 0;
  if (typeof S.leverage !== 'number') S.leverage = 10;

  // === Robust equity/marginal (hantera okänt breakEven) ===
  const equity = () => {
    const effectiveBE = (breakEven > 0 ? breakEven : price);
    const pnl = (price > 0 && effectiveBE > 0) ? qty * (price - effectiveBE) : 0;
    return wallet + pnl;
  };
  const marginUsed = () => Math.abs(qty) * (price > 0 ? price : 1) / Math.max(1, S.leverage);
  const freeMargin = () => Math.max(0, equity() - marginUsed());

  // Initiera metrics första gången vi har giltig data
  if (price > 0 && equity() > 0 && S.startTs === 0) {
    S.startTs = now;
    S.startEquity = equity();
    S.startPrice = price;
    S.hodlQty = S.startPrice > 0 ? (S.startEquity / S.startPrice) : 0;
    S.eqPeak = S.startEquity;
    S.lastFlatEq = S.startEquity; // bas för realized PnL
    console.log('[GRID] metrics init startEq=', S.startEquity.toFixed(4), 'startP=', S.startPrice.toFixed(8));
  }

  // Inventory-ratio [-1..1]
  const invRatio = (() => {
    const eq = Math.max(1e-9, equity());
    const maxNotional = Math.max(1e-6, S.invMaxPct * eq);
    const curNotional = Math.abs(qty) * (price > 0 ? price : 1);
    const r = curNotional / maxNotional;
    const sign = qty >= 0 ? 1 : -1;
    const v = sign * r;
    return v > 1 ? 1 : (v < -1 ? -1 : v);
  })();

  // ==== Failsafe ====
  let pauseReason = '';
  if (S.failsafeEnabled) {
    const stale = now - S.lastGoodTs > S.maxStaleMs;
    if (!priceOk) pauseReason = 'Price data missing';
    else if (stale) pauseReason = 'Price data stale';
    else {
      const eq = equity();
      const fm = freeMargin();
      const minFM = Math.max(0, S.minFreeMarginPct * Math.max(1e-9, eq));
      if (fm <= minFM) pauseReason = 'Low free margin';
    }
  }

  // ==== Center & step ====
  const stepAbs = (price > 0 ? price : 1) * Math.max(0.0001, S.gridStepPct);
  const centerTarget = price > 0 ? (price - S.skewK * invRatio * stepAbs) : (S.center || 0);

  // Adaptiv recenter: lägre tröskel vid små gridsteg
  const drift = price > 0 ? Math.abs((S.center - centerTarget) / price) : 0;
  const driftThreshold = Math.max(0.001, S.gridStepPct / 2); // minst 0.1% eller halva gridsteget
  const needRecenter = (now - S.lastRecenterTs > S.recenterEveryMs) || (drift > driftThreshold);

  // Manuell reset
  if (S.resetCenter && price > 0) {
    S.center = price;
    S.lastRecenterTs = now;
    S.resetCenter = false;
    gb.data.pairLedger.notifications = [
      { text: `Manual center reset to ${price.toFixed(6)}`, variant: 'info', persist: false }
    ];
  } else if (needRecenter) {
    S.center = centerTarget;
    S.lastRecenterTs = now;
  }

  // ==== Bygg grid ====
  const levels = Math.max(1, Math.min(S.levelsPerSide, 25));
  const allocQuote = freeMargin() * Math.max(0, Math.min(1, S.allocPct));
  const weights = []; for (let i = 1; i <= levels; i++) weights.push(1 / i);
  const wSum = weights.reduce((a, b) => a + b, 0);

  // Hjälpare för avrundning
  const roundToStep = (v, step) => {
    if (!Number.isFinite(v)) return 0;
    if (!Number.isFinite(step) || step <= 0) return v;
    return Math.round(v / step) * step;
  };

  const bids = []; const asks = [];
  const sizeBaseB = []; const sizeBaseA = [];
  for (let i = 1; i <= levels; i++) {
    let b = S.center - i * stepAbs;
    let a = S.center + i * stepAbs;
    b = roundToStep(b, S.priceStep);
    a = roundToStep(a, S.priceStep);
    bids.push(b); asks.push(a);

    const perLevelQuote = allocQuote * (weights[i - 1] / wSum);
    let baseAmt = perLevelQuote / Math.max(1e-9, (price > 0 ? price : 1));
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) baseAmt = 0;
    baseAmt = Math.max(S.minBaseAmt, baseAmt);
    baseAmt = roundToStep(baseAmt, S.qtyStep);
    sizeBaseB.push(baseAmt); sizeBaseA.push(baseAmt);
  }

  // ==== Throttle / Open Orders Failsafe ====
  const cycleDue = now - S.lastCycleTs > S.cooldownMs;
  const tol = S.cancelTolerancePct * (price > 0 ? price : 1);

  // === Open Orders Failsafe (NY) ===
  let oo = [];
  if (!Array.isArray(gb.data.openOrders)) {
    console.warn('[GRID] ⚠️ openOrders saknas – använder tom array');
    if (!S.openOrdersFailSince) S.openOrdersFailSince = now;
    oo = [];
  } else {
    oo = gb.data.openOrders;
    S.openOrdersFailSince = 0; // återställ om allt OK
  }

  // Backoff: om openOrders saknas eller nyligen saknats, fördröj gridarbete
  let apiUnstable = false;
  if (S.failsafeEnabled) {
    if (S.openOrdersFailSince > 0) apiUnstable = true;
    if (S.apiBackoffUntil > now) apiUnstable = true;
  }

  if (S.failsafeEnabled && S.openOrdersFailSince > 0 && (now - S.openOrdersFailSince > 3 * S.cooldownMs)) {
    if (!pauseReason) pauseReason = 'openOrders missing or delayed';
    // exponentiell backoff
    const next = S.apiBackoffMs > 0 ? Math.min(S.apiBackoffMs * 2, S.apiBackoffMax) : 10_000;
    S.apiBackoffMs = next;
    S.apiBackoffUntil = now + S.apiBackoffMs;
    gb.data.pairLedger.notifications = [
      { text: `⚠️ openOrders timeout – pausar och backoff ${Math.round(next/1000)}s`, variant: 'error', persist: false }
    ];
  }

  const prevPauseKey = (S.paused ? S.lastPauseReason : '');
  const changed = prevPauseKey !== pauseReason;
  if (pauseReason) {
    if (!S.paused || changed) {
      S.paused = true; S.lastPauseReason = pauseReason;
      gb.data.pairLedger.notifications = [
        { text: `FAILSAFE: ${pauseReason}. Pausing orders.`, variant: 'error', persist: false }
      ];
    }
  } else if (S.paused) {
    S.paused = false; S.lastPauseReason = '';
    gb.data.pairLedger.notifications = [
      { text: 'Failsafe cleared. Resuming.', variant: 'success', persist: false }
    ];
  }

  // ==== Orderunderhåll + läggning ====
  if (cycleDue && !S.paused && !apiUnstable) {
    // Cancel ordrar som avviker för mycket från grid
    for (const o of oo) {
      const id = o.id; const side = o.type; const rate = Number.isFinite(o.rate) ? o.rate : 0;
      let keep = false;
      if (side === 'buy') { for (let i = 0; i < bids.length; i++) if (Math.abs(rate - bids[i]) <= tol) { keep = true; break; } }
      else if (side === 'sell') { for (let i = 0; i < asks.length; i++) if (Math.abs(rate - asks[i]) <= tol) { keep = true; break; } }
      if (!keep) { try { gb.method.cancelOrder(id, pair, ex); } catch (e) { /* noop */ } }
    }

    // Önskade order per roll
    const want = [];
    if (S.role === 'long') {
      for (let i = 0; i < bids.length; i++) want.push({ side: 'buy', px: bids[i], amt: sizeBaseB[i] });
      const trims = Math.min(2, asks.length);
      for (let i = 0; i < trims; i++) want.push({ side: 'sell', px: asks[i], amt: sizeBaseA[i] * S.trimInsidePct });
    } else {
      for (let i = 0; i < asks.length; i++) want.push({ side: 'sell', px: asks[i], amt: sizeBaseA[i] });
      const trims = Math.min(2, bids.length);
      for (let i = 0; i < trims; i++) want.push({ side: 'buy', px: bids[i], amt: sizeBaseB[i] * S.trimInsidePct });
    }

    // Dubblettskydd (lokalt) under denna cykel
    if (!Array.isArray(S.recentPlaced)) S.recentPlaced = [];
    // Purge gamla (äldre än 3*cooldown)
    S.recentPlaced = S.recentPlaced.filter(x => now - x.ts <= 3 * S.cooldownMs);

    // Lägg saknade upp till gränser
    const openCount = oo.length;
    let added = 0;
    const maxAdd = Math.max(1, Math.min(10, S.maxActiveOrders));

    const placeOne = async (side, px, amt) => {
      try {
        // Extra lokalt dubblettskydd: om vi nyss la nästan exakt denna
        for (const r of S.recentPlaced) {
          if (r.side === side && Math.abs(r.px - px) <= tol) {
            console.log('[GRID] skipped place (recent duplicate)', side, amt, '@', px);
            return false;
          }
        }

        if (S.usePostOnly) {
          if (side === 'buy') await gb.method.buyLimitPostOnly(amt, px, pair, ex);
          else await gb.method.sellLimitPostOnly(amt, px, pair, ex);
        } else {
          if (side === 'buy') await gb.method.buyLimit(amt, px, pair, ex);
          else await gb.method.sellLimit(amt, px, pair, ex);
        }
        S.recentPlaced.push({ side, px, ts: Date.now() });
        console.log('[GRID]', S.role, 'placed', side, amt, '@', px);
        return true;
      } catch (e) {
        console.log('[GRID] place err', side, px, e && e.message ? e.message : e);
        return false;
      }
    };

    for (const w of want) {
      if (openCount + added >= S.maxActiveOrders || added >= maxAdd) break;

      // Existerar redan på börsen inom tolerans?
      let exists = false;
      for (const o of oo) {
        const sameSide = o.type === w.side; const rate = Number.isFinite(o.rate) ? o.rate : 0;
        if (sameSide && Math.abs(rate - w.px) <= tol) { exists = true; break; }
      }
      if (exists) continue;

      // Finns i våra nyligen lagda (race-skydd)?
      let recentDup = false;
      for (const r of S.recentPlaced) {
        if (r.side === w.side && Math.abs(r.px - w.px) <= tol) { recentDup = true; break; }
      }
      if (recentDup) continue;

      const ok = await placeOne(w.side, w.px, w.amt);
      if (ok) added++;
    }

    if (added > 0) {
      gb.data.pairLedger.notifications = [
        { text: `Grid ${S.role.toUpperCase()}: +${added} nya`, variant: 'info', persist: false }
      ];
    }

    S.lastCycleTs = now;
  }

  // ==== Metrics & Sidebar (egna beräkningar) ====
  const curEq = equity();
  const curP  = price > 0 ? price : 0;
  const lev = Math.max(1, S.leverage);
  const notional = Math.abs(qty) * curP;

  // Historik: sampel var 30–60s (tunna ut via cooldown)
  if (curEq > 0 && curP > 0) {
    const lastPt = S.eqHist.length ? S.eqHist[S.eqHist.length-1] : null;
    if (!lastPt || now - lastPt.t > Math.max(30_000, S.cooldownMs)) {
      S.eqHist.push({ t: now, eq: curEq, p: curP });
      if (S.eqHist.length > 5000) S.eqHist.shift();
    }
  }

  // Peak & max drawdown
  if (curEq > S.eqPeak) S.eqPeak = curEq;
  const ddPct = S.eqPeak > 0 ? (1 - curEq / S.eqPeak) * 100 : 0;
  if (ddPct > S.maxDD) S.maxDD = ddPct;

  // Unrealized PnL & ROE från start (proxy)
  const baseEq = (S.eqHist.length ? S.eqHist[0].eq : (S.startEquity || curEq));
  const uPnL = curEq - baseEq;
  const roePct = (S.startEquity > 0) ? (curEq / S.startEquity - 1) * 100 : 0;

  // CAGR (årlig)
  let cagrPct = 0;
  if (S.startTs > 0 && curEq > 0 && S.startEquity > 0) {
    const years = Math.max(1/365, (now - S.startTs) / (365 * 24 * 3600 * 1000));
    const cagr = Math.pow(curEq / S.startEquity, 1 / years) - 1;
    cagrPct = cagr * 100;
  }

  // HODL benchmarks
  const hodlUSDT = S.startEquity || 0;                 // Håll bara kontant
  const hodlCoinEq = S.hodlQty * curP;                 // Håll coin från start
  const alphaUSDT = curEq - hodlUSDT;                  // över/under kontant baseline
  const alphaCoin = curEq - hodlCoinEq;                // över/under coin-HODL

  // % till likvid & % till BE
  let toLiqPct = 0;
  if (liq > 0 && curP > 0) {
    if (qty >= 0) toLiqPct = ((curP - liq) / curP) * 100;   // long: hur långt ned till liq
    else           toLiqPct = ((liq - curP) / curP) * 100;   // short: hur långt upp till liq
  }
  const be = (breakEven > 0 ? breakEven : 0);
  const toBEPct = (be > 0 && curP > 0) ? ((curP - be) / curP) * 100 : 0; // + över BE, - under BE

  // Risk-/margin-nyckeltal (egna approximationer)
  const mr = (curEq > 0) ? (marginUsed() / curEq) * 100 : 0;     // margin ratio (%)
  const mmApproxPct = (typeof S.mmPct === 'number') ? S.mmPct : 0.5; // % av notional (approx)
  const maintMargin = (notional * mmApproxPct / 100);

  // Realized PnL proxy: när positionen går från non-zero -> zero
  const flatNow = Math.abs(qty) < 1e-9;
  if (!S.wasFlat && flatNow) {
    if (S.lastFlatEq === 0) S.lastFlatEq = curEq; // init om saknas
    // ökning i equity sedan förra flat-tillfället betraktas som realized
    const delta = curEq - S.lastFlatEq;
    if (Number.isFinite(delta)) S.realizedPnL += delta;
    S.lastFlatEq = curEq; // uppdatera bas
  }
  if (flatNow) {
    if (S.lastFlatEq === 0) S.lastFlatEq = curEq;
  }
  S.wasFlat = flatNow;

  // ==== Visuals (frivilligt i GUI) ====
  const makeLine = (txt, px, color) => ({
    text: txt, price: px, lineStyle: 2, lineWidth: 1, lineColor: color,
    bodyBackgroundColor: '#fff', quantityBackgroundColor: '#1f1f1f'
  });
  const lines = [ makeLine('Grid Center', S.center, S.paused ? '#999' : '#78a6ff') ];
  for (let i = 0; i < Math.min(8, levels); i++) {
    const step = (price > 0 ? price : 1) * S.gridStepPct;
    lines.push(makeLine(`Bid L${i+1}`, S.center - (i+1) * step, S.paused ? '#295c3a' : '#53cf77'));
    lines.push(makeLine(`Ask L${i+1}`, S.center + (i+1) * step, S.paused ? '#6b2d2d' : '#cf5353'));
  }
  gb.data.pairLedger.customChartTargets = lines;

  // ==== Sidopanel ====
  const statusTxt = S.paused ? `PAUSED: ${S.lastPauseReason || 'unknown'}` : 'RUNNING';
  gb.data.pairLedger.sidebarExtras = [
    { label: 'Role', value: S.role.toUpperCase() },
    { label: 'Status', value: statusTxt, valueColor: S.paused ? '#ffb4a2' : '#b7f7c1' },

    { label: 'Price', value: (curP).toFixed(6) },
    { label: 'Center', value: S.center.toFixed(6) },
    { label: 'Step %', value: (S.gridStepPct * 100).toFixed(3) + '%' },
    { label: 'Levels/side', value: String(S.levelsPerSide) },
    { label: 'Skew', value: S.skewK.toFixed(2) },
    { label: 'Alloc %', value: (S.allocPct * 100).toFixed(0) + '%' },

    { label: 'Leverage', value: String(lev) + 'x' },
    { label: 'Wallet', value: (Number.isFinite(wallet) ? wallet : 0).toFixed(2) },
    { label: 'Equity (now)', value: (curEq).toFixed(2) },
    { label: 'Equity (start)', value: (S.startEquity || 0).toFixed(2) },

    { label: 'Unrealized PnL', value: (uPnL).toFixed(2) },
    { label: 'Realized PnL*', value: (S.realizedPnL).toFixed(2), tooltip: 'Proxy: summering av equity-ökning vid flat events' },
    { label: 'ROE %', value: roePct.toFixed(2) + '%' },
    { label: 'CAGR % (annual)', value: cagrPct.toFixed(2) + '%' },

    { label: 'Max DD %', value: (S.maxDD).toFixed(2) + '%' },
    { label: 'Notional', value: notional.toFixed(2) },
    { label: 'Margin used', value: marginUsed().toFixed(2) },
    { label: 'Margin ratio %', value: mr.toFixed(2) + '%' },

    { label: 'Liq price', value: (liq || 0).toFixed(6) },
    { label: '% to Liq', value: toLiqPct.toFixed(2) + '%' },
    { label: 'BreakEven', value: (be || 0).toFixed(6) },
    { label: '% vs BE', value: toBEPct.toFixed(2) + '%' },

    { label: 'HODL(USDT) Eq', value: (hodlUSDT).toFixed(2) },
    { label: 'α vs HODL(USDT)', value: (alphaUSDT).toFixed(2) },
    { label: 'HODL(COIN) Eq', value: (hodlCoinEq).toFixed(2) },
    { label: 'α vs HODL(COIN)', value: (alphaCoin).toFixed(2) },

    { label: 'Maint. Margin ~', value: maintMargin.toFixed(2), tooltip: 'Approx baserat på S.mmPct' },
    { label: 'Open orders', value: String(Array.isArray(gb.data.openOrders) ? gb.data.openOrders.length : 0) },
    {
      label: 'Orders fail since',
      value: S.openOrdersFailSince ? new Date(S.openOrdersFailSince).toLocaleTimeString() : '-',
      tooltip: 'Tidpunkt då openOrders senast saknades'
    },
    {
      label: 'API backoff',
      value: S.apiBackoffUntil > now ? `${Math.ceil((S.apiBackoffUntil - now)/1000)}s` : '-',
      tooltip: 'Backoff-interval vid API-fel'
    },
  ];

  // ==== Log ====
  console.log(`[GRID] role=${S.role} status=${S.paused?'PAUSED':'RUNNING'} reason=${S.lastPauseReason||'-'} p=${(price>0?price:0).toFixed(6)} center=${S.center.toFixed(6)} step%=${(S.gridStepPct*100).toFixed(3)} levels=${S.levelsPerSide}`);
})();

/**
 * Gunbot Derivatives Grid MM – robust, role-based (LONG/SHORT)
 * - Fungerar utan candles-historik
 * - Inventory- & margin-aware
 * - Recenter + skew
 * - Städar/ersätter felplacerade ordrar, throttlar läggning
 * - Failsafe för prisdata, fri marginal, openOrders-API (med backoff)
 * - Utökade metrics i sidopanelen
 * Node 14.4. Ingen ||=.
 */

(async () => {
  // ==== Grundkrav ====  (namespacat state per roll)
  if (!gb || !gb.data || !gb.data.pairLedger) { console.log('[GRID] missing gb.data'); return; }
  const pl = gb.data.pairLedger;
  if (typeof pl._gridStores !== 'object' || !pl._gridStores) pl._gridStores = {};
  const roleKey = (
    (gb && typeof gb.role === 'string' && gb.role) ||
    (gb && gb.envRole) ||
    (pl.customStratStore && typeof pl.customStratStore.role === 'string' && pl.customStratStore.role) ||
    'long'
  ).toLowerCase();
  if (!pl._gridStores[roleKey]) pl._gridStores[roleKey] = {};
  const S = pl._gridStores[roleKey];
  if (typeof S.role !== 'string') S.role = roleKey;  // 'long' | 'short'

  // ==== Defaults (ändra i runtime via customStratStore) ====
  if (typeof S.gridStepPct !== 'number') S.gridStepPct = 0.003;
  if (typeof S.allocPct !== 'number') S.allocPct = 0.05;          // 5% av fri marginal
  if (typeof S.invMaxPct !== 'number') S.invMaxPct = 0.12;
  if (typeof S.skewK !== 'number') S.skewK = 0.8;
  if (typeof S.recenterEveryMs !== 'number') S.recenterEveryMs = 60_000;
  if (typeof S.cancelTolerancePct !== 'number') S.cancelTolerancePct = 0.20 / 100; // 0.20%
  if (typeof S.replaceTriggerPct !== 'number') {
    const defaultTrigger = Math.max(S.gridStepPct * 0.5, S.cancelTolerancePct * 1.5);
    S.replaceTriggerPct = defaultTrigger;
  }
  if (typeof S.cooldownMs !== 'number') S.cooldownMs = 8000;      // t.ex. 6s exchange delay externt
  if (typeof S.minBaseAmt !== 'number') S.minBaseAmt = 1e-9;
  if (typeof S.usePostOnly !== 'boolean') S.usePostOnly = false;
  if (typeof S.localOrderTimeoutMs !== 'number') S.localOrderTimeoutMs = 15_000;

  // Samlad orderplan-konfiguration
  if (!S.orderPlan || typeof S.orderPlan !== 'object') S.orderPlan = {};
  const orderPlan = S.orderPlan;
  const legacyLevels = Number.isFinite(S.levelsPerSide) ? S.levelsPerSide : 3;
  const legacyTrims = Number.isFinite(S.trimLevels) ? S.trimLevels : 1;
  const legacyMaxActive = Number.isFinite(S.maxActiveOrders)
    ? S.maxActiveOrders
    : 2 * legacyLevels + legacyTrims;
  if (!Number.isFinite(orderPlan.levels)) orderPlan.levels = legacyLevels;
  if (!Number.isFinite(orderPlan.trimLevels)) orderPlan.trimLevels = legacyTrims;
  if (!Number.isFinite(orderPlan.maxActive)) orderPlan.maxActive = legacyMaxActive;
  if (!Number.isFinite(orderPlan.maxPerCycle)) {
    const fallbackCycle = Number.isFinite(S.maxAddPerCycle) ? S.maxAddPerCycle : Math.min(4, orderPlan.maxActive);
    orderPlan.maxPerCycle = Math.max(1, fallbackCycle);
  }
  if (!Number.isFinite(orderPlan.placeSpacingMs)) {
    const legacySpacing = Number.isFinite(S.placeSpacingMs) ? S.placeSpacingMs : 400;
    orderPlan.placeSpacingMs = Math.max(0, legacySpacing);
  }
  if (!Number.isFinite(orderPlan.trimCooldownMs)) {
    const legacyTrimCooldown = Number.isFinite(S.trimCooldownMs) ? S.trimCooldownMs : 15_000;
    orderPlan.trimCooldownMs = Math.max(0, legacyTrimCooldown);
  }
  if (!Number.isFinite(orderPlan.maxReplacesPerCycle)) {
    const legacyMaxReplace = Number.isFinite(S.maxReplacePerCycle)
      ? S.maxReplacePerCycle
      : Math.max(1, Math.floor(orderPlan.maxPerCycle / 2));
    orderPlan.maxReplacesPerCycle = Math.max(0, legacyMaxReplace);
  }
  if (!Number.isFinite(orderPlan.replaceCooldownMs)) {
    const legacyReplaceCooldown = Number.isFinite(S.replaceCooldownMs)
      ? S.replaceCooldownMs
      : Math.max(S.cooldownMs, 5_000);
    orderPlan.replaceCooldownMs = Math.max(0, legacyReplaceCooldown);
  }
  if (!Number.isFinite(orderPlan.trimDistanceFactor)) {
    const legacyTrimDistance = Number.isFinite(S.trimDistanceFactor) ? S.trimDistanceFactor : 0.35;
    orderPlan.trimDistanceFactor = Math.max(0.05, Math.min(2, legacyTrimDistance));
  }
  if (!Number.isFinite(S.trimInsidePct)) S.trimInsidePct = 0.15; // trims nära center, 15% av normal storlek

  // Spegla till legacy-fält för bakåtkompatibilitet i runtime-inställningar
  S.levelsPerSide = orderPlan.levels;
  S.trimLevels = orderPlan.trimLevels;
  S.maxActiveOrders = orderPlan.maxActive;
  S.maxReplacePerCycle = orderPlan.maxReplacesPerCycle;
  S.replaceCooldownMs = orderPlan.replaceCooldownMs;
  S.trimDistanceFactor = orderPlan.trimDistanceFactor;

  // Tick/lot defaults (justera per instrument vid behov)
  if (typeof S.priceStep !== 'number') S.priceStep = 0.0001; // ex. DOGEUSDT typiskt 0.0001
  if (typeof S.qtyStep !== 'number')   S.qtyStep   = 1;      // ex. 1 DOGE

  // Orderstorleksregler
  if (typeof S.minOrderQuote !== 'number') S.minOrderQuote = 5;        // min 5 USDT per order
  if (typeof S.maxOrderQuotePct !== 'number') S.maxOrderQuotePct = 0.01; // max 1% av equity per order

  // Failsafe
  if (typeof S.failsafeEnabled !== 'boolean') S.failsafeEnabled = true;
  if (typeof S.maxStaleMs !== 'number') S.maxStaleMs = 30_000;
  if (typeof S.minFreeMarginPct !== 'number') S.minFreeMarginPct = 0.00;
  if (typeof S.paused !== 'boolean') S.paused = false;
  if (typeof S.lastPauseReason !== 'string') S.lastPauseReason = '';
  if (typeof S.lastGoodTs !== 'number') S.lastGoodTs = 0;

  // Extra failsafe-state
  if (typeof S.openOrdersFailSince !== 'number') S.openOrdersFailSince = 0;
  if (typeof S.apiBackoffUntil !== 'number') S.apiBackoffUntil = 0;
  if (typeof S.apiBackoffMs !== 'number') S.apiBackoffMs = 0;
  if (typeof S.apiBackoffMax !== 'number') S.apiBackoffMax = 120_000;
  if (typeof S.apiFailCount !== 'number') S.apiFailCount = 0;
  if (typeof S.lastApiError !== 'string') S.lastApiError = '';

  // Manuell center-reset
  if (typeof S.resetCenter !== 'boolean') S.resetCenter = false;

  // Metrics state
  if (typeof S.startTs !== 'number') S.startTs = 0;
  if (typeof S.startEquity !== 'number') S.startEquity = 0;
  if (typeof S.startPrice !== 'number') S.startPrice = 0;
  if (typeof S.hodlQty !== 'number') S.hodlQty = 0;
  if (!Array.isArray(S.eqHist)) S.eqHist = [];
  if (typeof S.eqPeak !== 'number') S.eqPeak = 0;
  if (typeof S.maxDD !== 'number') S.maxDD = 0;
  if (typeof S.realizedPnL !== 'number') S.realizedPnL = 0;
  if (typeof S.lastFlatEq !== 'number') S.lastFlatEq = 0;
  if (typeof S.wasFlat !== 'boolean') S.wasFlat = true;

  // Extra state för orkestrering
  if (typeof S.lastFillTs !== 'number') S.lastFillTs = 0;
  if (typeof S.forceImmediateCycle !== 'boolean') S.forceImmediateCycle = false;
  if (typeof S.forceRecenter !== 'boolean') S.forceRecenter = false;
  if (!Array.isArray(S.lastKnownOrders)) S.lastKnownOrders = [];
  if (!Array.isArray(S.lastDesiredShape)) S.lastDesiredShape = [];
  if (!S.replaceThrottle || typeof S.replaceThrottle !== 'object') S.replaceThrottle = {};

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
  if (!(price > 0)) { S.paused = true; S.lastPauseReason = 'Prisdata saknas'; }

  // Derivatdata
  const wallet = Number.isFinite(gb.data.walletBalance) ? gb.data.walletBalance : 0; // quote
  const qty = Number.isFinite(gb.data.currentQty) ? gb.data.currentQty : 0;          // base
  const breakEven = Number.isFinite(gb.data.breakEven) ? gb.data.breakEven : 0;
  const liq = Number.isFinite(gb.data.liquidationPrice) ? gb.data.liquidationPrice : 0;
  if (typeof S.leverage !== 'number') S.leverage = 10;

  // === Equity/marginal ===
  const equity = () => {
    const effectiveBE = (breakEven > 0 ? breakEven : price);
    const pnl = (price > 0 && effectiveBE > 0) ? qty * (price - effectiveBE) : 0;
    return wallet + pnl;
  };
  const marginUsed = () => Math.abs(qty) * (price > 0 ? price : 1) / Math.max(1, S.leverage);
  const freeMargin = () => Math.max(0, equity() - marginUsed());

  const safePromise = (fn) => { try { return Promise.resolve(fn()); } catch (err) { return Promise.reject(err); } };

  const callWithTimeout = async (promise, ms, label) => {
    let timer;
    const timeoutErr = new Error(`local-timeout ${label} after ${ms}ms`);
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutErr), Math.max(1, ms)); });
    try { return await Promise.race([promise, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  };

  const markApiFailure = (reason) => {
    const nowTs = Date.now();
    const reasonTxtRaw = reason && reason.message ? reason.message : String(reason || 'okänd');
    const reasonTxt = reasonTxtRaw.length > 160 ? reasonTxtRaw.slice(0, 157) + '…' : reasonTxtRaw;
    const alreadyBackoff = S.apiBackoffUntil > nowTs;
    const next = S.apiBackoffMs > 0 ? Math.min(S.apiBackoffMs * 2, S.apiBackoffMax) : 15_000;
    S.apiBackoffMs = next;
    S.apiBackoffUntil = nowTs + next;
    S.apiFailCount = (S.apiFailCount || 0) + 1;
    const reasonChanged = S.lastApiError !== reasonTxt;
    S.lastApiError = reasonTxt;
    if (!alreadyBackoff || reasonChanged) {
      gb.data.pairLedger.notifications = [
        { text: `API-problem (${reasonTxt}). Pausar i ${Math.round(next/1000)}s`, variant: 'error', persist: false }
      ];
    }
  };

  const shouldBackoff = (err) => {
    if (!err) return false;
    const txt = (err.message ? err.message : String(err || '')).toLowerCase();
    if (!txt) return false;
    return txt.includes('timeout') || txt.includes('timed out') || txt.includes('etimedout') || txt.includes('econn') || txt.includes('connect') || txt.includes('network');
  };

  const clearApiFailure = () => {
    if (S.apiBackoffMs !== 0 || S.apiFailCount !== 0 || (S.lastApiError && S.lastApiError.length)) {
      S.apiFailCount = 0; S.apiBackoffMs = 0; S.apiBackoffUntil = 0;
      if (S.lastApiError && S.lastApiError.length) {
        gb.data.pairLedger.notifications = [{ text: 'API återhämtat. Återupptar.', variant: 'success', persist: false }];
      }
      S.lastApiError = '';
    }
  };

  // Init metrics
  if (price > 0 && equity() > 0 && S.startTs === 0) {
    S.startTs = now; S.startEquity = equity(); S.startPrice = price;
    S.hodlQty = S.startPrice > 0 ? (S.startEquity / S.startPrice) : 0;
    S.eqPeak = S.startEquity; S.lastFlatEq = S.startEquity;
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
    if (!priceOk) pauseReason = 'Prisdata saknas';
    else if (stale) pauseReason = 'Prisdata inaktuell';
    else {
      const eq = equity();
      const fm = freeMargin();
      const minFM = Math.max(0, S.minFreeMarginPct * Math.max(1e-9, eq));
      if (fm < minFM) pauseReason = 'Låg fri marginal';
    }
  }

  // ==== Center & step ====
  const stepAbs = (price > 0 ? price : 1) * Math.max(0.0001, S.gridStepPct);
  const centerTarget = price > 0 ? (price - S.skewK * invRatio * stepAbs) : (S.center || 0);

  const drift = price > 0 ? Math.abs((S.center - centerTarget) / price) : 0;
  const driftThreshold = Math.max(0.001, S.gridStepPct / 2);
  const needRecenter = (now - S.lastRecenterTs > S.recenterEveryMs) || (drift > driftThreshold);

  if (S.resetCenter && price > 0) {
    S.center = price; S.lastRecenterTs = now; S.resetCenter = false;
    gb.data.pairLedger.notifications = [{ text: `Manuell center-återställning till ${price.toFixed(6)}`, variant: 'info', persist: false }];
  } else if (needRecenter) {
    S.center = centerTarget; S.lastRecenterTs = now;
  }

  // ==== Hjälpare ====
  const roundToStep = (v, step) => {
    if (!Number.isFinite(v)) return 0;
    if (!Number.isFinite(step) || step <= 0) return v;
    return Math.round(v / step) * step;
  };
  const toQuote = (px, base) => Math.max(0, (Number.isFinite(px)?px:0) * (Number.isFinite(base)?base:0));
  const pause = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

  // ==== Bygg grid ====
  const levels = Math.max(1, Math.min(orderPlan.levels, 25));

  const allocQuote = freeMargin() * Math.max(0, Math.min(1, S.allocPct));
  const weights = []; for (let i = 1; i <= levels; i++) weights.push(1 / i);
  const wSum = weights.reduce((a, b) => a + b, 0);

  const bids = []; const asks = [];
  const sizeBaseB = []; const sizeBaseA = [];
  for (let i = 1; i <= levels; i++) {
    let b = S.center - i * stepAbs;
    let a = S.center + i * stepAbs;
    b = roundToStep(b, S.priceStep); a = roundToStep(a, S.priceStep);
    bids.push(b); asks.push(a);

    const perLevelQuote = allocQuote * (weights[i - 1] / wSum);

    let baseAmt = perLevelQuote / Math.max(1e-9, (price > 0 ? price : 1));
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) baseAmt = 0;

    if (toQuote(price, baseAmt) < S.minOrderQuote) {
      baseAmt = S.minOrderQuote / Math.max(1e-9, price);
    }

    const eqNow = equity();
    const eqForCap = (S.startEquity > 0 ? S.startEquity : eqNow);
    const maxQuote = Math.max(0, eqForCap * S.maxOrderQuotePct);
    if (maxQuote > 0 && toQuote(price, baseAmt) > maxQuote) {
      baseAmt = maxQuote / Math.max(1e-9, price);
    }

    baseAmt = Math.max(S.minBaseAmt, roundToStep(baseAmt, S.qtyStep));

    sizeBaseB.push(baseAmt);
    sizeBaseA.push(baseAmt);
  }

  // ==== Throttle / toleranser ====
  const cycleDueBase = now - S.lastCycleTs > S.cooldownMs;
  let cycleDue = cycleDueBase || S.forceImmediateCycle;
  const pxUnit = (price > 0 ? price : 1);

  const tolPct = S.cancelTolerancePct;
  const tolAbs = tolPct * pxUnit;

  const replaceTriggerPct = (Number.isFinite(S.replaceTriggerPct) && S.replaceTriggerPct > 0)
    ? S.replaceTriggerPct
    : Math.max(S.gridStepPct * 0.5, tolPct * 1.5);
  const replaceTriggerAbs = replaceTriggerPct * pxUnit;
  const cancelTriggerAbs = Math.max(replaceTriggerAbs * 1.75, pxUnit * S.gridStepPct);

  const halfTick = (S.priceStep > 0 ? 0.51 * S.priceStep : 0);
  const matchTolerance = Math.max(tolAbs, replaceTriggerAbs * 0.5, halfTick);

  // === Open Orders Failsafe ===
  let oo = [];
  if (!Array.isArray(gb.data.openOrders)) {
    console.warn('[GRID] openOrders saknas – använder tom array');
    if (!S.openOrdersFailSince) S.openOrdersFailSince = now;
    oo = [];
  } else {
    oo = gb.data.openOrders;
    S.openOrdersFailSince = 0;
  }

  let apiUnstable = false;
  if (S.failsafeEnabled) {
    if (S.openOrdersFailSince > 0) apiUnstable = true;
    if (S.apiBackoffUntil > now) apiUnstable = true;
  }

  const backoffLeftSec = S.apiBackoffUntil > now ? Math.ceil((S.apiBackoffUntil - now) / 1000) : 0;

  if (!Array.isArray(S.observedCache)) S.observedCache = [];

  // === Hjälpare för orderfält (behövs tidigt) ===
  const rateFromOrder = (o) => {
    if (!o || typeof o !== 'object') return 0;
    const fields = ['rate', 'price', 'limit_price', 'orderPrice', 'avgPrice', 'avg_price', 'priceAvg'];
    for (const f of fields) {
      if (!(f in o)) continue;
      const num = typeof o[f] === 'number' ? o[f] : Number(o[f]);
      if (Number.isFinite(num) && num > 0) return num;
    }
    return 0;
  };
  const sideFromOrder = (o) => {
    if (!o || typeof o !== 'object') return '';
    const raw = o.type || o.side || o.orderSide || o.positionSide;
    if (!raw) return '';
    const txt = String(raw).toLowerCase();
    if (txt.startsWith('buy') || txt === 'long' || txt === '1') return 'buy';
    if (txt.startsWith('sell') || txt === 'short' || txt === '2') return 'sell';
    return '';
  };
  const idFromOrder = (o) => {
    if (!o || typeof o !== 'object') return '';
    const fields = ['id', 'orderId', 'order_id', 'clientOrderId', 'client_order_id', 'clOrdID'];
    for (const f of fields) {
      const v = o[f];
      if (v !== undefined && v !== null && String(v).length) return String(v);
    }
    return '';
  };
  const qtyFromOrder = (o) => {
    if (!o || typeof o !== 'object') return 0;
    const fields = ['quantity', 'qty', 'amount', 'origQty', 'baseQuantity', 'size'];
    for (const f of fields) {
      if (!(f in o)) continue;
      const num = typeof o[f] === 'number' ? o[f] : Number(o[f]);
      if (Number.isFinite(num) && num > 0) return num;
    }
    return 0;
  };

  // Bygg nuvarande kända ordrar
  const currentKnownOrders = [];
  const curIdSet = new Set();
  const curBySide = { buy: 0, sell: 0 };
  if (Array.isArray(oo)) {
    for (const ord of oo) {
      const id = idFromOrder(ord);
      if (!id) continue;
      const side = sideFromOrder(ord);
      const px = rateFromOrder(ord);
      currentKnownOrders.push({ id, side, px });
      curIdSet.add(id);
      if (side === 'buy' || side === 'sell') curBySide[side]++;
    }
  }

  // Detektera fyllda/ försvunna ordrar och saknade mål
  let fillDetected = false;
  const missingOrders = [];
  if (Array.isArray(S.lastKnownOrders) && S.lastKnownOrders.length) {
    for (const prev of S.lastKnownOrders) {
      if (!prev || !prev.id) continue;
      if (!curIdSet.has(prev.id)) {
        missingOrders.push(prev);
        fillDetected = true;
      }
    }
  }
  if (Array.isArray(S.lastDesiredShape) && S.lastDesiredShape.length) {
    for (const target of S.lastDesiredShape) {
      if (!target || !target.side || !Number.isFinite(target.px)) continue;
      const exists = currentKnownOrders.some(o => o.side === target.side && Math.abs((o.px || 0) - target.px) <= matchTolerance);
      if (!exists) missingOrders.push({ side: target.side, px: target.px });
    }
    if (missingOrders.length) fillDetected = true;
  }
  if (missingOrders.length > 1) {
    const seen = new Set();
    const unique = [];
    for (const m of missingOrders) {
      if (!m) continue;
      const key = `${m.side || ''}:${Number(m.px || 0).toFixed(8)}:${m.id || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(m);
    }
    if (unique.length !== missingOrders.length) {
      missingOrders.splice(0, missingOrders.length, ...unique);
    }
  }
  if (fillDetected) {
    S.lastFillTs = now;
    S.forceImmediateCycle = true;
    S.forceRecenter = true;
    const cleanupTol = Math.max(matchTolerance, S.priceStep || 0);
    if (S.observedCache.length) {
      S.observedCache = S.observedCache.filter(c => {
        if (!c) return false;
        return !missingOrders.some(m => m && m.side === c.side && Math.abs((c.px || 0) - (m.px || 0)) <= cleanupTol);
      });
    }
    if (Array.isArray(S.recentPlaced) && S.recentPlaced.length) {
      S.recentPlaced = S.recentPlaced.filter(r => {
        if (!r) return false;
        return !missingOrders.some(m => m && m.side === r.side && Math.abs((r.px || 0) - (m.px || 0)) <= cleanupTol);
      });
    }
    const missTxt = missingOrders
      .map(m => m && m.side ? `${m.side}@${Number(m.px || 0).toFixed(6)}` : null)
      .filter(Boolean)
      .join(', ');
    console.log('[GRID]', S.role, 'orderförlust upptäckt – triggar omplanering. Saknar:', missTxt || 'okända id:n');
  }
  S.lastKnownOrders = currentKnownOrders;

  if (S.forceRecenter) {
    S.center = centerTarget;
    S.lastRecenterTs = now;
    S.forceRecenter = false;
  }
  if (S.forceImmediateCycle) cycleDue = true;

  if (S.failsafeEnabled && S.openOrdersFailSince > 0 && (now - S.openOrdersFailSince > 3 * S.cooldownMs)) {
    if (!pauseReason) pauseReason = 'openOrders saknas eller är fördröjda';
    const next = S.apiBackoffMs > 0 ? Math.min(S.apiBackoffMs * 2, S.apiBackoffMax) : 10_000;
    S.apiBackoffMs = next; S.apiBackoffUntil = now + S.apiBackoffMs;
    gb.data.pairLedger.notifications = [
      { text: `⚠️ openOrders timeout – pausar och backoff ${Math.round(next/1000)}s`, variant: 'error', persist: false }
    ];
  }

  const prevPauseKey = (S.paused ? S.lastPauseReason : '');
  const changed = prevPauseKey !== pauseReason;
  if (pauseReason) {
    if (!S.paused || changed) {
      S.paused = true; S.lastPauseReason = pauseReason;
      gb.data.pairLedger.notifications = [{ text: `FAILSAFE: ${pauseReason}. Pausar order.`, variant: 'error', persist: false }];
    }
  } else if (S.paused) {
    S.paused = false; S.lastPauseReason = '';
    gb.data.pairLedger.notifications = [{ text: 'Failsafe avklarad. Återupptar.', variant: 'success', persist: false }];
  }

  // ==== Orderunderhåll + läggning ====
  if (cycleDue && !S.paused && !apiUnstable) {
    if (!S.trimThrottle || typeof S.trimThrottle !== 'object') S.trimThrottle = {};
    const trimThrottle = S.trimThrottle;
    const trimKeys = Object.keys(trimThrottle);
    const trimExpiry = Math.max(orderPlan.trimCooldownMs * 4, 120_000);
    for (const key of trimKeys) {
      if (!Number.isFinite(trimThrottle[key]) || now - trimThrottle[key] > trimExpiry) delete trimThrottle[key];
    }

    if (!S.replaceThrottle || typeof S.replaceThrottle !== 'object') S.replaceThrottle = {};
    const replaceThrottle = S.replaceThrottle;
    const replaceKeys = Object.keys(replaceThrottle);
    const replaceExpiry = Math.max((orderPlan.replaceCooldownMs || 0) * 4, 120_000);
    for (const key of replaceKeys) {
      if (!Number.isFinite(replaceThrottle[key]) || now - replaceThrottle[key] > replaceExpiry) delete replaceThrottle[key];
    }

    // helper: minsta basmängd som motsvarar minOrderQuote
    const minBaseByQuote = (qPx) => roundToStep(S.minOrderQuote / Math.max(1e-9, qPx), S.qtyStep);

    const desired = [];
    const pushDesired = (side, px, amt, tag) => {
      if (!Number.isFinite(px) || px <= 0) return;
      if (!Number.isFinite(amt) || amt <= 0) return;
      // dedup per sida+pris inom matchTolerance
      for (const d of desired) {
        if (d.side === side && Math.abs(d.px - px) <= matchTolerance) return;
      }
      desired.push({ side, px, amt, matched: false, tag });
    };

    // primära grid-ordrar + trims
    const trimGapFactor = Math.max(0.05, Math.min(2, orderPlan.trimDistanceFactor || 0));
    const trimGapAbs = Math.max(S.priceStep || 0, stepAbs * trimGapFactor);

    if (S.role === 'long') {
      for (let i = 0; i < bids.length; i++) pushDesired('buy',  bids[i], sizeBaseB[i], `bid-${i}`);
      const trims = Math.min(S.trimLevels, asks.length);
      for (let i = 0; i < trims; i++) {
        const amt = Math.max(minBaseByQuote(price), roundToStep(sizeBaseA[i] * S.trimInsidePct, S.qtyStep));
        const rawPx = price + (i + 1) * trimGapAbs;
        const px = roundToStep(rawPx, S.priceStep);
        if (px > 0) pushDesired('sell', px, amt, `trimAsk-${i}`);
      }
    } else {
      for (let i = 0; i < asks.length; i++) pushDesired('sell', asks[i], sizeBaseA[i], `ask-${i}`);
      const trims = Math.min(S.trimLevels, bids.length);
      for (let i = 0; i < trims; i++) {
        const amt = Math.max(minBaseByQuote(price), roundToStep(sizeBaseB[i] * S.trimInsidePct, S.qtyStep));
        const rawPx = price - (i + 1) * trimGapAbs;
        const px = roundToStep(rawPx, S.priceStep);
        if (px > 0) pushDesired('buy', px, amt, `trimBid-${i}`);
      }
    }

    const desiredBuy  = desired.filter(d => d.side === 'buy').length;
    const desiredSell = desired.filter(d => d.side === 'sell').length;

    console.log('[GRID]', S.role, 'cykelstart',
      `pris=${Number(price || 0).toFixed(6)}`,
      `öppna=${oo.length}`,
      `mål=${desired.length}`,
      `köpmål=${desiredBuy}`,
      `säljmål=${desiredSell}`,
      `backoff=${backoffLeftSec}s`);

    // === Hjälpare för orderfält ===
    const rateFromOrder = (o) => {
      if (!o || typeof o !== 'object') return 0;
      const fields = ['rate','price','limit_price','orderPrice','avgPrice','avg_price','priceAvg'];
      for (const f of fields) {
        if (!(f in o)) continue;
        const num = typeof o[f] === 'number' ? o[f] : Number(o[f]);
        if (Number.isFinite(num) && num > 0) return num;
      }
      return 0;
    };
    const sideFromOrder = (o) => {
      if (!o || typeof o !== 'object') return '';
      const raw = o.type || o.side || o.orderSide || o.positionSide;
      if (!raw) return '';
      const txt = String(raw).toLowerCase();
      if (txt.startsWith('buy')  || txt === 'long'  || txt === '1') return 'buy';
      if (txt.startsWith('sell') || txt === 'short' || txt === '2') return 'sell';
      return '';
    };
    const idFromOrder = (o) => {
      if (!o || typeof o !== 'object') return '';
      const fields = ['id','orderId','order_id','clientOrderId','client_order_id','clOrdID'];
      for (const f of fields) {
        const v = o[f];
        if (v !== undefined && v !== null && String(v).length) return String(v);
      }
      return '';
    };
    const qtyFromOrder = (o) => {
      if (!o || typeof o !== 'object') return 0;
      const fields = ['quantity','qty','amount','origQty','baseQuantity','size'];
      for (const f of fields) {
        if (!(f in o)) continue;
        const num = typeof o[f] === 'number' ? o[f] : Number(o[f]);
        if (Number.isFinite(num) && num > 0) return num;
      }
      return 0;
    };

    const findWithinTolerance = (side, rate) => {
      if (!Number.isFinite(rate) || rate <= 0) return null;
      for (const d of desired) {
        if (d.matched) continue;
        if (d.side !== side) continue;
        if (Math.abs(rate - d.px) <= matchTolerance) return d;
      }
      return null;
    };
    const findClosestTarget = (side, rate) => {
      if (!Number.isFinite(rate) || rate <= 0) return null;
      let best = null; let bestDist = Infinity;
      for (const d of desired) {
        if (d.matched) continue;
        if (d.side !== side) continue;
        const dist = Math.abs(rate - d.px);
        if (dist < bestDist) { bestDist = dist; best = d; }
      }
      return best;
    };

    const replaceMethodName =
      (gb.method && typeof gb.method.replaceOrder === 'function') ? 'replaceOrder' :
      (gb.method && typeof gb.method.amendOrder   === 'function') ? 'amendOrder'   :
      (gb.method && typeof gb.method.editOrder    === 'function') ? 'editOrder'    : '';
    const canReplace = Boolean(replaceMethodName);

    const replaceOne = async (order, target) => {
      if (!canReplace || !order || !target) return false;
      const id = idFromOrder(order); if (!id) return false;
      const qtyExisting = qtyFromOrder(order);
      const q = Number.isFinite(target.amt) && target.amt > 0 ? target.amt : qtyExisting;
      if (!Number.isFinite(q) || q <= 0) return false;
      try {
        const method = gb.method[replaceMethodName];
        await callWithTimeout(safePromise(() => method(id, q, target.px, pair, ex)), S.localOrderTimeoutMs, 'replace order');
        clearApiFailure();
        target.matched = true;
        console.log('[GRID]', S.role, 'replaced', sideFromOrder(order), q, '@', target.px);
        return true;
      } catch (err) {
        console.log('[GRID] replace err', sideFromOrder(order), target.px, err && err.message ? err.message : err);
        if (shouldBackoff(err)) markApiFailure(err);
        return false;
      }
    };

    const cancelOne = async (orderOrId) => {
      const id = typeof orderOrId === 'string' ? orderOrId : idFromOrder(orderOrId);
      if (!id) return false;
      try {
        await callWithTimeout(safePromise(() => gb.method.cancelOrder(id, pair, ex)), S.localOrderTimeoutMs, 'cancel order');
        clearApiFailure();
        return true;
      } catch (err) {
        console.log('[GRID] cancel err', id, err && err.message ? err.message : err);
        if (shouldBackoff(err)) markApiFailure(err);
        return false;
      }
    };

    const observedBook = [];

    const maxReplacesPerCycle = (Number.isFinite(orderPlan.maxReplacesPerCycle) && orderPlan.maxReplacesPerCycle > 0)
      ? orderPlan.maxReplacesPerCycle
      : Infinity;
    let replacedThisCycle = 0;

    // Matcha/ersätt/avbryt befintliga ordrar
    for (const o of oo) {
      if (S.apiBackoffUntil > Date.now()) break;
      const side = sideFromOrder(o);
      const rate = rateFromOrder(o);
      if (!rate || (side !== 'buy' && side !== 'sell')) continue;
      observedBook.push({ side, px: rate });

      const exact = findWithinTolerance(side, rate);
      if (exact) { exact.matched = true; continue; }

      const target = findClosestTarget(side, rate);
      let handled = false;
      if (target) {
        const dist = Math.abs(rate - target.px);
        if (dist <= replaceTriggerAbs) { target.matched = true; continue; }
        const tagKey = target.tag && target.tag.length ? target.tag : `${target.side}@${target.px.toFixed(6)}`;
        const cooldownMs = Math.max(0, orderPlan.replaceCooldownMs || 0);
        const lastReplace = S.replaceThrottle[tagKey] || 0;
        const withinCooldown = cooldownMs > 0 && (now - lastReplace) < cooldownMs;
        const limitReached = replacedThisCycle >= maxReplacesPerCycle;
        if (withinCooldown || limitReached) {
          target.matched = true;
          continue;
        }
        S.replaceThrottle[tagKey] = now;
        handled = await replaceOne(o, target);
        if (handled) replacedThisCycle++;
        if (orderPlan.placeSpacingMs > 0) await pause(orderPlan.placeSpacingMs);
        if (!handled) {
          if (S.apiBackoffUntil > Date.now()) break;
          if (dist < cancelTriggerAbs) { target.matched = true; continue; }
        }
      }
      if (!handled) {
        if (S.apiBackoffUntil > Date.now()) break;
        await cancelOne(o);
        if (S.apiBackoffUntil > Date.now()) break;
      }
    }

    S.observedOrderBook = observedBook;

    // Dubblettskydd över cykler
    if (!Array.isArray(S.recentPlaced)) S.recentPlaced = [];
    S.recentPlaced = S.recentPlaced.filter(x => now - x.ts <= 10 * S.cooldownMs);

    // Cache över observerade order för när openOrders är sena
    if (!Array.isArray(S.observedCache)) S.observedCache = []; // [{side, px, ts}]
    const cacheHorizonMs = 60_000;
    S.observedCache = S.observedCache.filter(x => now - x.ts <= cacheHorizonMs);
    for (const ob of observedBook) S.observedCache.push({ ...ob, ts: now });

    // Lägg saknade upp till gränser
    const openCount = oo.length;
    const maxAdd     = Math.max(1, Math.min(orderPlan.maxPerCycle, orderPlan.maxActive));
    let added = 0; const addedSide = { buy: 0, sell: 0 };

    const placeOne = async (side, px, amt, tag) => {
      try {
        // skydd mot nära dubbletter
        for (const r of S.recentPlaced) {
          if (r.side === side && Math.abs(r.px - px) <= matchTolerance) {
            console.log('[GRID] skipped place (recent duplicate)', side, amt, '@', px);
            return false;
          }
        }
        const exec = () => {
          if (S.usePostOnly) {
            if (side === 'buy') return gb.method.buyLimitPostOnly(amt, px, pair, ex);
            return gb.method.sellLimitPostOnly(amt, px, pair, ex);
          }
          if (side === 'buy') return gb.method.buyLimit(amt, px, pair, ex);
          return gb.method.sellLimit(amt, px, pair, ex);
        };
        await callWithTimeout(safePromise(exec), S.localOrderTimeoutMs, 'place order');
        clearApiFailure();
        S.recentPlaced.push({ side, px, ts: Date.now() });
        S.observedCache.push({ side, px, ts: Date.now() });
        console.log('[GRID]', S.role, 'placed', tag || side, amt, '@', px);
        return true;
      } catch (e) {
        console.log('[GRID] place err', side, px, e && e.message ? e.message : e);
        if (shouldBackoff(e)) markApiFailure(e);
        return false;
      }
    };

    // saknade mål
    let missing = desired.filter(d => !d.matched);

    // slå ihop mål inom matchTolerance så bara ett per sida+pris återstår
    const coalesce = [];
    for (const d of missing) {
      const hit = coalesce.find(x => x.side === d.side && Math.abs(x.px - d.px) <= matchTolerance);
      if (!hit) coalesce.push(d);
    }
    missing = coalesce;

    if (missing.length) {
      const missTxt = missing.map(m => `${m.side}@${m.px.toFixed ? m.px.toFixed(6) : Number(m.px).toFixed(6)}${m.tag?`(${m.tag})`:''}`).join(', ');
      console.log('[GRID]', S.role, 'saknar', missing.length, 'mål -> försöker lägga', missTxt);
    }

    // räkna redan existerande nära våra mål
    const haveSide = { buy: 0, sell: 0 };
    for (const o of oo) {
      const s = sideFromOrder(o);
      const r = rateFromOrder(o);
      if (s && r && desired.some(d => d.side === s && Math.abs(d.px - r) <= matchTolerance)) haveSide[s]++;
    }
    for (const c of S.observedCache) {
      if (desired.some(d => d.side === c.side && Math.abs(d.px - c.px) <= matchTolerance)) haveSide[c.side]++;
    }

    if (S.apiBackoffUntil <= Date.now()) {
      for (const w of missing) {
        // per-cykelgräns
        if (added >= maxAdd) break;

        // per-sida: tillåt trims utöver levelsPerSide
        const isTrim = w.tag && w.tag.startsWith('trim');
        const sideCap = S.levelsPerSide + (isTrim ? S.trimLevels : 0);
        if ((haveSide[w.side] + addedSide[w.side]) >= sideCap) continue;

        // total cap
        if ((openCount + added) >= S.maxActiveOrders) break;

        // finns redan på börsen?
        let exists = false;
        for (const o of oo) {
          if (sideFromOrder(o) === w.side && Math.abs(rateFromOrder(o) - w.px) <= matchTolerance) { exists = true; break; }
        }
        if (exists) continue;

        // nyligen lagd?
        let recentDup = false;
        for (const r of S.recentPlaced) {
          if (r.side === w.side && Math.abs(r.px - w.px) <= matchTolerance) { recentDup = true; break; }
        }
        if (recentDup) continue;

        // redan observerad i cache nyligen?
        let cached = false;
        for (const c of S.observedCache) {
          if (c.side === w.side && Math.abs(c.px - w.px) <= matchTolerance) {
            if (now - c.ts <= S.cooldownMs) cached = true;
            break;
          }
        }
        if (cached) {
          console.log('[GRID]', S.role, 'väntar med att lägga', w.side, '@', w.px, 'pga färsk cache');
          continue;
        }

        if (isTrim && orderPlan.trimCooldownMs > 0) {
          const lastTrimTs = trimThrottle[w.tag] || 0;
          if (now - lastTrimTs < orderPlan.trimCooldownMs) {
            console.log('[GRID]', S.role, 'skipping trim', w.tag, '@', w.px, 'pga cooldown');
            continue;
          }
        }

        const ok = await placeOne(w.side, w.px, w.amt, w.tag);
        if (ok) {
          added++; addedSide[w.side]++;
          if (isTrim) trimThrottle[w.tag] = Date.now();
        }
        if (orderPlan.placeSpacingMs > 0) await pause(orderPlan.placeSpacingMs);
        if (S.apiBackoffUntil > Date.now()) break;
      }
    }

    if (added > 0) {
      gb.data.pairLedger.notifications = [
        { text: `Rutnät ${S.role.toUpperCase()}: +${added} nya order`, variant: 'info', persist: false }
      ];
    }
    if (added === 0 && missing.length > 0) {
      console.log('[GRID]', S.role, 'kunde inte lägga om saknade order denna cykel');
    }

    S.lastDesiredShape = desired.map(d => ({ side: d.side, px: d.px }));

    S.lastCycleTs = now;
    S.forceImmediateCycle = false;
  } else if (cycleDue) {
    console.log('[GRID]', S.role, 'hoppar över cykel p.g.a.', S.paused ? `paus (${S.lastPauseReason||'-'})` : 'API-backoff');
  }


  // ==== Metrics & Sidebar ====
  const curEq = equity();
  const curP  = price > 0 ? price : 0;
  const lev = Math.max(1, S.leverage);
  const notional = Math.abs(qty) * curP;

  if (curEq > 0 && curP > 0) {
    const lastPt = S.eqHist.length ? S.eqHist[S.eqHist.length-1] : null;
    if (!lastPt || now - lastPt.t > Math.max(30_000, S.cooldownMs)) {
      S.eqHist.push({ t: now, eq: curEq, p: curP });
      if (S.eqHist.length > 5000) S.eqHist.shift();
    }
  }

  if (curEq > S.eqPeak) S.eqPeak = curEq;
  const ddPct = S.eqPeak > 0 ? (1 - curEq / S.eqPeak) * 100 : 0;
  if (ddPct > S.maxDD) S.maxDD = ddPct;

  const baseEq = (S.eqHist.length ? S.eqHist[0].eq : (S.startEquity || curEq));
  const uPnL = curEq - baseEq;
  const roePct = (S.startEquity > 0) ? (curEq / S.startEquity - 1) * 100 : 0;

  let cagrPct = 0;
  if (S.startTs > 0 && curEq > 0 && S.startEquity > 0) {
    const years = Math.max(1/365, (now - S.startTs) / (365 * 24 * 3600 * 1000));
    const cagr = Math.pow(curEq / S.startEquity, 1 / years) - 1;
    cagrPct = cagr * 100;
  }

  const hodlUSDT = S.startEquity || 0;
  const hodlCoinEq = S.hodlQty * curP;
  const alphaUSDT = curEq - hodlUSDT;
  const alphaCoin = curEq - hodlCoinEq;

  let toLiqPct = 0;
  if (liq > 0 && curP > 0) {
    if (qty >= 0) toLiqPct = ((curP - liq) / curP) * 100;
    else           toLiqPct = ((liq - curP) / curP) * 100;
  }
  const be = (breakEven > 0 ? breakEven : 0);
  const toBEPct = (be > 0 && curP > 0) ? ((curP - be) / curP) * 100 : 0;

  const mr = (curEq > 0) ? (marginUsed() / curEq) * 100 : 0;
  const mmApproxPct = (typeof S.mmPct === 'number') ? S.mmPct : 0.5;
  const maintMargin = (notional * mmApproxPct / 100);

  const flatNow = Math.abs(qty) < 1e-9;
  if (!S.wasFlat && flatNow) {
    if (S.lastFlatEq === 0) S.lastFlatEq = curEq;
    const delta = curEq - S.lastFlatEq;
    if (Number.isFinite(delta)) S.realizedPnL += delta;
    S.lastFlatEq = curEq;
  }
  if (flatNow) { if (S.lastFlatEq === 0) S.lastFlatEq = curEq; }
  S.wasFlat = flatNow;

  const makeLine = (txt, px, color, style = 2) => ({
    text: txt,
    price: px,
    lineStyle: style,
    lineWidth: 0.8,
    lineColor: color,
    bodyBackgroundColor: '#1e1f2b',
    quantityBackgroundColor: '#13151f'
  });
  const lines = [];
  if (Number.isFinite(S.center) && S.center > 0) {
    lines.push(makeLine('Rutnätscenter', S.center, S.paused ? '#9aa0b8' : '#78a6ff', 1));
  }
  const buyColorActive = '#00ff94';
  const sellColorActive = '#ff5a5a';
  const buyColorNormal = '#53cf77';
  const sellColorNormal = '#cf5353';
  const buyColorPaused = '#295c3a';
  const sellColorPaused = '#6b2d2d';
  for (let i = 0; i < Math.min(8, levels); i++) {
    const step = (price > 0 ? price : 1) * S.gridStepPct;
    const isNext = i === 0;
    const bidColor = S.paused ? buyColorPaused : (isNext ? buyColorActive : buyColorNormal);
    const askColor = S.paused ? sellColorPaused : (isNext ? sellColorActive : sellColorNormal);
    lines.push(makeLine(`Köp nivå ${i + 1}`, S.center - (i + 1) * step, bidColor));
    lines.push(makeLine(`Sälj nivå ${i + 1}`, S.center + (i + 1) * step, askColor));
  }
  if (be > 0) lines.push(makeLine('Break-even', be, '#ffd166', 3));
  if (liq > 0) lines.push(makeLine('Likvidation', liq, '#ef476f', 3));
  gb.data.pairLedger.customChartTargets = lines;

  const statusTxt = S.paused
    ? `PAUSAD: ${S.lastPauseReason || 'okänt'}`
    : (backoffLeftSec > 0 ? `API-VILA (${backoffLeftSec}s)` : 'AKTIV');
  const lastFillTxt = S.lastFillTs ? new Date(S.lastFillTs).toLocaleTimeString('sv-SE') : '–';
  gb.data.pairLedger.sidebarExtras = [
    { label: '🎯 Roll', value: S.role.toUpperCase() },
    { label: '🚦 Status', value: statusTxt, valueColor: S.paused ? '#ffb4a2' : '#b7f7c1' },
    { label: '⏱️ Senaste fyllning', value: lastFillTxt },
    { label: '💸 Pris', value: (curP).toFixed(6) },
    { label: '🎛️ Center', value: S.center.toFixed(6) },
    { label: '📐 Steg %', value: (S.gridStepPct * 100).toFixed(3) + '%' },
    { label: '📊 Nivåer/ben', value: String(S.levelsPerSide) },
    { label: '⚖️ Skew', value: S.skewK.toFixed(2) },
    { label: '🧮 Allokering %', value: (S.allocPct * 100).toFixed(0) + '%' },
    { label: '📏 Hävarm', value: String(lev) + 'x' },
    { label: '👛 Plånbok', value: (Number.isFinite(wallet) ? wallet : 0).toFixed(2) },
    { label: '💼 Eget kapital (nu)', value: (curEq).toFixed(2) },
    { label: '💼 Eget kapital (start)', value: (S.startEquity || 0).toFixed(2) },
    { label: '📈 Orealiserad PnL', value: (uPnL).toFixed(2) },
    { label: '💰 Realiserad PnL*', value: (S.realizedPnL).toFixed(2), tooltip: 'Proxy: equity-ökning vid flat-lägen' },
    { label: '📉 ROE %', value: roePct.toFixed(2) + '%' },
    { label: '🚀 CAGR % (årlig)', value: cagrPct.toFixed(2) + '%' },
    { label: '🛡️ Max DD %', value: (S.maxDD).toFixed(2) + '%' },
    { label: '📦 Notional', value: notional.toFixed(2) },
    { label: '📊 Marginal använd', value: marginUsed().toFixed(2) },
    { label: '📊 Marginalkvot %', value: ((curEq > 0) ? (marginUsed() / curEq * 100) : 0).toFixed(2) + '%' },
    { label: '⚠️ Likvidationspris', value: (liq || 0).toFixed(6) },
    { label: '⚠️ Avstånd till likvid %', value: (((liq>0 && curP>0)?(qty>=0?((curP-liq)/curP*100):((liq-curP)/curP*100)):0)).toFixed(2) + '%' },
    { label: '🎯 Break-even', value: (breakEven || 0).toFixed(6) },
    { label: '🎯 Avstånd vs BE %', value: (toBEPct).toFixed(2) + '%' },
    { label: '💎 HODL (USDT)', value: (S.startEquity || 0).toFixed(2) },
    { label: 'α vs HODL (USDT)', value: (alphaUSDT).toFixed(2) },
    { label: '💎 HODL (COIN)', value: (S.hodlQty * curP).toFixed(2) },
    { label: 'α vs HODL (COIN)', value: (alphaCoin).toFixed(2) },
    { label: '🧱 Underhållsmarginal ~', value: maintMargin.toFixed(2), tooltip: 'Approximation baserad på S.mmPct' },
    { label: '📬 Öppna order', value: String(Array.isArray(gb.data.openOrders) ? gb.data.openOrders.length : 0) },
    { label: '🕒 Orders fel sedan', value: S.openOrdersFailSince ? new Date(S.openOrdersFailSince).toLocaleTimeString('sv-SE') : '-', tooltip: 'Tidpunkt då openOrders senast saknades' },
    { label: '⏳ API-vila', value: S.apiBackoffUntil > now ? `${Math.ceil((S.apiBackoffUntil - now)/1000)}s` : '-', tooltip: 'Backoff-intervall vid API-fel' },
    { label: '🧾 Senaste API-fel', value: S.lastApiError && S.lastApiError.length ? (S.lastApiError.length > 36 ? S.lastApiError.slice(0, 33) + '…' : S.lastApiError) : '-', tooltip: S.lastApiError && S.lastApiError.length ? S.lastApiError : 'Senaste API-felmeddelande' },
    { label: '📟 API-felräknare', value: String(S.apiFailCount || 0) },
  ];

  const desiredTotal = Array.isArray(S.lastDesiredShape) ? S.lastDesiredShape.length : 0;
  console.log(
    `[GRID] role=${S.role} status=${statusTxt} reason=${S.lastPauseReason||'-'} backoff=${backoffLeftSec}s ` +
    `p=${(price>0?price:0).toFixed(6)} center=${S.center.toFixed(6)} step%=${(S.gridStepPct*100).toFixed(3)} ` +
    `levels=${S.levelsPerSide} öppna=${Array.isArray(oo)?oo.length:0} köp=${curBySide.buy} sälj=${curBySide.sell} mål=${desiredTotal}`
  );
})();

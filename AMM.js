/**
 * Gunbot Derivatives Grid MM – LONG/SHORT (Bybit/USDT-perp testad)
 * Auto-min-notional per orderpris, per-symbol overrides, fallback för tick/step.
 * Node 14.4-kompatibel.
 */

(async () => {
  // ====== Bas/state ======
  if (!gb || !gb.data || !gb.data.pairLedger) { console.log('[GRID] missing gb.data'); return; }
  var pl = gb.data.pairLedger;
  if (typeof pl._gridStores !== 'object' || !pl._gridStores) pl._gridStores = {};

  var roleKey = (
    (gb && typeof gb.role === 'string' && gb.role) ||
    (gb && gb.envRole) ||
    (pl.customStratStore && typeof pl.customStratStore.role === 'string' && pl.customStratStore.role) ||
    'long'
  ).toLowerCase();
  if (!pl._gridStores[roleKey]) pl._gridStores[roleKey] = {};
  var S = pl._gridStores[roleKey];
  if (typeof S.role !== 'string') S.role = roleKey; // 'long' | 'short'

  // ====== Defaults ======
  if (typeof S.gridStepPct !== 'number') S.gridStepPct = 0.003;
  if (typeof S.allocPct !== 'number') S.allocPct = 0.05;
  if (typeof S.midReservePct !== 'number') S.midReservePct = 0.30;
  if (typeof S.invMaxPct !== 'number') S.invMaxPct = 0.12;
  if (typeof S.skewK !== 'number') S.skewK = 0.8;
  if (typeof S.recenterEveryMs !== 'number') S.recenterEveryMs = 60_000;
  if (typeof S.cancelTolerancePct !== 'number') S.cancelTolerancePct = 0.20 / 100;
  if (typeof S.replaceTriggerPct !== 'number') S.replaceTriggerPct = Math.max(S.gridStepPct * 0.5, S.cancelTolerancePct * 1.5);
  if (typeof S.cooldownMs !== 'number') S.cooldownMs = 8000;
  if (typeof S.minBaseAmt !== 'number') S.minBaseAmt = 0; // använd marknadsminimum som default
  if (typeof S.usePostOnly !== 'boolean') S.usePostOnly = false;
  if (typeof S.localOrderTimeoutMs !== 'number') S.localOrderTimeoutMs = 15_000;
  if (typeof S.leverage !== 'number') S.leverage = 10;

  // Auto-minimum: globala overrides + kompatibilitet med tidigare bump-procent
  if (typeof S.minNotionalOverride !== 'number') S.minNotionalOverride = 0; // USDT
  if (typeof S.minQtyOverride !== 'number') S.minQtyOverride = 0;           // base
  if (typeof S.minQuoteBumpPct !== 'number') S.minQuoteBumpPct = 0.00;      // legacy
  if (typeof S.minNotionalMultiplier !== 'number') S.minNotionalMultiplier = (1 + Math.max(0, S.minQuoteBumpPct || 0));
  if (typeof S.minNotionalBumpUSDT !== 'number') S.minNotionalBumpUSDT = 0.0;
  if (typeof S.absoluteMinQuoteUSDT !== 'number') S.absoluteMinQuoteUSDT = 0.0;
  if (typeof S.minNotionalFallbackUSDT !== 'number') S.minNotionalFallbackUSDT = 5.0;

  // Per-symbol overrides lagras i S.perSymbol["LINKUSDT"] = { minNotionalMultiplier, minNotionalBumpUSDT, absoluteMinQuoteUSDT, minNotionalOverride, minQtyOverride }
  if (!S.perSymbol || typeof S.perSymbol !== 'object') S.perSymbol = {};

  // Reduce-only + autoshed
  if (typeof S.reduceOnlyTrims !== 'boolean') S.reduceOnlyTrims = true;
  if (typeof S.autoShedEnabled !== 'boolean') S.autoShedEnabled = true;
  if (typeof S.autoShedSlackPct !== 'number') S.autoShedSlackPct = 0.10;
  if (typeof S.autoShedIoc !== 'boolean') S.autoShedIoc = true;

  // Orderplan
  if (!S.orderPlan || typeof S.orderPlan !== 'object') S.orderPlan = {};
  var orderPlan = S.orderPlan;
  var legacyLevels = Number.isFinite(S.levelsPerSide) ? S.levelsPerSide : 3;
  var legacyTrims  = Number.isFinite(S.trimLevels) ? S.trimLevels : 1;
  var legacyMaxAct = Number.isFinite(S.maxActiveOrders) ? S.maxActiveOrders : 2 * legacyLevels + legacyTrims;
  if (!Number.isFinite(orderPlan.levels)) orderPlan.levels = legacyLevels;
  if (!Number.isFinite(orderPlan.trimLevels)) orderPlan.trimLevels = legacyTrims;
  if (!Number.isFinite(orderPlan.maxActive)) orderPlan.maxActive = legacyMaxAct;
  if (!Number.isFinite(orderPlan.maxPerCycle)) orderPlan.maxPerCycle = Math.max(1, Math.min(4, orderPlan.maxActive));
  if (!Number.isFinite(orderPlan.placeSpacingMs)) orderPlan.placeSpacingMs = 400;
  if (!Number.isFinite(orderPlan.trimCooldownMs)) orderPlan.trimCooldownMs = 15_000;
  if (!Number.isFinite(orderPlan.trimDistanceFactor)) orderPlan.trimDistanceFactor = 1;
  if (!Number.isFinite(orderPlan.maxReplacesPerCycle)) orderPlan.maxReplacesPerCycle = orderPlan.maxPerCycle;
  if (!Number.isFinite(orderPlan.replaceCooldownMs)) orderPlan.replaceCooldownMs = 8_000;
  if (!Number.isFinite(S.maxOrderQuotePct)) S.maxOrderQuotePct = 0.01; // cap per order mot equity

  S.levelsPerSide = orderPlan.levels;
  S.trimLevels = orderPlan.trimLevels;
  S.maxActiveOrders = orderPlan.maxActive;

  // ====== Marknad (grunder) ======
  var m = (gb && gb.data && gb.data.market) ? gb.data.market : {};
  var marketTick    = Number(m && m.priceFilter && m.priceFilter.tickSize ? m.priceFilter.tickSize : 0);
  var marketQtyStep = Number(m && m.lotSizeFilter && m.lotSizeFilter.qtyStep ? m.lotSizeFilter.qtyStep : 0);
  var marketMinQty  = Number(m && m.lotSizeFilter && m.lotSizeFilter.minOrderQty ? m.lotSizeFilter.minOrderQty : 0);
  var marketMinNot  = Number(m && m.lotSizeFilter && m.lotSizeFilter.minNotionalValue ? m.lotSizeFilter.minNotionalValue : 0);

  var bid = Number.isFinite(gb.data.bid) ? gb.data.bid : (gb && gb.data && gb.data.ticker && Number(gb.data.ticker.bid)) || 0;
  var ask = Number.isFinite(gb.data.ask) ? gb.data.ask : (gb && gb.data && gb.data.ticker && Number(gb.data.ticker.ask)) || 0;
  var price = (bid > 0 && ask > 0)
    ? (bid + ask) / 2
    : (Math.max(bid, ask) || (gb && gb.data && gb.data.ticker && Number(gb.data.ticker.last)) || 0);
  var priceOk0 = price > 0;

  // ====== INJEKTERAD FIX: robust extraktion av tick/step/minNot per symbol ======
  function extractSymbolPrecision(symbolInfo, currentPrice) {
    symbolInfo = symbolInfo && typeof symbolInfo === 'object' ? symbolInfo : {};
    var lot = symbolInfo.lotSizeFilter && typeof symbolInfo.lotSizeFilter === 'object' ? symbolInfo.lotSizeFilter : {};
    var priceFilter = symbolInfo.priceFilter && typeof symbolInfo.priceFilter === 'object' ? symbolInfo.priceFilter : {};

    var tickSize = parseFloat(priceFilter.tickSize); if (!isFinite(tickSize) || tickSize <= 0) tickSize = 0.001;
    var minQty   = parseFloat(lot.minOrderQty);      if (!isFinite(minQty)   || minQty   <= 0) minQty   = 0.1;
    var qtyStep  = parseFloat(lot.qtyStep);          if (!isFinite(qtyStep)  || qtyStep  <= 0) qtyStep  = 0.1;
    var minNotionalRaw = parseFloat(lot.minNotionalValue); if (!isFinite(minNotionalRaw) || minNotionalRaw < 0) minNotionalRaw = 0;

    var cp = isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 0;
    var impliedMinNot = cp > 0 ? Number((cp * minQty).toFixed(6)) : 0;
    // Bybit skydd: minst 5 USDT
    var minNotEff = Math.max(minNotionalRaw, impliedMinNot, 5.0);

    return { tickSize: tickSize, qtyStep: qtyStep, minQty: minQty, minNotEff: minNotEff };
  }

  // Använd extraktionen om möjligt
  try {
    var extracted = extractSymbolPrecision(m, price);
    // Överskriv marknadsvärden med säkra
    marketTick    = extracted.tickSize;
    marketQtyStep = extracted.qtyStep;
    marketMinQty  = extracted.minQty;
    // Behåll det högsta av börsens minNotional och vår säkra
    marketMinNot  = Math.max(Number(marketMinNot || 0), Number(extracted.minNotEff || 0));
    console.log('[GRID] extractSymbolPrecision:', extracted);
  } catch (e) {
    console.log('[GRID] extractSymbolPrecision failed – använder rå marknadsvärden.', e && e.message ? e.message : e);
  }
  // ================================================================

  // Nu kan vi tryggt kolla hasTickStep med våra (ev. uppdaterade) värden:
  var hasTickStep = (marketTick > 0 && marketQtyStep > 0);

  // Startvakt: kräv bara pris; tick/step får fallback
  if (!priceOk0) {
    gb.data.pairLedger.notifications = [{ text: 'Väntar på giltigt pris…', variant: 'info', persist: false }];
    if (typeof S.paused !== 'boolean') S.paused = false;
    S.paused = true;
    S.lastPauseReason = 'Prisdata saknas';
    console.log('[GRID] startvakt aktiv. hasTickStep=', hasTickStep, 'priceOk=', priceOk0);
    return;
  }

  var fallbackTick = marketTick > 0 ? marketTick : 0.001;
  var fallbackQtyStep = marketQtyStep > 0 ? marketQtyStep : 0.1;

  if (!hasTickStep) {
    gb.data.pairLedger.notifications = [{ text: 'Tick/qtyStep saknas. Använder fallback 0.001/0.1', variant: 'info', persist: false }];
    if (!(marketTick > 0)) marketTick = fallbackTick;
    if (!(marketQtyStep > 0)) marketQtyStep = fallbackQtyStep;

    var minQtyFallback = Math.max(fallbackQtyStep, marketMinQty > 0 ? marketMinQty : 0);
    if (!(marketMinQty > 0) || marketMinQty < minQtyFallback) marketMinQty = minQtyFallback;

    if (!(marketMinNot > 0) && price > 0 && marketMinQty > 0) {
      marketMinNot = price * marketMinQty;
    }

    console.log('[GRID] startvakt: fallback tick=' + marketTick + ' qtyStep=' + marketQtyStep + ' minQty=' + marketMinQty + ' minNot=' + marketMinNot);
  }

  // Spara effektiva steg
  if (typeof S.priceStep !== 'number' || S.priceStep <= 0) S.priceStep = marketTick || 0.001;
  if (typeof S.qtyStep   !== 'number' || S.qtyStep   <= 0) S.qtyStep   = marketQtyStep || 0.1;

  // För debug i UI
  S._exTick     = marketTick;
  S._exQtyStep  = marketQtyStep;

  // ====== Utils ======
  var now = Date.now();
  var pairRaw = gb.data.pairName || gb.data.pair || '';
  var ex = gb.data.exchangeName || '';

  function normalizePairName(input) {
    var src = (input && typeof input === 'string') ? input : '';
    if (!src.length) {
      var skey = symbolKey();
      return skey && skey.length ? skey : src;
    }
    if (src.indexOf('-') >= 0) {
      var parts = src.split('-');
      if (parts.length >= 2) {
        var quote = (parts[0] || '').toUpperCase();
        var base = (parts[1] || '').toUpperCase();
        if (base && quote) return base + quote;
      }
      return src.replace(/-/g, '');
    }
    return src;
  }

  function formatPairLabel(input, role) {
    var txt = (typeof input === 'string' && input.length) ? input : '';
    if (!txt.length) return txt;
    var parts = txt.split('-').filter(function(p){ return p && p.length; });
    if (!parts.length) return txt;
    var roleUpper = (typeof role === 'string' ? role.toUpperCase() : '');
    if (roleUpper && parts.length > 2) {
      var last = parts[parts.length - 1].toUpperCase();
      if (last === roleUpper) parts = parts.slice(0, -1);
    }
    if (parts.length >= 2) {
      return parts[0].toUpperCase() + ' - ' + parts[1].toUpperCase();
    }
    return parts.join(' - ');
  }

  var pairForMethod = normalizePairName(pairRaw);
  var pairLabel = pairRaw && pairRaw.length ? pairRaw : (formatPairLabel(pairRaw, S.role) || pairForMethod);
  var pair = pairRaw && pairRaw.length ? pairRaw : pairForMethod;
  if (gb && gb.data && gb.data.pairLedger) {
    gb.data.pairLedger.customPairLabel = pairDisplay;
  }

  function symbolKey() {
    var p = (gb && gb.data && (gb.data.pairName || gb.data.pair)) ? (gb.data.pairName || gb.data.pair) : '';
    var parts = String(p).split('-');
    var quote = (parts[0] || '').toUpperCase();
    var base  = (parts[1] || '').toUpperCase();
    return (base && quote) ? (base + quote) : '';
  }


  function coerceNumber(val) {
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    if (typeof val === 'string' && val.length) {
      var num = Number(val);
      return Number.isFinite(num) ? num : null;
    }
    return null;
  }

  function pickRoleSpecific(obj, base, role) {
    if (!obj || typeof obj !== 'object') return [];
    var out = [];
    var r = (typeof role === 'string') ? role : '';
    if (!r.length) return out;
    var cap = r.charAt(0).toUpperCase() + r.slice(1);
    var upper = r.toUpperCase();
    var lower = r.toLowerCase();
    var candidates = [
      base + cap,
      base + upper,
      base + lower,
      base + '_' + cap,
      base + '_' + upper,
      base + '_' + lower,
      lower + base.charAt(0).toUpperCase() + base.slice(1),
      lower + base,
      lower + '_' + base,
      lower + '_' + base.toLowerCase()
    ];
    var seen = new Set();
    for (var i = 0; i < candidates.length; i++) {
      var key = candidates[i];
      if (typeof key !== 'string' || !key.length) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      if (Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key]);
    }
    return out;
  }

  function extractWalletBalance(data, role) {
    if (!data || typeof data !== 'object') return 0;
    var values = [];
    function add(val) {
      var num = coerceNumber(val);
      if (num !== null) values.push(num);
    }
    add(data.walletBalance);
    add(data.availableBalance);
    add(data.wallet);
    add(data.wallet_balance);
    add(data.marginBalance);
    add(data.margin_balance);
    var roleFields = pickRoleSpecific(data, 'walletBalance', role)
      .concat(pickRoleSpecific(data, 'wallet_balance', role))
      .concat(pickRoleSpecific(data, 'availableBalance', role))
      .concat(pickRoleSpecific(data, 'available_balance', role));
    for (var rf of roleFields) add(rf);
    if (data.wallets && typeof data.wallets === 'object') {
      var roleLower = (typeof role === 'string') ? role.toLowerCase() : '';
      var roleCap = roleLower ? roleLower.charAt(0).toUpperCase() + roleLower.slice(1) : '';
      var roleUpper = roleLower.toUpperCase();
      if (roleLower && Object.prototype.hasOwnProperty.call(data.wallets, roleLower)) add(data.wallets[roleLower]);
      if (roleCap && Object.prototype.hasOwnProperty.call(data.wallets, roleCap)) add(data.wallets[roleCap]);
      if (roleUpper && Object.prototype.hasOwnProperty.call(data.wallets, roleUpper)) add(data.wallets[roleUpper]);
    }
    if (data.roles && typeof data.roles === 'object') {
      var rl = (typeof role === 'string') ? role.toLowerCase() : '';
      var rc = rl ? rl.charAt(0).toUpperCase() + rl.slice(1) : '';
      var ru = rl.toUpperCase();
      var roleEntry = null;
      if (rl && Object.prototype.hasOwnProperty.call(data.roles, rl)) roleEntry = data.roles[rl];
      else if (rc && Object.prototype.hasOwnProperty.call(data.roles, rc)) roleEntry = data.roles[rc];
      else if (ru && Object.prototype.hasOwnProperty.call(data.roles, ru)) roleEntry = data.roles[ru];
      if (roleEntry && typeof roleEntry === 'object') {
        add(roleEntry.walletBalance);
        add(roleEntry.wallet);
        add(roleEntry.availableBalance);
        add(roleEntry.available_balance);
      }
    }
    if (data.balances && typeof data.balances === 'object') {
      var roleKey = (typeof role === 'string') ? role.toLowerCase() : '';
      if (roleKey && Object.prototype.hasOwnProperty.call(data.balances, roleKey)) add(data.balances[roleKey]);
    }
    if (data.pairLedger && typeof data.pairLedger === 'object') {
      add(data.pairLedger.walletBalance);
    }
    if (!values.length) return 0;
    for (var vi = 0; vi < values.length; vi++) {
      if (values[vi] !== 0) return values[vi];
    }
    return values[0];
  }

  var wallet = extractWalletBalance(gb.data, S.role);
  var qty = Number.isFinite(gb.data.currentQty) ? gb.data.currentQty : 0;
  var breakEven = Number.isFinite(gb.data.breakEven) ? gb.data.breakEven : 0;
  var liq = Number.isFinite(gb.data.liquidationPrice) ? gb.data.liquidationPrice : 0;

  function stepPrecision(step) {
    return Math.max(0, Math.round(Math.log10(1 / step)));
  }
  function preciseRoundToStep(v, step) {
    if (!Number.isFinite(v)) return 0;
    if (!Number.isFinite(step) || step <= 0) return v;
    var k = stepPrecision(step);
    return Number((Math.round(v / step) * step).toFixed(k));
  }
  function preciseCeilToStep(v, step) {
    if (!Number.isFinite(v)) return 0;
    if (!Number.isFinite(step) || step <= 0) return v;
    var k = stepPrecision(step);
    var scaled = Math.ceil(v / step - 1e-12);
    return Number((scaled * step).toFixed(k));
  }
  function preciseFloorToStep(v, step) {
    if (!Number.isFinite(v)) return 0;
    if (!Number.isFinite(step) || step <= 0) return v;
    var k = stepPrecision(step);
    var scaled = Math.floor(v / step + 1e-12);
    return Number((scaled * step).toFixed(k));
  }
  function fixPrice(px) { return preciseRoundToStep(px, S.priceStep); }
  function toQuote(px, base) { return Math.max(0, (Number.isFinite(px)?px:0) * (Number.isFinite(base)?base:0)); }
  function hasMethod(name) { return !!(gb && gb.method && typeof gb.method[name] === 'function'); }
  function pause(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }
  function safePromise(fn) { try { return Promise.resolve(fn()); } catch (err) { return Promise.reject(err); } }
  async function callWithTimeout(promise, ms, label) {
    var timer; var timeoutErr = new Error('local-timeout ' + label + ' after ' + ms + 'ms');
    var timeout = new Promise(function(_, reject){ timer = setTimeout(function(){ reject(timeoutErr); }, Math.max(1, ms)); });
    try { return await Promise.race([promise, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
  function markApiFailure(reason) {
    var nowTs = Date.now();
    var reasonTxtRaw = reason && reason.message ? reason.message : String(reason || 'okänd');
    var reasonTxt = reasonTxtRaw.length > 160 ? reasonTxtRaw.slice(0, 157) + '…' : reasonTxtRaw;
    var alreadyBackoff = S.apiBackoffUntil > nowTs;
    var next = S.apiBackoffMs > 0 ? Math.min(S.apiBackoffMs * 2, S.apiBackoffMax) : 15_000;
    S.apiBackoffMs = next; S.apiBackoffUntil = nowTs + next; S.apiFailCount = (S.apiFailCount || 0) + 1;
    var reasonChanged = S.lastApiError !== reasonTxt; S.lastApiError = reasonTxt;
    if (!alreadyBackoff || reasonChanged) {
      gb.data.pairLedger.notifications = [{ text: 'API-problem (' + reasonTxt + '). Pausar i ' + Math.round(next/1000) + 's', variant: 'error', persist: false }];
    }
  }
  function shouldBackoff(err) {
    if (!err) return false;
    var txt = (err.message ? err.message : String(err || '')).toLowerCase();
    return !!txt && (txt.indexOf('timeout')>=0 || txt.indexOf('timed out')>=0 || txt.indexOf('etimedout')>=0 || txt.indexOf('econn')>=0 || txt.indexOf('connect')>=0 || txt.indexOf('network')>=0);
  }
  function clearApiFailure() {
    if (S.apiBackoffMs !== 0 || S.apiFailCount !== 0 || (S.lastApiError && S.lastApiError.length)) {
      S.apiFailCount = 0; S.apiBackoffMs = 0; S.apiBackoffUntil = 0;
      if (S.lastApiError && S.lastApiError.length) {
        gb.data.pairLedger.notifications = [{ text: 'API återhämtat. Återupptar.', variant: 'success', persist: false }];
      }
      S.lastApiError = '';
    }
  }

  // ====== Equity/marginal ======
  function equity() {
    var effectiveBE = (breakEven > 0 ? breakEven : price);
    var pnl = (price > 0 && effectiveBE > 0) ? qty * (price - effectiveBE) : 0;
    return wallet + pnl;
  }
  function marginUsed() { return Math.abs(qty) * (price > 0 ? price : 1) / Math.max(1, S.leverage); }
  function freeMargin() { return Math.max(0, equity() - marginUsed()); }

  // ====== Metrics init ======
  if (price > 0 && equity() > 0 && !S.startTs) {
    S.startTs = now; S.startEquity = equity(); S.startPrice = price;
    S.hodlQty = S.startPrice > 0 ? (S.startEquity / S.startPrice) : 0;
    S.eqPeak = S.startEquity; S.lastFlatEq = S.startEquity;
    console.log('[GRID] metrics init startEq=', S.startEquity.toFixed(4), 'startP=', S.startPrice.toFixed(8));
  }

  // ====== Inventory-ratio ======
  var invRatio = (function(){
    var eq = Math.max(1e-9, equity());
    var maxNotional = Math.max(1e-6, S.invMaxPct * eq);
    var curNotional = Math.abs(qty) * (price > 0 ? price : 1);
    var r = curNotional / maxNotional;
    var sign = qty >= 0 ? 1 : -1;
    var v = sign * r;
    return v > 1 ? 1 : (v < -1 ? -1 : v);
  })();

  // ====== Failsafe ======
  if (typeof S.failsafeEnabled !== 'boolean') S.failsafeEnabled = true;
  if (typeof S.maxStaleMs !== 'number') S.maxStaleMs = 30_000;
  if (typeof S.minFreeMarginPct !== 'number') S.minFreeMarginPct = 0.00;
  if (typeof S.paused !== 'boolean') S.paused = false;
  if (typeof S.lastPauseReason !== 'string') S.lastPauseReason = '';
  if (typeof S.lastGoodTs !== 'number') S.lastGoodTs = 0;

  var priceOk = (bid > 0 && ask > 0 && ask >= bid);
  if (priceOk) S.lastGoodTs = now;
  var pauseReason = '';
  if (S.failsafeEnabled) {
    var stale = now - S.lastGoodTs > S.maxStaleMs;
    if (!priceOk) pauseReason = 'Prisdata saknas';
    else if (stale) pauseReason = 'Prisdata inaktuell';
    else {
      var eqv = equity();
      var fm = freeMargin();
      var minFM = Math.max(0, S.minFreeMarginPct * Math.max(1e-9, eqv));
      if (fm < minFM) pauseReason = 'Låg fri marginal';
    }
  }

  // ====== Center & step ======
  var stepAbs = (price > 0 ? price : 1) * Math.max(0.0001, S.gridStepPct);
  var centerTarget = price > 0 ? (price - S.skewK * invRatio * stepAbs) : (S.center || 0);
  var drift = price > 0 ? Math.abs((S.center - centerTarget) / price) : 0;
  var driftThreshold = Math.max(0.001, S.gridStepPct / 2);
  var needRecenter = (!S.lastRecenterTs || (now - S.lastRecenterTs > S.recenterEveryMs)) || (drift > driftThreshold);
  if (typeof S.resetCenter !== 'boolean') S.resetCenter = false;
  if (S.resetCenter && price > 0) { S.center = price; S.lastRecenterTs = now; S.resetCenter = false; }
  else if (needRecenter) { S.center = centerTarget; S.lastRecenterTs = now; }

  // ====== Dynamiska min-nivåer (auto + per symbol + override) ======
  var qtyStep = S.qtyStep > 0 ? S.qtyStep : 0.1;

  var skey = symbolKey();
  var perSym = (S.perSymbol && S.perSymbol[skey]) ? S.perSymbol[skey] : null;

  var minQtyEff  = Math.max(
    0,
    Number(marketMinQty) || 0,
    Number(S.minQtyOverride) || 0,
    Number(perSym && perSym.minQtyOverride) || 0
  );

  var baseMinNot0 = Math.max(
    0,
    Number(marketMinNot) || 0,
    Number(S.minNotionalOverride) || 0,
    Number(perSym && perSym.minNotionalOverride) || 0
  );

  var multGlobal = (Number.isFinite(S.minNotionalMultiplier) && S.minNotionalMultiplier > 0) ? S.minNotionalMultiplier : 1;
  var multPerSym = (perSym && Number.isFinite(perSym.minNotionalMultiplier) && perSym.minNotionalMultiplier > 0) ? perSym.minNotionalMultiplier : multGlobal;
  var bumpUSDT = Math.max(0, Number(S.minNotionalBumpUSDT) || 0) + Math.max(0, Number(perSym && perSym.minNotionalBumpUSDT) || 0);
  var absMinUSDT = Math.max(0, Number(S.absoluteMinQuoteUSDT) || 0, Number(perSym && perSym.absoluteMinQuoteUSDT) || 0);

  var minNotEff = Math.max(baseMinNot0 * multPerSym + bumpUSDT, absMinUSDT);

  var minBaseByNotionalMid = (minNotEff > 0 && price > 0) ? (minNotEff / price) : 0;
  var dynamicMinBaseMid = preciseCeilToStep(Math.max(minQtyEff || 0, minBaseByNotionalMid || 0, S.minBaseAmt || 0), qtyStep);

  S.dynamicMinBase = dynamicMinBaseMid;
  S.dynamicMinQuote = minNotEff;
  S._minQtyEff = minQtyEff;
  S._minNotEff = minNotEff;
  S._exMinQty = minQtyEff;
  S._exMinNot = minNotEff;

  // ====== Auto-shed om över cap ======
  async function maybeAutoShed() {
    if (!S.autoShedEnabled || !price || !Math.abs(qty)) return;
    var eqNow = equity();
    var cap = (S.invMaxPct * Math.max(1e-9, eqNow)) / Math.max(1e-9, price);
    var shedThreshold = cap * (1 + S.autoShedSlackPct);
    var absQ = Math.abs(qty);
    if (absQ <= shedThreshold) return;
    var overshoot = absQ - cap;
    var shedAmtRaw = Math.max(overshoot, cap * 0.25);
    var shedAmt = preciseRoundToStep(Math.min(shedAmtRaw, absQ), qtyStep);
    var side = (qty > 0) ? 'sell' : 'buy';
    var pxIoc = (qty > 0) ? Math.max(bid, price * 0.999) : Math.min(ask, price * 1.001);

    function placeIOC(side, q, px, reduceOnly) {
      if (reduceOnly) {
        if (side === 'buy') {
          if (hasMethod('buyMarketReduceOnly')) return gb.method.buyMarketReduceOnly(q, pair, ex);
          if (hasMethod('buyIOC'))              return gb.method.buyIOC(q, px, pair, ex, { reduceOnly: true });
          return gb.method.buyMarket(q, pair, ex, { reduceOnly: true });
        } else {
          if (hasMethod('sellMarketReduceOnly'))return gb.method.sellMarketReduceOnly(q, pair, ex);
          if (hasMethod('sellIOC'))             return gb.method.sellIOC(q, px, pair, ex, { reduceOnly: true });
          return gb.method.sellMarket(q, pair, ex, { reduceOnly: true });
        }
      }
      if (side === 'buy')  return hasMethod('buyMarket')  ? gb.method.buyMarket(q, pair, ex)  : gb.method.buyIOC(q, px, pair, ex);
      return hasMethod('sellMarket') ? gb.method.sellMarket(q, pair, ex) : gb.method.sellIOC(q, px, pair, ex);
    }

    try {
      var res = await callWithTimeout(safePromise(function(){ return placeIOC(side, shedAmt, fixPrice(pxIoc), true); }), Math.max(8_000, S.localOrderTimeoutMs), 'auto-shed');
      console.log('[GRID]', S.role, 'AUTO-SHED', side, shedAmt, '@', fixPrice(pxIoc), 'resp=', !!res);
      clearApiFailure();
    } catch(e) {
      console.log('[GRID] auto-shed err', e && e.message ? e.message : e);
      if (shouldBackoff(e)) markApiFailure(e);
    }
  }
  await maybeAutoShed();

  // ====== Bygg grid ======
  var levels = Math.max(1, Math.min(orderPlan.levels, 25));
  var freeNow = Math.max(0, freeMargin());
  var reservePct = Math.max(0, Math.min(0.9, S.midReservePct));
  var reserveQuote = freeNow * reservePct;
  var dynamicQuote = Math.max(0, freeNow - reserveQuote);
  var allocPct = Math.max(0, Math.min(1, S.allocPct));
  var manualQuote = freeNow * allocPct;
  var allocQuote = Math.min(freeNow, Math.max(dynamicQuote, manualQuote));

  var skewFactor = Math.max(-1, Math.min(1, invRatio * (Number.isFinite(S.skewK) ? S.skewK : 0)));
  var bidQuoteShare = Math.max(0, 0.5 * (1 - skewFactor));
  var askQuoteShare = Math.max(0, 0.5 * (1 + skewFactor));
  var bidAllocQuote = allocQuote * (bidQuoteShare / Math.max(1e-9, bidQuoteShare + askQuoteShare));
  var askAllocQuote = allocQuote * (askQuoteShare / Math.max(1e-9, bidQuoteShare + askQuoteShare));

  var weights = []; for (var wi=1; wi<=levels; wi++) weights.push(1/wi);
  var wSum = weights.reduce(function(a,b){return a+b;},0);

  var bids = []; var asks = [];
  var sizeBaseB = []; var sizeBaseA = [];

  for (var i=1; i<=levels; i++) {
    var b = fixPrice(S.center - i * stepAbs);
    var a = fixPrice(S.center + i * stepAbs);
    bids.push(b); asks.push(a);

    var weightShare = weights[i - 1] / Math.max(1e-9, wSum);

    function computeBaseAmt(sideQuoteAlloc) {
      var perLevelQuote = sideQuoteAlloc * weightShare;
      var pxRef = price > 0 ? price : 1;
      var baseAmtSide = perLevelQuote / Math.max(1e-9, pxRef);
      var hardMidBase = dynamicMinBaseMid;

      if (!Number.isFinite(baseAmtSide) || baseAmtSide <= 0) baseAmtSide = 0;
      baseAmtSide = Math.max(baseAmtSide, hardMidBase, minQtyEff);

      var eqForCap = (S.startEquity > 0 ? S.startEquity : equity());
      var maxQuote = Math.max(0, eqForCap * (Number.isFinite(S.maxOrderQuotePct)?S.maxOrderQuotePct:0.01));
      if (maxQuote > 0 && toQuote(price, baseAmtSide) > maxQuote) baseAmtSide = maxQuote / Math.max(1e-9, price);
      return preciseRoundToStep(baseAmtSide, qtyStep);
    }

    sizeBaseB.push(computeBaseAmt(bidAllocQuote));
    sizeBaseA.push(computeBaseAmt(askAllocQuote));
  }

  // ====== Throttle/toleranser ======
  var now2 = Date.now();
  var cycleDueBase = now2 - S.lastCycleTs > S.cooldownMs;
  var cycleDue = cycleDueBase || S.forceImmediateCycle;
  var pxUnit = (price > 0 ? price : 1);
  var tolPct = S.cancelTolerancePct;
  var tolAbs = tolPct * pxUnit;
  var replaceTriggerPct = (Number.isFinite(S.replaceTriggerPct) && S.replaceTriggerPct > 0) ? S.replaceTriggerPct : Math.max(S.gridStepPct * 0.5, tolPct * 1.5);
  var replaceTriggerAbs = replaceTriggerPct * pxUnit;
  var cancelTriggerAbs = Math.max(replaceTriggerAbs * 1.75, pxUnit * S.gridStepPct);
  var halfTick = (S.priceStep > 0 ? 0.51 * S.priceStep : 0);
  var matchTolerance = Math.max(tolAbs, replaceTriggerAbs * 0.5, halfTick);

  // ====== Open Orders Failsafe ======
  var oo = [];
  if (!Array.isArray(gb.data.openOrders)) {
    console.warn('[GRID] openOrders saknas – använder tom array');
    if (!S.openOrdersFailSince) S.openOrdersFailSince = now2;
    oo = [];
  } else {
    oo = gb.data.openOrders;
    S.openOrdersFailSince = 0;
  }
  if (typeof S.apiBackoffUntil !== 'number') S.apiBackoffUntil = 0;
  if (typeof S.apiBackoffMs !== 'number') S.apiBackoffMs = 0;
  if (typeof S.apiBackoffMax !== 'number') S.apiBackoffMax = 120_000;
  if (typeof S.apiFailCount !== 'number') S.apiFailCount = 0;
  if (typeof S.lastApiError !== 'string') S.lastApiError = '';
  var apiUnstable = false;
  if (S.failsafeEnabled) {
    if (S.openOrdersFailSince > 0) apiUnstable = true;
    if (S.apiBackoffUntil > now2) apiUnstable = true;
  }

  if (!Array.isArray(S.observedCache)) S.observedCache = [];

  // ====== Hjälpfunktioner orderfält ======
  function rateFromOrder(o){
    if (!o || typeof o !== 'object') return 0;
    var fields = ['rate','price','limit_price','orderPrice','avgPrice','avg_price','priceAvg'];
    for (var f of fields) { if (o.hasOwnProperty(f)) { var num = typeof o[f] === 'number' ? o[f] : Number(o[f]); if (Number.isFinite(num) && num > 0) return num; } }
    return 0;
  }
  function sideFromOrder(o){
    if (!o || typeof o !== 'object') return '';
    var raw = o.type || o.side || o.orderSide || o.positionSide;
    if (!raw) return '';
    var txt = String(raw).toLowerCase();
    if (txt.indexOf('buy')===0 || txt === 'long' || txt === '1') return 'buy';
    if (txt.indexOf('sell')===0 || txt === 'short' || txt === '2') return 'sell';
    return '';
  }
  function idFromOrder(o){
    if (!o || typeof o !== 'object') return '';
    var fields = ['id','orderId','order_id','clientOrderId','client_order_id','clOrdID'];
    for (var f of fields) { var v = o[f]; if (v !== undefined && v !== null && String(v).length) return String(v); }
    return '';
  }
  function qtyFromOrder(o){
    if (!o || typeof o !== 'object') return 0;
    var fields = ['quantity','qty','amount','origQty','baseQuantity','size'];
    for (var f of fields) { if (o.hasOwnProperty(f)) { var num = typeof o[f] === 'number' ? o[f] : Number(o[f]); if (Number.isFinite(num) && num > 0) return num; } }
    return 0;
  }

  // ====== Fyllda/saknade detektion ======
  var currentKnownOrders = []; var curIdSet = new Set(); var curBySide = { buy: 0, sell: 0 };
  if (Array.isArray(oo)) {
    for (var ord of oo) {
      var idk = idFromOrder(ord); if (!idk) continue;
      var s = sideFromOrder(ord);
      var pxo = rateFromOrder(ord);
      currentKnownOrders.push({ id: idk, side: s, px: pxo });
      curIdSet.add(idk);
      if (s === 'buy' || s === 'sell') curBySide[s]++;
    }
  }

  var fillDetected = false;
  var missingOrders = [];
  if (Array.isArray(S.lastKnownOrders) && S.lastKnownOrders.length) {
    for (var prev of S.lastKnownOrders) {
      if (!prev || !prev.id) continue;
      if (!curIdSet.has(prev.id)) { missingOrders.push(prev); fillDetected = true; }
    }
  }
  if (Array.isArray(S.lastDesiredShape) && S.lastDesiredShape.length) {
    for (var target of S.lastDesiredShape) {
      if (!target || !target.side || !Number.isFinite(target.px)) continue;
      var exists = currentKnownOrders.some(function(o){ return o.side === target.side && Math.abs((o.px || 0) - target.px) <= matchTolerance; });
      if (!exists) missingOrders.push({ side: target.side, px: target.px });
    }
    if (missingOrders.length) fillDetected = true;
  }
  if (missingOrders.length > 1) {
    var seen = new Set(); var unique = [];
    for (var ms of missingOrders) {
      if (!ms) continue;
      var keym = (ms.side || '') + ':' + Number(ms.px || 0).toFixed(8) + ':' + (ms.id || '');
      if (seen.has(keym)) continue; seen.add(keym); unique.push(ms);
    }
    if (unique.length !== missingOrders.length) { missingOrders = unique; }
  }
  if (fillDetected) {
    S.lastFillTs = now2; S.forceImmediateCycle = true; S.forceRecenter = true;
    var cleanupTol = Math.max(matchTolerance, S.priceStep || 0);
    if (S.observedCache.length) {
      S.observedCache = S.observedCache.filter(function(c){ return !missingOrders.some(function(m){ return m && m.side === c.side && Math.abs((c.px || 0) - (m.px || 0)) <= cleanupTol; }); });
    }
    if (Array.isArray(S.recentPlaced) && S.recentPlaced.length) {
      S.recentPlaced = S.recentPlaced.filter(function(r){ return !missingOrders.some(function(m){ return m && m.side === r.side && Math.abs((r.px || 0) - (m.px || 0)) <= cleanupTol; }); });
    }
    var missTxt = missingOrders.map(function(m){ return (m && m.side) ? (m.side + '@' + Number(m.px || 0).toFixed(6)) : null; }).filter(Boolean).join(', ');
    console.log('[GRID]', S.role, 'orderförlust – triggar omplanering. Saknar:', missTxt || 'okända id:n');
  }
  S.lastKnownOrders = currentKnownOrders;
  if (S.forceRecenter) { S.center = centerTarget; S.lastRecenterTs = now2; S.forceRecenter = false; }
  if (S.forceImmediateCycle) cycleDue = true;

  if (S.failsafeEnabled && S.openOrdersFailSince > 0 && (now2 - S.openOrdersFailSince > 3 * S.cooldownMs)) {
    if (!pauseReason) pauseReason = 'openOrders saknas eller är fördröjda';
    var nextB = S.apiBackoffMs > 0 ? Math.min(S.apiBackoffMs * 2, S.apiBackoffMax) : 10_000;
    S.apiBackoffMs = nextB; S.apiBackoffUntil = now2 + S.apiBackoffMs;
    gb.data.pairLedger.notifications = [{ text: 'openOrders timeout – backoff ' + Math.round(nextB/1000) + 's', variant: 'error', persist: false }];
  }

  var prevPauseKey = (S.paused ? S.lastPauseReason : '');
  var changed = prevPauseKey !== pauseReason;
  if (pauseReason) {
    if (!S.paused || changed) { S.paused = true; S.lastPauseReason = pauseReason;
      gb.data.pairLedger.notifications = [{ text: 'FAILSAFE: ' + pauseReason + '. Pausar order.', variant: 'error', persist: false }]; }
  } else if (S.paused) {
    S.paused = false; S.lastPauseReason = '';
    gb.data.pairLedger.notifications = [{ text: 'Failsafe avklarad. Återupptar.', variant: 'success', persist: false }];
  }

  // ====== Orderläggning ======
  var desired = null;
  if (cycleDue && !S.paused && !apiUnstable) {
    if (!S.trimThrottle || typeof S.trimThrottle !== 'object') S.trimThrottle = {};
    var trimThrottle = S.trimThrottle;
    var trimExpiry = Math.max(orderPlan.trimCooldownMs * 4, 120_000);
    for (var key in trimThrottle) if (!Number.isFinite(trimThrottle[key]) || now2 - trimThrottle[key] > trimExpiry) delete trimThrottle[key];

    desired = [];
    function pushDesired(side, px, amt, tag) {
      if (!Number.isFinite(px) || px <= 0) return;
      if (!Number.isFinite(amt) || amt <= 0) return;
      for (var d of desired) if (d.side === side && Math.abs(d.px - px) <= matchTolerance) return;
      desired.push({ side: side, px: px, amt: amt, matched: false, tag: tag });
    }

    // Trim-avstånd
    var trimGapAbs = Math.max(S.priceStep || 0, stepAbs * (orderPlan.trimDistanceFactor || 1));

    if (S.role === 'long') {
      for (var bi=0; bi<bids.length; bi++) pushDesired('buy',  bids[bi], sizeBaseB[bi], 'bid-' + bi);
      var trimsL = Math.min(S.trimLevels, asks.length);
      for (var ti=0; ti<trimsL; ti++) {
        var base0 = preciseRoundToStep(sizeBaseA[ti] * (S.trimInsidePct || 0.25), qtyStep);
        var amtTrim = preciseCeilToStep(Math.max(dynamicMinBaseMid, base0), qtyStep);
        if (S.reduceOnlyTrims) amtTrim = Math.min(amtTrim, Math.max(0, Math.abs(qty)));
        var pxT = fixPrice(price + (ti + 1) * trimGapAbs);
        if (pxT > 0 && amtTrim > 0) pushDesired('sell', pxT, amtTrim, 'trimAsk-' + ti + '|RO');
      }
    } else {
      for (var ai=0; ai<asks.length; ai++) pushDesired('sell', asks[ai], sizeBaseA[ai], 'ask-' + ai);
      var trimsS = Math.min(S.trimLevels, bids.length);
      for (var tj=0; tj<trimsS; tj++) {
        var base0s = preciseRoundToStep(sizeBaseB[tj] * (S.trimInsidePct || 0.25), qtyStep);
        var amtTrimS = preciseCeilToStep(Math.max(dynamicMinBaseMid, base0s), qtyStep);
        if (S.reduceOnlyTrims) amtTrimS = Math.min(amtTrimS, Math.max(0, Math.abs(qty)));
        var pxTs = fixPrice(price - (tj + 1) * trimGapAbs);
        if (pxTs > 0 && amtTrimS > 0) pushDesired('buy', pxTs, amtTrimS, 'trimBid-' + tj + '|RO');
      }
    }

    console.log('[GRID]', S.role, 'cykelstart',
      'pris=' + Number(price || 0).toFixed(6),
      'open=' + oo.length,
      'mål=' + desired.length,
      'minQtyEff=' + minQtyEff, 'minNotEff=' + minNotEff,
      'dynMinBase=' + dynamicMinBaseMid,
      'gridBudget=' + allocQuote.toFixed(4),
      'reserved=' + reserveQuote.toFixed(4),
      'bidBudget=' + bidAllocQuote.toFixed(4),
      'askBudget=' + askAllocQuote.toFixed(4)
    );

    if (desired.length === 0) {
      console.log('[GRID]', S.role, 'inga planerade order i denna cykel – alla nivåer uppfyllda eller budget=0');
    }

    var replaceMethodName =
      (gb.method && typeof gb.method.replaceOrder === 'function') ? 'replaceOrder' :
      (gb.method && typeof gb.method.amendOrder   === 'function') ? 'amendOrder'   :
      (gb.method && typeof gb.method.editOrder    === 'function') ? 'editOrder'    : '';
    var canReplace = Boolean(replaceMethodName);
    var maxReplacesPerCycle = (Number.isFinite(orderPlan.maxReplacesPerCycle) && orderPlan.maxReplacesPerCycle > 0)
      ? orderPlan.maxReplacesPerCycle : orderPlan.maxPerCycle || Infinity;
    var replacedThisCycle = 0;

    function findWithinTolerance(side, rate){
      if (!Number.isFinite(rate) || rate <= 0) return null;
      for (var d of desired) { if (!d.matched && d.side === side && Math.abs(rate - d.px) <= matchTolerance) return d; }
      return null;
    }
    function findClosestTarget(side, rate){
      if (!Number.isFinite(rate) || rate <= 0) return null;
      var best = null; var bestDist = Infinity;
      for (var d of desired) {
        if (d.matched || d.side !== side) continue;
        var dist = Math.abs(rate - d.px);
        if (dist < bestDist) { bestDist = dist; best = d; }
      }
      return best;
    }

    function placeLimit(side, qtyL, pxL, reduceOnly, postOnly) {
      if (reduceOnly) {
        if (side === 'buy') {
          if (hasMethod('buyLimitReduceOnly'))  return gb.method.buyLimitReduceOnly(qtyL, pxL, pair, ex);
          if (hasMethod('buyLimit'))            return gb.method.buyLimit(qtyL, pxL, pair, ex, { reduceOnly: true });
        } else {
          if (hasMethod('sellLimitReduceOnly')) return gb.method.sellLimitReduceOnly(qtyL, pxL, pair, ex);
          if (hasMethod('sellLimit'))           return gb.method.sellLimit(qtyL, pxL, pair, ex, { reduceOnly: true });
        }
      }
      if (postOnly || S.usePostOnly) {
        if (side === 'buy' && hasMethod('buyLimitPostOnly'))  return gb.method.buyLimitPostOnly(qtyL, pxL, pair, ex);
        if (side === 'sell' && hasMethod('sellLimitPostOnly')) return gb.method.sellLimitPostOnly(qtyL, pxL, pair, ex);
      }
      if (side === 'buy')  return gb.method.buyLimit(qtyL, pxL, pair, ex);
      return gb.method.sellLimit(qtyL, pxL, pair, ex);
    }

    async function placeOne(side, px, amt, tag) {
      try {
        // dubblettskydd
        for (var r of (S.recentPlaced || [])) if (r.side === side && Math.abs(r.px - px) <= matchTolerance) return false;
        for (var c of (S.observedCache || [])) if (c.side === side && Math.abs(c.px - px) <= matchTolerance && (now2 - c.ts) <= S.cooldownMs) return false;

        var reduceOnly = !!(tag && String(tag).indexOf('|RO')>0);
        var pxOk = fixPrice(px);
        var amtOk;

        if (reduceOnly) {
          var posAbs = Math.max(0, Math.abs(qty));
          amtOk = preciseFloorToStep(Math.min(Math.max(0, Number(amt) || 0), posAbs), qtyStep);
          var belowMinQtyRO = (minQtyEff > 0 && amtOk < minQtyEff);
          var belowMinNotRO = (minNotEff > 0 && toQuote(price, amtOk) < minNotEff);
          if (amtOk <= 0 || belowMinQtyRO || belowMinNotRO) {
            if (S.autoShedIoc && posAbs > 0) {
              var pxIoc = (qty > 0) ? Math.max(bid, price * 0.999) : Math.min(ask, price * 1.001);
              var resRO = await callWithTimeout(safePromise(function(){
                if (qty > 0) {
                  if (hasMethod('sellMarketReduceOnly')) return gb.method.sellMarketReduceOnly(posAbs, pair, ex);
                  if (hasMethod('sellIOC'))             return gb.method.sellIOC(posAbs, fixPrice(pxIoc), pair, ex, { reduceOnly: true });
                  return gb.method.sellMarket(posAbs, pair, ex, { reduceOnly: true });
                } else {
                  if (hasMethod('buyMarketReduceOnly')) return gb.method.buyMarketReduceOnly(posAbs, pair, ex);
                  if (hasMethod('buyIOC'))              return gb.method.buyIOC(posAbs, fixPrice(pxIoc), pair, ex, { reduceOnly: true });
                  return gb.method.buyMarket(posAbs, pair, ex, { reduceOnly: true });
                }
              }), Math.max(8_000, S.localOrderTimeoutMs), 'trim-RO-ioc');
              clearApiFailure();
              if (resRO) {
                if (!Array.isArray(S.recentPlaced)) S.recentPlaced = [];
                if (!Array.isArray(S.observedCache)) S.observedCache = [];
                S.recentPlaced.push({ side: (qty > 0 ? 'sell' : 'buy'), px: pxOk, ts: Date.now() });
                S.observedCache.push({ side: (qty > 0 ? 'sell' : 'buy'), px: pxOk, ts: Date.now() });
                console.log('[GRID]', S.role, 'RO-IOC placed to trim');
                return true;
              }
            }
            console.log('[GRID] skip RO trim: under minQty/minNotional', amtOk);
            return false;
          }
        } else {
          // Vanlig gridorder: hårda MIN per ORDER-PRIS
          var needQuoteBase = (minNotEff > 0 && pxOk > 0) ? (minNotEff / pxOk) : 0;
          var hardMinBaseNow = preciseCeilToStep(Math.max(S.minBaseAmt || 0, minQtyEff || 0, needQuoteBase || 0), qtyStep);
          var baseCandidate = Number(amt) || 0;
          if (!Number.isFinite(baseCandidate) || baseCandidate <= 0) baseCandidate = 0;
          // ta max(baseCandidate, hardMinBaseNow)
          amtOk = preciseCeilToStep(Math.max(baseCandidate, hardMinBaseNow), qtyStep);

          // bump om notional blir exakt på gräns
          var qv = toQuote(pxOk, amtOk);
          if (minNotEff > 0 && qv < minNotEff) {
            var bumpBase = preciseCeilToStep((minNotEff / pxOk) * 1.001, qtyStep);
            amtOk = Math.max(amtOk, bumpBase);
            qv = toQuote(pxOk, amtOk);
          }

          // cap per order mot equity
          var eqForCap2 = (S.startEquity > 0 ? S.startEquity : equity());
          var maxQuote2 = Math.max(0, eqForCap2 * (Number.isFinite(S.maxOrderQuotePct)?S.maxOrderQuotePct:0.01));
          if (maxQuote2 > 0 && qv > maxQuote2) {
            amtOk = preciseFloorToStep(maxQuote2 / Math.max(1e-9, pxOk), qtyStep);
            qv = toQuote(pxOk, amtOk);
          }

          // sista kontroll
          var failReason = null;
          if (amtOk <= 0) failReason = 'amt<=0';
          else if (minQtyEff > 0 && amtOk < minQtyEff) failReason = 'under minQtyEff';
          else if (minNotEff > 0 && qv < minNotEff) failReason = 'under minNotEff';

          if (failReason) {
            console.log('[GRID] skip grid order: fail=' + failReason, { pxOk: pxOk, amtOk: amtOk, qv: qv, minQtyEff: minQtyEff, minNotEff: minNotEff });
            return false;
          }
        }

        console.log('[GRID] placing', {
          side: side,
          px: pxOk,
          amt: amtOk,
          minQtyEff: minQtyEff,
          effMinQuote: minNotEff,
          dynMinBase: dynamicMinBaseMid
        });

        var res = await callWithTimeout(safePromise(function(){ return placeLimit(side, amtOk, pxOk, reduceOnly, S.usePostOnly); }), S.localOrderTimeoutMs, 'place order');

        var ok = false;
        if (res) {
          if (res.orderId || res.id || res.clientOrderId || res.client_order_id) ok = true;
          if (res.success === true) ok = true;
          if (typeof res.retCode !== 'undefined') ok = (Number(res.retCode) === 0 || String(res.retCode) === '0');
        }
        if (!ok) {
          var errMsg = (res && (res.retMsg || res.msg || res.message)) ? (res.retMsg || res.msg || res.message) : null;
          console.log('[GRID] place returned error-ish response', side, pxOk, { amtOk: amtOk, minQtyEff: minQtyEff, minNotEff: minNotEff }, errMsg ? 'err=' + errMsg : '', '\nresp=', res);
          if (errMsg && shouldBackoff({ message: errMsg })) markApiFailure({ message: errMsg });
          return false;
        }

        clearApiFailure();
        if (!Array.isArray(S.recentPlaced)) S.recentPlaced = [];
        if (!Array.isArray(S.observedCache)) S.observedCache = [];
        S.recentPlaced.push({ side: side, px: pxOk, ts: Date.now() });
        S.observedCache.push({ side: side, px: pxOk, ts: Date.now() });
        console.log('[GRID]', S.role, 'placed', tag || side, amtOk, '@', pxOk, reduceOnly ? '(RO)' : '');
        return true;
      } catch(e) {
        console.log('[GRID] place err', side, px, e && e.message ? e.message : e);
        if (shouldBackoff(e)) markApiFailure(e);
        return false;
      }
    }

    async function replaceOne(order, target) {
      if (!canReplace || !order || !target) return false;
      var id = idFromOrder(order); if (!id) return false;
      var qtyExisting = qtyFromOrder(order);
      var q = Number.isFinite(target.amt) && target.amt > 0 ? target.amt : qtyExisting;
      if (!Number.isFinite(q) || q <= 0) return false;
      var qOk = preciseRoundToStep(q, qtyStep);
      var pxOk = fixPrice(target.px);
      try {
        await callWithTimeout(safePromise(function(){ return gb.method[replaceMethodName](id, qOk, pxOk, pair, ex); }), S.localOrderTimeoutMs, 'replace order');
        clearApiFailure();
        target.matched = true; replacedThisCycle++;
        console.log('[GRID]', S.role, 'replaced', sideFromOrder(order), qOk, '@', pxOk);
        return true;
      } catch(err) {
        console.log('[GRID] replace err', sideFromOrder(order), pxOk, err && err.message ? err.message : err);
        if (shouldBackoff(err)) markApiFailure(err);
        return false;
      }
    }

    async function cancelOne(orderOrId) {
      var id = typeof orderOrId === 'string' ? orderOrId : idFromOrder(orderOrId);
      if (!id) return false;
      try {
        await callWithTimeout(safePromise(function(){ return gb.method.cancelOrder(id, pair, ex); }), S.localOrderTimeoutMs, 'cancel order');
        clearApiFailure();
        return true;
      } catch (err) {
        console.log('[GRID] cancel err', id, err && err.message ? err.message : err);
        if (shouldBackoff(err)) markApiFailure(err);
        return false;
      }
    }

    // Match/replace/cancel
    var observedBook = [];
    for (var o of oo) {
      if (S.apiBackoffUntil > Date.now()) break;
      var sO = sideFromOrder(o), rate = rateFromOrder(o);
      if (!rate || (sO !== 'buy' && sO !== 'sell')) continue;
      observedBook.push({ side: sO, px: rate });

      var exact = findWithinTolerance(sO, rate);
      if (exact) { exact.matched = true; continue; }

      var target = findClosestTarget(sO, rate);
      var handled = false;
      if (target) {
        var dist = Math.abs(rate - target.px);
        if (dist <= replaceTriggerAbs) { target.matched = true; continue; }
        var tagKey = target.tag && target.tag.length ? target.tag : (target.side + '@' + target.px.toFixed(6));
        var cooldownMs = Math.max(0, orderPlan.replaceCooldownMs || 0);
        var lastReplace = S.replaceThrottle && S.replaceThrottle[tagKey] || 0;
        var withinCooldown = cooldownMs > 0 && (now2 - lastReplace) < cooldownMs;
        var limitReached = replacedThisCycle >= maxReplacesPerCycle;
        if (withinCooldown || limitReached) { target.matched = true; continue; }
        if (!S.replaceThrottle) S.replaceThrottle = {};
        S.replaceThrottle[tagKey] = now2;
        handled = await replaceOne(o, target);
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
    S.recentPlaced = Array.isArray(S.recentPlaced) ? S.recentPlaced : [];
    S.recentPlaced = S.recentPlaced.filter(function(x){ return now2 - x.ts <= 10 * S.cooldownMs; });
    if (!S.observedCache) S.observedCache = [];
    var cacheHorizonMs = 60_000;
    S.observedCache = S.observedCache.filter(function(x){ return now2 - x.ts <= cacheHorizonMs; });
    for (var ob of observedBook) S.observedCache.push({ side: ob.side, px: ob.px, ts: now2 });

    // Lägg saknade
    var knownSet = new Set(); var knownBySide = { buy: 0, sell: 0 };
    function addKnown(sideAdd, pxAdd) {
      if (!sideAdd || !Number.isFinite(pxAdd) || pxAdd <= 0) return;
      var key = sideAdd + ':' + Number(pxAdd).toFixed(8);
      for (var k of Array.from(knownSet)) {
        var parts = k.split(':'); var kside = parts[0]; var kpx = Number(parts[1]);
        if (kside === sideAdd && Math.abs(kpx - pxAdd) <= matchTolerance) return;
      }
      knownSet.add(key);
      knownBySide[sideAdd] = (knownBySide[sideAdd] || 0) + 1;
    }
    for (var o2 of oo) addKnown(sideFromOrder(o2), rateFromOrder(o2));
    for (var c2 of S.observedCache) addKnown(c2.side, c2.px);
    for (var r2 of (S.recentPlaced || [])) addKnown(r2.side, r2.px);

    var openCount = knownSet.size;
    var maxAdd = Math.max(1, Math.min(orderPlan.maxPerCycle, orderPlan.maxActive));
    var added = 0; var addedSide = { buy: 0, sell: 0 };

    var missing = desired.filter(function(d){ return !d.matched; });
    var coalesce = [];
    for (var d2 of missing) {
      var hit = coalesce.find(function(x){ return x.side === d2.side && Math.abs(x.px - d2.px) <= matchTolerance; });
      if (!hit) coalesce.push(d2);
    }
    missing = coalesce;
    if (missing.length) {
      console.log('[GRID]', S.role, 'saknar', missing.length, 'mål -> försöker lägga');
    } else {
      console.log('[GRID]', S.role, 'inga nya order behövs – alla', desired.length, 'mål matchade av befintliga order');
    }

    var eqNow2 = equity();
    var qtyCap = (S.invMaxPct * Math.max(1e-9, eqNow2)) / Math.max(1e-9, price);
    var absQty = Math.abs(qty);

    for (var w of missing) {
      if (added >= maxAdd) break;
      var isTrim = w.tag && w.tag.indexOf('trim')===0;
      var sideCap = S.levelsPerSide + (isTrim ? S.trimLevels : 0);
      if (((knownBySide[w.side] || 0) + addedSide[w.side]) >= sideCap) continue;
      if ((openCount + added) >= S.maxActiveOrders) break;

      var wouldIncrease = (w.side === 'buy'  && qty >= 0) || (w.side === 'sell' && qty <= 0);
      if (!isTrim && wouldIncrease && absQty >= qtyCap) {
        console.log('[GRID]', S.role, 'skip place: at/over cap', 'absQty=', absQty.toFixed(4), 'cap=', qtyCap.toFixed(4));
        continue;
      }

      var ok = await placeOne(w.side, w.px, w.amt, w.tag);
      if (ok) { added++; addedSide[w.side]++; if (isTrim) trimThrottle[w.tag] = Date.now(); }
      if (orderPlan.placeSpacingMs > 0) await pause(orderPlan.placeSpacingMs);
      if (S.apiBackoffUntil > Date.now()) break;
    }

    if (added > 0) {
      gb.data.pairLedger.notifications = [{ text: 'Rutnät ' + S.role.toUpperCase() + ': +' + added + ' nya order', variant: 'info', persist: false }];
    } else if (missing.length > 0) {
      console.log('[GRID]', S.role, 'kunde inte lägga om saknade order denna cykel');
    } else {
      console.log('[GRID]', S.role, 'cykel klar utan nya order – alla mål redan täckta');
    }

    S.lastDesiredShape = desired.map(function(d){ return { side: d.side, px: d.px }; });
    S.lastCycleTs = now2; S.forceImmediateCycle = false;
  } else if (cycleDue) {
    var cycleSkip = [];
    if (S.paused) cycleSkip.push('paus (' + (S.lastPauseReason || '-') + ')');
    if (apiUnstable) {
      var remainBackoffNow = Math.max(0, (S.apiBackoffUntil || 0) - now2);
      cycleSkip.push('API-backoff ' + Math.round(remainBackoffNow / 1000) + 's kvar');
    }
    if (!cycleSkip.length) cycleSkip.push('okänd orsak');
    console.log('[GRID]', S.role, 'hoppar cykel –', cycleSkip.join('; '));
  } else {
    var blockReasons = [];
    var sinceLast = (Number.isFinite(S.lastCycleTs) && S.lastCycleTs > 0) ? (now2 - S.lastCycleTs) : Infinity;
    if (!cycleDueBase) {
      var remainMs = Math.max(0, (S.cooldownMs || 0) - sinceLast);
      blockReasons.push('cooldown ' + Math.round(remainMs / 1000) + 's kvar');
    }
    if (S.paused) blockReasons.push('paus (' + (S.lastPauseReason || '-') + ')');
    if (apiUnstable) {
      var remainBackoff = Math.max(0, (S.apiBackoffUntil || 0) - now2);
      blockReasons.push('API-backoff ' + Math.round(remainBackoff / 1000) + 's kvar');
    }
    if (!cycleDueBase && Array.isArray(S.lastDesiredShape) && S.lastDesiredShape.length === 0) {
      blockReasons.push('inga planerade nivåer just nu');
    }
    if (!blockReasons.length) blockReasons.push('ingen trigger ännu');
    var blockKey = blockReasons.join('|');
    var shouldLogBlock = (!S._lastBlockKey || S._lastBlockKey !== blockKey || (now2 - (S._lastBlockTs || 0)) > Math.max(15_000, S.cooldownMs || 0));
    if (shouldLogBlock) {
      console.log('[GRID]', S.role, 'ingen ordercykel nu –', blockReasons.join('; '));
      S._lastBlockKey = blockKey;
      S._lastBlockTs = now2;
    }
  }

  // ====== Metrics/Sidebar/Lines ======
  var curEq = equity();
  var curP  = price > 0 ? price : 0;
  var lev = Math.max(1, S.leverage);
  var notionalNow = Math.abs(qty) * curP;

  if (curEq > 0 && curP > 0) {
    var lastPt = S.eqHist && S.eqHist.length ? S.eqHist[S.eqHist.length-1] : null;
    if (!lastPt || now - lastPt.t > Math.max(30_000, S.cooldownMs)) {
      if (!Array.isArray(S.eqHist)) S.eqHist = [];
      S.eqHist.push({ t: now, eq: curEq, p: curP });
      if (S.eqHist.length > 5000) S.eqHist.shift();
    }
  }
  if (curEq > (S.eqPeak || 0)) S.eqPeak = curEq;
  var ddPct = S.eqPeak > 0 ? (1 - curEq / S.eqPeak) * 100 : 0;
  if (ddPct > (S.maxDD || 0)) S.maxDD = ddPct;
  var baseEq = (S.eqHist && S.eqHist.length ? S.eqHist[0].eq : (S.startEquity || curEq));
  var uPnL = curEq - baseEq;
  var roePct = (S.startEquity > 0) ? (curEq / S.startEquity - 1) * 100 : 0;

  var cagrPct = 0;
  if (S.startTs > 0 && curEq > 0 && S.startEquity > 0) {
    var years = Math.max(1/365, (Date.now() - S.startTs) / (365 * 24 * 3600 * 1000));
    var cagr = Math.pow(curEq / S.startEquity, 1 / years) - 1;
    cagrPct = cagr * 100;
  }

  var be = (breakEven > 0 ? breakEven : 0);
  var toBEPct = (be > 0 && curP > 0) ? ((curP - be) / curP) * 100 : 0;

  var lines = [];
  function makeLine(txt, px, color, style){ return { text: txt, price: px, lineStyle: (style||2), lineWidth: 0.8, lineColor: color, bodyBackgroundColor: '#1e1f2b', quantityBackgroundColor: '#13151f' }; }
  if (Number.isFinite(S.center) && S.center > 0) lines.push(makeLine('Rutnätscenter', S.center, S.paused ? '#9aa0b8' : '#78a6ff', 1));
  for (var li=0; li<Math.min(8, orderPlan.levels); li++) {
    var step = (price > 0 ? price : 1) * S.gridStepPct;
    var isNext = li === 0;
    lines.push(makeLine('Köp nivå ' + (li + 1), S.center - (li + 1) * step, S.paused ? '#295c3a' : (isNext ? '#00ff94' : '#53cf77')));
    lines.push(makeLine('Sälj nivå ' + (li + 1), S.center + (li + 1) * step, S.paused ? '#6b2d2d' : (isNext ? '#ff5a5a' : '#cf5353')));
  }
  if (be > 0) lines.push(makeLine('Break-even', be, '#ffd166', 3));
  if (liq > 0) lines.push(makeLine('Likvidation', liq, '#ef476f', 3));
  gb.data.pairLedger.customChartTargets = lines;

  var statusTxt = S.paused ? ('PAUSAD: ' + (S.lastPauseReason || 'okänt')) : (S.apiBackoffUntil > Date.now() ? ('API-VILA (' + Math.ceil((S.apiBackoffUntil - Date.now())/1000) + 's)') : 'AKTIV');
  var lastFillTxt = S.lastFillTs ? new Date(S.lastFillTs).toLocaleTimeString('sv-SE') : '–';
  gb.data.pairLedger.sidebarExtras = [
    { label: 'Roll', value: S.role.toUpperCase() },
    { label: 'Status', value: statusTxt, valueColor: S.paused ? '#ffb4a2' : '#b7f7c1' },
    { label: 'Senaste fyllning', value: lastFillTxt },
    { label: 'Pris', value: (curP).toFixed(6) },
    { label: 'Center', value: S.center.toFixed(6) },
    { label: 'Steg %', value: (S.gridStepPct * 100).toFixed(3) + '%' },
    { label: 'Nivåer/ben', value: String(orderPlan.levels) },
    { label: 'Dyn minBase(mid)', value: String(S.dynamicMinBase || 0) },
    { label: 'MinQtyEff', value: String(S._minQtyEff || 0) },
    { label: 'MinNotEff(USDT)', value: String(S._minNotEff || 0) },
    { label: 'Allokering %', value: (S.allocPct * 100).toFixed(0) + '%' },
    { label: 'Gridbudget (USDT)', value: allocQuote.toFixed(2) },
    { label: 'Reserv mitt %', value: (reservePct * 100).toFixed(0) + '%' },
    { label: 'Reserv mitt (USDT)', value: reserveQuote.toFixed(2) },
    { label: 'Budgetsida köp', value: bidAllocQuote.toFixed(2) },
    { label: 'Budgetsida sälj', value: askAllocQuote.toFixed(2) },
    { label: 'Hävarm', value: String(lev) + 'x' },
    { label: 'Plånbok', value: (Number.isFinite(wallet) ? wallet : 0).toFixed(2) },
    { label: 'Eget kapital (nu)', value: (curEq).toFixed(2) },
    { label: 'Eget kapital (start)', value: (S.startEquity || 0).toFixed(2) },
    { label: 'Orealiserad PnL', value: (curEq - (S.eqHist && S.eqHist.length ? S.eqHist[0].eq : (S.startEquity || curEq))).toFixed(2) },
    { label: 'Realiserad PnL*', value: (S.realizedPnL || 0).toFixed(2) },
    { label: 'ROE %', value: roePct.toFixed(2) + '%' },
    { label: 'CAGR %', value: cagrPct.toFixed(2) + '%' },
    { label: 'Max DD %', value: (S.maxDD || 0).toFixed(2) + '%' },
    { label: 'Notional', value: notionalNow.toFixed(2) },
    { label: 'Marginal använd', value: marginUsed().toFixed(2) },
    { label: 'Marginalkvot %', value: ((curEq > 0) ? (marginUsed() / curEq * 100) : 0).toFixed(2) + '%' },
    { label: 'Likvidationspris', value: (liq || 0).toFixed(6) },
    { label: 'Break-even', value: (breakEven || 0).toFixed(6) },
    { label: 'Avstånd vs BE %', value: (toBEPct).toFixed(2) + '%' },
    { label: 'Öppna order', value: String(Array.isArray(gb.data.openOrders) ? gb.data.openOrders.length : 0) },
    { label: 'API-vila', value: S.apiBackoffUntil > now ? (Math.ceil((S.apiBackoffUntil - now)/1000) + 's') : '-' },
    { label: 'Senaste API-fel', value: S.lastApiError && S.lastApiError.length ? (S.lastApiError.length > 36 ? (S.lastApiError.slice(0, 33) + '…') : S.lastApiError) : '-' },
    { label: 'API-felräknare', value: String(S.apiFailCount || 0) },
  ];

  var desiredTotal = Array.isArray(S.lastDesiredShape) ? S.lastDesiredShape.length : 0;
  console.log('[GRID] role=' + S.role + ' status=' + statusTxt + ' p=' + (price>0?price:0).toFixed(6) +
    ' center=' + S.center.toFixed(6) + ' step%=' + (S.gridStepPct*100).toFixed(3) +
    ' levels=' + orderPlan.levels + ' mål=' + desiredTotal +
    ' minQtyEff=' + minQtyEff + ' minNotEff=' + minNotEff +
    ' dynMinBase=' + dynamicMinBaseMid +
    ' gridBudget=' + allocQuote.toFixed(4) +
    ' reserved=' + reserveQuote.toFixed(4) +
    ' bidBudget=' + bidAllocQuote.toFixed(4) +
    ' askBudget=' + askAllocQuote.toFixed(4)
  );
})();

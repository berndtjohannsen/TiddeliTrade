/**
 * Price updates and Now panel.
 */
export function initPrices(socket, state, log) {
  var nowBuy = document.getElementById('nowBuy');
  var nowSell = document.getElementById('nowSell');
  var nowSpread = document.getElementById('nowSpread');
  var nowTime = document.getElementById('nowTime');
  var nowMarketState = document.getElementById('nowMarketState');
  var nowDelay = document.getElementById('nowDelay');
  var priceUpdateCount = 0;

  socket.on('price_update', function (data) {
    if (!data) {
      log('Stream stopped, prices cleared');
      if (nowBuy) nowBuy.textContent = '—';
      if (nowSell) nowSell.textContent = '—';
      if (nowSpread) nowSpread.textContent = '—';
      if (nowTime) nowTime.textContent = '—';
      if (nowMarketState) nowMarketState.textContent = '—';
      if (nowDelay) nowDelay.textContent = '—';
      priceUpdateCount = 0;
      state.currentBid = null;
      state.currentOffer = null;
      state.currentSpread = null;
      state.currentUpdateTime = null;
      state.currentTrend = null;
      state._prevBid = null;
      state._prevOffer = null;
      return;
    }
    priceUpdateCount++;
    if (priceUpdateCount === 1) {
      log('First price update: bid=' + data.bid + ' offer=' + data.offer);
    } else if (priceUpdateCount % 500 === 0) {
      log('Price update #' + priceUpdateCount);
    }
    if (nowBuy) nowBuy.textContent = data.offer || '—';
    if (nowSell) nowSell.textContent = data.bid || '—';
    if (nowSpread) nowSpread.textContent = data.spread || '—';
    if (nowTime) nowTime.textContent = data.updateTime || '—';
    if (nowMarketState) nowMarketState.textContent = data.marketState || '—';
    if (nowDelay) nowDelay.textContent = (data.marketDelay === '1' ? 'Delayed' : data.marketDelay === '0' ? 'Live' : (data.marketDelay || '—'));
    var bid = typeof data.bid === 'number' ? data.bid : parseFloat(data.bid);
    var offer = typeof data.offer === 'number' ? data.offer : parseFloat(data.offer);
    if (isNaN(bid)) bid = null;
    if (isNaN(offer)) offer = null;
    if (state._prevBid != null && state._prevOffer != null && bid != null && offer != null) {
      var mid = (bid + offer) / 2;
      var prevMid = (state._prevBid + state._prevOffer) / 2;
      state.currentTrend = mid > prevMid ? 'up' : mid < prevMid ? 'down' : 'flat';
    }
    state._prevBid = bid;
    state._prevOffer = offer;
    state.currentBid = bid;
    state.currentOffer = offer;
    state.currentSpread = typeof data.spread === 'number' ? data.spread : parseFloat(data.spread);
    if (isNaN(state.currentSpread)) state.currentSpread = null;
    state.currentUpdateTime = data.updateTime || null;
    var nowTrend = document.getElementById('nowTrend');
    if (nowTrend) {
      var t = state.currentTrend;
      nowTrend.textContent = t === 'up' ? '\u2191 Up' : t === 'down' ? '\u2193 Down' : t === 'flat' ? '\u2192 Flat' : '—';
      nowTrend.className = 'font-mono text-xs' + (t === 'up' ? ' text-emerald-500' : t === 'down' ? ' text-red-500' : ' text-slate-500');
    }
  });

  socket.on('disconnect', function () {
    if (nowBuy) nowBuy.textContent = '—';
    if (nowSell) nowSell.textContent = '—';
    if (nowSpread) nowSpread.textContent = '—';
    if (nowTime) nowTime.textContent = '—';
    if (nowMarketState) nowMarketState.textContent = '—';
    if (nowDelay) nowDelay.textContent = '—';
    state.currentBid = null;
    state.currentOffer = null;
    state.currentSpread = null;
    state.currentUpdateTime = null;
    state.currentTrend = null;
    state._prevBid = null;
    state._prevOffer = null;
    var nowTrend = document.getElementById('nowTrend');
    if (nowTrend) { nowTrend.textContent = '—'; nowTrend.className = 'font-mono text-xs text-slate-500'; }
  });
}

/** @decorator */

import ppp from '../ppp.js';
import {
  BROKERS,
  EXCHANGE,
  INSTRUMENT_DICTIONARY,
  TRADER_DATUM
} from '../lib/const.js';
import { debounce, later } from '../lib/ppp-decorators.js';
import {
  GlobalTraderDatum,
  Trader,
  TraderDatum,
  TraderEventDatum
} from './common-trader.js';
import { isJWTTokenExpired } from '../lib/ppp-crypto.js';
import {
  AuthorizationError,
  TradingError,
  UTEXBlockError
} from '../lib/ppp-errors.js';
import { OperationType } from '../vendor/tinkoff/definitions/operations.js';

export function generateTraceId() {
  let result = '';

  for (let t = 0; t < 16; t++)
    result += '0123456789abcdef'[Math.floor(16 * Math.random())];

  return result;
}

class UtexMarginStocksTraderDatum extends TraderDatum {
  filter(data, instrument, source) {
    return (
      [EXCHANGE.US, EXCHANGE.UTEX_MARGIN_STOCKS, EXCHANGE.SPBX].indexOf(
        source?.instrument?.exchange
      ) !== -1
    );
  }

  async subscribe(source, field, datum) {
    await this.trader.establishWebSocketConnection();

    return super.subscribe(source, field, datum);
  }
}

class UtexMarginStocksTraderGlobalDatum extends GlobalTraderDatum {
  // Do not clear.
  // The trader sends everything right after connection establishment.
  // These datums have no explicit on-demand subscriptions.
  // We have to explicitly feed the first subscribed source with the saved value.
  // The same goes for other global datums.
  doNotClearValue = true;

  firstReferenceAdded(source, field, datum) {
    if (this.value.size) {
      for (const [key, data] of this.value) {
        if (this.filter(data, source, key, datum)) {
          source[field] =
            this[datum](data, source, key) ?? this.emptyValue(datum) ?? '—';
        }
      }
    }
  }

  async subscribe(source, field, datum) {
    await this.trader.establishWebSocketConnection();

    return super.subscribe(source, field, datum);
  }
}

class TimelineDatum extends UtexMarginStocksTraderGlobalDatum {
  valueKeyForData(data) {
    return `${data.exchangeOrderId}|${data.moment}|${data.side}|${data.tradeQty}|${data.tradePrice}`;
  }

  [TRADER_DATUM.TIMELINE_ITEM](data) {
    const instrument = this.trader.symbols.get(data.symbolId);
    const commissionRate = this.trader.document.commissionRate ?? 0.04;
    const commission =
      ((data.price / 1e8) * data.tradeQty * instrument.lot * commissionRate) /
      100;

    return {
      instrument,
      // UTEX trades are independent
      operationId: `${data.exchangeOrderId}|${data.moment}|${data.side}|${data.tradeQty}|${data.tradePrice}`,
      accruedInterest: null,
      commission,
      parentId: data.exchangeOrderId,
      symbol: instrument.symbol,
      type:
        data.side.toLowerCase() === 'buy'
          ? OperationType.OPERATION_TYPE_BUY
          : OperationType.OPERATION_TYPE_SELL,
      exchange: EXCHANGE.UTEX_MARGIN_STOCKS,
      quantity: data.tradeQty / instrument.lot,
      price: data.tradePrice / 1e8,
      createdAt: new Date(data.moment / 1e6).toISOString()
    };
  }
}

class ActiveOrderDatum extends UtexMarginStocksTraderGlobalDatum {
  valueKeyForData(data) {
    return data.exchangeOrderId;
  }

  [TRADER_DATUM.ACTIVE_ORDER](order) {
    const instrument = this.trader.symbols.get(order.symbolId);

    if (instrument) {
      return {
        instrument,
        orderId: order.exchangeOrderId,
        symbol: instrument.symbol,
        exchange: EXCHANGE.UTEX_MARGIN_STOCKS,
        orderType: order.type.toLowerCase(),
        side: order.side.toLowerCase(),
        status: this.trader.getUTEXOrderStatus(order),
        placedAt: new Date().toISOString(),
        endsAt: null,
        quantity: parseInt(order.qty) / instrument.lot,
        filled: parseInt(order.filled),
        price: parseFloat(order.price)
      };
    }
  }
}

class PositionDatum extends UtexMarginStocksTraderGlobalDatum {
  @debounce(1000)
  dispatchDelayedEstimateEvent() {
    this.trader.traderEvent({ event: 'estimate' });
  }

  filter(data, source, key, datum) {
    if (datum !== TRADER_DATUM.POSITION) {
      if (data.isBalance) {
        return data.position.currency === source.getAttribute('balance');
      }

      return data.position?.symbolId === source.instrument?.utexSymbolID;
    } else {
      return true;
    }
  }

  valueKeyForData(data) {
    if (data.isBalance) {
      // USDT
      return data.position.currency;
    } else {
      return data.position.symbolId;
    }
  }

  #getBalanceSize(data) {
    let profit = 0;

    for (const [, { isBalance, position }] of this.trader.positions) {
      if (!isBalance) {
        profit += +position.netRealizedPnl / 1e8;
      }
    }

    return +data.amount + profit;
  }

  recalculateBalance() {
    const balancePosition = this.value.get('USDT');

    if (balancePosition) {
      this.dataArrived(balancePosition);
      this.dispatchDelayedEstimateEvent();
    }
  }

  [TRADER_DATUM.POSITION](data) {
    if (data.isBalance) {
      return {
        symbol: data.position.currency,
        lot: 1,
        exchange: EXCHANGE.UTEX_MARGIN_STOCKS,
        isCurrency: true,
        isBalance: true,
        size: this.#getBalanceSize(data.position),
        accountId: null
      };
    } else {
      const instrument = this.trader.symbols.get(data.position.symbolId);

      if (instrument) {
        return {
          instrument,
          symbol: instrument.symbol,
          lot: instrument.lot,
          exchange: instrument.exchange,
          averagePrice: +data.position.averageInitialPrice / 1e8,
          isCurrency: false,
          isBalance: false,
          size: +data.position.qty / instrument.lot,
          accountId: null
        };
      }
    }
  }

  [TRADER_DATUM.POSITION_SIZE](data) {
    if (data.isBalance) {
      return this.#getBalanceSize(data.position);
    } else {
      const instrument = this.trader.symbols.get(data.position.symbolId);

      return +data.position.qty / instrument.lot;
    }
  }

  [TRADER_DATUM.POSITION_AVERAGE](data) {
    if (!data.isBalance) {
      return +data.position.averageInitialPrice / 1e8;
    }
  }
}

// noinspection JSUnusedGlobalSymbols
/**
 * @typedef {Object} UtexMarginStocksTrader
 */
class UtexMarginStocksTrader extends Trader {
  #pendingAccessTokenRequest;

  accessToken;

  #heartbeatInterval;

  #pendingConnection;

  connection;

  leftMarginBP = 0;

  usedMarginBP = 0;

  #symbols = new Map();

  get symbols() {
    return this.#symbols;
  }

  get orders() {
    return Array.from(this.datums[TRADER_DATUM.ACTIVE_ORDER].value);
  }

  get positions() {
    return Array.from(this.datums[TRADER_DATUM.POSITION].value);
  }

  constructor(document) {
    super(document, [
      {
        type: TimelineDatum,
        datums: [TRADER_DATUM.TIMELINE_ITEM]
      },
      {
        type: ActiveOrderDatum,
        datums: [TRADER_DATUM.ACTIVE_ORDER]
      },
      {
        type: PositionDatum,
        datums: [
          TRADER_DATUM.POSITION,
          TRADER_DATUM.POSITION_SIZE,
          TRADER_DATUM.POSITION_AVERAGE
        ]
      },
      {
        type: TraderEventDatum,
        datums: [TRADER_DATUM.TRADER]
      }
    ]);
  }

  instrumentCacheCallback(instrument) {
    if (typeof instrument.utexSymbolID === 'number') {
      this.#symbols.set(instrument.utexSymbolID, instrument);
    }
  }

  async ensureAccessTokenIsOk() {
    try {
      if (isJWTTokenExpired(this.accessToken)) this.accessToken = void 0;

      if (typeof this.accessToken === 'string') return;

      if (this.#pendingAccessTokenRequest) {
        await this.#pendingAccessTokenRequest;
      } else {
        this.#pendingAccessTokenRequest = new Promise(
          async (resolve, reject) => {
            let savedAccessToken = sessionStorage.getItem(
              `utex-access-token-${this.document._id}`
            );
            let savedRefreshToken = sessionStorage.getItem(
              `utex-refresh-token-${this.document._id}`
            );
            let tokensResponse;

            if (isJWTTokenExpired(savedAccessToken)) {
              if (isJWTTokenExpired(savedRefreshToken)) {
                const tokensRequest = await fetch(
                  new URL(
                    'fetch',
                    ppp.keyVault.getKey('service-machine-url')
                  ).toString(),
                  {
                    cache: 'reload',
                    method: 'POST',
                    body: JSON.stringify({
                      method: 'POST',
                      url: 'https://api.utex.io/rest/grpc/com.unitedtraders.luna.sessionservice.api.sso.SsoService.authorizeByFirstFactor',
                      headers: {
                        Origin: 'https://utex.io',
                        Referer: 'https://utex.io/',
                        'User-Agent': navigator.userAgent,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({
                        realm: 'aurora',
                        clientId: 'utexweb',
                        loginOrEmail: this.document.broker.login,
                        password: this.document.broker.password,
                        product: 'UTEX',
                        locale: 'ru'
                      })
                    })
                  }
                );

                tokensResponse = await tokensRequest.json();
              } else {
                // Refresh token is OK - try to refresh access token.
                const refreshAuthRequest = await fetch(
                  new URL(
                    'fetch',
                    ppp.keyVault.getKey('service-machine-url')
                  ).toString(),
                  {
                    cache: 'reload',
                    method: 'POST',
                    body: JSON.stringify({
                      method: 'POST',
                      url: 'https://api.utex.io/rest/grpc/com.unitedtraders.luna.sessionservice.api.sso.SsoService.refreshAuthorization',
                      headers: {
                        Origin: 'https://utex.io',
                        Referer: 'https://utex.io/',
                        'User-Agent': navigator.userAgent,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({
                        realm: 'aurora',
                        clientId: 'utexweb',
                        refreshToken: savedRefreshToken
                      })
                    })
                  }
                );

                tokensResponse = await refreshAuthRequest.json();

                if (tokensResponse.accessToken && tokensResponse.refreshToken) {
                  tokensResponse.tokens = {
                    accessToken: tokensResponse.accessToken,
                    refreshToken: tokensResponse.refreshToken
                  };
                }
              }

              if (tokensResponse.tokens) {
                savedAccessToken = tokensResponse.tokens.accessToken;
                savedRefreshToken = tokensResponse.tokens.refreshToken;

                sessionStorage.setItem(
                  `utex-access-token-${this.document._id}`,
                  savedAccessToken
                );
                sessionStorage.setItem(
                  `utex-refresh-token-${this.document._id}`,
                  savedRefreshToken
                );
              }
            } else {
              // Access token is OK.
              tokensResponse = {
                tokens: {
                  accessToken: savedAccessToken,
                  refreshToken: savedRefreshToken
                }
              };
            }

            if (
              !tokensResponse?.tokens ||
              /NoActiveSessionException|InvalidCredentialsException/i.test(
                tokensResponse?.type
              )
            ) {
              sessionStorage.removeItem(
                `utex-access-token-${this.document._id}`
              );
              sessionStorage.removeItem(
                `utex-refresh-token-${this.document._id}`
              );

              reject(new AuthorizationError({ details: tokensResponse }));
            } else if (/BlockingException/i.test(tokensResponse?.type)) {
              reject(new UTEXBlockError({ details: tokensResponse }));
            } else if (tokensResponse.tokens?.accessToken) {
              this.accessToken = tokensResponse.tokens.accessToken;

              resolve(this.accessToken);
            }
          }
        ).then(() => (this.#pendingAccessTokenRequest = void 0));

        await this.#pendingAccessTokenRequest;
      }
    } catch (e) {
      console.error(e);

      this.#pendingAccessTokenRequest = void 0;

      if (e instanceof AuthorizationError) {
        throw e;
      }

      return new Promise((resolve) => {
        setTimeout(async () => {
          await this.ensureAccessTokenIsOk();

          resolve();
        }, Math.max(this.document.reconnectTimeout ?? 1000, 1000));
      });
    }
  }

  async establishWebSocketConnection(reconnect) {
    await this.ensureAccessTokenIsOk();

    if (this.connection?.readyState === WebSocket.OPEN) {
      this.#pendingConnection = void 0;

      return this.connection;
    } else if (this.#pendingConnection) {
      return this.#pendingConnection;
    } else {
      return (this.#pendingConnection = new Promise((resolve) => {
        if (!reconnect && this.connection) {
          resolve(this.connection);
        } else {
          this.connection = new WebSocket('wss://ususdt-api-margin.utex.io/ws');

          this.connection.onopen = async () => {
            if (reconnect) {
              await this.resubscribe();
            }

            this.connection.send('{"t":0,"d":{}}');

            clearInterval(this.#heartbeatInterval);

            this.#heartbeatInterval = setInterval(() => {
              if (this.connection.readyState === WebSocket.OPEN) {
                this.connection.send('{"t":8,"d":{}}');
              }
            }, 2000);

            resolve(this.connection);
          };

          this.connection.onclose = async ({ code }) => {
            await later(Math.max(this.document.reconnectTimeout ?? 1000, 1000));

            this.accessToken = void 0;
            this.#pendingAccessTokenRequest = void 0;

            await this.ensureAccessTokenIsOk();

            this.#pendingConnection = void 0;

            clearInterval(this.#heartbeatInterval);

            await this.establishWebSocketConnection(true);
          };

          this.connection.onerror = () => this.connection.close();

          this.connection.onmessage = async ({ data }) => {
            const payload = JSON.parse(data);

            if (payload.t === 12) {
              await this.ensureAccessTokenIsOk();

              this.connection.send(
                JSON.stringify({
                  t: 1,
                  d: {
                    topic:
                      'com.unitedtraders.luna.utex.protocol.mobile.MobileHistoryService.subscribePendingOrders',
                    i: 1,
                    accessToken: this.accessToken,
                    metadata: {
                      traceId: generateTraceId(),
                      spanId: generateTraceId()
                    },
                    parameters: {}
                  }
                })
              );

              this.connection.send(
                JSON.stringify({
                  t: 1,
                  d: {
                    topic:
                      'com.unitedtraders.luna.utex.protocol.mobile.MobileHistoryService.subscribeCompletedOrders',
                    i: 2,
                    accessToken: this.accessToken,
                    metadata: {
                      traceId: generateTraceId(),
                      spanId: generateTraceId()
                    },
                    parameters: {}
                  }
                })
              );

              this.connection.send(
                JSON.stringify({
                  t: 1,
                  d: {
                    topic:
                      'com.unitedtraders.luna.utex.protocol.mobile.MarginUserPositionService.subscribeMarginPositions',
                    i: 3,
                    accessToken: this.accessToken,
                    metadata: {
                      traceId: generateTraceId(),
                      spanId: generateTraceId()
                    },
                    parameters: {}
                  }
                })
              );

              this.connection.send(
                JSON.stringify({
                  t: 1,
                  d: {
                    topic:
                      'com.unitedtraders.luna.utex.protocol.mobile.MobileMarginalTradingBalanceService.subscribeTradingBalanceUpdateWithSnapshot',
                    i: 4,
                    accessToken: this.accessToken,
                    metadata: {
                      traceId: generateTraceId(),
                      spanId: generateTraceId()
                    },
                    parameters: {
                      market: 'UsEquitiesUsdt'
                    }
                  }
                })
              );

              this.connection.send(
                JSON.stringify({
                  t: 1,
                  d: {
                    topic:
                      'com.unitedtraders.luna.utex.protocol.mobile.MobileHistoryService.subscribeAllFilledExecutions',
                    i: 5,
                    accessToken: this.accessToken,
                    metadata: {
                      traceId: generateTraceId(),
                      spanId: generateTraceId()
                    },
                    parameters: {
                      depth: 100
                    }
                  }
                })
              );

              // Liquidation threshold
              // this.connection.send(
              //   JSON.stringify({
              //     t: 1,
              //     d: {
              //       topic:
              //         'com.unitedtraders.luna.utex.protocol.mobile.MobileMarginalTradingBalanceService.subscribeMaintenanceBalanceWithSnapshot',
              //       i: 6,
              //       accessToken: this.accessToken,
              //       metadata: {
              //         traceId: generateTraceId(),
              //         spanId: generateTraceId()
              //       },
              //       parameters: {
              //         market: 'UsEquitiesUsdt'
              //       }
              //     }
              //   })
              // );
            } else if (payload.t === 7) {
              const d = payload.d?.d;

              if (Array.isArray(d?.orders)) {
                for (const order of d.orders) {
                  if (payload.d?.i === 1) {
                    this.datums[TRADER_DATUM.ACTIVE_ORDER].dataArrived(order);
                  }
                }
              }

              if (d.marginBuyingPower) {
                this.leftMarginBP = +d.marginBuyingPower.left / 1e8;
                this.usedMarginBP = +d.marginBuyingPower.used / 1e8;

                this.traderEvent({ event: 'estimate' });
              }

              if (Array.isArray(d.positions)) {
                for (const position of d.positions) {
                  this.datums[TRADER_DATUM.POSITION].dataArrived({
                    isBalance: false,
                    position
                  });

                  // Update balance here, count positions, P&L.
                  this.datums[TRADER_DATUM.POSITION].recalculateBalance();
                }
              }

              if (payload.d?.i === 4) {
                const balance = payload.d?.d?.value;

                if (typeof balance === 'object') {
                  this.datums[TRADER_DATUM.POSITION].dataArrived({
                    isBalance: true,
                    position: balance
                  });
                }
              }

              if (payload.d?.i === 5) {
                if (Array.isArray(d.executions)) {
                  for (const item of d.executions.sort(
                    (a, b) =>
                      new Date(a.moment / 1000) - new Date(b.moment / 1000)
                  )) {
                    this.datums[TRADER_DATUM.TIMELINE_ITEM].dataArrived(
                      item,
                      this.#symbols.get(item.symbolId)
                    );
                  }
                }
              }
            }
          };
        }
      }));
    }
  }

  getUTEXOrderStatus(order) {
    switch (order.status) {
      case 'NEW':
      case 'PART_FILLED':
        return 'working';
      case 'FILLED':
        return 'filled';
      case 'PART_CANCELED':
      case 'CANCELED':
        return 'canceled';
      case 'REJECTED':
        return 'rejected';
      case 'TRIGGERED':
        return 'triggered';
    }

    return 'unspecified';
  }

  getExchange() {
    return EXCHANGE.UTEX_MARGIN_STOCKS;
  }

  getExchangeForDBRequest() {
    return EXCHANGE.UTEX_MARGIN_STOCKS;
  }

  getDictionary() {
    return INSTRUMENT_DICTIONARY.UTEX_MARGIN_STOCKS;
  }

  getBroker() {
    return BROKERS.UTEX;
  }

  getInstrumentIconUrl(instrument) {
    if (!instrument) {
      return 'static/instruments/unknown.svg';
    }

    if (instrument.symbol === 'PRN') {
      return 'static/instruments/stocks/us/PRN@US.svg';
    }

    if (instrument.currency === 'USD' || instrument.currency === 'USDT') {
      return `static/instruments/stocks/us/${instrument.symbol
        .replace(' ', '-')
        .replace('/', '-')}.svg`;
    }

    return super.getInstrumentIconUrl(instrument);
  }

  async modifyLimitOrders({ instrument, side, value }) {
    await this.ensureAccessTokenIsOk();

    for (const [, o] of this.orders) {
      const status = this.getUTEXOrderStatus(o);
      const orderInstrument = this.#symbols.get(o.symbolId);

      if (
        status === 'working' &&
        (o.side.toLowerCase() === side || side === 'all')
      ) {
        if (
          instrument &&
          !this.instrumentsAreEqual(instrument, orderInstrument)
        )
          continue;

        if (orderInstrument?.minPriceIncrement > 0) {
          const price = +this.fixPrice(
            orderInstrument,
            +o.price + orderInstrument.minPriceIncrement * value
          );

          o.instrument = orderInstrument;
          o.orderType = o.type.toLowerCase();
          o.orderId = o.exchangeOrderId;

          await this.cancelLimitOrder(o);
          await this.placeLimitOrder({
            instrument: orderInstrument,
            price,
            quantity: (+o.qty - +o.filled) / orderInstrument.lot,
            direction: o.side
          });
        }
      }
    }
  }

  async cancelAllLimitOrders({ instrument, filter } = {}) {
    await this.ensureAccessTokenIsOk();

    for (const [, o] of this.orders) {
      const status = this.getUTEXOrderStatus(o);
      const orderInstrument = this.#symbols.get(o.symbolId);

      if (orderInstrument && status === 'working') {
        if (
          instrument &&
          !this.instrumentsAreEqual(instrument, orderInstrument)
        )
          continue;

        if (filter === 'buy' && o.side.toLowerCase() !== 'buy') {
          continue;
        }

        if (filter === 'sell' && o.side.toLowerCase() !== 'sell') {
          continue;
        }

        o.instrument = orderInstrument;
        o.orderType = o.type.toLowerCase();
        o.orderId = o.exchangeOrderId;

        await this.cancelLimitOrder(o);
      }
    }
  }

  async cancelLimitOrder(order) {
    if (order.orderType === 'limit') {
      await this.ensureAccessTokenIsOk();

      const request = await fetch(
        new URL('fetch', ppp.keyVault.getKey('service-machine-url')).toString(),
        {
          cache: 'reload',
          method: 'POST',
          body: JSON.stringify({
            method: 'POST',
            url: 'https://ususdt-api-margin.utex.io/rest/grpc/com.unitedtraders.luna.utex.protocol.mobile.MobileExecutionService.cancelOrderByExchangeOrderId',
            body: JSON.stringify({
              exchangeOrderId: order.orderId,
              orderSymbolId: order.instrument.utexSymbolID
            }),
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json;charset=UTF-8',
              'User-Agent': navigator.userAgent,
              Origin: 'https://margin.utex.io',
              Referer: 'https://margin.utex.io/',
              'x-b3-spanid': generateTraceId(),
              'x-b3-traceid': generateTraceId()
            }
          })
        }
      );

      if (request.status === 200) return {};
      else {
        throw new TradingError({
          details: await (await request).json()
        });
      }
    }
  }

  async placeLimitOrder({ instrument, price, quantity, direction }) {
    await this.ensureAccessTokenIsOk();

    const orderRequest = await fetch(
      new URL('fetch', ppp.keyVault.getKey('service-machine-url')).toString(),
      {
        cache: 'reload',
        method: 'POST',
        body: JSON.stringify({
          method: 'POST',
          url: 'https://ususdt-api-margin.utex.io/rest/grpc/com.unitedtraders.luna.utex.protocol.mobile.MobileExecutionService.createLimitOrder',
          body: JSON.stringify({
            price: Math.round(
              +this.fixPrice(instrument, price) * 1e8
            ).toString(),
            side: direction.toUpperCase(),
            qty: (quantity * instrument.lot).toString(),
            symbolId: instrument.utexSymbolID,
            tif: 'GTC'
          }),
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json;charset=UTF-8',
            'User-Agent': navigator.userAgent,
            Origin: 'https://margin.utex.io',
            Referer: 'https://margin.utex.io/',
            'x-b3-spanid': generateTraceId(),
            'x-b3-traceid': generateTraceId()
          }
        })
      }
    );

    const order = await orderRequest.json();

    if (orderRequest.status !== 200) {
      throw new TradingError({
        details: order
      });
    } else {
      return {
        orderId: order.orderId
      };
    }
  }

  async placeMarketOrder({ instrument, quantity, direction }) {
    await this.ensureAccessTokenIsOk();

    const orderRequest = await fetch(
      new URL('fetch', ppp.keyVault.getKey('service-machine-url')).toString(),
      {
        cache: 'reload',
        method: 'POST',
        body: JSON.stringify({
          method: 'POST',
          url: 'https://ususdt-api-margin.utex.io/rest/grpc/com.unitedtraders.luna.utex.protocol.mobile.MobileExecutionService.createMarketOrder',
          body: JSON.stringify({
            qty: (quantity * instrument.lot).toString(),
            side: direction.toUpperCase(),
            symbolId: instrument.utexSymbolID
          }),
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json;charset=UTF-8',
            'User-Agent': navigator.userAgent,
            Origin: 'https://margin.utex.io',
            Referer: 'https://margin.utex.io/',
            'x-b3-spanid': generateTraceId(),
            'x-b3-traceid': generateTraceId()
          }
        })
      }
    );

    const order = await orderRequest.json();

    if (orderRequest.status !== 200) {
      throw new TradingError({
        details: order
      });
    } else {
      return {
        orderId: order.orderId
      };
    }
  }

  async estimate(instrument, price, quantity) {
    const commissionRate = this.document?.commissionRate ?? 0.04;
    const commission =
      (price * quantity * instrument.lot * commissionRate) / 100;
    const marginBPQuantity = Math.trunc(
      this.leftMarginBP / price / instrument.lot
    );

    let marginSellingPowerQuantity = marginBPQuantity;
    let marginBuyingPowerQuantity = marginBPQuantity;

    for (const [, { isBalance, position }] of this.positions) {
      if (isBalance) {
        continue;
      }

      const positionInstrument = this.#symbols.get(position.symbolId);

      if (
        positionInstrument &&
        this.instrumentsAreEqual(positionInstrument, instrument)
      ) {
        const quantity = +position.qty;

        if (quantity > 0) {
          marginSellingPowerQuantity += quantity / instrument.lot;
        } else if (quantity < 0) {
          marginBuyingPowerQuantity -= quantity / instrument.lot;
        }
      }
    }

    return {
      marginSellingPowerQuantity,
      marginBuyingPowerQuantity,
      sellingPowerQuantity: null,
      buyingPowerQuantity: null,
      commission
    };
  }

  async formatError(instrument, error) {
    if (error instanceof AuthorizationError) {
      return 'Ошибка авторизации. Попробуйте обновить страницу.';
    }

    if (error instanceof UTEXBlockError) {
      return 'Найдена активная блокировка (должна быть снята в течение часа).';
    }

    const { details } = error;

    if (details?.error === 'Unauthorized') {
      return 'Не удалось авторизоваться.';
    }

    if (details?.details) {
      if (details?.type === 'aurora.grpc.luna.exception.RuntimeException') {
        return 'Неизвестная ошибка на стороне UTEX.';
      }

      const rejectReason = details.details.attributes?.rejectReason;

      if (rejectReason === 'LowAverageDayVolumeOnInstrument') {
        return 'Низколиквидный инструмент, заявка отклонена UTEX.';
      } else if (
        rejectReason === 'NotEnoughBP' ||
        rejectReason === 'NotEnoughNightBP'
      ) {
        return 'Недостаточно покупательской способности для открытия позиции.';
      } else if (rejectReason === 'MarketIsNotAvailable') {
        return 'Рынок сейчас закрыт.';
      }
    }
  }
}

export default UtexMarginStocksTrader;

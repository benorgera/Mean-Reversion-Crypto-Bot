'use strict';

let ccxt = require('ccxt'),
  express = require('express'),
  app = express(),
  body_parser = require('body-parser'),
  exphbs  = require('express-handlebars'),
  heartbeats = require('heartbeats'),
  request = require('request'),
  mongo_client = require('mongodb').MongoClient,
  url = 'mongodb://localhost:3000/algobot',
  heart,
  db,
  markets = [],
  exchanges = [],
  fs = require('fs'),
  log = new (require('log'))('debug', fs.createWriteStream(__dirname + '/logs/' + new Date() + '.log')),
  SETTINGS = {
    MEAN_PERIOD: 60*60*24*5,
    VOLUME_PERIOD: 60*60*24*7,
    VOLUME_HIGH: 0.37,
   // VOLUME_LOW: 0.06, if vol is within or below this percentage (+ or -), and price is low, buy (for now this is 0%)
    REV_TOL: 0.065, //while looking for an up/down trend, a change of this amount or less in the wrong direction is acceptable
    FIRST_SELL: {
        gain: 0.1,
        sell: 0.3
    },
    SECOND_SELL: {
        gain: 0.3,
        sell: 0.5
    },
    THIRD_SELL: {
        gain: 0.8,
        sell: 0.8  //sell at peak above gain
    },
    FIRST_BUY: {
        drop: 0.12,
        buy: 0.3 
    },
    SECOND_BUY: {
        drop: 0.15,
        buy: 0.65  //buy at peak below gain
    }
  };

const SIT = 0.3, //keep 30% in btc at all time
  SIMULATON_PERIOD = 60*60*24*14,
  VOLUME_UNIT_INTERVAL = 60*60*24, //volume is stored over one day
  POLL_INTERVAL = 2,  //update once every 2 seconds
  EXCHANGES = {
    BITTREX: 0
  },
  FAST = true,  //30 min tick interval is fastest
  EXCHANGES_VOLUME_UNIT_INTERVALS = [ VOLUME_UNIT_INTERVAL ], //when data is polled, this is the volume unit returned
  EXCHANGES_FEES = [ 0.0025 ];

mongo_client.connect(url, (err, data) => {
    if (err) error(err);

    log_('Database created');
    db = data.db('algobot');
    startup_bot();
});

app.use(body_parser.json());
app.use(express.static('static'));

app.engine('handlebars', exphbs({
    defaultLayout: 'admin',
    layoutsDir: __dirname + '/views'
}));
app.set('view engine', 'handlebars');

app.get('/admin', (req, res) => {
    var market_index = req.query.index ? parseInt(req.query.index.split('?')[0]) : 0;

    if (invalid_market_index(market_index))
        return error('Invalid admin request')

    log_('Admin page loaded for market: ' + markets[market_index].name);

    get_debug_data(market_index, (data) => {
        res.render('admin', { debug: JSON.stringify(data), SETTINGS: JSON.stringify(SETTINGS) });
    });
});

app.post('/admin/recalc', (req, res) => {
    if (typeof req.body.SETTINGS.VOLUME_HIGH != 'number' || req.body.SETTINGS.VOLUME_HIGH <= 0 || req.body.SETTINGS.VOLUME_HIGH > 1 || invalid_market_index(req.body.market_index)
      || typeof req.body.SETTINGS.MEAN_PERIOD != 'number' || req.body.SETTINGS.MEAN_PERIOD <= VOLUME_UNIT_INTERVAL || req.body.SETTINGS.MEAN_PERIOD > SIMULATON_PERIOD
      || typeof req.body.SETTINGS.VOLUME_PERIOD != 'number' || req.body.SETTINGS.VOLUME_PERIOD <= VOLUME_UNIT_INTERVAL || req.body.SETTINGS.VOLUME_PERIOD > SIMULATON_PERIOD)
        return error('Invalid recalculate request');

    SETTINGS.VOLUME_HIGH = req.body.SETTINGS.VOLUME_HIGH;
    SETTINGS.VOLUME_PERIOD = req.body.SETTINGS.VOLUME_PERIOD;
    SETTINGS.MEAN_PERIOD = req.body.SETTINGS.MEAN_PERIOD;

    log_('Admin page recalculated with VOLUME_HIGH: ' + SETTINGS.VOLUME_HIGH + ', VOLUME_PERIOD: ' + SETTINGS.VOLUME_PERIOD + ', MEAN_PERIOD: ' + SETTINGS.MEAN_PERIOD);

    load_market(req.body.market_index, () => {
        get_debug_data(req.body.market_index, (data) => {
            res.json(data.steady_mean);
            load_historical_markets(() => {}, req.body.market_index);
        });
    });
});

app.post('/admin/simulate', (req, res) => {
    if (typeof req.body.SETTINGS.REV_TOL != 'number' || req.body.SETTINGS.REV_TOL <= 0 || req.body.SETTINGS.REV_TOL > 1 || invalid_market_index(req.body.market_index)
      || typeof req.body.SETTINGS.FIRST_SELL.gain != 'number' || req.body.SETTINGS.FIRST_SELL.gain <= 0 || req.body.SETTINGS.FIRST_SELL.gain > 1
      || typeof req.body.SETTINGS.FIRST_SELL.sell != 'number' || req.body.SETTINGS.FIRST_SELL.sell <= 0 || req.body.SETTINGS.FIRST_SELL.sell > 1
      || typeof req.body.SETTINGS.SECOND_SELL.gain != 'number' || req.body.SETTINGS.SECOND_SELL.gain <= 0 || req.body.SETTINGS.SECOND_SELL.gain > 1
      || typeof req.body.SETTINGS.SECOND_SELL.sell != 'number' || req.body.SETTINGS.SECOND_SELL.sell <= 0 || req.body.SETTINGS.SECOND_SELL.sell > 1
      || typeof req.body.SETTINGS.THIRD_SELL.gain != 'number' || req.body.SETTINGS.THIRD_SELL.gain <= 0 || req.body.SETTINGS.THIRD_SELL.gain > 1
      || typeof req.body.SETTINGS.THIRD_SELL.sell != 'number' || req.body.SETTINGS.THIRD_SELL.sell <= 0 || req.body.SETTINGS.THIRD_SELL.sell > 1
      || typeof req.body.SETTINGS.FIRST_BUY.drop != 'number' || req.body.SETTINGS.FIRST_BUY.drop <= 0 || req.body.SETTINGS.FIRST_BUY.drop > 1
      || typeof req.body.SETTINGS.FIRST_BUY.buy != 'number' || req.body.SETTINGS.FIRST_BUY.buy <= 0 || req.body.SETTINGS.FIRST_BUY.buy > 1
      || typeof req.body.SETTINGS.SECOND_BUY.drop != 'number' || req.body.SETTINGS.SECOND_BUY.drop <= 0 || req.body.SETTINGS.SECOND_BUY.drop > 1
      || typeof req.body.SETTINGS.SECOND_BUY.buy != 'number' || req.body.SETTINGS.SECOND_BUY.buy <= 0 || req.body.SETTINGS.SECOND_BUY.buy > 1)
        return error('Invalid simulate request');

    SETTINGS.REV_TOL = req.body.SETTINGS.REV_TOL;
    SETTINGS.FIRST_SELL = req.body.SETTINGS.FIRST_SELL;
    SETTINGS.SECOND_SELL = req.body.SETTINGS.SECOND_SELL;
    SETTINGS.THIRD_SELL = req.body.SETTINGS.THIRD_SELL;
    SETTINGS.FIRST_BUY = req.body.SETTINGS.FIRST_BUY;
    SETTINGS.SECOND_BUY = req.body.SETTINGS.SECOND_BUY;

    log_('Simulation with FIRST_BUY: ' + JSON.stringify(SETTINGS.FIRST_BUY) + ', SECOND_BUY: ' + JSON.stringify(SETTINGS.SECOND_BUY) + ', FIRST_SELL: ' + JSON.stringify(SETTINGS.FIRST_SELL) + ', SECOND_SELL: ' + JSON.stringify(SETTINGS.SECOND_SELL)
        + ', THIRD_SELL: ' + JSON.stringify(SETTINGS.THIRD_SELL) + ', REV_TOL: ' + SETTINGS.REV_TOL);

    var profiles = [],
      trades_of_displayed_market = {
        buys: [],
        sells: []
      };

    ready_simulation_profiles(profiles, () => {
        simulate(profiles[req.body.market_index], () => {
            res.json(trades_of_displayed_market);
        }, trades_of_displayed_market);

        for (var i = 0; i < markets.length; i++)
            if (i !== req.body.market_index) {
                simulate(profiles[i], () => {});
            }
    });

});

app.listen(4000);

function simulate(profile, callback, trades) {
    var portfolio_start = 1,
        portfolio = Number(portfolio_start);

    db.collection(profile.market.name).find({}).sort({ time: 1 }).toArray((err, arr) => {
        if (err) return error(err);

        for (var i = 0; i < arr.length; i++) {
            if (!arr[i].vol_unit || !arr[i].price || !arr[i].vol_avg) return error('Corrupt db entry: ' + JSON.stringify(item));
            
            profile.mean = arr[i].steady_mean;
            profile.vol = arr[i].vol_unit;
            profile.vol_avg = arr[i].vol_avg;
            profile.price = arr[i].price;
            profile.time = arr[i].time;

            check_trade(profile, portfolio, trades);

            if (i === arr.length - 1) {
                var leftover = profile.holding * profile.price;

                log_('Simulated market ' + profile.market.name + ' grew portfolio from ' + portfolio_start + ' to ' + (portfolio + leftover) + ' BTC (' + ((portfolio + leftover) / portfolio_start - 1) * 100 + '% growth, ' + (portfolio / (portfolio + leftover) * 100) + '% actually sold)');
                callback();
            }
        }
    });
}

function ready_simulation_profiles(profiles, callback) {
    var count = 0;

    markets.forEach((market, ind) => {
        db.collection(market.name).find({}).sort({ time: 1 }).limit(1).toArray((err, arr) => {
            if (err) return error(err);
    
            if (arr.length < 1) error('Missing data for simulation');

            profiles[ind] = {
                market: markets[ind],
                price: arr[0].price,
                mean: arr[0].steady_mean,
                vol: arr[0].vol_unit,
                vol_avg: arr[0].vol_avg,
                holding: 0,
                prev_percent_change: 0,
                consecutive_stage_two_buys: 0,
                consecutive_stage_one_buys: 0,
                local_min: false,
                local_max: false,
                time: arr[0].time
            };

            count++;
            if (count == markets.length)
                callback();
        });
    });
}

function check_trade(market_profile, portfolio, trades) {
    var percent_change = market_profile.price / market_profile.mean - 1;

    //reset local extrema (peak checks) when the price leaves the range for which they are checked
    if (market_profile.local_min && -percent_change <= SETTINGS.SECOND_BUY.drop) market_profile.local_min = false;
    if (market_profile.local_max && percent_change <= SETTINGS.THIRD_SELL.gain) market_profile.local_max = false;

    if (market_profile.vol <= market_profile.vol_avg) {

        if (-percent_change > SETTINGS.SECOND_BUY.drop) {
        
            if (!market_profile.local_min || -market_profile.prev_percent_change <= SETTINGS.SECOND_BUY.drop) //this is the first time buy peaks were tracked
                market_profile.local_min = market_profile.price;
            else { //been tracking buy peaks
                if (market_profile.price < market_profile.local_min) market_profile.local_min = market_profile.price;
        
                if (market_profile.consecutive_stage_two_buys < 1 && (market_profile.price - market_profile.local_min) / market_profile.mean > SETTINGS.REV_TOL) { //price stopped dropping
                    buy(SETTINGS.SECOND_BUY.buy, 2, market_profile, portfolio, trades);
                    market_profile.consecutive_stage_two_buys++;
                }
            }
        
        } else if (market_profile.consecutive_stage_one_buys < 2 && -percent_change > SETTINGS.FIRST_BUY.drop && -market_profile.prev_percent_change <= SETTINGS.FIRST_BUY.drop) { //crossed first buy line
            buy(SETTINGS.FIRST_BUY.buy, 1, market_profile, portfolio, trades);
            market_profile.consecutive_stage_one_buys++;
        }
    }

    if (market_profile.holding === 0) return;

    if (percent_change > SETTINGS.THIRD_SELL.gain) {

        if (!market_profile.local_max || market_profile.prev_percent_change <= SETTINGS.THIRD_SELL.gain) //this is the first time sell peaks were tracked
            market_profile.local_max = market_profile.price;
        else { //been tracking sell peaks
            if (market_profile.price > market_profile.local_max) market_profile.local_max = market_profile.price;
        
            if ((market_profile.local_max - market_profile.price) / market_profile.mean > SETTINGS.REV_TOL) { //price stopped rising
                sell(SETTINGS.THIRD_SELL.sell, 3, market_profile, portfolio, trades);
                market_profile.local_max = false;
                market_profile.consecutive_stage_two_buys = 0;
                market_profile.consecutive_stage_one_buys = 0;
            }
        }

    } else if (percent_change > SETTINGS.SECOND_SELL.gain && market_profile.prev_percent_change <= SETTINGS.SECOND_SELL.gain) { //crossed second sell line
        sell(SETTINGS.SECOND_SELL.sell, 2, market_profile, portfolio, trades);
        market_profile.consecutive_stage_two_buys = 0;
        market_profile.consecutive_stage_one_buys = 0;
    } else if (percent_change > SETTINGS.FIRST_SELL.gain && market_profile.prev_percent_change <= SETTINGS.FIRST_SELL.gain) { //crossed first sell line
        sell(SETTINGS.FIRST_SELL.sell, 1, market_profile, portfolio, trades);
        market_profile.consecutive_stage_two_buys = 0;
        market_profile.consecutive_stage_one_buys = 0;
    }

    market_profile.prev_percent_change = percent_change;
}

function buy(percentage, num, market_profile, portfolio, trades) {

    var base = percentage * (1 - SIT) * portfolio,  // divide by markets length to allocate a small percentage of portfolio to each stock
      quote = base / market_profile.price;

    log_('Stage ' + num + ' buy of ' + base + ' worth of ' + market_profile.market.name + ' for ' + market_profile.price + ' BTC each');

    portfolio -= base;
    market_profile.holding += quote * (1 - EXCHANGES_FEES[market_profile.market.exchange]);

    if (trades && Array.isArray(trades.buys))
        trades.buys.push({
            x: market_profile.time,
            y: market_profile.price,
            z: base
        });
}

function sell(percentage, num, market_profile, portfolio, trades) {
    var quote = percentage * market_profile.holding,
      base = quote * market_profile.price;

    log_('Stage ' + num + ' sell of ' + base + ' worth of ' + market_profile.market.name + ' for ' + market_profile.price + ' BTC each');

    market_profile.holding -= quote;
    portfolio += base * (1 - EXCHANGES_FEES[market_profile.market.exchange]);

    market_profile.last_sell_price = market_profile.price;

    if (trades && Array.isArray(trades.sells))
        trades.sells.push({
            x: market_profile.time,
            y: market_profile.price,
            z: base
        });
}

function update_portfolio(market_profiles, callback) {
    if (!market_profiles || market_profiles.length != markets.length) return error('Invalid portfolio value calculation');

    var val = 0,
      loaded = 0,
      balances = [];

    exchanges.forEach((exchange, ind) => {
        exchange.fetchBalance().then((data) => {
            balances[ind] = data;
            val += data.BTC.total;
            loaded++;

            if (loaded == exchanges.length) {
                for (var i = 0; i < markets.length; i++) {
                    var holding_in_alt = balances[market_profiles[i].market.exchange][market_profiles[i].market.name.split('/')[0]];
                    market_profiles[i].holding = (holding_in_alt ? holding_in_alt.total : 0) * market_profiles[i].price;
                    val += market_profiles[i].holding;
                }
                callback(val);
            }
        });
    });
}

function invalid_market_index(market_index) {
    return typeof market_index != 'number' || market_index < 0 || market_index >= markets.length;
}

function startup_bot() {

    exchanges.push(new ccxt.bittrex({
        apiKey: '***REMOVED***',
        secret: '***REMOVED***',
        verbose: false
    }));

    new_market('NEO/BTC', EXCHANGES.BITTREX);
    new_market('ETH/BTC', EXCHANGES.BITTREX);
    new_market('SC/BTC', EXCHANGES.BITTREX);
    new_market('GNT/BTC', EXCHANGES.BITTREX);
    new_market('STORJ/BTC', EXCHANGES.BITTREX);
    new_market('DOPE/BTC', EXCHANGES.BITTREX);
    new_market('MCO/BTC', EXCHANGES.BITTREX);

    load_historical_markets(() => {
        log_('Starting Bot');
        heart = heartbeats.createHeart(POLL_INTERVAL * 1000);
        // heart.createEvent(1, heartbeat);
    });
}

function heartbeat() {
    markets.forEach((market, m) => {
        var collection = db.collection(market.name),
          exchange = exchanges[market.exchange],
          ticker;

        exchange.fetchTicker(market.name).then((data) => {
            ticker = data;
            console.log(ticker);

        }, error);
    });
}

function get_stats(collection, exchange, callback) {
    var cursor = collection.find({
        $or: [
            { h: true },
            { exchange: exchange }
        ] 
    }),
      steady_mean = 0,
      mean_count = 0,
      vol_avg = 0,
      vol_count = 0;

    while (cursor.hasNext()) {
        var entry = cursor.next();

        if (!entry.steady_mean || !entry.is_steady || !entry['24_hr_vol']) error('Corrupt db entry: ' + entry);


    }
}

function load_market(i, callback) {
    const tick_interval = (FAST ? 'thirty' : 'five') + 'Min';

    request('https://bittrex.com/Api/v2.0/pub/market/GetTicks?marketName='
    + markets[i].name.split('/')[1] + '-' + markets[i].name.split('/')[0] + '&tickInterval=' + tick_interval, (err, res, body) => {
        if (err) throw err;
        var data = JSON.parse(body);

        if (!data.success || !data.result[0]) return error('Could not load historical data for ' + markets[i].name);

        var collection = db.collection(markets[i].name);
        collection.remove({}, {});

        collection.ensureIndex({time: 1}, {expireAfterSeconds: SIMULATON_PERIOD});

        var vol_ticks = new Moving_Average(VOLUME_UNIT_INTERVAL, true),
          vols = new Moving_Average(SETTINGS.VOLUME_PERIOD, false),
          means = new Moving_Average(SETTINGS.MEAN_PERIOD, false, 24 * (tick_interval == 'thirtyMin' ? 2 : 12));

        data.result.forEach((item, ind) => {

            var res = {},
              time = new Date(item.T),
              time_s = time.getTime(),
              age_s = (Date.now() - time.getTime()) / 1000; 

            if (age_s < SIMULATON_PERIOD) {

                vol_ticks.add(time_s, item.BV);

                res.price = item.C; //close price is price
                res.raw_vol = item.BV;  //volume over past tick_interval
                res.vol_unit = vol_ticks.get(); //base volume is volume in btc, this is moving average over 24 hrs
                res.vol_avg = vols.get();
                res.steady_mean = means.get();
                res.is_steady = res.vol_unit <= (1 + SETTINGS.VOLUME_HIGH) * res.vol_avg;
                res.time = time;
                res.h = true; //historical data, so poll interval is tick_interval, not INTERVAL

                collection.insert(res);

                vols.add(time_s, res.vol_unit);
                if (res.is_steady) //only count steady stocks towards mean
                    means.add(time_s, res.price);

            } else {

                if (age_s < SIMULATON_PERIOD + SETTINGS.MEAN_PERIOD)
                    means.add(time_s, item.C);

                if (age_s < SIMULATON_PERIOD + SETTINGS.VOLUME_PERIOD) {
                    vol_ticks.add(time_s, item.BV);
                    vols.add(time_s, vol_ticks.get());
                } else if (age_s < SIMULATON_PERIOD + SETTINGS.VOLUME_PERIOD + VOLUME_UNIT_INTERVAL)
                    vol_ticks.add(time_s, item.BV);
            }
        });

        log_('Loaded market: ' + markets[i].name);

        callback();
    });
}

function load_historical_markets(callback, except) {
    var num_loaded = Number(typeof except == 'number' ? 1 : 0);

    for (var i = 0; i < markets.length; i++)
        if (i !== except)
            load_market(i, function() {
                num_loaded++;
                if (num_loaded == markets.length) this();
            }.bind(callback));
}

function add_debug_point(data, db_entry) {

    data.vol_ticks.push({
        x: db_entry.time,
        y: db_entry.raw_vol
    });

    data.vol_avgs_over_period.push({
        x: db_entry.time,
        y: db_entry.vol_avg
    });

    data.vols_over_unit_interval.push({
        x: db_entry.time,
        y: db_entry.vol_unit
    });

    data.price.push({
        x: db_entry.time,
        y: db_entry.price
    });

    data.steady_mean.push({
        x: db_entry.time,
        y: db_entry.steady_mean
    });
}

function get_debug_data(market_index, callback) {
    var data = {
        vol_ticks: [],
        vols_over_unit_interval: [],
        vol_avgs_over_period: [],
        price: [],
        steady_mean: [],
        name: markets[market_index].name,
        market_index: market_index
    };  

    db.collection(markets[market_index].name).find({}).sort({ time: 1 }).toArray((err, arr) => {
        if (err) return error(err);

        arr.forEach((entry) => {
            if (!entry.steady_mean || !entry.price || !entry.raw_vol || !entry.vol_avg || !entry.vol_unit)
                error('Corrupt db entry: ' + JSON.stringify(entry));
            else 
                add_debug_point(data, entry, market_index);
        });

        callback(data);
    });
}

function new_market(name, exchange) {
    var res = {};
    res.name = name;
    res.exchange = exchange;
    markets.push(res);
}

async function test() {
    //await exchanges[0].loadMarkets();
    console.log(await exchanges[0].fetchBalance());
    //console.log(exchanges[0].markets);
    //console.log(await exchanges[0].fetchTicker(markets[0].name));
}

function log_(msg) {
    console.log(msg);
    log.info(msg);
}

function error(msg) {
    console.error(msg.message ? msg.message : msg);
    log.error(msg.message ? msg.message : msg);
}




//pass in number of expected ticks per interval to ensure data stays at desired_len long
function Moving_Average(interval, is_sum, ticks) {
    this.sum = 0;
    this.is_sum = is_sum;
    this.data = [];
    this.interval = interval;
    this.desired_len = ticks;
}

Moving_Average.prototype.add = function(time, vol) {
    if (Number.MAX_SAFE_INTEGER - vol < this.sum) error('Integer overflow error');

    this.sum += vol;
    this.data.push({
        time: time,
        vol: vol
    });
}

Moving_Average.prototype.get = function() {
    if (this.data.length == 0) return error('Invalid moving average calculation');

    var since = this.data[this.data.length - 1].time;

    for (var k = 0; k < this.data.length; k++)
        if ((!this.desired_len || this.data.length > this.desired_len) && (since - this.data[k].time) / 1000 >= this.interval) {
            this.sum -= this.data[k].vol;
            this.data.splice(k, 1);
        } else {
            break; //assumes everything pushed chronologically
        }

    return this.is_sum ? this.sum : this.sum / this.data.length;
}
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
    VOL_SPIKE: 0.37,
    FIRST_SELL: {
        gain: 0.1,
        sell: 0.3
    },
    SECOND_SELL: {
        gain: 0.5,
        sell: 0.5
    },
    THIRD_SELL: 0.8,
    FIRST_BUY: {
        drop: 0.15,
        buy: 0.4 
    },
    SECOND_BUY: 0.6,
  };

const MEAN_AND_VOLUME_PERIOD = 60*60*24*14, //moving averages are over 2 weeks
  VOLUME_UNIT_INTERVAL = 60*60*24, //volume is stored over one day
  POLL_INTERVAL = 2,  //update once every 2 seconds
  EXCHANGES = {
    BITTREX: 0
  },
  EXCHANGES_VOLUME_UNIT_INTERVALS = [ VOLUME_UNIT_INTERVAL ]; //when data is polled, this is the volume unit returned

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
    if (typeof req.body.SETTINGS.VOL_SPIKE != 'number' || req.body.SETTINGS.VOL_SPIKE <= 0 || req.body.SETTINGS.VOL_SPIKE > 1 || invalid_market_index(req.body.market_index))
        return error('Invalid recalculate request');

    SETTINGS.VOL_SPIKE = req.body.SETTINGS.VOL_SPIKE;

    log_('Admin page recalculated for market: ' + markets[req.body.market_index].name + ' with VOL_SPIKE: ' + SETTINGS.VOL_SPIKE);

    load_historical_markets(() => {
        get_debug_data(req.body.market_index, (data) => {
            res.json(data.steady_mean);
        });
    });
});

app.post('/admin/simulate', (req, res) => {
    console.log(req.body);
});

app.listen(4000);

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
        heart = heartbeats.createHeart(POLL_INTERVAL * 1000);
        //heart.createEvent(1, heartbeat);
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

function load_historical_markets(callback) {
    var num_loaded = 0;

    markets.forEach((item, i) => {

        request('https://bittrex.com/Api/v2.0/pub/market/GetTicks?marketName='
            + markets[i].name.split('/')[1] + '-' + markets[i].name.split('/')[0] + '&tickInterval=fiveMin', (err, res, body) => {
                if (err) throw err;
                var data = JSON.parse(body);

                if (!data.success || !data.result[0]) return error('Could not load historical data for ' + markets[i].name);

                var collection = db.collection(markets[i].name);
                collection.remove({}, {});

                collection.ensureIndex({time: 1}, {expireAfterSeconds: MEAN_AND_VOLUME_PERIOD});

                //used to calculate 24 hr volume moving average
                var last_24_hrs = [],  //the volume ticks over the last 24 hours (stores values of moving average)
                  vol_sum_24_hr = 0; //the sum of volumes over tick_interval for last 24 hours

                //used to calculate 2 week 24 hr volume average
                var vol_sum_2_weeks = 0,
                  vol_count = 0;

                //used to calculate 2 week mean price on steady data (low volume data)
                var mean_sum = 0,
                  mean_count = 0;

                for (var j = 0; j < data.result.length; j++) {
                    var res = {},
                      time = new Date(data.result[j].T);

                    if ((Date.now() - time.getTime()) / 1000 < MEAN_AND_VOLUME_PERIOD) {

                        //removing old values from moving average array
                        for (var k = 0; k < last_24_hrs.length; k++)
                            if ((time.getTime() - last_24_hrs[k].time.getTime()) / 1000 > VOLUME_UNIT_INTERVAL) {
                                vol_sum_24_hr -= last_24_hrs[k].vol;
                                last_24_hrs.splice(k, 1);
                            } else {
                                break;
                            }

                        vol_sum_24_hr += data.result[j].BV;
                        last_24_hrs.push({
                            time: time,
                            vol: data.result[j].BV
                        });

                        res.price = data.result[j].C; //close price is price
                        res.raw_vol = data.result[j].BV;  //volume over past tick_interval
                        res.vol_unit = vol_sum_24_hr; //base volume is volume in btc, this is moving average over 24 hrs
                        res.vol_avg = vol_sum_2_weeks / vol_count;
                        res.steady_mean = mean_sum / mean_count;
                        res.is_steady = res.vol_unit <= (1 + SETTINGS.VOL_SPIKE) * res.vol_avg;
                        res.time = time;
                        res.h = true; //historical data, so poll interval is tick_interval, not INTERVAL
    
                        collection.insert(res);
    
                        //current stock's volume is not counted towards the average its compared to
                        vol_sum_2_weeks += res.vol_unit;
                        vol_count++;
    
                        //only count steady stocks towards mean
                        if (res.is_steady) {
                            mean_sum += res.price;
                            mean_count++;
                        }

                    } else if ((Date.now() - time.getTime()) / 1000 < MEAN_AND_VOLUME_PERIOD + VOLUME_UNIT_INTERVAL) {
                        
                        vol_sum_24_hr += data.result[j].BV;
                        last_24_hrs.push({
                            time: time,
                            vol: data.result[j].BV
                        });

                    }
                }
                log_('Loaded market history: ' + markets[i].name);
                num_loaded++;

                if (num_loaded == markets.length) callback();
        });
    });
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
    console.log(exchanges[0].markets);
    console.log(await exchanges[0].fetchTicker(markets[0].name));
}

function log_(msg) {
    console.log(msg);
    log.info(msg);
}

function error(msg) {
    console.error(msg.message ? msg.message : msg);
    log.error(msg.message ? msg.message : msg);
}
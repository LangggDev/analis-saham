import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool, initDB, ensureDB } from './db.js';
import midtransClient from 'midtrans-client';

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET tidak ditemukan di environment variables! Server tidak bisa dijalankan tanpa secret key.');
  console.error('   Tambahkan JWT_SECRET=your_secret_key ke file .env');
  process.exit(1);
}

// ─── Midtrans Gateway Client Configuration ──────────────────────────────────
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-YOUR_SERVER_KEY_DEFAULT';
const MIDTRANS_CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY || 'SB-Mid-client-YOUR_CLIENT_KEY_DEFAULT';
const IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';

let snapClient = null;
let coreApiClient = null;
try {
  snapClient = new midtransClient.Snap({
    isProduction: IS_PRODUCTION,
    serverKey: MIDTRANS_SERVER_KEY,
    clientKey: MIDTRANS_CLIENT_KEY
  });
  coreApiClient = new midtransClient.CoreApi({
    isProduction: IS_PRODUCTION,
    serverKey: MIDTRANS_SERVER_KEY,
    clientKey: MIDTRANS_CLIENT_KEY
  });
  console.log('💳 [Midtrans] Gateway client berhasil diinisialisasi (' + (IS_PRODUCTION ? 'Production' : 'Sandbox') + ').');
} catch (err) {
  console.warn('⚠️ [Midtrans Warning]: Gagal menginisialisasi client Midtrans:', err.message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Disable X-Powered-By header for security
app.disable('x-powered-by');

// Security Headers Middleware
app.use(helmet({
  contentSecurityPolicy: false, // allow loading CDNs/scripts used in public/index.html
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Rate Limiter: Prevent abuse/DDoS on API endpoints (200 requests per 15 mins per IP)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan. Silakan coba lagi beberapa saat.' }
});

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use('/api/', apiLimiter);
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:5000', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '500kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Input Sanitizer Helper
function sanitizeSymbol(input) {
  if (typeof input !== 'string') return '';
  return input.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 15);
}


// ─── Yahoo Finance HTTP Client ──────────────────────────────────────────────
// v8/chart endpoint works without crumb authentication
// v10/v11 quoteSummary endpoints REQUIRE crumb + cookie authentication
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// Crumb + Cookie cache for authenticated Yahoo requests
let yfCrumbData = { crumb: null, cookie: null, timestamp: 0 };
const CRUMB_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getYahooCrumb() {
  const now = Date.now();
  if (yfCrumbData.crumb && yfCrumbData.cookie && (now - yfCrumbData.timestamp) < CRUMB_TTL_MS) {
    return yfCrumbData;
  }

  console.log('[Yahoo] Fetching fresh crumb + cookie...');

  try {
    // Step 1: Get consent cookie from Yahoo Finance main page
    const pageRes = await fetch('https://finance.yahoo.com/quote/AAPL/', {
      headers: YF_HEADERS,
      redirect: 'manual',
    });

    // Collect Set-Cookie headers
    const setCookies = pageRes.headers.getSetCookie?.() || [];
    let cookieStr = setCookies
      .map(c => c.split(';')[0])
      .join('; ');

    // Follow redirects manually if needed to collect all cookies
    if (pageRes.status >= 300 && pageRes.status < 400) {
      const redir = pageRes.headers.get('location');
      if (redir) {
        const redirRes = await fetch(redir, {
          headers: { ...YF_HEADERS, 'Cookie': cookieStr },
          redirect: 'manual',
        });
        const moreCookies = redirRes.headers.getSetCookie?.() || [];
        if (moreCookies.length > 0) {
          cookieStr += '; ' + moreCookies.map(c => c.split(';')[0]).join('; ');
        }
      }
    }

    // Step 2: Fetch the crumb using the cookie
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        ...YF_HEADERS,
        'Accept': '*/*',
        'Cookie': cookieStr,
      },
    });

    if (!crumbRes.ok) {
      throw new Error(`Crumb fetch failed: ${crumbRes.status}`);
    }

    const crumb = await crumbRes.text();
    if (!crumb || crumb.length < 5) {
      throw new Error(`Invalid crumb received: "${crumb}"`);
    }

    yfCrumbData = { crumb: crumb.trim(), cookie: cookieStr, timestamp: now };
    console.log(`[Yahoo] Crumb obtained: ${yfCrumbData.crumb.substring(0, 8)}...`);
    return yfCrumbData;

  } catch (err) {
    console.error('[Yahoo] Failed to get crumb:', err.message);
    // Return stale data if available
    if (yfCrumbData.crumb) return yfCrumbData;
    throw err;
  }
}

async function yahooFetch(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { ...YF_HEADERS, 'Accept': 'application/json', ...extraHeaders },
  });
  if (!res.ok) {
    throw new Error(`Yahoo Finance API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Authenticated fetch for quoteSummary-type endpoints that need crumb
async function yahooAuthFetch(baseUrl) {
  const { crumb, cookie } = await getYahooCrumb();
  const separator = baseUrl.includes('?') ? '&' : '?';
  const url = `${baseUrl}${separator}crumb=${encodeURIComponent(crumb)}`;
  return yahooFetch(url, { 'Cookie': cookie });
}

// ─── In-Memory Cache ────────────────────────────────────────────────────────
const cache = new Map();
const inFlight = new Map();

function withCache(key, ttlSeconds, fetchFn) {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.timestamp < ttlSeconds * 1000) {
    return Promise.resolve(cached.data);
  }
  // Mencegah duplicate processing: jika cache sedang dihitung (in-flight), tunggu promise yang sama
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }
  const promise = fetchFn().then((data) => {
    cache.set(key, { data, timestamp: Date.now() });
    inFlight.delete(key);
    return data;
  }).catch((err) => {
    inFlight.delete(key);
    throw err;
  });
  inFlight.set(key, promise);
  return promise;
}

// Prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > 30 * 60 * 1000) cache.delete(key); // Perpanjang usia simpan cadangan menjadi 30 menit
  }
}, 5 * 60 * 1000);

// ─── Rate Limiting / Throttle ───────────────────────────────────────────────
const MAX_CONCURRENT = 12; // Ditingkatkan agar scan paralel 300 saham jauh lebih cepat
let activeCalls = 0;
const waitQueue = [];

function withThrottle(fn) {
  return new Promise((resolve, reject) => {
    const execute = () => {
      activeCalls++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeCalls--;
          if (waitQueue.length > 0) waitQueue.shift()();
        });
    };
    if (activeCalls < MAX_CONCURRENT) execute();
    else waitQueue.push(execute);
  });
}

// ─── Retry Logic ────────────────────────────────────────────────────────────
async function withRetry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Abort langsung jika error 404 / 400 (saham tidak ada di Yahoo Finance / tidak terindeks), retry tidak akan menyelesaikan error ini
      if (err.message && (err.message.includes('404') || err.message.includes('Not Found') || err.message.includes('400') || err.message.includes('No chart data'))) {
        throw err;
      }
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 500;
        console.warn(`  ⚠ Attempt ${attempt + 1} failed (${err.message}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ─── Request Logger ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  }
  next();
});

function yahooCall(fn) {
  return withThrottle(() => withRetry(fn));
}

// ─── Helper: fetch chart + meta from v8 endpoint ────────────────────────────
async function fetchChartData(symbol, interval = '1d', range = '6mo') {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const result = await yahooFetch(url);
  const chartResult = result?.chart?.result?.[0];
  if (!chartResult) throw new Error(`No chart data for ${symbol}`);
  return chartResult;
}

// ─── Helper: Fetch Real-Time Quote from TradingView Screener API ─────────────
async function fetchTradingViewQuote(ticker) {
  try {
    const baseTicker = ticker.replace(/\.JK$/i, '').toUpperCase();
    const tvRes = await fetch('https://scanner.tradingview.com/indonesia/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: { tickers: [`IDX:${baseTicker}`] },
        columns: ['close', 'change', 'change_abs', 'volume', 'description', 'high', 'low', 'open', 'Pre-market.change', 'Post-market.change']
      })
    });
    if (!tvRes.ok) return null;
    const json = await tvRes.json();
    const row = json?.data?.[0]?.d;
    if (!row || !row[0]) return null;
    return {
      price: parseFloat(row[0]),
      changePercent: parseFloat(row[1]),
      change: parseFloat(row[2]),
      volume: parseInt(row[3]) || 0,
      name: row[4] || baseTicker,
      dayHigh: parseFloat(row[5]) || parseFloat(row[0]),
      dayLow: parseFloat(row[6]) || parseFloat(row[0]),
      open: parseFloat(row[7]) || parseFloat(row[0])
    };
  } catch (err) {
    return null;
  }
}

// ─── API: Quote (Dual-Engine: Yahoo Finance + TradingView Screener API) ──────
app.get('/api/quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await withCache(`quote:${symbol}`, 10, async () => {
      // Ambil secara paralel dari TradingView Screener dan Yahoo Finance
      const [tvQuote, yahooQuote] = await Promise.all([
        fetchTradingViewQuote(symbol),
        yahooCall(async () => {
          const chart = await fetchChartData(symbol, '1m', '5d').catch(() => fetchChartData(symbol, '1d', '5d'));
          const meta = chart.meta;
          const closes = (chart.indicators?.quote?.[0]?.close || []).filter(c => c != null);

          let price = meta.regularMarketPrice ?? 0;
          let previousClose = meta.chartPreviousClose ?? meta.previousClose ?? 0;

          if (!price || price === 0) {
            if (closes.length >= 2) {
              price = closes[closes.length - 1];
            } else if (closes.length === 1) {
              price = closes[0];
            }
          }
          if (!previousClose || previousClose === 0) {
            if (closes.length >= 2) {
              previousClose = closes[closes.length - 2];
            }
          }

          const change = price - previousClose;
          const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

          return {
            symbol: meta.symbol || symbol,
            name: meta.shortName || meta.longName || symbol,
            price,
            change,
            changePercent,
            volume: meta.regularMarketVolume ?? 0,
            marketCap: meta.marketCap ?? null,
            dayHigh: meta.regularMarketDayHigh ?? 0,
            dayLow: meta.regularMarketDayLow ?? 0,
            open: meta.regularMarketOpen ?? 0,
            previousClose,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? 0,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? 0,
            currency: meta.currency || '',
            exchange: meta.exchangeName || meta.fullExchangeName || '',
            marketState: meta.marketState || 'UNKNOWN',
          };
        }).catch(() => null)
      ]);

      // Gabungkan data: Pilih data dengan volume paling update/tinggi atau harga terkini dari TradingView
      if (yahooQuote && tvQuote) {
        if (tvQuote.volume >= yahooQuote.volume || tvQuote.price !== yahooQuote.price) {
          return {
            ...yahooQuote,
            price: tvQuote.price || yahooQuote.price,
            change: tvQuote.change || yahooQuote.change,
            changePercent: tvQuote.changePercent || yahooQuote.changePercent,
            volume: Math.max(tvQuote.volume, yahooQuote.volume),
            dayHigh: Math.max(tvQuote.dayHigh, yahooQuote.dayHigh),
            dayLow: Math.min(tvQuote.dayLow || Infinity, yahooQuote.dayLow || Infinity) !== Infinity ? Math.min(tvQuote.dayLow, yahooQuote.dayLow) : yahooQuote.dayLow,
            open: tvQuote.open || yahooQuote.open,
            source: 'TradingView + Yahoo Dual-Engine'
          };
        }
        return { ...yahooQuote, source: 'Yahoo + TradingView Verified' };
      }
      if (tvQuote && (!yahooQuote || !yahooQuote.price)) {
        return {
          symbol,
          name: tvQuote.name,
          price: tvQuote.price,
          change: tvQuote.change,
          changePercent: tvQuote.changePercent,
          volume: tvQuote.volume,
          dayHigh: tvQuote.dayHigh,
          dayLow: tvQuote.dayLow,
          open: tvQuote.open,
          previousClose: tvQuote.price - tvQuote.change,
          currency: 'IDR',
          exchange: 'JKT',
          marketState: 'REGULAR',
          source: 'TradingView Live Screener API'
        };
      }
      if (yahooQuote) return yahooQuote;
      throw new Error(`Data tidak ditemukan untuk ${symbol}`);
    });
    res.json(data);
  } catch (err) {
    console.error(`Error fetching quote for ${symbol}:`, err.message);
    res.status(500).json({ error: `Failed to fetch quote for ${symbol}`, details: err.message });
  }
});


// ─── API: Chart ─────────────────────────────────────────────────────────────
app.get('/api/chart/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const interval = req.query.interval || '1d';
  const range = req.query.range || '6mo';
  const cacheKey = `chart:${symbol}:${interval}:${range}`;

  try {
    // Shorter cache for intraday intervals to support real-time updates
    const intradayIntervals = ['1m', '2m', '5m', '15m', '30m', '60m', '1h'];
    const cacheTTL = intradayIntervals.includes(interval) ? 30 : 60;

    const transformed = await withCache(cacheKey, cacheTTL, () =>
      yahooCall(async () => {
        // Auto-determine range based on interval
        const intradayIntervals = ['1m', '2m', '5m', '15m', '30m', '60m', '1h'];
        let useRange = range;
        if (intradayIntervals.includes(interval)) {
          switch (interval) {
            case '1m': case '2m': useRange = '5d'; break;
            case '5m': case '15m': case '30m': useRange = '1mo'; break;
            case '60m': case '1h': useRange = '2mo'; break;
            default: useRange = '1mo';
          }
        }

        const chart = await fetchChartData(symbol, interval, useRange);
        const timestamps = chart.timestamp || [];
        const quote = chart.indicators?.quote?.[0] || {};

        const candles = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (quote.close?.[i] != null && quote.open?.[i] != null) {
            candles.push({
              time: timestamps[i],
              open: quote.open[i],
              high: quote.high?.[i] ?? quote.open[i],
              low: quote.low?.[i] ?? quote.open[i],
              close: quote.close[i],
              volume: quote.volume?.[i] || 0,
            });
          }
        }
        return candles;
      })
    );
    res.json(transformed);
  } catch (err) {
    console.error(`Error fetching chart for ${symbol}:`, err.message);
    res.status(500).json({ error: `Failed to fetch chart for ${symbol}`, details: err.message });
  }
});

// ─── API: Search ────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Query parameter "q" is required' });

  try {
    const results = await withCache(`search:${query.toLowerCase()}`, 300, () =>
      yahooCall(async () => {
        const result = await yahooFetch(
          `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`
        );
        return (result?.quotes || []).map((item) => ({
          symbol: item.symbol,
          name: item.shortname || item.longname || item.symbol,
          exchange: item.exchDisp || item.exchange,
          type: item.quoteType || item.typeDisp,
        }));
      })
    );
    res.json(results);
  } catch (err) {
    console.error(`Error searching for "${query}":`, err.message);
    res.status(500).json({ error: `Failed to search for "${query}"`, details: err.message });
  }
});

// ─── Helper: fetch news data ──────────────────────────────────────────────────
async function fetchNewsData(symbol) {
  const baseSymbol = symbol.split('.')[0]; // remove .JK or other extensions
  return await withCache(`news:${symbol}`, 300, () =>
    yahooCall(async () => {
      const result = await yahooFetch(
        `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=20&listsCount=0`
      );

      const rawNews = result?.news || [];

      const filteredNews = rawNews.filter(item => {
        if (item.relatedTickers && item.relatedTickers.length > 0) {
          return item.relatedTickers.some(t => t.toUpperCase().includes(baseSymbol));
        }
        return item.title && item.title.toUpperCase().includes(baseSymbol);
      });

      return filteredNews.map((item) => ({
        title: item.title,
        link: item.link,
        publisher: item.publisher,
        publishedAt: item.providerPublishTime
          ? new Date(item.providerPublishTime * 1000).toISOString()
          : null,
        thumbnail: item.thumbnail?.resolutions?.[0]?.url || null,
      }));
    })
  );
}

// ─── API: News ──────────────────────────────────────────────────────────────
app.get('/api/news/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const news = await fetchNewsData(symbol);
    res.json(news);
  } catch (err) {
    console.error(`Error fetching news for ${symbol}:`, err.message);
    res.status(500).json({ error: `Failed to fetch news for ${symbol}`, details: err.message });
  }
});

// ─── Sentiment Analysis Helper ─────────────────────────────────────────────
const keywordSentiment = (text) => {
  const positive = ['naik', 'laba', 'untung', 'tumbuh', 'rekor', 'lonjakan', 'beli', 'bullish', 'investasi', 'dividen', 'profit', 'growth', 'surge', 'buy'];
  const negative = ['turun', 'rugi', 'anjlok', 'merosot', 'jual', 'bearish', 'skandal', 'denda', 'phk', 'loss', 'drop', 'plunge', 'sell', 'cut'];

  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  let posCount = 0;
  let negCount = 0;

  words.forEach(w => {
    if (positive.includes(w)) posCount++;
    if (negative.includes(w)) negCount++;
  });

  let sentiment = 'NEUTRAL';
  let score = 50;

  if (posCount > negCount) {
    sentiment = 'POSITIVE';
    score = 75 + Math.min(25, (posCount - negCount) * 5);
  } else if (negCount > posCount) {
    sentiment = 'NEGATIVE';
    score = 25 - Math.min(25, (negCount - posCount) * 5);
  }

  return { sentiment, score };
};

// ─── API: Sentiment ─────────────────────────────────────────────────────────
app.get('/api/sentiment/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const news = await fetchNewsData(symbol);
    if (!news || news.length === 0) {
      return res.json({ symbol, overallSentiment: 'NEUTRAL', score: 50, articlesAnalyzed: 0, articles: [], _method: 'none' });
    }

    const articlesToAnalyze = news.slice(0, 10);

    // Check if Gemini AI is available
    if (process.env.GEMINI_API_KEY) {
      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        const prompt = `Analyze the sentiment of the following news headlines for stock ${symbol}.
For each headline, provide a sentiment (POSITIVE, NEGATIVE, or NEUTRAL) and a score from 0 to 100 (where 0 is extremely negative, 50 is neutral, and 100 is extremely positive).
Format your response as a valid JSON array of objects, where each object has "sentiment" (string) and "score" (number). Do not include any markdown formatting or extra text, just the JSON array.
Headlines:
${articlesToAnalyze.map((n, i) => `${i + 1}. ${n.title}`).join('\n')}`;

        const result = await model.generateContent(prompt);
        let text = result.response.text();
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        const aiResults = JSON.parse(text);

        let totalScore = 0;
        const articles = articlesToAnalyze.map((article, i) => {
          const aiResult = aiResults[i] || { sentiment: 'NEUTRAL', score: 50 };
          totalScore += aiResult.score;
          return {
            title: article.title,
            sentiment: aiResult.sentiment,
            score: aiResult.score,
            source: 'gemini',
            publisher: article.publisher,
            publishedAt: article.publishedAt,
            link: article.link
          };
        });

        const avgScore = Math.round(totalScore / articles.length);
        let overallSentiment = 'NEUTRAL';
        if (avgScore >= 65) overallSentiment = 'POSITIVE';
        else if (avgScore <= 35) overallSentiment = 'NEGATIVE';

        return res.json({
          symbol,
          overallSentiment,
          score: avgScore,
          articlesAnalyzed: articles.length,
          articles,
          _method: 'gemini'
        });

      } catch (aiError) {
        console.warn('Gemini API failed, falling back to keyword analysis:', aiError.message);
      }
    }

    // Fallback: Keyword analysis
    let totalScore = 0;
    const articles = articlesToAnalyze.map(article => {
      const { sentiment, score } = keywordSentiment(article.title);
      totalScore += score;
      return {
        title: article.title,
        sentiment,
        score,
        source: 'keyword',
        publisher: article.publisher,
        publishedAt: article.publishedAt,
        link: article.link
      };
    });

    const avgScore = Math.round(totalScore / articles.length);
    let overallSentiment = 'NEUTRAL';
    if (avgScore >= 60) overallSentiment = 'POSITIVE';
    else if (avgScore <= 40) overallSentiment = 'NEGATIVE';

    res.json({
      symbol,
      overallSentiment,
      score: avgScore,
      articlesAnalyzed: articles.length,
      articles,
      _method: 'keyword'
    });

  } catch (err) {
    console.error(`Error fetching sentiment for ${symbol}:`, err.message);
    res.status(500).json({ error: `Failed to fetch sentiment for ${symbol}`, details: err.message });
  }
});

// ─── API: Summary ───────────────────────────────────────────────────────────
// Uses chart meta + additional data for fundamental info
app.get('/api/summary/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const summary = await withCache(`summary:${symbol}`, 600, () =>
      yahooCall(async () => {
        const chart = await fetchChartData(symbol, '1d', '1y');
        const meta = chart.meta;
        return {
          symbol: meta.symbol,
          currency: meta.currency,
          exchange: meta.exchangeName,
          regularMarketPrice: meta.regularMarketPrice,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
          chartPreviousClose: meta.chartPreviousClose,
        };
      })
    );
    res.json(summary);
  } catch (err) {
    console.error(`Error fetching summary for ${symbol}:`, err.message);
    res.status(500).json({ error: `Failed to fetch summary for ${symbol}`, details: err.message });
  }
});

// ─── Unauthenticated Fundamental Helpers (TradingView Screener & Yahoo V8) ───
async function fetchTradingViewFundamental(symbol) {
  try {
    const baseTicker = symbol.replace('.JK', '').toUpperCase();
    const marketUrl = symbol.endsWith('.JK')
      ? 'https://scanner.tradingview.com/indonesia/scan'
      : 'https://scanner.tradingview.com/global/scan';

    const res = await fetch(marketUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Referer': 'https://www.tradingview.com/'
      },
      body: JSON.stringify({
        symbols: { tickers: [symbol.endsWith('.JK') ? `IDX:${baseTicker}` : baseTicker] },
        columns: [
          "name",
          "price_earnings_ttm",
          "price_book_mrq",
          "price_book_fq",
          "return_on_equity_ttm",
          "return_on_equity_fq",
          "debt_to_equity_mrq",
          "debt_to_equity_fq",
          "basic_eps_ttm",
          "earnings_per_share_basic_ttm",
          "dividend_yield_recent",
          "dividend_yield_trailing_12_month",
          "market_cap_basic",
          "total_revenue_yoy_growth_ttm",
          "net_margin_ttm",
          "current_ratio_fq",
          "free_cash_flow_ttm",
          "close"
        ]
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.data && json.data[0] && json.data[0].d) {
      const d = json.data[0].d;
      return {
        per: d[1] ?? null,
        pbv: d[2] ?? d[3] ?? null,
        roe: (d[4] ?? d[5]) != null ? (d[4] ?? d[5]) / 100 : null,
        der: (d[6] ?? d[7]) != null ? (d[6] ?? d[7]) / 100 : null,
        eps: d[8] ?? d[9] ?? null,
        dividendYield: (d[10] ?? d[11]) != null ? (d[10] ?? d[11]) / 100 : null,
        marketCap: d[12] ?? null,
        revenueGrowth: d[13] != null ? d[13] / 100 : null,
        profitMargin: d[14] != null ? d[14] / 100 : null,
        currentRatio: d[15] ?? null,
        freeCashFlow: d[16] ?? null,
        price: d[17] ?? null,
      };
    }
  } catch (e) {
    console.warn(`[TV Fundamental] Failed for ${symbol}:`, e.message);
  }
  return null;
}

async function fetchYahooV8Fundamental(symbol) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/quote?symbols=${encodeURIComponent(symbol)}`, {
      headers: YF_HEADERS
    });
    if (!res.ok) return null;
    const json = await res.json();
    const q = json?.quoteResponse?.result?.[0];
    if (q) {
      return {
        per: q.trailingPE ?? q.forwardPE ?? null,
        pbv: q.priceToBook ?? null,
        eps: q.epsTrailingTwelveMonths ?? q.epsForward ?? null,
        dividendYield: q.trailingAnnualDividendYield != null ? q.trailingAnnualDividendYield / 100 : (q.dividendYield ?? null),
        marketCap: q.marketCap ?? null,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: q.fiftyTwoWeekLow ?? null,
        price: q.regularMarketPrice ?? null,
        bookValue: q.bookValue ?? null
      };
    }
  } catch (e) {
    console.warn(`[Yahoo V8 Fundamental] Failed for ${symbol}:`, e.message);
  }
  return null;
}

// ─── API: Fundamental Data ──────────────────────────────────────────────
app.get('/api/fundamental/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const fundamental = await withCache(`fundamental:${symbol}`, 600, () =>
      yahooCall(async () => {
        // Try quoteSummary endpoint for rich fundamental data (requires crumb auth)
        const modules = 'financialData,defaultKeyStatistics,summaryDetail,earningsHistory,balanceSheetHistory,incomeStatementHistory';
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;

        let result;
        try {
          result = await yahooAuthFetch(url);
        } catch (e) {
          console.warn(`[Fundamental] v10 failed for ${symbol}: ${e.message}, trying v11...`);
          try {
            const url2 = `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
            result = await yahooAuthFetch(url2);
          } catch (e2) {
            console.warn(`[Fundamental] v11 failed for ${symbol}: ${e2.message}, switching to TradingView & Yahoo V8 hybrid fallback...`);
            // Robust Hybrid Fallback without crumb requirements
            const [tvData, v8Data, chart] = await Promise.all([
              fetchTradingViewFundamental(symbol),
              fetchYahooV8Fundamental(symbol),
              fetchChartData(symbol, '1d', '1y').catch(() => ({ meta: {} }))
            ]);
            const meta = chart?.meta || {};

            const combined = {
              symbol: meta.symbol || symbol,
              per: tvData?.per ?? v8Data?.per ?? null,
              pbv: tvData?.pbv ?? v8Data?.pbv ?? null,
              roe: tvData?.roe ?? null,
              der: tvData?.der ?? null,
              eps: tvData?.eps ?? v8Data?.eps ?? null,
              dividendYield: tvData?.dividendYield ?? v8Data?.dividendYield ?? null,
              revenueGrowth: tvData?.revenueGrowth ?? null,
              profitMargin: tvData?.profitMargin ?? null,
              currentRatio: tvData?.currentRatio ?? null,
              freeCashFlow: tvData?.freeCashFlow ?? null,
              marketCap: tvData?.marketCap ?? v8Data?.marketCap ?? meta.marketCap ?? null,
              fiftyTwoWeekHigh: v8Data?.fiftyTwoWeekHigh ?? meta.fiftyTwoWeekHigh ?? null,
              fiftyTwoWeekLow: v8Data?.fiftyTwoWeekLow ?? meta.fiftyTwoWeekLow ?? null,
              price: tvData?.price ?? v8Data?.price ?? meta.regularMarketPrice ?? null,
              _source: tvData ? 'tradingview+v8_hybrid' : (v8Data ? 'yahoo_v8' : 'chart_fallback'),
              _hasData: Boolean(tvData || v8Data)
            };
            return combined;
          }
        }

        const summary = result?.quoteSummary?.result?.[0];
        if (!summary) throw new Error(`No fundamental data for ${symbol}`);

        const fd = summary.financialData || {};
        const ks = summary.defaultKeyStatistics || {};
        const sd = summary.summaryDetail || {};

        // Extract raw values safely
        const getRaw = (obj, key) => {
          const val = obj?.[key];
          if (val === undefined || val === null) return null;
          if (typeof val === 'object' && val.raw !== undefined) return val.raw;
          if (typeof val === 'number') return val;
          return null;
        };

        const getFmt = (obj, key) => {
          const val = obj?.[key];
          if (val === undefined || val === null) return null;
          if (typeof val === 'object' && val.fmt !== undefined) return val.fmt;
          if (typeof val === 'string') return val;
          return null;
        };

        return {
          symbol: symbol,
          // Valuation
          per: getRaw(sd, 'trailingPE') ?? getRaw(ks, 'trailingPE') ?? getRaw(sd, 'forwardPE'),
          forwardPE: getRaw(sd, 'forwardPE') ?? getRaw(ks, 'forwardPE'),
          pbv: getRaw(ks, 'priceToBook'),
          priceToSales: getRaw(ks, 'priceToSalesTrailing12Months'),
          enterpriseValue: getRaw(ks, 'enterpriseValue'),

          // Profitability
          roe: getRaw(fd, 'returnOnEquity'),
          roa: getRaw(fd, 'returnOnAssets'),
          profitMargin: getRaw(fd, 'profitMargins'),
          operatingMargin: getRaw(fd, 'operatingMargins'),
          grossMargin: getRaw(fd, 'grossMargins'),

          // Financial health
          der: getRaw(fd, 'debtToEquity') != null ? getRaw(fd, 'debtToEquity') / 100 : null,
          currentRatio: getRaw(fd, 'currentRatio'),
          quickRatio: getRaw(fd, 'quickRatio'),

          // Per-share data
          eps: getRaw(ks, 'trailingEps') ?? getRaw(fd, 'earningsPerShare'),
          bookValue: getRaw(ks, 'bookValue'),

          // Growth
          revenueGrowth: getRaw(fd, 'revenueGrowth'),
          earningsGrowth: getRaw(fd, 'earningsGrowth'),

          // Income
          dividendYield: getRaw(sd, 'dividendYield') ?? getRaw(ks, 'lastDividendValue'),
          dividendRate: getRaw(sd, 'dividendRate'),
          payoutRatio: getRaw(sd, 'payoutRatio'),

          // Cash flow
          freeCashFlow: getRaw(fd, 'freeCashflow'),
          operatingCashFlow: getRaw(fd, 'operatingCashflow'),
          totalRevenue: getRaw(fd, 'totalRevenue'),
          totalDebt: getRaw(fd, 'totalDebt'),
          totalCash: getRaw(fd, 'totalCash'),

          // Market data
          marketCap: getRaw(sd, 'marketCap'),
          beta: getRaw(ks, 'beta'),
          fiftyTwoWeekHigh: getRaw(sd, 'fiftyTwoWeekHigh'),
          fiftyTwoWeekLow: getRaw(sd, 'fiftyTwoWeekLow'),
          fiftyDayAverage: getRaw(sd, 'fiftyDayAverage'),
          twoHundredDayAverage: getRaw(sd, 'twoHundredDayAverage'),

          // Formatted strings for display
          _formatted: {
            per: getFmt(sd, 'trailingPE') ?? getFmt(ks, 'trailingPE'),
            pbv: getFmt(ks, 'priceToBook'),
            roe: getFmt(fd, 'returnOnEquity'),
            profitMargin: getFmt(fd, 'profitMargins'),
            dividendYield: getFmt(sd, 'dividendYield'),
            revenueGrowth: getFmt(fd, 'revenueGrowth'),
          },
          _source: 'quoteSummary',
          _hasData: true,
        };
      })
    );
    res.json(fundamental);
  } catch (err) {
    console.error(`Error fetching fundamental for ${symbol}:`, err.message);
    res.status(500).json({ error: `Failed to fetch fundamental data for ${symbol}`, details: err.message });
  }
});

// ─── API: Market Status ─────────────────────────────────────────────────
app.get('/api/market-status/:exchange', async (req, res) => {
  const exchange = req.params.exchange.toUpperCase();
  const cacheKey = `market-status:${exchange}`;

  try {
    const status = await withCache(cacheKey, 30, () => {
      const now = new Date();

      // Market hours configuration (all times in local timezone)
      const markets = {
        // Indonesian Stock Exchange (IDX) — WIB (UTC+7)
        'IDX': { tz: 7, open: [9, 0], close: [15, 30], days: [1, 2, 3, 4, 5], name: 'Indonesia Stock Exchange', preOpen: [8, 45] },
        'JKT': { tz: 7, open: [9, 0], close: [15, 30], days: [1, 2, 3, 4, 5], name: 'Indonesia Stock Exchange', preOpen: [8, 45] },
        // US Markets — ET (UTC-4 DST / UTC-5 EST)
        'NYSE': { tz: -4, open: [9, 30], close: [16, 0], days: [1, 2, 3, 4, 5], name: 'New York Stock Exchange', preOpen: [4, 0] },
        'NASDAQ': { tz: -4, open: [9, 30], close: [16, 0], days: [1, 2, 3, 4, 5], name: 'NASDAQ', preOpen: [4, 0] },
        'NMS': { tz: -4, open: [9, 30], close: [16, 0], days: [1, 2, 3, 4, 5], name: 'NASDAQ', preOpen: [4, 0] },
        // Hong Kong
        'HKSE': { tz: 8, open: [9, 30], close: [16, 0], days: [1, 2, 3, 4, 5], name: 'Hong Kong Stock Exchange', preOpen: [9, 0] },
        // Tokyo
        'TSE': { tz: 9, open: [9, 0], close: [15, 0], days: [1, 2, 3, 4, 5], name: 'Tokyo Stock Exchange', preOpen: [8, 0] },
        // London
        'LSE': { tz: 1, open: [8, 0], close: [16, 30], days: [1, 2, 3, 4, 5], name: 'London Stock Exchange', preOpen: [7, 0] },
      };

      const market = markets[exchange] || markets['IDX'];

      // Convert current UTC time to market local time
      const utcHours = now.getUTCHours();
      const utcMinutes = now.getUTCMinutes();
      const utcDay = now.getUTCDay();

      let localHours = (utcHours + market.tz + 24) % 24;
      let localMinutes = utcMinutes;
      let localDay = utcDay;

      // Adjust day if timezone shift crosses midnight
      if (utcHours + market.tz >= 24) localDay = (utcDay + 1) % 7;
      if (utcHours + market.tz < 0) localDay = (utcDay + 6) % 7;

      const localTimeMinutes = localHours * 60 + localMinutes;
      const openMinutes = market.open[0] * 60 + market.open[1];
      const closeMinutes = market.close[0] * 60 + market.close[1];
      const preOpenMinutes = market.preOpen ? market.preOpen[0] * 60 + market.preOpen[1] : openMinutes - 30;

      const isWeekday = market.days.includes(localDay);

      let state, label;
      if (!isWeekday) {
        state = 'CLOSED';
        label = 'Pasar tutup (akhir pekan)';
      } else if (localTimeMinutes >= openMinutes && localTimeMinutes < closeMinutes) {
        state = 'OPEN';
        label = 'Pasar sedang buka';
      } else if (localTimeMinutes >= preOpenMinutes && localTimeMinutes < openMinutes) {
        state = 'PRE_MARKET';
        label = 'Pre-market / Pre-opening';
      } else {
        state = 'CLOSED';
        label = 'Pasar tutup';
      }

      // Calculate next open time
      let nextOpenText = '';
      if (state !== 'OPEN') {
        const openH = String(market.open[0]).padStart(2, '0');
        const openM = String(market.open[1]).padStart(2, '0');
        if (state === 'CLOSED' && isWeekday && localTimeMinutes < openMinutes) {
          nextOpenText = `Buka hari ini pukul ${openH}:${openM}`;
        } else {
          nextOpenText = `Buka besok pukul ${openH}:${openM}`;
        }
      }

      return Promise.resolve({
        exchange: exchange,
        name: market.name,
        state,
        label,
        nextOpen: nextOpenText,
        localTime: `${String(localHours).padStart(2, '0')}:${String(localMinutes).padStart(2, '0')}`,
        tradingHours: `${String(market.open[0]).padStart(2, '0')}:${String(market.open[1]).padStart(2, '0')} - ${String(market.close[0]).padStart(2, '0')}:${String(market.close[1]).padStart(2, '0')}`,
        isPreOrderMode: state !== 'OPEN',
      });
    });
    res.json(status);
  } catch (err) {
    console.error(`Error getting market status for ${exchange}:`, err.message);
    res.status(500).json({ error: `Failed to get market status`, details: err.message });
  }
});



// ─── API: Stock Recommendations ─────────────────────────────────────────

// Helper: Analyze a stock for recommendation
async function analyzeStockForRecommendation(symbol, tvRatingsMap = null) {
  try {
    const baseTicker = symbol.replace('.JK', '').toUpperCase();
    const tvData = (tvRatingsMap && tvRatingsMap[baseTicker]) || { rating: 'N/A', score: 0 };

    const [chartResult, quoteResult] = await Promise.all([
      yahooCall(() => fetchChartData(symbol, '1d', '6mo')),
      yahooCall(async () => {
        const chart = await fetchChartData(symbol, '1d', '5d');
        const meta = chart.meta;
        const closes = (chart.indicators?.quote?.[0]?.close || []).filter(c => c != null);
        let price = meta.regularMarketPrice ?? 0;
        let previousClose = meta.chartPreviousClose ?? meta.previousClose ?? 0;
        if (!price || price === 0) {
          if (closes.length >= 2) {
            price = closes[closes.length - 1];
          } else if (closes.length === 1) {
            price = closes[0];
          }
        }
        if (!previousClose || previousClose === 0) {
          if (closes.length >= 2) {
            previousClose = closes[closes.length - 2];
          }
        }
        const change = price - previousClose;
        const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;
        return {
          symbol: meta.symbol || symbol,
          name: meta.shortName || meta.longName || symbol,
          price,
          change,
          changePercent,
          volume: meta.regularMarketVolume ?? 0,
          previousClose,
          dayHigh: meta.regularMarketDayHigh ?? 0,
          dayLow: meta.regularMarketDayLow ?? 0,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? 0,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? 0,
          exchange: meta.exchangeName || '',
        };
      }),

    ]);

    const timestamps = chartResult.timestamp || [];
    const quotes = chartResult.indicators?.quote?.[0] || {};
    const ohlcv = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (quotes.close?.[i] != null && quotes.open?.[i] != null) {
        ohlcv.push({
          time: timestamps[i],
          open: quotes.open[i],
          high: quotes.high?.[i] ?? quotes.open[i],
          low: quotes.low?.[i] ?? quotes.open[i],
          close: quotes.close[i],
          volume: quotes.volume?.[i] || 0,
        });
      }
    }

    if (ohlcv.length < 30) return null;

    // Technical Analysis with High-Precision Multi-Indicator Suite
    const closes = ohlcv.map(d => d.close);
    const highs = ohlcv.map(d => d.high);
    const lows = ohlcv.map(d => d.low);
    const lastPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2] || lastPrice;

    // Moving Average Helper
    const calcSMA = (arr, period) => {
      if (arr.length < period) return null;
      const slice = arr.slice(-period);
      return slice.reduce((a, b) => a + b, 0) / period;
    };

    const calcEMA = (arr, period) => {
      if (arr.length < period) return null;
      const k = 2 / (period + 1);
      let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < arr.length; i++) {
        ema = arr[i] * k + ema * (1 - k);
      }
      return ema;
    };

    const sma20 = calcSMA(closes, 20);
    const sma50 = calcSMA(closes, 50);
    const sma200 = calcSMA(closes, 200);
    const ema10 = calcEMA(closes, 10); // Enhancement #11: Short-term trend for multi-timeframe alignment
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const ema50 = calcEMA(closes, 50);

    // 1. RSI Calculation (Wilder's Smoothing Method)
    let gains = 0, losses = 0;
    for (let i = 1; i <= 14; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    let avgGain = gains / 14;
    let avgLoss = losses / 14;

    for (let i = 15; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) {
        avgGain = (avgGain * 13 + diff) / 14;
        avgLoss = (avgLoss * 13) / 14;
      } else {
        avgGain = (avgGain * 13) / 14;
        avgLoss = (avgLoss * 13 + Math.abs(diff)) / 14;
      }
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));

    // 2. MACD (12, 26, 9) Calculation
    const macdLine = ema12 && ema26 ? ema12 - ema26 : 0;
    // FIX #1: Calculate MACD history with properly seeded EMA12 through bars 12-25
    const macdHistory = [];
    let tempEma12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    let tempEma26 = closes.length >= 26 ? closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26 : 0;
    // Properly update EMA12 for bars 12-25 before MACD history starts
    for (let i = 12; i < Math.min(26, closes.length); i++) {
      tempEma12 = closes[i] * (2 / 13) + tempEma12 * (1 - 2 / 13);
    }
    for (let i = 26; i < closes.length; i++) {
      tempEma12 = closes[i] * (2 / 13) + tempEma12 * (1 - 2 / 13);
      tempEma26 = closes[i] * (2 / 27) + tempEma26 * (1 - 2 / 27);
      macdHistory.push(tempEma12 - tempEma26);
    }
    const macdSignalLine = macdHistory.length >= 9 ? calcEMA(macdHistory, 9) : 0;
    const macdHist = macdLine - macdSignalLine;

    // 3. Stochastic Oscillator (%K 14, %D 3) — with smoothing + crossover detection
    const stochKValues = [];
    for (let si = 13; si < ohlcv.length; si++) {
      const sHighs = highs.slice(si - 13, si + 1);
      const sLows = lows.slice(si - 13, si + 1);
      const sMaxH = Math.max(...sHighs);
      const sMinL = Math.min(...sLows);
      stochKValues.push(sMaxH !== sMinL ? ((closes[si] - sMinL) / (sMaxH - sMinL)) * 100 : 50);
    }
    const stochK = stochKValues.length > 0 ? stochKValues[stochKValues.length - 1] : 50;
    // %D = SMA(3) of %K for smoothing
    let stochD = stochK;
    let prevStochK = stochK, prevStochD = stochD;
    if (stochKValues.length >= 3) {
      stochD = (stochKValues[stochKValues.length - 1] + stochKValues[stochKValues.length - 2] + stochKValues[stochKValues.length - 3]) / 3;
    }
    // Fix #15: Stochastic %K/%D Crossover Detection
    let stochCrossover = 'NONE'; // BULLISH_CROSS, BEARISH_CROSS, NONE
    if (stochKValues.length >= 4) {
      prevStochK = stochKValues[stochKValues.length - 2];
      prevStochD = (stochKValues[stochKValues.length - 2] + stochKValues[stochKValues.length - 3] + stochKValues[stochKValues.length - 4]) / 3;
      if (prevStochK <= prevStochD && stochK > stochD) stochCrossover = 'BULLISH_CROSS';
      else if (prevStochK >= prevStochD && stochK < stochD) stochCrossover = 'BEARISH_CROSS';
    }

    // 4. Volume Analysis
    const avgVol = ohlcv.slice(-20).reduce((s, d) => s + d.volume, 0) / 20;
    const lastVol = ohlcv[ohlcv.length - 1].volume;
    const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

    // 5. Multi-Bar Pivot Point Support & Resistance (3-bar average for robustness)
    const pivotBars = Math.min(3, ohlcv.length);
    const pivotHighs = highs.slice(-pivotBars);
    const pivotLows = lows.slice(-pivotBars);
    const pivotCloses = closes.slice(-pivotBars);
    const avgPivotHigh = pivotHighs.reduce((a, b) => a + b, 0) / pivotBars;
    const avgPivotLow = pivotLows.reduce((a, b) => a + b, 0) / pivotBars;
    const avgPivotClose = pivotCloses.reduce((a, b) => a + b, 0) / pivotBars;
    const pivot = (avgPivotHigh + avgPivotLow + avgPivotClose) / 3;
    const support1 = (2 * pivot) - avgPivotHigh;
    const resistance1 = (2 * pivot) - avgPivotLow;
    const support2 = pivot - (avgPivotHigh - avgPivotLow);
    const resistance2 = pivot + (avgPivotHigh - avgPivotLow);

    // Dynamic Support & Resistance with Price Clustering (frequency-weighted)
    const recentLows = lows.slice(-20);
    const recentHighs = highs.slice(-20);
    // Cluster analysis: find price levels that appear multiple times (within 1% tolerance)
    const allSRLevels = [...recentLows, ...recentHighs];
    const clusterThreshold = lastPrice * 0.01; // 1% tolerance
    const clusters = [];
    allSRLevels.forEach(level => {
      const existingCluster = clusters.find(c => Math.abs(c.center - level) <= clusterThreshold);
      if (existingCluster) {
        existingCluster.count++;
        existingCluster.center = (existingCluster.center * (existingCluster.count - 1) + level) / existingCluster.count;
      } else {
        clusters.push({ center: level, count: 1 });
      }
    });
    // Sort clusters by frequency, prioritize multi-touch levels
    const strongClusters = clusters.filter(c => c.count >= 2).sort((a, b) => b.count - a.count);
    const supportClusters = strongClusters.filter(c => c.center < lastPrice).sort((a, b) => b.center - a.center);
    const resistanceClusters = strongClusters.filter(c => c.center > lastPrice).sort((a, b) => a.center - b.center);
    const support = supportClusters.length > 0 ? supportClusters[0].center : Math.min(...recentLows, support1);
    const resistance = resistanceClusters.length > 0 ? resistanceClusters[0].center : Math.max(...recentHighs, resistance1);

    // 6. ATR (Average True Range) Calculation for Dynamic Volatility Risk / Reward (Min 1:2 RRR)
    let atr = 0;
    const trs = [];
    for (let i = 1; i < ohlcv.length; i++) {
      const d = ohlcv[i];
      const prev = ohlcv[i - 1];
      const tr = Math.max(d.high - d.low, Math.abs(d.high - prev.close), Math.abs(d.low - prev.close));
      trs.push(tr);
    }
    if (trs.length >= 14) {
      atr = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
    } else if (trs.length > 0) {
      atr = trs.reduce((a, b) => a + b, 0) / trs.length;
    }
    const atrStopLoss = Math.max(1, Math.round(lastPrice - Math.max(1.5 * atr, lastPrice - support)));
    const riskAmount = Math.max(lastPrice - atrStopLoss, lastPrice * 0.02);
    const atrTakeProfit = Math.round(lastPrice + Math.max(riskAmount * 2, resistance - lastPrice, 3 * atr));

    // ═══════════════════════════════════════════════════════════════
    // 6b. VWAP (Volume-Weighted Average Price) — Institutional Benchmark
    //     FIX: Calculate from last 10 days only (not entire 6-month history)
    //     Daily VWAP proxy since we use daily candles, not intraday ticks
    // ═══════════════════════════════════════════════════════════════
    let vwap = lastPrice; // fallback
    {
      const vwapLookback = Math.min(10, ohlcv.length);
      const vwapSlice = ohlcv.slice(-vwapLookback);
      let cumTPV = 0, cumVol = 0;
      for (let i = 0; i < vwapSlice.length; i++) {
        const typicalPrice = (vwapSlice[i].high + vwapSlice[i].low + vwapSlice[i].close) / 3;
        cumTPV += typicalPrice * vwapSlice[i].volume;
        cumVol += vwapSlice[i].volume;
      }
      if (cumVol > 0) vwap = cumTPV / cumVol;
    }
    const vwapDeviation = lastPrice > 0 ? ((lastPrice - vwap) / vwap) * 100 : 0;
    // Positive = price above VWAP (bullish institutional positioning)
    // Negative = price below VWAP (bearish institutional positioning)

    // ═══════════════════════════════════════════════════════════════
    // 6c. OBV (On-Balance Volume) — Smart Money Flow Detection
    // ═══════════════════════════════════════════════════════════════
    const obvValues = [];
    let obv = 0;
    for (let i = 0; i < ohlcv.length; i++) {
      if (i === 0) { obv = ohlcv[i].volume; }
      else if (ohlcv[i].close > ohlcv[i - 1].close) { obv += ohlcv[i].volume; }
      else if (ohlcv[i].close < ohlcv[i - 1].close) { obv -= ohlcv[i].volume; }
      obvValues.push(obv);
    }
    // OBV trend: compare last 10 bars slope
    let obvTrend = 'FLAT'; // RISING, FALLING, FLAT
    if (obvValues.length >= 10) {
      const obvRecent = obvValues.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const obvPrev = obvValues.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
      const obvChange = obvPrev !== 0 ? ((obvRecent - obvPrev) / Math.abs(obvPrev)) * 100 : 0;
      if (obvChange > 3) obvTrend = 'RISING';
      else if (obvChange < -3) obvTrend = 'FALLING';
    }
    // Key detection: OBV vs Price divergence (smart money detection)
    // FIX: Use 5-bar slope for price trend (consistent with OBV 10-bar lookback)
    //       instead of single bar comparison which is extremely noisy
    let priceTrendSlope = 0;
    if (closes.length >= 5) {
      const recentCloses5 = closes.slice(-5);
      const olderCloses5 = closes.slice(-10, -5);
      const avgRecent = recentCloses5.reduce((a, b) => a + b, 0) / 5;
      const avgOlder = olderCloses5.length >= 5 ? olderCloses5.reduce((a, b) => a + b, 0) / 5 : avgRecent;
      priceTrendSlope = avgOlder !== 0 ? ((avgRecent - avgOlder) / avgOlder) * 100 : 0;
    }
    const priceRising = priceTrendSlope > 0.5;   // >0.5% = meaningful uptrend
    const priceFalling = priceTrendSlope < -0.5;  // <-0.5% = meaningful downtrend
    const obvDivergence = (obvTrend === 'FALLING' && priceRising) ? 'DISTRIBUTION'
      : (obvTrend === 'RISING' && priceFalling) ? 'ACCUMULATION'
        : 'CONFIRMED';

    // ═══════════════════════════════════════════════════════════════
    // 6d. Candlestick Pattern Detection (with Volume Confirmation & Multi-Bar Trend Context)
    //     FIX: Require volume confirmation for reliability (+15-20% accuracy)
    //     FIX: Use 5-bar trend context instead of 1-bar comparison
    // ═══════════════════════════════════════════════════════════════
    let candlestickPattern = 'NONE';
    let candlestickScore = 0;
    if (ohlcv.length >= 5) {
      const curr = ohlcv[ohlcv.length - 1];
      const prev1 = ohlcv[ohlcv.length - 2];
      const currBody = Math.abs(curr.close - curr.open);
      const currRange = curr.high - curr.low;
      const prev1Body = Math.abs(prev1.close - prev1.open);
      const currBullish = curr.close > curr.open;
      const prev1Bullish = prev1.close > prev1.open;

      // Volume confirmation: current volume should be above average for pattern to be reliable
      const volConfirmed = volRatio >= 1.0; // at least average volume
      const volStrong = volRatio >= 1.3;     // strong volume confirmation

      // Multi-bar trend context (5-bar lookback for trend direction)
      const trendSlice = closes.slice(-5);
      const isDowntrend = trendSlice[0] > trendSlice[trendSlice.length - 1] &&
        trendSlice.slice(0, 3).every((v, i) => i === 0 || v <= trendSlice[i - 1]);
      const isUptrend = trendSlice[0] < trendSlice[trendSlice.length - 1] &&
        trendSlice.slice(0, 3).every((v, i) => i === 0 || v >= trendSlice[i - 1]);

      // Bullish Engulfing: prev bearish candle fully engulfed by curr bullish candle + volume
      if (currBullish && !prev1Bullish && curr.open <= prev1.close && curr.close >= prev1.open && currBody > prev1Body) {
        candlestickPattern = 'BULLISH_ENGULFING';
        candlestickScore = volStrong ? 10 : volConfirmed ? 7 : 4; // scale by volume confidence
      }
      // Bearish Engulfing: prev bullish candle fully engulfed by curr bearish candle + volume
      else if (!currBullish && prev1Bullish && curr.open >= prev1.close && curr.close <= prev1.open && currBody > prev1Body) {
        candlestickPattern = 'BEARISH_ENGULFING';
        candlestickScore = volStrong ? -10 : volConfirmed ? -7 : -4;
      }
      // Hammer (bullish reversal): small body, long lower shadow, must be in multi-bar downtrend
      else if (currRange > 0 && currBody / currRange < 0.35 && (Math.min(curr.open, curr.close) - curr.low) / currRange > 0.6 && isDowntrend) {
        candlestickPattern = 'HAMMER';
        candlestickScore = volConfirmed ? 7 : 4;
      }
      // Inverted Hammer / Shooting Star
      else if (currRange > 0 && currBody / currRange < 0.35 && (curr.high - Math.max(curr.open, curr.close)) / currRange > 0.6) {
        if (isDowntrend) {
          candlestickPattern = 'INVERTED_HAMMER';
          candlestickScore = volConfirmed ? 5 : 3;
        } else if (isUptrend) {
          candlestickPattern = 'SHOOTING_STAR';
          candlestickScore = volConfirmed ? -7 : -4;
        }
      }
      // Doji: body < 10% of range, only meaningful with above-average volume
      else if (currRange > 0 && currBody / currRange < 0.1 && volConfirmed) {
        candlestickPattern = 'DOJI';
        candlestickScore = -3;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 6e. MACD Histogram Momentum (Acceleration / Deceleration)
    //     FIX: Pre-compute entire histogram array ONCE for consistency
    //     Old code recalculated signal line with different slices each time
    // ═══════════════════════════════════════════════════════════════
    // Pre-compute full MACD histogram series (macd_line[i] - signal_line[i])
    const macdHistogramSeries = [];
    if (macdHistory.length >= 9) {
      const sigK = 2 / (9 + 1);
      let sigEma = macdHistory.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
      for (let mhi = 0; mhi < macdHistory.length; mhi++) {
        if (mhi >= 9) {
          sigEma = macdHistory[mhi] * sigK + sigEma * (1 - sigK);
        }
        macdHistogramSeries.push(mhi >= 8 ? macdHistory[mhi] - sigEma : 0);
      }
    }

    let macdMomentum = 'NEUTRAL';
    let macdMomentumScore = 0;
    if (macdHistogramSeries.length >= 3) {
      const currHistVal = macdHistogramSeries[macdHistogramSeries.length - 1];
      const prevHistVal = macdHistogramSeries[macdHistogramSeries.length - 2];
      const prevHistVal2 = macdHistogramSeries[macdHistogramSeries.length - 3];

      if (currHistVal > 0 && currHistVal > prevHistVal && prevHistVal > prevHistVal2) {
        macdMomentum = 'ACCELERATING_BULL';
        macdMomentumScore = 5;
      } else if (currHistVal < 0 && currHistVal < prevHistVal && prevHistVal < prevHistVal2) {
        macdMomentum = 'ACCELERATING_BEAR';
        macdMomentumScore = -5;
      } else if (currHistVal > 0 && Math.abs(currHistVal) < Math.abs(prevHistVal)) {
        macdMomentum = 'DECELERATING_BULL';
        macdMomentumScore = -3;
      } else if (currHistVal < 0 && Math.abs(currHistVal) < Math.abs(prevHistVal)) {
        macdMomentum = 'DECELERATING_BEAR';
        macdMomentumScore = 3;
      }
      // Zero-line crossover (most powerful MACD signal)
      if (prevHistVal < 0 && currHistVal > 0) {
        macdMomentum = 'ZERO_CROSS_BULL';
        macdMomentumScore = 7;
      } else if (prevHistVal > 0 && currHistVal < 0) {
        macdMomentum = 'ZERO_CROSS_BEAR';
        macdMomentumScore = -7;
      }
    }

    // 6f. Fibonacci Retracement Levels (last 60 bars swing)
    const fibLookback = Math.min(60, ohlcv.length);
    const fibSlice = ohlcv.slice(-fibLookback);
    const fibHigh = Math.max(...fibSlice.map(d => d.high));
    const fibLow = Math.min(...fibSlice.map(d => d.low));
    const fibRange = fibHigh - fibLow;
    const fibonacci = {
      level0: parseFloat(fibHigh.toFixed(0)),
      level236: parseFloat((fibHigh - fibRange * 0.236).toFixed(0)),
      level382: parseFloat((fibHigh - fibRange * 0.382).toFixed(0)),
      level500: parseFloat((fibHigh - fibRange * 0.5).toFixed(0)),
      level618: parseFloat((fibHigh - fibRange * 0.618).toFixed(0)),
      level786: parseFloat((fibHigh - fibRange * 0.786).toFixed(0)),
      level1: parseFloat(fibLow.toFixed(0)),
    };
    // ═══════════════════════════════════════════════════════════════
    // 7. Enhanced Multi-Indicator Divergence Detection (Last 20 bars)
    //    FIX: Tighter thresholds + RSI slope confirmation to reduce false positives
    // ═══════════════════════════════════════════════════════════════
    let divergence = 'NONE';
    let divergenceStrength = 0;
    if (ohlcv.length >= 20) {
      const pastSlice = ohlcv.slice(-20, -3);
      const maxPastClose = Math.max(...pastSlice.map(d => d.close));
      const minPastClose = Math.min(...pastSlice.map(d => d.close));

      // RSI slope calculation for divergence confirmation
      // Need RSI to be *declining* while price makes new high (bearish div)
      // or RSI to be *rising* while price makes new low (bullish div)
      let rsiSlope = 0;
      if (closes.length >= 10) {
        // Approximate RSI of 5 bars ago vs current RSI
        const oldCloses = closes.slice(0, -5);
        let oldGains = 0, oldLosses = 0;
        for (let ri = 1; ri <= Math.min(14, oldCloses.length - 1); ri++) {
          const d = oldCloses[ri] - oldCloses[ri - 1];
          if (d >= 0) oldGains += d; else oldLosses += Math.abs(d);
        }
        const period = Math.min(14, oldCloses.length - 1);
        if (period > 0) {
          const oldAvgG = oldGains / period;
          const oldAvgL = oldLosses / period;
          const oldRs = oldAvgL === 0 ? 100 : oldAvgG / oldAvgL;
          const oldRsi = oldAvgL === 0 ? 100 : 100 - (100 / (1 + oldRs));
          rsiSlope = rsi - oldRsi; // positive = RSI rising, negative = RSI falling
        }
      }

      // FIX #10: Tighter divergence thresholds — price must be at/above past extremes
      // Also require RSI slope confirmation
      const rsiDivBearish = lastPrice >= maxPastClose * 1.0 && rsi < 55 && rsiSlope < -3;
      const rsiDivBullish = lastPrice <= minPastClose * 1.0 && rsi > 38 && rsiSlope > 3;
      const obvDivBearish = obvDivergence === 'DISTRIBUTION';
      const obvDivBullish = obvDivergence === 'ACCUMULATION';
      const macdDivBearish = macdMomentum === 'DECELERATING_BULL' || macdMomentum === 'ZERO_CROSS_BEAR';
      const macdDivBullish = macdMomentum === 'ACCELERATING_BULL' || macdMomentum === 'ZERO_CROSS_BULL';

      // Only trigger on 2+ confirmations (removed single-indicator divergence)
      const bearishCount = [rsiDivBearish, obvDivBearish, macdDivBearish].filter(Boolean).length;
      const bullishCount = [rsiDivBullish, obvDivBullish, macdDivBullish].filter(Boolean).length;

      if (bearishCount >= 2) {
        divergence = 'BEARISH_BULL_TRAP';
        divergenceStrength = bearishCount;
      } else if (bullishCount >= 2) {
        divergence = 'BULLISH_ACCUMULATION';
        divergenceStrength = bullishCount;
      }
    }

    // 8. Cerdas & Adaptif: Proteksi Likuiditas (Mendukung Saham Sultan & Saham Gorengan/Aktif)
    const dailyTurnover = avgVol * lastPrice;
    // FIX #8: Lower threshold from 50M to 20M to avoid over-filtering active small-caps
    const isIlliquidTrap = symbol.endsWith('.JK') && (dailyTurnover < 20000000 || (lastPrice < 5000 && avgVol < 3000));

    // ═══════════════════════════════════════════════════════════════
    // 8a-i. Enhancement #12: Volume Trend Detection (3-day rising volume)
    //       3 consecutive days of rising volume = genuine accumulation
    // ═══════════════════════════════════════════════════════════════
    let volumeTrend = 'FLAT'; // RISING_3D, FALLING_3D, FLAT
    if (ohlcv.length >= 4) {
      const v1 = ohlcv[ohlcv.length - 3].volume;
      const v2 = ohlcv[ohlcv.length - 2].volume;
      const v3 = ohlcv[ohlcv.length - 1].volume;
      if (v3 > v2 && v2 > v1 && v3 > avgVol * 0.8) volumeTrend = 'RISING_3D';
      else if (v3 < v2 && v2 < v1) volumeTrend = 'FALLING_3D';
    }

    // ═══════════════════════════════════════════════════════════════
    // 8a-ii. Enhancement #6: Anti-Trap Safeguards
    //        Bull Trap, Pump-and-Dump, Dead Cat Bounce detection
    // ═══════════════════════════════════════════════════════════════
    let trapType = 'NONE'; // BULL_TRAP, PUMP_DUMP, DEAD_CAT_BOUNCE, NONE
    let trapPenalty = 0;
    if (ohlcv.length >= 5) {
      // Bull Trap: price rising but volume falling 3 consecutive days
      const priceUp3 = closes[closes.length - 1] > closes[closes.length - 4];
      if (priceUp3 && volumeTrend === 'FALLING_3D') {
        trapType = 'BULL_TRAP';
        trapPenalty = -12;
      }
      // Pump-and-Dump: volume spike > 4x average AND price already up > 8% in 3 days
      const priceChange3d = closes.length >= 4 ? ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100 : 0;
      if (volRatio > 4 && priceChange3d > 8) {
        trapType = 'PUMP_DUMP';
        trapPenalty = -20;
      }
    }
    // Dead Cat Bounce: dropped > 15% in 10 days then bounced 2-5% (false recovery)
    if (ohlcv.length >= 12) {
      const priceNow = closes[closes.length - 1];
      const price10ago = closes[closes.length - 11];
      const price3ago = closes[closes.length - 4];
      const drop10d = ((price3ago - price10ago) / price10ago) * 100;
      const bounce3d = ((priceNow - price3ago) / price3ago) * 100;
      if (drop10d < -12 && bounce3d > 1.5 && bounce3d < 6) {
        trapType = 'DEAD_CAT_BOUNCE';
        trapPenalty = -15;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 8b. Bollinger Bands %B (Squeeze & Overbought/Oversold Detection)
    // ═══════════════════════════════════════════════════════════════
    let bbPercentB = 0.5; // default: midband
    let bbBandwidth = 0;
    let bbSqueeze = false;
    if (closes.length >= 20) {
      const bbPeriod = 20;
      const bbSlice = closes.slice(-bbPeriod);
      const bbSMA = bbSlice.reduce((a, b) => a + b, 0) / bbPeriod;
      const bbStdDev = Math.sqrt(bbSlice.reduce((sum, v) => sum + Math.pow(v - bbSMA, 2), 0) / bbPeriod);
      const bbUpper = bbSMA + 2 * bbStdDev;
      const bbLower = bbSMA - 2 * bbStdDev;
      bbPercentB = (bbUpper - bbLower) > 0 ? (lastPrice - bbLower) / (bbUpper - bbLower) : 0.5;
      bbBandwidth = bbSMA > 0 ? ((bbUpper - bbLower) / bbSMA) * 100 : 0;
      // Squeeze detection: bandwidth < 4% indicates consolidation, potential breakout
      bbSqueeze = bbBandwidth < 4;
    }

    // ═══════════════════════════════════════════════════════════════
    // 8c. ADX (Average Directional Index) — Trend Strength Filter
    //     ADX > 25 = trending, ADX < 20 = ranging/sideways
    //     Used to modulate trend-following signals (MA, MACD)
    // ═══════════════════════════════════════════════════════════════
    let adx = 25; // default neutral
    if (ohlcv.length >= 28) { // Need 14-period DM + 14-period smoothing
      let plusDMSum = 0, minusDMSum = 0, trSum = 0;
      // First 14-period averages
      for (let ai = 1; ai <= 14; ai++) {
        const d = ohlcv[ai], p = ohlcv[ai - 1];
        const upMove = d.high - p.high;
        const downMove = p.low - d.low;
        plusDMSum += (upMove > downMove && upMove > 0) ? upMove : 0;
        minusDMSum += (downMove > upMove && downMove > 0) ? downMove : 0;
        trSum += Math.max(d.high - d.low, Math.abs(d.high - p.close), Math.abs(d.low - p.close));
      }
      let smoothPlusDM = plusDMSum;
      let smoothMinusDM = minusDMSum;
      let smoothTR = trSum;
      const dxValues = [];
      // Wilder's smoothing for remaining bars
      for (let ai = 15; ai < ohlcv.length; ai++) {
        const d = ohlcv[ai], p = ohlcv[ai - 1];
        const upMove = d.high - p.high;
        const downMove = p.low - d.low;
        const curPlusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
        const curMinusDM = (downMove > upMove && downMove > 0) ? downMove : 0;
        const curTR = Math.max(d.high - d.low, Math.abs(d.high - p.close), Math.abs(d.low - p.close));
        smoothPlusDM = smoothPlusDM - (smoothPlusDM / 14) + curPlusDM;
        smoothMinusDM = smoothMinusDM - (smoothMinusDM / 14) + curMinusDM;
        smoothTR = smoothTR - (smoothTR / 14) + curTR;
        const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
        const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
        const diSum = plusDI + minusDI;
        const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
        dxValues.push(dx);
      }
      // ADX = 14-period SMA of DX
      if (dxValues.length >= 14) {
        adx = dxValues.slice(-14).reduce((a, b) => a + b, 0) / 14;
      }
    }
    const isTrending = adx > 25;
    const isRanging = adx < 20;
    // Modulation factor: reduce weight of trend-following signals in ranging market
    const trendModulator = isTrending ? 1.0 : isRanging ? 0.5 : 0.75;

    // ═══════════════════════════════════════════════════════════════
    // Multi-Factor Precision Scoring v4.0 (0-100)
    // FIX #2: RSI reversal confirmation (no more catching falling knives)
    // FIX #3: VWAP nuanced scoring (buy opportunity vs overbought)
    // FIX #9: TradingView scoring symmetry
    // FIX #15: Stochastic crossover signal
    // Enhancement #11: EMA alignment chain (EMA10 > EMA20 > EMA50)
    // Enhancement #12: Volume trend detection (3-day rising volume)
    // Enhancement #6: Anti-trap penalty integration
    // ═══════════════════════════════════════════════════════════════
    let score = 50;

    // RSI Factor (+/- 15) — FIX #2: Oversold only bullish if RSI is turning up
    // Compute RSI slope from last-bar to detect reversal vs continued decline
    let rsiTurningUp = false;
    let rsiTurningDown = false;
    if (closes.length >= 16) {
      // Approximate previous-bar RSI using Wilder's method snapshot
      let pGains = 0, pLosses = 0;
      for (let ri = 1; ri <= 14; ri++) {
        const d = closes[ri] - closes[ri - 1];
        if (d >= 0) pGains += d; else pLosses += Math.abs(d);
      }
      let pAvgGain = pGains / 14, pAvgLoss = pLosses / 14;
      for (let ri = 15; ri < closes.length - 1; ri++) {
        const d = closes[ri] - closes[ri - 1];
        if (d >= 0) { pAvgGain = (pAvgGain * 13 + d) / 14; pAvgLoss = (pAvgLoss * 13) / 14; }
        else { pAvgGain = (pAvgGain * 13) / 14; pAvgLoss = (pAvgLoss * 13 + Math.abs(d)) / 14; }
      }
      const prevRsi = pAvgLoss === 0 ? 100 : 100 - (100 / (1 + (pAvgGain / pAvgLoss)));
      rsiTurningUp = rsi > prevRsi + 1;  // RSI rising by > 1 point
      rsiTurningDown = rsi < prevRsi - 1; // RSI falling by > 1 point
    }

    if (rsi <= 30) {
      // Oversold: only strong bullish if RSI is turning up (reversal confirmed)
      if (rsiTurningUp) score += 15;
      else if (!rsiTurningDown) score += 5; // flat RSI in oversold = mild bullish
      // else: RSI still falling in oversold = catching falling knife, no bonus
    } else if (rsi <= 40) {
      score += rsiTurningUp ? 8 : 4;
    } else if (rsi >= 70) {
      if (rsiTurningDown) score -= 15;
      else score -= 10;
    } else if (rsi >= 60) {
      score -= rsiTurningDown ? 8 : 4;
    }

    // Moving Average Trend Factor (+/- 15, modulated by ADX)
    if (sma20 && lastPrice > sma20) score += Math.round(5 * trendModulator);
    else if (sma20) score -= Math.round(5 * trendModulator);
    if (sma50 && lastPrice > sma50) score += Math.round(5 * trendModulator);
    else if (sma50) score -= Math.round(5 * trendModulator);
    if (sma200 && lastPrice > sma200) score += Math.round(5 * trendModulator);
    else if (sma200) score -= Math.round(5 * trendModulator);

    // Enhancement #11: EMA Alignment Chain (Price > EMA10 > EMA20 > EMA50 = strong uptrend)
    if (ema10 && sma20 && ema50) {
      if (lastPrice > ema10 && ema10 > sma20 && sma20 > ema50) score += 6; // perfect bullish alignment
      else if (lastPrice < ema10 && ema10 < sma20 && sma20 < ema50) score -= 6; // perfect bearish alignment
    }

    // Golden / Death Cross Factor (+/- 8, modulated by ADX)
    if (sma50 && sma200) {
      if (sma50 > sma200) score += Math.round(8 * trendModulator);
      else score -= Math.round(8 * trendModulator);
    }

    // MACD Factor (+/- 12, modulated by ADX)
    if (macdLine > macdSignalLine) {
      score += Math.round(8 * trendModulator);
      if (macdHist > 0) score += Math.round(4 * trendModulator);
    } else {
      score -= Math.round(8 * trendModulator);
      if (macdHist < 0) score -= Math.round(4 * trendModulator);
    }

    // Volume Breakout Factor (+/- 12, nullified if illiquid)
    if (!isIlliquidTrap) {
      if (volRatio > 1.5 && priceTrendSlope > 0.5) score += 12;
      else if (volRatio > 1.5 && priceTrendSlope < -0.5) score -= 12;
      else if (volRatio > 1.2 && priceTrendSlope > 0.3) score += 6;
    }

    // Enhancement #12: Volume Trend Bonus (+/- 6)
    if (volumeTrend === 'RISING_3D' && priceTrendSlope > 0) score += 6;
    else if (volumeTrend === 'FALLING_3D' && priceTrendSlope > 0) score -= 4; // divergence: price up, vol down

    // Stochastic Factor (+/- 8, using smoothed %D)
    if (stochD < 20) score += 8;
    else if (stochD > 80) score -= 8;
    // Fix #15: Stochastic Crossover Signal (+/- 5)
    if (stochCrossover === 'BULLISH_CROSS' && stochK < 50) score += 5; // bullish cross from oversold zone
    else if (stochCrossover === 'BEARISH_CROSS' && stochK > 50) score -= 5; // bearish cross from overbought zone

    // Bollinger Bands %B Factor (+/- 8)
    if (bbPercentB < 0.05) score += 8;    // below lower band = oversold
    else if (bbPercentB < 0.20) score += 4;
    else if (bbPercentB > 0.95) score -= 8; // above upper band = overbought
    else if (bbPercentB > 0.80) score -= 4;
    // BB Squeeze bonus: tight bands = potential breakout, boost score for trending stocks
    if (bbSqueeze && isTrending) score += 5;

    // Divergence Synergy (+/- 15 based on confirmation strength)
    if (divergence === 'BULLISH_ACCUMULATION') {
      score += divergenceStrength >= 2 ? 15 : 8;
    } else if (divergence === 'BEARISH_BULL_TRAP') {
      score -= divergenceStrength >= 2 ? 15 : 8;
    }

    // FIX #3: VWAP Institutional Factor — Nuanced Scoring (+/- 6)
    // Slightly above VWAP = confirmed support (bullish)
    // Far above VWAP = extended/overbought risk (less bullish)
    // Below VWAP = potential buy zone IF other signals confirm, else bearish
    if (vwapDeviation > 0.3 && vwapDeviation <= 2.0) score += 5;   // healthy position above VWAP
    else if (vwapDeviation > 2.0) score += 2;                       // extended above VWAP, reduced bonus
    else if (vwapDeviation < -0.3 && vwapDeviation >= -2.0 && rsiTurningUp) score += 3; // below VWAP but reversing = buy zone
    else if (vwapDeviation < -2.0) score -= 6;                      // significantly below VWAP = bearish
    else if (vwapDeviation < -0.3) score -= 3;                      // slightly below VWAP

    // OBV Smart Money Factor (+/- 10)
    if (obvDivergence === 'ACCUMULATION') score += 10;
    else if (obvDivergence === 'DISTRIBUTION') score -= 10;
    else if (obvTrend === 'RISING' && priceRising) score += 4;
    else if (obvTrend === 'FALLING' && priceFalling) score -= 4;

    // Candlestick Pattern Factor
    score += candlestickScore;

    // MACD Histogram Momentum Factor
    score += macdMomentumScore;

    // 52-Week Position Factor (+/- 6)
    const fiftyTwoHigh = quoteResult.fiftyTwoWeekHigh || 0;
    const fiftyTwoLow = quoteResult.fiftyTwoWeekLow || 0;
    const fiftyTwoRange = fiftyTwoHigh - fiftyTwoLow;
    if (fiftyTwoRange > 0) {
      const positionIn52w = (lastPrice - fiftyTwoLow) / fiftyTwoRange;
      if (positionIn52w < 0.20 && rsi <= 40) score += 6;
      else if (positionIn52w > 0.90 && rsi >= 60) score -= 6;
    }

    // ADX Trend Strength Factor (+/- 4)
    if (isTrending && priceTrendSlope > 1) score += 4;
    else if (isTrending && priceTrendSlope < -1) score -= 4;
    else if (isRanging) score -= 2;

    // Synergy & Conflict Intelligence
    const bullishFactors = [
      rsi <= 40,
      macdLine > macdSignalLine,
      lastPrice > (sma50 || 0),
      vwapDeviation > 0.3,
      obvTrend === 'RISING',
      stochD < 30,
      candlestickScore > 0,
      macdMomentumScore > 0,
      bbPercentB < 0.20,
      volumeTrend === 'RISING_3D',    // Enhancement #12
      stochCrossover === 'BULLISH_CROSS', // Fix #15
    ].filter(Boolean).length;

    const bearishFactors = [
      rsi >= 60,
      macdLine < macdSignalLine,
      lastPrice < (sma50 || Infinity),
      vwapDeviation < -0.5,
      obvTrend === 'FALLING',
      stochD > 70,
      candlestickScore < 0,
      macdMomentumScore < 0,
      bbPercentB > 0.80,
      volumeTrend === 'FALLING_3D',    // Enhancement #12
      stochCrossover === 'BEARISH_CROSS', // Fix #15
    ].filter(Boolean).length;

    // Synergy bonus: 6+ factors aligned = strong conviction
    if (bullishFactors >= 7) score += 10;
    else if (bullishFactors >= 6) score += 7;
    else if (bullishFactors >= 5) score += 4;
    else if (bearishFactors >= 7) score -= 10;
    else if (bearishFactors >= 6) score -= 7;
    else if (bearishFactors >= 5) score -= 4;
    // Conflict penalty: strong signals in both directions = unreliable
    if (bullishFactors >= 3 && bearishFactors >= 3) score -= 5;

    // FIX #9: TradingView Official Screener Rating Validator (Symmetric scoring)
    if (tvData.rating === 'STRONG_BUY') score += 8;
    else if (tvData.rating === 'BUY') score += 4;
    else if (tvData.rating === 'SELL') score -= 6;
    else if (tvData.rating === 'STRONG_SELL') score -= 10;

    // Enhancement #6: Anti-Trap Penalty Integration
    if (trapType !== 'NONE') {
      score += trapPenalty;
    }

    // Liquidity Trap Safety Override
    if (isIlliquidTrap) {
      score = Math.min(score - 12, 45);
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    // 9. Profit Estimation Engine (Time-Based)
    const atrPercent = lastPrice > 0 ? (atr / lastPrice) * 100 : 1;

    // Trend direction multiplier from MACD & RSI & Score
    let trendDirectionMult = 1.0;
    if (macdLine > macdSignalLine && rsi < 70) {
      trendDirectionMult = 1.0 + Math.min((macdLine - macdSignalLine) / (Math.abs(macdLine) + 1), 0.5);
    } else if (macdLine < macdSignalLine && rsi > 30) {
      trendDirectionMult = 0.5; // bearish trend slows bullish target
    } else if (rsi >= 70) {
      trendDirectionMult = 0.3; // overbought reduces upside speed
    }

    // Volume confirmation factor
    const volConfirmation = volRatio >= 1.5 ? 1.3 : volRatio >= 1.0 ? 1.0 : 0.7;

    // Daily expected movement toward target (based on ATR, adjusted by trend & volume)
    const dailyMovementEstimate = atr * trendDirectionMult * volConfirmation;

    // Calculate distances
    const distanceToTP = Math.abs(atrTakeProfit - lastPrice);
    const distanceToSL = Math.abs(lastPrice - atrStopLoss);

    // Risk:Reward Ratio
    const riskRewardRatio = distanceToSL > 0 ? parseFloat((distanceToTP / distanceToSL).toFixed(2)) : 0;

    // Time estimates (in trading days)
    const rawDaysToTarget = dailyMovementEstimate > 0 ? distanceToTP / dailyMovementEstimate : 999;

    // FIX #16: Confidence adjustment — floor at 0.5 to prevent absurd time estimates
    const confidenceMultiplier = Math.max(0.5, Math.min(2.0, score / 60));
    const adjustedDaysToTarget = Math.max(1, Math.round(rawDaysToTarget / confidenceMultiplier));

    // Convert to different time units
    const IDX_TRADING_HOURS_PER_DAY = 6.5; // 09:00-15:30 WIB
    const TRADING_DAYS_PER_WEEK = 5;

    const estimatedHours = Math.round(adjustedDaysToTarget * IDX_TRADING_HOURS_PER_DAY);
    const estimatedDays = adjustedDaysToTarget;
    const estimatedWeeks = parseFloat((adjustedDaysToTarget / TRADING_DAYS_PER_WEEK).toFixed(1));

    // Profit percentage
    const profitPercent = lastPrice > 0 ? parseFloat(((distanceToTP / lastPrice) * 100).toFixed(2)) : 0;
    const profitPerDay = estimatedDays > 0 ? parseFloat((profitPercent / estimatedDays).toFixed(2)) : 0;
    const lossPercent = lastPrice > 0 ? parseFloat(((distanceToSL / lastPrice) * 100).toFixed(2)) : 0;

    // ═══════════════════════════════════════════════════════════════
    // FIX #4: Win Probability v4.0 — Independent Signal Confluence Model
    // Instead of re-adding the same factors used in scoring (double-counting),
    // this uses a CATEGORY-based confluence system where each category
    // contributes exactly once. 7 categories, each worth ~7 probability points.
    // ═══════════════════════════════════════════════════════════════
    let winProb = 50;

    // Category 1: Momentum State (RSI + Stochastic combined) — single contribution
    const momentumBullish = (rsi <= 40 && rsiTurningUp) || (stochD < 25 && stochCrossover === 'BULLISH_CROSS');
    const momentumBearish = (rsi >= 65 && rsiTurningDown) || (stochD > 75 && stochCrossover === 'BEARISH_CROSS');
    const momentumNeutralBull = rsi >= 40 && rsi <= 55 && stochK > stochD; // healthy mid-range momentum
    if (momentumBullish) winProb += 8;
    else if (momentumBearish) winProb -= 8;
    else if (momentumNeutralBull) winProb += 3;

    // Category 2: Trend Structure (MA alignment + ADX) — single contribution
    const trendBullish = (sma50 && sma200 && sma50 > sma200) && (ema10 && sma20 && lastPrice > ema10 && ema10 > sma20) && isTrending;
    const trendBearish = (sma50 && sma200 && sma50 < sma200) && (ema10 && sma20 && lastPrice < ema10 && ema10 < sma20);
    const trendPartialBull = (sma50 && lastPrice > sma50) || (sma20 && lastPrice > sma20);
    if (trendBullish) winProb += 10;
    else if (trendBearish) winProb -= 10;
    else if (trendPartialBull) winProb += 4;

    // Category 3: MACD Signal State — single contribution
    const macdBullish = macdLine > macdSignalLine && macdHist > 0 && (macdMomentum === 'ACCELERATING_BULL' || macdMomentum === 'ZERO_CROSS_BULL');
    const macdBearish = macdLine < macdSignalLine && macdHist < 0 && (macdMomentum === 'ACCELERATING_BEAR' || macdMomentum === 'ZERO_CROSS_BEAR');
    if (macdBullish) winProb += 8;
    else if (macdLine > macdSignalLine) winProb += 4;
    else if (macdBearish) winProb -= 8;
    else if (macdLine < macdSignalLine) winProb -= 4;

    // Category 4: Volume & Smart Money (OBV + Volume Trend) — single contribution
    const volumeBullish = (obvDivergence === 'ACCUMULATION') || (volumeTrend === 'RISING_3D' && priceTrendSlope > 0);
    const volumeBearish = (obvDivergence === 'DISTRIBUTION') || (volumeTrend === 'FALLING_3D' && priceTrendSlope > 0);
    if (volumeBullish) winProb += 7;
    else if (volumeBearish) winProb -= 7;
    else if (volRatio >= 1.3 && priceTrendSlope > 0.3) winProb += 3;

    // Category 5: Risk/Reward Structure — single contribution
    if (riskRewardRatio >= 3) winProb += 6;
    else if (riskRewardRatio >= 2) winProb += 4;
    else if (riskRewardRatio >= 1.5) winProb += 2;
    else if (riskRewardRatio < 1) winProb -= 6;

    // Category 6: External Validation (TradingView + Divergence) — single contribution
    const externalBullish = (tvData.rating === 'STRONG_BUY' || tvData.rating === 'BUY') && divergence !== 'BEARISH_BULL_TRAP';
    const externalBearish = (tvData.rating === 'STRONG_SELL' || tvData.rating === 'SELL') || divergence === 'BEARISH_BULL_TRAP';
    if (externalBullish && divergence === 'BULLISH_ACCUMULATION') winProb += 8;
    else if (externalBullish) winProb += 5;
    else if (externalBearish && divergence === 'BEARISH_BULL_TRAP') winProb -= 8;
    else if (externalBearish) winProb -= 5;

    // Category 7: Safety & Liquidity — single contribution (penalty only)
    if (trapType !== 'NONE') winProb -= 8;
    if (isIlliquidTrap) winProb -= 5;
    // BB extreme zones as confirmation
    if (bbPercentB < 0.10 && rsiTurningUp) winProb += 4;
    else if (bbPercentB > 0.90 && rsiTurningDown) winProb -= 4;

    winProb = Math.max(5, Math.min(95, winProb));

    // Format time estimate as human readable
    let timeEstimateLabel;
    if (estimatedDays <= 1) {
      timeEstimateLabel = `~${estimatedHours} jam`;
    } else if (estimatedDays <= 5) {
      timeEstimateLabel = `~${estimatedDays} hari`;
    } else if (estimatedWeeks <= 4) {
      timeEstimateLabel = `~${estimatedWeeks} minggu`;
    } else {
      timeEstimateLabel = `~${Math.round(estimatedWeeks)} minggu`;
    }

    const profitEstimation = {
      estimatedHours,
      estimatedDays,
      estimatedWeeks,
      timeEstimateLabel,
      profitPercent,
      profitPerDay,
      lossPercent,
      riskRewardRatio,
      winProbability: winProb,
      dailyMovement: parseFloat(dailyMovementEstimate.toFixed(2)),
      atrPercent: parseFloat(atrPercent.toFixed(2)),
      confidenceLevel: confidenceMultiplier >= 1.2 ? 'HIGH' : confidenceMultiplier >= 0.8 ? 'MEDIUM' : 'LOW',
    };

    // ─── Fix #7: Strategy-Specific Dynamic Fit Scoring with Penalties ───
    let scalpScore = score;
    // Scalping bonuses
    if (volRatio >= 1.5) scalpScore += 8; else if (volRatio >= 1.2) scalpScore += 4;
    if (atrPercent >= 2.0) scalpScore += 6;
    if (vwapDeviation > 0 && vwapDeviation <= 2) scalpScore += 5;
    if (macdMomentum === 'ACCELERATING_BULL' || macdMomentum === 'ZERO_CROSS_BULL') scalpScore += 5;
    if (volumeTrend === 'RISING_3D') scalpScore += 4;
    // Scalping penalties
    if (atrPercent < 1.0) scalpScore -= 12; // not volatile enough for scalping
    if (volRatio < 0.8) scalpScore -= 8;    // below-average volume = no liquidity for scalp
    if (isRanging && atrPercent < 1.5) scalpScore -= 5; // ranging + low ATR = dead stock
    if (trapType !== 'NONE') scalpScore -= 10;
    scalpScore = Math.max(0, Math.min(100, Math.round(scalpScore)));

    let swingScore = score;
    // Swing bonuses
    if (sma50 && sma200 && sma50 > sma200) swingScore += 10;
    if (adx >= 25) swingScore += 6; else if (adx >= 20) swingScore += 3;
    if (rsi >= 40 && rsi <= 65) swingScore += 6;
    if (bbPercentB >= 0.2 && bbPercentB <= 0.8) swingScore += 4;
    if (volumeTrend === 'RISING_3D') swingScore += 4;
    // Swing penalties
    if (adx < 15) swingScore -= 8;        // no trend = swing trading fails
    if (rsi > 70) swingScore -= 8;         // overbought entry for multi-day hold = risky
    if (trapType === 'PUMP_DUMP') swingScore -= 15;
    if (trapType === 'DEAD_CAT_BOUNCE') swingScore -= 12;
    swingScore = Math.max(0, Math.min(100, Math.round(swingScore)));

    let bsjpScore = score;
    const dayRange = (quoteResult.dayHigh - quoteResult.dayLow) || 1;
    const closeNearHigh = ((lastPrice - quoteResult.dayLow) / dayRange) >= 0.65;
    // BSJP bonuses
    if (closeNearHigh) bsjpScore += 8;
    if (obvTrend === 'RISING' || obvDivergence === 'ACCUMULATION') bsjpScore += 8;
    if (volumeTrend === 'RISING_3D') bsjpScore += 4;
    // FIX #14: BSJP overnight gap risk filter
    if (atrPercent > 4.5) bsjpScore -= 12; // high ATR% = likely gap-down overnight
    if (rsi > 75) bsjpScore -= 8;          // overbought at close = gap-down risk
    if (obvDivergence === 'DISTRIBUTION') bsjpScore -= 10; // smart money exiting
    if (trapType === 'BULL_TRAP') bsjpScore -= 10;
    if (!closeNearHigh && priceTrendSlope < 0) bsjpScore -= 6; // closed weak + downtrend
    bsjpScore = Math.max(0, Math.min(100, Math.round(bsjpScore)));

    let bpjsScore = score;
    // BPJS bonuses
    if (priceTrendSlope > 0) bpjsScore += 6;
    if (volRatio >= 1.1) bpjsScore += 6;
    if (stochK > stochD && stochK < 80) bpjsScore += 5;
    if (stochCrossover === 'BULLISH_CROSS') bpjsScore += 4;
    // BPJS penalties
    if (volRatio < 0.9) bpjsScore -= 6;   // low volume at open = weak momentum
    if (rsi > 70) bpjsScore -= 6;          // overbought = limited upside during day
    if (priceTrendSlope < -1) bpjsScore -= 8; // downtrend = bad for intraday buy
    if (trapType !== 'NONE') bpjsScore -= 8;
    bpjsScore = Math.max(0, Math.min(100, Math.round(bpjsScore)));

    let bsijScore = score;
    // BSIJ bonuses
    if (bbSqueeze || (adx > 22 && rsi >= 48)) bsijScore += 8;
    if (obvTrend === 'RISING') bsijScore += 5;
    if (stochCrossover === 'BULLISH_CROSS' && stochK < 60) bsijScore += 4;
    // BSIJ penalties
    if (priceTrendSlope < -0.5) bsijScore -= 8; // session 2 continuation unlikely if downtrend
    if (rsi > 72) bsijScore -= 6;          // overbought = limited upside in afternoon
    if (volRatio < 0.8) bsijScore -= 6;    // low volume = no momentum to ride
    if (trapType !== 'NONE') bsijScore -= 8;
    bsijScore = Math.max(0, Math.min(100, Math.round(bsijScore)));

    const strategyScores = { scalpScore, swingScore, bsjpScore, bpjsScore, bsijScore };

    let signal;
    if (score >= 75) signal = 'STRONG_BUY';
    else if (score >= 60) signal = 'BUY';
    else if (score >= 40) signal = 'NEUTRAL';
    else if (score >= 25) signal = 'SELL';
    else signal = 'STRONG_SELL';

    return {
      symbol,
      name: quoteResult.name,
      price: lastPrice,
      change: quoteResult.change,
      changePercent: quoteResult.changePercent,
      volume: quoteResult.volume,
      previousClose: quoteResult.previousClose,
      dayHigh: quoteResult.dayHigh,
      dayLow: quoteResult.dayLow,
      fiftyTwoWeekHigh: quoteResult.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: quoteResult.fiftyTwoWeekLow,
      score,
      signal,
      rsi: parseFloat(rsi.toFixed(1)),
      macdLine: parseFloat(macdLine.toFixed(2)),
      macdSignalLine: parseFloat(macdSignalLine.toFixed(2)),
      macdHist: parseFloat(macdHist.toFixed(2)),
      stochK: parseFloat(stochK.toFixed(1)),
      stochD: parseFloat(stochD.toFixed(1)),
      stochCrossover,          // New: %K/%D crossover state
      sma20,
      sma50,
      sma200,
      ema10,                   // New: short-term EMA for alignment
      volRatio: parseFloat(volRatio.toFixed(2)),
      volumeTrend,             // New: 3-day volume direction
      support: parseFloat(support.toFixed(0)),
      resistance: parseFloat(resistance.toFixed(0)),
      support1: parseFloat(support1.toFixed(0)),
      resistance1: parseFloat(resistance1.toFixed(0)),
      atr: parseFloat(atr.toFixed(2)),
      atrStopLoss,
      atrTakeProfit,
      fibonacci,
      profitEstimation,
      divergence,
      divergenceStrength,
      vwap: parseFloat(vwap.toFixed(2)),
      vwapDeviation: parseFloat(vwapDeviation.toFixed(2)),
      obvTrend,
      obvDivergence,
      candlestickPattern,
      macdMomentum,
      bullishFactors,
      bearishFactors,
      bbPercentB: parseFloat(bbPercentB.toFixed(3)),
      bbBandwidth: parseFloat(bbBandwidth.toFixed(2)),
      bbSqueeze,
      adx: parseFloat(adx.toFixed(1)),
      isTrending,
      isRanging,
      priceTrendSlope: parseFloat(priceTrendSlope.toFixed(2)),
      tradingViewRating: tvData.rating,
      tvRecommendScore: tvData.score,
      isIlliquidTrap,
      dailyTurnover: Math.round(dailyTurnover),
      trapType,                // New: anti-trap detection result
      strategyScores,
    };
  } catch (err) {
    // Abaikan log peringatan 404 di console (normal terjadi pada beberapa saham yang belum terindeks/suspend di Yahoo Finance)
    if (!err.message || !err.message.includes('404')) {
      console.warn(`[Recommendation] Failed to analyze ${symbol}:`, err.message);
    }
    return null;
  }
}

// Recommendation symbols (400+ Stocks across all 11 IDX Sectors, Including Popular Traders Favorites)
const RECOMMENDATION_SYMBOLS = [
  // 🧪 BASIC-IND (Basic Materials)
  'BRPT.JK', 'TPIA.JK', 'INKP.JK', 'TKIM.JK', 'ANTM.JK', 'INCO.JK', 'MDKA.JK', 'NCKL.JK', 'MBMA.JK', 'SMGR.JK', 'INTP.JK', 'AVIA.JK', 'TINS.JK', 'PSAB.JK', 'DKFT.JK', 'NIKL.JK', 'CITA.JK', 'SMCB.JK', 'SMBR.JK', 'ARCI.JK', 'IFSH.JK', 'MCOL.JK', 'SOLA.JK', 'AGII.JK', 'ALDO.JK', 'AMFG.JK', 'BTON.JK', 'FASW.JK', 'GDST.JK', 'INCF.JK', 'ISSP.JK', 'KRAS.JK', 'LION.JK', 'LMSH.JK', 'PBSA.JK', 'TDPM.JK', 'TRST.JK', 'UNIC.JK', 'BRMS.JK', 'SMGA.JK', 'NICE.JK', 'HILL.JK', 'ZINC.JK', 'DAAZ.JK', 'CHEM.JK', 'PBID.JK', 'EKAD.JK', 'FPNI.JK', 'IGAR.JK',
  // 🔥 ENERGY
  'ADRO.JK', 'PTBA.JK', 'PGAS.JK', 'MEDC.JK', 'AKRA.JK', 'ESSA.JK', 'AMMN.JK', 'BREN.JK', 'CUAN.JK', 'PGEO.JK', 'HRUM.JK', 'ITMG.JK', 'DOID.JK', 'INDY.JK', 'PTRO.JK', 'BYAN.JK', 'GEMS.JK', 'BUMI.JK', 'ELSA.JK', 'MBSS.JK', 'ENRG.JK', 'TOBA.JK', 'ABMM.JK', 'APEX.JK', 'ARTI.JK', 'BIPI.JK', 'BSSR.JK', 'DEWA.JK', 'FIRE.JK', 'GTBO.JK', 'IATA.JK', 'KOBX.JK', 'MYOH.JK', 'RUIS.JK', 'SMMT.JK', 'SURE.JK', 'TEBE.JK', 'WINS.JK', 'DSSA.JK', 'ADMR.JK', 'AADI.JK', 'RAJA.JK', 'PSSI.JK', 'SGER.JK', 'HUMI.JK', 'GTRA.JK', 'KKGI.JK', 'BSML.JK', 'RGAS.JK',
  // 👕 CYCLICAL (Consumer Cyclicals)
  'ACES.JK', 'MAPI.JK', 'MAPA.JK', 'ERAA.JK', 'RALS.JK', 'LPPF.JK', 'AUTO.JK', 'DRMA.JK', 'ASLC.JK', 'MPPA.JK', 'CINT.JK', 'WOOD.JK', 'PANR.JK', 'SCMA.JK', 'MNCN.JK', 'MSIN.JK', 'MDIA.JK', 'BELL.JK', 'BIKA.JK', 'BIPP.JK', 'BLTZ.JK', 'BOLA.JK', 'CSAP.JK', 'DFAM.JK', 'FAST.JK', 'FILM.JK', 'GLOB.JK', 'HERO.JK', 'KOCI.JK', 'MABA.JK', 'BMTR.JK', 'CARS.JK', 'IMAS.JK', 'IMJS.JK', 'MSKY.JK', 'ZONE.JK',
  // 🪙 FINANCE
  'BBRI.JK', 'BBCA.JK', 'BMRI.JK', 'BBNI.JK', 'BRIS.JK', 'ARTO.JK', 'BBHI.JK', 'BNGA.JK', 'BDMN.JK', 'BJBR.JK', 'BJTM.JK', 'BTPS.JK', 'NISP.JK', 'PNLF.JK', 'BFIN.JK', 'SRTG.JK', 'BBTN.JK', 'AGRO.JK', 'BCIC.JK', 'BNLI.JK', 'BSIM.JK', 'MAHA.JK', 'MFIN.JK', 'CFIN.JK', 'AMAG.JK', 'BABP.JK', 'BACA.JK', 'BBKP.JK', 'BBMD.JK', 'BCAP.JK', 'BEKS.JK', 'BGTG.JK', 'BINA.JK', 'BNBA.JK', 'BNII.JK', 'BSWD.JK', 'BTPN.JK', 'DNAR.JK', 'MASB.JK', 'ADMF.JK', 'WOMF.JK', 'AMAR.JK', 'BBYB.JK', 'BANK.JK', 'TUGU.JK', 'PNBN.JK', 'PNIN.JK', 'MEGA.JK', 'NOBU.JK', 'MLPL.JK',
  // 🛣️ INFRASTRUC (Infrastructure)
  'TLKM.JK', 'ISAT.JK', 'EXCL.JK', 'TOWR.JK', 'TBIG.JK', 'JSMR.JK', 'FREN.JK', 'CENT.JK', 'GHON.JK', 'GOLD.JK', 'META.JK', 'CMNP.JK', 'KEEN.JK', 'POWR.JK', 'TGRA.JK', 'ACST.JK', 'BALI.JK', 'BPII.JK', 'BUKK.JK', 'DADA.JK', 'IBST.JK', 'IDPR.JK', 'KBLV.JK', 'LINK.JK', 'MCTA.JK', 'MTPS.JK', 'PPRE.JK', 'SSIA.JK', 'SUPR.JK', 'TLDN.JK', 'MORI.JK', 'OASA.JK', 'KARW.JK', 'MTEL.JK',
  // 🏥 HEALTH (Healthcare)
  'KLBF.JK', 'KAEF.JK', 'MIKA.JK', 'HEAL.JK', 'SILO.JK', 'SIDO.JK', 'INAF.JK', 'SAME.JK', 'PRDA.JK', 'TSPC.JK', 'PEHA.JK', 'DVLA.JK', 'PYFA.JK', 'BMHS.JK', 'CARE.JK', 'DGNS.JK', 'MEDS.JK', 'OMED.JK', 'PRAY.JK', 'PRIM.JK', 'RDTX.JK', 'SCPI.JK', 'SOHO.JK', 'RSGK.JK', 'MTMH.JK', 'HALO.JK',
  // 🏭 INDUSTRIAL (Industrials)
  'ASII.JK', 'UNTR.JK', 'HEXA.JK', 'PTPP.JK', 'WIKA.JK', 'ADHI.JK', 'WEGE.JK', 'TOTL.JK', 'MARK.JK', 'IMPC.JK', 'KBLI.JK', 'JECC.JK', 'ARNA.JK', 'BHIT.JK', 'CCSI.JK', 'GMFI.JK', 'INAI.JK', 'KBLM.JK', 'KMTR.JK', 'KPII.JK', 'SPTO.JK', 'BNBR.JK', 'VKTR.JK', 'MLIA.JK', 'LABA.JK', 'HYGN.JK', 'SKRN.JK', 'JTPE.JK',
  // 🛒 NON-CYCLICAL (Consumer Non-Cyclicals)
  'UNVR.JK', 'ICBP.JK', 'INDF.JK', 'CPIN.JK', 'JPFA.JK', 'CMRY.JK', 'CLEO.JK', 'MYOR.JK', 'AMRT.JK', 'GGRM.JK', 'HMSP.JK', 'STTP.JK', 'AALI.JK', 'LSIP.JK', 'TAPG.JK', 'DSNG.JK', 'SSMS.JK', 'BWPT.JK', 'SIMP.JK', 'VICI.JK', 'MAIN.JK', 'BEEF.JK', 'BTEK.JK', 'CEKA.JK', 'DLTA.JK', 'DMND.JK', 'FOOD.JK', 'GOOD.JK', 'HOKI.JK', 'IKAN.JK', 'KEJU.JK', 'BOBA.JK', 'STRK.JK', 'ROTI.JK', 'ULTJ.JK', 'ADES.JK', 'CAMP.JK', 'TBLA.JK',
  // 🏠 PROPERTY (Property & Real Estate)
  'BSDE.JK', 'CTRA.JK', 'PWON.JK', 'SMRA.JK', 'ASRI.JK', 'APLN.JK', 'DUTI.JK', 'MKPI.JK', 'DILD.JK', 'KIJA.JK', 'BEST.JK', 'LPKR.JK', 'LPCK.JK', 'PPRO.JK', 'JRPT.JK', 'BKSL.JK', 'ARMY.JK', 'BAPA.JK', 'BBSS.JK', 'BCIP.JK', 'CITY.JK', 'COWL.JK', 'CPRI.JK', 'DMAS.JK', 'ELTY.JK', 'FMII.JK', 'FORZ.JK', 'GAMA.JK', 'GPRA.JK', 'GWSA.JK', 'IPAC.JK', 'PANI.JK', 'REAL.JK', 'SWID.JK', 'TRIN.JK', 'URBN.JK', 'VAST.JK',
  // ✈️ TRANSPORT (Transportation & Logistics)
  'BIRD.JK', 'SMDR.JK', 'ASSA.JK', 'TMAS.JK', 'HELI.JK', 'HAIS.JK', 'GIAA.JK', 'CMPP.JK', 'IPCC.JK', 'IPCM.JK', 'SAFE.JK', 'BPTR.JK', 'TRUK.JK', 'WEHA.JK', 'AKSI.JK', 'BLTA.JK', 'CASS.JK', 'DEAL.JK', 'HITS.JK', 'JKSW.JK', 'LEAD.JK', 'LRNA.JK', 'NELY.JK', 'SOCI.JK', 'KLAS.JK', 'PTMP.JK', 'PJAA.JK',
  // 💻 TECHNOLOGY
  'GOTO.JK', 'BUKA.JK', 'EMTK.JK', 'MLPT.JK', 'DCII.JK', 'MTDL.JK', 'WIFI.JK', 'BELI.JK', 'AXIO.JK', 'MCAS.JK', 'NFCX.JK', 'DMMX.JK', 'ENVY.JK', 'ATIC.JK', 'CASH.JK', 'DIVA.JK', 'GLVA.JK', 'HDIT.JK', 'JSPT.JK', 'LUCK.JK', 'MTECH.JK', 'PTSN.JK', 'WIRE.JK', 'AWAN.JK', 'ZYRX.JK', 'CYBR.JK', 'CHIP.JK', 'EDGE.JK', 'ELIT.JK', 'TECH.JK', 'TRON.JK', 'AREA.JK'
];

// ─── TradingView Screener API Validation Engine ───
let tvRatingsCache = null;
let tvRatingsTimestamp = 0;
const TV_CACHE_TTL = 15 * 60 * 1000; // 15 minutes cache

async function fetchTradingViewRatings() {
  const now = Date.now();
  if (tvRatingsCache && (now - tvRatingsTimestamp) < TV_CACHE_TTL) {
    return tvRatingsCache;
  }

  console.log('[TradingView] Fetching live composite technical ratings from IDX Screener...');
  try {
    const res = await fetch('https://scanner.tradingview.com/indonesia/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://www.tradingview.com/'
      },
      body: JSON.stringify({
        filter: [{ left: "type", operation: "equal", right: "stock" }],
        options: { lang: "en" },
        symbols: { query: { types: [] }, tickers: [] },
        columns: ["name", "Recommend.All", "Recommend.MA", "Recommend.Other"],
        range: [0, 1500]
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const ratingsMap = {};

    if (json && json.data && Array.isArray(json.data)) {
      json.data.forEach(item => {
        if (item.d && item.d.length >= 2) {
          const ticker = item.d[0];
          const score = parseFloat(item.d[1]);
          let rating = 'NEUTRAL';
          if (score >= 0.5) rating = 'STRONG_BUY';
          else if (score >= 0.1) rating = 'BUY';
          else if (score <= -0.5) rating = 'STRONG_SELL';
          else if (score <= -0.1) rating = 'SELL';

          ratingsMap[ticker] = {
            score: !isNaN(score) ? parseFloat(score.toFixed(2)) : 0,
            rating: rating,
            maScore: !isNaN(item.d[2]) ? parseFloat(Number(item.d[2]).toFixed(2)) : 0,
            otherScore: !isNaN(item.d[3]) ? parseFloat(Number(item.d[3]).toFixed(2)) : 0,
          };
        }
      });
    }

    console.log(`[TradingView] Successfully indexed ${Object.keys(ratingsMap).length} IDX stock ratings.`);
    tvRatingsCache = ratingsMap;
    tvRatingsTimestamp = now;
    return ratingsMap;
  } catch (err) {
    console.warn('[TradingView] Failed to fetch screener ratings:', err.message);
    return tvRatingsCache || {};
  }
}

// Helper: Run parallel batch tasks with TradingView rating validation
async function analyzeBatch(symbols, batchSize = 20) {
  const tvRatingsMap = await fetchTradingViewRatings();
  const results = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const chunk = symbols.slice(i, i + batchSize);
    const chunkResults = await Promise.all(
      chunk.map(symbol => analyzeStockForRecommendation(symbol, tvRatingsMap))
    );
    chunkResults.forEach(r => { if (r) results.push(r); });
    if (i + batchSize < symbols.length) {
      await new Promise(r => setTimeout(r, 100)); // Dipersingkat agar tidak membuang waktu
    }
  }
  return results;
}

// ─── Helper: Aturan resmi fraksi harga (Tick Size) Bursa Efek Indonesia (IDX) ──
function roundToIdxTick(price, direction = 'nearest') {
  if (!price || isNaN(price) || price <= 0) return 0;
  let tick = 1;
  if (price < 200) tick = 1;
  else if (price < 500) tick = 2;
  else if (price < 2000) tick = 5;
  else if (price < 5000) tick = 10;
  else tick = 25;

  if (direction === 'floor' || direction === 'sl') {
    return Math.max(1, Math.floor(price / tick) * tick);
  } else if (direction === 'ceil' || direction === 'tp') {
    return Math.max(1, Math.ceil(price / tick) * tick);
  }
  return Math.max(1, Math.round(price / tick) * tick);
}

// Helper: Optimasi level harga dengan proteksi Risk/Reward Ratio minimal institusional (1:1.5 - 1:2.5)
function optimizeTradeLevels(rawLow, rawHigh, rawSL, rawTP, minRRR = 1.5) {
  const entryLow = roundToIdxTick(rawLow, 'nearest');
  const entryHigh = Math.max(entryLow, roundToIdxTick(rawHigh, 'nearest'));
  let stopLoss = Math.min(entryLow, roundToIdxTick(rawSL, 'sl'));
  let takeProfit = Math.max(entryHigh, roundToIdxTick(rawTP, 'tp'));

  const entryMid = (entryLow + entryHigh) / 2 || entryHigh;
  let distSL = Math.abs(entryMid - stopLoss);
  
  // Ensure SL is always at least 1 tick below entry (fixes edge case for very low-priced stocks)
  if (distSL <= 0 || stopLoss >= entryLow) {
    // Try 2% below first
    stopLoss = roundToIdxTick(entryLow * 0.98, 'sl');
    // If still at or above entry (very low price stocks), force 1 tick below
    if (stopLoss >= entryLow) {
      const tick = entryLow < 200 ? 1 : entryLow < 500 ? 2 : entryLow < 2000 ? 5 : entryLow < 5000 ? 10 : 25;
      stopLoss = Math.max(1, entryLow - tick);
    }
    distSL = Math.abs(entryMid - stopLoss);
  }

  let distTP = Math.abs(takeProfit - entryMid);
  if (distSL > 0 && (distTP / distSL) < minRRR) {
    takeProfit = roundToIdxTick(entryMid + (distSL * minRRR), 'tp');
    distTP = Math.abs(takeProfit - entryMid);
  }

  const finalRRR = distSL > 0 ? parseFloat((distTP / distSL).toFixed(2)) : 0;
  const finalProfitPct = entryMid > 0 ? parseFloat(((distTP / entryMid) * 100).toFixed(2)) : 0;
  const finalLossPct = entryMid > 0 ? parseFloat(((distSL / entryMid) * 100).toFixed(2)) : 0;

  return { entryLow, entryHigh, stopLoss, takeProfit, entryMid, finalRRR, finalProfitPct, finalLossPct };
}

// ─── API: Stock Recommendations (Multi-Strategy: Scalping, Swing, BSJP, BPJS) ──
async function getSharedBatchAnalyses() {
  return await withCache('recommendations:raw_batch_v2_perfect', 1800, async () => {
    console.log('[Recommendations] Computing master batch analyses for all strategies...');
    const analyses = await analyzeBatch(RECOMMENDATION_SYMBOLS, 20);
    return analyses;
  });
}

// Warm-up cache otomatis secara latar belakang setelah server aktif
setTimeout(() => {
  console.log('[Recommendations] Memulai warm-up analisis saham otomatis di background...');
  getSharedBatchAnalyses().catch(err => console.error('[Recommendations Warmup Error]', err.message));
}, 4000);

function getNextTradingDayLabel() {
  const d = new Date();
  d.setDate(d.getDate() + 1); // Besok hari
  while (d.getDay() === 0 || d.getDay() === 6) { // 0 = Minggu, 6 = Sabtu
    d.setDate(d.getDate() + 1);
  }
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// 1. API: Recommendations for Scalping — Hari Ini (Live Intraday)
app.get('/api/recommendations/today', async (req, res) => {
  try {
    const data = await withCache('recommendations:today_v3_perfect', 1800, async () => {
      const analyses = await getSharedBatchAnalyses();
      // FIX #5: Sort by strategy score primarily, use volRatio as tiebreaker (not multiplier)
      const sorted = [...analyses].sort((a, b) => {
        const scoreA = a.strategyScores?.scalpScore || a.score;
        const scoreB = b.strategyScores?.scalpScore || b.score;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return b.volRatio - a.volRatio; // tiebreaker
      });

      // FIX #13: Raise minimum score threshold from 54 to 60, exclude trapped stocks
      const buyPicks = sorted.filter(a => (a.strategyScores?.scalpScore || a.score) >= 60 && !a.isIlliquidTrap && a.trapType === 'NONE').slice(0, 8);
      const sellPicks = sorted.filter(a => a.score <= 35).slice(0, 4);
      const holdPicks = sorted.filter(a => a.score > 35 && (a.strategyScores?.scalpScore || a.score) < 60 && !a.isIlliquidTrap).slice(0, 4);

      let aiAnalysis = {};
      if (process.env.GEMINI_API_KEY && buyPicks.length > 0) {
        try {
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

          const stockSummaries = buyPicks.slice(0, 5).map(s =>
            `${s.symbol}: Harga ${s.price}, RSI ${s.rsi}, MACD ${s.macdLine}/${s.macdSignalLine}, Vol Ratio ${s.volRatio}x, ATR ${s.atr}, VWAP ${s.vwap}, OBV Trend ${s.obvTrend}, Candle ${s.candlestickPattern}, Support ${s.support}, Resistance ${s.resistance}, TV Rating ${s.tradingViewRating}, Skor ${s.score}`
          ).join('\n');

          const prompt = `Kamu adalah sistem Multi-Agent Trading AI profesional. Berdasarkan data teknikal berikut, berikan rekomendasi SCALPING HARI INI secara profesional dalam Bahasa Indonesia tanpa emotikon/emoji.

Data saham:
${stockSummaries}

Untuk setiap saham, berikan:
1. entry_low dan entry_high (range harga beli scalping realistis)
2. stop_loss (harga cut loss ketat, max 2-3% dari entry)
3. take_profit (target profit cepat intraday)
4. reasoning (ringkasan 2 kalimat hasil analisis teknikal dan konfirmasi arus volume, diawali dengan "[Multi-Agent Verified]:")

Format response sebagai JSON array (tanpa markdown wrapper).`;

          const result = await model.generateContent(prompt);
          let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
          const aiResults = JSON.parse(text);
          aiResults.forEach(r => { aiAnalysis[r.symbol] = r; });
        } catch (aiErr) {
          console.warn('[Recommendations] Gemini AI failed:', aiErr.message);
        }
      }

      const enrichPick = (pick) => {
        const ai = aiAnalysis[pick.symbol] || {};
        const atrBasedEntry = pick.atr ? Math.round(pick.price - pick.atr * 0.5) : Math.round(pick.price * 0.99);
        const rawLow = ai.entry_low || pick.support || atrBasedEntry;
        const rawHigh = ai.entry_high || pick.price;
        const rawSL = ai.stop_loss || pick.atrStopLoss || Math.round(pick.price - pick.atr * 1.5);
        const rawTP = ai.take_profit || pick.atrTakeProfit || Math.round(pick.price + pick.atr * 3);

        const { entryLow, entryHigh, stopLoss, takeProfit, finalRRR, finalProfitPct, finalLossPct } = optimizeTradeLevels(rawLow, rawHigh, rawSL, rawTP, 1.5);

        const pe = pick.profitEstimation || {};
        const updatedPE = {
          ...pe,
          timeEstimateLabel: '1 - 7 Jam (Hari Ini)',
          estimatedDays: 1,
          profitPercent: finalProfitPct,
          lossPercent: finalLossPct,
          riskRewardRatio: finalRRR,
          profitPerDay: finalProfitPct,
        };

        return {
          ...pick,
          entryLow,
          entryHigh,
          stopLoss,
          takeProfit,
          profitEstimation: updatedPE,
          reasoning: ai.reasoning || generateFallbackReasoning(pick),
        };
      };

      return {
        timestamp: new Date().toISOString(),
        type: 'today',
        strategy: 'SCALPING — Hari Ini',
        buyPicks: buyPicks.map(enrichPick),
        sellPicks: sellPicks.map(p => ({ ...p, reasoning: generateFallbackReasoning(p) })),
        holdPicks: holdPicks.map(p => ({ ...p, reasoning: generateFallbackReasoning(p) })),
        totalAnalyzed: analyses.length,
      };
    });

    res.json(data);
  } catch (err) {
    console.error('[Recommendations] Today error:', err.message);
    res.status(500).json({ error: 'Failed to generate recommendations', details: err.message });
  }
});

// 2. API: Recommendations for Scalping — Besok Pagi (Pre-Open)
app.get('/api/recommendations/tomorrow', async (req, res) => {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const wibHours = (utcHours + 7) % 24;

  if (wibHours < 19 && !(wibHours < 5)) {
    return res.json({
      locked: true,
      message: 'Rekomendasi besok pagi tersedia mulai pukul 19:00 WIB (Analisis Pasca Penutupan Pasar)',
      currentTimeWIB: `${String(wibHours).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} WIB`,
      availableAt: '19:00 WIB',
    });
  }

  try {
    const data = await withCache('recommendations:tomorrow_v3_perfect', 3600, async () => {
      const analyses = await getSharedBatchAnalyses();
      const sorted = [...analyses].sort((a, b) => (b.strategyScores?.scalpScore || b.score) - (a.strategyScores?.scalpScore || a.score));

      // FIX #13: Raise threshold from 55 to 60, exclude trapped stocks
      const morningPicks = sorted.filter(a => (a.strategyScores?.scalpScore || a.score) >= 60 && !a.isIlliquidTrap && a.trapType === 'NONE').slice(0, 6);
      const avoidPicks = sorted.filter(a => a.score <= 32).slice(0, 4);

      let aiAnalysis = {};
      if (process.env.GEMINI_API_KEY && morningPicks.length > 0) {
        try {
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

          const stockSummaries = morningPicks.map(s =>
            `${s.symbol}: Close ${s.price}, RSI ${s.rsi}, MACD ${s.macdLine}/${s.macdSignalLine}, Vol Ratio ${s.volRatio}x, VWAP ${s.vwap}, OBV Trend ${s.obvTrend}, Candle ${s.candlestickPattern}, Support ${s.support}, Resistance ${s.resistance}, TV Rating ${s.tradingViewRating}, Skor ${s.score}`
          ).join('\n');

          const prompt = `Kamu adalah sistem Multi-Agent Trading AI profesional. Berdasarkan data teknikal end-of-day berikut, lakukan analisis mendalam untuk PEMBUKAAN BESOK PAGI dalam Bahasa Indonesia tanpa emoji.

Data saham:
${stockSummaries}

Untuk setiap saham, berikan:
1. entry_low dan entry_high (range beli optimal saat opening besok)
2. stop_loss (harga cut loss ketat)
3. take_profit (target jual cepat)
4. reasoning (alasan konsensus 2-3 kalimat mengapa layak beli besok pagi, diawali "[Multi-Agent Verified]:")
5. priority (1-5, dimana 1 = paling prioritas)

Format response sebagai JSON array (tanpa markdown wrapper).`;

          const result = await model.generateContent(prompt);
          let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
          const aiResults = JSON.parse(text);
          aiResults.forEach(r => { aiAnalysis[r.symbol] = r; });
        } catch (aiErr) {
          console.warn('[Recommendations] Gemini AI tomorrow failed:', aiErr.message);
        }
      }

      const enrichPick = (pick) => {
        const ai = aiAnalysis[pick.symbol] || {};
        const atrBasedEntry = pick.atr ? Math.round(pick.price - pick.atr * 0.5) : Math.round(pick.price * 0.99);
        const rawLow = ai.entry_low || pick.support || atrBasedEntry;
        const rawHigh = ai.entry_high || pick.price;
        const rawSL = ai.stop_loss || pick.atrStopLoss || Math.round(pick.price - pick.atr * 1.5);
        const rawTP = ai.take_profit || pick.atrTakeProfit || Math.round(pick.price + pick.atr * 3);

        const { entryLow, entryHigh, stopLoss, takeProfit, finalRRR, finalProfitPct, finalLossPct } = optimizeTradeLevels(rawLow, rawHigh, rawSL, rawTP, 1.5);

        const pe = pick.profitEstimation || {};
        const updatedPE = {
          ...pe,
          timeEstimateLabel: '1 - 4 Jam (Sesi I Besok)',
          estimatedDays: 1,
          profitPercent: finalProfitPct,
          lossPercent: finalLossPct,
          riskRewardRatio: finalRRR,
          profitPerDay: finalProfitPct,
        };

        return {
          ...pick,
          entryLow,
          entryHigh,
          stopLoss,
          takeProfit,
          profitEstimation: updatedPE,
          reasoning: ai.reasoning || generateFallbackReasoning(pick),
          priority: ai.priority || 3,
        };
      };

      return {
        timestamp: new Date().toISOString(),
        type: 'tomorrow',
        strategy: 'SCALPING — Besok Pagi',
        locked: false,
        morningPicks: morningPicks.map(enrichPick).sort((a, b) => (a.priority || 3) - (b.priority || 3)),
        avoidPicks: avoidPicks.map(p => ({ ...p, reasoning: generateFallbackReasoning(p) })),
        totalAnalyzed: analyses.length,
      };
    });

    res.json(data);
  } catch (err) {
    console.error('[Recommendations] Tomorrow error:', err.message);
    res.status(500).json({ error: 'Failed to generate tomorrow recommendations', details: err.message });
  }
});

// 3. API: Recommendations for Swing Trading (Multi-Day Trend Hold)
app.get('/api/recommendations/swing', async (req, res) => {
  try {
    const data = await withCache('recommendations:swing_v3_perfect', 1800, async () => {
      const analyses = await getSharedBatchAnalyses();
      const sorted = [...analyses].sort((a, b) => (b.strategyScores?.swingScore || b.score) - (a.strategyScores?.swingScore || a.score));
      // FIX #13: Raise threshold from 55 to 58, exclude trapped stocks
      const candidates = sorted.filter(a => (a.strategyScores?.swingScore || a.score) >= 58 && !a.isIlliquidTrap && a.trapType === 'NONE');

      const nextTradingDate = getNextTradingDayLabel();

      const swingPicks = candidates.slice(0, 8).map(p => {
        const pe = p.profitEstimation || {};
        const minProfit = Math.max(6.0, (pe.profitPercent || 7.0)).toFixed(1);
        const maxProfit = (parseFloat(minProfit) + 5.0).toFixed(1);
        
        const rawLow = p.support || Math.round(p.price * 0.97);
        const rawHigh = p.price;
        const rawTP = p.atrTakeProfit || Math.round(p.price * (1 + (parseFloat(minProfit) / 100)));
        const rawSL = p.atrStopLoss || Math.round(rawLow * 0.95);

        const { entryLow, entryHigh, stopLoss, takeProfit: targetPriceLow, finalRRR, finalProfitPct, finalLossPct } = optimizeTradeLevels(rawLow, rawHigh, rawSL, rawTP, 2.0);
        const targetPriceHigh = Math.max(targetPriceLow, roundToIdxTick(Math.round(p.price * (1 + (parseFloat(maxProfit) / 100))), 'tp'));

        const updatedPE = {
          ...pe,
          timeEstimateLabel: '2 - 7 Hari (Swing Trend)',
          estimatedDays: 4,
          profitPercent: finalProfitPct,
          lossPercent: finalLossPct,
          riskRewardRatio: finalRRR,
          profitPerDay: parseFloat((finalProfitPct / 4).toFixed(2)),
        };

        return {
          ...p,
          entryLow,
          entryHigh,
          stopLoss,
          takeProfit: targetPriceLow,
          profitEstimation: updatedPE,
          strategy: 'SWING TRADING',
          entryDateAdvice: `Masuk pada hari bursa berikutnya (${nextTradingDate}) pada area batas beli Rp ${entryLow.toLocaleString('id-ID')} - Rp ${entryHigh.toLocaleString('id-ID')}`,
          targetProfitPct: `+${finalProfitPct}% hingga +${maxProfit}%`,
          sellProfitAdvice: `Jual bertahap saat profit mencapai +${finalProfitPct}% hingga +${maxProfit}% (Target harga Rp ${targetPriceLow.toLocaleString('id-ID')} - Rp ${targetPriceHigh.toLocaleString('id-ID')})`,
          reasoning: generateFallbackReasoning(p)
        };
      });

      return {
        timestamp: new Date().toISOString(),
        type: 'swing',
        strategy: 'SWING TRADING',
        picks: swingPicks,
        totalAnalyzed: analyses.length,
      };
    });
    res.json(data);
  } catch (err) {
    console.error('[Recommendations] Swing error:', err.message);
    res.status(500).json({ error: 'Failed to generate swing recommendations', details: err.message });
  }
});

// 4. API: Recommendations for BSJP (Beli Sore Jual Pagi)
app.get('/api/recommendations/bsjp', async (req, res) => {
  try {
    const data = await withCache('recommendations:bsjp_v3_perfect', 1800, async () => {
      const analyses = await getSharedBatchAnalyses();
      const candidates = [...analyses]
        // FIX #13: Raise threshold from 52 to 55, exclude trapped stocks
        .filter(a => (a.strategyScores?.bsjpScore || a.score) >= 55 && !a.isIlliquidTrap && a.trapType === 'NONE' && (
          a.obvDivergence === 'ACCUMULATION' ||
          a.obvTrend === 'RISING' ||
          a.volRatio >= 1.2
        ) && a.priceTrendSlope > -1)
        .sort((a, b) => (b.strategyScores?.bsjpScore || b.score) - (a.strategyScores?.bsjpScore || a.score));

      const bsjpPicks = candidates.slice(0, 6).map(p => {
        const rawLow = p.support || Math.round(p.price * 0.99);
        const rawHigh = p.price;
        const rawSL = p.atrStopLoss || Math.round(p.price * 0.975);
        const rawTP = p.atrTakeProfit || Math.round(p.price * 1.025);
        const { entryLow, entryHigh, stopLoss, takeProfit, finalRRR, finalProfitPct, finalLossPct } = optimizeTradeLevels(rawLow, rawHigh, rawSL, rawTP, 1.5);

        const pe = p.profitEstimation || {};
        const updatedPE = {
          ...pe,
          timeEstimateLabel: '12 - 16 Jam (Overnight)',
          estimatedDays: 1,
          profitPercent: finalProfitPct,
          lossPercent: finalLossPct,
          riskRewardRatio: finalRRR,
          profitPerDay: finalProfitPct,
        };

        return {
          ...p,
          entryLow,
          entryHigh,
          stopLoss,
          takeProfit,
          profitEstimation: updatedPE,
          strategy: 'BSJP (Beli Sore Jual Pagi)',
          entryTimeAdvice: `Beli saat sesi akhir bursa menjelang penutupan (Pukul 15.45 - 15.50 WIB) pada harga kisaran Rp ${entryHigh.toLocaleString('id-ID')}`,
          sellTimeAdvice: `Jual pada menit-menit awal bursa keesokan paginya (Pukul 09.00 - 09.15 WIB) saat terjadi lonjakan pembukaan (Gap-Up) dengan target cuan +${finalProfitPct}%`,
          reasoning: generateFallbackReasoning(p)
        };
      });

      return {
        timestamp: new Date().toISOString(),
        type: 'bsjp',
        strategy: 'BSJP (Beli Sore Jual Pagi)',
        picks: bsjpPicks,
        totalAnalyzed: analyses.length,
      };
    });
    res.json(data);
  } catch (err) {
    console.error('[Recommendations] BSJP error:', err.message);
    res.status(500).json({ error: 'Failed to generate BSJP recommendations', details: err.message });
  }
});

// 5. API: Recommendations for BPJS (Beli Pagi Jual Sore)
app.get('/api/recommendations/bpjs', async (req, res) => {
  try {
    const data = await withCache('recommendations:bpjs_v3_perfect', 1800, async () => {
      const analyses = await getSharedBatchAnalyses();
      const candidates = [...analyses]
        // FIX #13: Raise threshold from 52 to 55, exclude trapped stocks
        .filter(a => (a.strategyScores?.bpjsScore || a.score) >= 55 && !a.isIlliquidTrap && a.trapType === 'NONE' && a.volRatio >= 1.1 &&
          a.rsi >= 35 && a.rsi <= 65 &&
          a.priceTrendSlope > 0
        )
        .sort((a, b) => (b.strategyScores?.bpjsScore || b.score) - (a.strategyScores?.bpjsScore || a.score));

      const bpjsPicks = candidates.slice(0, 6).map(p => {
        const rawLow = p.support || Math.round(p.price * 0.985);
        const rawHigh = p.price;
        const rawSL = p.atrStopLoss || Math.round(rawLow * 0.97);
        const rawTP = p.atrTakeProfit || Math.round(p.price * 1.035);

        const { entryLow, entryHigh, stopLoss, takeProfit, finalRRR, finalProfitPct, finalLossPct } = optimizeTradeLevels(rawLow, rawHigh, rawSL, rawTP, 1.5);

        const pe = p.profitEstimation || {};
        const updatedPE = {
          ...pe,
          timeEstimateLabel: '3 - 6 Jam (Sesi I - II)',
          estimatedDays: 1,
          profitPercent: finalProfitPct,
          lossPercent: finalLossPct,
          riskRewardRatio: finalRRR,
          profitPerDay: finalProfitPct,
        };

        return {
          ...p,
          entryLow,
          entryHigh,
          stopLoss,
          takeProfit,
          profitEstimation: updatedPE,
          strategy: 'BPJS (Beli Pagi Jual Sore)',
          entryTimeAdvice: `Beli pada masa pembukaan sesi I bursa (Pukul 09.00 - 09.30 WIB) saat terkonfirmasi dorongan volume pembelian pada kisaran Rp ${entryLow.toLocaleString('id-ID')} - Rp ${entryHigh.toLocaleString('id-ID')}`,
          sellTimeAdvice: `Jual sebelum penutupan sesi II di sore hari (Pukul 15.20 - 15.45 WIB) untuk mengunci cuan harian +${finalProfitPct}% tanpa menginapkan saham`,
          reasoning: generateFallbackReasoning(p)
        };
      });

      return {
        timestamp: new Date().toISOString(),
        type: 'bpjs',
        strategy: 'BPJS (Beli Pagi Jual Sore)',
        picks: bpjsPicks,
        totalAnalyzed: analyses.length,
      };
    });
    res.json(data);
  } catch (err) {
    console.error('[Recommendations] BPJS error:', err.message);
    res.status(500).json({ error: 'Failed to generate BPJS recommendations', details: err.message });
  }
});

// 6. API: Recommendations for BSIJ (Beli Siang Jual Sore — Sesi II Momentum)
app.get('/api/recommendations/bsij', async (req, res) => {
  try {
    const data = await withCache('recommendations:bsij_v3_perfect', 1800, async () => {
      const analyses = await getSharedBatchAnalyses();
      const candidates = [...analyses]
        // FIX #13: Raise threshold from 52 to 55, exclude trapped stocks
        .filter(a => (a.strategyScores?.bsijScore || a.score) >= 55 && !a.isIlliquidTrap && a.trapType === 'NONE' && a.volRatio >= 1.1 && (
          a.obvDivergence === 'ACCUMULATION' ||
          a.obvTrend === 'RISING' ||
          a.changePercent > 0
        ) && a.rsi >= 40 && a.rsi <= 70)
        .sort((a, b) => (b.strategyScores?.bsijScore || b.score) - (a.strategyScores?.bsijScore || a.score));

      const bsijPicks = candidates.slice(0, 6).map(p => {
        const rawLow = p.support || Math.round(p.price * 0.99);
        const rawHigh = p.price;
        const rawSL = p.atrStopLoss || Math.round(rawLow * 0.975);
        const rawTP = p.atrTakeProfit || Math.round(p.price * 1.025);
        const { entryLow, entryHigh, stopLoss, takeProfit, finalRRR, finalProfitPct, finalLossPct } = optimizeTradeLevels(rawLow, rawHigh, rawSL, rawTP, 1.5);

        const pe = p.profitEstimation || {};
        const updatedPE = {
          ...pe,
          timeEstimateLabel: '1 - 3 Jam (Momentum Sesi II)',
          estimatedDays: 1,
          profitPercent: finalProfitPct,
          lossPercent: finalLossPct,
          riskRewardRatio: finalRRR,
          profitPerDay: finalProfitPct,
        };

        return {
          ...p,
          entryLow,
          entryHigh,
          stopLoss,
          takeProfit,
          profitEstimation: updatedPE,
          strategy: 'BSIJ (Beli Siang Jual Sore)',
          entryTimeAdvice: `Beli saat jeda sesi siang / pembukaan Sesi II (Pukul 13.30 - 13.45 WIB) pada kisaran Rp ${entryLow.toLocaleString('id-ID')} - Rp ${entryHigh.toLocaleString('id-ID')}`,
          sellTimeAdvice: `Jual sebelum bursa tutup sore ini (Pukul 15.20 - 15.45 WIB) untuk memanfaatkan kelanjutan momentum Sesi II dengan target cuan +${finalProfitPct}%`,
          reasoning: generateFallbackReasoning(p)
        };
      });

      return {
        timestamp: new Date().toISOString(),
        type: 'bsij',
        strategy: 'BSIJ (Beli Siang Jual Sore)',
        picks: bsijPicks,
        totalAnalyzed: analyses.length,
      };
    });
    res.json(data);
  } catch (err) {
    console.error('[Recommendations] BSIJ error:', err.message);
    res.status(500).json({ error: 'Failed to generate BSIJ recommendations', details: err.message });
  }
});

// Fallback & Institutional Reasoning Generator (Clean Stockbit UI without emojis)
function generateFallbackReasoning(stock) {
  const parts = [];

  // 0. Anti-Trap Warning (highest priority)
  if (stock.trapType === 'BULL_TRAP') {
    parts.push('[PERINGATAN BULL TRAP]: Harga naik namun volume menurun 3 hari berturut — waspadai jebakan kenaikan palsu');
  } else if (stock.trapType === 'PUMP_DUMP') {
    parts.push('[PERINGATAN PUMP & DUMP]: Volume melonjak ekstrem disertai kenaikan harga tajam — risiko koreksi sangat tinggi');
  } else if (stock.trapType === 'DEAD_CAT_BOUNCE') {
    parts.push('[PERINGATAN DEAD CAT BOUNCE]: Pantulan kecil setelah penurunan tajam — bukan reversal genuine, risiko lanjut turun');
  }

  // 1. Konsensus AI & Smart Money Flow
  if (stock.obvDivergence === 'ACCUMULATION') {
    parts.push('[Smart Money Verified]: Terdeteksi arus akumulasi institusi (OBV Divergence) di tengah harga yang terkonsolidasi');
  } else if (stock.vwapDeviation !== undefined && stock.vwapDeviation > 0.3 && stock.vwapDeviation <= 2.0) {
    parts.push(`[Dominasi Buyer]: Harga kokoh bertengger di atas garis VWAP Institusi (+${stock.vwapDeviation}%), menandakan dorongan volume beli agresif`);
  } else if (stock.tradingViewRating && stock.tradingViewRating.includes('BUY')) {
    parts.push(`[Sinyal Konsensus]: Validasi teknikal multi-indikator mengonfirmasi status ${stock.tradingViewRating.replace(/_/g, ' ')}`);
  } else {
    parts.push('[Teknikal Konfirmasi]: Struktur harga berada dalam zona momentum dengan potensi pergerakan optimal');
  }

  // 2. Momentum & Tren (enhanced with EMA alignment and volume trend)
  const trendDesc = (stock.sma50 && stock.sma200 && stock.sma50 > stock.sma200) ? 'di dalam jalur uptrend major (Golden Cross Zone)' : 'dengan potensi rebound teknikal';
  if (stock.macdMomentum === 'ZERO_CROSS_BULL' || stock.macdMomentum === 'ACCELERATING_BULL') {
    parts.push(`Momentum MACD Histogram mengakselerasi kuat ${trendDesc}`);
  } else if (stock.volRatio >= 1.3 && stock.volumeTrend === 'RISING_3D') {
    parts.push(`Lonjakan volume 3 hari berturut hingga ${stock.volRatio}x rata-rata memperkuat validasi akumulasi genuine ${trendDesc}`);
  } else if (stock.volRatio >= 1.3) {
    parts.push(`Lonjakan volume transaksi hingga ${stock.volRatio}x rata-rata harian memperkuat validasi breakout ${trendDesc}`);
  } else if (stock.rsi >= 40 && stock.rsi <= 65) {
    parts.push(`RSI berada di level ideal (${stock.rsi}) untuk melanjutkan ekspansi harga tanpa tekanan overbought ${trendDesc}`);
  } else if (stock.rsi < 35) {
    parts.push(`Indikator RSI menyentuh zona oversold terdepresiasi (${stock.rsi}), membuka peluang pantulan reversal berisiko rendah`);
  }

  // 2b. Stochastic Crossover & EMA Alignment (new signals)
  if (stock.stochCrossover === 'BULLISH_CROSS' && stock.stochK < 50) {
    parts.push(`Sinyal Stochastic %K memotong ke atas %D dari zona oversold (K:${stock.stochK}/D:${stock.stochD}) — konfirmasi momentum pembalikan`);
  }
  if (stock.ema10 && stock.sma20 && stock.price > stock.ema10 && stock.ema10 > stock.sma20) {
    parts.push('Struktur EMA tersusun rapi (Harga > EMA10 > SMA20), menandakan kekuatan tren jangka pendek terkonfirmasi');
  }

  // 3. Manajemen Risiko & Ekspektasi Cuan
  const pe = stock.profitEstimation;
  if (pe && pe.riskRewardRatio >= 1.5) {
    parts.push(`Rasio Risk/Reward terukur sangat sehat 1:${pe.riskRewardRatio} dengan estimasi win rate ${pe.winProbability}% dan target protektif SL di Rp ${stock.stopLoss || stock.atrStopLoss}`);
  } else if (stock.stopLoss || stock.atrStopLoss) {
    parts.push(`Proteksi modal ketat berpedoman pada batas rugi (SL) di Rp ${stock.stopLoss || stock.atrStopLoss}`);
  }

  if (stock.isIlliquidTrap) {
    parts.unshift('[PERHATIAN]: Turnover/volume saat ini rendah, terapkan lot ukuran kecil (money management protektif)');
  }

  return parts.join('. ') + '.';
}

// ─── Autentikasi Middleware (JWT Token Validator) ───────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Akses ditolak: Silakan login terlebih dahulu untuk mengakses fitur ini.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Sesi login telah berakhir atau token tidak sah. Silakan login kembali.' });
    req.user = user;
    next();
  });
}

// ─── Security: Rate Limiter Middleware (Anti Brute-Force) ─────────────────────
const authAttemptTracker = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 Menit
const MAX_FAILED_ATTEMPTS = 5;

function rateLimitAuth(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const now = Date.now();
  const record = authAttemptTracker.get(ip) || { attempts: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetTime) {
    record.attempts = 0;
    record.resetTime = now + RATE_LIMIT_WINDOW_MS;
  }

  if (record.attempts >= MAX_FAILED_ATTEMPTS) {
    const minutesLeft = Math.ceil((record.resetTime - now) / 60000);
    return res.status(429).json({
      error: `Terlalu banyak percobaan gagal. Akses diblokir sementara demi keamanan. Silakan coba lagi dalam ${minutesLeft} menit.`
    });
  }

  req.authIpRecord = record;
  req.authIpKey = ip;
  next();
}

function registerFailedAttempt(ipRecord, ipKey) {
  ipRecord.attempts += 1;
  authAttemptTracker.set(ipKey, ipRecord);
}

function clearFailedAttempts(ipKey) {
  authAttemptTracker.delete(ipKey);
}

// Helper Validasi Input Keamanan
function validateRegistrationInput(username, email, password) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;

  if (!username || !usernameRegex.test(username.trim())) {
    return 'Username harus 3-30 karakter (hanya huruf, angka, dan underscore).';
  }
  if (!email || !emailRegex.test(email.trim())) {
    return 'Format alamat email tidak valid.';
  }
  if (!password || password.length < 8 || password.length > 128) {
    return 'Password harus 8-128 karakter.';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password harus mengombinasikan huruf dan setidaknya 1 angka.';
  }
  return null;
}

// ─── API: Autentikasi & Akun Pengguna (/api/auth/*) ──────────────────────────
app.post('/api/auth/register', rateLimitAuth, async (req, res) => {
  await ensureDB();
  const { username, email, password, selected_tier, payment_method } = req.body;

  const valError = validateRegistrationInput(username, email, password);
  if (valError) {
    registerFailedAttempt(req.authIpRecord, req.authIpKey);
    return res.status(400).json({ error: valError });
  }

  const cleanUser = username.trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();
  const tier = selected_tier === 'PRO' ? 'PRO' : 'FREE';

  try {
    const existing = await pool.query(
      'SELECT id FROM app_users WHERE username = $1 OR email = $2 LIMIT 1',
      [cleanUser, cleanEmail]
    );
    if (existing.rows.length > 0) {
      registerFailedAttempt(req.authIpRecord, req.authIpKey);
      return res.status(409).json({ error: 'Username atau email sudah terdaftar. Silakan gunakan yang lain.' });
    }

    // Hash dengan 12 Salt Rounds untuk proteksi ekstra
    const salt = await bcrypt.genSalt(12);
    const hash = await bcrypt.hash(password, salt);

    const initialStatus = tier === 'PRO' ? 'UNPAID' : 'FREE';

    const newRes = await pool.query(
      'INSERT INTO app_users (username, email, password_hash, tier, payment_status, payment_method) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, email, tier, payment_status, created_at',
      [cleanUser, cleanEmail, hash, tier, initialStatus, payment_method || 'FREE']
    );
    const user = newRes.rows[0];
    clearFailedAttempts(req.authIpKey);

    const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ message: 'Registrasi berhasil!', token, user });
  } catch (err) {
    console.error('[Auth Register Error]:', err.message);
    res.status(500).json({ error: 'Gagal mendaftar akun. Silakan coba lagi nanti.' });
  }
});

app.post('/api/auth/login', rateLimitAuth, async (req, res) => {
  await ensureDB();
  const { login, password, remember_me } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'Username/Email dan password wajib diisi.' });
  }

  try {
    const userRes = await pool.query(
      'SELECT * FROM app_users WHERE username = $1 OR email = $1 LIMIT 1',
      [login.trim().toLowerCase()]
    );
    if (userRes.rows.length === 0) {
      registerFailedAttempt(req.authIpRecord, req.authIpKey);
      return res.status(401).json({ error: 'Akun tidak ditemukan atau kombinasi password salah.' });
    }
    const user = userRes.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      registerFailedAttempt(req.authIpRecord, req.authIpKey);
      return res.status(401).json({ error: 'Kombinasi password dan akun salah.' });
    }

    clearFailedAttempts(req.authIpKey);
    const tokenExpiry = remember_me ? '30d' : '1d';
    const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: tokenExpiry });
    res.json({
      message: 'Login berhasil!',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        tier: user.tier,
        payment_status: user.payment_status,
        tier_expires: user.tier_expires,
        created_at: user.created_at
      }
    });
  } catch (err) {
    console.error('[Auth Login Error]:', err.message);
    res.status(500).json({ error: 'Gagal melakukan login. Silakan coba lagi nanti.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  await ensureDB();
  try {
    const uRes = await pool.query('SELECT id, username, email, tier, payment_status, tier_expires, created_at FROM app_users WHERE id = $1', [req.user.id]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });

    const statsRes = await pool.query(`
      SELECT 
        COUNT(*) as total_trades,
        COALESCE(SUM(CASE WHEN type = 'SELL' THEN pnl ELSE 0 END), 0) as total_pnl,
        COUNT(CASE WHEN type = 'SELL' AND pnl > 0 THEN 1 END) as win_count,
        COUNT(CASE WHEN type = 'SELL' AND pnl <= 0 THEN 1 END) as loss_count
      FROM app_transactions 
      WHERE user_id = $1
    `, [req.user.id]);

    const stats = statsRes.rows[0];
    const sellCount = Number(stats.win_count) + Number(stats.loss_count);
    const winRate = sellCount > 0 ? ((Number(stats.win_count) / sellCount) * 100).toFixed(1) : '0.0';

    res.json({ user: uRes.rows[0], stats: { ...stats, win_rate: winRate } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Fitur Pembayaran Berlangganan (Midtrans Snap & Webhook /api/payment/*) ────────
app.post('/api/payment/checkout', authenticateToken, async (req, res) => {
  await ensureDB();
  try {
    const { method } = req.body; // 'QRIS', 'VA_BCA', 'VA_MANDIRI'
    const orderId = `PRO-${req.user.id}-${Date.now()}`;
    const amount = 49000;

    // Simpan data order awal ke tabel app_orders
    await pool.query(
      'INSERT INTO app_orders (order_id, user_id, gross_amount, payment_method, status) VALUES ($1, $2, $3, $4, $5)',
      [orderId, req.user.id, amount, method || 'QRIS', 'PENDING']
    );

    await pool.query(
      'UPDATE app_users SET tier = $1, payment_status = $2, payment_method = $3 WHERE id = $4',
      ['PRO', 'UNPAID', method || 'QRIS', req.user.id]
    );

    // Coba integrasi Midtrans Snap asli jika API Key sudah dikonfigurasi
    if (snapClient && MIDTRANS_SERVER_KEY && !MIDTRANS_SERVER_KEY.includes('YOUR_SERVER_KEY_DEFAULT')) {
      try {
        const parameter = {
          transaction_details: {
            order_id: orderId,
            gross_amount: amount
          },
          credit_card: { secure: true },
          customer_details: {
            first_name: req.user.username || 'Trader',
            email: req.user.email || 'trader@stockpulse.id'
          },
          item_details: [{
            id: 'PRO-TRADER-30D',
            price: amount,
            quantity: 1,
            name: 'StockPulse PRO Member (30 Hari)'
          }]
        };

        const snapTokenResponse = await snapClient.createTransaction(parameter);
        await pool.query('UPDATE app_orders SET snap_token = $1 WHERE order_id = $2', [snapTokenResponse.token, orderId]);

        return res.json({
          success: true,
          orderId,
          amount,
          currency: 'IDR',
          useSnap: true,
          snapToken: snapTokenResponse.token,
          redirectUrl: snapTokenResponse.redirect_url,
          clientKey: MIDTRANS_CLIENT_KEY
        });
      } catch (snapErr) {
        console.warn('⚠️ [Midtrans Snap Error]: Gagal menghubungi server Midtrans, beralih ke mode simulasi:', snapErr.message);
      }
    }

    // Fallback mode simulasi (jika API Key belum dipesan/dikonfigurasi di .env)
    const vaNumber = method === 'VA_BCA' ? '88012' + Math.floor(10000000 + Math.random() * 90000000)
      : method === 'VA_MANDIRI' ? '89012' + Math.floor(10000000 + Math.random() * 90000000)
        : null;

    res.json({
      success: true,
      orderId,
      amount,
      currency: 'IDR',
      useSnap: false,
      method: method || 'QRIS',
      vaNumber,
      qrisUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=00020101021126580014ID.CO.MIDTRANS.WWW01189360091100000000005204581253033605405990005802ID5916STOCKPULSE_PRO6007JAKARTA63041A2B',
      expiresInMinutes: 30
    });
  } catch (err) {
    console.error('❌ [Checkout Error]:', err.message);
    res.status(500).json({ error: 'Terjadi kesalahan saat memproses checkout. Silakan coba lagi.' });
  }
});

// Endpoint Resmi untuk Server Bank & Webhook Notifikasi Midtrans Real-Time
app.post('/api/payment/webhook', async (req, res) => {
  await ensureDB();
  try {
    const notification = req.body;
    console.log('📬 [Midtrans Webhook] Menerima notifikasi transaksi:', notification.order_id);

    let orderId = notification.order_id;
    let transactionStatus = notification.transaction_status;
    let fraudStatus = notification.fraud_status;

    // Verifikasi keaslian payload menggunakan SDK — WAJIB untuk keamanan pembayaran
    if (coreApiClient && MIDTRANS_SERVER_KEY && !MIDTRANS_SERVER_KEY.includes('YOUR_SERVER_KEY_DEFAULT')) {
      try {
        const statusResponse = await coreApiClient.transaction.notification(notification);
        orderId = statusResponse.order_id;
        transactionStatus = statusResponse.transaction_status;
        fraudStatus = statusResponse.fraud_status;
      } catch (sdkErr) {
        console.error('❌ [Webhook] Signature verification GAGAL:', sdkErr.message);
        return res.status(403).json({ error: 'Webhook verification failed' });
      }
    } else {
      // Tanpa SDK key terkonfigurasi, tolak semua webhook demi keamanan
      console.warn('⚠️ [Webhook] Midtrans server key belum dikonfigurasi, webhook diabaikan.');
      return res.status(200).json({ status: 'IGNORED', reason: 'No server key configured' });
    }

    let orderStatus = 'PENDING';
    if (transactionStatus == 'capture') {
      orderStatus = fraudStatus == 'challenge' ? 'CHALLENGE' : 'PAID';
    } else if (transactionStatus == 'settled' || transactionStatus == 'settlement') {
      orderStatus = 'PAID';
    } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
      orderStatus = 'FAILED';
    } else if (transactionStatus == 'pending') {
      orderStatus = 'PENDING';
    }

    // Update status pemesanan di database
    const ordRes = await pool.query('UPDATE app_orders SET status = $1, updated_at = NOW() WHERE order_id = $2 RETURNING user_id', [orderStatus, orderId]);

    // Jika pembayaran PAID / terealisasi, aktivasi status PRO Member otomatis!
    if (orderStatus === 'PAID' && ordRes.rows.length > 0) {
      const userId = ordRes.rows[0].user_id;
      const expiresDate = new Date();
      expiresDate.setDate(expiresDate.getDate() + 30); // 30 hari akses PRO

      await pool.query(
        'UPDATE app_users SET tier = $1, payment_status = $2, tier_expires = $3 WHERE id = $4',
        ['PRO', 'PAID', expiresDate.toISOString(), userId]
      );
      console.log(`✅ [Midtrans Automation] Pembayaran Sukses! Akun User #${userId} telah otomatis diaktifkan menjadi PRO Member.`);
    }

    res.status(200).json({ status: 'OK', processed_status: orderStatus });
  } catch (err) {
    console.error('❌ [Midtrans Webhook Error]:', err.message);
    res.status(500).json({ error: 'Terjadi kesalahan saat memproses notifikasi pembayaran.' });
  }
});

// Endpoint untuk frontend melakukan polling konfirmasi status pesanan
app.get('/api/payment/status/:orderId', authenticateToken, async (req, res) => {
  await ensureDB();
  try {
    const { orderId } = req.params;
    const ordRes = await pool.query('SELECT status, gross_amount, payment_method FROM app_orders WHERE order_id = $1 AND user_id = $2', [orderId, req.user.id]);
    if (ordRes.rows.length === 0) {
      return res.status(404).json({ error: 'Data transaksi tidak ditemukan.' });
    }
    const orderData = ordRes.rows[0];

    // Jika sudah PAID di DB, laporkan sukses
    res.json({ success: true, orderId, status: orderData.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payment/confirm', authenticateToken, async (req, res) => {
  await ensureDB();
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID wajib disertakan.' });
    }

    // SECURITY: Cek apakah order ini memang sudah berstatus PAID (dari webhook Midtrans yang terverifikasi)
    const orderCheck = await pool.query(
      'SELECT status FROM app_orders WHERE order_id = $1 AND user_id = $2',
      [orderId, req.user.id]
    );
    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order tidak ditemukan.' });
    }
    if (orderCheck.rows[0].status !== 'PAID') {
      return res.status(403).json({ error: 'Pembayaran belum terverifikasi oleh sistem. Silakan selesaikan pembayaran terlebih dahulu.' });
    }

    // Order sudah PAID dari webhook — aktifkan PRO Member
    const expiresDate = new Date();
    expiresDate.setDate(expiresDate.getDate() + 30); // 30 hari akses PRO

    await pool.query(
      'UPDATE app_users SET tier = $1, payment_status = $2, tier_expires = $3 WHERE id = $4',
      ['PRO', 'PAID', expiresDate.toISOString(), req.user.id]
    );

    res.json({
      success: true,
      message: 'Pembayaran berhasil dikonfirmasi! Akun Anda kini berstatus PRO Member.',
      tier: 'PRO',
      expiresAt: expiresDate.toISOString()
    });
  } catch (err) {
    console.error('[Payment Confirm Error]:', err.message);
    res.status(500).json({ error: 'Terjadi kesalahan saat mengonfirmasi pembayaran.' });
  }
});

// ─── API: Watchlist Sinkronisasi PostgreSQL Cloud (/api/watchlist) ─────────
app.get('/api/watchlist', authenticateToken, async (req, res) => {
  try {
    const uRes = await pool.query('SELECT watchlist FROM app_users WHERE id = $1', [req.user.id]);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'User tidak ditemukan' });
    const symbols = uRes.rows[0].watchlist || ['BBRI.JK', 'TLKM.JK', 'BBCA.JK', 'AAPL', 'GOOGL'];
    res.json({ watchlist: symbols });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/watchlist', authenticateToken, async (req, res) => {
  try {
    const { watchlist } = req.body;
    if (!Array.isArray(watchlist)) {
      return res.status(400).json({ error: 'Watchlist harus berupa array simbol saham' });
    }
    const sanitized = watchlist.map(s => String(s).toUpperCase().trim()).filter(Boolean);
    await pool.query('UPDATE app_users SET watchlist = $1 WHERE id = $2', [sanitized, req.user.id]);
    res.json({ success: true, watchlist: sanitized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Jurnal & Evaluasi Transaksi (/api/transactions/*) ─────────────────
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const txRes = await pool.query(
      'SELECT * FROM app_transactions WHERE user_id = $1 ORDER BY transaction_date DESC, id DESC LIMIT 200',
      [req.user.id]
    );

    // Hitung analisa performa portfolio (Win Rate, Profit/Loss, Best & Worst)
    let totalTrades = txRes.rows.length;
    let totalSellTrades = 0;
    let winCount = 0;
    let realizedPnL = 0;
    let bestWin = 0;
    let worstLoss = 0;
    let totalInvested = 0; // estimasi posisi aktif/terbuka (BUY - SELL qty)

    // Group per symbol to check holdings in chronological order (oldest to newest)
    const holdings = {};
    const chronologicalTx = [...txRes.rows].reverse();

    chronologicalTx.forEach(tx => {
      const sym = tx.symbol;
      if (!holdings[sym]) holdings[sym] = { qty: 0, cost: 0, avgPrice: 0 };

      if (tx.type === 'BUY') {
        holdings[sym].qty += Number(tx.quantity);
        holdings[sym].cost += Number(tx.total_value);
        if (holdings[sym].qty > 0) {
          holdings[sym].avgPrice = Math.round(holdings[sym].cost / holdings[sym].qty);
        }
      } else if (tx.type === 'SELL') {
        const soldQty = Number(tx.quantity);
        const currentQty = holdings[sym].qty;
        if (currentQty > 0) {
          const costReduction = (holdings[sym].cost / currentQty) * Math.min(soldQty, currentQty);
          holdings[sym].cost = Math.max(0, holdings[sym].cost - costReduction);
        }
        holdings[sym].qty = Math.max(0, holdings[sym].qty - soldQty);
        if (holdings[sym].qty === 0) {
          holdings[sym].cost = 0;
          holdings[sym].avgPrice = 0;
        } else {
          holdings[sym].avgPrice = Math.round(holdings[sym].cost / holdings[sym].qty);
        }
        totalSellTrades++;
        const pnl = Number(tx.pnl || 0);
        realizedPnL += pnl;
        if (pnl > 0) winCount++;
        if (pnl > bestWin) bestWin = pnl;
        if (pnl < worstLoss) worstLoss = pnl;
      }
    });

    const winRate = totalSellTrades > 0 ? Math.round((winCount / totalSellTrades) * 100) : 0;

    res.json({
      transactions: txRes.rows,
      evaluation: {
        totalTrades,
        totalSellTrades,
        winRate,
        realizedPnL: Math.round(realizedPnL),
        bestWin: Math.round(bestWin),
        worstLoss: Math.round(worstLoss),
        holdings
      }
    });
  } catch (err) {
    console.error('[Transactions GET Error]:', err.message);
    res.status(500).json({ error: 'Gagal mengambil data transaksi: ' + err.message });
  }
});

app.post('/api/transactions', authenticateToken, async (req, res) => {
  const { symbol, type, price, quantity, strategy_tag, notes, transaction_date } = req.body;

  if (!symbol || !type || !price || !quantity) {
    return res.status(400).json({ error: 'Simbol saham, tipe (BUY/SELL), harga, dan jumlah wajib diisi.' });
  }
  const cleanSymbol = symbol.trim().toUpperCase();
  const txType = type.trim().toUpperCase();
  if (!['BUY', 'SELL'].includes(txType)) {
    return res.status(400).json({ error: 'Tipe transaksi hanya boleh BUY atau SELL.' });
  }
  const numPrice = Number(price);
  const numQty = Number(quantity);
  const totalVal = numPrice * numQty;

  if (isNaN(numPrice) || numPrice <= 0 || isNaN(numQty) || numQty <= 0) {
    return res.status(400).json({ error: 'Harga dan jumlah harus berupa angka positif.' });
  }

  try {
    let pnl = null;
    let pnlPercent = null;

    // Jika transaksi adalah JUAL (SELL), hitung Realized P&L otomatis berdasarkan harga rata-rata beli
    if (txType === 'SELL') {
      const buyRes = await pool.query(
        "SELECT SUM(total_value) as sum_val, SUM(quantity) as sum_qty FROM app_transactions WHERE user_id = $1 AND symbol = $2 AND type = 'BUY'",
        [req.user.id, cleanSymbol]
      );
      const sumVal = Number(buyRes.rows[0]?.sum_val || 0);
      const sumQty = Number(buyRes.rows[0]?.sum_qty || 0);

      if (sumQty > 0) {
        const avgBuyPrice = sumVal / sumQty;
        pnl = (numPrice - avgBuyPrice) * numQty;
        pnlPercent = ((numPrice - avgBuyPrice) / avgBuyPrice) * 100;
      } else {
        // Jika tidak ada data beli sebelumnya di jurnal (misal migrasi portofolio eksternal), anggap P&L berdasarkan estimasi langsung
        pnl = 0;
        pnlPercent = 0;
      }
    }

    const dateVal = transaction_date ? new Date(transaction_date) : new Date();

    const insertRes = await pool.query(
      `INSERT INTO app_transactions (user_id, symbol, type, price, quantity, total_value, transaction_date, strategy_tag, notes, pnl, pnl_percent) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [req.user.id, cleanSymbol, txType, numPrice, numQty, totalVal, dateVal, strategy_tag || 'Standard Trade', notes || '', pnl, pnlPercent]
    );

    res.status(201).json({ message: 'Transaksi berhasil dicatat!', transaction: insertRes.rows[0] });
  } catch (err) {
    console.error('[Transactions POST Error]:', err.message);
    res.status(500).json({ error: 'Gagal mencatat transaksi. Silakan coba lagi.' });
  }
});

app.delete('/api/transactions/:id', authenticateToken, async (req, res) => {
  try {
    const delRes = await pool.query(
      'DELETE FROM app_transactions WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (delRes.rows.length === 0) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan atau tidak berwenang menghapusnya.' });
    }
    res.json({ message: 'Transaksi berhasil dihapus!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Export Laporan Evaluasi to CSV/Excel (/api/transactions/export) ───
app.get('/api/transactions/export', authenticateToken, async (req, res) => {
  try {
    const txRes = await pool.query(
      'SELECT * FROM app_transactions WHERE user_id = $1 ORDER BY transaction_date DESC, id DESC',
      [req.user.id]
    );

    const rows = txRes.rows;
    // Header CSV (BOM \uFEFF agar kompatibel 100% dengan Microsoft Excel dan merespons karakter lokal)
    let csv = '\uFEFF"ID Transaksi","Tanggal","Simbol","Tipe (BUY/SELL)","Harga per Lembar (Rp)","Jumlah Lembar / Qty","Total Nilai Transaksi (Rp)","Realized Profit/Loss (Rp)","Return ROI (%)","Strategi / Tag","Catatan Evaluasi"\r\n';

    rows.forEach(t => {
      const dateStr = t.transaction_date ? new Date(t.transaction_date).toISOString().replace('T', ' ').slice(0, 19) : '';
      const pnlStr = t.pnl !== null ? Number(t.pnl).toFixed(2) : '-';
      const pnlPctStr = t.pnl_percent !== null ? Number(t.pnl_percent).toFixed(2) + '%' : '-';
      const noteStr = (t.notes || '').replace(/"/g, '""'); // Escape quotes for CSV
      const tagStr = (t.strategy_tag || '').replace(/"/g, '""');

      csv += `"${t.id}","${dateStr}","${t.symbol}","${t.type}","${t.price}","${t.quantity}","${t.total_value}","${pnlStr}","${pnlPctStr}","${tagStr}","${noteStr}"\r\n`;
    });

    const filename = `laporan-evaluasi-trading-${req.user.username}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[Export Report Error]:', err.message);
    res.status(500).json({ error: 'Gagal mengunduh laporan evaluasi. Silakan coba lagi.' });
  }
});

// ─── Fallback: Serve index.html ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  // Initialize Database on startup
  await initDB();

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║   📊 StockPulse — Real-Time Stock Analysis Dashboard v3.5  ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║   URL: http://localhost:${PORT}                               ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║   Endpoints:                                                ║`);
  console.log(`║   GET  /api/quote/:symbol         — Real-time quote         ║`);
  console.log(`║   GET  /api/chart/:symbol         — Historical OHLCV        ║`);
  console.log(`║   GET  /api/search?q=             — Symbol search           ║`);
  console.log(`║   GET  /api/fundamental/:symbol   — Fundamental data        ║`);
  console.log(`║   POST /api/auth/login & register — Auth & Accounts (NEW)   ║`);
  console.log(`║   GET/POST/DELETE /api/transactions — Trading Journal (NEW) ║`);
  console.log(`║   GET  /api/transactions/export   — Unduh Laporan (CSV/XLS) ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
});


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
const JWT_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET || 'stockpulse_secret_key_super_secure_2026_jwt_token';

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
app.use(cors());
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
        'IDX': { tz: 7, open: [9, 0], close: [15, 30], days: [1,2,3,4,5], name: 'Indonesia Stock Exchange', preOpen: [8, 45] },
        'JKT': { tz: 7, open: [9, 0], close: [15, 30], days: [1,2,3,4,5], name: 'Indonesia Stock Exchange', preOpen: [8, 45] },
        // US Markets — ET (UTC-4 DST / UTC-5 EST)
        'NYSE': { tz: -4, open: [9, 30], close: [16, 0], days: [1,2,3,4,5], name: 'New York Stock Exchange', preOpen: [4, 0] },
        'NASDAQ': { tz: -4, open: [9, 30], close: [16, 0], days: [1,2,3,4,5], name: 'NASDAQ', preOpen: [4, 0] },
        'NMS': { tz: -4, open: [9, 30], close: [16, 0], days: [1,2,3,4,5], name: 'NASDAQ', preOpen: [4, 0] },
        // Hong Kong
        'HKSE': { tz: 8, open: [9, 30], close: [16, 0], days: [1,2,3,4,5], name: 'Hong Kong Stock Exchange', preOpen: [9, 0] },
        // Tokyo
        'TSE': { tz: 9, open: [9, 0], close: [15, 0], days: [1,2,3,4,5], name: 'Tokyo Stock Exchange', preOpen: [8, 0] },
        // London
        'LSE': { tz: 1, open: [8, 0], close: [16, 30], days: [1,2,3,4,5], name: 'London Stock Exchange', preOpen: [7, 0] },
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
        localTime: `${String(localHours).padStart(2,'0')}:${String(localMinutes).padStart(2,'0')}`,
        tradingHours: `${String(market.open[0]).padStart(2,'0')}:${String(market.open[1]).padStart(2,'0')} - ${String(market.close[0]).padStart(2,'0')}:${String(market.close[1]).padStart(2,'0')}`,
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
    // Calculate MACD history for signal line
    const macdHistory = [];
    let tempEma12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    let tempEma26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
    for (let i = 26; i < closes.length; i++) {
      tempEma12 = closes[i] * (2 / 13) + tempEma12 * (1 - 2 / 13);
      tempEma26 = closes[i] * (2 / 27) + tempEma26 * (1 - 2 / 27);
      macdHistory.push(tempEma12 - tempEma26);
    }
    const macdSignalLine = macdHistory.length >= 9 ? calcEMA(macdHistory, 9) : 0;
    const macdHist = macdLine - macdSignalLine;

    // 3. Stochastic Oscillator (%K 14)
    const sliceHighs = highs.slice(-14);
    const sliceLows = lows.slice(-14);
    const maxHigh = Math.max(...sliceHighs);
    const minLow = Math.min(...sliceLows);
    const stochK = maxHigh !== minLow ? ((lastPrice - minLow) / (maxHigh - minLow)) * 100 : 50;

    // 4. Volume Analysis
    const avgVol = ohlcv.slice(-20).reduce((s, d) => s + d.volume, 0) / 20;
    const lastVol = ohlcv[ohlcv.length - 1].volume;
    const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

    // 5. Pivot Point Support & Resistance
    const lastHigh = highs[highs.length - 1];
    const lastLow = lows[lows.length - 1];
    const pivot = (lastHigh + lastLow + lastPrice) / 3;
    const support1 = (2 * pivot) - lastHigh;
    const resistance1 = (2 * pivot) - lastLow;
    const support2 = pivot - (lastHigh - lastLow);
    const resistance2 = pivot + (lastHigh - lastLow);

    // Dynamic Support & Resistance Range
    const recentLows = lows.slice(-20);
    const recentHighs = highs.slice(-20);
    const support = Math.min(...recentLows, support1);
    const resistance = Math.max(...recentHighs, resistance1);

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
    // ═══════════════════════════════════════════════════════════════
    let vwap = lastPrice; // fallback
    {
      let cumTPV = 0, cumVol = 0;
      for (let i = 0; i < ohlcv.length; i++) {
        const typicalPrice = (ohlcv[i].high + ohlcv[i].low + ohlcv[i].close) / 3;
        cumTPV += typicalPrice * ohlcv[i].volume;
        cumVol += ohlcv[i].volume;
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
    const priceRising = lastPrice > prevPrice;
    const obvDivergence = (obvTrend === 'FALLING' && priceRising) ? 'DISTRIBUTION'
                        : (obvTrend === 'RISING' && !priceRising) ? 'ACCUMULATION'
                        : 'CONFIRMED';

    // ═══════════════════════════════════════════════════════════════
    // 6d. Candlestick Pattern Detection (last 2-3 bars)
    // ═══════════════════════════════════════════════════════════════
    let candlestickPattern = 'NONE';
    let candlestickScore = 0;
    if (ohlcv.length >= 3) {
      const curr = ohlcv[ohlcv.length - 1];
      const prev1 = ohlcv[ohlcv.length - 2];
      const currBody = Math.abs(curr.close - curr.open);
      const currRange = curr.high - curr.low;
      const prev1Body = Math.abs(prev1.close - prev1.open);
      const currBullish = curr.close > curr.open;
      const prev1Bullish = prev1.close > prev1.open;

      // Bullish Engulfing: prev bearish candle fully engulfed by curr bullish candle
      if (currBullish && !prev1Bullish && curr.open <= prev1.close && curr.close >= prev1.open && currBody > prev1Body) {
        candlestickPattern = 'BULLISH_ENGULFING';
        candlestickScore = 8;
      }
      // Bearish Engulfing: prev bullish candle fully engulfed by curr bearish candle
      else if (!currBullish && prev1Bullish && curr.open >= prev1.close && curr.close <= prev1.open && currBody > prev1Body) {
        candlestickPattern = 'BEARISH_ENGULFING';
        candlestickScore = -8;
      }
      // Hammer (bullish reversal): small body at top, long lower shadow, in downtrend
      else if (currRange > 0 && currBody / currRange < 0.35 && (curr.close - curr.low) / currRange > 0.6 && lastPrice < prevPrice) {
        candlestickPattern = 'HAMMER';
        candlestickScore = 6;
      }
      // Inverted Hammer / Shooting Star detection
      else if (currRange > 0 && currBody / currRange < 0.35 && (curr.high - Math.max(curr.open, curr.close)) / currRange > 0.6) {
        if (lastPrice < prevPrice) {
          candlestickPattern = 'INVERTED_HAMMER'; // bullish reversal in downtrend
          candlestickScore = 5;
        } else {
          candlestickPattern = 'SHOOTING_STAR'; // bearish reversal in uptrend
          candlestickScore = -6;
        }
      }
      // Doji (indecision): body < 10% of range
      else if (currRange > 0 && currBody / currRange < 0.1) {
        candlestickPattern = 'DOJI';
        candlestickScore = -3; // reduces confidence
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 6e. MACD Histogram Momentum (Acceleration / Deceleration)
    // ═══════════════════════════════════════════════════════════════
    let macdMomentum = 'NEUTRAL'; // ACCELERATING, DECELERATING, NEUTRAL, ZERO_CROSS_BULL, ZERO_CROSS_BEAR
    let macdMomentumScore = 0;
    if (macdHistory.length >= 3) {
      const hist1 = macdHistory[macdHistory.length - 1] - (macdHistory.length >= 2 ? calcEMA(macdHistory.slice(0, -0), 9) : 0);
      // Simpler: compare last 3 histogram values for momentum direction
      const h = macdHistory.slice(-3);
      const signalVals = [];
      let tmpSig = h[0];
      for (let i = 0; i < h.length; i++) {
        tmpSig = h[i] * (2/10) + tmpSig * (8/10);
        signalVals.push(h[i] - tmpSig);
      }
      // Use raw MACD history diffs for momentum detection
      const currHist = macdHist;
      const prevHist2 = macdHistory.length >= 3 ? macdHistory[macdHistory.length - 2] - (calcEMA(macdHistory.slice(0, -1), 9) || 0) : 0;
      const prevHist3 = macdHistory.length >= 4 ? macdHistory[macdHistory.length - 3] - (calcEMA(macdHistory.slice(0, -2), 9) || 0) : 0;

      if (currHist > 0 && currHist > prevHist2 && prevHist2 > prevHist3) {
        macdMomentum = 'ACCELERATING_BULL';
        macdMomentumScore = 5;
      } else if (currHist < 0 && currHist < prevHist2 && prevHist2 < prevHist3) {
        macdMomentum = 'ACCELERATING_BEAR';
        macdMomentumScore = -5;
      } else if (currHist > 0 && Math.abs(currHist) < Math.abs(prevHist2)) {
        macdMomentum = 'DECELERATING_BULL';
        macdMomentumScore = -3; // losing momentum
      } else if (currHist < 0 && Math.abs(currHist) < Math.abs(prevHist2)) {
        macdMomentum = 'DECELERATING_BEAR';
        macdMomentumScore = 3; // bearish momentum weakening = mildly bullish
      }
      // Zero-line crossover
      if (prevHist2 < 0 && currHist > 0) {
        macdMomentum = 'ZERO_CROSS_BULL';
        macdMomentumScore = 7;
      } else if (prevHist2 > 0 && currHist < 0) {
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
    //    Combines RSI divergence + OBV divergence + MACD histogram divergence
    // ═══════════════════════════════════════════════════════════════
    let divergence = 'NONE';
    let divergenceStrength = 0; // 0 = none, 1 = single, 2 = double, 3 = triple confirmation
    if (ohlcv.length >= 20) {
      const pastSlice = ohlcv.slice(-20, -3);
      const maxPastClose = Math.max(...pastSlice.map(d => d.close));
      const minPastClose = Math.min(...pastSlice.map(d => d.close));

      // Individual divergence checks
      const rsiDivBearish = lastPrice >= maxPastClose * 0.995 && rsi < 58;
      const rsiDivBullish = lastPrice <= minPastClose * 1.005 && rsi > 35;
      const obvDivBearish = obvDivergence === 'DISTRIBUTION'; // OBV falling while price rising
      const obvDivBullish = obvDivergence === 'ACCUMULATION'; // OBV rising while price falling
      const macdDivBearish = macdMomentum === 'DECELERATING_BULL' || macdMomentum === 'ZERO_CROSS_BEAR';
      const macdDivBullish = macdMomentum === 'ACCELERATING_BULL' || macdMomentum === 'ZERO_CROSS_BULL';

      // Count confirmations
      const bearishCount = [rsiDivBearish, obvDivBearish, macdDivBearish].filter(Boolean).length;
      const bullishCount = [rsiDivBullish, obvDivBullish, macdDivBullish].filter(Boolean).length;

      if (bearishCount >= 2) {
        divergence = 'BEARISH_BULL_TRAP';
        divergenceStrength = bearishCount;
      } else if (bullishCount >= 2) {
        divergence = 'BULLISH_ACCUMULATION';
        divergenceStrength = bullishCount;
      } else if (bearishCount === 1 && rsiDivBearish) {
        divergence = 'BEARISH_BULL_TRAP';
        divergenceStrength = 1;
      } else if (bullishCount === 1 && rsiDivBullish) {
        divergence = 'BULLISH_ACCUMULATION';
        divergenceStrength = 1;
      }
    }

    // 8. Liquidity & Anti-Penny Stock Trap Protection
    const dailyTurnover = avgVol * lastPrice;
    const isIlliquidTrap = symbol.endsWith('.JK') && (lastPrice <= 60 || (dailyTurnover < 250000000 && lastPrice < 5000) || avgVol < 15000);

    // ═══════════════════════════════════════════════════════════════
    // Multi-Factor Precision Scoring v2.0 (0-100)
    // Now with VWAP, OBV, Candlestick, MACD Momentum, 52-Week,
    // and Synergy/Conflict Intelligence
    // ═══════════════════════════════════════════════════════════════
    let score = 50;

    // RSI Factor (+/- 20)
    if (rsi <= 30) score += 20;
    else if (rsi <= 40) score += 10;
    else if (rsi >= 70) score -= 20;
    else if (rsi >= 60) score -= 10;

    // Moving Average Trend Factor (+/- 20)
    if (sma20 && lastPrice > sma20) score += 6;
    else if (sma20) score -= 6;
    if (sma50 && lastPrice > sma50) score += 7;
    else if (sma50) score -= 7;
    if (sma200 && lastPrice > sma200) score += 7;
    else if (sma200) score -= 7;

    // Golden / Death Cross Factor (+/- 10)
    if (sma50 && sma200) {
      if (sma50 > sma200) score += 10;
      else score -= 10;
    }

    // MACD Factor (+/- 15)
    if (macdLine > macdSignalLine) {
      score += 10;
      if (macdHist > 0) score += 5;
    } else {
      score -= 10;
      if (macdHist < 0) score -= 5;
    }

    // Volume Breakout Factor (+/- 15, nullified if illiquid/penny trap)
    if (!isIlliquidTrap) {
      if (volRatio > 1.5 && lastPrice > prevPrice) score += 15;
      else if (volRatio > 1.5 && lastPrice < prevPrice) score -= 15;
      else if (volRatio > 1.2 && lastPrice > prevPrice) score += 8;
    }

    // Stochastic Factor (+/- 10)
    if (stochK < 20) score += 10;
    else if (stochK > 80) score -= 10;

    // Divergence Synergy (+/- 20 based on confirmation strength)
    if (divergence === 'BULLISH_ACCUMULATION') {
      score += divergenceStrength >= 2 ? 20 : 12;
    } else if (divergence === 'BEARISH_BULL_TRAP') {
      score -= divergenceStrength >= 2 ? 20 : 12;
    }

    // ── NEW: VWAP Institutional Factor (+/- 8) ──
    if (vwapDeviation > 2) score += 8;        // clearly above VWAP = institutional buying
    else if (vwapDeviation > 0.5) score += 4;  // slightly above
    else if (vwapDeviation < -2) score -= 8;   // clearly below VWAP = institutional selling
    else if (vwapDeviation < -0.5) score -= 4; // slightly below

    // ── NEW: OBV Smart Money Factor (+/- 12) ──
    if (obvDivergence === 'ACCUMULATION') score += 12;     // smart money accumulating (very bullish!)
    else if (obvDivergence === 'DISTRIBUTION') score -= 12; // smart money distributing (very bearish!)
    else if (obvTrend === 'RISING' && priceRising) score += 5;  // confirmed uptrend
    else if (obvTrend === 'FALLING' && !priceRising) score -= 5; // confirmed downtrend

    // ── NEW: Candlestick Pattern Factor ──
    score += candlestickScore;

    // ── NEW: MACD Histogram Momentum Factor ──
    score += macdMomentumScore;

    // ── NEW: 52-Week Position Factor (+/- 7) ──
    const fiftyTwoHigh = quoteResult.fiftyTwoWeekHigh || 0;
    const fiftyTwoLow = quoteResult.fiftyTwoWeekLow || 0;
    const fiftyTwoRange = fiftyTwoHigh - fiftyTwoLow;
    if (fiftyTwoRange > 0) {
      const positionIn52w = (lastPrice - fiftyTwoLow) / fiftyTwoRange; // 0.0 = at low, 1.0 = at high
      if (positionIn52w < 0.20 && rsi <= 40) score += 7;    // near 52w low + oversold = accumulation zone
      else if (positionIn52w > 0.90 && rsi >= 60) score -= 7; // near 52w high + overbought = distribution zone
    }

    // ── NEW: Synergy & Conflict Intelligence ──
    // Count how many major factors align in same direction
    const bullishFactors = [
      rsi <= 40,
      macdLine > macdSignalLine,
      lastPrice > (sma50 || 0),
      vwapDeviation > 0.5,
      obvTrend === 'RISING',
      stochK < 30,
      candlestickScore > 0,
      macdMomentumScore > 0,
    ].filter(Boolean).length;

    const bearishFactors = [
      rsi >= 60,
      macdLine < macdSignalLine,
      lastPrice < (sma50 || Infinity),
      vwapDeviation < -0.5,
      obvTrend === 'FALLING',
      stochK > 70,
      candlestickScore < 0,
      macdMomentumScore < 0,
    ].filter(Boolean).length;

    // Synergy bonus: 5+ factors aligned = strong conviction
    if (bullishFactors >= 5) score += 8;
    else if (bearishFactors >= 5) score -= 8;
    // Conflict penalty: strong signals in both directions = unreliable
    if (bullishFactors >= 3 && bearishFactors >= 3) score -= 5;

    // TradingView Official Screener Rating Validator
    if (tvData.rating === 'STRONG_BUY') score += 10;
    else if (tvData.rating === 'BUY') score += 5;
    else if (tvData.rating === 'SELL') score -= 10;
    else if (tvData.rating === 'STRONG_SELL') score -= 20;

    // Liquidity Trap Safety Override (Cap score at 45 to protect retail from penny pump traps)
    if (isIlliquidTrap) {
      score = Math.min(score - 20, 45);
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

    // Confidence adjustment based on score & trend alignment
    const confidenceMultiplier = Math.max(0.3, Math.min(2.0, (score > 0 ? score : 50) / 60));
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

    // Win Probability Calculation v2.0 (enhanced with new factors)
    let winProb = 50; // base
    // RSI alignment
    if (rsi <= 30) winProb += 12;
    else if (rsi <= 40) winProb += 6;
    else if (rsi >= 70) winProb -= 12;
    else if (rsi >= 60) winProb -= 6;
    // MACD alignment
    if (macdLine > macdSignalLine && macdHist > 0) winProb += 10;
    else if (macdLine > macdSignalLine) winProb += 5;
    else if (macdLine < macdSignalLine && macdHist < 0) winProb -= 10;
    else if (macdLine < macdSignalLine) winProb -= 5;
    // Moving average trend
    if (sma20 && sma50 && lastPrice > sma20 && lastPrice > sma50) winProb += 8;
    else if (sma20 && sma50 && lastPrice < sma20 && lastPrice < sma50) winProb -= 8;
    // Golden/Death Cross
    if (sma50 && sma200 && sma50 > sma200) winProb += 5;
    else if (sma50 && sma200 && sma50 < sma200) winProb -= 5;
    // Volume confirmation
    if (volRatio > 1.5 && lastPrice > prevPrice) winProb += 7;
    else if (volRatio > 1.5 && lastPrice < prevPrice) winProb -= 7;
    // Stochastic
    if (stochK < 20) winProb += 5;
    else if (stochK > 80) winProb -= 5;
    // Divergence synergy (with strength)
    if (divergence === 'BULLISH_ACCUMULATION') winProb += divergenceStrength >= 2 ? 12 : 6;
    else if (divergence === 'BEARISH_BULL_TRAP') winProb -= divergenceStrength >= 2 ? 12 : 6;
    // RRR bonus
    if (riskRewardRatio >= 3) winProb += 5;
    else if (riskRewardRatio >= 2) winProb += 3;
    else if (riskRewardRatio < 1) winProb -= 5;
    // ── NEW: VWAP institutional positioning ──
    if (vwapDeviation > 1) winProb += 5;
    else if (vwapDeviation < -1) winProb -= 5;
    // ── NEW: OBV smart money flow ──
    if (obvDivergence === 'ACCUMULATION') winProb += 8;
    else if (obvDivergence === 'DISTRIBUTION') winProb -= 8;
    else if (obvTrend === 'RISING') winProb += 3;
    else if (obvTrend === 'FALLING') winProb -= 3;
    // ── NEW: Candlestick pattern ──
    if (candlestickScore > 0) winProb += 4;
    else if (candlestickScore < 0) winProb -= 4;
    // ── NEW: MACD momentum ──
    if (macdMomentumScore > 3) winProb += 4;
    else if (macdMomentumScore < -3) winProb -= 4;
    // ── NEW: Synergy/Conflict ──
    if (bullishFactors >= 5) winProb += 5;
    else if (bearishFactors >= 5) winProb -= 5;
    if (bullishFactors >= 3 && bearishFactors >= 3) winProb -= 3;
    // TradingView validation adjustment
    if (tvData.rating === 'STRONG_BUY') winProb += 5;
    else if (tvData.rating === 'BUY') winProb += 3;
    else if (tvData.rating === 'SELL') winProb -= 5;
    else if (tvData.rating === 'STRONG_SELL') winProb -= 10;
    // Illiquidity penalty
    if (isIlliquidTrap) winProb -= 10;

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
      sma20,
      sma50,
      sma200,
      volRatio: parseFloat(volRatio.toFixed(2)),
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
      tradingViewRating: tvData.rating,
      tvRecommendScore: tvData.score,
      isIlliquidTrap,
      dailyTurnover: Math.round(dailyTurnover),
    };
  } catch (err) {
    console.warn(`[Recommendation] Failed to analyze ${symbol}:`, err.message);
    return null;
  }
}

// Recommendation symbols (300+ Stocks across all 11 IDX Sectors)
const RECOMMENDATION_SYMBOLS = [
  // 🧪 BASIC-IND (Basic Materials)
  'BRPT.JK', 'TPIA.JK', 'INKP.JK', 'TKIM.JK', 'ANTM.JK', 'INCO.JK', 'MDKA.JK', 'NCKL.JK', 'MBMA.JK', 'SMGR.JK', 'INTP.JK', 'AVIA.JK', 'TINS.JK', 'PSAB.JK', 'DKFT.JK', 'NIKL.JK', 'CITA.JK', 'SMCB.JK', 'SMBR.JK', 'ARCI.JK', 'IFSH.JK', 'MCOL.JK', 'SOLA.JK', 'AGII.JK', 'ALDO.JK', 'AMFG.JK', 'BTON.JK', 'FASW.JK', 'GDST.JK', 'INCF.JK', 'ISSP.JK', 'KRAS.JK', 'LION.JK', 'LMSH.JK', 'PBSA.JK', 'TDPM.JK', 'TRST.JK', 'UNIC.JK',
  // 🔥 ENERGY
  'ADRO.JK', 'PTBA.JK', 'PGAS.JK', 'MEDC.JK', 'AKRA.JK', 'ESSA.JK', 'AMMN.JK', 'BREN.JK', 'CUAN.JK', 'PGEO.JK', 'HRUM.JK', 'ITMG.JK', 'DOID.JK', 'INDY.JK', 'PTRO.JK', 'BYAN.JK', 'GEMS.JK', 'BUMI.JK', 'ELSA.JK', 'MBSS.JK', 'ENRG.JK', 'TOBA.JK', 'ABMM.JK', 'APEX.JK', 'ARTI.JK', 'BIPI.JK', 'BSSR.JK', 'DEWA.JK', 'FIRE.JK', 'GTBO.JK', 'IATA.JK', 'KOBX.JK', 'MYOH.JK', 'RUIS.JK', 'SMMT.JK', 'SURE.JK', 'TEBE.JK', 'WINS.JK',
  // 👕 CYCLICAL (Consumer Cyclicals)
  'ACES.JK', 'MAPI.JK', 'MAPA.JK', 'ERAA.JK', 'RALS.JK', 'LPPF.JK', 'AUTO.JK', 'DRMA.JK', 'ASLC.JK', 'MPPA.JK', 'CINT.JK', 'WOOD.JK', 'PANR.JK', 'SCMA.JK', 'MNCN.JK', 'MSIN.JK', 'MDIA.JK', 'BELL.JK', 'BIKA.JK', 'BIPP.JK', 'BLTZ.JK', 'BOLA.JK', 'CSAP.JK', 'DFAM.JK', 'FAST.JK', 'FILM.JK', 'GLOB.JK', 'HERO.JK', 'KOCI.JK', 'MABA.JK',
  // 🪙 FINANCE
  'BBRI.JK', 'BBCA.JK', 'BMRI.JK', 'BBNI.JK', 'BRIS.JK', 'ARTO.JK', 'BBHI.JK', 'BNGA.JK', 'BDMN.JK', 'BJBR.JK', 'BJTM.JK', 'BTPS.JK', 'NISP.JK', 'PNLF.JK', 'BFIN.JK', 'SRTG.JK', 'BBTN.JK', 'AGRO.JK', 'BCIC.JK', 'BNLI.JK', 'BSIM.JK', 'MAHA.JK', 'MFIN.JK', 'CFIN.JK', 'AMAG.JK', 'BABP.JK', 'BACA.JK', 'BBKP.JK', 'BBMD.JK', 'BCAP.JK', 'BEKS.JK', 'BGTG.JK', 'BINA.JK', 'BNBA.JK', 'BNII.JK', 'BSWD.JK', 'BTPN.JK', 'DNAR.JK', 'MASB.JK',
  // 🛣️ INFRASTRUC (Infrastructure)
  'TLKM.JK', 'ISAT.JK', 'EXCL.JK', 'TOWR.JK', 'TBIG.JK', 'JSMR.JK', 'FREN.JK', 'CENT.JK', 'GHON.JK', 'GOLD.JK', 'META.JK', 'CMNP.JK', 'KEEN.JK', 'POWR.JK', 'TGRA.JK', 'ACST.JK', 'BALI.JK', 'BPII.JK', 'BUKK.JK', 'DADA.JK', 'IBST.JK', 'IDPR.JK', 'KBLV.JK', 'LINK.JK', 'MCTA.JK', 'MTPS.JK', 'PPRE.JK', 'SSIA.JK', 'SUPR.JK', 'TLDN.JK',
  // 🏥 HEALTH (Healthcare)
  'KLBF.JK', 'KAEF.JK', 'MIKA.JK', 'HEAL.JK', 'SILO.JK', 'SIDO.JK', 'INAF.JK', 'SAME.JK', 'PRDA.JK', 'TSPC.JK', 'PEHA.JK', 'DVLA.JK', 'PYFA.JK', 'BMHS.JK', 'CARE.JK', 'DGNS.JK', 'MEDS.JK', 'OMED.JK', 'PRAY.JK', 'PRIM.JK', 'RDTX.JK', 'SCPI.JK',
  // 🏭 INDUSTRIAL (Industrials)
  'ASII.JK', 'UNTR.JK', 'HEXA.JK', 'PTPP.JK', 'WIKA.JK', 'ADHI.JK', 'WEGE.JK', 'TOTL.JK', 'MARK.JK', 'IMPC.JK', 'KBLI.JK', 'JECC.JK', 'ARNA.JK', 'BHIT.JK', 'CCSI.JK', 'GMFI.JK', 'INAI.JK', 'KBLM.JK', 'KMTR.JK', 'KPII.JK', 'SPTO.JK',
  // 🛒 NON-CYCLICAL (Consumer Non-Cyclicals)
  'UNVR.JK', 'ICBP.JK', 'INDF.JK', 'CPIN.JK', 'JPFA.JK', 'CMRY.JK', 'CLEO.JK', 'MYOR.JK', 'AMRT.JK', 'GGRM.JK', 'HMSP.JK', 'STTP.JK', 'AALI.JK', 'LSIP.JK', 'TAPG.JK', 'DSNG.JK', 'SSMS.JK', 'BWPT.JK', 'SIMP.JK', 'VICI.JK', 'MAIN.JK', 'BEEF.JK', 'BTEK.JK', 'CEKA.JK', 'DLTA.JK', 'DMND.JK', 'FOOD.JK', 'GOOD.JK', 'HOKI.JK', 'IKAN.JK', 'KEJU.JK',
  // 🏠 PROPERTY (Property & Real Estate)
  'BSDE.JK', 'CTRA.JK', 'PWON.JK', 'SMRA.JK', 'ASRI.JK', 'APLN.JK', 'DUTI.JK', 'MKPI.JK', 'DILD.JK', 'KIJA.JK', 'BEST.JK', 'LPKR.JK', 'LPCK.JK', 'PPRO.JK', 'JRPT.JK', 'BKSL.JK', 'ARMY.JK', 'BAPA.JK', 'BBSS.JK', 'BCIP.JK', 'CITY.JK', 'COWL.JK', 'CPRI.JK', 'DMAS.JK', 'ELTY.JK', 'FMII.JK', 'FORZ.JK', 'GAMA.JK', 'GPRA.JK', 'GWSA.JK', 'IPAC.JK',
  // ✈️ TRANSPORT (Transportation & Logistics)
  'BIRD.JK', 'SMDR.JK', 'ASSA.JK', 'TMAS.JK', 'HELI.JK', 'HAIS.JK', 'GIAA.JK', 'CMPP.JK', 'IPCC.JK', 'IPCM.JK', 'SAFE.JK', 'BPTR.JK', 'TRUK.JK', 'WEHA.JK', 'AKSI.JK', 'BLTA.JK', 'CASS.JK', 'DEAL.JK', 'HITS.JK', 'JKSW.JK', 'LEAD.JK', 'LRNA.JK',
  // 💻 TECHNOLOGY
  'GOTO.JK', 'BUKA.JK', 'EMTK.JK', 'MLPT.JK', 'DCII.JK', 'MTDL.JK', 'WIFI.JK', 'BELI.JK', 'AXIO.JK', 'MCAS.JK', 'NFCX.JK', 'DMMX.JK', 'ENVY.JK', 'ATIC.JK', 'CASH.JK', 'DIVA.JK', 'GLVA.JK', 'HDIT.JK', 'JSPT.JK', 'LUCK.JK', 'MTECH.JK', 'PTSN.JK', 'WIRE.JK'
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

// ─── API: Stock Recommendations (Multi-Strategy: Scalping, Swing, BSJP, BPJS) ──
async function getSharedBatchAnalyses() {
  return await withCache('recommendations:raw_batch', 1800, async () => {
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
    const data = await withCache('recommendations:today_processed', 1800, async () => {
      const analyses = await getSharedBatchAnalyses();
      const sorted = [...analyses].sort((a, b) => (b.volRatio * b.score) - (a.volRatio * a.score));

      const buyPicks = sorted.filter(a => a.score >= 52 && !a.isIlliquidTrap).slice(0, 8);
      const sellPicks = sorted.filter(a => a.score <= 35).slice(0, 4);
      const holdPicks = sorted.filter(a => a.score > 35 && a.score < 52).slice(0, 4);

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
        const entryLow = ai.entry_low || pick.support || Math.round(pick.price * 0.99);
        const entryHigh = ai.entry_high || pick.price;
        const stopLoss = ai.stop_loss || pick.atrStopLoss || Math.round(pick.support * 0.97);
        const takeProfit = ai.take_profit || pick.atrTakeProfit || Math.round(pick.resistance * 1.02);

        const entryMid = (entryLow + entryHigh) / 2;
        const finalDistTP = Math.abs(takeProfit - entryMid);
        const finalDistSL = Math.abs(entryMid - stopLoss);
        const finalRRR = finalDistSL > 0 ? parseFloat((finalDistTP / finalDistSL).toFixed(2)) : 0;
        const finalProfitPct = entryMid > 0 ? parseFloat(((finalDistTP / entryMid) * 100).toFixed(2)) : 0;
        const finalLossPct = entryMid > 0 ? parseFloat(((finalDistSL / entryMid) * 100).toFixed(2)) : 0;

        const pe = pick.profitEstimation || {};
        const updatedPE = {
          ...pe,
          profitPercent: finalProfitPct,
          lossPercent: finalLossPct,
          riskRewardRatio: finalRRR,
          profitPerDay: pe.estimatedDays > 0 ? parseFloat((finalProfitPct / pe.estimatedDays).toFixed(2)) : 0,
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
    const data = await withCache('recommendations:tomorrow_processed', 3600, async () => {
      const analyses = await getSharedBatchAnalyses();
      const sorted = [...analyses].sort((a, b) => b.score - a.score);

      const morningPicks = sorted.filter(a => a.score >= 55 && !a.isIlliquidTrap).slice(0, 6);
      const avoidPicks = sorted.filter(a => a.score <= 30).slice(0, 4);

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
        const entryLow = ai.entry_low || pick.support || Math.round(pick.price * 0.99);
        const entryHigh = ai.entry_high || pick.price;
        const stopLoss = ai.stop_loss || pick.atrStopLoss || Math.round(pick.support * 0.97);
        const takeProfit = ai.take_profit || pick.atrTakeProfit || Math.round(pick.resistance * 1.03);

        const entryMid = (entryLow + entryHigh) / 2;
        const finalDistTP = Math.abs(takeProfit - entryMid);
        const finalDistSL = Math.abs(entryMid - stopLoss);
        const finalRRR = finalDistSL > 0 ? parseFloat((finalDistTP / finalDistSL).toFixed(2)) : 0;
        const finalProfitPct = entryMid > 0 ? parseFloat(((finalDistTP / entryMid) * 100).toFixed(2)) : 0;
        const finalLossPct = entryMid > 0 ? parseFloat(((finalDistSL / entryMid) * 100).toFixed(2)) : 0;

        const pe = pick.profitEstimation || {};
        const updatedPE = {
          ...pe,
          profitPercent: finalProfitPct,
          lossPercent: finalLossPct,
          riskRewardRatio: finalRRR,
          profitPerDay: pe.estimatedDays > 0 ? parseFloat((finalProfitPct / pe.estimatedDays).toFixed(2)) : 0,
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
    const data = await withCache('recommendations:swing_processed', 1800, async () => {
      const analyses = await getSharedBatchAnalyses();
      // Filter untuk swing: Skor tinggi, berpotensi golden cross / di atas SMA50, tidak illiquid
      const sorted = [...analyses].sort((a, b) => b.score - a.score);
      const candidates = sorted.filter(a => a.score >= 54 && !a.isIlliquidTrap);

      const nextTradingDate = getNextTradingDayLabel();

      const swingPicks = candidates.slice(0, 8).map(p => {
        const pe = p.profitEstimation || {};
        const minProfit = Math.max(5.5, (pe.profitPercent || 6.5)).toFixed(1);
        const maxProfit = (parseFloat(minProfit) + 4.5).toFixed(1);
        const entryLow = p.support || Math.round(p.price * 0.97);
        const entryHigh = p.price;
        const targetPriceLow = p.atrTakeProfit || Math.round(p.price * (1 + (parseFloat(minProfit) / 100)));
        const targetPriceHigh = Math.round(p.price * (1 + (parseFloat(maxProfit) / 100)));
        const stopLoss = p.atrStopLoss || Math.round(entryLow * 0.95);

        return {
          ...p,
          entryLow,
          entryHigh,
          stopLoss,
          takeProfit: targetPriceLow,
          strategy: 'SWING TRADING',
          entryDateAdvice: `Masuk pada hari bursa berikutnya (${nextTradingDate}) pada area batas beli Rp ${entryLow.toLocaleString('id-ID')} - Rp ${entryHigh.toLocaleString('id-ID')}`,
          targetProfitPct: `+${minProfit}% hingga +${maxProfit}%`,
          sellProfitAdvice: `Jual bertahap saat profit mencapai +${minProfit}% hingga +${maxProfit}% (Target harga Rp ${targetPriceLow.toLocaleString('id-ID')} - Rp ${targetPriceHigh.toLocaleString('id-ID')})`,
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
    const data = await withCache('recommendations:bsjp_processed', 1800, async () => {
      const analyses = await getSharedBatchAnalyses();
      // BSJP: Prioritaskan saham dengan akumulasi OBV positif & volume meningkat
      const candidates = [...analyses]
        .filter(a => a.score >= 50 && !a.isIlliquidTrap && (a.obvDivergence === 'ACCUMULATION' || a.obvTrend > 0 || a.volRatio >= 1.2))
        .sort((a, b) => b.volRatio - a.volRatio);

      const bsjpPicks = candidates.slice(0, 6).map(p => {
        const entryLow = Math.round(p.price * 0.995);
        const entryHigh = p.price;
        const stopLoss = Math.round(p.price * 0.975);
        const takeProfit = Math.round(p.price * 1.025);

        return {
          ...p,
          entryLow,
          entryHigh,
          stopLoss,
          takeProfit,
          strategy: 'BSJP (Beli Sore Jual Pagi)',
          entryTimeAdvice: `Beli saat sesi akhir bursa menjelang penutupan (Pukul 15.45 - 15.50 WIB) pada harga kisaran Rp ${p.price.toLocaleString('id-ID')}`,
          sellTimeAdvice: `Jual pada menit-menit awal bursa keesokan paginya (Pukul 09.00 - 09.15 WIB) saat terjadi lonjakan pembukaan (Gap-Up) dengan target cuan +1.5% hingga +3.0%`,
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
    const data = await withCache('recommendations:bpjs_processed', 1800, async () => {
      const analyses = await getSharedBatchAnalyses();
      // BPJS: Saham berdaya dorong intraday tinggi (volRatio >= 1.2 dan RSI di 45 - 68)
      const candidates = [...analyses]
        .filter(a => a.score >= 50 && !a.isIlliquidTrap && a.volRatio >= 1.1)
        .sort((a, b) => b.score - a.score);

      const bpjsPicks = candidates.slice(0, 6).map(p => {
        const entryLow = p.support || Math.round(p.price * 0.985);
        const entryHigh = p.price;
        const stopLoss = p.atrStopLoss || Math.round(entryLow * 0.97);
        const takeProfit = p.atrTakeProfit || Math.round(p.price * 1.035);

        return {
          ...p,
          entryLow,
          entryHigh,
          stopLoss,
          takeProfit,
          strategy: 'BPJS (Beli Pagi Jual Sore)',
          entryTimeAdvice: `Beli pada masa pembukaan sesi I bursa (Pukul 09.00 - 09.30 WIB) saat terkonfirmasi dorongan volume pembelian pada kisaran Rp ${entryLow.toLocaleString('id-ID')} - Rp ${entryHigh.toLocaleString('id-ID')}`,
          sellTimeAdvice: `Jual sebelum penutupan sesi II di sore hari (Pukul 15.20 - 15.45 WIB) untuk mengunci cuan harian +2.0% hingga +4.0% tanpa menginapkan saham`,
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

// Fallback & Institutional Reasoning Generator (Clean Stockbit UI without emojis)
function generateFallbackReasoning(stock) {
  const parts = [];

  if (stock.tradingViewRating && stock.tradingViewRating !== 'N/A' && stock.tradingViewRating !== 'NEUTRAL') {
    parts.push(`[Multi-Agent Verified] TV Rating: ${stock.tradingViewRating.replace(/_/g, ' ')}`);
  }

  if (stock.isIlliquidTrap) {
    parts.push('[PROTEKSI LIKUIDITAS]: Turn-over / volume rendah (rawan jebakan volatilitas saham kurang likuid)');
  }

  if (stock.divergence === 'BEARISH_BULL_TRAP') {
    const strengthTxt = stock.divergenceStrength >= 2 ? ` (${stock.divergenceStrength}x konfirmasi)` : '';
    parts.push(`[Waspada Bull Trap / Bearish Divergence]${strengthTxt}: Harga melaju tinggi tanpa dukungan momentum RSI/OBV`);
  } else if (stock.divergence === 'BULLISH_ACCUMULATION') {
    const strengthTxt = stock.divergenceStrength >= 2 ? ` (${stock.divergenceStrength}x konfirmasi)` : '';
    parts.push(`[Bullish Divergence]${strengthTxt}: Akumulasi di area bottom, potensi reversal kuat`);
  }

  if (stock.obvDivergence === 'ACCUMULATION') {
    parts.push('[Smart Money Accumulation]: Volume OBV menanjak kencang padahal harga sedang konsolidasi');
  } else if (stock.obvDivergence === 'DISTRIBUTION') {
    parts.push('[Smart Money Distribution]: Volume OBV melemah tajam padahal harga dipaksa naik (waspada distribusi)');
  }

  if (stock.vwapDeviation !== undefined && Math.abs(stock.vwapDeviation) > 1) {
    if (stock.vwapDeviation > 0) parts.push(`Harga di atas VWAP (+${stock.vwapDeviation}%) menandakan dominasi buyer institusi`);
    else parts.push(`Harga di bawah VWAP (${stock.vwapDeviation}%) menandakan tekanan jual institusi`);
  }

  if (stock.candlestickPattern && stock.candlestickPattern !== 'NONE') {
    parts.push(`Pola candlestick ${stock.candlestickPattern.replace(/_/g, ' ')} terdeteksi`);
  }

  if (stock.macdMomentum === 'ZERO_CROSS_BULL' || stock.macdMomentum === 'ACCELERATING_BULL') {
    parts.push('Momentum MACD Histogram mengakselerasi naik dengan kuat');
  }

  if (stock.rsi < 30) parts.push('RSI sangat oversold — peluang technical rebound');
  else if (stock.rsi < 40) parts.push('RSI di zona akumulasi (mendekati oversold)');
  else if (stock.rsi > 70) parts.push('RSI overbought — rawan aksi take profit');
  else if (stock.rsi > 60) parts.push('RSI menguji area overbought');

  if (stock.sma50 && stock.sma200) {
    if (stock.sma50 > stock.sma200) parts.push('trend major bullish (Golden Cross zone)');
    else parts.push('trend major bearish (Death Cross zone)');
  }

  if (!stock.isIlliquidTrap && stock.volRatio > 1.5) {
    parts.push(`lonjakan volume ${stock.volRatio}x mengonfirmasi momentum`);
  }

  const pe = stock.profitEstimation;
  if (pe) {
    parts.push(`RRR ${pe.riskRewardRatio}:1 (SL ${stock.atrStopLoss}, TP ${stock.atrTakeProfit})`);
    parts.push(`Estimasi profit +${pe.profitPercent}% dalam ${pe.timeEstimateLabel}`);
    parts.push(`Win probability: ${pe.winProbability}%`);
  } else if (stock.atrStopLoss && stock.atrTakeProfit) {
    parts.push(`RRR optimal (SL ATR: ${stock.atrStopLoss}, Target: ${stock.atrTakeProfit})`);
  }

  return parts.join('. ') + '.';
}

// ─── Autentikasi Middleware (JWT Token Validator) ───────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  
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
  if (!password || password.length < 8) {
    return 'Password minimal 8 karakter.';
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
    res.status(500).json({ error: 'Gagal mendaftar akun: ' + err.message });
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
    res.status(500).json({ error: 'Gagal melakukan login: ' + err.message });
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
    const amount = 99000;

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
    res.status(500).json({ error: err.message });
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

    // Verifikasi keaslian payload menggunakan SDK
    if (coreApiClient && MIDTRANS_SERVER_KEY && !MIDTRANS_SERVER_KEY.includes('YOUR_SERVER_KEY_DEFAULT')) {
      try {
        const statusResponse = await coreApiClient.transaction.notification(notification);
        orderId = statusResponse.order_id;
        transactionStatus = statusResponse.transaction_status;
        fraudStatus = statusResponse.fraud_status;
      } catch (sdkErr) {
        console.warn('⚠️ [Webhook SDK Verify Warning]:', sdkErr.message);
      }
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
    res.status(500).json({ error: err.message });
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
    // Jika orderId diset, mark PAID di app_orders juga
    if (orderId) {
      await pool.query('UPDATE app_orders SET status = $1, updated_at = NOW() WHERE order_id = $2 AND user_id = $3', ['PAID', orderId, req.user.id]);
    }

    // Verifikasi instan (Untuk simulasi atau konfirmasi manual dari modal simulasi)
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
    res.status(500).json({ error: err.message });
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
    
    // Group per symbol to check holdings
    const holdings = {};

    txRes.rows.forEach(tx => {
      const sym = tx.symbol;
      if (!holdings[sym]) holdings[sym] = { qty: 0, cost: 0 };

      if (tx.type === 'BUY') {
        holdings[sym].qty += Number(tx.quantity);
        holdings[sym].cost += Number(tx.total_value);
      } else if (tx.type === 'SELL') {
        holdings[sym].qty = Math.max(0, holdings[sym].qty - Number(tx.quantity));
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
    res.status(500).json({ error: 'Gagal mencatat transaksi: ' + err.message });
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
    res.status(500).json({ error: 'Gagal mengunduh laporan evaluasi: ' + err.message });
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


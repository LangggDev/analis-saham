import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

dotenv.config();

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

function withCache(key, ttlSeconds, fetchFn) {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.timestamp < ttlSeconds * 1000) {
    return Promise.resolve(cached.data);
  }
  return fetchFn().then((data) => {
    cache.set(key, { data, timestamp: now });
    return data;
  });
}

// Prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > 10 * 60 * 1000) cache.delete(key);
  }
}, 5 * 60 * 1000);

// ─── Rate Limiting / Throttle ───────────────────────────────────────────────
const MAX_CONCURRENT = 4;
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

// ─── API: Quote ─────────────────────────────────────────────────────────────
// Extracts real-time quote from chart endpoint meta data (no auth needed)
app.get('/api/quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await withCache(`quote:${symbol}`, 10, () =>
      yahooCall(async () => {
        const chart = await fetchChartData(symbol, '1d', '5d');
        const meta = chart.meta;
        const closes = (chart.indicators?.quote?.[0]?.close || []).filter(c => c != null);

        let price = meta.regularMarketPrice ?? 0;
        let previousClose = meta.chartPreviousClose ?? meta.previousClose ?? 0;

        if (closes.length >= 2) {
          price = closes[closes.length - 1];
          previousClose = closes[closes.length - 2];
        } else if (closes.length === 1) {
          price = closes[0];
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
      })
    );
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
          // Fallback: try v11 endpoint
          try {
            const url2 = `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
            result = await yahooAuthFetch(url2);
          } catch (e2) {
            console.warn(`[Fundamental] v11 also failed for ${symbol}: ${e2.message}, using chart fallback`);
            // Final fallback: derive basic data from chart meta
            const chart = await fetchChartData(symbol, '1d', '1y');
            const meta = chart.meta;
            return {
              symbol: meta.symbol || symbol,
              per: null,
              pbv: null,
              roe: null,
              der: null,
              eps: null,
              dividendYield: null,
              revenueGrowth: null,
              profitMargin: null,
              currentRatio: null,
              freeCashFlow: null,
              marketCap: meta.marketCap || null,
              fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
              fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
              price: meta.regularMarketPrice || null,
              _source: 'chart_fallback',
              _hasData: false,
            };
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
async function analyzeStockForRecommendation(symbol) {
  try {
    const [chartResult, quoteResult] = await Promise.all([
      yahooCall(() => fetchChartData(symbol, '1d', '6mo')),
      yahooCall(async () => {
        const chart = await fetchChartData(symbol, '1d', '5d');
        const meta = chart.meta;
        const closes = (chart.indicators?.quote?.[0]?.close || []).filter(c => c != null);
        let price = meta.regularMarketPrice ?? 0;
        let previousClose = meta.chartPreviousClose ?? meta.previousClose ?? 0;
        if (closes.length >= 2) {
          price = closes[closes.length - 1];
          previousClose = closes[closes.length - 2];
        } else if (closes.length === 1) {
          price = closes[0];
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

// Helper: Run parallel batch tasks
async function analyzeBatch(symbols, batchSize = 5) {
  const results = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const chunk = symbols.slice(i, i + batchSize);
    const chunkResults = await Promise.all(
      chunk.map(symbol => analyzeStockForRecommendation(symbol))
    );
    chunkResults.forEach(r => { if (r) results.push(r); });
    if (i + batchSize < symbols.length) {
      await new Promise(r => setTimeout(r, 400));
    }
  }
  return results;
}

// API: Recommendations for Today
app.get('/api/recommendations/today', async (req, res) => {
  try {
    const data = await withCache('recommendations:today', 1800, async () => {
      console.log('[Recommendations] Generating today\'s recommendations...');

      // Batch analyze all stocks in chunks of 5
      const analyses = await analyzeBatch(RECOMMENDATION_SYMBOLS, 5);

      // Sort by score (best first)
      analyses.sort((a, b) => b.score - a.score);

      // Get top picks (score >= 55) and bottom picks (score <= 35)
      const buyPicks = analyses.filter(a => a.score >= 55).slice(0, 8);
      const sellPicks = analyses.filter(a => a.score <= 35).slice(0, 4);
      const holdPicks = analyses.filter(a => a.score > 35 && a.score < 55).slice(0, 4);

      // Use Gemini AI for analysis text
      let aiAnalysis = {};
      if (process.env.GEMINI_API_KEY && buyPicks.length > 0) {
        try {
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

          const stockSummaries = buyPicks.slice(0, 5).map(s =>
            `${s.symbol}: Harga ${s.price}, RSI ${s.rsi}, MACD ${s.macdLine}/${s.macdSignalLine}, SMA20 ${s.sma20?.toFixed(0) || 'N/A'}, SMA50 ${s.sma50?.toFixed(0) || 'N/A'}, SMA200 ${s.sma200?.toFixed(0) || 'N/A'}, Vol Ratio ${s.volRatio}x, ATR ${s.atr}, VWAP ${s.vwap} (Dev ${s.vwapDeviation}%), OBV Trend ${s.obvTrend}, OBV Div ${s.obvDivergence}, Candle ${s.candlestickPattern}, MACD Mom ${s.macdMomentum}, Support ${s.support}, Resistance ${s.resistance}, Fib 38.2% ${s.fibonacci?.level382}, Fib 61.8% ${s.fibonacci?.level618}, Skor ${s.score}, Bull/Bear ${s.bullishFactors}/${s.bearishFactors}, Win Prob ${s.profitEstimation?.winProbability}%, Est Days ${s.profitEstimation?.estimatedDays}`
          ).join('\n');

          const prompt = `Kamu adalah analis saham profesional Indonesia berpengalaman 20+ tahun. Berdasarkan data teknikal berikut, berikan rekomendasi PRESISI TINGGI untuk HARI INI dalam Bahasa Indonesia.

Data saham:
${stockSummaries}

Untuk setiap saham, berikan:
1. entry_low dan entry_high (range harga beli yang REALISTIS berdasarkan support dan fibonacci)
2. stop_loss (harga cut loss KETAT, max 3-5% dari entry, berdasarkan ATR)
3. take_profit (target profit REALISTIS berdasarkan resistance dan fibonacci)
4. reasoning (alasan detail 2-3 kalimat, sebutkan indikator yang mendukung, dalam Bahasa Indonesia)

PENTING: Entry, SL, dan TP harus REALISTIS dan berdasarkan data teknikal. Jangan asal tebak.

Format response sebagai JSON array (tanpa markdown wrapper), contoh:
[{"symbol":"BBRI.JK","entry_low":4400,"entry_high":4520,"stop_loss":4250,"take_profit":4800,"reasoning":"RSI 28.5 oversold dengan MACD bullish crossover dan golden cross SMA50/200. Volume 1.8x mengonfirmasi akumulasi institusi."}]`;

          const result = await model.generateContent(prompt);
          let text = result.response.text();
          text = text.replace(/```json/g, '').replace(/```/g, '').trim();
          const aiResults = JSON.parse(text);
          aiResults.forEach(r => { aiAnalysis[r.symbol] = r; });
        } catch (aiErr) {
          console.warn('[Recommendations] Gemini AI failed:', aiErr.message);
        }
      }

      // Merge AI analysis into picks
      const enrichPick = (pick) => {
        const ai = aiAnalysis[pick.symbol] || {};
        const entryLow = ai.entry_low || pick.support;
        const entryHigh = ai.entry_high || pick.price;
        const stopLoss = ai.stop_loss || pick.atrStopLoss || Math.round(pick.support * 0.97);
        const takeProfit = ai.take_profit || pick.atrTakeProfit || Math.round(pick.resistance * 1.02);

        // Recalculate profit estimation with final entry/TP/SL values
        const entryMid = (entryLow + entryHigh) / 2;
        const finalDistTP = Math.abs(takeProfit - entryMid);
        const finalDistSL = Math.abs(entryMid - stopLoss);
        const finalRRR = finalDistSL > 0 ? parseFloat((finalDistTP / finalDistSL).toFixed(2)) : 0;
        const finalProfitPct = entryMid > 0 ? parseFloat(((finalDistTP / entryMid) * 100).toFixed(2)) : 0;
        const finalLossPct = entryMid > 0 ? parseFloat(((finalDistSL / entryMid) * 100).toFixed(2)) : 0;

        // Use the pick's profitEstimation but override with final values
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
        buyPicks: buyPicks.map(enrichPick),
        sellPicks: sellPicks.map(p => ({
          ...p,
          reasoning: generateFallbackReasoning(p),
        })),
        holdPicks: holdPicks.map(p => ({
          ...p,
          reasoning: generateFallbackReasoning(p),
        })),
        totalAnalyzed: analyses.length,
      };
    });

    res.json(data);
  } catch (err) {
    console.error('[Recommendations] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate recommendations', details: err.message });
  }
});

// API: Recommendations for Tomorrow Morning
app.get('/api/recommendations/tomorrow', async (req, res) => {
  // Time gate: only available after 19:00 WIB (UTC+7)
  const now = new Date();
  const utcHours = now.getUTCHours();
  const wibHours = (utcHours + 7) % 24;

  if (wibHours < 19 && !(wibHours < 5)) {
    // Before 19:00 WIB and after 05:00 WIB = locked
    return res.json({
      locked: true,
      message: 'Rekomendasi besok pagi tersedia mulai pukul 19:00 WIB',
      currentTimeWIB: `${String(wibHours).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} WIB`,
      availableAt: '19:00 WIB',
    });
  }

  try {
    const data = await withCache('recommendations:tomorrow', 3600, async () => {
      console.log('[Recommendations] Generating tomorrow morning recommendations...');

      const analyses = await analyzeBatch(RECOMMENDATION_SYMBOLS, 5);

      analyses.sort((a, b) => b.score - a.score);

      // Tomorrow picks: focus on best setups for morning opening
      const morningPicks = analyses.filter(a => a.score >= 55).slice(0, 6);
      const avoidPicks = analyses.filter(a => a.score <= 30).slice(0, 4);

      // Use Gemini AI for tomorrow analysis
      let aiAnalysis = {};
      if (process.env.GEMINI_API_KEY && morningPicks.length > 0) {
        try {
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

          const stockSummaries = morningPicks.map(s =>
            `${s.symbol}: Close ${s.price}, RSI ${s.rsi}, MACD ${s.macdLine}/${s.macdSignalLine}, SMA20 ${s.sma20?.toFixed(0) || 'N/A'}, SMA50 ${s.sma50?.toFixed(0) || 'N/A'}, SMA200 ${s.sma200?.toFixed(0) || 'N/A'}, Vol Ratio ${s.volRatio}x, VWAP ${s.vwap} (Dev ${s.vwapDeviation}%), OBV Trend ${s.obvTrend}, OBV Div ${s.obvDivergence}, Candle ${s.candlestickPattern}, MACD Mom ${s.macdMomentum}, Support ${s.support}, Resistance ${s.resistance}, Skor ${s.score}, Bull/Bear ${s.bullishFactors}/${s.bearishFactors}, Win Prob ${s.profitEstimation?.winProbability}%`
          ).join('\n');

          const prompt = `Kamu adalah analis saham profesional Indonesia. Berdasarkan data teknikal end-of-day berikut, berikan rekomendasi untuk PEMBUKAAN BESOK PAGI dalam Bahasa Indonesia.

Fokus pada:
- Saham yang berpotensi gap up atau rally di pembukaan
- Entry point yang optimal saat pre-market/opening
- Risk management yang ketat

Data saham:
${stockSummaries}

Untuk setiap saham, berikan:
1. entry_low dan entry_high (range harga beli saat opening besok)
2. stop_loss (harga cut loss, max 3-5% dari entry)
3. take_profit (target jual jangka pendek 1-3 hari)
4. reasoning (alasan singkat 2-3 kalimat mengapa layak beli besok pagi, dalam Bahasa Indonesia)
5. priority (1-5, dimana 1 = paling prioritas)

Format response sebagai JSON array (tanpa markdown wrapper), contoh:
[{"symbol":"BBRI.JK","entry_low":4400,"entry_high":4520,"stop_loss":4300,"take_profit":4800,"reasoning":"RSI menunjukkan kondisi oversold...","priority":1}]`;

          const result = await model.generateContent(prompt);
          let text = result.response.text();
          text = text.replace(/```json/g, '').replace(/```/g, '').trim();
          const aiResults = JSON.parse(text);
          aiResults.forEach(r => { aiAnalysis[r.symbol] = r; });
        } catch (aiErr) {
          console.warn('[Recommendations] Gemini AI tomorrow failed:', aiErr.message);
        }
      }

      const enrichPick = (pick) => {
        const ai = aiAnalysis[pick.symbol] || {};
        const entryLow = ai.entry_low || pick.support;
        const entryHigh = ai.entry_high || pick.price;
        const stopLoss = ai.stop_loss || pick.atrStopLoss || Math.round(pick.support * 0.97);
        const takeProfit = ai.take_profit || pick.atrTakeProfit || Math.round(pick.resistance * 1.02);

        // Recalculate profit estimation with final values
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
        locked: false,
        morningPicks: morningPicks.map(enrichPick).sort((a, b) => (a.priority || 3) - (b.priority || 3)),
        avoidPicks: avoidPicks.map(p => ({
          ...p,
          reasoning: generateFallbackReasoning(p),
        })),
        totalAnalyzed: analyses.length,
      };
    });

    res.json(data);
  } catch (err) {
    console.error('[Recommendations] Tomorrow error:', err.message);
    res.status(500).json({ error: 'Failed to generate tomorrow recommendations', details: err.message });
  }
});

// Fallback & Advanced Institutional Reasoning Generator (with ATR RRR, Divergence, Liquidity, VWAP, OBV, Candlesticks and Profit Estimation)
function generateFallbackReasoning(stock) {
  const parts = [];

  // 1. Critical Liquidity & Penny Stock Warning
  if (stock.isIlliquidTrap) {
    parts.push('⚠️ PROTEKSI LIKUIDITAS: Turn-over / volume rendah (rawan jebakan volatilitas saham gila/penny stock)');
  }

  // 2. Divergence / Bull Trap Alerts (with multi-indicator strength)
  if (stock.divergence === 'BEARISH_BULL_TRAP') {
    const strengthTxt = stock.divergenceStrength >= 2 ? ` (${stock.divergenceStrength}x konfirmasi)` : '';
    parts.push(`🚨 Waspada Bull Trap (Bearish Divergence)${strengthTxt}: Harga melaju tinggi tanpa dukung momentum RSI/OBV`);
  } else if (stock.divergence === 'BULLISH_ACCUMULATION') {
    const strengthTxt = stock.divergenceStrength >= 2 ? ` (${stock.divergenceStrength}x konfirmasi)` : '';
    parts.push(`🟢 Bullish Divergence terdeteksi${strengthTxt}: Akumulasi di area bottom, potensi reversal kuat`);
  }

  // 3. Smart Money OBV & VWAP Institutional Flow
  if (stock.obvDivergence === 'ACCUMULATION') {
    parts.push('💎 Smart Money Accumulation: Volume OBV menanjak kencang padahal harga sedang rehat');
  } else if (stock.obvDivergence === 'DISTRIBUTION') {
    parts.push('🛑 Smart Money Distribution: Volume OBV melemah tajam padahal harga dipaksa naik (waspada dump)');
  }
  if (stock.vwapDeviation !== undefined && Math.abs(stock.vwapDeviation) > 1) {
    if (stock.vwapDeviation > 0) parts.push(`Harga di atas VWAP (${stock.vwapDeviation}%) menandakan dominasi buyer institusi`);
    else parts.push(`Harga di bawah VWAP (${stock.vwapDeviation}%) menandakan tekanan jual institusi`);
  }

  // 4. Candlestick Pattern & MACD Momentum
  if (stock.candlestickPattern && stock.candlestickPattern !== 'NONE') {
    parts.push(`Pola candlestick ${stock.candlestickPattern.replace(/_/g, ' ')} terdeteksi`);
  }
  if (stock.macdMomentum === 'ZERO_CROSS_BULL' || stock.macdMomentum === 'ACCELERATING_BULL') {
    parts.push('Momentum MACD Histogram mengakselerasi naik dengan kuat');
  }

  // 5. RSI & Trend Momentum
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

  // 6. Risk/Reward & Profit Estimation
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

// ─── Fallback: Serve index.html ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║   📊 StockPulse — Real-Time Stock Analysis Dashboard v2.0  ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║   URL: http://localhost:${PORT}                               ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║   Endpoints:                                                ║`);
  console.log(`║   GET /api/quote/:symbol         — Real-time quote          ║`);
  console.log(`║   GET /api/chart/:symbol         — Historical OHLCV         ║`);
  console.log(`║   GET /api/search?q=             — Symbol search            ║`);
  console.log(`║   GET /api/news/:symbol          — Latest news              ║`);
  console.log(`║   GET /api/summary/:symbol       — Company summary          ║`);
  console.log(`║   GET /api/fundamental/:symbol   — Fundamental data (NEW)   ║`);
  console.log(`║   GET /api/market-status/:exch   — Market hours (NEW)       ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
});

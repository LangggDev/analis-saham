// test_fotmob_scrape3.js
async function run() {
  try {
    const url = 'https://www.fotmob.com/';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'
      }
    });
    if (res.ok) {
      const html = await res.text();
      const startTag = '<script id="__NEXT_DATA__" type="application/json">';
      const startIdx = html.indexOf(startTag);
      if (startIdx !== -1) {
        const endIdx = html.indexOf('</script>', startIdx);
        const jsonText = html.substring(startIdx + startTag.length, endIdx);
        const data = JSON.parse(jsonText);
        const fallback = data.props?.pageProps?.fallback || {};
        for (const key of Object.keys(fallback)) {
          if (key.startsWith('notableMatches')) {
            const val = fallback[key];
            console.log('val.matches type/isArray:', Array.isArray(val.matches) ? 'array' : typeof val.matches);
            if (Array.isArray(val.matches)) {
              console.log('Matches length:', val.matches.length);
              console.log('First 2 matches:', JSON.stringify(val.matches.slice(0, 2), null, 2));
            } else {
              console.log('val.matches keys:', Object.keys(val.matches || {}));
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
  }
}
run();

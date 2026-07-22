// test_fotmob_scrape4.js
async function run() {
  try {
    const url = 'https://www.fotmob.com/?date=20260629';
    console.log('Fetching:', url);
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
        console.log('Fallback keys:', Object.keys(fallback));
        for (const key of Object.keys(fallback)) {
          if (key.includes('Matches') || key.includes('matches')) {
            const val = fallback[key];
            console.log(`Key ${key}: matches field type:`, val.matches ? (Array.isArray(val.matches) ? 'array' : typeof val.matches) : 'no matches field');
            if (val.matches && Array.isArray(val.matches)) {
              console.log(`Matches length: ${val.matches.length}`);
              if (val.matches.length > 0) {
                console.log('First match:', JSON.stringify(val.matches[0], null, 2));
              }
            } else if (Array.isArray(val)) {
              console.log(`It is array of length: ${val.length}`);
              if (val.length > 0) {
                console.log('First item:', JSON.stringify(val[0], null, 2));
              }
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

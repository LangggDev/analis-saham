// test_fotmob_scrape.js
async function run() {
  try {
    const url = 'https://www.fotmob.com/';
    console.log('Fetching', url);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'
      }
    });
    console.log('Status:', res.status);
    if (res.ok) {
      const html = await res.text();
      console.log('HTML Length:', html.length);
      
      // Search for __NEXT_DATA__
      const nextDataIndex = html.indexOf('__NEXT_DATA__');
      console.log('__NEXT_DATA__ found at index:', nextDataIndex);
      
      if (nextDataIndex !== -1) {
        // Let's extract it
        const startTag = '<script id="__NEXT_DATA__" type="application/json">';
        const startIdx = html.indexOf(startTag);
        if (startIdx !== -1) {
          const endIdx = html.indexOf('</script>', startIdx);
          const jsonText = html.substring(startIdx + startTag.length, endIdx);
          console.log('JSON text length:', jsonText.length);
          const data = JSON.parse(jsonText);
          console.log('Props keys:', Object.keys(data.props || {}));
          console.log('PageProps keys:', Object.keys(data.props?.pageProps || {}));
          // Let's print out if there are matches in pageProps
          if (data.props?.pageProps) {
            const pageProps = data.props.pageProps;
            // Let's dump the structure
            console.log('pageProps keys:', Object.keys(pageProps));
            // Let's see if we have fixtures, matches, day, or leagues
            for (const key of Object.keys(pageProps)) {
              const val = pageProps[key];
              if (val && typeof val === 'object') {
                console.log(`Key "${key}" is object. Keys:`, Object.keys(val));
              }
            }
          }
        }
      }
    } else {
      console.log('Error fetching HTML');
    }
  } catch (err) {
    console.error('Scrape error:', err);
  }
}
run();

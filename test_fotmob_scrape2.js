// test_fotmob_scrape2.js
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
        console.log('Fallback keys:', Object.keys(fallback));
        for (const key of Object.keys(fallback)) {
          if (key.startsWith('notableMatches')) {
            const val = fallback[key];
            console.log(`Key ${key} matches array length:`, Array.isArray(val) ? val.length : typeof val);
            if (Array.isArray(val)) {
              // let's print the first match
              if (val.length > 0) {
                console.log('First match in list:', JSON.stringify(val[0], null, 2));
              }
            } else if (val && typeof val === 'object') {
              console.log('Object keys of match data:', Object.keys(val));
              // Let's print out the first match in matches or nested leagues
              if (Array.isArray(val.leagues)) {
                console.log('Leagues count:', val.leagues.length);
                val.leagues.slice(0, 3).forEach(l => {
                  console.log(`  League: ${l.name} (id: ${l.primaryId})`);
                  if (l.matches) {
                    console.log(`    Matches: ${l.matches.length}`);
                    l.matches.slice(0, 2).forEach(m => {
                      console.log(`      Match: ${m.home?.name} vs ${m.away?.name} (id: ${m.id})`);
                    });
                  }
                });
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

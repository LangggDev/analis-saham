// test_fotmob.js
async function run() {
  try {
    const url = 'https://www.fotmob.com/api/matches?date=20260629&timezone=Asia/Jakarta';
    console.log('Fetching', url);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    });
    console.log('Status:', res.status);
    if (res.ok) {
      const data = await res.json();
      console.log('Leagues count:', data.leagues ? data.leagues.length : 'no leagues field');
      if (Array.isArray(data.leagues)) {
        data.leagues.slice(0, 5).forEach(l => {
          console.log(`League: ${l.name} (id: ${l.id})`);
          if (l.matches) {
            l.matches.slice(0, 2).forEach(m => {
              console.log(`  Match: ${m.home.name} (id: ${m.home.id}) vs ${m.away.name} (id: ${m.away.id})`);
              console.log(`    Status: Finished? ${m.status?.finished}, Reason: ${m.status?.reason}, Score: ${m.home.score}-${m.away.score}`);
            });
          }
        });
      } else {
        console.log('Keys of data:', Object.keys(data));
      }
    } else {
      const text = await res.text();
      console.log('Error text:', text.substring(0, 500));
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }
}
run();

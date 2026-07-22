// test_fotmob_endpoints.js
async function run() {
  const date = '20260629';
  const urls = [
    `https://www.fotmob.com/api/allmatches?date=${date}&timezone=Asia%2FJakarta`,
    `https://www.fotmob.com/api/matches?date=${date}`,
    `https://www.fotmob.com/api/day?date=${date}`
  ];

  for (const url of urls) {
    try {
      console.log('Fetching:', url);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        }
      });
      console.log('Status:', res.status);
      if (res.ok) {
        const data = await res.json();
        console.log('Success! Keys:', Object.keys(data));
        if (data.leagues) {
          console.log('Leagues count:', data.leagues.length);
        }
      } else {
        const text = await res.text();
        console.log('Error output (first 200 chars):', text.substring(0, 200));
      }
    } catch (e) {
      console.error('Error for', url, ':', e.message);
    }
    console.log('---');
  }
}
run();

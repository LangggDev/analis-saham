import yahooFinance from 'yahoo-finance2';
async function test() {
  try {
    const res = await yahooFinance.quoteSummary('BBRI.JK', { modules: ['financialData', 'defaultKeyStatistics'] });
    console.log(res ? 'SUCCESS' : 'NO DATA');
  } catch (e) {
    console.error('ERROR:', e.message);
  }
}
test();

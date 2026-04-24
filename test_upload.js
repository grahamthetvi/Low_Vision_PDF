const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  
  await page.goto('http://localhost:8080/index.html', { waitUntil: 'networkidle0' });
  
  await page.waitForSelector('#welcome-continue');
  await page.click('#welcome-continue');
  
  const inputUploadHandle = await page.$('input[type=file]');
  await inputUploadHandle.uploadFile('./test.pdf');
  
  await page.waitForTimeout(2000);
  
  const status = await page.$eval('#status-region', el => el.textContent);
  console.log('STATUS:', status);
  
  await browser.close();
})();

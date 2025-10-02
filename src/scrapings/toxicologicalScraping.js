const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const os = require('os');

puppeteer.use(StealthPlugin());

// --- SELECTORS ---
const SELECTOR_CPF = 'br-input[formcontrolname="cpf"] input';
const SELECTOR_BIRTHDATE = 'br-date-picker[formcontrolname="dataNascimento"] input';
const SELECTOR_LICENSE_EXPIRY = 'br-date-picker[formcontrolname="dataValidade"] input';
const SELECTOR_BUTTON_PROCEED = 'button.br-button.primary';

// --- CONSTANTS ---
const URL = 'https://portalservicos.senatran.serpro.gov.br/#/condutor/consultar-toxicologico';
const ERROR_SCREENSHOT_PATH = path.resolve(__dirname, 'logs/error_screenshots');
const CHROME_USER_DATA_DIR = path.resolve(os.homedir(), '.chrome_senatran_profile');

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function formatDate(dateStr) {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split('/').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} 00:00:00.000`;
}

function createSemaphore(maxConcurrency) {
  let count = 0;
  const queue = [];

  return {
    async acquire() {
      if (count < maxConcurrency) {
        count++;
        return;
      }
      await new Promise((resolve) => queue.push(resolve));
      count++;
    },
    release() {
      count--;
      if (queue.length) queue.shift()();
    },
  };
}

// --- PAGE SETUP ---
async function setupPage(page) {
  await page.setRequestInterception(true);

  page.on('request', (req) => {
    const url = req.url().toLowerCase();
    if (
      ['image', 'font'].includes(req.resourceType()) ||
      url.includes('googlesyndication') ||
      url.includes('doubleclick') ||
      url.includes('analytics')
    ) {
      return req.abort();
    }
    req.continue();
  });

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9',
  });

  await page.evaluateOnNewDocument(() => {
    // navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // languages
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt'] });
    Object.defineProperty(navigator, 'language', { get: () => 'pt-BR' });

    // plugins & mimeTypes
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }] });

    // hardwareConcurrency
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
    } catch (e) {}

    // spoof WebGL
    try {
      const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return originalGetParameter(param);
      };
    } catch (e) {}

    // AudioContext minimal spoof
    try {
      window.AudioContext = window.AudioContext || window.webkitAudioContext;
      const orig = AudioContext.prototype.constructor;
      AudioContext.prototype.constructor = function () {
        return new orig();
      };
    } catch (e) {}

    // remove webdriver prototype
    try {
      delete navigator.__proto__.webdriver;
    } catch (e) {}
  });
}

// --- DATA EXTRACTION ---
async function extractDriverData(page) {
  try {
    const rawData = await page.evaluate(() => {
      const results = {};
      const rows = document.querySelectorAll('app-consulta-toxicologico table tr');
      rows.forEach((row) => {
        const cols = row.querySelectorAll('td');
        if (cols.length === 2) results[cols[0].innerText.trim()] = cols[1].innerText.trim();
      });
      return results;
    });

    let expiryDate = null;
    const expiryRaw = rawData['Prazo para realização de novo exame'];
    if (expiryRaw) {
      const match = expiryRaw.match(/\d{2}\/\d{2}\/\d{4}/);
      if (match) expiryDate = formatDate(match[0]);
    }

    let collectionDate = null;
    const collectionText = rawData['Amostra para novo exame coletada em'];
    if (collectionText && !collectionText.includes('Não há registro')) {
      const match = collectionText.match(/\d{2}\/\d{2}\/\d{4}/);
      if (match) collectionDate = formatDate(match[0]);
    }

    return {
      expired_at_senatran: expiryDate,
      collection_date_senatran: collectionDate,
    };
  } catch (err) {
    console.error('Error extracting driver data:', err.message);
    return { expired_at_senatran: null, collection_date_senatran: null };
  }
}

// --- DRIVER QUERY ---
async function queryDriverRecord(browserContext, driver, maxAttempts = 3) {
  const userAgent =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let page = null;

    try {
      page = await browserContext.newPage();
      await page.setUserAgent(userAgent);
      await page.setViewport({ width: 1920, height: 1080 });
      await setupPage(page);

      console.log(`Attempt ${attempt}/${maxAttempts} for CPF ${driver.cpf}...`);
      await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

      await page.waitForSelector(SELECTOR_CPF, { visible: true, timeout: 30000 });
      await page.click(SELECTOR_CPF, { clickCount: 3 });
      await page.type(SELECTOR_CPF, driver.cpf, { delay: 120 });

      await page.click(SELECTOR_BIRTHDATE, { clickCount: 3 });
      await page.type(SELECTOR_BIRTHDATE, driver.birthday, { delay: 120 });

      await page.click(SELECTOR_LICENSE_EXPIRY, { clickCount: 3 });
      await page.type(SELECTOR_LICENSE_EXPIRY, driver.cnh_due_at, { delay: 120 });

      await page.click(SELECTOR_BUTTON_PROCEED);

      const statusResult = await Promise.race([
        page.waitForSelector('h3.text-primary', { visible: true, timeout: 30000 }).then(() => 'ok'),
        page
          .waitForSelector('.br-message.is-danger', { visible: true, timeout: 30000 })
          .then(() => 'error'),
      ]);

      if (statusResult === 'error') {
        let errorMsg = 'Unknown error';
        try {
          errorMsg = await page.$eval('.br-message.is-danger .title', (el) => el.innerText.trim());
        } catch {}
        if (attempt === maxAttempts) {
          await captureScreenshot(page, driver.cpf, attempt);
          try {
            await page.close();
          } catch {}
          return { success: false, error: `Driver not found / error: ${errorMsg}` };
        }

        console.log(`🔄 Retrying CPF ${driver.cpf} (error: ${errorMsg})`);
        try {
          await page.close();
        } catch {}
        await delay(500);
        continue;
      }

      const data = await extractDriverData(page);
      try {
        await page.close();
      } catch {}
      return { success: true, data };
    } catch (err) {
      console.error(`⚠️ Attempt ${attempt} error for CPF ${driver.cpf}: ${err.message}`);
      if (attempt === maxAttempts) {
        await captureScreenshot(page, driver.cpf, attempt);
        try {
          if (page && !page.isClosed()) await page.close();
        } catch {}
        return { success: false, error: err.message };
      }

      try {
        if (page && !page.isClosed()) await page.close();
      } catch {}
      console.log(`🔄 Retrying CPF ${driver.cpf}...`);
      await delay(500);
    }
  }

  return { success: false, error: 'Unknown failure querying driver' };
}

// --- SCREENSHOT ---
async function captureScreenshot(page, cpf, attempt) {
  if (!page) return;
  try {
    const filePath = path.join(ERROR_SCREENSHOT_PATH, `error_${cpf}_attempt${attempt}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
  } catch (err) {
    console.error('❌ Failed to capture error screenshot:', err.message);
  }
}

// --- BATCH PROCESS ---
async function* processDriverBatch(drivers) {
  const MAX_CONCURRENCY = 5;
  const semaphore = createSemaphore(MAX_CONCURRENCY);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
    ],
    defaultViewport: null,
    userDataDir: CHROME_USER_DATA_DIR,
  });

  const results = [];

  async function processDriver(idx, driver) {
    await semaphore.acquire();
    try {
      const browserContext = await browser.createBrowserContext();
      const result = await queryDriverRecord(browserContext, driver);

      const driverResult = result.success
        ? { ...driver, ...result.data, search_status: 'success' }
        : { ...driver, search_status: 'error', error: result.error };

      results.push(driverResult);
    } catch (err) {
      console.error('Processing error:', err);
    } finally {
      semaphore.release();
    }
  }

  const tasks = drivers.map((driver, idx) => processDriver(idx, driver));

  while (results.length < drivers.length) {
    while (results.length > 0) yield results.shift();
    await delay(50);
  }

  await Promise.all(tasks);
  while (results.length > 0) yield results.shift();

  await browser.close();
  console.log('\n--- All driver queries completed ---');
}

module.exports = { processDriverBatch };

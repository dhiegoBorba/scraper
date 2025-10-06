const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const os = require('os');

puppeteer.use(StealthPlugin());

class ToxicologicalScraper {
  constructor({ maxConcurrency = 5, maxAttempts = 3 } = {}) {
    this.CHROME_USER_DATA_DIR = path.resolve(os.homedir(), '.chrome_senatran_profile');

    this.maxConcurrency = maxConcurrency;
    this.maxAttempts = maxAttempts;
    this.semaphore = this.createSemaphore(this.maxConcurrency);
    this.browser = null;
  }

  async *processBatch(drivers) {
    console.log('\nSCRAPER - Start toxicological scraper batch processing');

    await this.initBrowser();

    const tasks = drivers.map((driver) => {
      const p = this.#processDriverWithSemaphore(driver);
      p.finally(() => (p.isResolved = true));
      return p;
    });

    const pending = new Set(tasks);

    while (pending.size > 0) {
      const result = await Promise.race(pending);

      for (const task of pending) {
        if (task.isResolved) {
          pending.delete(task);
          break;
        }
      }

      yield result;
    }

    await this.#closeBrowser();
    console.log('SCRAPER - Finish toxicological scraper\n');
  }

  async #processDriverWithSemaphore(driver) {
    await this.semaphore.acquire();
    try {
      return await this.#processDriver(driver);
    } finally {
      this.semaphore.release();
    }
  }

  async initBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
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
        userDataDir: this.CHROME_USER_DATA_DIR,
      });
    }
  }

  async #closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  createSemaphore(maxConcurrency) {
    let count = 0;
    const queue = [];

    return {
      acquire: async () => {
        if (count < maxConcurrency) {
          count++;
          return;
        }

        await new Promise((resolve) => queue.push(resolve));
        count++;
      },
      release: () => {
        count--;

        if (queue.length) queue.shift()();
      },
    };
  }

  #delay(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  async #processDriver(driver) {
    try {
      const browserContext = await this.browser.createBrowserContext();
      const data = await this.#queryDriverRecord(browserContext, driver, this.maxAttempts);

      return { payload: driver, result: data };
    } catch (err) {
      console.error('SCRAPER - Processing error:', err);

      return { success: false, error: err.message };
    }
  }

  async #setupPage(page) {
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
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt'] });
      Object.defineProperty(navigator, 'language', { get: () => 'pt-BR' });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }] });

      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
      } catch (e) {}

      try {
        const originalGetParameter = WebGLRenderingContext.prototype.getParameter;

        WebGLRenderingContext.prototype.getParameter = function (param) {
          if (param === 37445) return 'Intel Inc.';
          if (param === 37446) return 'Intel Iris OpenGL Engine';

          return originalGetParameter(param);
        };
      } catch (e) {}

      try {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        const orig = AudioContext.prototype.constructor;

        AudioContext.prototype.constructor = function () {
          return new orig();
        };
      } catch (e) {}

      try {
        delete navigator.__proto__.webdriver;
      } catch (e) {}
    });
  }

  async #queryDriverRecord(browserContext, driver, maxAttempts) {
    if (!driver.cpf || !driver.birthday || !driver.cnh_due_at) {
      return {
        success: false,
        error: 'Missing required driver fields (cpf, birthday, cnh_due_at)',
      };
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let page = null;

      try {
        page = await this.#openPage(browserContext);

        console.log(`SCRAPER - Attempt ${attempt}/${maxAttempts} for CPF ${driver.cpf}...`);

        await this.#fillForm(page, driver);

        const status = await this.#waitForResult(page);

        if (status === 'error') {
          const errorMsg = await this.#getErrorMessage(page);

          if (attempt === maxAttempts) {
            const capturedImageBase64 = await this.#captureScreenshotBase64(page);

            await page.close();

            return {
              success: false,
              error: `Driver not found / error: ${errorMsg}`,
              captured_image_base64: capturedImageBase64,
            };
          }

          console.log(`SCRAPER - Retrying CPF ${driver.cpf} (error: ${errorMsg})`);

          await page.close();
          await this.#delay(500);

          continue;
        }

        const data = await this.#extractDriverData(page);
        await page.close();

        return { success: true, ...data };
      } catch (err) {
        console.error(`SCRAPER - Attempt ${attempt} error for CPF ${driver.cpf}: ${err.message}`);

        if (attempt === maxAttempts) {
          const capturedImageBase64 = await this.#captureScreenshotBase64(page);

          return { success: false, error: err.message, captured_image_base64: capturedImageBase64 };
        }

        if (page) await page.close();

        await this.#delay(500);
      }
    }

    return { success: false, error: 'Unknown failure querying driver' };
  }

  async #openPage(browserContext) {
    const page = await browserContext.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1920, height: 1080 });
    await this.#setupPage(page);
    await page.goto(
      'https://portalservicos.senatran.serpro.gov.br/#/condutor/consultar-toxicologico',
      {
        waitUntil: 'networkidle2',
        timeout: 60000,
      },
    );
    return page;
  }

  async #fillForm(page, driver) {
    const selectors = {
      cpf: 'br-input[formcontrolname="cpf"] input',
      birthdate: 'br-date-picker[formcontrolname="dataNascimento"] input',
      licenseExpiry: 'br-date-picker[formcontrolname="dataValidade"] input',
      proceed: 'button.br-button.primary',
    };

    await page.waitForSelector(selectors.cpf, { visible: true, timeout: 60000 });
    await page.click(selectors.cpf, { clickCount: 3 });
    await page.type(selectors.cpf, driver.cpf, { delay: 120 });

    await page.click(selectors.birthdate, { clickCount: 3 });
    await page.type(selectors.birthdate, driver.birthday, { delay: 120 });

    await page.click(selectors.licenseExpiry, { clickCount: 3 });
    await page.type(selectors.licenseExpiry, driver.cnh_due_at, { delay: 120 });

    await page.click(selectors.proceed);
  }

  async #waitForResult(page) {
    return Promise.race([
      page.waitForSelector('h3.text-primary', { visible: true, timeout: 60000 }).then(() => 'ok'),
      page
        .waitForSelector('.br-message.is-danger', { visible: true, timeout: 60000 })
        .then(() => 'error'),
    ]);
  }

  async #getErrorMessage(page) {
    try {
      return page.$eval('.br-message.is-danger .title', (el) => el.innerText.trim());
    } catch (err) {
      return 'Unknown error';
    }
  }

  async #extractDriverData(page) {
    try {
      const rawData = await page.evaluate(() => {
        const data = {};
        document.querySelectorAll('app-consulta-toxicologico table tr').forEach((row) => {
          const [keyCell, valueCell] = row.querySelectorAll('td');
          if (keyCell && valueCell) data[keyCell.innerText.trim()] = valueCell.innerText.trim();
        });
        return data;
      });

      return {
        expired_at: this.#extractDate(rawData['Prazo para realização de novo exame']),
        collection_date: this.#extractDate(rawData['Amostra para novo exame coletada em']),
        captured_image_base64: await this.#captureScreenshotBase64(page),
      };
    } catch (err) {
      console.error('SCRAPER - Error extracting driver data:', err.message);
      return { expired_at: null, collection_date: null, captured_image_base64: null };
    }
  }

  #extractDate(text) {
    if (!text || text.includes('Não há registro')) return null;
    const match = text.match(/\d{2}\/\d{2}\/\d{4}/);
    return match ? this.#formatDate(match[0]) : null;
  }

  #formatDate(dateStr) {
    if (!dateStr) return null;
    const [day, month, year] = dateStr.split('/').map(Number);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} 00:00:00.000`;
  }

  async #captureScreenshotBase64(page) {
    if (!page) return null;
    try {
      return await page.screenshot({ fullPage: true, encoding: 'base64' });
    } catch (err) {
      console.error('SCRAPER - Failed to capture base64 screenshot:', err.message);
      return null;
    }
  }
}

module.exports = ToxicologicalScraper;

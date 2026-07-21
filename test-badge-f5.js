// F5 Badge Bug Verification Test
// Tests: badge shows 3 after load, 0 after clicking all, STAYS 0 after F5

const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:3001';
const LOGIN_EMAIL = 'corr1783604302@x.com';
const LOGIN_PASSWORD = 'senha123';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  // Step 1: Open login page
  console.log('[STEP 1] Opening login page...');
  await page.goto(`${BASE}/login.html`);
  await page.waitForLoadState('networkidle');

  // Step 2: Clear localStorage
  console.log('[STEP 2] Clearing localStorage...');
  await page.evaluate(() => localStorage.clear());

  // Step 3: Login
  console.log('[STEP 3] Logging in as corretor...');
  await page.fill('#email', LOGIN_EMAIL);
  await page.fill('#senha', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard.html', { timeout: 10000 });
  await page.waitForLoadState('networkidle');

  // Step 4-5: Wait 2 seconds for polling
  console.log('[STEP 4-5] Waiting 2 seconds for polling to update badge...');
  await page.waitForTimeout(2000);

  // Step 6: Check badge - should show "3"
  const badgeText = await page.evaluate(() => {
    const badge = document.getElementById('badge-mensagens');
    return { text: badge ? badge.textContent : 'NOT FOUND', visible: badge ? (window.getComputedStyle(badge).display !== 'none') : false };
  });
  console.log(`[STEP 6] Badge after load: text="${badgeText.text}", visible=${badgeText.visible}`);

  // Step 7: Check localStorage
  const lsBefore = await page.evaluate(() => localStorage.getItem('moravo_chats_seen_25'));
  console.log(`[STEP 7] localStorage moravo_chats_seen_25 before clicking: ${lsBefore}`);

  // Step 8: Click Mensagens section
  console.log('[STEP 8] Clicking Mensagens section...');
  await page.click('a[data-section="mensagens"]');
  await page.waitForTimeout(500);

  // Step 9: Verify 3 conversas with green dots
  const conversas = await page.evaluate(() => {
    const items = document.querySelectorAll('#chatInboxList > div');
    return Array.from(items).map(el => {
      const dot = el.querySelector('.unread-dot, [style*="background:#34c240"], .msg-unread');
      return { id: el.dataset.chatId || el.id, text: el.textContent.trim().substring(0, 60), hasDot: !!dot };
    });
  });
  console.log(`[STEP 9] Found ${conversas.length} conversas:`, JSON.stringify(conversas, null, 2));

  // Step 10: Click each of the 3 conversas
  console.log('[STEP 10] Clicking each conversa...');
  for (let i = 0; i < Math.min(3, conversas.length); i++) {
    const items = await page.$$('#chatInboxList > div');
    if (items.length > 0) {
      await items[0].click();
      await page.waitForTimeout(300);
    }
  }

  // Step 11: Check badge after all clicks
  const badgeAfterClicks = await page.evaluate(() => {
    const badge = document.getElementById('badge-mensagens');
    return { text: badge ? badge.textContent : 'NOT FOUND', visible: badge ? (window.getComputedStyle(badge).display !== 'none') : false };
  });
  console.log(`[STEP 11] Badge after clicking all: text="${badgeAfterClicks.text}", visible=${badgeAfterClicks.visible}`);

  // Step 12: Check localStorage after clicks
  const lsAfterClicks = await page.evaluate(() => localStorage.getItem('moravo_chats_seen_25'));
  console.log(`[STEP 12] localStorage after clicks: ${lsAfterClicks}`);

  // Step 13: F5 (page.reload())
  console.log('[STEP 13] Performing F5 (page.reload())...');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000); // wait for polling

  // Step 14: Check badge after F5 - CRITICAL: must still be 0
  const badgeAfterF5 = await page.evaluate(() => {
    const badge = document.getElementById('badge-mensagens');
    return { text: badge ? badge.textContent : 'NOT FOUND', visible: badge ? (window.getComputedStyle(badge).display !== 'none') : false };
  });
  console.log(`[STEP 14] CRITICAL - Badge after F5: text="${badgeAfterF5.text}", visible=${badgeAfterF5.visible}`);

  // Step 15: Check localStorage after F5
  const lsAfterF5 = await page.evaluate(() => localStorage.getItem('moravo_chats_seen_25'));
  console.log(`[STEP 15] localStorage after F5: ${lsAfterF5}`);

  // Console errors
  console.log(`\n[CONSOLE ERRORS] Count: ${errors.length}`);
  if (errors.length > 0) {
    errors.forEach(e => console.log('  ERROR:', e));
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Badge after load:         "${badgeText.text}" ${badgeText.visible ? '(visible)' : '(hidden)'}`);
  console.log(`Badge after clicks:       "${badgeAfterClicks.text}" ${badgeAfterClicks.visible ? '(visible)' : '(hidden)'}`);
  console.log(`Badge after F5:           "${badgeAfterF5.text}" ${badgeAfterF5.visible ? '(visible)' : '(hidden)'}`);
  console.log(`localStorage before:      ${lsBefore}`);
  console.log(`localStorage after F5:    ${lsAfterF5}`);
  console.log(`\nBUG STATUS: ${badgeAfterF5.text === '0' || !badgeAfterF5.visible ? 'FIXED - badge stayed 0 after F5' : 'NOT FIXED - badge is "' + badgeAfterF5.text + '" after F5 (should be 0)'}`);

  await browser.close();
}

run().catch(e => { console.error('Test failed:', e); process.exit(1); });

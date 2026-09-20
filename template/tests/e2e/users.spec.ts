import { test, expect } from '@playwright/test';
import { PIN } from './helpers';
const PIN2 = process.env.ATLAS_PIN2 || '52525252';

async function enter(page: any, pin: string) { await page.goto('/gate/'); await page.waitForTimeout(300); await page.keyboard.type(pin); await page.waitForURL((u: URL) => !u.pathname.startsWith('/gate'), { timeout: 15000 }); await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 15000 }); }

test('dois PINs, dois usuários: cada um vê só os seus documentos e os compartilhados', async ({ page }) => {
  await enter(page, PIN2);
  await page.fill('.search', 'incorporação'); await expect(page.locator('li a', { hasText: 'incorporação imobiliária' })).toHaveCount(1);
  await expect(page.locator('.bar button[aria-label="Ver todos"]')).toHaveCount(1); // ela também pode revelar a biblioteca (menos categorias privadas)
  await page.evaluate(() => { localStorage.clear(); document.cookie = 'atlas_token=; Path=/; Max-Age=0'; });
  await enter(page, PIN);
  await page.fill('.search', 'incorporação'); await expect(page.locator('li a', { hasText: 'incorporação imobiliária' })).toHaveCount(0);
  // "ver todos" mostra os dela também, mas nunca a categoria privada
  await page.locator('.bar button[aria-label="Ver todos"]').click();
  await expect(page.locator('li a', { hasText: 'incorporação imobiliária' })).toHaveCount(1);
  await page.fill('.search', 'resume'); await expect(page.locator('li a', { hasText: 'Resume Parser' })).toHaveCount(1); // lucas vê trackfive (é dele)
});

test('estado pessoal não vaza: marcar como lido para um usuário não marca para o outro', async ({ page }) => {
  await enter(page, PIN2);
  await page.fill('.search', 'incorporação'); // a busca expande categorias e subcategorias recolhidas
  const li = page.locator('li', { hasText: 'incorporação imobiliária' }).first(); await li.hover();
  await li.locator('button[title="Marcar como lido"]').click(); await page.waitForTimeout(500);
  await page.evaluate(() => { localStorage.clear(); document.cookie = 'atlas_token=; Path=/; Max-Age=0'; });
  await enter(page, PIN);
  await page.locator('.bar button[aria-label="Ver todos"]').click(); await page.fill('.search', 'incorporação');
  const li2 = page.locator('li', { hasText: 'incorporação imobiliária' }).first();
  await expect(li2.locator('.readmark')).toHaveCount(0);
  // desfaz como ela
  await page.evaluate(() => { localStorage.clear(); document.cookie = 'atlas_token=; Path=/; Max-Age=0'; });
  await enter(page, PIN2); await page.fill('.search', 'incorporação'); const li3 = page.locator('li', { hasText: 'incorporação imobiliária' }).first(); await li3.hover();
  await li3.locator('button[title="Marcar como não lido"]').click(); await page.waitForTimeout(400);
});

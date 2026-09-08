import { test, expect } from '@playwright/test';

test('a vanished room with a remembered seat shows an expiry message and a way to start fresh', async ({ page }) => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.addInitScript(({ id }) => {
    localStorage.setItem(`dice:session:${id}`, JSON.stringify({ room_id: id, token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', member: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Remembered player' } }));
  }, { id });
  await page.goto(`/r/${id}`);
  await expect(page.getByRole('alert')).toContainText('expired');
  await expect(page.getByRole('link', { name: 'Or start a new room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join this room' })).toBeDisabled();
  await page.getByRole('link', { name: 'Or start a new room' }).click();
  await expect(page.getByRole('button', { name: 'Create a room' })).toBeVisible();
});
